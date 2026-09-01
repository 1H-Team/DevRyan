import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

import { resolveComputerScopeKey } from '@openchamber/bots-runtime';

import { publicBotChannelPreview } from './channels.js';
import { normalizeBotRunError } from './error-normalization.js';
import { withBotAbort } from './request-lifetime.js';
import {
  BotReasoningAdapterError,
  createBotReasoningAdapterRegistry,
  genericExecutionFromLegacyRun,
  projectBotReasoningResponse,
} from './reasoning-adapter.js';
import { validateBotRoutineSnapshot } from './routine-runtime.js';
import { assertExactObject, validateBoundedString, validateUuid } from './validation.js';
import { createBotWarmRuntimeLeases } from './warm-runtime-leases.js';
import { hasBotExecutionIdentity, hasBotRetrySideEffects } from './retry-policy.js';

const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_RUN_TIMEOUT_MS = 15 * 60 * 1000;
const CHECKPOINT_INTERVAL_MS = 500;
const REQUESTER_STREAM_INTERVAL_MS = 50;
const TERMINAL_SETTLEMENT_RETRY_DELAYS_MS = Object.freeze([0, 100, 500]);
const MAX_REQUESTER_STREAM_TEXT_BYTES = 192 * 1024;
const MAX_PENDING_MESSAGE_COUNT = 8;
const MAX_PENDING_PART_COUNT = 128;
const MAX_PENDING_TEXT_BYTES = 256 * 1024;
const TERMINAL_RUN_STATES = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const GATEWAY_PAUSED_RUN_STATES = new Set([
  'waiting_approval',
  'waiting_control',
  'needs_reconciliation',
]);
const ATTACHMENT_DELIVERY_MODES = new Set(['auto', 'compatibility']);

const defaultIsRuntimeOwnerAlive = (owner) => {
  const match = /^devryan-web:(\d+)$/.exec(String(owner || ''));
  if (!match) return true;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
};

export class BotRunDispatcherError extends Error {
  constructor(message, code = 'bot_run_invalid', statusCode = 400, diagnostics = null) {
    super(message);
    this.name = 'BotRunDispatcherError';
    this.code = code;
    this.statusCode = statusCode;
    this.diagnostics = diagnostics ? Object.freeze({ ...diagnostics }) : null;
  }
}

const fail = (message, code, statusCode) => {
  throw new BotRunDispatcherError(message, code, statusCode);
};

const normalizeMessage = (value) => {
  try {
    assertExactObject(value, {
      label: 'Bot message request',
      required: ['messageId', 'idempotencyKey', 'text', 'attachmentIds'],
      optional: ['acknowledgmentId', 'attachmentDeliveryMode', 'prewarmLeaseId'],
    });
  } catch (error) {
    fail(error.message, error.code || 'bot_message_invalid', error.statusCode || 400);
  }
  const attachmentDeliveryMode = value.attachmentDeliveryMode ?? 'auto';
  if (!ATTACHMENT_DELIVERY_MODES.has(attachmentDeliveryMode)) {
    fail('Bot attachment delivery mode is invalid', 'bot_attachment_delivery_mode_invalid', 400);
  }
  return Object.freeze({
    messageId: validateUuid(value.messageId, 'messageId'),
    acknowledgmentId: value.acknowledgmentId === undefined
      ? null
      : validateUuid(value.acknowledgmentId, 'acknowledgmentId'),
    idempotencyKey: validateBoundedString(value.idempotencyKey, 'idempotencyKey', { maximum: 512 }),
    text: value.text,
    attachmentIds: value.attachmentIds,
    attachmentDeliveryMode,
    prewarmLeaseId: value.prewarmLeaseId === undefined
      ? null
      : validateUuid(value.prewarmLeaseId, 'prewarmLeaseId'),
  });
};

const normalizeAdmission = (value, activeRevisionId) => {
  if (value === undefined || value === null) return null;
  try {
    assertExactObject(value, {
      label: 'Bot run admission',
      required: ['revisionId', 'routine'],
    });
  } catch (error) {
    fail(error.message, error.code || 'bot_run_admission_invalid', error.statusCode || 400);
  }
  const revisionId = validateUuid(value.revisionId, 'admission.revisionId');
  if (revisionId !== activeRevisionId) {
    fail('Bot routine revision is no longer active', 'bot_revision_changed', 409);
  }
  return Object.freeze({
    revisionId,
    routine: validateBotRoutineSnapshot(value.routine),
  });
};

const channelPreviewPayload = (message) => (
  typeof message?.finalizedAt === 'string'
  && (message?.role === 'user' || message?.role === 'assistant')
  && message?.assistantPhase !== 'acknowledgment'
    ? { channelPreview: publicBotChannelPreview(message) }
    : {}
);

const totalTokens = (tokens) => {
  if (!tokens || typeof tokens !== 'object') return 0;
  return ['input', 'output', 'reasoning'].reduce((sum, key) => (
    sum + Math.max(0, Number(tokens[key]) || 0)
  ), 0) + Math.max(0, Number(tokens.cache?.read) || 0)
    + Math.max(0, Number(tokens.cache?.write) || 0);
};

const nowIso = (now) => now().toISOString();

