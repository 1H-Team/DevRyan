import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_GATEWAY_JSON_BYTES = 64 * 1024;
const GATEWAY_TIMEOUT_MS = 30_000;
const ARTIFACT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{32,8192}$/;

export class ComputerWorkspaceError extends Error {
  constructor(message, code, statusCode = 400) {
    super(message);
    this.name = 'ComputerWorkspaceError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (message, code, statusCode) => {
  throw new ComputerWorkspaceError(message, code, statusCode);
};

const safeFilename = (value) => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255
    || value !== path.basename(value) || value === '.' || value === '..'
    || /[\u0000-\u001f\u007f/\\]/u.test(value)) {
    fail('Scratch filename is invalid', 'DEVRYAN_BOT_FILE_INVALID');
  }
  return value;
};

const validateGateway = (value) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('Artifact gateway URL is invalid', 'DEVRYAN_BOT_FILE_CONFIG_INVALID', 500);
  }
  // The container has no route to the host: the private gateway is reached at
  // the egress service's in-network address, which relays to the host loopback.
  if (url.protocol !== 'http:' || url.hostname !== 'egress' || url.port !== '43121'
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    fail('Artifact gateway URL is invalid', 'DEVRYAN_BOT_FILE_CONFIG_INVALID', 500);
  }
  return url;
};

const parseJson = async (response) => {
  if (!response?.body || typeof response.body.getReader !== 'function') {
    fail('Artifact gateway response is invalid', 'DEVRYAN_BOT_FILE_GATEWAY_INVALID', 502);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_GATEWAY_JSON_BYTES) {
        await reader.cancel().catch(() => undefined);
        fail('Artifact gateway response is too large', 'DEVRYAN_BOT_FILE_GATEWAY_INVALID', 502);
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8'));
  } catch {
    fail('Artifact gateway response is invalid', 'DEVRYAN_BOT_FILE_GATEWAY_INVALID', 502);
  }
};

export function createWorkspaceGateway({
  scratchDirectory,
  gatewayUrl,
  runtimeToken: defaultRuntimeToken = null,
  fetchImpl = globalThis.fetch,
  fsPromises = fs,
} = {}) {
  if (typeof scratchDirectory !== 'string' || !path.isAbsolute(scratchDirectory)
    || typeof fetchImpl !== 'function') {
    fail('Workspace gateway configuration is invalid', 'DEVRYAN_BOT_FILE_CONFIG_INVALID', 500);
  }
  const gateway = validateGateway(gatewayUrl);

  const authorizationFor = (runtimeToken) => {
    const token = runtimeToken || defaultRuntimeToken;
    if (!TOKEN_PATTERN.test(token || '')) {
      fail('Artifact gateway authorization is invalid', 'DEVRYAN_BOT_FILE_AUTH_INVALID', 401);
    }
    return `Bearer ${token}`;
  };

  const resolveScratchPath = (filename) => {
    const normalized = safeFilename(filename);
    const resolved = path.join(scratchDirectory, normalized);
    if (path.dirname(resolved) !== scratchDirectory) {
      fail('Scratch path escaped its volume', 'DEVRYAN_BOT_FILE_INVALID');
    }
    return resolved;
  };

  const stageUpload = async ({ artifactId, filename, runtimeToken } = {}) => {
    if (!ARTIFACT_ID_PATTERN.test(artifactId)) {
      fail('Artifact ID is invalid', 'DEVRYAN_BOT_FILE_INVALID');
    }
    await fsPromises.mkdir(scratchDirectory, { recursive: true, mode: 0o700 });
    const destination = resolveScratchPath(filename);
    const response = await fetchImpl(
      new URL(`/api/bots/private/artifacts/${encodeURIComponent(artifactId)}/content`, gateway),
      {
        headers: { authorization: authorizationFor(runtimeToken) },
        redirect: 'error',
        signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
      },
    ).catch(() => fail(
      'Artifact gateway is unavailable',
      'DEVRYAN_BOT_FILE_GATEWAY_UNAVAILABLE',
      502,
    ));
    if (!response.ok || !response.body) {
      fail('Artifact download was rejected', 'DEVRYAN_BOT_FILE_GATEWAY_REJECTED', 502);
    }
    const temporary = `${destination}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    let handle;
    try {
      handle = await fsPromises.open(temporary, 'wx', 0o600);
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > MAX_FILE_BYTES) {
          fail('Artifact exceeds the scratch file limit', 'DEVRYAN_BOT_FILE_TOO_LARGE', 413);
        }
        await handle.write(chunk);
      }
      await handle.sync();
      await handle.close();
      handle = null;
      await fsPromises.rename(temporary, destination);
      await fsPromises.chmod(destination, 0o600);
      return Object.freeze({ path: destination, filename: safeFilename(filename), size });
    } finally {
      await handle?.close().catch(() => undefined);
      await fsPromises.unlink(temporary).catch(() => undefined);
    }
  };

  const publishDownload = async ({ filename, runtimeToken } = {}) => {
    const source = resolveScratchPath(filename);
    let handle;
    let content;
    try {
      handle = await fsPromises.open(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile()) fail('Download source is not a regular file', 'DEVRYAN_BOT_FILE_INVALID');
      if (stat.size > MAX_FILE_BYTES) {
        fail('Download exceeds the scratch file limit', 'DEVRYAN_BOT_FILE_TOO_LARGE', 413);
      }
      content = await handle.readFile();
      const response = await fetchImpl(new URL('/api/bots/private/artifacts', gateway), {
        method: 'POST',
        headers: {
          authorization: authorizationFor(runtimeToken),
          'content-type': 'application/octet-stream',
          'x-devryan-filename': safeFilename(filename),
        },
        body: content,
        redirect: 'error',
        signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
      }).catch(() => fail(
        'Artifact gateway is unavailable',
        'DEVRYAN_BOT_FILE_GATEWAY_UNAVAILABLE',
        502,
      ));
      const result = await parseJson(response);
      if (!response.ok || result?.ok !== true || !ARTIFACT_ID_PATTERN.test(result?.artifact?.id)) {
        fail('Artifact upload was rejected', 'DEVRYAN_BOT_FILE_GATEWAY_REJECTED', 502);
      }
      return Object.freeze({
        artifactId: result.artifact.id,
        filename: safeFilename(filename),
        size: stat.size,
      });
    } finally {
      content?.fill(0);
      await handle?.close().catch(() => undefined);
    }
  };

  return Object.freeze({ resolveScratchPath, stageUpload, publishDownload });
}
