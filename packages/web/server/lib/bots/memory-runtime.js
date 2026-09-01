import { createHash, randomUUID } from 'node:crypto';

import { channelSummaryAssociatedData, memoryAssociatedData } from './channels.js';
import { decryptBotJson, encryptBotJson } from './encryption.js';
import {
  botChannelMemoryNamespace,
  botSharedMemoryNamespace,
} from './indexer-client.js';
import {
  BOT_MEMORY_EXTRACTION_SCHEMA,
  buildBotMemoryExtractionPrompt,
  classifyBotMemoryCandidates,
} from './memory-classifier.js';
import { createBotMemoryConsolidation } from './memory-consolidation.js';
import {
  assertExactObject,
  normalizePageLimit,
  validateBoundedString,
  validateUuid,
} from './validation.js';

const DEPLOYMENT_KEY_ID = 'deployment-v1';
const MAX_MEMORY_TEXT_BYTES = 16 * 1024;
const MAX_SUMMARY_ITEMS = 80;
const MAX_SUMMARY_COMMIT_ATTEMPTS = 3;
const SUMMARY_RETRY_DELAYS_MS = Object.freeze([25, 75]);
const EXTRACTION_JOB_CONCURRENCY = 2;
const EXTRACTION_JOB_LEASE_MS = 10 * 60 * 1_000;
const EXTRACTION_JOB_POLL_MS = 5_000;
const EXTRACTION_JOB_MAX_ATTEMPTS = 8;
const EXTRACTION_JOB_RETRY_DELAYS_MS = Object.freeze([
  1_000,
  5_000,
  30_000,
  2 * 60_000,
  10 * 60_000,
  30 * 60_000,
  60 * 60_000,
]);
const MAX_ALL_ROWS = 25_000;
const MEMORY_SENSITIVITIES = new Set(['normal', 'confidential', 'restricted']);
const UNFINISHED_RUN_STATES = new Set([
  'queued',
  'starting',
  'running',
  'waiting_approval',
  'waiting_control',
  'needs_reconciliation',
]);
const TERMINAL_EXTRACTION_CODES = new Set([
  'bot_memory_extraction_invalid',
  'bot_memory_extraction_too_large',
  'bot_memory_summary_decrypt_failed',
  'bot_memory_candidate_envelope_invalid',
  'bot_encryption_envelope_invalid',
  'bot_encryption_envelope_unsupported',
  'bot_encryption_failed',
  'bot_encryption_key_mismatch',
  'bot_encryption_plaintext_invalid',
  'bot_message_not_found',
  'bot_opencode_configuration_invalid',
  'bot_opencode_request_invalid',
  'bot_opencode_response_invalid',
  'bot_run_not_found',
  'bot_run_not_completed',
  'bot_not_found',
  'bot_channel_not_found',
  'bot_revision_not_found',
  'bot_revision_conflict',
]);

const extractionErrorRetryable = (error, fallback = false) => {
  if (typeof error?.details?.retryable === 'boolean') return error.details.retryable;
  if (typeof error?.diagnostics?.retryable === 'boolean') return error.diagnostics.retryable;
  if (TERMINAL_EXTRACTION_CODES.has(error?.code)) return false;
  const statusCode = Number(error?.statusCode || error?.status);
  if (statusCode === 408 || statusCode === 429 || (statusCode >= 500 && statusCode <= 599)) {
    return true;
  }
  return fallback;
};

const stableUuid = (...parts) => {
  const bytes = Buffer.from(createHash('sha256').update(parts.join('\0')).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const candidateAssociatedData = (runId) => (
  `devryan:bot-memory-extraction:${validateUuid(runId, 'runId')}`
);

export class BotMemoryRuntimeError extends Error {
  constructor(message, code = 'bot_memory_invalid', statusCode = 400, details = null) {
    super(message);
    this.name = 'BotMemoryRuntimeError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

const fail = (message, code, statusCode, details = null) => {
  throw new BotMemoryRuntimeError(message, code, statusCode, details);
};

const requireDate = (value, field = 'expectedUpdatedAt') => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    fail(`${field} is required`, 'bot_revision_required', 400);
  }
  return value;
};

const normalizeText = (value) => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || Buffer.byteLength(text, 'utf8') > MAX_MEMORY_TEXT_BYTES) {
    fail('Bot memory text is invalid', 'bot_memory_invalid', 400);
  }
  return text;
};

const normalizeSensitivity = (value) => {
  if (!MEMORY_SENSITIVITIES.has(value)) fail('Bot memory sensitivity is invalid');
  return value;
};

const normalizeConfidence = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    fail('Bot memory confidence is invalid');
  }
  return value;
};

const publicMemory = (row, content, activeCreatorKind = null) => Object.freeze({
  id: row.id,
  botId: row.bot_id,
  scope: row.scope,
  subjectUserId: row.subject_user_id || null,
  logicalKey: row.logical_key,
  content: Object.freeze({ text: content.text }),
  sensitivity: row.sensitivity,
  confidence: Number(row.confidence),
  activeVersionId: row.active_version_id || null,
  activeCreatorKind,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  tombstonedAt: row.tombstoned_at || null,
});

const publicVersion = (row, content) => Object.freeze({
  id: row.id,
  memoryId: row.memory_id,
  versionNumber: Number(row.version_number),
  content: Object.freeze({ text: content.text }),
  classifierMetadata: structuredClone(row.classifier_metadata || {}),
  creatorKind: row.creator_kind,
  createdBy: row.created_by || null,
  createdAt: row.created_at,
});

const publicSource = (row) => Object.freeze({
  id: row.id,
  memoryVersionId: row.memory_version_id,
  channelId: row.channel_id || null,
  runId: row.run_id || null,
  messageId: row.message_id || null,
  sourceKind: row.source_kind,
  sourceMetadata: structuredClone(row.source_metadata || {}),
  sourceTombstonedAt: row.source_tombstoned_at || null,
  createdAt: row.created_at,
});

// One Bot, one retrieval namespace.
const indexIdentity = (memory) => ({
  namespace: botSharedMemoryNamespace(memory.bot_id),
  documentId: `memory:${memory.id}`,
  version: memory.active_version_id,
});

const indexDocument = (memory, content) => ({
  ...indexIdentity(memory),
  text: content.text,
  metadata: {
    kind: 'memory',
    memoryId: memory.id,
    botId: memory.bot_id,
    scope: memory.scope,
    subjectUserId: memory.subject_user_id || null,
    logicalKey: memory.logical_key,
    sensitivity: memory.sensitivity,
    confidence: Number(memory.confidence),
  },
});

