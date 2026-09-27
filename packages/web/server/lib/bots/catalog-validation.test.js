import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { actionArgsAssociatedData, actionResultAssociatedData } from './action-gateway.js';
import { createBotBlobStore } from './blob-store.js';
import {
  BOT_CATALOG_ENVELOPES,
  BotCatalogValidationError,
  validateBotCatalogCandidate,
} from './catalog-validation.js';
import { channelSummaryAssociatedData, memoryAssociatedData, messageAssociatedData } from './channels.js';
import { createBotCredentialVault } from './credential-vault.js';
import { encryptBotJson } from './encryption.js';
import { createBotEnvironmentSecretVault } from './environment-secret-vault.js';
import { botObjectFileName, createLocalBotObjectStorage } from './local-object-storage.js';
import { botMcpDescriptorAssociatedData } from './mcp-connector.js';

const KEY = Buffer.alloc(32, 0x5a);
const OTHER_KEY = Buffer.alloc(32, 0x3c);
const KEY_ID = 'deployment-v1';
const PAGE_SIZE = 200;
const CREATOR_ID = randomUUID();
const PRINCIPAL = Object.freeze({ id: CREATOR_ID });

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const workspace = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-bot-catalog-validation-'));
  directories.push(root);
  return {
    objectsDirectory: path.join(root, 'objects'),
    hostStateDirectory: path.join(root, 'host-state'),
  };
};

// Every issued key copy is tracked so tests can prove the validator zeroes it.
const encryptionFor = (key = KEY, issued = []) => ({
  getKey: async () => {
    const copy = Buffer.from(key);
    issued.push(copy);
    return copy;
  },
});

const seal = (value, associatedData, { key = KEY, keyId = KEY_ID } = {}) => encryptBotJson({
  key, keyId, value, associatedData,
});

const compareKeys = (left, right) => {
  if (left < right) return -1;
  return left > right ? 1 : 0;
};

// A bounded, keyset-paginated reader over in-memory candidate tables that
// projects exactly the requested columns, like the host's candidate reader.
const candidateReader = (tables = {}) => {
  const calls = [];
  const readPage = async ({ table, columns, keyColumn, afterId, limit }) => {
    calls.push({ table, columns: [...columns], keyColumn, afterId, limit });
    return (tables[table] || [])
      .slice()
      .sort((left, right) => compareKeys(left[keyColumn], right[keyColumn]))
      .filter((row) => afterId === null || row[keyColumn] > afterId)
      .slice(0, limit)
      .map((row) => structuredClone(Object.fromEntries(columns.map((column) => [column, row[column] ?? null]))));
  };
  return { readPage, calls };
};

const allowAll = Object.freeze({
  requireManager: async () => {},
  requireActiveMembership: async () => {},
  requireChannelSend: async () => {},
  requireChannelRead: async () => {},
});

// Produces bot_objects and bot_library_versions rows through the real blob
// store and local object storage, so the fixtures carry production envelopes,
// object AAD, ciphertext hashes and on-disk file names.
const objectFixtures = async (objectsDirectory) => {
  const storage = await createLocalBotObjectStorage({ directory: objectsDirectory });
  const rows = new Map();
  const rowKey = (table, id) => `${table}:${id}`;
  const store = {
    storage: {
      upload: (bucket, name, bytes, options) => storage.storageUpload(bucket, name, bytes, options),
      download: (bucket, name, options) => storage.storageDownload(bucket, name, options),
      delete: (bucket, names) => storage.storageDelete(bucket, names),
    },
    insert: async (table, row) => {
      const stored = { ...structuredClone(row), created_at: '2026-09-26T00:00:00.000Z', updated_at: '2026-09-26T00:00:00.000Z' };
      rows.set(rowKey(table, row.id), stored);
      return structuredClone(stored);
    },
    get: async (table, keys) => structuredClone(rows.get(rowKey(table, keys.id)) || null),
    list: async () => ({ items: [] }),
    updateIfRevision: async (table, keys, patch) => {
      const next = { ...rows.get(rowKey(table, keys.id)), ...patch };
      rows.set(rowKey(table, keys.id), next);
      return structuredClone(next);
    },
    deleteCreated: async () => {},
  };
  const blobStore = createBotBlobStore({ store, authorization: allowAll, encryption: encryptionFor() });
  const createObject = (botId, text = 'catalog object bytes') => blobStore.createLibraryObject({
    principal: PRINCIPAL, botId, contentType: 'text/plain', bytes: Buffer.from(text), provenance: {},
  });
  const publishVersion = async (botId, objectId) => {
    const sourceId = randomUUID();
    await store.insert('bot_library_sources', {
      id: sourceId, bot_id: botId, retired_at: null, current_published_version_id: null,
    });
    return blobStore.publishToLibrary({ principal: PRINCIPAL, botId, objectId, sourceId });
  };
  return { createObject, publishVersion };
};

