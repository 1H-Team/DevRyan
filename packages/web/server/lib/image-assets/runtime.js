import express from 'express';
import {
  canonicalizeAssistantImageSource,
  extractAssistantImageReferences,
  isSupportedAssistantImageSource,
} from '@openchamber/shared-runtime';

const MAX_IMAGE_ASSETS = 12;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const DEFAULT_GRANT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_GRANT_MAX_ENTRIES = 256;
const DEFAULT_GRANT_MAX_METADATA_BYTES = 128 * 1024;

const MIME_BY_EXTENSION = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
]);

const FINAL_TOOL_STATUSES = new Set([
  'completed', 'complete', 'error', 'failed', 'aborted', 'timeout',
  'timedout', 'done', 'cancelled', 'canceled',
]);

const normalizeToolName = (value) => typeof value === 'string'
  ? value.trim().toLowerCase().replace(/[\s-]+/g, '_')
  : '';

const isImageGenerationTool = (toolName) => (
  toolName === 'gpt_imagegen'
  || toolName === 'imagegen'
  || toolName === 'image_gen'
  || toolName === 'image_generation'
);

const isFinalizedToolPart = (part) => {
  const state = part?.state && typeof part.state === 'object' ? part.state : {};
  const status = typeof state.status === 'string'
    ? state.status.toLowerCase().trim().replace(/[\s_-]+/g, '')
    : '';
  const start = Number.isFinite(state.time?.start) ? state.time.start : null;
  const end = Number.isFinite(state.time?.end) ? state.time.end : null;
  const validEnd = end !== null && (start === null || end >= start);
  return validEnd || FINAL_TOOL_STATUSES.has(status);
};

const readPartText = (part) => [part?.text, part?.content, part?.value]
  .filter((value) => typeof value === 'string')
  .reduce((longest, value) => value.length > longest.length ? value : longest, '');

const readToolOutput = (part) => {
  if (part?.type !== 'tool' || !isFinalizedToolPart(part)) return null;
  const metadata = part.state?.metadata && typeof part.state.metadata === 'object'
    && !Array.isArray(part.state.metadata)
    ? part.state.metadata
    : {};
  const source = canonicalizeAssistantImageSource(
    typeof metadata.out === 'string' ? metadata.out.trim() : '',
  );
  if (!source || !isSupportedAssistantImageSource(source)) return null;
  const mimeType = ['mimeType', 'mime', 'contentType']
    .map((key) => metadata[key])
    .find((value) => typeof value === 'string' && value.trim());
  if (!String(mimeType || '').toLowerCase().startsWith('image/')
    && !isImageGenerationTool(normalizeToolName(part.tool))) {
    return null;
  }
  return source;
};

export const extractAuthorizedAssistantImageSources = (message) => {
  const sources = new Map();
  for (const part of Array.isArray(message?.parts) ? message.parts : []) {
    if (part?.type !== 'text') continue;
    for (const reference of extractAssistantImageReferences(readPartText(part))) {
      if (!sources.has(reference.source)) {
        sources.set(reference.source, { source: reference.source, toolOutput: false });
      }
    }
  }
  for (const part of Array.isArray(message?.parts) ? message.parts : []) {
    const source = readToolOutput(part);
    if (!source) continue;
    sources.set(source, { source, toolOutput: true });
  }
  return sources;
};

const principalKey = (principal) => {
  const id = typeof principal?.id === 'string' ? principal.id.trim() : '';
  const scope = typeof principal?.scope === 'string' ? principal.scope.trim() : '';
  return id ? `${scope || 'unknown'}:${id}` : null;
};

const metadataSize = (record) => Buffer.byteLength(JSON.stringify(record), 'utf8');

export const createImageAssetGrantStore = ({
  crypto,
  now = Date.now,
  ttlMs = DEFAULT_GRANT_TTL_MS,
  maxEntries = DEFAULT_GRANT_MAX_ENTRIES,
  maxMetadataBytes = DEFAULT_GRANT_MAX_METADATA_BYTES,
} = {}) => {
  const grants = new Map();
  let totalMetadataBytes = 0;

  const remove = (token) => {
    const record = grants.get(token);
    if (!record) return;
    grants.delete(token);
    totalMetadataBytes = Math.max(0, totalMetadataBytes - record.metadataBytes);
  };

  const prune = () => {
    const currentTime = now();
    for (const [token, record] of grants) {
      if (record.expiresAt <= currentTime) remove(token);
    }
    while (grants.size > maxEntries || totalMetadataBytes > maxMetadataBytes) {
      const oldestToken = grants.keys().next().value;
      if (!oldestToken) break;
      remove(oldestToken);
    }
  };

  const grant = ({ principal, canonicalPath, sessionId, messageId }) => {
    const owner = principalKey(principal);
    if (!owner) throw new Error('Authenticated principal is required');
    const token = crypto.randomUUID().replaceAll('-', '');
    const base = {
      owner,
      canonicalPath,
      sessionId,
      messageId,
      createdAt: now(),
      expiresAt: now() + ttlMs,
    };
    const record = { ...base, metadataBytes: metadataSize(base) };
    if (record.metadataBytes > maxMetadataBytes) throw new Error('Image asset grant metadata is too large');
    grants.set(token, record);
    totalMetadataBytes += record.metadataBytes;
    prune();
    return token;
  };

  const authorize = ({ token, principal, canonicalPath }) => {
    prune();
    const record = grants.get(token);
    const owner = principalKey(principal);
    if (!record || !owner || record.owner !== owner || record.canonicalPath !== canonicalPath) {
      return false;
    }
    if (record.expiresAt <= now()) {
      remove(token);
      return false;
    }
    grants.delete(token);
    grants.set(token, record);
    return true;
  };

  return {
    grant,
    authorize,
    getStatus: () => ({ entries: grants.size, metadataBytes: totalMetadataBytes }),
  };
};