const summaryDocument = (channel, summary) => ({
  namespace: botChannelMemoryNamespace(channel.id),
  documentId: `summary:${channel.id}`,
  version: `checkpoint-${channel.current_checkpoint_number}`,
  text: summary.items.map((item) => item.text).join('\n'),
  metadata: {
    kind: 'channel_summary',
    botId: channel.bot_id,
    channelId: channel.id,
    ownerUserId: channel.owner_user_id,
    checkpointNumber: Number(channel.current_checkpoint_number),
  },
});

export function createBotMemoryRuntime({
  store,
  authorization,
  channels,
  encryption,
  indexer,
  extractCandidates,
  audit = async () => {},
  onMemoryChanged = async () => {},
  loadAdditionalIndexDocuments = async () => [],
  recordDiagnostic = () => {},
  uuid = randomUUID,
  now = () => new Date(),
  logger = console,
  consolidationIntervalMs,
  extractionConcurrency = EXTRACTION_JOB_CONCURRENCY,
  extractionLeaseMs = EXTRACTION_JOB_LEASE_MS,
  extractionPollMs = EXTRACTION_JOB_POLL_MS,
  extractionRetryDelaysMs = EXTRACTION_JOB_RETRY_DELAYS_MS,
} = {}) {
  if (!store?.repositories?.bot_memories || typeof store.commitMemoryVersion !== 'function'
    || typeof store.commitChannelSummary !== 'function'
    || typeof store.enqueueMemoryExtractionJob !== 'function'
    || typeof store.claimMemoryExtractionJob !== 'function'
    || typeof store.persistMemoryExtractionCandidates !== 'function'
    || typeof store.settleMemoryExtractionJob !== 'function'
    || typeof store.deleteChannel !== 'function'
    || !authorization || typeof authorization.requireManager !== 'function'
    || !channels || typeof channels.decryptMemory !== 'function'
    || typeof channels.decryptSummary !== 'function'
    || typeof channels.loadRunUserMessage !== 'function'
    || typeof channels.loadRunAssistantResult !== 'function'
    || !indexer || typeof indexer.upsert !== 'function' || typeof indexer.delete !== 'function'
    || typeof indexer.rebuild !== 'function' || typeof indexer.status !== 'function'
    || typeof extractCandidates !== 'function' || typeof audit !== 'function'
    || typeof onMemoryChanged !== 'function'
    || typeof loadAdditionalIndexDocuments !== 'function'
    || typeof recordDiagnostic !== 'function'
    || typeof uuid !== 'function' || typeof now !== 'function'
    || !Number.isSafeInteger(extractionConcurrency) || extractionConcurrency < 1
    || !Number.isSafeInteger(extractionLeaseMs) || extractionLeaseMs < 1_000
    || !Number.isSafeInteger(extractionPollMs) || extractionPollMs < 1
    || !Array.isArray(extractionRetryDelaysMs) || extractionRetryDelaysMs.length < 1) {
    throw new TypeError('Bot memory runtime is misconfigured');
  }

  const pendingExtractions = new Set();
  const summaryCommitTails = new Map();
  const extractionOwner = `bot-memory:${process.pid}:${randomUUID()}`;
  let extractionWakeTimer = null;
  let extractionPumpPromise = null;
  let activeExtractionWorkers = 0;
  let workerStarted = false;
  let stopped = false;

  const delaySummaryRetry = (attempt) => new Promise((resolve) => {
    setTimeout(resolve, SUMMARY_RETRY_DELAYS_MS[attempt] || 0);
  });

  const withSummaryCommitLock = (channelId, task) => {
    const previous = summaryCommitTails.get(channelId) || Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    summaryCommitTails.set(channelId, current);
    return current.finally(() => {
      if (summaryCommitTails.get(channelId) === current) summaryCommitTails.delete(channelId);
    });
  };

  const notifyMemoryChanged = async (input) => {
    try {
      await onMemoryChanged(Object.freeze({ ...input }));
    } catch (error) {
      logger?.warn?.('[BotsMemory] memory-change notification failed', {
        code: error?.code || 'bot_memory_notification_failed',
        botId: input?.botId || null,
      });
    }
  };

  const listAll = async (repository, filters = {}, maximum = MAX_ALL_ROWS) => {
    const items = [];
    let cursor = null;
    do {
      const page = await repository.list({ filters, cursor, limit: 100 });
      items.push(...page.items);
      if (items.length > maximum) {
        fail('Bot memory collection is too large', 'bot_memory_limit_exceeded', 413);
      }
      cursor = page.nextCursor;
    } while (cursor);
    return items;
  };

  const buildMemoryIndexDocuments = async () => {
    const memories = (await listAll(store.repositories.bot_memories))
      .filter((row) => row.tombstoned_at === null && row.active_version_id);
    const channelRows = (await listAll(store.repositories.bot_channels))
      .filter((row) => row.summary_envelope && row.archived_at === null);
    const documents = [];
    for (const memory of memories) {
      documents.push(indexDocument(memory, await channels.decryptMemory(memory)));
    }
    for (const channel of channelRows) {
      const summary = await channels.decryptSummary(channel);
      if (Array.isArray(summary?.items) && summary.items.length > 0) {
        documents.push(summaryDocument(channel, summary));
      }
    }
    if (documents.length > MAX_ALL_ROWS) {
      fail('Bot index rebuild is too large', 'bot_memory_limit_exceeded', 413);
    }
    return Object.freeze({
      documents: Object.freeze(documents),
      memoryCount: memories.length,
      channelSummaryCount: documents.length - memories.length,
    });
  };

  const buildCompleteIndexDocuments = async () => {
    const [{ documents: memoryDocuments, memoryCount, channelSummaryCount }, additional] = await Promise.all([
      buildMemoryIndexDocuments(),
      loadAdditionalIndexDocuments(),
    ]);
    if (!Array.isArray(additional)) {
      fail('Bot index rebuild source is invalid', 'bot_memory_index_source_invalid', 502);
    }
    const documents = [...memoryDocuments, ...additional];
    if (documents.length > MAX_ALL_ROWS) {
      fail('Bot index rebuild is too large', 'bot_memory_limit_exceeded', 413);
    }
    return Object.freeze({
      documents: Object.freeze(documents),
      memoryCount,
      channelSummaryCount,
      additionalDocumentCount: additional.length,
    });
  };

  const withKey = async (operation) => {
    let provided = null;
    let key = null;
    try {
      if (typeof encryption?.getKey !== 'function') {
        fail('Bot encryption key is unavailable', 'bot_os_encryption_unavailable', 503);
      }
      provided = await encryption.getKey();
      key = Buffer.from(provided || []);
      if (key.byteLength !== 32) {
        fail('Bot encryption key is unavailable', 'bot_os_encryption_unavailable', 503);
      }
      return await operation(key);
    } finally {
      key?.fill(0);
      if (Buffer.isBuffer(provided) || provided instanceof Uint8Array) provided.fill(0);
    }
  };

  const emitExtractionDiagnostic = (event, job, payload = {}) => {
    try {
      recordDiagnostic({
        type: 'lifecycle',
        event,
        sessionID: job?.run_id || null,
        payload: {
          runId: job?.run_id || null,
          botId: job?.bot_id || null,
          channelId: job?.channel_id || null,
          attemptCount: Number(job?.attempt_count || 0),
          ...payload,
        },
      });
    } catch {
      // Diagnostics must never change extraction settlement.
    }
  };

  const encryptClassifiedCandidates = (runId, classified, revisionId) => withKey((key) => (
    encryptBotJson({
      key,
      keyId: DEPLOYMENT_KEY_ID,
      value: {
        version: 1,
        revisionId,
        accepted: classified.accepted,
        rejectedCount: classified.rejected.length,
      },
      associatedData: candidateAssociatedData(runId),
    })
  ));

  const decryptClassifiedCandidates = async (job) => {
    let value;
    try {
      value = await withKey((key) => decryptBotJson({
        key,
        envelope: job.candidate_envelope,
        expectedKeyId: DEPLOYMENT_KEY_ID,
        associatedData: candidateAssociatedData(job.run_id),
      }));
    } catch (error) {
      throw new BotMemoryRuntimeError(
        'Bot memory candidate envelope could not be decrypted',
        'bot_memory_candidate_envelope_invalid',
        500,
        { phase: 'candidate_load', retryable: false },
      );
    }
    if (!value || value.version !== 1 || !Array.isArray(value.accepted)
      || !Number.isSafeInteger(value.rejectedCount) || value.rejectedCount < 0
      || typeof value.revisionId !== 'string') {
      throw new BotMemoryRuntimeError(
        'Bot memory candidate envelope is invalid',
        'bot_memory_candidate_envelope_invalid',
        500,
        { phase: 'candidate_load', retryable: false },
      );
    }
    return value;
  };

  const encryptMemory = (memoryId, text) => withKey(async (key) => encryptBotJson({
    key,
    keyId: DEPLOYMENT_KEY_ID,
    value: { version: 1, text: normalizeText(text) },
    associatedData: memoryAssociatedData(memoryId),
  }));

  const loadMemory = async (botId, memoryId) => {
    const row = await store.repositories.bot_memories.get({
      id: validateUuid(memoryId, 'memoryId'),
      bot_id: validateUuid(botId, 'botId'),
    });
    if (!row) fail('Bot memory not found', 'bot_memory_not_found', 404);
    return row;
  };

  const loadActiveCreatorKind = async (row) => {
    if (!row.active_version_id) return null;
    const version = await store.repositories.bot_memory_versions.get({
      id: row.active_version_id,
      memory_id: row.id,
    });
    return version?.creator_kind || null;
  };

  const decryptPublicMemory = async (row) => publicMemory(
    row,
    await channels.decryptMemory(row),
    await loadActiveCreatorKind(row),
  );

  // A Bot holds one memory per logical key; there is no subject to key on.
  const findLogicalMemory = (candidate) => store.repositories.bot_memories.get({
    bot_id: candidate.botId,
    logical_key: candidate.logicalKey,
  });

  const commitVersion = async ({
    candidate,
    text,
    creatorKind,
    createdBy,
    channelId = null,
    runId = null,
    messageId = null,
    sourceKind,
    sourceMetadata,
    expectedUpdatedAt,
    memoryId = null,
    sourceId = null,
  }) => {
    let existing = memoryId
      ? await loadMemory(candidate.botId, memoryId)
      : await findLogicalMemory(candidate);
    let resolvedMemoryId = existing?.id || validateUuid(uuid(), 'memoryId');
    if (memoryId && existing.logical_key !== candidate.logicalKey) {
      fail('Bot memory identity is immutable', 'bot_memory_identity_immutable', 409);
    }
    const resolvedSourceId = sourceId
      ? validateUuid(sourceId, 'memorySourceId')
      : validateUuid(uuid(), 'memorySourceId');
    let identityRace = false;
    let result;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const encryptedContent = await encryptMemory(resolvedMemoryId, text);
      try {
        result = await store.commitMemoryVersion({
          memoryId: resolvedMemoryId,
          versionId: validateUuid(uuid(), 'memoryVersionId'),
          sourceId: resolvedSourceId,
          botId: candidate.botId,
          scope: candidate.scope,
          subjectUserId: candidate.subjectUserId,
          logicalKey: candidate.logicalKey,
          encryptedContent,
          sensitivity: normalizeSensitivity(candidate.sensitivity),
          confidence: normalizeConfidence(candidate.confidence),
          classifierMetadata: structuredClone(candidate.classifierMetadata || {}),
          creatorKind,
          createdBy,
          channelId,
          runId,
          messageId,
          sourceKind,
          sourceMetadata: structuredClone(sourceMetadata || {}),
          expectedUpdatedAt: identityRace
            ? null
            : existing
              ? (expectedUpdatedAt === undefined ? existing.updated_at : expectedUpdatedAt)
              : null,
        });
        break;
      } catch (error) {
        if (memoryId || creatorKind !== 'classifier' || attempt > 0
          || !['40001', 'bot_revision_conflict'].includes(error?.code)) throw error;
        existing = await findLogicalMemory(candidate);
        if (!existing) throw error;
        resolvedMemoryId = existing.id;
        identityRace = true;
      }
    }
    if (!result?.memory || !result?.version || typeof result.activated !== 'boolean') {
      fail('Bot memory transaction returned invalid data', 'bot_memory_store_invalid', 502);
    }
    return result;
  };

  const synchronizeMemory = async (row, content) => {
    if (row.tombstoned_at || !row.active_version_id) return indexer.delete(indexIdentity(row));
    return indexer.upsert(indexDocument(row, content));
  };

  const auditMemory = (principal, row, action, result = 'success', metadata = {}) => audit({
    principal,
    botId: row.bot_id,
    targetType: 'bot_memory',
    targetId: row.id,
    action,
    result,
    metadata,
  });

  const synchronizeSummary = async (channel, summary) => {
    for (let attempt = 0; attempt < MAX_SUMMARY_COMMIT_ATTEMPTS; attempt += 1) {
      try {
        await indexer.upsert(summaryDocument(channel, summary));
        return true;
      } catch (error) {
        if (attempt + 1 >= MAX_SUMMARY_COMMIT_ATTEMPTS) {
          logger?.warn?.('[BotsMemory] channel summary index sync remains pending', {
            code: error?.code || 'bot_memory_index_sync_failed',
            channelId: channel.id,
            attemptCount: attempt + 1,
          });
          return false;
        }
        await delaySummaryRetry(attempt);
      }
    }
    return false;
  };

  const applyThreadOnly = (candidate) => withSummaryCommitLock(
    candidate.provenance.channelId,
    async () => {
      for (let attempt = 0; attempt < MAX_SUMMARY_COMMIT_ATTEMPTS; attempt += 1) {
        const channel = await store.repositories.bot_channels.get({
          id: candidate.provenance.channelId,
          bot_id: candidate.botId,
        });
        if (!channel) return { activated: false, reason: 'channel_missing', attemptCount: attempt + 1 };
        let current;
        try {
          current = await channels.decryptSummary(channel);
        } catch (error) {
          throw new BotMemoryRuntimeError(
            'Bot channel summary could not be decrypted',
            'bot_memory_summary_decrypt_failed',
            500,
            { phase: 'thread_summary_decrypt', retryable: false, attemptCount: attempt + 1 },
          );
        }
        const currentItems = Array.isArray(current?.items) ? current.items : [];
        if (currentItems.some((item) => item.sourceRunId === candidate.provenance.runId
          && item.logicalKey === candidate.logicalKey)) {
          const indexSynchronized = await synchronizeSummary(channel, { version: 1, items: currentItems });
          return {
            activated: false,
            reason: 'already_present',
            idempotent: true,
            indexPending: !indexSynchronized,
            attemptCount: attempt + 1,
          };
        }
        const checkpoint = Number(channel.current_checkpoint_number || 0) + 1;
        const items = [...currentItems, {
          logicalKey: candidate.logicalKey,
          text: candidate.statement,
          sensitivity: candidate.sensitivity,
          confidence: candidate.confidence,
          sourceRunId: candidate.provenance.runId,
          sourceMessageIds: [...candidate.provenance.messageIds],
        }].slice(-MAX_SUMMARY_ITEMS);
        const envelope = await withKey(async (key) => encryptBotJson({
          key,
          keyId: DEPLOYMENT_KEY_ID,
          value: { version: 1, items },
          associatedData: channelSummaryAssociatedData(channel.id, checkpoint),
        }));
        try {
          const updated = await store.commitChannelSummary({
            channelId: channel.id,
            botId: channel.bot_id,
            expectedCheckpointNumber: Number(channel.current_checkpoint_number || 0),
            summaryEnvelope: envelope,
          });
          const indexSynchronized = await synchronizeSummary(updated, { version: 1, items });
          return {
            activated: true,
            indexPending: !indexSynchronized,
            attemptCount: attempt + 1,
          };
        } catch (error) {
          if (error?.code !== 'bot_summary_checkpoint_conflict') throw error;
          if (attempt + 1 >= MAX_SUMMARY_COMMIT_ATTEMPTS) {
            return {
              activated: false,
              reason: 'checkpoint_conflict',
              retryable: true,
              attemptCount: attempt + 1,
            };
          }
          await delaySummaryRetry(attempt);
        }
      }
      return { activated: false, reason: 'checkpoint_conflict', retryable: true };
    },
  );

  const loadExtractionInput = async (job) => {
    const run = await store.repositories.bot_runs.get({ id: job.run_id });
    if (!run) fail('Bot extraction run is missing', 'bot_run_not_found', 404);
    if (run.state !== 'completed') {
      fail('Bot extraction run is not completed', 'bot_run_not_completed', 409);
    }
    const [bot, channel, revision] = await Promise.all([
      store.repositories.bots.get({ id: job.bot_id }),
      store.repositories.bot_channels.get({ id: job.channel_id, bot_id: job.bot_id }),
      store.repositories.bot_revisions.get({ id: job.revision_id, bot_id: job.bot_id }),
    ]);
    if (!bot) fail('Bot extraction Bot is missing', 'bot_not_found', 404);
    if (!channel) fail('Bot extraction channel is missing', 'bot_channel_not_found', 404);
    if (!revision) fail('Bot extraction revision is missing', 'bot_revision_not_found', 404);
    const [userMessage, assistantMessage] = await Promise.all([
      channels.loadRunUserMessage({ runId: run.id, channelId: channel.id }),
      channels.loadRunAssistantResult({ runId: run.id, channelId: channel.id }),
    ]);
    return Object.freeze({ run, bot, channel, revision, userMessage, assistantMessage });
  };

  const classifyCompletedRun = async (job, input) => {
    if (job.candidate_envelope) {
      emitExtractionDiagnostic('bot.memory.extraction.recovery', job, {
        phase: 'candidate_load',
      });
      return decryptClassifiedCandidates(job);
    }
    const assistantText = typeof input.assistantMessage?.body?.text === 'string'
      ? input.assistantMessage.body.text
      : '';
    const userText = typeof input.userMessage?.body?.text === 'string'
      ? input.userMessage.body.text
      : '';
    const messageIds = [input.userMessage?.id, input.assistantMessage?.id].filter(Boolean);
    const prompt = buildBotMemoryExtractionPrompt({
      botId: input.bot.id,
      channelId: input.channel.id,
      runId: input.run.id,
      ownerUserId: input.channel.owner_user_id,
      userText,
      assistantText,
    });
    let output;
    try {
      output = await extractCandidates({
        runId: input.run.id,
        prompt,
        schema: BOT_MEMORY_EXTRACTION_SCHEMA,
        bot: input.bot,
        channel: input.channel,
        revision: input.revision,
      });
    } catch (error) {
      throw new BotMemoryRuntimeError(
        'Bot memory provider request failed',
        error?.code || 'bot_memory_provider_failed',
        error?.statusCode || 502,
        { phase: 'classification', retryable: extractionErrorRetryable(error) },
      );
    }
    let classified;
    try {
      classified = classifyBotMemoryCandidates({
        output,
        botId: input.bot.id,
        channelId: input.channel.id,
        runId: input.run.id,
        ownerUserId: input.channel.owner_user_id,
        messageIds,
        transcript: `${userText}\n${assistantText}`,
      });
    } catch (error) {
      throw new BotMemoryRuntimeError(
        'Bot memory classifier output is unrecoverable',
        error?.code || 'bot_memory_extraction_invalid',
        error?.statusCode || 422,
        { phase: 'classification_validation', retryable: false },
      );
    }
    const candidateEnvelope = await encryptClassifiedCandidates(
      input.run.id,
      classified,
      input.revision.id,
    );
    let persisted;
    try {
      persisted = await store.persistMemoryExtractionCandidates({
        runId: job.run_id,
        leaseOwner: extractionOwner,
        candidateEnvelope,
      });
    } catch (error) {
      throw new BotMemoryRuntimeError(
        'Bot memory candidates could not be persisted',
        error?.code || 'bot_memory_candidate_persistence_failed',
        error?.statusCode || 503,
        { phase: 'candidate_persistence', retryable: true },
      );
    }
    emitExtractionDiagnostic('bot.memory.extraction.candidates_persisted', persisted || job, {
      acceptedCount: classified.accepted.length,
      rejectedCount: classified.rejected.length,
    });
    return Object.freeze({
      version: 1,
      revisionId: input.revision.id,
      accepted: classified.accepted,
      rejectedCount: classified.rejected.length,
    });
  };

  const applyClassifiedCandidates = async (input, classified) => {
    if (classified.revisionId !== input.revision.id) {
      fail('Bot extraction revision changed', 'bot_revision_not_found', 409);
    }
    let activated = 0;
    let superseded = 0;
    let idempotent = 0;
    let skipped = 0;
    let indexPending = 0;
    let retryAttempts = 0;
    const changedMemoryIds = [];
    for (const candidate of classified.accepted) {
      if (candidate.scope === 'thread_only') {
        const result = await applyThreadOnly(candidate);
        retryAttempts += Math.max(0, Number(result.attemptCount || 1) - 1);
        if (result.indexPending) indexPending += 1;
        if (result.activated) activated += 1;
        else if (result.idempotent) idempotent += 1;
        else if (result.reason === 'checkpoint_conflict') {
          throw new BotMemoryRuntimeError(
            'Bot channel summary checkpoint remained contended',
            'bot_summary_checkpoint_conflict',
            409,
            { phase: 'summary_commit', retryable: true, attemptCount: result.attemptCount },
          );
        }
        else skipped += 1;
        continue;
      }
      let result;
      try {
        result = await commitVersion({
          candidate: {
            ...candidate,
            classifierMetadata: candidate.classifier,
          },
          text: candidate.statement,
          creatorKind: 'classifier',
          createdBy: input.channel.owner_user_id,
          channelId: candidate.provenance.channelId,
          runId: candidate.provenance.runId,
          messageId: candidate.provenance.messageIds[0],
          sourceKind: 'run',
          sourceId: stableUuid(
            'bot-memory-source-v1',
            candidate.provenance.runId,
            candidate.logicalKey,
          ),
          sourceMetadata: {
            messageIds: [...candidate.provenance.messageIds],
            classifierVersion: candidate.classifier.version,
            revisionId: input.revision.id,
          },
        });
      } catch (error) {
        throw new BotMemoryRuntimeError(
          'Bot memory version commit failed',
          error?.code || 'bot_memory_commit_failed',
          error?.statusCode || 503,
          { phase: 'memory_commit', retryable: true },
        );
      }
      if (result.source?._replayed === true) idempotent += 1;
      if (!result.activated) {
        superseded += 1;
        continue;
      }
      try {
        await synchronizeMemory(result.memory, { text: candidate.statement });
      } catch (error) {
        throw new BotMemoryRuntimeError(
          'Bot memory index synchronization failed',
          error?.code || 'bot_memory_index_sync_failed',
          error?.statusCode || 503,
          { phase: 'index_sync', retryable: true },
        );
      }
      changedMemoryIds.push(result.memory.id);
      if (result.source?._replayed !== true) activated += 1;
    }
    if (indexPending > 0) {
      throw new BotMemoryRuntimeError(
        'Bot memory index synchronization remains pending',
        'bot_memory_index_sync_failed',
        503,
        { phase: 'index_sync', retryable: true },
      );
    }
    if (changedMemoryIds.length > 0) {
      await notifyMemoryChanged({
        botId: input.bot.id,
        memoryIds: Object.freeze(changedMemoryIds),
        source: 'automatic',
      });
    }
    return Object.freeze({
      accepted: classified.accepted.length,
      rejected: classified.rejected.length,
      activated,
      idempotent,
      skipped,
      superseded,
      indexPending,
      retryAttempts,
    });
  };

  const isDuplicateAudit = (error) => (
    error?.code === '23505' || error?.payload?.code === '23505'
  );

  const recordExtractionAudit = async (input, job, result, metadata) => {
    try {
      await audit({
        principal: input?.channel?.owner_user_id
          ? { id: input.channel.owner_user_id, scope: 'managed' }
          : null,
        botId: job.bot_id,
        targetType: 'bot_run',
        targetId: job.run_id,
        action: 'bot.memory.extract',
        result,
        metadata,
        eventId: stableUuid('bot-memory-extraction-audit-v1', job.run_id, result),
      });
    } catch (error) {
      if (!isDuplicateAudit(error)) throw error;
    }
  };

  const processExtractionJob = async (job) => {
    emitExtractionDiagnostic('bot.memory.extraction.claim', job, {
      hasPersistedCandidates: Boolean(job.candidate_envelope),
    });
    let input = null;
    try {
      input = await loadExtractionInput(job);
      const classified = await classifyCompletedRun(job, input);
      const result = await applyClassifiedCandidates(input, {
        ...classified,
        rejected: Array.from({ length: classified.rejectedCount }, () => null),
      });
      await recordExtractionAudit(input, job, 'success', {
        acceptedCount: result.accepted,
        rejectedCount: result.rejected,
        activatedCount: result.activated,
        idempotentCount: result.idempotent,
        skippedCount: result.skipped,
        supersededCount: result.superseded,
        conflictCount: 0,
        indexPendingCount: 0,
        retryAttemptCount: Math.max(0, Number(job.attempt_count || 1) - 1) + result.retryAttempts,
        revisionId: input.revision.id,
        recovered: Boolean(job.candidate_envelope) || Number(job.attempt_count || 0) > 1,
      });
      await store.settleMemoryExtractionJob({
        runId: job.run_id,
        leaseOwner: extractionOwner,
        disposition: 'succeeded',
        phase: 'complete',
      });
      emitExtractionDiagnostic('bot.memory.extraction.success', job, {
        acceptedCount: result.accepted,
        activatedCount: result.activated,
        idempotentCount: result.idempotent,
        supersededCount: result.superseded,
      });
    } catch (error) {
      const code = error?.code || 'bot_memory_extraction_failed';
      const phase = error?.details?.phase || 'recovery';
      if (code === 'bot_runtime_scope_busy') {
        const delayMs = extractionPollMs;
        await store.settleMemoryExtractionJob({
          runId: job.run_id,
          leaseOwner: extractionOwner,
          disposition: 'defer',
          nextAttemptAt: new Date(now().getTime() + delayMs).toISOString(),
          phase: 'admission',
          errorCode: code,
        });
        emitExtractionDiagnostic('bot.memory.extraction.deferred', job, {
          code,
          phase: 'admission',
          delayMs,
        });
        return;
      }
      const attemptCount = Number(job.attempt_count || 1);
      const terminal = TERMINAL_EXTRACTION_CODES.has(code)
        || error?.details?.retryable === false
        || attemptCount >= Math.min(EXTRACTION_JOB_MAX_ATTEMPTS, extractionRetryDelaysMs.length + 1);
      if (terminal) {
        await recordExtractionAudit(input, job, 'failure', {
          code,
          phase,
          retryable: false,
          attemptCount,
        });
        await store.settleMemoryExtractionJob({
          runId: job.run_id,
          leaseOwner: extractionOwner,
          disposition: 'terminal',
          phase,
          errorCode: code,
        });
        emitExtractionDiagnostic('bot.memory.extraction.terminal_failure', job, { code, phase });
        return;
      }
      const delayMs = extractionRetryDelaysMs[Math.min(
        extractionRetryDelaysMs.length - 1,
        Math.max(0, attemptCount - 1),
      )];
      await store.settleMemoryExtractionJob({
        runId: job.run_id,
        leaseOwner: extractionOwner,
        disposition: 'retry',
        nextAttemptAt: new Date(now().getTime() + delayMs).toISOString(),
        phase,
        errorCode: code,
      });
      emitExtractionDiagnostic('bot.memory.extraction.retry', job, { code, phase, delayMs });
    }
  };

  const scheduleExtractionPump = (delayMs = 0) => {
    if (stopped || !workerStarted || extractionWakeTimer) return;
    extractionWakeTimer = setTimeout(() => {
      extractionWakeTimer = null;
      void pumpExtractions();
    }, delayMs);
    extractionWakeTimer.unref?.();
  };

  const runExtractionPump = async () => {
    if (stopped) return;
    while (activeExtractionWorkers < extractionConcurrency) {
      let job;
      try {
        job = await store.claimMemoryExtractionJob({
          leaseOwner: extractionOwner,
          leaseUntil: new Date(now().getTime() + extractionLeaseMs).toISOString(),
        });
      } catch (error) {
        logger?.warn?.('[BotsMemory] extraction claim failed', {
          code: error?.code || 'bot_memory_extraction_claim_failed',
        });
        scheduleExtractionPump(extractionPollMs);
        return;
      }
      if (!job) {
        scheduleExtractionPump(extractionPollMs);
        return;
      }
      activeExtractionWorkers += 1;
      const task = processExtractionJob(job)
        .catch((error) => {
          logger?.warn?.('[BotsMemory] extraction settlement failed', {
            code: error?.code || 'bot_memory_extraction_settlement_failed',
            runId: job.run_id,
          });
        })
        .finally(() => {
          activeExtractionWorkers -= 1;
          pendingExtractions.delete(task);
          scheduleExtractionPump(0);
        });
      pendingExtractions.add(task);
    }
  };

  const pumpExtractions = () => {
    if (extractionPumpPromise) return extractionPumpPromise;
    extractionPumpPromise = runExtractionPump().finally(() => {
      extractionPumpPromise = null;
    });
    return extractionPumpPromise;
  };

  const loadConsolidationMemories = async () => {
    const rows = await listAll(store.repositories.bot_memories);
    const active = rows.filter((row) => row.tombstoned_at === null && row.active_version_id);
    return Promise.all(active.map(decryptPublicMemory));
  };

  const mergeForConsolidation = async (plan) => {
    const target = await store.repositories.bot_memories.get({ id: plan.targetId });
    if (!target || target.tombstoned_at || target.updated_at !== plan.expectedUpdatedAt) {
      return { activated: false };
    }
    const result = await commitVersion({
      candidate: {
        botId: target.bot_id,
        scope: target.scope,
        subjectUserId: target.subject_user_id || null,
        logicalKey: target.logical_key,
        sensitivity: plan.sensitivity,
        confidence: plan.confidence,
        classifierMetadata: { version: 1, consolidation: true, sourceCount: plan.sourceIds.length },
      },
      memoryId: target.id,
      text: plan.content.text,
      creatorKind: 'system',
      createdBy: null,
      sourceKind: 'consolidation',
      sourceMetadata: { sourceMemoryIds: [...plan.sourceIds] },
      expectedUpdatedAt: plan.expectedUpdatedAt,
    });
    if (!result.activated) return { activated: false };
    for (const sourceId of plan.sourceIds) {
      const source = await store.repositories.bot_memories.get({ id: sourceId });
      if (!source || source.tombstoned_at || source.bot_id !== target.bot_id
        || source.scope !== target.scope
        || source.subject_user_id !== target.subject_user_id) continue;
      await store.repositories.bot_memories.updateIfRevision(
        { id: source.id },
        { tombstoned_at: now().toISOString() },
        source.updated_at,
      ).then((updated) => indexer.delete(indexIdentity(updated))).catch((error) => {
        if (error?.code !== 'bot_revision_conflict') throw error;
      });
    }
    await synchronizeMemory(result.memory, plan.content);
    await notifyMemoryChanged({
      botId: result.memory.bot_id,
      memoryIds: Object.freeze([result.memory.id, ...plan.sourceIds]),
      source: 'consolidation',
    });
    return { activated: true };
  };

  const consolidation = createBotMemoryConsolidation({
    loadMemories: loadConsolidationMemories,
    mergeMemories: mergeForConsolidation,
    ...(consolidationIntervalMs === undefined ? {} : { intervalMs: consolidationIntervalMs }),
    logger,
  });

  return Object.freeze({
    async enqueueCompletedRun(input) {
      if (stopped) return Promise.resolve(Object.freeze({ skipped: true }));
      const runId = validateUuid(input?.run?.id, 'run.id');
      const job = await store.enqueueMemoryExtractionJob({ runId });
      emitExtractionDiagnostic('bot.memory.extraction.enqueued', job || {
        run_id: runId,
        bot_id: input?.bot?.id || null,
        channel_id: input?.channel?.id || null,
      });
      workerStarted = true;
      await pumpExtractions();
      return Object.freeze({ queued: true });
    },

    async listForManager(principal, botId, { cursor = null, limit } = {}) {
      const normalizedBotId = validateUuid(botId, 'botId');
      await authorization.requireManager(principal, normalizedBotId);
      const page = await store.repositories.bot_memories.list({
        filters: { bot_id: normalizedBotId },
        cursor,
        limit: normalizePageLimit(limit),
      });
      return Object.freeze({
        memories: Object.freeze(await Promise.all(page.items.map(decryptPublicMemory))),
        nextCursor: page.nextCursor || null,
      });
    },

    async getForManager(principal, botId, memoryId) {
      const normalizedBotId = validateUuid(botId, 'botId');
      await authorization.requireManager(principal, normalizedBotId);
      const memory = await loadMemory(normalizedBotId, memoryId);
      const versionRows = await listAll(
        store.repositories.bot_memory_versions,
        { memory_id: memory.id },
        2_000,
      );
      const versions = await Promise.all(versionRows.map(async (row) => publicVersion(
        row,
        await channels.decryptMemory({ id: memory.id, encrypted_content: row.encrypted_content }),
      )));
      const sourceRows = await Promise.all(versionRows.map((row) => listAll(
        store.repositories.bot_memory_sources,
        { memory_version_id: row.id },
        2_000,
      )));
      return Object.freeze({
        memory: await decryptPublicMemory(memory),
        versions: Object.freeze(versions),
        sources: Object.freeze(sourceRows.flat().map(publicSource)),
      });
    },

    async editMemory(principal, botId, memoryId, request) {
      assertExactObject(request, {
        label: 'Bot memory edit',
        required: ['text', 'sensitivity', 'confidence', 'expectedUpdatedAt'],
      });
      const normalizedBotId = validateUuid(botId, 'botId');
      await authorization.requireManager(principal, normalizedBotId);
      const memory = await loadMemory(normalizedBotId, memoryId);
      const text = normalizeText(request.text);
      const result = await commitVersion({
        candidate: {
          botId: memory.bot_id,
          scope: memory.scope,
          subjectUserId: memory.subject_user_id || null,
          logicalKey: memory.logical_key,
          sensitivity: normalizeSensitivity(request.sensitivity),
          confidence: normalizeConfidence(request.confidence),
          classifierMetadata: { version: 1, managerEdit: true },
        },
        memoryId: memory.id,
        text,
        creatorKind: 'manager',
        createdBy: validateUuid(principal.id, 'principal.id'),
        sourceKind: 'manager',
        sourceMetadata: { operation: 'edit' },
        expectedUpdatedAt: requireDate(request.expectedUpdatedAt),
      });
      if (!result.activated) {
        await auditMemory(principal, memory, 'bot.memory.edit', 'partial', {
          versionId: result.version.id,
          code: 'bot_memory_version_conflict',
        });
        fail(
          'Bot memory changed before this edit completed',
          'bot_memory_version_conflict',
          409,
          { preservedVersionId: result.version.id },
        );
      }
      let indexSynchronized = true;
      await synchronizeMemory(result.memory, { text }).catch(() => { indexSynchronized = false; });
      await auditMemory(
        principal,
        result.memory,
        'bot.memory.edit',
        indexSynchronized ? 'success' : 'partial',
        { versionId: result.version.id, indexSynchronized },
      );
      await notifyMemoryChanged({
        botId: result.memory.bot_id,
        memoryIds: Object.freeze([result.memory.id]),
        source: 'manager',
      });
      return Object.freeze({
        memory: await decryptPublicMemory(result.memory),
        version: publicVersion(result.version, { text }),
        indexSynchronized,
      });
    },

    async mergeMemories(principal, botId, request) {
      assertExactObject(request, {
        label: 'Bot memory merge',
        required: [
          'targetMemoryId', 'sourceMemoryIds', 'text', 'sensitivity', 'confidence',
          'expectedUpdatedAt',
        ],
      });
      const normalizedBotId = validateUuid(botId, 'botId');
      await authorization.requireManager(principal, normalizedBotId);
      const target = await loadMemory(normalizedBotId, request.targetMemoryId);
      if (!Array.isArray(request.sourceMemoryIds) || request.sourceMemoryIds.length < 1
        || request.sourceMemoryIds.length > 100) {
        fail('Bot memory merge sources are invalid');
      }
      const sourceIds = [...new Set(request.sourceMemoryIds.map((id) => validateUuid(id, 'sourceMemoryId')))]
        .filter((id) => id !== target.id);
      if (sourceIds.length < 1) fail('Bot memory merge sources are invalid');
      const sources = await Promise.all(sourceIds.map((id) => loadMemory(normalizedBotId, id)));
      const text = normalizeText(request.text);
      const result = await commitVersion({
        candidate: {
          botId: target.bot_id,
          scope: target.scope,
          subjectUserId: target.subject_user_id || null,
          logicalKey: target.logical_key,
          sensitivity: normalizeSensitivity(request.sensitivity),
          confidence: normalizeConfidence(request.confidence),
          classifierMetadata: { version: 1, managerMerge: true, sourceCount: sources.length },
        },
        memoryId: target.id,
        text,
        creatorKind: 'manager',
        createdBy: validateUuid(principal.id, 'principal.id'),
        sourceKind: 'manager',
        sourceMetadata: { operation: 'merge', sourceMemoryIds: sourceIds },
        expectedUpdatedAt: requireDate(request.expectedUpdatedAt),
      });
      if (!result.activated) {
        fail(
          'Bot memory changed before this merge completed',
          'bot_memory_version_conflict',
          409,
          { preservedVersionId: result.version.id },
        );
      }
      const conflicts = [];
      for (const source of sources) {
        try {
          const updated = await store.repositories.bot_memories.updateIfRevision(
            { id: source.id, bot_id: normalizedBotId },
            { tombstoned_at: now().toISOString() },
            source.updated_at,
          );
          await indexer.delete(indexIdentity(updated));
        } catch (error) {
          if (error?.code !== 'bot_revision_conflict') throw error;
          conflicts.push(source.id);
        }
      }
      let indexSynchronized = true;
      await synchronizeMemory(result.memory, { text }).catch(() => { indexSynchronized = false; });
      const partial = conflicts.length > 0 || !indexSynchronized;
      await auditMemory(principal, result.memory, 'bot.memory.merge', partial ? 'partial' : 'success', {
        versionId: result.version.id,
        sourceCount: sources.length,
        conflictCount: conflicts.length,
        indexSynchronized,
      });
      await notifyMemoryChanged({
        botId: result.memory.bot_id,
        memoryIds: Object.freeze([result.memory.id, ...sourceIds]),
        source: 'manager',
      });
      return Object.freeze({
        memory: await decryptPublicMemory(result.memory),
        version: publicVersion(result.version, { text }),
        tombstonedSourceIds: Object.freeze(sourceIds.filter((id) => !conflicts.includes(id))),
        conflicts: Object.freeze(conflicts),
        indexSynchronized,
      });
    },

    async tombstoneMemory(principal, botId, memoryId, request) {
      assertExactObject(request, {
        label: 'Bot memory tombstone',
        required: ['expectedUpdatedAt'],
      });
      const normalizedBotId = validateUuid(botId, 'botId');
      await authorization.requireManager(principal, normalizedBotId);
      const memory = await loadMemory(normalizedBotId, memoryId);
      const updated = await store.repositories.bot_memories.updateIfRevision(
        { id: memory.id, bot_id: normalizedBotId },
        { tombstoned_at: now().toISOString() },
        requireDate(request.expectedUpdatedAt),
      );
      let indexSynchronized = true;
      await indexer.delete(indexIdentity(updated)).catch(() => { indexSynchronized = false; });
      await auditMemory(principal, updated, 'bot.memory.tombstone', indexSynchronized ? 'success' : 'partial', {
        indexSynchronized,
      });
      await notifyMemoryChanged({
        botId: updated.bot_id,
        memoryIds: Object.freeze([updated.id]),
        source: 'manager',
      });
      return Object.freeze({ memory: await decryptPublicMemory(updated), indexSynchronized });
    },

    async restoreMemory(principal, botId, memoryId, request) {
      assertExactObject(request, {
        label: 'Bot memory restore',
        required: ['expectedUpdatedAt'],
      });
      const normalizedBotId = validateUuid(botId, 'botId');
      await authorization.requireManager(principal, normalizedBotId);
      const memory = await loadMemory(normalizedBotId, memoryId);
      const updated = await store.repositories.bot_memories.updateIfRevision(
        { id: memory.id, bot_id: normalizedBotId },
        { tombstoned_at: null },
        requireDate(request.expectedUpdatedAt),
      );
      const content = await channels.decryptMemory(updated);
      let indexSynchronized = true;
      await synchronizeMemory(updated, content).catch(() => { indexSynchronized = false; });
      await auditMemory(principal, updated, 'bot.memory.restore', indexSynchronized ? 'success' : 'partial', {
        indexSynchronized,
      });
      await notifyMemoryChanged({
        botId: updated.bot_id,
        memoryIds: Object.freeze([updated.id]),
        source: 'manager',
      });
      return Object.freeze({
        memory: publicMemory(updated, content, await loadActiveCreatorKind(updated)),
        indexSynchronized,
      });
    },

    async rebuildIndex(principal, botId) {
      const normalizedBotId = validateUuid(botId, 'botId');
      await authorization.requireManager(principal, normalizedBotId);
      const {
        documents,
        memoryCount,
        channelSummaryCount,
        additionalDocumentCount,
      } = await buildCompleteIndexDocuments();
      const result = await indexer.rebuild(documents);
      await audit({
        principal,
        botId: normalizedBotId,
        targetType: 'bot_index',
        targetId: normalizedBotId,
        action: 'bot.memory.rebuild_index',
        result: 'success',
        metadata: {
          documentCount: documents.length,
          memoryCount,
          channelSummaryCount,
          additionalDocumentCount,
        },
      });
      return Object.freeze({
        result: structuredClone(result),
        documentCount: documents.length,
        memoryCount,
        channelSummaryCount,
        additionalDocumentCount,
      });
    },

    async listIndexDocuments() {
      return (await buildMemoryIndexDocuments()).documents;
    },

    async deleteChannel(principal, channelId, request) {
      assertExactObject(request, {
        label: 'Bot channel deletion',
        required: ['sharedMemorySurvives'],
      });
      if (request.sharedMemorySurvives !== true) {
        fail(
          'Confirm that shared learning survives channel deletion',
          'bot_channel_delete_confirmation_required',
          409,
        );
      }
      const normalizedChannelId = validateUuid(channelId, 'channelId');
      const channel = await store.repositories.bot_channels.get({ id: normalizedChannelId });
      if (!channel) fail('Bot channel not found', 'bot_channel_not_found', 404);
      const decision = await authorization.requireChannelRead(
        principal,
        channel.bot_id,
        channel.id,
      );
      if (decision.channel.owner_user_id !== principal?.id) {
        fail('Only the channel owner can delete it', 'bot_channel_owner_required', 403);
      }
      const runs = await listAll(store.repositories.bot_runs, { channel_id: channel.id }, 5_000);
      if (runs.some((run) => UNFINISHED_RUN_STATES.has(run.state))) {
        fail('Finish or cancel active runs before deleting this channel', 'bot_channel_busy', 409);
      }
      // Every memory is shared and outlives its source channel, so deleting a
      // channel only tombstones the provenance; nothing is removed from the
      // retrieval index except the channel's own summary.
      if (channel.summary_envelope) {
        await indexer.delete({
          namespace: botChannelMemoryNamespace(channel.id),
          documentId: `summary:${channel.id}`,
          version: `checkpoint-${channel.current_checkpoint_number}`,
        });
      }
      const objectRows = await listAll(
        store.repositories.bot_objects,
        { channel_id: channel.id, visibility: 'private' },
        10_000,
      );
      const objectsByBucket = new Map();
      for (const object of objectRows) {
        const names = objectsByBucket.get(object.storage_bucket) || [];
        names.push(object.storage_object_name);
        objectsByBucket.set(object.storage_bucket, names);
      }
      for (const [bucket, names] of objectsByBucket) {
        await store.storage.delete(bucket, names);
      }
      const result = await store.deleteChannel({
        channelId: channel.id,
        actorId: validateUuid(principal.id, 'principal.id'),
      });
      const retainedSharedMemories = Number(result?.retained_shared_memories || 0);
      const deletedMessages = Number(result?.deleted_messages || 0);
      await audit({
        principal,
        botId: channel.bot_id,
        targetType: 'bot_channel',
        targetId: channel.id,
        action: 'bot.channel.delete',
        result: 'success',
        metadata: {
          retainedSharedMemoryCount: retainedSharedMemories,
          deletedMessageCount: deletedMessages,
          deletedObjectCount: objectRows.length,
          sharedMemorySurvives: true,
        },
      });
      return Object.freeze({
        deleted: true,
        channelId: channel.id,
        retainedSharedMemories,
        deletedMessages,
        deletedObjects: objectRows.length,
        notice: 'Everything this Bot learned survives channel deletion.',
      });
    },

    async start() {
      stopped = false;
      consolidation.start();
      const status = await indexer.status();
      if (status?.state !== 'rebuild_required') {
        workerStarted = true;
        await pumpExtractions();
        return Object.freeze({ indexState: status?.state || null, rebuilt: false });
      }
      const { documents } = await buildCompleteIndexDocuments();
      await indexer.rebuild(documents);
      workerStarted = true;
      await pumpExtractions();
      return Object.freeze({
        indexState: 'ready',
        rebuilt: true,
        documentCount: documents.length,
      });
    },

    async shutdown() {
      stopped = true;
      workerStarted = false;
      if (extractionWakeTimer) clearTimeout(extractionWakeTimer);
      extractionWakeTimer = null;
      await consolidation.shutdown();
      if (extractionPumpPromise) await extractionPumpPromise;
      await Promise.allSettled([...pendingExtractions]);
    },

    runConsolidation: () => consolidation.sweep(),
    getPendingExtractionCount: () => pendingExtractions.size,
    async waitForPendingExtractions() {
      await pumpExtractions();
      while (pendingExtractions.size > 0) {
        await Promise.allSettled([...pendingExtractions]);
        await pumpExtractions();
      }
    },
  });
}