const assistantResponseIdForMessage = (messageId) => {
  const bytes = Buffer.from(createHash('sha256')
    .update(`devryan-bot-assistant-response\0${messageId}`, 'utf8')
    .digest()
    .subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export function createBotRunDispatcher({
  store,
  channels,
  contextAssembler,
  reasoningAdapters = null,
  executeGovernedToolIntent = null,
  eventStream,
  runtimePreflight,
  streamAccessLeases = null,
  approvalService = null,
  reconcileExpiredApprovals = async () => {},
  sharedFileService = null,
  resolveLibrarySnapshot = async ({ configuredVersionIds }) => configuredVersionIds || [],
  onRunCompleted = async () => {},
  onRunSettled = async () => {},
  executeClaimedRun = null,
  uuid = randomUUID,
  now = () => new Date(),
  leaseMs = DEFAULT_LEASE_MS,
  runTimeoutMs = DEFAULT_RUN_TIMEOUT_MS,
  checkpointIntervalMs = CHECKPOINT_INTERVAL_MS,
  runtimeOwner = `devryan-web:${process.pid}`,
  isRuntimeOwnerAlive = defaultIsRuntimeOwnerAlive,
  autoDispatch = true,
  recordDiagnostic = () => {},
  logger = console,
} = {}) {
  if (!store || typeof store.claimRun !== 'function'
    || !store.repositories?.bot_revisions
    || !channels || typeof channels.preflightMessage !== 'function'
    || typeof channels.enqueueUserMessage !== 'function'
    || !eventStream || typeof eventStream.publish !== 'function'
    || typeof runtimePreflight !== 'function'
    || typeof resolveLibrarySnapshot !== 'function'
    || typeof onRunCompleted !== 'function'
    || typeof onRunSettled !== 'function'
    || typeof reconcileExpiredApprovals !== 'function'
    || typeof uuid !== 'function' || typeof now !== 'function'
    || typeof recordDiagnostic !== 'function'
    || !Number.isFinite(leaseMs) || leaseMs < 1_000
    || !Number.isFinite(runTimeoutMs) || runTimeoutMs < 10
    || !Number.isFinite(checkpointIntervalMs) || checkpointIntervalMs < 0) {
    throw new TypeError('Bot run dispatcher is misconfigured');
  }
  if (sharedFileService !== null && typeof sharedFileService?.prepareMessage !== 'function') {
    throw new TypeError('Bot Shared file service is misconfigured');
  }
  if (streamAccessLeases !== null
    && (typeof streamAccessLeases?.establish !== 'function'
      || typeof streamAccessLeases?.authorize !== 'function'
      || typeof streamAccessLeases?.isAuthorized !== 'function'
      || typeof streamAccessLeases?.invalidateChannel !== 'function')) {
    throw new TypeError('Bot requester stream access leases are misconfigured');
  }
  if (approvalService !== null && typeof approvalService?.cancelPendingForRun !== 'function') {
    throw new TypeError('Bot approval service is misconfigured');
  }
  if (typeof isRuntimeOwnerAlive !== 'function') {
    throw new TypeError('Bot run lease liveness check is misconfigured');
  }
  const hasInjectedExecutor = typeof executeClaimedRun === 'function';
  let adapterRegistry = null;
  if (!hasInjectedExecutor) {
    const adapters = Array.isArray(reasoningAdapters) ? [...reasoningAdapters] : [];
    adapterRegistry = createBotReasoningAdapterRegistry({ adapters });
  }
  if (!hasInjectedExecutor && (!contextAssembler || typeof contextAssembler.assemble !== 'function'
    || typeof channels.getOrCreateAssistantCheckpoint !== 'function'
    || !adapterRegistry || adapterRegistry.kinds.length < 1)) {
    throw new TypeError('Bot run executor is misconfigured');
  }
  if (executeGovernedToolIntent !== null && typeof executeGovernedToolIntent !== 'function') {
    throw new TypeError('Bot governed tool executor is misconfigured');
  }

  const drains = new Map();
  const activeExecutions = new Map();
  const executionControllers = new Map();
  let executionOrdinal = 0;
  let shuttingDown = false;
  const warmAdaptersByRun = new Map();

  const markDiagnostic = (stage, fields = {}) => {
    try {
      recordDiagnostic({
        type: 'timing',
        mark: `bot.turn.${stage}`,
        payload: fields,
      });
    } catch {
    }
  };

  const warmRuntimeLeases = !hasInjectedExecutor && adapterRegistry.kinds.some(
    (kind) => typeof adapterRegistry.get(kind).warm === 'function',
  )
    ? createBotWarmRuntimeLeases({
        uuid: () => validateUuid(uuid(), 'warmLeaseId'),
        now: () => now().getTime(),
        record: (stage, fields) => markDiagnostic(stage, fields),
        logger,
        stop: async (runId) => {
          const adapter = warmAdaptersByRun.get(runId);
          warmAdaptersByRun.delete(runId);
          await adapter?.releaseWarm?.({ runId });
        },
        prepare: async (binding) => {
          const startedAt = performance.now();
          const selection = adapterRegistry.forRevision(binding.contract);
          if (typeof selection.adapter.warm !== 'function') return;
          warmAdaptersByRun.set(binding.runId, selection.adapter);
          await selection.adapter.warm({
            run: {
              id: binding.runId,
              botId: binding.botId,
              channelId: binding.channelId,
              revisionId: binding.revisionId,
              ownerUserId: binding.ownerUserId,
              updatedAt: binding.updatedAt,
            },
            contract: binding.contract,
            binding: selection.binding,
            attachmentIds: [],
            libraryVersionIds: binding.libraryVersionIds,
          });
          markDiagnostic('runtime_startup', {
            channelId: binding.channelId,
            runId: binding.runId,
            warm: true,
            durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
          });
        },
      })
    : null;

  const timeStage = async (collector, name, operation) => {
    const startedAt = performance.now();
    try {
      return await operation();
    } finally {
      collector?.(name, Math.max(0, performance.now() - startedAt));
    }
  };

  const audienceFor = async (channelId, fallbackUserId = null) => {
    if (typeof channels.audienceForChannel === 'function') {
      return channels.audienceForChannel(channelId);
    }
    return fallbackUserId ? [fallbackUserId] : [];
  };

  const publish = async (kind, run, payload, fallbackUserId = null) => eventStream.publish({
    kind,
    botId: run.bot_id,
    channelId: run.channel_id,
    audienceUserIds: await audienceFor(run.channel_id, fallbackUserId),
    payload,
  });

  const publishCanonical = async (kind, run, payload, fallbackUserId = null) => {
    try {
      return await publish(kind, run, payload, fallbackUserId);
    } catch (error) {
      logger?.warn?.('[BotsDispatcher] canonical event publication failed', {
        code: error?.code || 'bot_event_publish_failed',
        kind,
        runId: run?.id || null,
      });
      return Object.freeze({ delivered: 0 });
    }
  };

  const notifyRunCompleted = async (input) => {
    try {
      await onRunCompleted(input);
    } catch (error) {
      logger?.warn?.('[BotsDispatcher] completed-run follow-up failed', {
        code: error?.code || 'bot_run_follow_up_failed',
        runId: input?.run?.id || null,
      });
    }
  };

  const notifyRunSettled = async (input) => {
    try {
      await onRunSettled(input);
    } catch (error) {
      logger?.warn?.('[BotsDispatcher] settled-run follow-up failed', {
        code: error?.code || 'bot_run_settled_follow_up_failed',
        runId: input?.run?.id || null,
      });
    }
  };

  const cancelPendingActions = async (run) => {
    if (!approvalService) return;
    try {
      await approvalService.cancelPendingForRun({ run });
    } catch (error) {
      logger?.warn?.('[BotsDispatcher] pending-action cancellation failed', {
        code: error?.code || 'bot_action_cancel_failed',
        runId: run?.id || null,
      });
    }
  };

  const currentRun = (runId) => store.repositories.bot_runs.get({ id: runId });

  const updateRun = async (runId, changes) => {
    const current = await currentRun(runId);
    if (!current) fail('Bot run not found', 'bot_run_not_found', 404);
    if (TERMINAL_RUN_STATES.has(current.state)) return current;
    return store.repositories.bot_runs.updateIfRevision(
      { id: current.id },
      changes,
      current.updated_at,
    );
  };

  const settleTerminalRun = async (run, {
    state,
    interruptionKind,
    contextSnapshot,
    finishedAt,
  }) => {
    let lastError = null;
    for (const delayMs of TERMINAL_SETTLEMENT_RETRY_DELAYS_MS) {
      if (delayMs > 0) await delay(delayMs);
      try {
        const persisted = await store.settleRunTerminal({
          runId: run.id,
          state,
          interruptionKind,
          contextSnapshot,
          finishedAt,
        });
        if (persisted?.id) return persisted;
        lastError = new BotRunDispatcherError(
          'Bot terminal settlement returned no run',
          'bot_run_terminal_settlement_missing',
          503,
        );
      } catch (error) {
        lastError = error;
      }
    }
    const persistenceCode = lastError?.code || 'bot_run_terminal_persistence_failed';
    markDiagnostic('terminal_persistence_failed', {
      botId: run.bot_id,
      channelId: run.channel_id,
      runId: run.id,
      intendedState: state,
      code: persistenceCode,
      attempts: TERMINAL_SETTLEMENT_RETRY_DELAYS_MS.length,
    });
    logger?.warn?.('[BotsDispatcher] terminal run persistence failed', {
      code: persistenceCode,
      runId: run.id,
      intendedState: state,
    });
    throw lastError;
  };

  const assistantResponseProjection = (active) => {
    const messageId = active.providerMessageId || null;
    if (!messageId) return projectBotReasoningResponse([]);
    return projectBotReasoningResponse([
      ...(active.partsByMessage.get(messageId)?.values() || []),
    ]);
  };

  const renderedAssistantText = (active) => {
    const projection = assistantResponseProjection(active);
    return projection.resultText;
  };

  const pendingPartText = (active, messageId, partId, value, {
    append = false,
    ignored,
    synthetic,
    partType,
    visible,
  } = {}) => {
    let parts = active.pendingPartsByMessage.get(messageId);
    if (!parts) {
      if (active.pendingPartsByMessage.size >= MAX_PENDING_MESSAGE_COUNT) return false;
      parts = new Map();
      active.pendingPartsByMessage.set(messageId, parts);
    }
    const currentRecord = parts.get(partId);
    const current = currentRecord?.type === 'text' ? currentRecord.text : '';
    if (!parts.has(partId) && active.pendingPartCount >= MAX_PENDING_PART_COUNT) return false;
    const next = append ? `${current}${value}` : value;
    const currentBytes = Buffer.byteLength(current, 'utf8');
    const nextBytes = Buffer.byteLength(next, 'utf8');
    if (active.pendingTextBytes - currentBytes + nextBytes > MAX_PENDING_TEXT_BYTES) return false;
    if (!parts.has(partId)) active.pendingPartCount += 1;
    active.pendingTextBytes += nextBytes - currentBytes;
    parts.set(partId, Object.freeze({
      type: partType && partType !== 'unknown' ? partType : (currentRecord?.type || 'unknown'),
      text: next,
      ...(visible !== undefined ? { visible } : {}),
      ...(ignored === true || currentRecord?.ignored === true ? { ignored: true } : {}),
      ...(synthetic === true || currentRecord?.synthetic === true ? { synthetic: true } : {}),
    }));
    return true;
  };

  const takePendingParts = (active, messageId) => {
    const parts = active.pendingPartsByMessage.get(messageId);
    if (!parts) return null;
    active.pendingPartsByMessage.delete(messageId);
    for (const part of parts.values()) {
      const text = part?.type === 'text' ? part.text : '';
      active.pendingPartCount -= 1;
      active.pendingTextBytes -= Buffer.byteLength(text, 'utf8');
    }
    return parts;
  };

  const flushRequesterStream = (active) => {
    if (!streamAccessLeases || active.streamSuppressed || active.streamPaused
      || active.streamTimer) return;
    const elapsed = performance.now() - active.lastStreamScheduledAt;
    const delayMs = active.streamSequence === 0
      ? 0
      : Math.max(0, REQUESTER_STREAM_INTERVAL_MS - elapsed);
    const deliver = () => {
      active.streamTimer = null;
      const text = renderedAssistantText(active);
      const revision = active.streamRevision;
      if (revision <= active.lastStreamDeliveredRevision || !text) return;
      if (Buffer.byteLength(text, 'utf8') > MAX_REQUESTER_STREAM_TEXT_BYTES) {
        active.streamSuppressed = true;
        return;
      }
      active.lastStreamScheduledAt = performance.now();
      active.streamSequence += 1;
      const sequence = active.streamSequence;
      const messageId = active.assistantMessage.id;
      active.streamDelivery = active.streamDelivery
        .catch(() => undefined)
        .then(async () => {
          const authorized = await streamAccessLeases.authorize({
            channelId: active.run.channel_id,
            userId: active.requesterUserId,
          });
          if (!authorized || !streamAccessLeases.isAuthorized({
            channelId: active.run.channel_id,
            userId: active.requesterUserId,
          })) {
            active.lastStreamDeliveredRevision = revision;
            return;
          }
          const result = await eventStream.publish({
            kind: 'message.streaming',
            botId: active.run.bot_id,
            channelId: active.run.channel_id,
            audienceUserIds: [active.requesterUserId],
            payload: {
              messageId,
              runId: active.run.id,
              channelId: active.run.channel_id,
              sequence,
              createdAt: nowIso(now),
              text,
              revision,
            },
          });
          active.lastStreamDeliveredRevision = revision;
          if (!active.firstRequesterDelivery && result.delivered > 0) {
            active.firstRequesterDelivery = true;
            markDiagnostic('first_requester_delivery', {
              botId: active.run.bot_id,
              channelId: active.run.channel_id,
              runId: active.run.id,
              messageId,
            });
          }
        })
        .catch((error) => logger?.warn?.('[BotsDispatcher] requester stream failed', {
          code: error?.code || 'bot_stream_delivery_failed',
          runId: active.run.id,
        }))
        .finally(() => {
          if (active.streamRevision > revision && !active.streamSuppressed) {
            flushRequesterStream(active);
          }
        });
    };
    if (delayMs === 0) deliver();
    else {
      active.streamTimer = setTimeout(deliver, delayMs);
      active.streamTimer.unref?.();
    }
  };

  const noteRequesterText = (active) => {
    const text = renderedAssistantText(active);
    if (!text) return;
    active.streamRevision += 1;
    if (!active.firstProviderText) {
      active.firstProviderText = true;
      markDiagnostic('first_provider_text', {
        botId: active.run.bot_id,
        channelId: active.run.channel_id,
        runId: active.run.id,
      });
    }
    // Ambiguous pre-tool prose must never cross the public boundary.
    if (active.finalVerified) flushRequesterStream(active);
  };

  const updateKnownAssistantPart = (active, messageId, partId, value, {
    append = false,
    ignored,
    synthetic,
    partType,
    visible,
  } = {}) => {
    if (active.messageRolesById.get(messageId) !== 'assistant') return false;
    const parts = active.partsByMessage.get(messageId) || new Map();
    const currentRecord = parts.get(partId);
    const current = currentRecord?.type === 'text' ? currentRecord.text : '';
    const next = append ? `${current}${value}` : value;
    if (next === current && (partType === undefined || partType === currentRecord?.type)
      && ignored === currentRecord?.ignored && synthetic === currentRecord?.synthetic
      && visible === currentRecord?.visible) return false;
    parts.set(partId, Object.freeze({
      type: partType && partType !== 'unknown' ? partType : (currentRecord?.type || 'unknown'),
      text: next,
      ...(visible !== undefined ? { visible } : {}),
      ...(ignored === true || currentRecord?.ignored === true ? { ignored: true } : {}),
      ...(synthetic === true || currentRecord?.synthetic === true ? { synthetic: true } : {}),
    }));
    active.partsByMessage.set(messageId, parts);
    noteRequesterText(active);
    scheduleCheckpoint(active);
    return true;
  };

  const checkpointWrite = (active, {
    final = false,
    message = active.assistantMessage,
    text = renderedAssistantText(active),
    assistantPhase = null,
  } = {}) => {
    if (!message || (!final && !active.finalVerified)) return Promise.resolve(null);
    const streamRevision = active.streamRevision;
    active.lastCheckpointAt = Date.now();
    active.checkpointWrite = active.checkpointWrite
      .catch(() => undefined)
      .then(async () => {
        const updatedMessage = await channels.updateAssistantCheckpoint({
          message,
          text,
          finalizedAt: final ? nowIso(now) : null,
          assistantPhase,
        });
        if (updatedMessage) {
          await publish('message.updated', active.run, {
            message: updatedMessage,
            streamRevision,
            ...channelPreviewPayload(updatedMessage),
          }).catch((error) => logger?.warn?.('[BotsDispatcher] checkpoint publication failed', {
            code: error?.code || 'bot_event_publish_failed',
            runId: active.run.id,
            messageId: updatedMessage.id,
          }));
          if (!active.firstCanonicalCheckpoint) {
            active.firstCanonicalCheckpoint = true;
            markDiagnostic('first_canonical_checkpoint', {
              botId: active.run.bot_id,
              channelId: active.run.channel_id,
              runId: active.run.id,
              messageId: updatedMessage.id,
            });
          }
        }
        return updatedMessage;
      });
    return active.checkpointWrite;
  };

  const scheduleCheckpoint = (active) => {
    if (!active.finalVerified || !active.assistantMessage || active.streamPaused || active.checkpointTimer) return;
    const remaining = Math.max(
      0,
      checkpointIntervalMs - (Date.now() - active.lastCheckpointAt),
    );
    active.checkpointTimer = setTimeout(() => {
      active.checkpointTimer = null;
      void checkpointWrite(active).catch((error) => {
        active.reject(error);
      });
    }, remaining);
    active.checkpointTimer.unref?.();
  };

  const beginToolPhase = (active) => {
    active.toolObserved = true;
    // Keep the one pending result. Acknowledgment and progress prose are never
    // persisted; the UI represents activity using the authoritative run state.
  };

  const pendingPartTool = (active, messageId, partId) => {
    let parts = active.pendingPartsByMessage.get(messageId);
    if (!parts) {
      if (active.pendingPartsByMessage.size >= MAX_PENDING_MESSAGE_COUNT) return false;
      parts = new Map();
      active.pendingPartsByMessage.set(messageId, parts);
    }
    if (!parts.has(partId) && active.pendingPartCount >= MAX_PENDING_PART_COUNT) return false;
    const current = parts.get(partId);
    if (current?.type === 'text') {
      active.pendingTextBytes -= Buffer.byteLength(current.text, 'utf8');
    }
    if (!parts.has(partId)) active.pendingPartCount += 1;
    parts.set(partId, Object.freeze({ type: 'tool' }));
    return true;
  };

  const updateKnownAssistantTool = (active, messageId, partId) => {
    if (active.messageRolesById.get(messageId) !== 'assistant') return false;
    const parts = active.partsByMessage.get(messageId) || new Map();
    if (parts.get(partId)?.type === 'tool') return false;
    parts.set(partId, Object.freeze({ type: 'tool' }));
    active.partsByMessage.set(messageId, parts);
    beginToolPhase(active);
    return true;
  };

  const settleActive = (active, error = null) => {
    if (active.settled) return;
    active.settled = true;
    if (error) active.reject(error);
    else active.resolve();
  };

  const observeReasoningEvent = async ({ runId, event } = {}) => {
    const active = activeExecutions.get(runId);
    if (!active || active.finalVerified || !event || typeof event.kind !== 'string') return false;
    const properties = event.payload || {};
    if (properties.requestId && properties.requestId !== runId) return false;
    if (event.kind === 'assistant.message') {
      if (typeof properties.messageId === 'string' && typeof properties.role === 'string') {
        active.messageRolesById.set(properties.messageId, properties.role);
        if (properties.role !== 'assistant') {
          takePendingParts(active, properties.messageId);
          return true;
        }
        active.providerMessageId = properties.messageId;
        const pending = takePendingParts(active, properties.messageId);
        if (pending) {
          active.partsByMessage.set(properties.messageId, pending);
          if ([...pending.values()].some((part) => part?.type === 'tool')) {
            beginToolPhase(active);
          } else {
            noteRequesterText(active);
            scheduleCheckpoint(active);
          }
        }
        const limit = Number(active.modelSnapshot?.contextLimit || 0);
        if (limit > 0) {
          active.providerContextRatio = Math.min(1, totalTokens(properties.tokens) / limit);
        }
      }
    } else if (event.kind === 'assistant.text') {
      if (typeof properties.text === 'string'
        && typeof properties.partId === 'string' && typeof properties.messageId === 'string') {
        const role = active.messageRolesById.get(properties.messageId);
        if (role === 'assistant') {
          updateKnownAssistantPart(
            active,
            properties.messageId,
            properties.partId,
            properties.text,
            {
              append: properties.mode === 'append',
              ignored: properties.ignored,
              synthetic: properties.synthetic,
              partType: properties.partType,
              visible: properties.visible,
            },
          );
        } else if (role === undefined) {
          pendingPartText(
            active,
            properties.messageId,
            properties.partId,
            properties.text,
            {
              append: properties.mode === 'append',
              ignored: properties.ignored,
              synthetic: properties.synthetic,
              partType: properties.partType,
              visible: properties.visible,
            },
          );
        }
      }
    } else if (event.kind === 'governed_tool.intent') {
      if (typeof properties.partId === 'string' && typeof properties.messageId === 'string') {
        const role = active.messageRolesById.get(properties.messageId);
        if (role === 'assistant') {
          updateKnownAssistantTool(active, properties.messageId, properties.partId);
        } else if (role === undefined) {
          pendingPartTool(active, properties.messageId, properties.partId);
        }
      } else {
        beginToolPhase(active);
      }
    } else if (event.kind === 'run.error') {
      settleActive(active, new BotRunDispatcherError(
        'Scoped reasoning run failed',
        properties.code || 'bot_agent_run_failed',
        502,
        {
          ...(properties.diagnostics || {}),
          retryable: properties.retryable === true,
        },
      ));
    } else if (event.kind === 'run.completed' && properties.needsToolContinuation !== true) {
      if (active.promptAccepted) settleActive(active);
      else if (active.promptStarted) active.idleObservedDuringAcceptance = true;
    }
    return true;
  };

  const inspectCurrentCompletion = async (active) => {
    const inspection = await withBotAbort(active.adapter.inspectRun({
      runId: active.run.id,
      handle: active.handle,
      binding: active.adapterBinding,
      signal: active.controller.signal,
    }), active.controller.signal);
    if (inspection.requestId && inspection.requestId !== active.run.id) {
      throw new BotRunDispatcherError('Bot completion belongs to another request', 'bot_response_identity_invalid', 502);
    }
    return inspection;
  };

  const waitForCompletion = async (active) => {
    // SSE idle is a wakeup, not an answer. Polling recovers missed final events
    // without ever submitting the prompt again.
    let completionObserved = false;
    let incompleteIdleChecks = 0;
    let inspectionFailures = 0;
    while (true) {
      if (!completionObserved) {
        completionObserved = await withBotAbort(Promise.race([
          active.completion.then(() => true),
          delay(1_000, false, { signal: active.controller.signal }),
        ]), active.controller.signal);
      }
      let inspection;
      try {
        inspection = await inspectCurrentCompletion(active);
        inspectionFailures = 0;
      } catch (error) {
        if (!active.controller.signal.aborted && [502, 503, 504].includes(error?.statusCode)
          && error?.code !== 'bot_opencode_run_failed' && ++inspectionFailures < 3) {
          await delay(200, undefined, { signal: active.controller.signal });
          continue;
        }
        throw error;
      }
      if (inspection.promptObserved === true && inspection.assistantTerminal === true
        && inspection.status === 'idle') return inspection;
      if (completionObserved && inspection.promptObserved === true && inspection.status === 'idle') {
        // A terminal SSE idle plus the exact persisted request may have no
        // answer at all; let the caller report that explicitly.
        if (!inspection.assistantMessageId) return inspection;
        if (++incompleteIdleChecks >= 5) {
          const result = typeof channels.getAssistantCheckpoint === 'function'
            ? (await channels.getAssistantCheckpoint({ run: active.run, assistantPhase: 'result' })
              || await channels.getAssistantCheckpoint({ run: active.run, assistantPhase: 'pending' }))
            : null;
          if (inspection.assistantProjection?.generatedImages?.length > 0
            || Number(result?.attachment_count) > 0) return inspection;
          throw new BotRunDispatcherError('Bot stopped without a verified final response', 'bot_response_incomplete', 502);
        }
      }
      if (completionObserved) await delay(100, undefined, { signal: active.controller.signal });
    }
  };

  const executeDefault = async (claimed, { recovered = false } = {}) => {
    let runtimeStarted = false;
    let active = null;
    let activeAdapter = null;
    let adapterBinding = null;
    let adapterHandle = null;
    let current = claimed;
    let terminalState = 'completed';
    let terminalError = null;
    const controller = new AbortController();
    executionControllers.set(claimed.id, controller);
    const timeoutMs = Number.isFinite(claimed.context_snapshot?.routine?.contract?.timeoutSeconds)
      ? Math.max(10, claimed.context_snapshot.routine.contract.timeoutSeconds * 1_000)
      : runTimeoutMs;
    const deadline = setTimeout(() => controller.abort(new BotRunDispatcherError(
      'Bot run timed out', 'bot_run_timeout', 504,
    )), timeoutMs);
    deadline.unref?.();
    const bounded = (promise) => withBotAbort(promise, controller.signal);
    const persistedExecution = genericExecutionFromLegacyRun(claimed);
    let reconcilingPersistedExecution = Boolean(recovered && persistedExecution.threadId);
    try {
      const loadUserMessage = () => (typeof channels.loadRunUserMessage === 'function'
        ? channels.loadRunUserMessage({ runId: claimed.id, channelId: claimed.channel_id })
        : channels.loadRecentMessages({ channelId: claimed.channel_id, limit: 100 })
          .then((messages) => [...messages]
            .reverse()
            .find((message) => message.runId === claimed.id && message.role === 'user')));
      const [bot, channel, revision, userMessage] = await bounded(Promise.all([
        store.repositories.bots.get({ id: claimed.bot_id }),
        store.repositories.bot_channels.get({ id: claimed.channel_id, bot_id: claimed.bot_id }),
        store.repositories.bot_revisions.get({ id: claimed.revision_id, bot_id: claimed.bot_id }),
        loadUserMessage(),
      ]));
      if (!bot || !channel || !revision) fail('Bot run context is unavailable', 'bot_run_context_missing', 409);
      if (!userMessage) fail('Bot run user message is missing', 'bot_message_not_found', 409);
      const selection = adapterRegistry.forRevision(revision.contract);
      activeAdapter = selection.adapter;
      adapterBinding = Object.freeze({
        ...selection.binding,
        botId: claimed.bot_id,
        revisionId: claimed.revision_id,
      });
      if (persistedExecution.adapter && persistedExecution.adapter !== adapterBinding.kind) {
        throw new BotReasoningAdapterError(
          'A started Bot run cannot switch reasoning adapters',
          'bot_agent_adapter_changed',
          409,
        );
      }
      await bounded(runtimePreflight({ run: claimed, adapter: adapterBinding.kind, signal: controller.signal }));
      const runInput = {
        id: claimed.id,
        botId: claimed.bot_id,
        channelId: claimed.channel_id,
        revisionId: claimed.revision_id,
        ownerUserId: channel.owner_user_id,
        updatedAt: claimed.updated_at,
      };
      const assemblyPromise = contextAssembler.assemble({
        run: claimed,
        bot,
        channel,
        revision,
        queryText: userMessage.body.text,
        currentMessageId: userMessage.id,
        currentMessageSequence: userMessage.sequence,
      });
      const runtimePromise = activeAdapter.prepareRevision({
        signal: controller.signal,
        run: runInput,
        contract: revision.contract,
        binding: adapterBinding,
        attachmentIds: Array.isArray(userMessage.body?.attachmentIds)
          ? userMessage.body.attachmentIds
          : [],
        attachmentDeliveryMode: claimed.context_snapshot?.attachmentDeliveryMode || 'auto',
        libraryVersionIds: Array.isArray(claimed.context_snapshot?.libraryVersionIds)
          ? claimed.context_snapshot.libraryVersionIds
          : [],
      });
      // Preparation can finish after a cancelled non-abortable host callback.
      // Release its late resource instead of resurrecting a cancelled runtime.
      void runtimePromise.then(() => {
        if (controller.signal.aborted) return activeAdapter.closeRun({ runId: claimed.id }).catch(() => undefined);
        return undefined;
      }, () => undefined);
      const runtimeStartedAt = performance.now();
      const [assemblyResult, runtimeResult] = await bounded(Promise.allSettled([
        assemblyPromise,
        runtimePromise,
      ]));
      if (runtimeResult.status === 'fulfilled') runtimeStarted = true;
      if (assemblyResult.status === 'rejected' || runtimeResult.status === 'rejected') {
        if (runtimeResult.status === 'fulfilled') {
          await activeAdapter.closeRun({ runId: claimed.id }).catch(() => undefined);
          runtimeStarted = false;
        }
        throw assemblyResult.status === 'rejected'
          ? assemblyResult.reason
          : runtimeResult.reason;
      }
      const assembled = assemblyResult.value;
      const runtime = runtimeResult.value;
      runtimeStarted = true;
      markDiagnostic('runtime_startup', {
        botId: claimed.bot_id,
        channelId: claimed.channel_id,
        runId: claimed.id,
        durationMs: Math.round((performance.now() - runtimeStartedAt) * 100) / 100,
      });
      markDiagnostic('runtime_ready', {
        botId: claimed.bot_id,
        channelId: claimed.channel_id,
        runId: claimed.id,
      });
      const recoveredHandle = recovered && persistedExecution.threadId
        ? {
            threadId: persistedExecution.threadId,
            ...persistedExecution.execution,
          }
        : null;
      adapterHandle = await bounded(activeAdapter.startRun({
        signal: controller.signal,
        runId: claimed.id,
        title: `Bot channel ${channel.id.slice(0, 8)}`,
        execution: recoveredHandle,
        continuation: assembled.continuation,
      }));
      reconcilingPersistedExecution = Boolean(recoveredHandle);
      const executionContextSnapshot = {
        ...assembled.contextSnapshot,
        attachmentDeliveryMode: claimed.context_snapshot?.attachmentDeliveryMode || 'auto',
        continuationReason: recoveredHandle
          ? 'recovered_execution'
          : assembled.continuation.reason,
        ...(claimed.context_snapshot?.routine
          ? { routine: validateBotRoutineSnapshot(claimed.context_snapshot.routine) }
          : {}),
      };
      current = await currentRun(claimed.id);
      current = await store.repositories.bot_runs.updateIfRevision(
        { id: current.id },
        {
          state: 'running',
          agent_adapter: adapterBinding.kind,
          agent_thread_id: adapterHandle.threadId,
          agent_execution: adapterHandle.execution,
          ...(adapterHandle.legacyProjection || {}),
          model_snapshot: runtime.modelSnapshot,
          context_snapshot: executionContextSnapshot,
        },
        current.updated_at,
      );
      const recoveredResult = recovered && typeof channels.getAssistantCheckpoint === 'function'
        ? await channels.getAssistantCheckpoint({ run: current, assistantPhase: 'result' })
        : null;
      const recoveredAcknowledgment = recovered && typeof channels.getAssistantCheckpoint === 'function'
        ? await channels.getAssistantCheckpoint({ run: current, assistantPhase: 'acknowledgment' })
        : null;
      const recoveredPending = recovered && typeof channels.getAssistantCheckpoint === 'function'
        ? await channels.getAssistantCheckpoint({ run: current, assistantPhase: 'pending' })
        : null;
      const assistantMessage = recoveredResult || recoveredPending
        || await channels.getOrCreateAssistantCheckpoint({
          run: current,
          assistantPhase: 'pending',
        });
      if (recovered && recoveredResult?.finalized_at) {
        current = await updateRun(current.id, {
          state: 'completed',
          finished_at: recoveredResult.finalized_at,
        });
        await publishCanonical('run.completed', current, { run: channels.publicRun(current) });
        const recentMessages = await channels.loadRecentMessages({
          channelId: channel.id,
          limit: 100,
        });
        await notifyRunCompleted({
          run: current,
          bot,
          channel,
          revision,
          userMessage,
          assistantMessage: recentMessages.find((message) => (
            message.id === recoveredResult.id
            || (message.runId === current.id && message.role === 'assistant'
              && message.assistantPhase === 'result')
          )) || null,
          recovered: true,
        });
        markDiagnostic('terminal', {
          botId: current.bot_id,
          channelId: current.channel_id,
          runId: current.id,
          outcome: 'completed',
        });
        return current;
      }
      let resolveCompletion;
      let rejectCompletion;
      const completion = new Promise((resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
      });
      void completion.catch(() => undefined);
      active = {
        controller,
        finalVerified: false,
        run: current,
        adapter: activeAdapter,
        adapterBinding,
        handle: adapterHandle,
        modelSnapshot: runtime.modelSnapshot,
        assistantMessage,
        providerMessageId: null,
        messageRolesById: new Map(),
        partsByMessage: new Map(),
        pendingPartsByMessage: new Map(),
        pendingPartCount: 0,
        pendingTextBytes: 0,
        providerContextRatio: 0,
        requesterUserId: validateUuid(userMessage.actorUserId, 'message.actorUserId'),
        streamRevision: 0,
        streamSequence: 0,
        lastStreamDeliveredRevision: 0,
        lastStreamScheduledAt: 0,
        streamTimer: null,
        streamDelivery: Promise.resolve(),
        streamSuppressed: false,
        streamPaused: Boolean(recoveredAcknowledgment),
        toolObserved: Boolean(recoveredAcknowledgment),
        phaseTransition: Promise.resolve(),
        firstProviderText: false,
        firstRequesterDelivery: false,
        firstCanonicalCheckpoint: false,
        lastCheckpointAt: 0,
        checkpointTimer: null,
        checkpointWrite: Promise.resolve(),
        completion,
        resolve: resolveCompletion,
        reject: rejectCompletion,
        settled: false,
        promptAccepted: false,
        promptStarted: false,
        idleObservedDuringAcceptance: false,
        cancelled: false,
        timeoutMs: Number.isFinite(current.context_snapshot?.routine?.contract?.timeoutSeconds)
          ? Math.max(10, current.context_snapshot.routine.contract.timeoutSeconds * 1_000)
          : runTimeoutMs,
      };
      activeExecutions.set(current.id, active);
      await publishCanonical('run.started', current, { run: channels.publicRun(current) });
      const submitPrompt = async () => {
        active.promptStarted = true;
        let parts = assembled.parts;
        let toolMessage = null;
        let continuationCount = 0;
        while (true) {
          const continuation = await bounded(activeAdapter.continueRun({
            signal: controller.signal,
            runId: current.id,
            handle: active.handle,
            binding: adapterBinding,
            parts,
            toolMessage,
            onEvent: (event) => observeReasoningEvent({ runId: current.id, event }),
          }));
          if (continuation?.handle) {
            active.handle = continuation.handle;
            adapterHandle = continuation.handle;
            current = await updateRun(current.id, {
              agent_thread_id: adapterHandle.threadId,
              agent_execution: adapterHandle.execution,
              ...(adapterHandle.legacyProjection || {}),
            });
            active.run = current;
          }
          if (continuation?.status !== 'tool') break;
          if (!executeGovernedToolIntent) {
            throw new BotRunDispatcherError(
              'Selected agent requested a governed tool but the gateway is unavailable',
              'bot_gateway_operation_unavailable',
              503,
            );
          }
          continuationCount += 1;
          if (continuationCount > 32) {
            throw new BotRunDispatcherError(
              'Bot exceeded the governed tool continuation limit',
              'bot_agent_tool_limit_exceeded',
              409,
            );
          }
          let content;
          let toolError = null;
          try {
            const gatewayResult = await executeGovernedToolIntent({
              claims: {
                botId: current.bot_id,
                runId: current.id,
                channelId: current.channel_id,
                revisionId: current.revision_id,
              },
              operation: continuation.toolIntent.operation,
              payload: continuation.toolIntent.payload,
            });
            content = {
              ok: true,
              result: gatewayResult?.result ?? {},
              receipt: gatewayResult?.receipt ?? null,
            };
          } catch (error) {
            toolError = typeof error?.code === 'string' ? error.code : 'bot_gateway_operation_failed';
            content = {
              ok: false,
              error: {
                code: toolError,
                message: Number(error?.statusCode) >= 500
                  ? 'The governed operation is temporarily unavailable'
                  : String(error?.message || 'The governed operation was rejected').slice(0, 512),
              },
            };
          }
          parts = null;
          toolMessage = {
            toolCallId: continuation.toolIntent.toolCallId,
            content,
            ...(toolError ? { error: toolError } : {}),
          };
        }
        active.promptAccepted = true;
        markDiagnostic('prompt_accepted', {
          botId: current.bot_id,
          channelId: current.channel_id,
          runId: current.id,
        });
        if (active.idleObservedDuringAcceptance) settleActive(active);
      };
      if (recovered && recoveredHandle) {
        active.promptStarted = true;
        const inspection = await inspectCurrentCompletion(active);
        if (inspection.resumable === false) {
          throw new BotRunDispatcherError(
            'The interrupted agent run cannot be inspected or resumed; retry it as a new run',
            'bot_agent_retry_as_new_required',
            409,
          );
        }
        if (inspection.promptObserved) {
          active.promptAccepted = true;
          active.providerContextRatio = Math.max(
            0,
            Math.min(1, Number(inspection.providerContextRatio) || 0),
          );
          if (inspection.assistantMessageId || inspection.assistantText
            || inspection.assistantProjection?.toolObserved === true) {
            active.providerMessageId = inspection.assistantMessageId || 'recovered-assistant';
            active.messageRolesById.set(active.providerMessageId, 'assistant');
            const projection = inspection.assistantProjection;
            if (projection?.toolObserved === true) {
              active.partsByMessage.set(active.providerMessageId, new Map([
                ['recovered-acknowledgment', Object.freeze({
                  type: 'text', text: projection.acknowledgmentText || '',
                })],
                ['recovered-tool-boundary', Object.freeze({ type: 'tool' })],
                ['recovered-result', Object.freeze({
                  type: 'text', text: projection.resultText || '',
                })],
              ]));
              if (!active.toolObserved) beginToolPhase(active);
            } else {
              active.partsByMessage.set(active.providerMessageId, new Map([
                ['recovered-text', Object.freeze({
                  type: 'text', text: projection?.resultText || inspection.assistantText,
                })],
              ]));
            }
          }
          if (inspection.assistantTerminal || inspection.status === 'idle'
            || active.idleObservedDuringAcceptance) {
            settleActive(active);
          }
        } else {
          // An existing execution handle plus a missing request record is an
          // uncertain submission, not proof that no side effects occurred.
          throw new BotRunDispatcherError('The previous request could not be confirmed; it was not submitted again', 'bot_prompt_outcome_unknown', 409);
        }
      } else {
        await submitPrompt();
      }
      const finalizedInspection = await waitForCompletion(active);
      await active.phaseTransition;
      if (active.streamTimer) clearTimeout(active.streamTimer);
      await active.streamDelivery.catch(() => undefined);
      if (active.checkpointTimer) clearTimeout(active.checkpointTimer);
      await active.checkpointWrite.catch(() => undefined);
      current = await currentRun(current.id);
      if (GATEWAY_PAUSED_RUN_STATES.has(current?.state)) return current;
      const responseProjection = finalizedInspection.assistantProjection;
      if (!responseProjection) {
        throw new BotRunDispatcherError('Bot final response could not be verified', 'bot_response_unverified', 502);
      }
      const generatedImages = responseProjection.generatedImages || [];
      const persistedResponse = typeof channels.getAssistantCheckpoint === 'function'
        ? (await channels.getAssistantCheckpoint({ run: current, assistantPhase: 'result' })
          || await channels.getAssistantCheckpoint({ run: current, assistantPhase: 'pending' }))
        : null;
      if (persistedResponse) active.assistantMessage = persistedResponse;
      const hasPublishedAttachment = Number(persistedResponse?.attachment_count) > 0;
      if (!responseProjection.resultText.trim() && generatedImages.length === 0 && !hasPublishedAttachment) {
        throw new BotRunDispatcherError('Bot completed without a final response', 'bot_response_missing', 502);
      }
      active.finalVerified = true;
      if (generatedImages.length > 0) {
        if (typeof activeAdapter.exportArtifact !== 'function'
          || typeof sharedFileService?.publishBotFile !== 'function') {
          throw new BotRunDispatcherError(
            'Generated image publication is unavailable',
            'bot_image_publication_failed',
            503,
          );
        }
        try {
          for (const descriptor of generatedImages.slice(0, 12)) {
            const exported = await activeAdapter.exportArtifact({
              runId: current.id,
              path: descriptor.sourcePath,
              handle: active.handle,
              binding: adapterBinding,
            });
            try {
              const digest = createHash('sha256')
                .update(`${current.id}\0${descriptor.toolPartId}\0${descriptor.sourcePath}`)
                .digest('hex');
              await sharedFileService.publishBotFile({
                botId: current.bot_id,
                channelId: current.channel_id,
                runId: current.id,
                principalId: channel.owner_user_id,
                filename: exported.filename,
                contentType: exported.contentType,
                bytes: exported.bytes,
                sourceKey: `generated:${digest}`,
              });
            } finally {
              exported.bytes?.fill?.(0);
            }
          }
        } catch (error) {
          throw new BotRunDispatcherError(
            'Generated image could not be securely published',
            'bot_image_publication_failed',
            502,
            { cause: error },
          );
        }
      }
      const finalizedAssistantMessage = await checkpointWrite(active, {
        final: true,
        text: responseProjection.resultText,
        assistantPhase: active.assistantMessage?.assistant_phase === 'pending' ? 'result' : null,
      });
      current = await updateRun(current.id, {
        state: 'completed',
        context_snapshot: {
          ...executionContextSnapshot,
          completedUserTurns: executionContextSnapshot.completedUserTurns + 1,
          providerContextRatio: active.providerContextRatio,
        },
        finished_at: nowIso(now),
      });
      await publishCanonical('run.completed', current, { run: channels.publicRun(current) });
      await notifyRunCompleted({
        run: current,
        bot,
        channel,
        revision,
        userMessage,
        assistantMessage: finalizedAssistantMessage,
        recovered,
      });
      markDiagnostic('terminal', {
        botId: current.bot_id,
        channelId: current.channel_id,
        runId: current.id,
        outcome: 'completed',
      });
      return current;
    } catch (error) {
      if (controller.signal.aborted) error = controller.signal.reason;
      error = normalizeBotRunError(error, { cancellationConfirmed: active?.cancelled === true });
      terminalError = error;
      terminalState = active?.cancelled || error?.code === 'bot_run_cancelled'
        ? 'cancelled'
        : (reconcilingPersistedExecution ? 'interrupted' : 'failed');
      if (active?.checkpointTimer) clearTimeout(active.checkpointTimer);
      if (active?.streamTimer) clearTimeout(active.streamTimer);
      await active?.phaseTransition?.catch(() => undefined);
      await active?.streamDelivery?.catch(() => undefined);
      const durable = await currentRun(claimed.id).catch(() => null);
      // A gateway pause remains resumable only while the run is still live.
      // User cancellation must finalize any visible assistant checkpoint and
      // persist the terminal run instead of leaving the bubble "Updating…".
      const gatewayPaused = !active?.cancelled && GATEWAY_PAUSED_RUN_STATES.has(durable?.state);
      if (active?.assistantMessage) {
        await active.checkpointWrite.catch(() => undefined);
        if (!gatewayPaused) {
          await checkpointWrite(active, {
            final: true,
            text: '',
            assistantPhase: active.assistantMessage?.assistant_phase === 'pending'
              ? 'result'
              : null,
          }).catch(() => undefined);
        }
      }
      if (runtimeStarted && active?.handle && activeAdapter) {
        await activeAdapter.cancelRun({
          runId: claimed.id,
          handle: active.handle,
          binding: adapterBinding,
        }).catch(() => undefined);
      }
      if (gatewayPaused) {
        terminalError = null;
        current = durable;
        return current;
      }
      const executionStarted = Boolean(
        hasBotExecutionIdentity(durable)
        || hasBotExecutionIdentity(claimed)
        || adapterHandle?.threadId || adapterHandle?.execution?.threadId
        || adapterHandle?.execution?.segmentId || adapterHandle?.execution?.invocationId
        || active?.promptStarted
        || active?.firstProviderText || active?.toolObserved,
      );
      const sideEffects = !executionStarted && durable
        ? await hasBotRetrySideEffects(store, durable).catch(() => true)
        : true;
      const classifiedRetryable = typeof error?.diagnostics?.retryable === 'boolean'
        ? error.diagnostics.retryable
        : null;
      const failureStage = typeof error?.botRuntimeStage === 'string'
        ? error.botRuntimeStage
        : (typeof error?.diagnostics?.stage === 'string'
          ? error.diagnostics.stage
          : (executionStarted ? 'execution' : 'startup'));
      const interruptionKind = error?.code || 'bot_run_failed';
      const contextSnapshot = {
        ...(durable?.context_snapshot || claimed.context_snapshot || {}),
        state: terminalState,
        failurePhase: executionStarted ? 'execution' : 'startup',
        failureStage,
        retryable: terminalState === 'failed'
          && !executionStarted && !sideEffects && classifiedRetryable !== false,
      };
      if (terminalState === 'cancelled') {
        current = await updateRun(claimed.id, {
          state: terminalState,
          interruption_kind: interruptionKind,
          context_snapshot: contextSnapshot,
          finished_at: nowIso(now),
        });
      } else {
        current = await settleTerminalRun(durable || claimed, {
          state: terminalState,
          interruptionKind,
          contextSnapshot,
          finishedAt: nowIso(now),
        });
      }
      if (current.state === terminalState) {
        await publish(`run.${terminalState}`, current, {
          run: channels.publicRun(current),
          code: interruptionKind,
        }).catch(() => undefined);
      }
      markDiagnostic('terminal', {
        botId: current?.bot_id || claimed.bot_id,
        channelId: current?.channel_id || claimed.channel_id,
        runId: claimed.id,
        outcome: terminalState,
        code: error?.code || 'bot_run_failed',
        failureStage,
      });
      return current;
    } finally {
      clearTimeout(deadline);
      executionControllers.delete(claimed.id);
      if (active) activeExecutions.delete(claimed.id);
      if (runtimeStarted && activeAdapter) await activeAdapter.closeRun({
        runId: claimed.id,
        handle: active?.handle || adapterHandle,
        binding: adapterBinding,
      }).catch((error) => {
        logger?.warn?.('[BotsDispatcher] scoped runtime stop failed', {
          code: error?.code || 'bot_agent_close_failed',
          runId: claimed.id,
        });
      });
      warmRuntimeLeases?.settle(claimed.id);
      if (terminalError && (terminalState === 'failed' || terminalState === 'interrupted')) {
        logger?.warn?.('[BotsDispatcher] Bot run failed', {
          code: terminalError?.code || 'bot_run_failed',
          runId: claimed.id,
          ...(terminalError?.diagnostics ? {
            providerErrorType: terminalError.diagnostics.providerErrorType,
            statusCode: terminalError.diagnostics.statusCode,
            retryable: terminalError.diagnostics.retryable,
            providerReference: terminalError.diagnostics.providerReference,
          } : {}),
        });
      }
    }
  };

  const runExecutor = hasInjectedExecutor ? executeClaimedRun : executeDefault;

  const executeAndNotify = async (claimed, options) => {
    const result = await runExecutor(claimed, options);
    if (result?.id && TERMINAL_RUN_STATES.has(result.state)) {
      await notifyRunSettled({ run: result });
    }
    return result;
  };

  const claimScopeRun = async (computerScopeKey) => {
    await reconcileExpiredApprovals(computerScopeKey);
    const claimed = await store.claimRun({
      computerScopeKey,
      runtimeOwner,
      leaseUntil: new Date(now().getTime() + leaseMs).toISOString(),
    });
    if (claimed) {
      markDiagnostic('queue_claimed', {
        botId: claimed.bot_id,
        channelId: claimed.channel_id,
        runId: claimed.id,
      });
    }
    return claimed;
  };

  const startScopeDrain = (computerScopeKey, initialClaim = null) => {
    if (shuttingDown) return Promise.resolve();
    const existing = drains.get(computerScopeKey);
    if (existing) return existing;
    const promise = (async () => {
      let claimed = initialClaim;
      while (!shuttingDown) {
        if (!claimed) claimed = await claimScopeRun(computerScopeKey);
        if (!claimed) break;
        const drainIndex = executionOrdinal;
        executionOrdinal += 1;
        try {
          await executeAndNotify(claimed, { drainIndex, recovered: false });
        } catch (error) {
          error = normalizeBotRunError(error);
          logger?.warn?.('[BotsDispatcher] claimed run execution failed', {
            code: error?.code || 'bot_run_failed',
            runId: claimed.id,
          });
          const interruptionKind = error?.code || 'bot_run_failed';
          const failed = await settleTerminalRun(claimed, {
            state: 'failed',
            interruptionKind,
            contextSnapshot: {
              ...(claimed.context_snapshot || {}),
              state: 'failed',
              failurePhase: 'execution',
              failureStage: 'dispatcher',
              retryable: false,
            },
            finishedAt: nowIso(now),
          }).catch(() => undefined);
          if (failed?.id && TERMINAL_RUN_STATES.has(failed.state)) {
            if (failed.state === 'failed') {
              await publish('run.failed', failed, {
                run: channels.publicRun(failed),
                code: interruptionKind,
              }).catch(() => undefined);
            }
            await notifyRunSettled({ run: failed });
          }
        }
        claimed = null;
      }
    })().finally(() => drains.delete(computerScopeKey));
    drains.set(computerScopeKey, promise);
    return promise;
  };

  const drainScope = (computerScopeKey) => startScopeDrain(computerScopeKey);

  return Object.freeze({
    async enqueueMessage({ principal, channelId, message, admission, timing = null } = {}) {
      if (shuttingDown) fail('Bot dispatcher is shutting down', 'bots_unavailable', 503);
      const normalizedMessage = normalizeMessage(message);
      markDiagnostic('request_received', {
        channelId: validateUuid(channelId, 'channelId'),
        messageId: normalizedMessage.messageId,
      });
      const preflight = await timeStage(timing, 'authorization', () => (
        channels.preflightMessage({ principal, channelId })
      ));
      const normalizedAdmission = normalizeAdmission(admission, preflight.bot.active_revision_id);
      const requestedRevisionId = normalizedAdmission?.revisionId || preflight.bot.active_revision_id;
      const revision = preflight.revision?.id === requestedRevisionId
        ? preflight.revision
        : await store.repositories.bot_revisions.get({
            id: requestedRevisionId,
            bot_id: preflight.bot.id,
          });
      if (!revision || revision.activated_at === null || revision.retired_at != null) {
        fail('Bot active revision is unavailable', 'bot_revision_unavailable', 409);
      }
      const computerScopeKey = resolveComputerScopeKey({
        botId: preflight.bot.id,
        tenancy: preflight.bot.tenancy,
        ownerUserId: preflight.channel.owner_user_id,
      });
      const libraryVersionIds = await timeStage(timing, 'library', () => resolveLibrarySnapshot({
        botId: preflight.bot.id,
        configuredVersionIds: Array.isArray(revision.contract?.libraryVersionIds)
          ? revision.contract.libraryVersionIds
          : [],
      }));
      if (!Array.isArray(libraryVersionIds) || libraryVersionIds.length > 1_000) {
        fail('Bot Library snapshot is invalid', 'bot_library_snapshot_invalid', 502);
      }
      const normalizedLibraryVersionIds = libraryVersionIds.map((versionId) => (
        validateUuid(versionId, 'libraryVersionId')
      ));
      if (new Set(normalizedLibraryVersionIds).size !== normalizedLibraryVersionIds.length) {
        fail('Bot Library snapshot contains duplicates', 'bot_library_snapshot_invalid', 502);
      }
      const warmEligible = normalizedMessage.attachmentIds.length === 0 && !normalizedAdmission;
      let warmClaim = Object.freeze({ hit: false, runId: null });
      if (warmRuntimeLeases && warmEligible && normalizedMessage.prewarmLeaseId) {
        warmClaim = await warmRuntimeLeases.claim({
          leaseId: normalizedMessage.prewarmLeaseId,
          principalId: validateUuid(principal?.id, 'principal.id'),
          channelId: preflight.channel.id,
          revisionId: revision.id,
          librarySnapshotKey: normalizedLibraryVersionIds.join(':'),
          messageId: normalizedMessage.messageId,
        });
      }
      if (warmRuntimeLeases && !warmClaim.hit) {
        await warmRuntimeLeases.releaseChannel({
          principalId: validateUuid(principal?.id, 'principal.id'),
          channelId: preflight.channel.id,
          reason: warmEligible ? 'cold_path_replacement' : 'ineligible_send',
        });
      }
      const runId = warmClaim.hit
        ? warmClaim.runId
        : validateUuid(uuid(), 'runId');
      const acknowledgmentId = normalizedMessage.acknowledgmentId
        || assistantResponseIdForMessage(normalizedMessage.messageId);
      let admitted;
      try {
        admitted = await timeStage(timing, 'admission', () => channels.enqueueUserMessage({
          principal,
          preflight,
          messageId: normalizedMessage.messageId,
          acknowledgmentId,
          runId,
          revisionId: revision.id,
          idempotencyKey: normalizedMessage.idempotencyKey,
          text: normalizedMessage.text,
          attachmentIds: normalizedMessage.attachmentIds,
          computerScopeKey,
          modelSnapshot: { version: 1, state: 'pending' },
          contextSnapshot: {
            version: 1,
            state: 'queued',
            libraryVersionIds: normalizedLibraryVersionIds,
            attachmentDeliveryMode: normalizedMessage.attachmentDeliveryMode,
            ...(normalizedAdmission ? { routine: normalizedAdmission.routine } : {}),
          },
        }));
      } catch (error) {
        if (warmClaim.hit) await warmRuntimeLeases?.abandonClaim(runId);
        throw error;
      }
      const requiresSharedPreparation = admitted.created
        && normalizedMessage.attachmentIds.length > 0
        && sharedFileService !== null;
      const run = admitted.rawRun || admitted.run;
      markDiagnostic('durable_acceptance', {
        botId: run?.bot_id || preflight.bot.id,
        channelId: preflight.channel.id,
        messageId: admitted.message?.id || normalizedMessage.messageId,
        runId: run?.id || null,
        created: admitted.created === true,
      });
      if (admitted.acknowledgment) {
        markDiagnostic('acknowledgment_ready', {
          botId: run?.bot_id || preflight.bot.id,
          channelId: preflight.channel.id,
          messageId: admitted.acknowledgment.id,
          runId: run?.id || null,
        });
      }
      if (streamAccessLeases && run) {
        streamAccessLeases.establish({
          principal,
          channelId: preflight.channel.id,
          botId: preflight.bot.id,
        });
      }
      setImmediate(() => {
        if (admitted.created) {
          void publish('message.created', run, {
            message: admitted.message,
            run: admitted.run,
            ...channelPreviewPayload(admitted.message),
          }, principal?.id).catch((error) => logger?.warn?.(
            '[BotsDispatcher] accepted-message publication failed',
            {
              code: error?.code || 'bot_event_publish_failed',
              messageId: admitted.message?.id || normalizedMessage.messageId,
            },
          ));
          if (admitted.acknowledgment) {
            void publish('message.created', run, {
              message: admitted.acknowledgment,
              run: admitted.run,
            }, principal?.id).then(() => {
              markDiagnostic('acknowledgment_published', {
                botId: run?.bot_id || preflight.bot.id,
                channelId: preflight.channel.id,
                messageId: admitted.acknowledgment.id,
                runId: run?.id || null,
              });
            }).catch((error) => logger?.warn?.(
              '[BotsDispatcher] acknowledgment publication failed',
              {
                code: error?.code || 'bot_event_publish_failed',
                messageId: admitted.acknowledgment.id,
              },
            ));
          }
        }
        if (requiresSharedPreparation) {
          void sharedFileService.prepareMessage({ messageId: normalizedMessage.messageId })
            .catch((error) => logger?.warn?.('[BotsShared] message preparation failed', {
              code: error?.code || 'bot_shared_file_copy_failed',
              messageId: normalizedMessage.messageId,
            }))
            .finally(() => {
              if (autoDispatch && run?.state === 'queued' && !drains.has(computerScopeKey)) {
                void drainScope(computerScopeKey);
              }
            });
        } else if (autoDispatch && run?.state === 'queued' && !drains.has(computerScopeKey)) {
          void drainScope(computerScopeKey);
        }
      });
      return Object.freeze({
        created: admitted.created,
        message: admitted.message,
        acknowledgment: admitted.acknowledgment,
        run: admitted.run,
      });
    },

    drainScope,
    observeReasoningEvent,

    async resumeRun(run) {
      if (shuttingDown) return { resumed: false };
      const current = await currentRun(validateUuid(run?.id, 'run.id'));
      if (!current || TERMINAL_RUN_STATES.has(current.state)) {
        return { resumed: false, claimed: false };
      }
      if (current.lease_owner && current.lease_owner !== runtimeOwner
        && await isRuntimeOwnerAlive(current.lease_owner)) {
        return { resumed: false, claimed: false };
      }
      let claimed;
      try {
        claimed = await store.repositories.bot_runs.updateIfRevision(
          { id: current.id },
          {
            lease_owner: runtimeOwner,
            lease_until: new Date(now().getTime() + leaseMs).toISOString(),
            lease_generation: Number(current.lease_generation || 0) + 1,
          },
          current.updated_at,
        );
      } catch (error) {
        if (error?.code === 'bot_revision_conflict') {
          return { resumed: false, claimed: false };
        }
        throw error;
      }
      markDiagnostic('queue_claimed', {
        botId: claimed.bot_id,
        channelId: claimed.channel_id,
        runId: claimed.id,
        recovered: true,
      });
      const result = await executeAndNotify(claimed, {
        drainIndex: executionOrdinal++,
        recovered: true,
      });
      return { resumed: result?.state !== 'interrupted', claimed: true };
    },

    async getRunStatus({ principal, runId } = {}) {
      const run = await currentRun(validateUuid(runId, 'runId'));
      if (!run) fail('Bot run not found', 'bot_run_not_found', 404);
      await channels.authorizeChannelRead({ principal, channelId: run.channel_id });
      return channels.publicRun(run);
    },

    async retryRun({ principal, runId } = {}) {
      if (shuttingDown) fail('Bot dispatcher is shutting down', 'bots_unavailable', 503);
      if (typeof store.retryRun !== 'function') {
        fail('Bot run retry is unavailable', 'bots_unavailable', 503);
      }
      const normalizedRunId = validateUuid(runId, 'runId');
      const run = await currentRun(normalizedRunId);
      if (!run) fail('Bot run not found', 'bot_run_not_found', 404);
      try {
        await channels.authorizeChannelSend({ principal, channelId: run.channel_id });
      } catch (error) {
        if (error?.statusCode === 403) {
          error.details = Object.freeze({ retryReason: 'access_revoked' });
        }
        throw error;
      }
      const retried = await store.retryRun({
        runId: normalizedRunId,
        actorUserId: validateUuid(principal?.id, 'principal.id'),
        now: nowIso(now),
      });
      const publicRun = channels.publicRun(retried);
      setImmediate(() => {
        void publish('run.queued', retried, { run: publicRun }, principal?.id)
          .catch((error) => logger?.warn?.('[BotsDispatcher] retried-run publication failed', {
            code: error?.code || 'bot_event_publish_failed',
            runId: retried.id,
          }));
        if (autoDispatch && !drains.has(retried.computer_scope_key)) {
          void drainScope(retried.computer_scope_key);
        }
      });
      return publicRun;
    },

    async prewarmChannel({ principal, channelId } = {}) {
      if (!warmRuntimeLeases) {
        fail('Bot prewarm is unavailable', 'bots_unavailable', 503);
      }
      const preflight = await channels.preflightMessage({ principal, channelId });
      const revision = preflight.revision || await store.repositories.bot_revisions.get({
        id: preflight.bot.active_revision_id,
        bot_id: preflight.bot.id,
      });
      if (!revision || revision.activated_at === null || revision.retired_at !== null) {
        fail('Bot active revision is unavailable', 'bot_revision_unavailable', 409);
      }
      const recentRuns = await store.repositories.bot_runs.list({
        filters: { channel_id: preflight.channel.id },
        limit: 100,
      });
      if ((recentRuns.items || []).some((run) => !TERMINAL_RUN_STATES.has(run.state))) {
        return Object.freeze({
          state: 'skipped',
          leaseId: null,
          revisionId: revision.id,
          expiresAt: null,
          reason: 'busy',
        });
      }
      const libraryVersionIds = (await resolveLibrarySnapshot({
        botId: preflight.bot.id,
        configuredVersionIds: Array.isArray(revision.contract?.libraryVersionIds)
          ? revision.contract.libraryVersionIds
          : [],
      })).map((versionId) => validateUuid(versionId, 'libraryVersionId'));
      return warmRuntimeLeases.begin({
        principalId: validateUuid(principal?.id, 'principal.id'),
        botId: preflight.bot.id,
        channelId: preflight.channel.id,
        revisionId: revision.id,
        contract: revision.contract,
        ownerUserId: preflight.channel.owner_user_id,
        updatedAt: revision.updated_at || nowIso(now),
        libraryVersionIds,
        librarySnapshotKey: libraryVersionIds.join(':'),
      });
    },

    async releasePrewarm({ principal, channelId, leaseId } = {}) {
      const normalizedChannelId = validateUuid(channelId, 'channelId');
      await channels.authorizeChannelRead({ principal, channelId: normalizedChannelId });
      const released = await warmRuntimeLeases?.release({
        leaseId: validateUuid(leaseId, 'leaseId'),
        principalId: validateUuid(principal?.id, 'principal.id'),
        channelId: normalizedChannelId,
      });
      return Object.freeze({ released: released === true });
    },

    invalidateChannel(channelId) {
      void warmRuntimeLeases?.releaseChannel({ channelId, reason: 'channel_invalidated' });
      streamAccessLeases?.invalidateChannel(channelId);
    },

    async invalidateAll() {
      await warmRuntimeLeases?.invalidateAll();
    },

    async cancelRun({ principal, runId } = {}) {
      const normalizedRunId = validateUuid(runId, 'runId');
      const run = await currentRun(normalizedRunId);
      if (!run) fail('Bot run not found', 'bot_run_not_found', 404);
      await channels.authorizeChannelSend({ principal, channelId: run.channel_id });
      if (TERMINAL_RUN_STATES.has(run.state)) {
        await cancelPendingActions(run);
        return channels.publicRun(run);
      }
      executionControllers.get(run.id)?.abort(new BotRunDispatcherError('Bot run was cancelled', 'bot_run_cancelled', 409));
      const active = activeExecutions.get(run.id);
      if (active) {
        active.cancelled = true;
        await active.adapter.cancelRun({
          runId: run.id,
          handle: active.handle,
          binding: active.adapterBinding,
        }).catch(() => undefined);
        await cancelPendingActions(run);
        settleActive(active, new BotRunDispatcherError(
          'Bot run was cancelled',
          'bot_run_cancelled',
          409,
        ));
        return channels.publicRun(run);
      }
      const cancelled = await updateRun(run.id, {
        state: 'cancelled',
        interruption_kind: 'cancelled_by_user',
        finished_at: nowIso(now),
      });
      await cancelPendingActions(cancelled);
      await publishCanonical(
        'run.cancelled',
        cancelled,
        { run: channels.publicRun(cancelled) },
        principal?.id,
      );
      await notifyRunSettled({ run: cancelled });
      markDiagnostic('terminal', {
        botId: cancelled.bot_id,
        channelId: cancelled.channel_id,
        runId: cancelled.id,
        outcome: 'cancelled',
      });
      return channels.publicRun(cancelled);
    },

    async shutdown() {
      shuttingDown = true;
      for (const controller of executionControllers.values()) {
        controller.abort(new BotRunDispatcherError('Bot runtime shut down', 'bot_run_interrupted', 503));
      }
      await warmRuntimeLeases?.shutdown();
      for (const active of activeExecutions.values()) {
        active.cancelled = true;
        settleActive(active, new BotRunDispatcherError(
          'Bot runtime shut down',
          'bot_run_interrupted',
          503,
        ));
      }
      await Promise.allSettled([...drains.values()]);
    },
  });
}