const objectFile = (objectsDirectory, row) => path.join(objectsDirectory, botObjectFileName(row.storage_object_name));

const telegramVaultFor = (hostStateDirectory, key = KEY) => createBotCredentialVault({
  dataDirectory: path.join(hostStateDirectory, 'bot-integrations', 'telegram'),
  getBotEncryptionKey: async () => Buffer.from(key),
});

const createTelegramCredential = async (vault, botId) => {
  const id = randomUUID();
  await vault.create({
    id,
    botId,
    provider: 'telegram',
    kind: 'bot_token',
    credentialScope: 'team',
    ownerUserId: null,
    createdBy: CREATOR_ID,
    metadata: {},
    secret: { token: 'telegram-token-fixture' },
  });
  return id;
};

const messageRow = ({ channelId = randomUUID(), id = randomUUID(), sealed } = {}) => ({
  id,
  channel_id: channelId,
  body_envelope: sealed ?? seal({ text: 'hello' }, messageAssociatedData(channelId, id)),
});

const memoryRow = ({ id = randomUUID(), options } = {}) => ({
  id,
  encrypted_content: seal({ content: 'remember this' }, memoryAssociatedData(id), options),
});

const validate = (tables, { paths, ...options }) => validateBotCatalogCandidate({
  readPage: candidateReader(tables).readPage,
  encryption: encryptionFor(),
  objectsDirectory: paths.objectsDirectory,
  hostStateDirectory: paths.hostStateDirectory,
  ...options,
});

