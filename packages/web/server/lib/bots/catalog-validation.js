import fs from 'node:fs/promises';
import path from 'node:path';

import { actionArgsAssociatedData, actionResultAssociatedData } from './action-gateway.js';
import { BOT_OBJECT_BUCKET, createBotBlobStore } from './blob-store.js';
import { channelSummaryAssociatedData, memoryAssociatedData, messageAssociatedData } from './channels.js';
import { createBotCredentialVault } from './credential-vault.js';
import { decryptBotJson } from './encryption.js';
import { createBotEnvironmentSecretVault } from './environment-secret-vault.js';
import { botMcpDescriptorAssociatedData } from './mcp-connector.js';
import { botObjectFileName } from './local-object-storage.js';

// Authenticates a restore or import candidate before it can become the live
// catalog: every retained inline envelope with its exact associated data,
// every live encrypted object end to end, and every referenced vault record.
// A wrong key or a single corrupted byte rejects the whole candidate.

const DEPLOYMENT_KEY_ID = 'deployment-v1';
const PAGE_SIZE = 200;

const metadataAad = (kind, id) => `devryan-bot-${kind}:${id}:v1`;
const wrappedKeyAad = (objectId) => `devryan-bot-object-key:${objectId}:v1`;
const candidateAad = (runId) => `devryan:bot-memory-extraction:${runId}`;
const evalCaseAad = (botId, evalCaseId) => `devryan:bot-eval-case:${botId}:${evalCaseId}`;
const telegramAad = (kind, id) => `devryan:telegram:${kind}:${id}`;

export const BOT_CATALOG_ENVELOPES = Object.freeze([
  Object.freeze({ table: 'bot_messages', columns: ['id', 'channel_id', 'body_envelope'], envelopes: [
    { read: (row) => row.body_envelope, aad: (row) => messageAssociatedData(row.channel_id, row.id) },
  ] }),
  Object.freeze({ table: 'bot_channels', columns: ['id', 'current_checkpoint_number', 'summary_envelope'], envelopes: [
    { read: (row) => row.summary_envelope, optional: true, aad: (row) => channelSummaryAssociatedData(row.id, row.current_checkpoint_number) },
  ] }),
  Object.freeze({ table: 'bot_memories', columns: ['id', 'encrypted_content'], envelopes: [
    { read: (row) => row.encrypted_content, aad: (row) => memoryAssociatedData(row.id) },
  ] }),
  Object.freeze({ table: 'bot_memory_versions', columns: ['id', 'memory_id', 'encrypted_content'], envelopes: [
    { read: (row) => row.encrypted_content, aad: (row) => memoryAssociatedData(row.memory_id) },
  ] }),
  Object.freeze({ table: 'bot_memory_extraction_jobs', keyColumn: 'run_id', columns: ['run_id', 'candidate_envelope'], envelopes: [
    { read: (row) => row.candidate_envelope, optional: true, aad: (row) => candidateAad(row.run_id) },
  ] }),
  Object.freeze({ table: 'bot_action_attempts', columns: ['id', 'action_hash', 'encrypted_args', 'execution_receipt'], envelopes: [
    { read: (row) => row.encrypted_args, aad: (row) => actionArgsAssociatedData(row.id, row.action_hash) },
    { read: (row) => row.execution_receipt?.resultEnvelope, optional: true, aad: (row) => actionResultAssociatedData(row.id, row.action_hash) },
  ] }),
  Object.freeze({ table: 'bot_objects', columns: ['id', 'wrapped_key', 'deleted_at'], envelopes: [
    { read: (row) => row.wrapped_key, aad: (row) => wrappedKeyAad(row.id) },
  ] }),
  Object.freeze({ table: 'bot_library_sources', columns: ['id', 'provenance', 'host_path_envelope'], envelopes: [
    // Provenance written before encryption was introduced stays plaintext and
    // is read as such (library-runtime.js); only envelopes are authenticated.
    { read: (row) => (row.provenance?.algorithm === 'aes-256-gcm' ? row.provenance : null), optional: true, aad: (row) => metadataAad('library-source-provenance', row.id) },
    { read: (row) => row.host_path_envelope, optional: true, aad: (row) => metadataAad('library-source-path', row.id) },
  ] }),
  Object.freeze({ table: 'bot_library_versions', columns: ['id', 'manifest_envelope', 'diff_envelope'], envelopes: [
    { read: (row) => row.manifest_envelope, aad: (row) => metadataAad('library-manifest', row.id) },
    { read: (row) => row.diff_envelope, optional: true, aad: (row) => metadataAad('library-diff', row.id) },
  ] }),
  Object.freeze({ table: 'bot_mcp_bindings', columns: ['id', 'descriptor_envelope'], envelopes: [
    { read: (row) => row.descriptor_envelope, aad: (row) => botMcpDescriptorAssociatedData(row.id) },
  ] }),
  Object.freeze({ table: 'bot_eval_cases', columns: ['id', 'bot_id', 'input_envelope'], envelopes: [
    { read: (row) => row.input_envelope, aad: (row) => evalCaseAad(row.bot_id, row.id) },
  ] }),
  Object.freeze({ table: 'bot_telegram_inbox', columns: ['id', 'payload_envelope'], envelopes: [
    { read: (row) => row.payload_envelope, aad: (row) => telegramAad('inbox', row.id) },
  ] }),
  Object.freeze({ table: 'bot_telegram_outbox', columns: ['id', 'payload_envelope'], envelopes: [
    { read: (row) => row.payload_envelope, aad: (row) => telegramAad('outbox', row.id) },
  ] }),
]);

