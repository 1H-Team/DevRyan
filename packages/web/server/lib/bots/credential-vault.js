import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { decryptBotJson, encryptBotJson } from './encryption.js';

export const BOT_CREDENTIAL_VAULT_VERSION = 1;
export const BOT_CREDENTIAL_KEY_ID = 'deployment-v1';
export const BOT_CREDENTIAL_REDACTION = '[REDACTED]';
export const BOT_CREDENTIAL_EXPORT_FORMAT = 'DevRyan.BotCredentialVaultExport';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_METADATA_BYTES = 16 * 1024;
const MAX_EXPORT_BYTES = 16 * 1024 * 1024;
const RECORD_FIELDS = Object.freeze([
  'botId',
  'createdAt',
  'createdBy',
  'credentialScope',
  'id',
  'keyId',
  'kind',
  'metadata',
  'ownerUserId',
  'provider',
  'revokedAt',
  'rotatedAt',
  'rotationCount',
  'secretEnvelope',
  'secretVersion',
  'status',
  'updatedAt',
]);
const FORBIDDEN_METADATA_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export class BotCredentialVaultError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'BotCredentialVaultError';
    this.code = code;
  }
}

const fail = (message, code) => {
  throw new BotCredentialVaultError(message, code);
};

const isPlainObject = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const isSensitiveMetadataKey = (key) => {
  const normalized = key.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  return normalized === 'authorization'
    || normalized === 'cookie'
    || normalized === 'keybytes'
    || normalized === 'privatekey'
    || normalized === 'apikey'
    || normalized.endsWith('password')
    || normalized.endsWith('passphrase')
    || normalized.endsWith('secret')
    || normalized.endsWith('token');
};

const sanitizeMetadataValue = (value, key = '') => {
  if (key && isSensitiveMetadataKey(key)) return BOT_CREDENTIAL_REDACTION;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((entry) => sanitizeMetadataValue(entry));
  if (!isPlainObject(value)) {
    fail('Bot credential metadata must contain JSON values', 'bot_credential_metadata_invalid');
  }
  const sanitized = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (FORBIDDEN_METADATA_KEYS.has(entryKey)) {
      fail('Bot credential metadata contains a forbidden key', 'bot_credential_metadata_invalid');
    }
    sanitized[entryKey] = sanitizeMetadataValue(entryValue, entryKey);
  }
  return sanitized;
};

export const sanitizeBotCredentialMetadata = (metadata = {}) => {
  if (!isPlainObject(metadata)) {
    fail('Bot credential metadata must be a JSON object', 'bot_credential_metadata_invalid');
  }
  const sanitized = sanitizeMetadataValue(metadata);
  if (Buffer.byteLength(JSON.stringify(sanitized), 'utf8') > MAX_METADATA_BYTES) {
    fail('Bot credential metadata is too large', 'bot_credential_metadata_invalid');
  }
  return sanitized;
};

const normalizeUuid = (value, field) => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!UUID_PATTERN.test(normalized)) {
    fail(`Bot credential ${field} is invalid`, 'bot_credential_invalid');
  }
  return normalized;
};

const normalizeLabel = (value, field) => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (normalized.length < 1 || normalized.length > 120) {
    fail(`Bot credential ${field} is invalid`, 'bot_credential_invalid');
  }
  return normalized;
};

const normalizeSecret = (secret) => {
  if (secret === undefined) {
    fail('Bot credential secret is required', 'bot_credential_secret_invalid');
  }
  try {
    const encoded = JSON.stringify(secret);
    if (typeof encoded !== 'string') {
      fail('Bot credential secret must be JSON-compatible', 'bot_credential_secret_invalid');
    }
    return JSON.parse(encoded);
  } catch (error) {
    if (error instanceof BotCredentialVaultError) throw error;
    fail('Bot credential secret must be JSON-compatible', 'bot_credential_secret_invalid');
  }
};

