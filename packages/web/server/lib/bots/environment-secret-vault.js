import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { decryptBotJson, encryptBotJson } from './encryption.js';

const VAULT_VERSION = 1;
const KEY_ID = 'deployment-v1';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_SECRET_COUNT = 128;
const MAX_TOTAL_VALUE_BYTES = 256 * 1024;
const RECORD_KEYS = Object.freeze([
  'id',
  'botId',
  'name',
  'createdBy',
  'createdAt',
  'updatedAt',
  'secretVersion',
  'secretEnvelope',
]);

export class BotEnvironmentSecretVaultError extends Error {
  constructor(message, code = 'bot_environment_secret_vault_invalid') {
    super(message);
    this.name = 'BotEnvironmentSecretVaultError';
    this.code = code;
  }
}

const fail = (message, code) => {
  throw new BotEnvironmentSecretVaultError(message, code);
};

const normalizeUuid = (value, field) => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!UUID_PATTERN.test(normalized)) fail(`Bot environment secret ${field} is invalid`);
  return normalized;
};

const normalizeName = (value) => {
  if (typeof value !== 'string' || !NAME_PATTERN.test(value)) {
    fail('Bot environment secret name is invalid', 'bot_environment_secret_invalid');
  }
  return value;
};

const normalizeValue = (value) => {
  if (typeof value !== 'string' || value.length < 1 || value.includes('\0')
    || Buffer.byteLength(value, 'utf8') > 16 * 1024) {
    fail('Bot environment secret value is invalid', 'bot_environment_secret_invalid');
  }
  return value;
};

const associatedData = (id, version) => `devryan-bot-environment-secret:${id}:v${version}`;
const vaultReference = (id) => `bot-environment-secret:${id}`;
const clone = (value) => structuredClone(value);

const validateRecord = (input, { expectedBotId = null, expectedId = null } = {}) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).sort().join('\0') !== [...RECORD_KEYS].sort().join('\0')) {
    fail('Bot environment secret vault record is invalid');
  }
  const id = normalizeUuid(input.id, 'ID');
  const botId = normalizeUuid(input.botId, 'Bot ID');
  if ((expectedId && id !== expectedId) || (expectedBotId && botId !== expectedBotId)
    || normalizeUuid(input.createdBy, 'creator ID') !== input.createdBy
    || normalizeName(input.name) !== input.name
    || !Number.isSafeInteger(input.secretVersion) || input.secretVersion < 1
    || !Number.isFinite(Date.parse(input.createdAt))
    || !Number.isFinite(Date.parse(input.updatedAt))
    || !input.secretEnvelope || typeof input.secretEnvelope !== 'object'
    || Array.isArray(input.secretEnvelope)) {
    fail('Bot environment secret vault record is invalid');
  }
  return input;
};

const publicMetadata = (record) => Object.freeze({
  id: record.id,
  botId: record.botId,
  name: record.name,
  localVaultReference: vaultReference(record.id),
  secretVersion: record.secretVersion,
  createdBy: record.createdBy,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

const parseRecoveryDocument = (bytes, expectedBotId) => {
  let document;
  try {
    document = JSON.parse(Buffer.from(bytes || []).toString('utf8'));
  } catch {
    fail('Bot environment secret recovery document is invalid');
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)
    || Object.keys(document).sort().join('\0') !== 'botId\0records\0version'
    || document.version !== VAULT_VERSION || document.botId !== expectedBotId
    || !Array.isArray(document.records) || document.records.length > MAX_SECRET_COUNT) {
    fail('Bot environment secret recovery document is invalid');
  }
  return document;
};

const loadState = async (vaultPath, fsPromises) => {
  try {
    const state = JSON.parse(await fsPromises.readFile(vaultPath, 'utf8'));
    if (!state || typeof state !== 'object' || Array.isArray(state)
      || Object.keys(state).sort().join('\0') !== 'secrets\0version'
      || state.version !== VAULT_VERSION || !state.secrets
      || typeof state.secrets !== 'object' || Array.isArray(state.secrets)) {
      fail('Bot environment secret vault is invalid');
    }
    return state;
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: VAULT_VERSION, secrets: {} };
    if (error instanceof BotEnvironmentSecretVaultError) throw error;
    fail('Bot environment secret vault could not be read', 'bot_environment_secret_vault_unavailable');
  }
};

