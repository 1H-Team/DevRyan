import fs from 'node:fs/promises';
import path from 'node:path';

import {
  assertExactObject,
  validateBoundedJsonObject,
  validateBoundedString,
  validateUuid,
} from './validation.js';

const MAX_MATERIALIZED_OBJECTS = 1_000;
const MAX_MATERIALIZED_BYTES = 100 * 1024 * 1024;
export const MAX_INLINE_ATTACHMENT_BYTES = 128 * 1024;
export const MAX_INLINE_ATTACHMENT_TURN_BYTES = 256 * 1024;
const CONTENT_TYPE_EXTENSIONS = new Map([
  ['application/json', '.json'],
  ['application/pdf', '.pdf'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', '.pptx'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
  ['application/xml', '.xml'],
  ['application/zip', '.zip'],
  ['image/gif', '.gif'],
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['text/csv', '.csv'],
  ['text/markdown', '.md'],
  ['text/plain', '.txt'],
  ['text/yaml', '.yaml'],
]);

export class BotArtifactServiceError extends Error {
  constructor(message, code = 'bot_artifact_invalid', statusCode = 400) {
    super(message);
    this.name = 'BotArtifactServiceError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (message, code, statusCode) => {
  throw new BotArtifactServiceError(message, code, statusCode);
};

const safeRelativePath = (value, fallback) => {
  const candidate = typeof value === 'string' ? value.replaceAll('\\', '/').trim() : '';
  const normalized = path.posix.normalize(candidate || fallback);
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')
    || normalized.startsWith('/') || normalized.includes('\0')
    || normalized.split('/').some((segment) => segment.toLowerCase() === '.git')) {
    fail('Library materialization path is invalid', 'bot_artifact_path_invalid', 409);
  }
  return normalized;
};

const ensureWithin = (root, candidate) => {
  const resolved = path.resolve(candidate);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    fail('Artifact materialization escaped its workspace', 'bot_artifact_path_invalid', 409);
  }
  return resolved;
};

const writePrivateFile = async (root, relativePath, bytes) => {
  const destination = ensureWithin(root, path.join(root, ...relativePath.split('/')));
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const handle = await fs.open(destination, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.chmod(destination, 0o400);
  return destination;
};

const privateArtifactPath = (object) => (
  `artifacts/artifact-${object.id}${CONTENT_TYPE_EXTENSIONS.get(object.content_type) || '.bin'}`
);

const safeDisplayName = (object) => {
  const candidate = typeof object?.provenance?.name === 'string'
    ? path.basename(object.provenance.name.trim())
    : '';
  return candidate && candidate !== '.' && candidate !== '..'
    && !/[\u0000-\u001f\u007f/\\]/u.test(candidate)
    ? candidate.slice(0, 255)
    : `attachment-${object.id}${CONTENT_TYPE_EXTENSIONS.get(object.content_type) || '.bin'}`;
};

const normalizedContentType = (value) => (
  typeof value === 'string' ? value.split(';', 1)[0].trim().toLowerCase() : ''
);

const isInlineTextType = (contentType) => (
  contentType.startsWith('text/')
  || contentType === 'application/csv'
  || contentType === 'application/json'
  || contentType === 'application/xml'
  || contentType.endsWith('+json')
  || contentType.endsWith('+xml')
);

const isNativeFileType = (contentType) => (
  contentType === 'application/pdf' || contentType.startsWith('image/')
);

const decodeUtf8Prefix = (bytes, maximumBytes, fullText) => {
  if (maximumBytes <= 0) return '';
  if (bytes.byteLength <= maximumBytes) return fullText;
  for (let end = maximumBytes; end >= Math.max(0, maximumBytes - 3); end -= 1) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end));
    } catch {
    }
  }
  return '';
};

const classifyPrivateAttachment = ({ object, bytes, remainingInlineBytes }) => {
  const mime = normalizedContentType(object.content_type);
  if (isNativeFileType(mime)) {
    return Object.freeze({ delivery: 'native', inlineText: null, inlineBytes: 0, truncated: false });
  }
  if (!isInlineTextType(mime)) {
    return Object.freeze({ delivery: 'mounted', inlineText: null, inlineBytes: 0, truncated: false });
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return Object.freeze({ delivery: 'mounted', inlineText: null, inlineBytes: 0, truncated: false });
  }
  const maximumBytes = Math.max(0, Math.min(
    MAX_INLINE_ATTACHMENT_BYTES,
    remainingInlineBytes,
  ));
  const inlineText = decodeUtf8Prefix(bytes, maximumBytes, text);
  const inlineBytes = Buffer.byteLength(inlineText, 'utf8');
  return Object.freeze({
    delivery: 'inline_text',
    inlineText,
    inlineBytes,
    truncated: inlineBytes < bytes.byteLength,
  });
};