const normalizeCreateInput = (input) => {
  if (!isPlainObject(input)) fail('Bot credential input is invalid', 'bot_credential_invalid');
  const credentialScope = input.credentialScope;
  const ownerUserId = input.ownerUserId === null || input.ownerUserId === undefined
    ? null
    : normalizeUuid(input.ownerUserId, 'owner user ID');
  if ((credentialScope === 'team' && ownerUserId !== null)
    || (credentialScope === 'user' && ownerUserId === null)
    || !['team', 'user'].includes(credentialScope)) {
    fail('Bot credential scope and owner do not match', 'bot_credential_scope_invalid');
  }

  return {
    id: normalizeUuid(input.id, 'ID'),
    botId: normalizeUuid(input.botId, 'Bot ID'),
    provider: normalizeLabel(input.provider, 'provider'),
    kind: normalizeLabel(input.kind, 'kind'),
    credentialScope,
    ownerUserId,
    createdBy: normalizeUuid(input.createdBy, 'creator ID'),
    metadata: sanitizeBotCredentialMetadata(input.metadata),
  };
};

const localVaultReference = (credentialId) => `bot-credential:${credentialId}`;
const associatedData = (credentialId, secretVersion) => (
  `devryan-bot-credential:${credentialId}:v${secretVersion}`
);

const clone = (value) => structuredClone(value);

const publicMetadata = (record) => ({
  id: record.id,
  botId: record.botId,
  provider: record.provider,
  kind: record.kind,
  credentialScope: record.credentialScope,
  ownerUserId: record.ownerUserId,
  createdBy: record.createdBy,
  status: record.status,
  localVaultReference: localVaultReference(record.id),
  metadata: clone(record.metadata),
  keyId: record.keyId,
  secretVersion: record.secretVersion,
  rotationCount: record.rotationCount,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  rotatedAt: record.rotatedAt,
  revokedAt: record.revokedAt,
});

const supabaseRecord = (record) => ({
  id: record.id,
  bot_id: record.botId,
  provider: record.provider,
  kind: record.kind,
  credential_scope: record.credentialScope,
  owner_user_id: record.ownerUserId,
  local_vault_reference: localVaultReference(record.id),
  metadata: {
    ...clone(record.metadata),
    keyId: record.keyId,
    secretVersion: record.secretVersion,
    rotationCount: record.rotationCount,
    rotatedAt: record.rotatedAt,
  },
  status: record.status,
  created_by: record.createdBy,
  created_at: record.createdAt,
  updated_at: record.updatedAt,
  revoked_at: record.revokedAt,
});

const ensureExactRecordShape = (record) => {
  if (!isPlainObject(record)
    || Object.keys(record).sort().join('\0') !== RECORD_FIELDS.join('\0')) {
    fail('Bot credential vault contains an invalid record', 'bot_credential_vault_invalid');
  }
};

const validateLoadedRecord = (record, expectedId) => {
  ensureExactRecordShape(record);
  if (record.id !== expectedId
    || normalizeUuid(record.id, 'ID') !== record.id
    || normalizeUuid(record.botId, 'Bot ID') !== record.botId
    || normalizeUuid(record.createdBy, 'creator ID') !== record.createdBy) {
    fail('Bot credential vault contains an invalid identity', 'bot_credential_vault_invalid');
  }
  const ownerUserId = record.ownerUserId === null
    ? null
    : normalizeUuid(record.ownerUserId, 'owner user ID');
  if ((record.credentialScope === 'team' && ownerUserId !== null)
    || (record.credentialScope === 'user' && ownerUserId === null)
    || !['team', 'user'].includes(record.credentialScope)) {
    fail('Bot credential vault contains an invalid scope', 'bot_credential_vault_invalid');
  }
  normalizeLabel(record.provider, 'provider');
  normalizeLabel(record.kind, 'kind');
  const sanitizedMetadata = sanitizeBotCredentialMetadata(record.metadata);
  if (JSON.stringify(sanitizedMetadata) !== JSON.stringify(record.metadata)) {
    fail('Bot credential vault contains unsafe metadata', 'bot_credential_vault_invalid');
  }
  if (!Number.isSafeInteger(record.secretVersion) || record.secretVersion < 1
    || record.rotationCount !== record.secretVersion - 1
    || record.keyId !== BOT_CREDENTIAL_KEY_ID
    || !['active', 'revoked'].includes(record.status)) {
    fail('Bot credential vault contains invalid rotation state', 'bot_credential_vault_invalid');
  }
  if ((record.status === 'active' && (!isPlainObject(record.secretEnvelope) || record.revokedAt !== null))
    || (record.status === 'revoked' && (record.secretEnvelope !== null || typeof record.revokedAt !== 'string'))
    || (record.secretEnvelope && record.secretEnvelope.keyId !== record.keyId)) {
    fail('Bot credential vault contains invalid secret state', 'bot_credential_vault_invalid');
  }
  for (const field of ['createdAt', 'updatedAt']) {
    if (typeof record[field] !== 'string' || !Number.isFinite(Date.parse(record[field]))) {
      fail('Bot credential vault contains an invalid timestamp', 'bot_credential_vault_invalid');
    }
  }
  for (const field of ['rotatedAt', 'revokedAt']) {
    if (record[field] !== null
      && (typeof record[field] !== 'string' || !Number.isFinite(Date.parse(record[field])))) {
      fail('Bot credential vault contains an invalid timestamp', 'bot_credential_vault_invalid');
    }
  }
  return clone(record);
};