export class BotCatalogValidationError extends Error {
  constructor(message, code, report = null) {
    super(message);
    this.name = 'BotCatalogValidationError';
    this.code = code;
    this.statusCode = 422;
    this.report = report;
  }
}

const withKey = async (encryption, operation) => {
  const provided = await encryption.getKey();
  const key = Buffer.from(provided || []);
  try {
    if (key.byteLength !== 32) {
      throw new BotCatalogValidationError('The Bot encryption key is unavailable', 'bot_os_encryption_unavailable');
    }
    return await operation(key);
  } finally {
    key.fill(0);
    if (Buffer.isBuffer(provided) || provided instanceof Uint8Array) provided.fill(0);
  }
};

// Reads every page of one candidate table through the host's bounded reader.
async function* readAll(readPage, spec) {
  const keyColumn = spec.keyColumn || 'id';
  let after = null;
  for (;;) {
    const rows = await readPage({ table: spec.table, columns: spec.columns, keyColumn, afterId: after, limit: PAGE_SIZE });
    if (!Array.isArray(rows)) throw new BotCatalogValidationError('The candidate page is invalid', 'bot_catalog_candidate_invalid');
    for (const row of rows) yield row;
    if (rows.length < PAGE_SIZE) return;
    after = rows.at(-1)?.[keyColumn];
    if (typeof after !== 'string') throw new BotCatalogValidationError('The candidate page is invalid', 'bot_catalog_candidate_invalid');
  }
}