export function createBotArtifactService({
  store,
  authorization,
  blobStore,
  libraryRuntime,
  dataDirectory,
} = {}) {
  if (!store?.repositories?.bot_objects || !authorization
    || typeof authorization.requireManager !== 'function'
    || !blobStore || typeof blobStore.download !== 'function'
    || typeof blobStore.downloadAuthorized !== 'function'
    || !libraryRuntime || typeof libraryRuntime.publishArtifactBytes !== 'function'
    || typeof libraryRuntime.resolveVersionObjects !== 'function'
    || typeof dataDirectory !== 'string' || !path.isAbsolute(dataDirectory)) {
    throw new TypeError('Bot artifact service is misconfigured');
  }

  const artifactsRoot = path.join(dataDirectory, 'bots', 'runtime', 'artifacts');
  const materializedRunIds = new Set();

  const loadPrivateObject = async (botId, channelId, objectId) => {
    const object = await store.repositories.bot_objects.get({
      id: validateUuid(objectId, 'objectId'),
      bot_id: validateUuid(botId, 'botId'),
    });
    if (!object || object.channel_id !== validateUuid(channelId, 'channelId')
      || object.visibility !== 'private' || object.deleted_at) {
      fail('Private Bot artifact not found', 'bot_object_not_found', 404);
    }
    return object;
  };

  const cleanupRun = async (runId) => {
    const normalizedRunId = validateUuid(runId, 'runId');
    const directory = ensureWithin(artifactsRoot, path.join(artifactsRoot, normalizedRunId));
    await fs.rm(directory, { recursive: true, force: true });
    materializedRunIds.delete(normalizedRunId);
    return Object.freeze({ removed: true, runId: normalizedRunId });
  };

  return Object.freeze({
    async publishPrivate(principal, botId, objectId, request) {
      assertExactObject(request, {
        label: 'Private artifact publication',
        required: ['name'],
        optional: ['sourceId', 'provenance'],
      });
      const normalizedBotId = validateUuid(botId, 'botId');
      await authorization.requireManager(principal, normalizedBotId);
      const downloaded = await blobStore.download({
        principal,
        botId: normalizedBotId,
        objectId: validateUuid(objectId, 'objectId'),
      });
      if (downloaded.object.visibility !== 'private' || !downloaded.object.channel_id) {
        downloaded.bytes.fill(0);
        fail('Only a private channel artifact can be published', 'bot_artifact_private_required', 409);
      }
      try {
        return await libraryRuntime.publishArtifactBytes({
          principal,
          botId: normalizedBotId,
          sourceId: request.sourceId ? validateUuid(request.sourceId, 'sourceId') : null,
          objectId: downloaded.object.id,
          channelId: downloaded.object.channel_id,
          name: validateBoundedString(request.name, 'Artifact publication name', { maximum: 255 }),
          contentType: downloaded.object.content_type,
          bytes: downloaded.bytes,
          provenance: request.provenance === undefined
            ? {}
            : validateBoundedJsonObject(request.provenance, 'Artifact publication provenance'),
        });
      } finally {
        downloaded.bytes.fill(0);
      }
    },

    async materializeRun({ run, channel, attachmentIds = [], libraryVersionIds = [] } = {}) {
      const runId = validateUuid(run?.id, 'run.id');
      const botId = validateUuid(run?.botId || run?.bot_id, 'run.botId');
      const channelId = validateUuid(channel?.id || run?.channelId || run?.channel_id, 'channel.id');
      if (!Array.isArray(attachmentIds) || !Array.isArray(libraryVersionIds)
        || attachmentIds.length + libraryVersionIds.length > MAX_MATERIALIZED_OBJECTS) {
        fail('Bot run artifacts exceed materialization limits', 'bot_artifact_limit_exceeded', 413);
      }
      const privateObjects = await Promise.all(attachmentIds.map((id) => (
        loadPrivateObject(botId, channelId, id)
      )));
      const libraryVersions = await libraryRuntime.resolveVersionObjects({
        botId,
        versionIds: libraryVersionIds,
      });
      const objectCount = privateObjects.length + libraryVersions.reduce(
        (sum, version) => sum + version.entries.length,
        0,
      );
      if (objectCount > MAX_MATERIALIZED_OBJECTS) {
        fail('Bot run artifacts exceed materialization limits', 'bot_artifact_limit_exceeded', 413);
      }

      await fs.mkdir(artifactsRoot, { recursive: true, mode: 0o700 });
      await cleanupRun(runId);
      const staging = await fs.mkdtemp(path.join(artifactsRoot, `.${runId}-`));
      const finalDirectory = path.join(artifactsRoot, runId);
      const manifest = [];
      const attachmentDeliveryById = new Map();
      let totalBytes = 0;
      let inlineTurnBytes = 0;
      try {
        for (const object of privateObjects) {
          const downloaded = await blobStore.downloadAuthorized({ botId, objectId: object.id });
          try {
            totalBytes += downloaded.bytes.byteLength;
            if (totalBytes > MAX_MATERIALIZED_BYTES) {
              fail('Bot run artifacts exceed materialization limits', 'bot_artifact_limit_exceeded', 413);
            }
            const relativePath = privateArtifactPath(object);
            await writePrivateFile(staging, relativePath, downloaded.bytes);
            const delivery = classifyPrivateAttachment({
              object,
              bytes: downloaded.bytes,
              remainingInlineBytes: MAX_INLINE_ATTACHMENT_TURN_BYTES - inlineTurnBytes,
            });
            inlineTurnBytes += delivery.inlineBytes;
            attachmentDeliveryById.set(object.id, delivery);
            manifest.push({
              kind: 'private_artifact',
              objectId: object.id,
              relativePath,
              contentType: object.content_type,
              bytes: downloaded.bytes.byteLength,
              delivery: delivery.delivery,
              inlineBytes: delivery.inlineBytes,
              truncated: delivery.truncated,
            });
          } finally {
            downloaded.bytes.fill(0);
          }
        }
        for (const resolved of libraryVersions) {
          for (let index = 0; index < resolved.entries.length; index += 1) {
            const entry = resolved.entries[index];
            const object = await store.repositories.bot_objects.get({
              id: validateUuid(entry.objectId, 'libraryObjectId'),
              bot_id: botId,
              visibility: 'library',
            });
            if (!object || object.deleted_at || !resolved.version.object_ids.includes(object.id)) {
              fail('Published Library object is unavailable', 'bot_library_integrity_failed', 502);
            }
            const downloaded = await blobStore.downloadAuthorized({ botId, objectId: object.id });
            try {
              totalBytes += downloaded.bytes.byteLength;
              if (totalBytes > MAX_MATERIALIZED_BYTES) {
                fail('Bot run artifacts exceed materialization limits', 'bot_artifact_limit_exceeded', 413);
              }
              const sourcePath = safeRelativePath(
                entry.relativePath,
                `object-${index + 1}${CONTENT_TYPE_EXTENSIONS.get(object.content_type) || '.bin'}`,
              );
              const relativePath = `library/${resolved.version.id}/${sourcePath}`;
              await writePrivateFile(staging, relativePath, downloaded.bytes);
              manifest.push({
                kind: 'library',
                sourceId: resolved.source.id,
                libraryVersionId: resolved.version.id,
                objectId: object.id,
                relativePath,
                contentType: object.content_type,
                bytes: downloaded.bytes.byteLength,
              });
            } finally {
              downloaded.bytes.fill(0);
            }
          }
        }
        const manifestBytes = Buffer.from(`${JSON.stringify({ version: 1, files: manifest })}\n`, 'utf8');
        await writePrivateFile(staging, 'manifest.json', manifestBytes);
        manifestBytes.fill(0);
        await fs.rename(staging, finalDirectory);
        await fs.chmod(finalDirectory, 0o700);
        materializedRunIds.add(runId);
        return Object.freeze({
          runId,
          objectCount,
          totalBytes,
          relativeRoot: '.devryan',
          attachments: Object.freeze(privateObjects.map((object) => {
            const relativePath = privateArtifactPath(object);
            const entry = manifest.find((candidate) => (
              candidate.kind === 'private_artifact' && candidate.objectId === object.id
            ));
            const delivery = attachmentDeliveryById.get(object.id);
            return Object.freeze({
              objectId: object.id,
              filename: safeDisplayName(object),
              mime: object.content_type,
              bytes: Number(entry?.bytes || 0),
              relativePath,
              url: `file:///workspace/.devryan/${relativePath.split('/').map(encodeURIComponent).join('/')}`,
              delivery: delivery?.delivery || 'mounted',
              inlineText: delivery?.inlineText ?? null,
              inlineBytes: delivery?.inlineBytes || 0,
              truncated: delivery?.truncated === true,
            });
          })),
        });
      } catch (error) {
        await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
        await fs.rm(finalDirectory, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    },

    cleanupRun,

    async shutdown() {
      await Promise.allSettled([...materializedRunIds].map(cleanupRun));
    },

    artifactsRoot,
  });
}