const loadState = async (vaultPath, fsPromises) => {
  let parsed;
  try {
    parsed = JSON.parse(await fsPromises.readFile(vaultPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: BOT_CREDENTIAL_VAULT_VERSION, credentials: {} };
    fail('Bot credential vault cannot be read', 'bot_credential_vault_invalid');
  }
  if (!isPlainObject(parsed)
    || Object.keys(parsed).sort().join('\0') !== 'credentials\0version'
    || parsed.version !== BOT_CREDENTIAL_VAULT_VERSION
    || !isPlainObject(parsed.credentials)) {
    fail('Bot credential vault format is unsupported', 'bot_credential_vault_invalid');
  }
  const credentials = {};
  for (const [credentialId, record] of Object.entries(parsed.credentials)) {
    credentials[credentialId] = validateLoadedRecord(record, credentialId);
  }
  await fsPromises.chmod(vaultPath, 0o600);
  return { version: BOT_CREDENTIAL_VAULT_VERSION, credentials };
};

const atomicWriteState = async (vaultPath, state, fsPromises) => {
  const directory = path.dirname(vaultPath);
  await fsPromises.mkdir(directory, { recursive: true, mode: 0o700 });
  await fsPromises.chmod(directory, 0o700);
  const temporaryPath = `${vaultPath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await fsPromises.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(state)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fsPromises.rename(temporaryPath, vaultPath);
    await fsPromises.chmod(vaultPath, 0o600);
    let directoryHandle;
    try {
      directoryHandle = await fsPromises.open(directory, 'r');
      await directoryHandle.sync();
    } catch {
      // Directory fsync is best-effort on filesystems that do not support it.
    } finally {
      await directoryHandle?.close().catch(() => undefined);
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fsPromises.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
};

const isoTimestamp = (now) => {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail('Bot credential clock is invalid', 'bot_credential_clock_invalid');
  }
  return value.toISOString();
};

export async function createBotCredentialVault({
  dataDirectory,
  getBotEncryptionKey,
  keyId = BOT_CREDENTIAL_KEY_ID,
  now = () => new Date(),
  fsPromises = fs,
} = {}) {
  if (typeof dataDirectory !== 'string' || !path.isAbsolute(dataDirectory)) {
    fail('Bot credential vault requires an absolute data directory', 'bot_credential_vault_invalid');
  }
  if (typeof getBotEncryptionKey !== 'function') {
    fail('Bot credential vault requires an encryption-key provider', 'bot_credential_vault_invalid');
  }
  if (keyId !== BOT_CREDENTIAL_KEY_ID) {
    fail('Bot credential vault key ID is unsupported', 'bot_credential_key_id_invalid');
  }

  const vaultPath = path.join(dataDirectory, 'bots', 'vault', 'credentials.v1.json');
  let state = await loadState(vaultPath, fsPromises);
  let mutation = Promise.resolve();

  const withKey = async (operation) => {
    const provided = await getBotEncryptionKey();
    const key = Buffer.from(provided || []);
    try {
      return operation(key);
    } finally {
      key.fill(0);
      if (Buffer.isBuffer(provided) || provided instanceof Uint8Array) provided.fill(0);
    }
  };

  const persist = async (nextState) => {
    await atomicWriteState(vaultPath, nextState, fsPromises);
    state = nextState;
  };

  const mutate = (operation) => {
    const next = mutation.then(operation, operation);
    mutation = next.catch(() => undefined);
    return next;
  };

  const findRecord = (credentialId) => {
    const normalizedId = normalizeUuid(credentialId, 'ID');
    const record = state.credentials[normalizedId];
    if (!record) fail('Bot credential was not found', 'bot_credential_not_found');
    return record;
  };

  const decodeExport = (botId, bytes) => {
    const normalizedBotId = normalizeUuid(botId, 'Bot ID');
    const encoded = Buffer.from(bytes || []);
    let parsed;
    try {
      if (encoded.byteLength < 1 || encoded.byteLength > MAX_EXPORT_BYTES) {
        fail('Bot credential export is invalid', 'bot_credential_restore_invalid');
      }
      parsed = JSON.parse(encoded.toString('utf8'));
    } catch (error) {
      if (error instanceof BotCredentialVaultError) throw error;
      fail('Bot credential export is invalid', 'bot_credential_restore_invalid');
    } finally {
      encoded.fill(0);
    }
    if (!isPlainObject(parsed)
      || Object.keys(parsed).sort().join('\0') !== 'botId\0credentials\0format\0version'
      || parsed.format !== BOT_CREDENTIAL_EXPORT_FORMAT
      || parsed.version !== BOT_CREDENTIAL_VAULT_VERSION
      || normalizeUuid(parsed.botId, 'Bot ID') !== normalizedBotId
      || !isPlainObject(parsed.credentials)) {
      fail('Bot credential export is incompatible', 'bot_credential_restore_incompatible');
    }
    const restored = {};
    for (const [credentialId, record] of Object.entries(parsed.credentials)) {
      const normalizedRecord = validateLoadedRecord(record, credentialId);
      if (normalizedRecord.botId !== normalizedBotId) {
        fail('Bot credential export contains another Bot', 'bot_credential_restore_incompatible');
      }
      restored[credentialId] = normalizedRecord;
    }
    return { normalizedBotId, restored };
  };

  const validateRestoredSecrets = (restored, key) => {
    try {
      for (const record of Object.values(restored)) {
        if (record.status !== 'active') continue;
        decryptBotJson({
          key,
          envelope: record.secretEnvelope,
          expectedKeyId: record.keyId,
          associatedData: associatedData(record.id, record.secretVersion),
        });
      }
    } catch {
      fail('Bot credential export integrity check failed', 'bot_credential_restore_integrity_invalid');
    }
  };

  return {
    async create(input) {
      return mutate(async () => {
        const normalized = normalizeCreateInput(input);
        if (state.credentials[normalized.id]) {
          fail('Bot credential already exists', 'bot_credential_exists');
        }
        const secret = normalizeSecret(input.secret);
        const timestamp = isoTimestamp(now);
        const secretVersion = 1;
        const secretEnvelope = await withKey((key) => encryptBotJson({
          key,
          keyId,
          value: secret,
          associatedData: associatedData(normalized.id, secretVersion),
        }));
        const record = {
          ...normalized,
          status: 'active',
          keyId,
          secretVersion,
          rotationCount: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
          rotatedAt: null,
          revokedAt: null,
          secretEnvelope,
        };
        const nextState = {
          version: BOT_CREDENTIAL_VAULT_VERSION,
          credentials: { ...state.credentials, [record.id]: record },
        };
        await persist(nextState);
        return publicMetadata(record);
      });
    },

    async read(credentialId) {
      const record = findRecord(credentialId);
      if (record.status === 'revoked') {
        fail('Bot credential has been revoked', 'bot_credential_revoked');
      }
      const secret = await withKey((key) => decryptBotJson({
        key,
        envelope: record.secretEnvelope,
        expectedKeyId: record.keyId,
        associatedData: associatedData(record.id, record.secretVersion),
      }));
      return { credential: publicMetadata(record), secret };
    },

    async rotate(credentialId, secretInput, metadataInput = undefined, { expectedSecretVersion } = {}) {
      return mutate(async () => {
        const record = findRecord(credentialId);
        if (expectedSecretVersion !== undefined && record.secretVersion !== expectedSecretVersion) {
          fail('Bot credential changed before rotation', 'bot_credential_rotation_conflict');
        }
        if (record.status === 'revoked') {
          fail('Bot credential has been revoked', 'bot_credential_revoked');
        }
        const secret = normalizeSecret(secretInput);
        const timestamp = isoTimestamp(now);
        const secretVersion = record.secretVersion + 1;
        const secretEnvelope = await withKey((key) => encryptBotJson({
          key,
          keyId,
          value: secret,
          associatedData: associatedData(record.id, secretVersion),
        }));
        const nextRecord = {
          ...record,
          metadata: metadataInput === undefined
            ? record.metadata
            : sanitizeBotCredentialMetadata(metadataInput),
          secretVersion,
          rotationCount: record.rotationCount + 1,
          updatedAt: timestamp,
          rotatedAt: timestamp,
          secretEnvelope,
        };
        await persist({
          version: BOT_CREDENTIAL_VAULT_VERSION,
          credentials: { ...state.credentials, [record.id]: nextRecord },
        });
        return publicMetadata(nextRecord);
      });
    },

    async rollbackRotation(credentialId, rotatedSecretVersion, previous) {
      return mutate(async () => {
        const record = findRecord(credentialId);
        const priorCredential = previous?.credential;
        const expectedRotatedVersion = Number(rotatedSecretVersion);
        if (!isPlainObject(priorCredential)
          || !Number.isSafeInteger(expectedRotatedVersion)
          || record.secretVersion !== expectedRotatedVersion
          || priorCredential.id !== record.id
          || priorCredential.botId !== record.botId
          || priorCredential.provider !== record.provider
          || priorCredential.kind !== record.kind
          || priorCredential.credentialScope !== record.credentialScope
          || priorCredential.ownerUserId !== record.ownerUserId
          || priorCredential.keyId !== record.keyId
          || priorCredential.status !== 'active'
          || priorCredential.secretVersion !== record.secretVersion - 1
          || priorCredential.rotationCount !== record.rotationCount - 1) {
          fail(
            'Bot credential rotation rollback no longer matches the vault state',
            'bot_credential_rotation_conflict',
          );
        }
        const secret = normalizeSecret(previous.secret);
        const secretEnvelope = await withKey((key) => encryptBotJson({
          key,
          keyId: record.keyId,
          value: secret,
          associatedData: associatedData(record.id, priorCredential.secretVersion),
        }));
        const restored = {
          ...record,
          metadata: clone(priorCredential.metadata),
          secretVersion: priorCredential.secretVersion,
          rotationCount: priorCredential.rotationCount,
          updatedAt: priorCredential.updatedAt,
          rotatedAt: priorCredential.rotatedAt,
          secretEnvelope,
        };
        await persist({
          version: BOT_CREDENTIAL_VAULT_VERSION,
          credentials: { ...state.credentials, [record.id]: restored },
        });
        return publicMetadata(restored);
      });
    },

    async revoke(credentialId) {
      return mutate(async () => {
        const record = findRecord(credentialId);
        if (record.status === 'revoked') return publicMetadata(record);
        const timestamp = isoTimestamp(now);
        const nextRecord = {
          ...record,
          status: 'revoked',
          updatedAt: timestamp,
          revokedAt: timestamp,
          secretEnvelope: null,
        };
        await persist({
          version: BOT_CREDENTIAL_VAULT_VERSION,
          credentials: { ...state.credentials, [record.id]: nextRecord },
        });
        return publicMetadata(nextRecord);
      });
    },

    getMetadata(credentialId) {
      return publicMetadata(findRecord(credentialId));
    },

    list() {
      return Object.values(state.credentials)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
        .map(publicMetadata);
    },

    exportForBot(botId) {
      const normalizedBotId = normalizeUuid(botId, 'Bot ID');
      const credentials = Object.fromEntries(Object.entries(state.credentials)
        .filter(([, record]) => record.botId === normalizedBotId)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([id, record]) => [id, clone(record)]));
      const bytes = Buffer.from(JSON.stringify({
        format: BOT_CREDENTIAL_EXPORT_FORMAT,
        version: BOT_CREDENTIAL_VAULT_VERSION,
        botId: normalizedBotId,
        credentials,
      }), 'utf8');
      if (bytes.byteLength > MAX_EXPORT_BYTES) {
        bytes.fill(0);
        fail('Bot credential export is too large', 'bot_credential_export_too_large');
      }
      return bytes;
    },

    async restoreForBot(botId, bytes, { mode = 'merge' } = {}) {
      return mutate(async () => {
        if (!['empty', 'merge'].includes(mode)) {
          fail('Bot credential restore mode is invalid', 'bot_credential_restore_invalid');
        }
        const { normalizedBotId, restored } = decodeExport(botId, bytes);
        await withKey((key) => validateRestoredSecrets(restored, key));
        for (const credentialId of Object.keys(restored)) {
          if (state.credentials[credentialId]) {
            fail('Bot credential restore would overwrite an identity', 'bot_credential_restore_collision');
          }
        }
        if (mode === 'empty'
          && Object.values(state.credentials).some((record) => record.botId === normalizedBotId)) {
          fail('Bot credential restore requires an empty target', 'bot_credential_restore_collision');
        }
        if (Object.keys(restored).length > 0) {
          await persist({
            version: BOT_CREDENTIAL_VAULT_VERSION,
            credentials: { ...state.credentials, ...restored },
          });
        }
        return Object.freeze({ restoredCount: Object.keys(restored).length });
      });
    },

    async inspectRestoreForBot(botId, bytes, { mode = 'merge', deploymentKey } = {}) {
      if (!['empty', 'merge'].includes(mode)) {
        fail('Bot credential restore mode is invalid', 'bot_credential_restore_invalid');
      }
      const { normalizedBotId, restored } = decodeExport(botId, bytes);
      const key = Buffer.from(deploymentKey || []);
      try {
        if (key.byteLength !== 32) {
          fail('Bot credential restore key is invalid', 'bot_credential_restore_integrity_invalid');
        }
        validateRestoredSecrets(restored, key);
      } finally {
        key.fill(0);
      }
      const credentialIds = Object.keys(restored).sort();
      const collisions = credentialIds.filter((credentialId) => Boolean(state.credentials[credentialId]));
      if (mode === 'empty'
        && Object.values(state.credentials).some((record) => record.botId === normalizedBotId)) {
        fail('Bot credential restore requires an empty target', 'bot_credential_restore_collision');
      }
      if (collisions.length > 0) {
        fail('Bot credential restore would overwrite an identity', 'bot_credential_restore_collision');
      }
      return Object.freeze({ credentialIds: Object.freeze(credentialIds) });
    },

    async deleteForBot(botId) {
      return mutate(async () => {
        const normalizedBotId = normalizeUuid(botId, 'Bot ID');
        const retained = Object.fromEntries(Object.entries(state.credentials)
          .filter(([, record]) => record.botId !== normalizedBotId));
        const deletedCount = Object.keys(state.credentials).length - Object.keys(retained).length;
        if (deletedCount > 0) {
          await persist({ version: BOT_CREDENTIAL_VAULT_VERSION, credentials: retained });
        }
        return Object.freeze({ deletedCount });
      });
    },

    async deleteCreated(credentialId) {
      return mutate(async () => {
        const normalizedId = normalizeUuid(credentialId, 'ID');
        if (!state.credentials[normalizedId]) return false;
        const retained = { ...state.credentials };
        delete retained[normalizedId];
        await persist({ version: BOT_CREDENTIAL_VAULT_VERSION, credentials: retained });
        return true;
      });
    },

    toSupabaseRecord(credentialId) {
      return supabaseRecord(findRecord(credentialId));
    },

    paths: Object.freeze({ vaultPath }),
  };
}