const isWithinRoot = (target, root, path) => {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const containsTraversal = (source) => source
  .replace(/\\/g, '/')
  .split(/[?#]/, 1)[0]
  .split('/')
  .some((segment) => segment === '..');

const isRemoteOrEmbedded = (source) => /^(?:https?:|data:)/i.test(source);

const stripLocalQuery = (source) => source.split(/[?#]/, 1)[0] || '';

const detectImageMimeType = (header) => {
  if (header.length >= 8
    && header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47
    && header[4] === 0x0d && header[5] === 0x0a && header[6] === 0x1a && header[7] === 0x0a) {
    return 'image/png';
  }
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return 'image/jpeg';
  }
  const signature = header.subarray(0, 6).toString('ascii');
  if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif';
  if (header.length >= 12
    && header.subarray(0, 4).toString('ascii') === 'RIFF'
    && header.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return null;
};

const readImageHeader = async (fsPromises, canonicalPath) => {
  const handle = await fsPromises.open(canonicalPath, 'r');
  try {
    const buffer = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
};

const errorResult = (source, errorCode) => ({ source, status: 'error', errorCode });

const unwrapMessage = (payload) => {
  const value = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  return value && typeof value === 'object' ? value : null;
};

export const createImageAssetsRuntime = ({
  fsPromises,
  path,
  os,
  crypto,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  ownsSession,
  fetchImpl = fetch,
  now = Date.now,
  grantOptions = {},
}) => {
  const grants = createImageAssetGrantStore({ crypto, now, ...grantOptions });

  const fetchMessage = async (sessionId, messageId) => {
    const response = await fetchImpl(buildOpenCodeUrl(
      `/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`,
      '',
    ), {
      headers: { accept: 'application/json', ...getOpenCodeAuthHeaders() },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    return unwrapMessage(await response.json());
  };

  const prepareSource = async ({ source, authorization, message, principal, sessionId, messageId }) => {
    if (isRemoteOrEmbedded(source)) return errorResult(source, 'REMOTE_SOURCE_UNSUPPORTED');
    if (containsTraversal(source)) return errorResult(source, 'PATH_TRAVERSAL');

    const workspace = typeof message?.info?.path?.cwd === 'string' ? message.info.path.cwd.trim() : '';
    if (!workspace) return errorResult(source, 'WORKSPACE_UNAVAILABLE');
    const localSource = stripLocalQuery(source);
    const lexicalPath = path.isAbsolute(localSource)
      ? path.resolve(localSource)
      : path.resolve(workspace, localSource);
    const tempRoot = os.tmpdir();
    const lexicalWorkspace = isWithinRoot(lexicalPath, workspace, path);
    const lexicalTemporary = authorization.toolOutput && isWithinRoot(lexicalPath, tempRoot, path);
    if (!lexicalWorkspace && !lexicalTemporary) {
      return errorResult(source, 'OUTSIDE_ALLOWED_ROOT');
    }

    let canonicalPath;
    let canonicalWorkspace;
    let canonicalTempRoot;
    try {
      [canonicalPath, canonicalWorkspace, canonicalTempRoot] = await Promise.all([
        fsPromises.realpath(lexicalPath),
        fsPromises.realpath(workspace).catch(() => path.resolve(workspace)),
        fsPromises.realpath(tempRoot).catch(() => path.resolve(tempRoot)),
      ]);
    } catch (error) {
      return errorResult(source, error?.code === 'ENOENT' ? 'FILE_NOT_FOUND' : 'PREPARE_FAILED');
    }

    const canonicalInWorkspace = isWithinRoot(canonicalPath, canonicalWorkspace, path);
    const canonicalInTemporary = authorization.toolOutput
      && isWithinRoot(canonicalPath, canonicalTempRoot, path);
    if ((lexicalWorkspace && !canonicalInWorkspace) || (lexicalTemporary && !canonicalInTemporary)) {
      return errorResult(source, 'SYMLINK_ESCAPE');
    }
    if (!canonicalInWorkspace && !canonicalInTemporary) {
      return errorResult(source, 'OUTSIDE_ALLOWED_ROOT');
    }

    const extension = path.extname(canonicalPath).toLowerCase();
    const expectedMimeType = MIME_BY_EXTENSION.get(extension);
    if (!expectedMimeType) return errorResult(source, 'UNSUPPORTED_FORMAT');

    let stats;
    try {
      stats = await fsPromises.stat(canonicalPath);
    } catch (error) {
      return errorResult(source, error?.code === 'ENOENT' ? 'FILE_NOT_FOUND' : 'PREPARE_FAILED');
    }
    if (!stats.isFile()) return errorResult(source, 'NOT_A_FILE');
    if (stats.size > MAX_IMAGE_BYTES) return errorResult(source, 'FILE_TOO_LARGE');

    let detectedMimeType;
    try {
      detectedMimeType = detectImageMimeType(await readImageHeader(fsPromises, canonicalPath));
    } catch {
      return errorResult(source, 'PREPARE_FAILED');
    }
    if (!detectedMimeType) return errorResult(source, 'INVALID_SIGNATURE');
    if (detectedMimeType !== expectedMimeType) return errorResult(source, 'MIME_MISMATCH');

    let url;
    if (canonicalInWorkspace) {
      const params = new URLSearchParams({ path: canonicalPath, directory: canonicalWorkspace });
      url = `/api/fs/raw?${params.toString()}`;
    } else {
      const token = grants.grant({ principal, canonicalPath, sessionId, messageId });
      const params = new URLSearchParams({ path: canonicalPath, assetGrant: token });
      url = `/api/fs/raw?${params.toString()}`;
    }
    return {
      source,
      status: 'ready',
      url,
      filename: path.basename(canonicalPath),
      mimeType: detectedMimeType,
      size: stats.size,
    };
  };

  const registerRoutes = (app) => {
    app.post(
      '/api/devryan/sessions/:sessionId/image-assets/prepare',
      express.json({ limit: '64kb' }),
      async (req, res) => {
        const sessionId = typeof req.params.sessionId === 'string' ? req.params.sessionId.trim() : '';
        const messageId = typeof req.body?.messageId === 'string' ? req.body.messageId.trim() : '';
        const sources = Array.isArray(req.body?.sources) ? req.body.sources : null;
        if (!req.principal) return res.status(401).json({ error: 'Authentication required' });
        if (!sessionId || !messageId || !sources || sources.length > MAX_IMAGE_ASSETS
          || sources.some((source) => typeof source !== 'string' || !source.trim() || source.length > 8_192)) {
          return res.status(400).json({ error: 'Invalid image asset request' });
        }
        try {
          if (typeof ownsSession === 'function' && !await ownsSession(req.principal, sessionId)) {
            return res.status(404).json({ error: 'Session not found' });
          }
          const message = await fetchMessage(sessionId, messageId);
          if (!message || message.info?.id !== messageId) {
            return res.status(404).json({ error: 'Message not found' });
          }
          if (message.info?.role !== 'assistant') {
            return res.status(400).json({ error: 'Assistant message required' });
          }
          if (!Number.isFinite(message.info?.time?.completed) || message.info.time.completed <= 0) {
            return res.status(409).json({ error: 'Assistant message is incomplete' });
          }

          const authorized = extractAuthorizedAssistantImageSources(message);
          const results = [];
          for (const input of sources) {
            const source = canonicalizeAssistantImageSource(input);
            if (!source || !isSupportedAssistantImageSource(source)) {
              results.push(errorResult(input, 'UNSUPPORTED_FORMAT'));
              continue;
            }
            const authorization = authorized.get(source);
            if (!authorization) {
              results.push(errorResult(input, 'UNREFERENCED_SOURCE'));
              continue;
            }
            results.push(await prepareSource({
              source: input,
              authorization,
              message,
              principal: req.principal,
              sessionId,
              messageId,
            }));
          }
          return res.json({ results });
        } catch {
          return res.status(502).json({ error: 'Unable to prepare image assets' });
        }
      },
    );
  };

  return {
    registerRoutes,
    authorizeAssetGrant: ({ token, principal, canonicalPath }) => grants.authorize({
      token,
      principal,
      canonicalPath,
    }),
    grantStore: grants,
  };
};

export {
  DEFAULT_GRANT_MAX_ENTRIES,
  DEFAULT_GRANT_MAX_METADATA_BYTES,
  DEFAULT_GRANT_TTL_MS,
  MAX_IMAGE_ASSETS,
  MAX_IMAGE_BYTES,
};
