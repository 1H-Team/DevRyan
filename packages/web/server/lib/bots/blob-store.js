import crypto from 'node:crypto';

import { decryptBotJson, encryptBotJson } from './encryption.js';
import {
  BOT_OBJECT_MAX_BYTES,
  validateBoundedJsonObject,
  validateUuid,
} from './validation.js';

export const BOT_OBJECT_BUCKET = 'devryan-bot-objects';
export const BOT_OBJECT_ENCRYPTION_VERSION = 1;
export const BOT_PROFILE_AVATAR_MAX_BYTES = 5 * 1024 * 1024;
export const BOT_PROFILE_AVATAR_CONTENT_TYPES = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

const DEPLOYMENT_KEY_ID = 'deployment-v1';
const OBJECT_KEY_BYTES = 32;
const IV_BYTES = 12;
const MIME_VERIFIERS = new Map([
  ['application/json', (bytes) => {
    const text = decodeText(bytes);
    try { JSON.parse(text); } catch { return false; }
    return true;
  }],
  ['application/pdf', (bytes) => bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', isZip],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', isZip],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', isZip],
  ['application/zip', isZip],
  ['application/xml', isText],
  ['image/gif', (bytes) => ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))],
  ['image/jpeg', (bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff],
  ['image/png', (bytes) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['image/webp', (bytes) => bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'],
  ['text/csv', isText],
  ['text/markdown', isText],
  ['text/plain', isText],
  ['text/yaml', isText],
]);

export class BotBlobStoreError extends Error {
  constructor(message, code = 'bot_object_invalid', statusCode = 400, details = null) {
    super(message);
    this.name = 'BotBlobStoreError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

function decodeText(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new BotBlobStoreError('Object is not valid UTF-8', 'bot_object_mime_mismatch', 400);
  }
}

function isText(bytes) {
  if (bytes.includes(0)) return false;
  try {
    decodeText(bytes);
    return true;
  } catch {
    return false;
  }
}

function isZip(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;
  return (bytes[2] === 0x03 && bytes[3] === 0x04)
    || (bytes[2] === 0x05 && bytes[3] === 0x06)
    || (bytes[2] === 0x07 && bytes[3] === 0x08);
}

const validateContent = (contentType, bytes, maximumBytes) => {
  const verifier = MIME_VERIFIERS.get(contentType);
  if (!verifier) {
    throw new BotBlobStoreError('Object content type is not allowed', 'bot_object_mime_forbidden', 415);
  }
  if (!Buffer.isBuffer(bytes) || bytes.byteLength < 1) {
    throw new BotBlobStoreError('Object content is required', 'bot_object_invalid', 400);
  }
  if (bytes.byteLength > maximumBytes) {
    throw new BotBlobStoreError('Object is too large', 'bot_object_too_large', 413);
  }
  if (!verifier(bytes)) {
    throw new BotBlobStoreError(
      'Object bytes do not match the declared content type',
      'bot_object_mime_mismatch',
      415,
    );
  }
};

const normalizeDeploymentKey = async (encryption) => {
  if (typeof encryption?.getKey !== 'function') {
    throw new BotBlobStoreError(
      'Bot encryption is unavailable on this host',
      'bot_os_encryption_unavailable',
      503,
    );
  }
  const provided = await encryption.getKey();
  try {
    if (!(Buffer.isBuffer(provided) || provided instanceof Uint8Array) || provided.byteLength !== 32) {
      throw new BotBlobStoreError('Bot encryption key is invalid', 'bot_encryption_key_invalid', 503);
    }
    return Buffer.from(provided);
  } finally {
    if (Buffer.isBuffer(provided) || provided instanceof Uint8Array) provided.fill(0);
  }
};

const objectAad = (row) => row.visibility === 'profile'
  ? `devryan-bot-object:${row.id}:${row.bot_id}:profile`
  : `devryan-bot-object:${row.id}:${row.bot_id}:${row.channel_id || 'library'}`;
const wrappedKeyAad = (objectId) => `devryan-bot-object-key:${objectId}:v1`;
const metadataAad = (kind, id) => `devryan-bot-${kind}:${id}:v1`;

const encryptBytes = ({ bytes, key, aad, randomBytes }) => {
  const iv = Buffer.from(randomBytes(IV_BYTES));
  if (iv.byteLength !== IV_BYTES) {
    throw new BotBlobStoreError('Object IV generator failed', 'bot_object_encryption_failed', 500);
  }
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return {
    ciphertext,
    envelope: {
      version: BOT_OBJECT_ENCRYPTION_VERSION,
      algorithm: 'aes-256-gcm',
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      aadVersion: 1,
    },
  };
};

const decryptBytes = ({ ciphertext, key, row }) => {
  const envelope = row.object_key_envelope;
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
    || Object.keys(envelope).sort().join(',') !== 'aadVersion,algorithm,iv,tag,version'
    || envelope.version !== BOT_OBJECT_ENCRYPTION_VERSION
    || envelope.algorithm !== 'aes-256-gcm'
    || envelope.aadVersion !== 1) {
    throw new BotBlobStoreError('Object encryption metadata is invalid', 'bot_object_integrity_failed', 502);
  }
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(envelope.iv, 'base64'),
    );
    decipher.setAAD(Buffer.from(objectAad(row), 'utf8'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new BotBlobStoreError('Object integrity verification failed', 'bot_object_integrity_failed', 502);
  }
};

export const publicBotObject = (row) => ({
  id: row.id,
  botId: row.bot_id,
  channelId: row.channel_id,
  visibility: row.visibility,
  ciphertextHash: row.ciphertext_hash,
  ciphertextSize: row.ciphertext_size,
  contentType: row.content_type,
  provenance: structuredClone(row.provenance || {}),
  createdBy: row.created_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  expiresAt: row.expires_at || null,
  deletedAt: row.deleted_at,
});

export function createBotBlobStore({
  store,
  authorization,
  encryption,
  maximumBytes = BOT_OBJECT_MAX_BYTES,
  randomBytes = crypto.randomBytes,
  randomUuid = crypto.randomUUID,
} = {}) {
  if (!store?.storage || !authorization) throw new TypeError('Bot blob store dependencies are missing');

  const createEncryptedObject = async ({
    principal,
    botId,
    channelId,
    visibility,
    contentType,
    bytes,
    provenance,
    expiresAt = null,
    contentMaximumBytes = maximumBytes,
  }) => {
    const normalizedBotId = validateUuid(botId, 'botId');
    const normalizedChannelId = visibility === 'private'
      ? validateUuid(channelId, 'channelId')
      : null;
    if (visibility === 'private') {
      await authorization.requireChannelSend(principal, normalizedBotId, normalizedChannelId);
    } else if (visibility === 'library' || visibility === 'profile') {
      await authorization.requireManager(principal, normalizedBotId);
    } else {
      throw new BotBlobStoreError('Object visibility is invalid');
    }
    validateContent(contentType, bytes, contentMaximumBytes);
    const normalizedProvenance = validateBoundedJsonObject(provenance || {}, 'provenance');
    let normalizedExpiresAt = null;
    if (expiresAt !== null) {
      const expiryTime = typeof expiresAt === 'string' ? Date.parse(expiresAt) : Number.NaN;
      if (!Number.isFinite(expiryTime) || expiryTime <= Date.now()) {
        throw new BotBlobStoreError('Object expiry must be in the future', 'bot_object_expiry_invalid');
      }
      normalizedExpiresAt = new Date(expiryTime).toISOString();
    }
    const objectId = validateUuid(randomUuid(), 'objectId');
    const rowIdentity = {
      id: objectId,
      bot_id: normalizedBotId,
      channel_id: normalizedChannelId,
      visibility,
    };
    const generatedObjectKey = randomBytes(OBJECT_KEY_BYTES);
    const objectKey = Buffer.isBuffer(generatedObjectKey)
      ? generatedObjectKey
      : Buffer.from(generatedObjectKey);
    if (objectKey.byteLength !== OBJECT_KEY_BYTES) {
      throw new BotBlobStoreError('Object key generator failed', 'bot_object_encryption_failed', 500);
    }
    const deploymentKey = await normalizeDeploymentKey(encryption);
    let uploaded = false;
    const storageObjectName = `objects/${validateUuid(randomUuid(), 'storageObjectId')}.bin`;
    try {
      const encrypted = encryptBytes({
        bytes,
        key: objectKey,
        aad: objectAad(rowIdentity),
        randomBytes,
      });
      const wrappedKey = encryptBotJson({
        key: deploymentKey,
        keyId: DEPLOYMENT_KEY_ID,
        value: { key: objectKey.toString('base64') },
        associatedData: wrappedKeyAad(objectId),
        randomBytes,
      });
      const ciphertextHash = crypto.createHash('sha256').update(encrypted.ciphertext).digest('hex');
      await store.storage.upload(BOT_OBJECT_BUCKET, storageObjectName, encrypted.ciphertext, {
        contentType: 'application/octet-stream',
        maximumBytes,
      });
      uploaded = true;
      return await store.insert('bot_objects', {
        id: objectId,
        bot_id: normalizedBotId,
        channel_id: normalizedChannelId,
        visibility,
        storage_bucket: BOT_OBJECT_BUCKET,
        storage_object_name: storageObjectName,
        object_key_envelope: encrypted.envelope,
        ciphertext_hash: ciphertextHash,
        ciphertext_size: encrypted.ciphertext.byteLength,
        wrapped_key: wrappedKey,
        content_type: contentType,
        provenance: normalizedProvenance,
        created_by: principal.id,
        expires_at: normalizedExpiresAt,
        deleted_at: null,
      });
    } catch (error) {
      if (uploaded) {
        await store.storage.delete(BOT_OBJECT_BUCKET, [storageObjectName]).catch(() => undefined);
      }
      throw error;
    } finally {
      objectKey.fill(0);
      deploymentKey.fill(0);
    }
  };

  const loadObject = async (botId, objectId) => {
    const row = await store.get('bot_objects', {
      id: validateUuid(objectId, 'objectId'),
      bot_id: validateUuid(botId, 'botId'),
    });
    if (!row || row.deleted_at !== null) {
      throw new BotBlobStoreError('Object not found', 'bot_object_not_found', 404);
    }
    return row;
  };

  const authorizeRead = async (principal, row, breakGlassReason = null) => {
    if (row.visibility === 'private') {
      await authorization.requireChannelRead(
        principal,
        row.bot_id,
        row.channel_id,
        breakGlassReason,
      );
      return;
    }
    try {
      await authorization.requireActiveMembership(principal, row.bot_id);
    } catch (error) {
      await authorization.requireManager(principal, row.bot_id).catch(() => { throw error; });
    }
  };

  const downloadRow = async (row) => {
    if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) {
      throw new BotBlobStoreError('Object has expired', 'bot_object_expired', 410);
    }
    const ciphertext = await store.storage.download(row.storage_bucket, row.storage_object_name, {
      maximumBytes: Math.min(maximumBytes, Number(row.ciphertext_size) + 1),
    });
    const actualHash = crypto.createHash('sha256').update(ciphertext).digest('hex');
    if (ciphertext.byteLength !== Number(row.ciphertext_size) || actualHash !== row.ciphertext_hash) {
      throw new BotBlobStoreError('Object integrity verification failed', 'bot_object_integrity_failed', 502);
    }
    const deploymentKey = await normalizeDeploymentKey(encryption);
    let objectKey = null;
    try {
      let unwrapped;
      try {
        unwrapped = decryptBotJson({
          key: deploymentKey,
          envelope: row.wrapped_key,
          expectedKeyId: DEPLOYMENT_KEY_ID,
          associatedData: wrappedKeyAad(row.id),
        });
      } catch {
        throw new BotBlobStoreError(
          'Object integrity verification failed',
          'bot_object_integrity_failed',
          502,
        );
      }
      objectKey = Buffer.from(unwrapped?.key || '', 'base64');
      if (objectKey.byteLength !== OBJECT_KEY_BYTES) {
        throw new BotBlobStoreError('Object key is invalid', 'bot_object_integrity_failed', 502);
      }
      const bytes = decryptBytes({ ciphertext, key: objectKey, row });
      try {
        validateContent(row.content_type, bytes, maximumBytes);
      } catch {
        throw new BotBlobStoreError(
          'Object integrity verification failed',
          'bot_object_integrity_failed',
          502,
        );
      }
      return { object: row, bytes };
    } finally {
      objectKey?.fill(0);
      deploymentKey.fill(0);
    }
  };

  const download = async ({ principal, botId, objectId, breakGlassReason = null }) => {
    const row = await loadObject(botId, objectId);
    await authorizeRead(principal, row, breakGlassReason);
    return downloadRow(row);
  };

  const deleteObject = async ({ principal, botId, objectId }) => {
    const row = await loadObject(botId, objectId);
    let mayDelete = false;
    if (row.visibility === 'private') {
      const access = await authorization.requireChannelRead(principal, row.bot_id, row.channel_id)
        .catch(() => null);
      mayDelete = access?.channel?.owner_user_id === principal.id;
    }
    if (!mayDelete) await authorization.requireManager(principal, row.bot_id);
    const deletedAt = new Date().toISOString();
    const updated = await store.updateIfRevision(
      'bot_objects',
      { id: row.id, bot_id: row.bot_id },
      { deleted_at: deletedAt },
      row.updated_at,
    );
    try {
      await store.storage.delete(row.storage_bucket, [row.storage_object_name]);
      return { object: updated, storageDeleted: true, cleanupRequired: false };
    } catch (error) {
      return {
        object: updated,
        storageDeleted: false,
        cleanupRequired: true,
        errorCode: typeof error?.code === 'string' ? error.code : 'bot_object_storage_delete_failed',
      };
    }
  };

  const encryptMetadata = async (kind, id, value) => {
    const deploymentKey = await normalizeDeploymentKey(encryption);
    try {
      return encryptBotJson({
        key: deploymentKey,
        keyId: DEPLOYMENT_KEY_ID,
        value,
        associatedData: metadataAad(kind, id),
        randomBytes,
      });
    } finally {
      deploymentKey.fill(0);
    }
  };

  const publishToLibrary = async ({ principal, botId, objectId, sourceId, provenance = {} }) => {
    const normalizedBotId = validateUuid(botId, 'botId');
    const normalizedSourceId = validateUuid(sourceId, 'sourceId');
    await authorization.requireManager(principal, normalizedBotId);
    const sourceObject = await loadObject(normalizedBotId, objectId);
    await authorizeRead(principal, sourceObject);
    const source = await store.get('bot_library_sources', {
      id: normalizedSourceId,
      bot_id: normalizedBotId,
    });
    if (!source || source.retired_at !== null) {
      throw new BotBlobStoreError('Library source not found', 'bot_library_source_not_found', 404);
    }
    const { bytes } = await download({ principal, botId: normalizedBotId, objectId: sourceObject.id });
    const normalizedProvenance = validateBoundedJsonObject(provenance, 'provenance');
    let publishedObject = null;
    let version = null;
    try {
      publishedObject = await createEncryptedObject({
        principal,
        botId: normalizedBotId,
        channelId: null,
        visibility: 'library',
        contentType: sourceObject.content_type,
        bytes,
        provenance: {
          publication: {
            sourceObjectId: sourceObject.id,
            sourceId: normalizedSourceId,
            publishedBy: principal.id,
          },
          supplied: normalizedProvenance,
        },
      });
      const latest = await store.list('bot_library_versions', {
        filters: { source_id: normalizedSourceId },
        limit: 1,
      });
      const versionNumber = Number(latest.items[0]?.version_number || 0) + 1;
      const versionId = validateUuid(randomUuid(), 'libraryVersionId');
      version = await store.insert('bot_library_versions', {
        id: versionId,
        source_id: normalizedSourceId,
        version_number: versionNumber,
        manifest_envelope: await encryptMetadata('library-manifest', versionId, {
          objectIds: [publishedObject.id],
          contentType: publishedObject.content_type,
          ciphertextHash: publishedObject.ciphertext_hash,
        }),
        diff_envelope: await encryptMetadata('library-diff', versionId, {
          previousVersionId: source.current_published_version_id,
          addedObjectIds: [publishedObject.id],
          removedObjectIds: [],
        }),
        object_ids: [publishedObject.id],
        published_by: principal.id,
        published_at: new Date().toISOString(),
      });
      await store.updateIfRevision(
        'bot_library_sources',
        { id: normalizedSourceId, bot_id: normalizedBotId },
        { current_published_version_id: version.id },
        source.updated_at,
      );
      return { object: publishedObject, version };
    } catch (error) {
      if (version) {
        await store.deleteCreated('bot_library_versions', { id: version.id }).catch(() => undefined);
      }
      if (publishedObject) {
        await store.storage.delete(
          publishedObject.storage_bucket,
          [publishedObject.storage_object_name],
        ).catch(() => undefined);
        await store.deleteCreated('bot_objects', { id: publishedObject.id }).catch(() => undefined);
      }
      throw error;
    }
  };

  return Object.freeze({
    uploadPrivate: (input) => createEncryptedObject({
      principal: input?.principal,
      botId: input?.botId,
      channelId: input?.channelId,
      visibility: 'private',
      contentType: input?.contentType,
      bytes: input?.bytes,
      provenance: input?.provenance,
      expiresAt: input?.expiresAt ?? null,
    }),
    createLibraryObject: (input) => createEncryptedObject({
      principal: input?.principal,
      botId: input?.botId,
      channelId: null,
      visibility: 'library',
      contentType: input?.contentType,
      bytes: input?.bytes,
      provenance: input?.provenance,
    }),
    uploadProfileAvatar: (input) => {
      if (!BOT_PROFILE_AVATAR_CONTENT_TYPES.includes(input?.contentType)) {
        throw new BotBlobStoreError(
          'Bot avatars must be PNG, JPEG, or WebP images',
          'bot_avatar_mime_forbidden',
          415,
        );
      }
      return createEncryptedObject({
        principal: input?.principal,
        botId: input?.botId,
        channelId: null,
        visibility: 'profile',
        contentType: input?.contentType,
        bytes: input?.bytes,
        provenance: input?.provenance ?? { purpose: 'bot-profile-avatar' },
        contentMaximumBytes: BOT_PROFILE_AVATAR_MAX_BYTES,
      });
    },
    download,
    async downloadAuthorized({ botId, objectId } = {}) {
      return downloadRow(await loadObject(botId, objectId));
    },
    deleteObject,
    publishToLibrary,
  });
}