export async function validateBotCatalogCandidate({
  readPage,
  encryption,
  objectsDirectory,
  hostStateDirectory,
  missingVaultRecord = 'reject',
  recordProgress = () => {},
} = {}) {
  if (typeof readPage !== 'function' || typeof encryption?.getKey !== 'function'
    || typeof objectsDirectory !== 'string' || !path.isAbsolute(objectsDirectory)
    || typeof hostStateDirectory !== 'string' || !path.isAbsolute(hostStateDirectory)
    || !['reject', 'disconnect'].includes(missingVaultRecord)) {
    throw new TypeError('Bot catalog validation is misconfigured');
  }
  const report = {
    envelopes: 0,
    objects: 0,
    vaultRecords: 0,
    disconnected: { credentials: [], environmentSecrets: [], telegramConnections: [] },
  };

  await withKey(encryption, async (key) => {
    for (const spec of BOT_CATALOG_ENVELOPES) {
      recordProgress({ phase: 'envelopes', table: spec.table });
      for await (const row of readAll(readPage, spec)) {
        for (const envelope of spec.envelopes) {
          const value = envelope.read(row);
          if (value === null || value === undefined) {
            if (envelope.optional) continue;
            throw new BotCatalogValidationError(`A ${spec.table} envelope is missing`, 'bot_catalog_envelope_missing', { table: spec.table });
          }
          try {
            decryptBotJson({ key, envelope: value, expectedKeyId: DEPLOYMENT_KEY_ID, associatedData: envelope.aad(row) });
          } catch {
            throw new BotCatalogValidationError(
              `A ${spec.table} envelope failed authentication`,
              'bot_catalog_envelope_invalid',
              { table: spec.table },
            );
          }
          report.envelopes += 1;
        }
      }
    }
  });

  // Every live object, end to end, through the existing blob decryptor.
  recordProgress({ phase: 'objects' });
  const objectSpec = {
    table: 'bot_objects',
    columns: [
      'id', 'bot_id', 'channel_id', 'visibility', 'storage_bucket', 'storage_object_name', 'object_key_envelope',
      'ciphertext_hash', 'ciphertext_size', 'wrapped_key', 'content_type', 'expires_at', 'deleted_at',
    ],
  };
  const rowsById = new Map();
  const blobStore = createBotBlobStore({
    store: {
      get: async (_table, keys) => rowsById.get(keys.id) || null,
      storage: {
        download: async (bucket, objectName, { maximumBytes } = {}) => {
          if (bucket !== BOT_OBJECT_BUCKET) throw new BotCatalogValidationError('A Bot object bucket is invalid', 'bot_catalog_object_invalid');
          const file = path.join(objectsDirectory, botObjectFileName(objectName));
          let bytes;
          try {
            bytes = await fs.readFile(file);
          } catch {
            throw new BotCatalogValidationError('A live Bot object is missing', 'bot_catalog_object_missing');
          }
          if (Number.isSafeInteger(maximumBytes) && bytes.byteLength > maximumBytes) {
            throw new BotCatalogValidationError('A Bot object exceeds its recorded size', 'bot_catalog_object_invalid');
          }
          return bytes;
        },
      },
    },
    authorization: {},
    encryption,
  });
  for await (const row of readAll(readPage, objectSpec)) {
    if (row.deleted_at) continue;
    rowsById.set(row.id, { ...row, expires_at: null });
    try {
      const downloaded = await blobStore.downloadAuthorized({ botId: row.bot_id, objectId: row.id });
      downloaded?.bytes?.fill?.(0);
    } catch (error) {
      if (error instanceof BotCatalogValidationError) throw error;
      throw new BotCatalogValidationError('A Bot object failed authentication', 'bot_catalog_object_invalid');
    } finally {
      rowsById.delete(row.id);
    }
    report.objects += 1;
  }

  // Referenced vault records must exist and decrypt under this host's key.
  recordProgress({ phase: 'vaults' });
  const getBotEncryptionKey = () => encryption.getKey();
  const credentialVault = await createBotCredentialVault({ dataDirectory: hostStateDirectory, getBotEncryptionKey });
  const environmentVault = await createBotEnvironmentSecretVault({ dataDirectory: hostStateDirectory, getBotEncryptionKey });
  const telegramVault = await createBotCredentialVault({
    dataDirectory: path.join(hostStateDirectory, 'bot-integrations', 'telegram'),
    getBotEncryptionKey,
  });
  const check = async (vault, reference, bucket, rowId) => {
    try {
      await vault.read(reference);
      report.vaultRecords += 1;
    } catch {
      if (missingVaultRecord === 'disconnect') {
        report.disconnected[bucket].push(rowId);
        return;
      }
      throw new BotCatalogValidationError('A referenced vault record is missing or invalid', 'bot_catalog_vault_record_invalid', { bucket });
    }
  };
  for await (const row of readAll(readPage, {
    table: 'bot_credentials', columns: ['id', 'local_vault_reference', 'status', 'revoked_at'],
  })) {
    if (row.revoked_at || !row.local_vault_reference) continue;
    // The column holds a prefixed reference; the vault is keyed by the row id.
    await check(credentialVault, row.id, 'credentials', row.id);
  }
  for await (const row of readAll(readPage, {
    table: 'bot_environment_secrets', columns: ['id', 'local_vault_reference', 'status'],
  })) {
    if (row.status !== 'active' || !row.local_vault_reference) continue;
    await check(environmentVault, row.id, 'environmentSecrets', row.id);
  }
  for await (const row of readAll(readPage, {
    table: 'bot_telegram_connections', keyColumn: 'bot_id', columns: ['bot_id', 'credential_id', 'enabled'],
  })) {
    if (!row.credential_id) continue;
    await check(telegramVault, row.credential_id, 'telegramConnections', row.bot_id);
  }
  return Object.freeze(report);
}