const atomicWrite = async (vaultPath, state, fsPromises) => {
  const directory = path.dirname(vaultPath);
  await fsPromises.mkdir(directory, { recursive: true, mode: 0o700 });
  await fsPromises.chmod(directory, 0o700);
  const temporary = `${vaultPath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await fsPromises.open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(state)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fsPromises.rename(temporary, vaultPath);
    await fsPromises.chmod(vaultPath, 0o600);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fsPromises.unlink(temporary).catch(() => undefined);
    throw error;
  }
};

export async function createBotEnvironmentSecretVault({
  dataDirectory,
  getBotEncryptionKey,
  now = () => new Date(),
  fsPromises = fs,
} = {}) {
  if (typeof dataDirectory !== 'string' || !path.isAbsolute(dataDirectory)
    || typeof getBotEncryptionKey !== 'function') {
    fail('Bot environment secret vault configuration is invalid');
  }
  const vaultPath = path.join(dataDirectory, 'bots', 'vault', 'environment-secrets.v1.json');
  let state = await loadState(vaultPath, fsPromises);
  let mutation = Promise.resolve();

  const timestamp = () => {
    const value = now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      fail('Bot environment secret clock is invalid');
    }
    return value.toISOString();
  };
  const withKey = async (operation) => {
    const supplied = await getBotEncryptionKey();
    const key = Buffer.from(supplied || []);
    try {
      if (key.byteLength !== 32) {
        fail('Bot environment secret encryption key is unavailable', 'bot_os_encryption_unavailable');
      }
      return await operation(key);
    } finally {
      key.fill(0);
      if (Buffer.isBuffer(supplied) || supplied instanceof Uint8Array) supplied.fill(0);
    }
  };
  const persist = async (next) => {
    await atomicWrite(vaultPath, next, fsPromises);
    state = next;
  };
  const mutate = (operation) => {
    const next = mutation.then(operation, operation);
    mutation = next.catch(() => undefined);
    return next;
  };
  const recordFor = (id) => {
    const normalizedId = normalizeUuid(id, 'ID');
    const record = state.secrets[normalizedId];
    if (!record) fail('Bot environment secret was not found', 'bot_environment_secret_not_found');
    return validateRecord(record, { expectedId: normalizedId });
  };

  return Object.freeze({
    async create(input) {
      return mutate(async () => {
        const id = normalizeUuid(input?.id, 'ID');
        if (state.secrets[id]) fail('Bot environment secret already exists', 'bot_environment_secret_exists');
        const botId = normalizeUuid(input?.botId, 'Bot ID');
        const name = normalizeName(input?.name);
        const createdBy = normalizeUuid(input?.createdBy, 'creator ID');
        const value = normalizeValue(input?.value);
        const createdAt = timestamp();
        const secretVersion = 1;
        const secretEnvelope = await withKey((key) => encryptBotJson({
          key,
          keyId: KEY_ID,
          value: { value },
          associatedData: associatedData(id, secretVersion),
        }));
        const record = {
          id, botId, name, createdBy, createdAt, updatedAt: createdAt,
          secretVersion, secretEnvelope,
        };
        await persist({ version: VAULT_VERSION, secrets: { ...state.secrets, [id]: record } });
        return publicMetadata(record);
      });
    },

    async read(id) {
      const record = recordFor(id);
      const decoded = await withKey((key) => decryptBotJson({
        key,
        envelope: record.secretEnvelope,
        expectedKeyId: KEY_ID,
        associatedData: associatedData(record.id, record.secretVersion),
      }));
      const value = normalizeValue(decoded?.value);
      return Object.freeze({ metadata: publicMetadata(record), value });
    },

    async rotate(id, valueInput) {
      return mutate(async () => {
        const record = recordFor(id);
        const value = normalizeValue(valueInput);
        const secretVersion = record.secretVersion + 1;
        const nextRecord = {
          ...record,
          secretVersion,
          updatedAt: timestamp(),
          secretEnvelope: await withKey((key) => encryptBotJson({
            key,
            keyId: KEY_ID,
            value: { value },
            associatedData: associatedData(record.id, secretVersion),
          })),
        };
        await persist({
          version: VAULT_VERSION,
          secrets: { ...state.secrets, [record.id]: nextRecord },
        });
        return Object.freeze({ metadata: publicMetadata(nextRecord), previous: clone(record) });
      });
    },

    async rollbackRotation(id, expectedVersion, previous) {
      return mutate(async () => {
        const record = recordFor(id);
        if (!Number.isSafeInteger(expectedVersion) || record.secretVersion !== expectedVersion
          || !previous || previous.id !== record.id || previous.secretVersion !== expectedVersion - 1) {
          fail('Bot environment secret rotation changed before rollback', 'bot_environment_secret_conflict');
        }
        await persist({
          version: VAULT_VERSION,
          secrets: { ...state.secrets, [record.id]: clone(previous) },
        });
        return publicMetadata(previous);
      });
    },

    async delete(id) {
      return mutate(async () => {
        const record = recordFor(id);
        const secrets = { ...state.secrets };
        delete secrets[record.id];
        await persist({ version: VAULT_VERSION, secrets });
        return Object.freeze({ metadata: publicMetadata(record), previous: clone(record) });
      });
    },

    async rollbackDelete(id, previous) {
      return mutate(async () => {
        const normalizedId = normalizeUuid(id, 'ID');
        if (state.secrets[normalizedId]) {
          fail('Bot environment secret deletion changed before rollback',
            'bot_environment_secret_conflict');
        }
        const record = validateRecord(clone(previous), { expectedId: normalizedId });
        await persist({
          version: VAULT_VERSION,
          secrets: { ...state.secrets, [normalizedId]: record },
        });
        return publicMetadata(record);
      });
    },

    async deleteBot(botIdInput) {
      return mutate(async () => {
        const botId = normalizeUuid(botIdInput, 'Bot ID');
        const secrets = Object.fromEntries(Object.entries(state.secrets)
          .filter(([, record]) => record.botId !== botId));
        const deletedCount = Object.keys(state.secrets).length - Object.keys(secrets).length;
        if (deletedCount > 0) await persist({ version: VAULT_VERSION, secrets });
        return Object.freeze({ deletedCount });
      });
    },

    listMetadata() {
      return Object.freeze(Object.keys(state.secrets).map((id) => publicMetadata(recordFor(id))));
    },

    exportForBot(botIdInput) {
      const botId = normalizeUuid(botIdInput, 'Bot ID');
      const records = Object.values(state.secrets)
        .filter((record) => record.botId === botId)
        .map((record) => clone(record));
      return Buffer.from(JSON.stringify({ version: VAULT_VERSION, botId, records }), 'utf8');
    },

    async inspectRestoreForBot(botIdInput, bytes, { mode, deploymentKey } = {}) {
      const botId = normalizeUuid(botIdInput, 'Bot ID');
      if (!['empty', 'merge'].includes(mode)) fail('Bot environment secret recovery mode is invalid');
      const document = parseRecoveryDocument(bytes, botId);
      const key = Buffer.from(deploymentKey || []);
      try {
        if (key.byteLength !== 32) fail('Bot environment secret recovery key is invalid');
        const ids = [];
        const names = [];
        let totalValueBytes = 0;
        for (const raw of document.records) {
          const id = normalizeUuid(raw?.id, 'ID');
          if (state.secrets[id]) fail('Bot environment secret recovery would overwrite a secret', 'bot_recovery_collision');
          const record = validateRecord(clone(raw), { expectedBotId: botId, expectedId: id });
          const decoded = decryptBotJson({
            key,
            envelope: record.secretEnvelope,
            expectedKeyId: KEY_ID,
            associatedData: associatedData(id, record.secretVersion),
          });
          const value = normalizeValue(decoded?.value);
          totalValueBytes += Buffer.byteLength(value, 'utf8');
          if (totalValueBytes > MAX_TOTAL_VALUE_BYTES) {
            fail('Bot environment secret recovery exceeds the per-Bot value limit');
          }
          ids.push(id);
          names.push(record.name);
        }
        if (new Set(ids).size !== ids.length || new Set(names).size !== names.length) {
          fail('Bot environment secret recovery contains duplicates');
        }
        return Object.freeze({ secretIds: Object.freeze(ids.sort()) });
      } finally {
        key.fill(0);
      }
    },

    async restoreForBot(botIdInput, bytes, { mode } = {}) {
      return mutate(async () => {
        const botId = normalizeUuid(botIdInput, 'Bot ID');
        const document = parseRecoveryDocument(bytes, botId);
        const records = document.records.map((record) => validateRecord(clone(record), {
          expectedBotId: botId,
          expectedId: normalizeUuid(record?.id, 'ID'),
        }));
        const ids = records.map((record) => record.id);
        const names = records.map((record) => record.name);
        if (!['empty', 'merge'].includes(mode) || new Set(ids).size !== ids.length
          || new Set(names).size !== names.length || ids.some((id) => state.secrets[id])) {
          fail('Bot environment secret recovery would overwrite a secret', 'bot_recovery_collision');
        }
        const additions = Object.fromEntries(records.map((record) => [record.id, record]));
        await persist({ version: VAULT_VERSION, secrets: { ...state.secrets, ...additions } });
        return Object.freeze({ restoredCount: ids.length });
      });
    },

    localVaultReference: vaultReference,
  });
}
