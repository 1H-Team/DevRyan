import { randomUUID } from 'node:crypto';

import { channelSummaryAssociatedData, memoryAssociatedData } from './channels.js';
import { encryptBotJson } from './encryption.js';
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
const MAX_ALL_ROWS = 25_000;
const MEMORY_SENSITIVITIES = new Set(['normal', 'confidential', 'restricted']);
const UNFINISHED_RUN_STATES = new Set([
  'queued',
  'starting',
  'running',
  'waiting_approval',
  'needs_reconciliation',
]);

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
  uuid = randomUUID,
  now = () => new Date(),
  logger = console,
  consolidationIntervalMs,
} = {}) {
  if (!store?.repositories?.bot_memories || typeof store.commitMemoryVersion !== 'function'
    || typeof store.deleteChannel !== 'function'
    || !authorization || typeof authorization.requireManager !== 'function'
    || !channels || typeof channels.decryptMemory !== 'function'
    || typeof channels.decryptSummary !== 'function'
    || !indexer || typeof indexer.upsert !== 'function' || typeof indexer.delete !== 'function'
    || typeof indexer.rebuild !== 'function' || typeof indexer.status !== 'function'
    || typeof extractCandidates !== 'function' || typeof audit !== 'function'
    || typeof onMemoryChanged !== 'function'
    || typeof loadAdditionalIndexDocuments !== 'function'
    || typeof uuid !== 'function' || typeof now !== 'function') {
    throw new TypeError('Bot memory runtime is misconfigured');
  }

  const pendingExtractions = new Set();
  let stopped = false;

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
  }) => {
    const existing = memoryId
      ? await loadMemory(candidate.botId, memoryId)
      : await findLogicalMemory(candidate);
    const resolvedMemoryId = existing?.id || validateUuid(uuid(), 'memoryId');
    if (memoryId && existing.logical_key !== candidate.logicalKey) {
      fail('Bot memory identity is immutable', 'bot_memory_identity_immutable', 409);
    }
    const encryptedContent = await encryptMemory(resolvedMemoryId, text);
    const result = await store.commitMemoryVersion({
      memoryId: resolvedMemoryId,
      versionId: validateUuid(uuid(), 'memoryVersionId'),
      sourceId: validateUuid(uuid(), 'memorySourceId'),
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
      expectedUpdatedAt: existing
        ? (expectedUpdatedAt === undefined ? existing.updated_at : expectedUpdatedAt)
        : null,
    });
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

  const applyThreadOnly = async (candidate) => {
    const channel = await store.repositories.bot_channels.get({
      id: candidate.provenance.channelId,
      bot_id: candidate.botId,
    });
    if (!channel) return { activated: false, reason: 'channel_missing' };
    const current = await channels.decryptSummary(channel).catch(() => null);
    const currentItems = Array.isArray(current?.items) ? current.items : [];
    if (currentItems.some((item) => item.sourceRunId === candidate.provenance.runId
      && item.logicalKey === candidate.logicalKey)) {
      return { activated: false, reason: 'already_present' };
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
    const updated = await store.repositories.bot_channels.updateIfRevision(
      { id: channel.id, bot_id: channel.bot_id },
      { current_checkpoint_number: checkpoint, summary_envelope: envelope },
      channel.updated_at,
    );
    await indexer.upsert(summaryDocument(updated, { version: 1, items }));
    return { activated: true };
  };

  const runAlreadyExtracted = async (input) => {
    const sourcePage = await store.repositories.bot_memory_sources.list({
      filters: { run_id: input.run.id },
      limit: 1,
    });
    if (sourcePage.items.length > 0) return true;
    const currentChannel = await store.repositories.bot_channels.get({
      id: input.channel.id,
      bot_id: input.bot.id,
    });
    const summary = currentChannel
      ? await channels.decryptSummary(currentChannel).catch(() => null)
      : null;
    return Array.isArray(summary?.items)
      && summary.items.some((item) => item.sourceRunId === input.run.id);
  };

  const extractCompletedRun = async (input) => {
    if (await runAlreadyExtracted(input)) return Object.freeze({ skipped: true });
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
    const output = await extractCandidates({
      runId: input.run.id,
      prompt,
      schema: BOT_MEMORY_EXTRACTION_SCHEMA,
      bot: input.bot,
      channel: input.channel,
      revision: input.revision,
    });
    const classified = classifyBotMemoryCandidates({
      output,
      botId: input.bot.id,
      channelId: input.channel.id,
      runId: input.run.id,
      ownerUserId: input.channel.owner_user_id,
      messageIds,
      transcript: `${userText}\n${assistantText}`,
    });
    let activated = 0;
    let conflicts = 0;
    const changedMemoryIds = [];
    for (const candidate of classified.accepted) {
      if (candidate.scope === 'thread_only') {
        const result = await applyThreadOnly(candidate);
        if (result.activated) activated += 1;
        else conflicts += 1;
        continue;
      }
      const result = await commitVersion({
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
        sourceMetadata: {
          messageIds: [...candidate.provenance.messageIds],
          classifierVersion: candidate.classifier.version,
          revisionId: input.revision.id,
        },
      });
      if (!result.activated) {
        conflicts += 1;
        continue;
      }
      await synchronizeMemory(result.memory, { text: candidate.statement });
      changedMemoryIds.push(result.memory.id);
      activated += 1;
    }
    await audit({
      principal: { id: input.channel.owner_user_id, scope: 'managed' },
      botId: input.bot.id,
      targetType: 'bot_run',
      targetId: input.run.id,
      action: 'bot.memory.extract',
      result: conflicts > 0 ? 'partial' : 'success',
      metadata: {
        acceptedCount: classified.accepted.length,
        rejectedCount: classified.rejected.length,
        activatedCount: activated,
        conflictCount: conflicts,
        revisionId: input.revision.id,
      },
    });
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
      conflicts,
    });
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
    enqueueCompletedRun(input) {
      if (stopped) return Promise.resolve(Object.freeze({ skipped: true }));
      const task = Promise.resolve().then(() => extractCompletedRun(input)).catch(async (error) => {
        logger?.warn?.('[BotsMemory] completed-run extraction failed', {
          code: error?.code || 'bot_memory_extraction_failed',
          runId: input?.run?.id || null,
        });
        await audit({
          principal: input?.channel?.owner_user_id
            ? { id: input.channel.owner_user_id, scope: 'managed' }
            : null,
          botId: input?.bot?.id || null,
          targetType: 'bot_run',
          targetId: input?.run?.id || null,
          action: 'bot.memory.extract',
          result: 'failure',
          metadata: { code: error?.code || 'bot_memory_extraction_failed' },
        }).catch(() => undefined);
        return Object.freeze({ failed: true, code: error?.code || 'bot_memory_extraction_failed' });
      }).finally(() => pendingExtractions.delete(task));
      pendingExtractions.add(task);
      // Extraction is a follow-up to a completed turn, not part of the turn's
      // response path. Keeping it tracked still makes shutdown deterministic.
      return Promise.resolve(Object.freeze({ queued: true }));
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
        return Object.freeze({ indexState: status?.state || null, rebuilt: false });
      }
      const { documents } = await buildCompleteIndexDocuments();
      await indexer.rebuild(documents);
      return Object.freeze({
        indexState: 'ready',
        rebuilt: true,
        documentCount: documents.length,
      });
    },

    async shutdown() {
      stopped = true;
      await consolidation.shutdown();
      await Promise.allSettled([...pendingExtractions]);
    },

    runConsolidation: () => consolidation.sweep(),
    getPendingExtractionCount: () => pendingExtractions.size,
    waitForPendingExtractions: () => Promise.allSettled([...pendingExtractions]),
  });
}
