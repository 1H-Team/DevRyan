import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  assertExactObject,
  validateBoundedString,
  validateUuid,
} from './validation.js';

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_SECRETS = 128;
const MAX_VALUE_BYTES = 16 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024;
const RESERVED_EXACT = new Set([
  'HOME', 'PATH', 'SHELL', 'USER', 'LOGNAME', 'PWD', 'OLDPWD',
  'NODE_OPTIONS', 'NODE_PATH', 'BUN_OPTIONS', 'HTTP_PROXY', 'HTTPS_PROXY',
  'ALL_PROXY', 'NO_PROXY',
]);

export class BotEnvironmentSecretsError extends Error {
  constructor(message, code = 'bot_environment_secret_invalid', statusCode = 400) {
    super(message);
    this.name = 'BotEnvironmentSecretsError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (message, code, statusCode) => {
  throw new BotEnvironmentSecretsError(message, code, statusCode);
};

export const validateBotEnvironmentSecretName = (value) => {
  const name = validateBoundedString(value, 'Environment secret name', {
    maximum: 128,
    pattern: NAME_PATTERN,
  });
  const upper = name.toUpperCase();
  if (upper.startsWith('DEVRYAN_') || upper.startsWith('OPENCODE_')
    || upper.startsWith('XDG_') || upper.endsWith('_PROXY') || RESERVED_EXACT.has(upper)) {
    fail('Environment secret name is reserved', 'bot_environment_secret_reserved', 409);
  }
  return name;
};

const validateValue = (value) => {
  if (typeof value !== 'string' || value.length < 1 || value.includes('\0')
    || Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) {
    fail('Environment secret value must be between 1 byte and 16 KiB');
  }
  return value;
};

const publicSecret = (row) => Object.freeze({
  name: row.name,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const listAll = async (repository, botId) => {
  const rows = [];
  let cursor = null;
  do {
    const page = await repository.list({ filters: { bot_id: botId }, cursor, limit: 100 });
    rows.push(...page.items);
    if (rows.length > MAX_SECRETS) {
      fail('Bot environment-secret inventory exceeds its limit', 'bot_environment_secret_limit', 413);
    }
    cursor = page.nextCursor;
  } while (cursor);
  return rows;
};

const writeRunEnvironment = async ({ dataDirectory, runId, variables, fsPromises }) => {
  const directory = path.join(dataDirectory, 'bots', 'runtime', 'environment', runId);
  const target = path.join(directory, 'environment.json');
  await fsPromises.rm(directory, { recursive: true, force: true });
  await fsPromises.mkdir(directory, { recursive: true, mode: 0o700 });
  await fsPromises.chmod(directory, 0o700);
  const handle = await fsPromises.open(target, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ version: 1, variables })}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsPromises.chmod(target, 0o400);
  return Object.freeze({ directory, path: target, count: Object.keys(variables).length });
};

export function createBotEnvironmentSecrets({
  store,
  authorization,
  vault,
  audit = async () => {},
  dataDirectory,
  uuid = randomUUID,
  fsPromises = fs,
} = {}) {
  const repository = store?.repositories?.bot_environment_secrets;
  if (!repository || typeof repository.list !== 'function' || typeof repository.get !== 'function'
    || typeof repository.insert !== 'function' || typeof repository.updateIfRevision !== 'function'
    || typeof store.deleteCreated !== 'function'
    || !authorization || typeof authorization.requireManager !== 'function'
    || !vault || typeof vault.create !== 'function' || typeof vault.read !== 'function'
    || typeof vault.rotate !== 'function' || typeof vault.delete !== 'function'
    || typeof vault.rollbackRotation !== 'function' || typeof vault.deleteBot !== 'function'
    || typeof vault.rollbackDelete !== 'function'
    || typeof audit !== 'function' || typeof dataDirectory !== 'string'
    || !path.isAbsolute(dataDirectory) || typeof uuid !== 'function') {
    throw new TypeError('Bot environment secrets runtime is misconfigured');
  }
  const activeRuns = new Map();

  const finalizeRun = async (runIdInput) => {
    const runId = validateUuid(runIdInput, 'runId');
    activeRuns.delete(runId);
    await fsPromises.rm(
      path.join(dataDirectory, 'bots', 'runtime', 'environment', runId),
      { recursive: true, force: true },
    );
    return Object.freeze({ removed: true });
  };

  const validateInventorySize = async (rows, replacement = null) => {
    let totalBytes = replacement ? Buffer.byteLength(replacement.value, 'utf8') : 0;
    for (const row of rows) {
      if (replacement?.id === row.id) continue;
      const secret = await vault.read(row.id);
      totalBytes += Buffer.byteLength(secret.value, 'utf8');
      if (totalBytes > MAX_TOTAL_BYTES) {
        fail('Bot environment secrets exceed 256 KiB', 'bot_environment_secret_limit', 413);
      }
    }
  };

  return Object.freeze({
    async list(principal, botIdInput) {
      const botId = validateUuid(botIdInput, 'botId');
      await authorization.requireManager(principal, botId);
      const rows = await listAll(repository, botId);
      return Object.freeze({
        environmentSecrets: Object.freeze(rows
          .sort((left, right) => left.name.localeCompare(right.name))
          .map(publicSecret)),
      });
    },

    async put(principal, botIdInput, nameInput, request) {
      const botId = validateUuid(botIdInput, 'botId');
      const name = validateBotEnvironmentSecretName(nameInput);
      assertExactObject(request, {
        label: 'Bot environment secret write',
        required: ['value', 'expectedUpdatedAt'],
      });
      const value = validateValue(request.value);
      const expectedUpdatedAt = request.expectedUpdatedAt;
      if (expectedUpdatedAt !== null
        && (typeof expectedUpdatedAt !== 'string' || !Number.isFinite(Date.parse(expectedUpdatedAt)))) {
        fail('Environment secret revision is invalid');
      }
      await authorization.requireManager(principal, botId);
      const existing = await repository.get({ bot_id: botId, name });
      const rows = await listAll(repository, botId);
      if (!existing && rows.length >= MAX_SECRETS) {
        fail('A Bot can have at most 128 environment secrets', 'bot_environment_secret_limit', 413);
      }
      if ((existing && existing.updated_at !== expectedUpdatedAt)
        || (!existing && expectedUpdatedAt !== null)) {
        fail('Environment secret changed before this operation completed', 'bot_environment_secret_conflict', 409);
      }
      await validateInventorySize(rows, { id: existing?.id || null, value });

      let row;
      if (!existing) {
        const id = validateUuid(uuid(), 'environmentSecretId');
        const metadata = await vault.create({
          id,
          botId,
          name,
          createdBy: validateUuid(principal?.id, 'principal.id'),
          value,
        });
        try {
          row = await repository.insert({
            id,
            bot_id: botId,
            name,
            local_vault_reference: metadata.localVaultReference,
            status: 'active',
            created_by: validateUuid(principal?.id, 'principal.id'),
          });
        } catch (error) {
          try {
            await vault.delete(id);
          } catch {
            fail('Environment secret creation requires vault reconciliation',
              'bot_environment_secret_reconciliation_required', 503);
          }
          if (error?.code === '23505') {
            fail('Environment secret changed before this operation completed', 'bot_environment_secret_conflict', 409);
          }
          throw error;
        }
      } else {
        const rotated = await vault.rotate(existing.id, value);
        try {
          row = await repository.updateIfRevision(
            { id: existing.id, bot_id: botId },
            { status: 'active' },
            expectedUpdatedAt,
          );
        } catch (error) {
          try {
            await vault.rollbackRotation(
              existing.id,
              rotated.metadata.secretVersion,
              rotated.previous,
            );
          } catch {
            fail('Environment secret rotation requires vault reconciliation',
              'bot_environment_secret_reconciliation_required', 503);
          }
          if (error?.code === 'bot_revision_conflict') {
            fail('Environment secret changed before this operation completed', 'bot_environment_secret_conflict', 409);
          }
          throw error;
        }
      }
      await audit({
        principal,
        botId,
        targetType: 'bot_environment_secret',
        targetId: row.id,
        action: existing ? 'bot.environment_secret.rotate' : 'bot.environment_secret.create',
        result: 'success',
        metadata: { name },
      });
      return Object.freeze({ environmentSecret: publicSecret(row) });
    },

    async remove(principal, botIdInput, nameInput, request) {
      const botId = validateUuid(botIdInput, 'botId');
      const name = validateBotEnvironmentSecretName(nameInput);
      assertExactObject(request, {
        label: 'Bot environment secret deletion',
        required: ['expectedUpdatedAt'],
      });
      await authorization.requireManager(principal, botId);
      const row = await repository.get({ bot_id: botId, name });
      if (!row) fail('Environment secret was not found', 'bot_environment_secret_not_found', 404);
      if (request.expectedUpdatedAt !== row.updated_at) {
        fail('Environment secret changed before this operation completed', 'bot_environment_secret_conflict', 409);
      }
      const deleted = await vault.delete(row.id);
      try {
        await store.deleteCreated('bot_environment_secrets', { id: row.id, bot_id: botId });
      } catch (error) {
        try {
          await vault.rollbackDelete(row.id, deleted.previous);
        } catch {
          fail('Environment secret deletion requires vault reconciliation',
            'bot_environment_secret_reconciliation_required', 503);
        }
        throw error;
      }
      await audit({
        principal,
        botId,
        targetType: 'bot_environment_secret',
        targetId: row.id,
        action: 'bot.environment_secret.delete',
        result: 'success',
        metadata: { name },
      });
      return Object.freeze({ deleted: true, name });
    },

    async prepareRun(run) {
      const runId = validateUuid(run?.id, 'run.id');
      const botId = validateUuid(run?.botId, 'run.botId');
      if (activeRuns.has(runId)) return activeRuns.get(runId);
      const rows = (await listAll(repository, botId)).filter((row) => row.status === 'active');
      const variables = {};
      let totalBytes = 0;
      try {
        for (const row of rows) {
          const secret = await vault.read(row.id);
          if (secret.metadata.botId !== botId || secret.metadata.name !== row.name) {
            fail('Bot environment secret identity failed verification', 'bot_environment_secrets_unavailable', 503);
          }
          totalBytes += Buffer.byteLength(secret.value, 'utf8');
          if (totalBytes > MAX_TOTAL_BYTES) {
            fail('Bot environment secrets exceed their run limit', 'bot_environment_secrets_unavailable', 503);
          }
          variables[row.name] = secret.value;
        }
        const materialized = await writeRunEnvironment({
          dataDirectory,
          runId,
          variables,
          fsPromises,
        });
        activeRuns.set(runId, materialized);
        return materialized;
      } catch (error) {
        await fsPromises.rm(
          path.join(dataDirectory, 'bots', 'runtime', 'environment', runId),
          { recursive: true, force: true },
        ).catch(() => undefined);
        if (error instanceof BotEnvironmentSecretsError) throw error;
        fail('Bot environment secrets are unavailable', 'bot_environment_secrets_unavailable', 503);
      }
    },

    async finalizeRun(runIdInput) {
      return finalizeRun(runIdInput);
    },

    async purgeBot(botIdInput) {
      const botId = validateUuid(botIdInput, 'botId');
      const rows = await listAll(repository, botId);
      for (const row of rows) {
        await store.deleteCreated('bot_environment_secrets', { id: row.id, bot_id: botId });
      }
      const result = await vault.deleteBot(botId);
      return Object.freeze({ deletedCount: rows.length, vaultDeletedCount: result.deletedCount });
    },

    async shutdown() {
      await Promise.all([...activeRuns.keys()].map(finalizeRun));
    },
  });
}