describe('Bot catalog candidate validation', () => {
  it('declares every retained envelope table with a key column that is read', () => {
    expect(Object.isFrozen(BOT_CATALOG_ENVELOPES)).toBe(true);
    const tables = BOT_CATALOG_ENVELOPES.map((spec) => spec.table);
    expect(new Set(tables).size).toBe(tables.length);
    for (const spec of BOT_CATALOG_ENVELOPES) {
      expect(spec.columns).toContain(spec.keyColumn || 'id');
      expect(spec.envelopes.length).toBeGreaterThan(0);
    }
    expect(BOT_CATALOG_ENVELOPES.find((spec) => spec.table === 'bot_memory_extraction_jobs').keyColumn).toBe('run_id');
  });

  it('accepts an authentic candidate and reports envelope, object and vault counts', async () => {
    const paths = await workspace();
    const botId = randomUUID();
    const fixtures = await objectFixtures(paths.objectsDirectory);
    const sourceObject = await fixtures.createObject(botId, 'library source bytes');
    const { object: publishedObject, version } = await fixtures.publishVersion(botId, sourceObject.id);
    // A deleted object keeps its wrapped key but needs no ciphertext on disk.
    const deletedObject = await fixtures.createObject(botId, 'deleted object bytes');
    await fs.rm(objectFile(paths.objectsDirectory, deletedObject));
    deletedObject.deleted_at = '2026-09-25T00:00:00.000Z';

    const telegramVault = await telegramVaultFor(paths.hostStateDirectory);
    const telegramCredentialId = await createTelegramCredential(telegramVault, botId);

    const channelId = randomUUID();
    const memoryId = randomUUID();
    const actionId = randomUUID();
    const bindingId = randomUUID();
    const tables = {
      bot_messages: [messageRow({ channelId })],
      bot_channels: [
        { id: channelId, current_checkpoint_number: 3, summary_envelope: seal({ summary: 'so far' }, channelSummaryAssociatedData(channelId, 3)) },
        { id: randomUUID(), current_checkpoint_number: 0, summary_envelope: null },
      ],
      bot_memories: [memoryRow({ id: memoryId })],
      bot_memory_versions: [{
        id: randomUUID(), memory_id: memoryId, encrypted_content: seal({ content: 'older' }, memoryAssociatedData(memoryId)),
      }],
      bot_memory_extraction_jobs: [{ run_id: randomUUID(), candidate_envelope: null }],
      bot_action_attempts: [
        {
          id: actionId,
          action_hash: 'hash-1',
          encrypted_args: seal({ args: { path: '/tmp/x' } }, actionArgsAssociatedData(actionId, 'hash-1')),
          execution_receipt: { resultEnvelope: seal({ ok: true }, actionResultAssociatedData(actionId, 'hash-1')) },
        },
        (() => {
          const id = randomUUID();
          return { id, action_hash: 'hash-2', encrypted_args: seal({ args: {} }, actionArgsAssociatedData(id, 'hash-2')), execution_receipt: null };
        })(),
      ],
      bot_objects: [sourceObject, publishedObject, deletedObject],
      bot_library_versions: [version],
      bot_mcp_bindings: [{ id: bindingId, descriptor_envelope: seal({ url: 'https://mcp.example.test' }, botMcpDescriptorAssociatedData(bindingId)) }],
      bot_credentials: [
        { id: randomUUID(), local_vault_reference: `bot-credential:${randomUUID()}`, status: 'revoked', revoked_at: '2026-09-01T00:00:00.000Z' },
        { id: randomUUID(), local_vault_reference: null, status: 'active', revoked_at: null },
      ],
      bot_environment_secrets: [
        { id: randomUUID(), local_vault_reference: `bot-environment-secret:${randomUUID()}`, status: 'deleted' },
      ],
      bot_telegram_connections: [
        { bot_id: botId, credential_id: telegramCredentialId, enabled: true },
        { bot_id: randomUUID(), credential_id: null, enabled: false },
      ],
    };
    const progress = [];
    const issued = [];
    const reader = candidateReader(tables);

    const report = await validateBotCatalogCandidate({
      readPage: reader.readPage,
      encryption: encryptionFor(KEY, issued),
      ...paths,
      recordProgress: (entry) => progress.push(entry),
    });

    // messages 1 + channel summary 1 + memory 1 + memory version 1 + action args/result 3
    // + wrapped object keys 3 + library manifest/diff 2 + MCP descriptor 1.
    expect(report).toEqual({
      envelopes: 13,
      objects: 2,
      vaultRecords: 1,
      disconnected: { credentials: [], environmentSecrets: [], telegramConnections: [] },
    });
    expect(Object.isFrozen(report)).toBe(true);
    expect(progress.map((entry) => entry.phase)).toEqual([
      ...BOT_CATALOG_ENVELOPES.map(() => 'envelopes'),
      'objects',
      'vaults',
    ]);
    expect(progress.filter((entry) => entry.phase === 'envelopes').map((entry) => entry.table))
      .toEqual(BOT_CATALOG_ENVELOPES.map((spec) => spec.table));
    expect(reader.calls.every((call) => call.limit === PAGE_SIZE && call.afterId === null)).toBe(true);
    expect(reader.calls.find((call) => call.table === 'bot_memory_extraction_jobs').keyColumn).toBe('run_id');
    expect(reader.calls.find((call) => call.table === 'bot_telegram_connections').keyColumn).toBe('bot_id');
    // Every key copy handed to the validator and the blob/vault readers is wiped.
    expect(issued.length).toBeGreaterThan(0);
    expect(issued.every((copy) => copy.every((byte) => byte === 0))).toBe(true);
  });

  it('rejects an envelope sealed under a different deployment key', async () => {
    const paths = await workspace();
    const tables = {
      bot_messages: [messageRow()],
      bot_memories: [memoryRow({ options: { key: OTHER_KEY } })],
    };

    const failure = await validate(tables, { paths }).catch((error) => error);
    expect(failure).toBeInstanceOf(BotCatalogValidationError);
    expect(failure).toMatchObject({
      code: 'bot_catalog_envelope_invalid', statusCode: 422, report: { table: 'bot_memories' },
    });
  });

  it('accepts plaintext Library provenance written before provenance was encrypted', async () => {
    const paths = await workspace();
    const report = await validate({
      bot_library_sources: [
        { id: randomUUID(), provenance: {}, host_path_envelope: null },
        { id: randomUUID(), provenance: { kind: 'folder', label: 'Docs' }, host_path_envelope: null },
      ],
    }, { paths });
    expect(report).toBeTruthy();
  });

  it('rejects an authentic candidate when the host key is not the candidate key', async () => {
    const paths = await workspace();
    await expect(validateBotCatalogCandidate({
      readPage: candidateReader({ bot_messages: [messageRow()] }).readPage,
      encryption: encryptionFor(OTHER_KEY),
      ...paths,
    })).rejects.toMatchObject({ code: 'bot_catalog_envelope_invalid', report: { table: 'bot_messages' } });
  });

  it('rejects an envelope sealed under another key id even with the right key', async () => {
    const paths = await workspace();
    await expect(validate({ bot_memories: [memoryRow({ options: { keyId: 'deployment-v2' } })] }, { paths }))
      .rejects.toMatchObject({ code: 'bot_catalog_envelope_invalid', report: { table: 'bot_memories' } });
  });

  it('rejects an envelope whose associated data belongs to another channel', async () => {
    const paths = await workspace();
    const messageId = randomUUID();
    const sealed = seal({ text: 'moved' }, messageAssociatedData(randomUUID(), messageId));
    await expect(validate({ bot_messages: [messageRow({ id: messageId, sealed })] }, { paths }))
      .rejects.toMatchObject({ code: 'bot_catalog_envelope_invalid', report: { table: 'bot_messages' } });
  });

  it('rejects an envelope transplanted from another row', async () => {
    const paths = await workspace();
    const channelId = randomUUID();
    const original = messageRow({ channelId });
    const transplanted = messageRow({ channelId, sealed: original.body_envelope });
    await expect(validate({ bot_messages: [original, transplanted] }, { paths }))
      .rejects.toMatchObject({ code: 'bot_catalog_envelope_invalid', report: { table: 'bot_messages' } });
  });

  it('binds channel summaries to their checkpoint and action results to their action hash', async () => {
    const paths = await workspace();
    const channelId = randomUUID();
    await expect(validate({
      bot_channels: [{ id: channelId, current_checkpoint_number: 4, summary_envelope: seal({ summary: 'stale' }, channelSummaryAssociatedData(channelId, 3)) }],
    }, { paths })).rejects.toMatchObject({ code: 'bot_catalog_envelope_invalid', report: { table: 'bot_channels' } });

    const actionId = randomUUID();
    await expect(validate({
      bot_action_attempts: [{
        id: actionId,
        action_hash: 'hash-now',
        encrypted_args: seal({ args: {} }, actionArgsAssociatedData(actionId, 'hash-now')),
        execution_receipt: { resultEnvelope: seal({ ok: true }, actionResultAssociatedData(actionId, 'hash-before')) },
      }],
    }, { paths })).rejects.toMatchObject({ code: 'bot_catalog_envelope_invalid', report: { table: 'bot_action_attempts' } });
  });

  it('rejects a missing required envelope but skips a missing optional one', async () => {
    const paths = await workspace();
    await expect(validate({ bot_memories: [{ id: randomUUID(), encrypted_content: null }] }, { paths }))
      .rejects.toMatchObject({ code: 'bot_catalog_envelope_missing', statusCode: 422, report: { table: 'bot_memories' } });

    const report = await validate({
      bot_channels: [{ id: randomUUID(), current_checkpoint_number: 0, summary_envelope: null }],
      bot_memory_extraction_jobs: [{ run_id: randomUUID(), candidate_envelope: null }],
    }, { paths });
    expect(report.envelopes).toBe(0);
  });

  it('rejects a live object whose ciphertext file has a flipped byte', async () => {
    const paths = await workspace();
    const fixtures = await objectFixtures(paths.objectsDirectory);
    const botId = randomUUID();
    const intact = await fixtures.createObject(botId, 'first object');
    const corrupted = await fixtures.createObject(botId, 'second object');
    const file = objectFile(paths.objectsDirectory, corrupted);
    const bytes = await fs.readFile(file);
    bytes[Math.floor(bytes.length / 2)] ^= 0x01;
    await fs.writeFile(file, bytes);

    await expect(validate({ bot_objects: [intact, corrupted] }, { paths }))
      .rejects.toMatchObject({ name: 'BotCatalogValidationError', code: 'bot_catalog_object_invalid', statusCode: 422 });
  });

  it('rejects a live object whose ciphertext file is missing', async () => {
    const paths = await workspace();
    const fixtures = await objectFixtures(paths.objectsDirectory);
    const object = await fixtures.createObject(randomUUID());
    await fs.rm(objectFile(paths.objectsDirectory, object));

    await expect(validate({ bot_objects: [object] }, { paths }))
      .rejects.toMatchObject({ code: 'bot_catalog_object_missing', statusCode: 422 });
  });

  it('rejects an intact object whose row was rebound to another Bot', async () => {
    const paths = await workspace();
    const fixtures = await objectFixtures(paths.objectsDirectory);
    const object = await fixtures.createObject(randomUUID());
    // The wrapped key is bound to the object id only, so the envelope phase
    // passes; the object AAD binds the Bot and must fail end to end.
    await expect(validate({ bot_objects: [{ ...object, bot_id: randomUUID() }] }, { paths }))
      .rejects.toMatchObject({ code: 'bot_catalog_object_invalid' });
  });

  it('rejects a referenced vault record that is missing when missingVaultRecord is reject', async () => {
    const paths = await workspace();
    await expect(validate({
      bot_credentials: [{ id: randomUUID(), local_vault_reference: `bot-credential:${randomUUID()}`, status: 'active', revoked_at: null }],
    }, { paths })).rejects.toMatchObject({
      code: 'bot_catalog_vault_record_invalid', statusCode: 422, report: { bucket: 'credentials' },
    });
    await expect(validate({
      bot_environment_secrets: [{ id: randomUUID(), local_vault_reference: `bot-environment-secret:${randomUUID()}`, status: 'active' }],
    }, { paths, missingVaultRecord: 'reject' })).rejects.toMatchObject({
      code: 'bot_catalog_vault_record_invalid', report: { bucket: 'environmentSecrets' },
    });
    await expect(validate({
      bot_telegram_connections: [{ bot_id: randomUUID(), credential_id: randomUUID(), enabled: true }],
    }, { paths, missingVaultRecord: 'reject' })).rejects.toMatchObject({
      code: 'bot_catalog_vault_record_invalid', report: { bucket: 'telegramConnections' },
    });
  });

  it('reports missing vault records under disconnected when missingVaultRecord is disconnect', async () => {
    const paths = await workspace();
    const telegramVault = await telegramVaultFor(paths.hostStateDirectory);
    const connectedBotId = randomUUID();
    const presentCredentialId = await createTelegramCredential(telegramVault, connectedBotId);
    const credentialRowId = randomUUID();
    const secretRowId = randomUUID();
    const disconnectedBotId = randomUUID();

    const report = await validate({
      bot_credentials: [{ id: credentialRowId, local_vault_reference: `bot-credential:${randomUUID()}`, status: 'active', revoked_at: null }],
      bot_environment_secrets: [{ id: secretRowId, local_vault_reference: `bot-environment-secret:${randomUUID()}`, status: 'active' }],
      bot_telegram_connections: [
        { bot_id: connectedBotId, credential_id: presentCredentialId, enabled: true },
        { bot_id: disconnectedBotId, credential_id: randomUUID(), enabled: true },
      ],
    }, { paths, missingVaultRecord: 'disconnect' });

    expect(report).toEqual({
      envelopes: 0,
      objects: 0,
      vaultRecords: 1,
      disconnected: {
        credentials: [credentialRowId],
        environmentSecrets: [secretRowId],
        telegramConnections: [disconnectedBotId],
      },
    });
  });

  it('rejects a vault record sealed under another key', async () => {
    const paths = await workspace();
    const botId = randomUUID();
    const foreignVault = await telegramVaultFor(paths.hostStateDirectory, OTHER_KEY);
    const credentialId = await createTelegramCredential(foreignVault, botId);

    await expect(validate({
      bot_telegram_connections: [{ bot_id: botId, credential_id: credentialId, enabled: true }],
    }, { paths })).rejects.toMatchObject({
      code: 'bot_catalog_vault_record_invalid', report: { bucket: 'telegramConnections' },
    });
  });

  // Catalog rows store a prefixed reference (`bot-credential:<id>`,
  // `bot-environment-secret:<id>`); both vaults are keyed by the row id.
  it('authenticates present credential and environment-secret records by their stored reference', async () => {
    const paths = await workspace();
    const botId = randomUUID();
    const getBotEncryptionKey = async () => Buffer.from(KEY);
    const credentialVault = await createBotCredentialVault({ dataDirectory: paths.hostStateDirectory, getBotEncryptionKey });
    const environmentVault = await createBotEnvironmentSecretVault({ dataDirectory: paths.hostStateDirectory, getBotEncryptionKey });
    const credential = await credentialVault.create({
      id: randomUUID(),
      botId,
      provider: 'github',
      kind: 'oauth',
      credentialScope: 'team',
      ownerUserId: null,
      createdBy: CREATOR_ID,
      metadata: {},
      secret: { accessToken: 'fixture' },
    });
    const secret = await environmentVault.create({
      id: randomUUID(), botId, name: 'SERVICE_TOKEN', createdBy: CREATOR_ID, value: 'fixture-value',
    });

    const report = await validate({
      bot_credentials: [{ id: credential.id, local_vault_reference: credential.localVaultReference, status: 'active', revoked_at: null }],
      bot_environment_secrets: [{ id: secret.id, local_vault_reference: secret.localVaultReference, status: 'active' }],
    }, { paths });
    expect(report.vaultRecords).toBe(2);
  });

  it('pages through every row using the last key of each full page', async () => {
    const paths = await workspace();
    const channelId = randomUUID();
    const messages = Array.from({ length: 2 * PAGE_SIZE + 50 }, () => messageRow({ channelId }));
    // Exactly two full pages: the reader must accept a trailing empty page.
    const jobs = Array.from({ length: 2 * PAGE_SIZE }, () => ({ run_id: randomUUID(), candidate_envelope: null }));
    const reader = candidateReader({ bot_messages: messages, bot_memory_extraction_jobs: jobs });

    const report = await validateBotCatalogCandidate({
      readPage: reader.readPage,
      encryption: encryptionFor(),
      ...paths,
    });

    expect(report.envelopes).toBe(messages.length);
    const messageIds = messages.map((row) => row.id).sort(compareKeys);
    expect(reader.calls.filter((call) => call.table === 'bot_messages').map((call) => call.afterId))
      .toEqual([null, messageIds[PAGE_SIZE - 1], messageIds[2 * PAGE_SIZE - 1]]);
    const runIds = jobs.map((row) => row.run_id).sort(compareKeys);
    expect(reader.calls.filter((call) => call.table === 'bot_memory_extraction_jobs').map((call) => [call.keyColumn, call.afterId]))
      .toEqual([['run_id', null], ['run_id', runIds[PAGE_SIZE - 1]], ['run_id', runIds[2 * PAGE_SIZE - 1]]]);
  });

  it('rejects a malformed page or a full page without a string cursor', async () => {
    const paths = await workspace();
    await expect(validateBotCatalogCandidate({
      readPage: async () => ({ rows: [] }),
      encryption: encryptionFor(),
      ...paths,
    })).rejects.toMatchObject({ code: 'bot_catalog_candidate_invalid' });

    const numericKeys = Array.from({ length: PAGE_SIZE }, (_, index) => ({ run_id: index, candidate_envelope: null }));
    await expect(validate({ bot_memory_extraction_jobs: numericKeys }, { paths }))
      .rejects.toMatchObject({ code: 'bot_catalog_candidate_invalid' });
  });

  it('fails closed without a usable key and on misconfiguration', async () => {
    const paths = await workspace();
    const readPage = candidateReader({}).readPage;
    await expect(validateBotCatalogCandidate({ readPage, encryption: { getKey: async () => Buffer.alloc(16) }, ...paths }))
      .rejects.toMatchObject({ code: 'bot_os_encryption_unavailable' });
    await expect(validateBotCatalogCandidate({ readPage, encryption: { getKey: async () => null }, ...paths }))
      .rejects.toMatchObject({ code: 'bot_os_encryption_unavailable' });

    const valid = { readPage, encryption: encryptionFor(), ...paths };
    for (const overrides of [
      { readPage: null },
      { encryption: {} },
      { objectsDirectory: 'relative/objects' },
      { hostStateDirectory: 'relative/host' },
      { missingVaultRecord: 'ignore' },
    ]) {
      await expect(validateBotCatalogCandidate({ ...valid, ...overrides })).rejects.toThrow(TypeError);
    }
    await expect(validateBotCatalogCandidate()).rejects.toThrow(TypeError);
  });
});
