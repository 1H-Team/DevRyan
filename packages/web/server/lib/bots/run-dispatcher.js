import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

import { resolveComputerScopeKey } from '@openchamber/bots-runtime';

import { publicBotChannelPreview } from './channels.js';
import { normalizeBotRunError, botErrorLogFields } from './error-normalization.js';
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
const DEFERRED_SETTLEMENT_DELAYS_MS = Object.freeze([1_000, 5_000, 30_000, 120_000, 300_000]);
const DEFERRED_SETTLEMENT_MAX_AGE_MS = 30 * 60 * 1000;
const DRAIN_RETRY_MIN_MS = 2_000;
const DRAIN_RETRY_MAX_MS = 60_000;
// Memory extraction on the completed run's own runtime must never make the
// next message wait long; past this budget the durable queue takes over.
const INLINE_MEMORY_EXTRACTION_BUDGET_MS = 30_000;
// A run whose runtime never started is replayed automatically this many times
// before its failure is shown to the user. Only stages where the failure is a
// slow or flaky runtime boot qualify; a missing secret or credential is a
// configuration problem that a replay cannot fix.
const AUTOMATIC_STARTUP_RETRY_LIMIT = 2;
const AUTOMATIC_STARTUP_RETRY_STAGES = new Set([
  'gateway',
  'container',
  'readiness',
  'oauth_readiness',
  'admission',
  'shared_copy',
]);
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
  const cancelRequests = new Set();
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
        ...botErrorLogFields(error, 'bot_event_publish_failed'),
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
      // The follow-up is memory extraction enqueue; the database trigger is the
      // backstop, but a failure here must leave a content-free trace.
      const fields = botErrorLogFields(error, 'bot_run_follow_up_failed');
      logger?.warn?.('[BotsDispatcher] completed-run follow-up failed', {
        ...fields,
        runId: input?.run?.id || null,
      });
      markDiagnostic('memory_enqueue_failed', {
        botId: input?.run?.bot_id || null,
        channelId: input?.run?.channel_id || null,
        runId: input?.run?.id || null,
        code: fields.code,
      });
    }
  };

  const hasQueuedRun = async (channelId) => {
    try {
      const page = await store.repositories.bot_runs.list({
        filters: { channel_id: channelId, state: 'queued' },
        limit: 1,
      });
      return (page?.items || []).length > 0;
    } catch {
      return false;
    }
  };

  // Shared by the user-facing retry and the automatic startup retry: publish
  // the requeued run, re-copy Shared attachments when needed, then drain.
  const scheduleRetriedRun = (retried, actorUserId) => {
    const publicRun = channels.publicRun(retried);
    setImmediate(() => {
      void publish('run.queued', retried, { run: publicRun }, actorUserId)
        .catch((error) => logger?.warn?.('[BotsDispatcher] retried-run publication failed', {
          ...botErrorLogFields(error, 'bot_event_publish_failed'),
          runId: retried.id,
        }));
      // A retried message with attachments re-copies its Shared files first;
      // the claim proceeds through onMessageReady, and a copy that fails
      // again fails the run visibly through onMessageBlocked.
      const sharedRetry = sharedFileService && typeof sharedFileService.prepareMessage === 'function'
        ? store.repositories.bot_messages.list({
          filters: { run_id: retried.id, channel_id: retried.channel_id, role: 'user' },
          limit: 1,
        }).then(({ items }) => {
          const userMessage = items[0];
          if (!userMessage || Number(userMessage.attachment_count || 0) === 0) return false;
          return sharedFileService.prepareMessage({ messageId: userMessage.id, force: true })
            .then(() => true);
        }).catch((error) => {
          logger?.warn?.('[BotsDispatcher] retried-run Shared preparation failed', {
            ...botErrorLogFields(error, 'bot_shared_file_copy_failed'),
            runId: retried.id,
          });
          return false;
        })
        : Promise.resolve(false);
      void sharedRetry.then(() => {
        if (autoDispatch) void drainScope(retried.computer_scope_key);
      });
    });
  };

  const retryStartupFailure = async ({ runId, channelId }) => {
    if (shuttingDown || typeof store.retryRun !== 'function') return false;
    const { items } = await store.repositories.bot_messages.list({
      filters: { run_id: runId, channel_id: channelId, role: 'user' },
      limit: 1,
    });
    const actorUserId = items[0]?.actor_user_id;
    if (!actorUserId) return false;
    const retried = await store.retryRun({ runId, actorUserId, now: nowIso(now) });
    markDiagnostic('startup_retry', {
      channelId,
      runId,
      retryCount: Number(retried?.context_snapshot?.retryCount) || 0,
    });
    scheduleRetriedRun(retried, actorUserId);
    return true;
  };

  const beginPostRunPrewarm = async ({ bot, channel, revision }) => {
    if (!warmRuntimeLeases || shuttingDown) return null;
    if (revision.activated_at === null || revision.retired_at !== null
      || (bot.active_revision_id && bot.active_revision_id !== revision.id)) return null;
    if (await hasQueuedRun(channel.id)) return null;
    const libraryVersionIds = (await resolveLibrarySnapshot({
      botId: bot.id,
      configuredVersionIds: Array.isArray(revision.contract?.libraryVersionIds)
        ? revision.contract.libraryVersionIds
        : [],
    })).map((versionId) => validateUuid(versionId, 'libraryVersionId'));
    return warmRuntimeLeases.begin({
      principalId: validateUuid(channel.owner_user_id, 'channel.owner_user_id'),
      botId: bot.id,
      channelId: channel.id,
      revisionId: revision.id,
      contract: revision.contract,
      ownerUserId: channel.owner_user_id,
      updatedAt: revision.updated_at || nowIso(now),
      libraryVersionIds,
      librarySnapshotKey: libraryVersionIds.join(':'),
      serverInitiated: true,
    });
  };

  const notifyRunSettled = async (input) => {
    try {
      await onRunSettled(input);
    } catch (error) {
      logger?.warn?.('[BotsDispatcher] settled-run follow-up failed', {
        ...botErrorLogFields(error, 'bot_run_settled_follow_up_failed'),
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
        ...botErrorLogFields(error, 'bot_action_cancel_failed'),
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
    const persistenceCode = botErrorLogFields(lastError, 'bot_run_terminal_persistence_failed').code;
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
    deferTerminalSettlement(run, { state, interruptionKind, contextSnapshot, finishedAt });
    throw lastError;
  };

  // A terminal transition that could not be persisted during a database blip
  // is journaled here and retried with backoff. Until it lands, the run stays
  // non-terminal and blocks its scope's claim, so every scope claim retries its
  // own pending settlements first. Publication still happens only after the
  // idempotent terminal RPC returns the persisted row.
  const pendingTerminalSettlements = new Map();

  const publishTerminalOutcome = async (persisted, interruptionKind) => {
    if (persisted.state === 'failed' || persisted.state === 'interrupted') {
      await publish(`run.${persisted.state}`, persisted, {
        run: channels.publicRun(persisted),
        code: interruptionKind,
      }).catch(() => undefined);
    }
    await notifyRunSettled({ run: persisted });
  };

  const scheduleDeferredSettlement = (entry) => {
    if (shuttingDown || entry.timer) return;
    const delayMs = DEFERRED_SETTLEMENT_DELAYS_MS[
      Math.min(entry.attempts, DEFERRED_SETTLEMENT_DELAYS_MS.length - 1)
    ];
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void retryDeferredSettlement(entry.run.id);
    }, delayMs);
    entry.timer.unref?.();
  };

  const deferTerminalSettlement = (run, input) => {
    if (!run?.id || pendingTerminalSettlements.has(run.id)) return;
    const entry = {
      run,
      input,
      attempts: 0,
      firstFailedAt: now().getTime(),
      timer: null,
      inFlight: false,
    };
    pendingTerminalSettlements.set(run.id, entry);
    scheduleDeferredSettlement(entry);
  };

  const retryDeferredSettlement = async (runId) => {
    const entry = pendingTerminalSettlements.get(runId);
    if (!entry || entry.inFlight) return null;
    entry.inFlight = true;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    try {
      const current = await currentRun(runId);
      if (!current || TERMINAL_RUN_STATES.has(current.state)) {
        pendingTerminalSettlements.delete(runId);
        return current;
      }
      const persisted = await store.settleRunTerminal({ runId, ...entry.input });
      if (!persisted?.id) {
        throw new BotRunDispatcherError(
          'Bot terminal settlement returned no run',
          'bot_run_terminal_settlement_missing',
          503,
        );
      }
      pendingTerminalSettlements.delete(runId);
      markDiagnostic('terminal_persistence_recovered', {
        botId: persisted.bot_id,
        channelId: persisted.channel_id,
        runId,
        outcome: persisted.state,
        attempts: entry.attempts + 1,
      });
      await publishTerminalOutcome(persisted, entry.input.interruptionKind);
      return persisted;
    } catch (error) {
      entry.attempts += 1;
      if (now().getTime() - entry.firstFailedAt > DEFERRED_SETTLEMENT_MAX_AGE_MS) {
        pendingTerminalSettlements.delete(runId);
        logger?.warn?.('[BotsDispatcher] deferred terminal settlement abandoned', {
          ...botErrorLogFields(error, 'bot_run_terminal_persistence_failed'),
          runId,
          attempts: entry.attempts,
        });
        return null;
      }
      scheduleDeferredSettlement(entry);
      return null;
    } finally {
      entry.inFlight = false;
    }
  };

  // Promote the admitted pending assistant row of a run that ends without any
  // model output to an empty finalized result, so the bubble stops "typing".
  const finalizeEmptyPendingResponse = async (run) => {
    if (typeof channels.getAssistantCheckpoint !== 'function'
      || typeof channels.updateAssistantCheckpoint !== 'function') return null;
    const pending = await channels.getAssistantCheckpoint({ run, assistantPhase: 'pending' });
    if (!pending || pending.finalized_at) return null;
    const finalized = await channels.updateAssistantCheckpoint({
      message: pending,
      text: '',
      finalizedAt: nowIso(now),
      assistantPhase: 'result',
    });
    if (finalized) {
      await publish('message.updated', run, {
        message: finalized,
        ...channelPreviewPayload(finalized),
      }).catch(() => undefined);
    }
    return finalized;
  };

  const retryPendingTerminalSettlements = async (computerScopeKey = null) => {
    const results = [];
    for (const entry of [...pendingTerminalSettlements.values()]) {
      if (computerScopeKey && entry.run.computer_scope_key !== computerScopeKey) continue;
      results.push(await retryDeferredSettlement(entry.run.id));
    }
    return results;
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
          ...botErrorLogFields(error, 'bot_stream_delivery_failed'),
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

  // Quick-reply questions asked through the gateway during a run, keyed by run
  // id, until the final result carries them into the Bot's message.
  const questionsByRunId = new Map();

  const checkpointWrite = (active, {
    final = false,
    message = active.assistantMessage,
    text = renderedAssistantText(active),
    assistantPhase = null,
    question = null,
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
          ...(final && question ? { question } : {}),
        });
        if (updatedMessage) {
          await publish('message.updated', active.run, {
            message: updatedMessage,
            streamRevision,
            ...channelPreviewPayload(updatedMessage),
          }).catch((error) => logger?.warn?.('[BotsDispatcher] checkpoint publication failed', {
            ...botErrorLogFields(error, 'bot_event_publish_failed'),
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

  // The first short line the Bot wrote before its first tool call is its
  // acknowledgment ("on it, give me a sec"). It becomes its own finalized bubble
  // and a fresh pending row takes the final answer, so the member sees the Bot
  // respond in its own voice before the work starts. Progress prose between
  // tools is still never persisted.
  const promoteAcknowledgment = (active) => {
    if (active.acknowledgmentPromoted || active.streamPaused) return;
    const message = active.assistantMessage;
    if (!message || message.assistant_phase !== 'pending' || message.finalized_at) return;
    if (typeof channels.getOrCreateAssistantCheckpoint !== 'function') return;
    const acknowledgmentText = assistantResponseProjection(active).acknowledgmentText;
    if (!acknowledgmentText.trim()) return;
    active.acknowledgmentPromoted = true;
    active.phaseTransition = active.phaseTransition
      .catch(() => undefined)
      .then(async () => {
        const acknowledgment = await channels.updateAssistantCheckpoint({
          message,
          text: acknowledgmentText,
          finalizedAt: nowIso(now),
          assistantPhase: 'acknowledgment',
        });
        const pending = await channels.getOrCreateAssistantCheckpoint({
          run: active.run,
          assistantPhase: 'pending',
        });
        if (active.assistantMessage === message) active.assistantMessage = pending;
        if (acknowledgment) {
          await publish('message.updated', active.run, {
            message: acknowledgment,
            ...channelPreviewPayload(acknowledgment),
          }).catch(() => undefined);
        }
        if (pending) {
          await publish('message.created', active.run, {
            message: pendingMessageProjection(pending),
            run: channels.publicRun(active.run),
          }).catch(() => undefined);
        }
      })
      .catch((error) => {
        active.acknowledgmentPromoted = false;
        logger?.warn?.('[BotsDispatcher] acknowledgment promotion failed', {
          ...botErrorLogFields(error, 'bot_acknowledgment_failed'),
          runId: active.run.id,
        });
      });
  };

  // The fresh pending row has no body yet; project it the way admission does.
  const pendingMessageProjection = (row) => Object.freeze({
    id: row.id,
    channelId: row.channel_id,
    runId: row.run_id || null,
    actorUserId: null,
    role: 'assistant',
    assistantPhase: row.assistant_phase || 'pending',
    sequence: Number(row.sequence),
    body: Object.freeze({ text: '', attachmentIds: Object.freeze([]) }),
    attachmentCount: 0,
    createdAt: row.created_at,
    finalizedAt: null,
  });

  const beginToolPhase = (active) => {
    const first = !active.toolObserved;
    active.toolObserved = true;
    if (first) promoteAcknowledgment(active);
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
        const tokenCount = totalTokens(properties.tokens);
        active.providerTokenTotal = Math.max(Number(active.providerTokenTotal) || 0, tokenCount);
        if (limit > 0) {
          active.providerContextRatio = Math.min(1, tokenCount / limit);
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
          && error?.code !== 'bot_opencode_run_failed'
          && error?.code !== 'bot_agent_execution_lost' && ++inspectionFailures < 3) {
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
    let automaticRetry = null;
    let bot = null;
    let channel = null;
    let revision = null;
    let userMessage = null;
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
      [bot, channel, revision, userMessage] = await bounded(Promise.all([
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
        actorUserId: userMessage.actor_user_id || null,
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
        providerTokenTotal: 0,
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
        mutatingToolObserved: false,
        acknowledgmentPromoted: Boolean(recoveredAcknowledgment),
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
          const readOnlyIntent = (
            ['artifact.get', 'library.search', 'memory.search'].includes(
              continuation.toolIntent.operation,
            )
            || (continuation.toolIntent.operation === 'computer.command'
              && ['download', 'navigate', 'screenshot', 'scroll', 'snapshot', 'status', 'wait']
                .includes(continuation.toolIntent.payload?.command))
            || (continuation.toolIntent.operation === 'action.request'
              && continuation.toolIntent.payload?.target?.operationKind === 'read')
          );
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
            const receipt = gatewayResult?.receipt;
            const safeRead = receipt?.operationKind === 'read'
              && (receipt.writeGuarantee === undefined || receipt.writeGuarantee === null
                || receipt.writeGuarantee === 'safe_to_retry');
            if (!safeRead) active.mutatingToolObserved = true;
            content = {
              ok: true,
              result: gatewayResult?.result ?? {},
              receipt: gatewayResult?.receipt ?? null,
            };
          } catch (error) {
            if (!readOnlyIntent) active.mutatingToolObserved = true;
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
          active.providerTokenTotal = Math.max(
            Number(active.providerTokenTotal) || 0,
            Number(inspection.providerTokenTotal) || 0,
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
              // A recovered turn is reconciled, not replayed: its acknowledgment
              // is historical and is not promoted into a new bubble now.
              active.toolObserved = true;
              active.acknowledgmentPromoted = true;
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
      // A scoped agent execution that vanishes (container restart, evicted
      // thread) before the model produced anything visible and before any
      // governed action ran is recreated exactly once; the prompt is then
      // resubmitted into the fresh execution. Anything later fails visibly.
      const recreateLostExecution = async (error) => {
        if (error?.code !== 'bot_agent_execution_lost' || active.executionRecreated
          || recoveredHandle || active.cancelled || controller.signal.aborted
          || active.firstProviderText || active.toolObserved) return false;
        const attempts = await Promise.resolve()
          .then(() => store.repositories.bot_action_attempts.list({
            filters: { run_id: current.id },
            limit: 1,
          }))
          .catch(() => ({ items: [null] }));
        if (attempts.items.length > 0) return false;
        active.executionRecreated = true;
        markDiagnostic('execution_lost_recreated', {
          botId: current.bot_id,
          channelId: current.channel_id,
          runId: current.id,
        });
        logger?.warn?.('[BotsDispatcher] agent execution lost before any output; recreating once', {
          runId: current.id,
        });
        adapterHandle = await bounded(activeAdapter.startRun({
          signal: controller.signal,
          runId: current.id,
          title: `Bot channel ${channel.id.slice(0, 8)}`,
          execution: null,
          continuation: assembled.continuation,
        }));
        active.handle = adapterHandle;
        current = await updateRun(current.id, {
          agent_thread_id: adapterHandle.threadId,
          agent_execution: adapterHandle.execution,
          ...(adapterHandle.legacyProjection || {}),
          context_snapshot: { ...(current.context_snapshot || {}), executionRecreatedCount: 1 },
        });
        active.run = current;
        let resolveNext;
        let rejectNext;
        const nextCompletion = new Promise((resolve, reject) => {
          resolveNext = resolve;
          rejectNext = reject;
        });
        void nextCompletion.catch(() => undefined);
        Object.assign(active, {
          completion: nextCompletion,
          resolve: resolveNext,
          reject: rejectNext,
          settled: false,
          promptAccepted: false,
          promptStarted: false,
          idleObservedDuringAcceptance: false,
          providerMessageId: null,
          pendingPartCount: 0,
          pendingTextBytes: 0,
        });
        active.messageRolesById.clear();
        active.partsByMessage.clear();
        active.pendingPartsByMessage.clear();
        await submitPrompt();
        return true;
      };
      let finalizedInspection;
      try {
        finalizedInspection = await waitForCompletion(active);
      } catch (error) {
        if (!(await recreateLostExecution(error))) throw error;
        finalizedInspection = await waitForCompletion(active);
      }
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
      // A turn that ends by asking a quick-reply question is a complete turn
      // even when the model wrote no prose around it.
      const question = questionsByRunId.get(current.id) || null;
      if (!responseProjection.resultText.trim() && generatedImages.length === 0
        && !hasPublishedAttachment && !question) {
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
        question,
      });
      current = await updateRun(current.id, {
        state: 'completed',
        context_snapshot: {
          ...executionContextSnapshot,
          completedUserTurns: executionContextSnapshot.completedUserTurns + 1,
          providerContextRatio: active.providerContextRatio,
          providerTokenTotal: Number(active.providerTokenTotal) || 0,
        },
        finished_at: nowIso(now),
      });
      await publishCanonical('run.completed', current, { run: channels.publicRun(current) });
      // Memory extraction runs on this run's still-active runtime, bounded so a
      // follow-up message never waits long. When a message is already queued
      // the durable queue takes over and the runtime is released right away.
      const inlineExtraction = runtimeStarted && typeof activeAdapter.completeStructured === 'function'
        && !(await hasQueuedRun(channel.id))
        ? {
            extract: (request) => activeAdapter.completeStructured({
              runId: current.id,
              prompt: request.prompt,
              schema: request.schema,
              ...(request.title ? { title: request.title } : {}),
              ...(request.system ? { system: request.system } : {}),
              ...(request.signal ? { signal: request.signal } : {}),
            }),
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(INLINE_MEMORY_EXTRACTION_BUDGET_MS),
            ]),
          }
        : {};
      await notifyRunCompleted({
        run: current,
        bot,
        channel,
        revision,
        userMessage,
        assistantMessage: finalizedAssistantMessage,
        recovered,
        ...inlineExtraction,
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
      const cancellationRequested = active?.cancelled === true || cancelRequests.has(claimed.id);
      error = normalizeBotRunError(error, { cancellationConfirmed: cancellationRequested });
      terminalError = error;
      terminalState = cancellationRequested || error?.code === 'bot_run_cancelled'
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
      const gatewayPaused = !cancellationRequested && GATEWAY_PAUSED_RUN_STATES.has(durable?.state);
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
      // Evidence, not phase, decides whether a same-run retry is safe: a run
      // that started executing but produced no visible text, no finalized
      // output, and no governed action can be replayed into a fresh execution.
      const sideEffects = durable
        ? await hasBotRetrySideEffects(store, durable).catch(() => true)
        : true;
      const visibleOutput = Boolean(active?.firstProviderText || active?.mutatingToolObserved);
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
          && !sideEffects && !visibleOutput && classifiedRetryable !== false,
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
        ...botErrorLogFields(error, 'bot_run_failed'),
        failureStage,
      });
      // A runtime that never started (slow container boot, readiness probe
      // timeout) has no side effects to protect. Retry it on the user's behalf
      // a bounded number of times before the failure is shown.
      if (current?.state === 'failed' && contextSnapshot.failurePhase === 'startup'
        && contextSnapshot.retryable === true
        && AUTOMATIC_STARTUP_RETRY_STAGES.has(failureStage)
        && (Number(contextSnapshot.retryCount) || 0) < AUTOMATIC_STARTUP_RETRY_LIMIT) {
        automaticRetry = { runId: claimed.id, channelId: claimed.channel_id };
      }
      return current;
    } finally {
      clearTimeout(deadline);
      executionControllers.delete(claimed.id);
      cancelRequests.delete(claimed.id);
      questionsByRunId.delete(claimed.id);
      if (active) activeExecutions.delete(claimed.id);
      if (runtimeStarted && activeAdapter) await activeAdapter.closeRun({
        runId: claimed.id,
        handle: active?.handle || adapterHandle,
        binding: adapterBinding,
      }).catch((error) => {
        logger?.warn?.('[BotsDispatcher] scoped runtime stop failed', {
          ...botErrorLogFields(error, 'bot_agent_close_failed'),
          runId: claimed.id,
        });
      });
      warmRuntimeLeases?.settle(claimed.id);
      if (terminalError && (terminalState === 'failed' || terminalState === 'interrupted')) {
        logger?.warn?.('[BotsDispatcher] Bot run failed', {
          ...botErrorLogFields(terminalError, 'bot_run_failed'),
          runId: claimed.id,
          ...(terminalError?.diagnostics ? {
            providerErrorType: terminalError.diagnostics.providerErrorType,
            statusCode: terminalError.diagnostics.statusCode,
            retryable: terminalError.diagnostics.retryable,
            providerReference: terminalError.diagnostics.providerReference,
          } : {}),
        });
      }
      if (automaticRetry) {
        void retryStartupFailure(automaticRetry).catch((retryError) => {
          logger?.warn?.('[BotsDispatcher] automatic startup retry failed', {
            ...botErrorLogFields(retryError, 'bot_run_retry_failed'),
            runId: automaticRetry.runId,
          });
        });
      } else if (terminalState === 'completed' && channel && revision && bot) {
        // Warm the next runtime for this channel now, while the user reads the
        // answer, so the follow-up message adopts a ready container instead of
        // paying a cold start. A queued message is about to start its own run.
        void beginPostRunPrewarm({ bot, channel, revision }).catch((prewarmError) => {
          logger?.warn?.('[BotsDispatcher] post-run prewarm failed', {
            ...botErrorLogFields(prewarmError, 'bot_warm_prepare_failed'),
            channelId: channel.id,
          });
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
    if (pendingTerminalSettlements.size > 0) {
      await retryPendingTerminalSettlements(computerScopeKey);
    }
    try {
      await reconcileExpiredApprovals(computerScopeKey);
    } catch (error) {
      // Expiry reconciliation is best-effort here: the claim RPC stays the
      // lease authority and the periodic sweep retries expiry with backoff.
      logger?.warn?.('[BotsDispatcher] approval expiry reconciliation skipped', {
        ...botErrorLogFields(error, 'bot_approval_expiry_failed'),
        computerScopeKey,
      });
    }
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

  // A drain that is inside its claim RPC cannot see a message admitted after
  // the RPC's snapshot. Callers therefore leave a wake mark instead of skipping
  // the drain; the loop re-claims once more whenever a mark arrived, and the
  // teardown re-arms the drain when a mark arrived during the last claim.
  const pendingWakes = new Set();
  const drainRetryTimers = new Map();
  const drainRetryDelays = new Map();

  const scheduleDrainRetry = (computerScopeKey) => {
    if (shuttingDown || drainRetryTimers.has(computerScopeKey)) return 0;
    const previous = drainRetryDelays.get(computerScopeKey) || 0;
    const delayMs = Math.min(DRAIN_RETRY_MAX_MS, Math.max(DRAIN_RETRY_MIN_MS, previous * 2));
    drainRetryDelays.set(computerScopeKey, delayMs);
    const timer = setTimeout(() => {
      drainRetryTimers.delete(computerScopeKey);
      void startScopeDrain(computerScopeKey);
    }, delayMs);
    timer.unref?.();
    drainRetryTimers.set(computerScopeKey, timer);
    return delayMs;
  };

  const startScopeDrain = (computerScopeKey, initialClaim = null) => {
    if (shuttingDown) return Promise.resolve();
    const existing = drains.get(computerScopeKey);
    if (existing) {
      pendingWakes.add(computerScopeKey);
      return existing;
    }
    const promise = (async () => {
      let claimed = initialClaim;
      while (!shuttingDown) {
        if (!claimed) {
          pendingWakes.delete(computerScopeKey);
          try {
            claimed = await claimScopeRun(computerScopeKey);
          } catch (error) {
            const retryInMs = scheduleDrainRetry(computerScopeKey);
            logger?.warn?.('[BotsDispatcher] scope claim failed', {
              ...botErrorLogFields(error, 'bot_run_claim_failed'),
              computerScopeKey,
              retryInMs,
            });
            break;
          }
          drainRetryDelays.delete(computerScopeKey);
        }
        if (!claimed) {
          if (pendingWakes.delete(computerScopeKey)) continue;
          break;
        }
        const drainIndex = executionOrdinal;
        executionOrdinal += 1;
        try {
          await executeAndNotify(claimed, { drainIndex, recovered: false });
        } catch (error) {
          error = normalizeBotRunError(error);
          logger?.warn?.('[BotsDispatcher] claimed run execution failed', {
            ...botErrorLogFields(error, 'bot_run_failed'),
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
    })().finally(() => {
      drains.delete(computerScopeKey);
      if (!shuttingDown && pendingWakes.delete(computerScopeKey)) {
        void startScopeDrain(computerScopeKey);
      }
    });
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
      if (warmRuntimeLeases && warmEligible && !warmClaim.hit
        && typeof warmRuntimeLeases.claimForChannel === 'function') {
        warmClaim = await warmRuntimeLeases.claimForChannel({
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
              ...botErrorLogFields(error, 'bot_event_publish_failed'),
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
                ...botErrorLogFields(error, 'bot_event_publish_failed'),
                messageId: admitted.acknowledgment.id,
              },
            ));
          }
        }
        if (requiresSharedPreparation) {
          void sharedFileService.prepareMessage({ messageId: normalizedMessage.messageId })
            .catch((error) => logger?.warn?.('[BotsShared] message preparation failed', {
              ...botErrorLogFields(error, 'bot_shared_file_copy_failed'),
              messageId: normalizedMessage.messageId,
            }))
            .finally(() => {
              if (autoDispatch && run?.state === 'queued') void drainScope(computerScopeKey);
            });
        } else if (autoDispatch && run?.state === 'queued') {
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

    // A queued run whose Shared copies cannot be prepared would otherwise hold
    // the channel head forever with typing dots. Fail it visibly instead: the
    // pending assistant row is finalized empty, the terminal RPC frees the
    // scope, and the failure is startup-phase retryable (no execution identity,
    // no output, no action attempt), so Retry re-copies and requeues the run.
    async failQueuedRun({ runId, code = 'bot_shared_file_copy_failed', failedFileIds = [] } = {}) {
      if (shuttingDown) return null;
      const run = await currentRun(validateUuid(runId, 'runId'));
      if (!run || run.state !== 'queued') return run;
      const interruptionKind = botErrorLogFields({ code }, 'bot_shared_file_copy_failed').code;
      const persisted = await settleTerminalRun(run, {
        state: 'failed',
        interruptionKind,
        contextSnapshot: {
          ...(run.context_snapshot || {}),
          state: 'failed',
          failurePhase: 'startup',
          failureStage: 'shared_copy',
          retryable: true,
          failedSharedFileCount: Array.isArray(failedFileIds) ? failedFileIds.length : 0,
        },
        finishedAt: nowIso(now),
      });
      if (persisted?.state !== 'failed') return persisted;
      await finalizeEmptyPendingResponse(persisted).catch((error) => {
        logger?.warn?.('[BotsDispatcher] blocked-run checkpoint finalization failed', {
          ...botErrorLogFields(error, 'bot_message_invalid'),
          runId: persisted.id,
        });
      });
      await publish('run.failed', persisted, {
        run: channels.publicRun(persisted),
        code: interruptionKind,
      }).catch(() => undefined);
      markDiagnostic('terminal', {
        botId: persisted.bot_id,
        channelId: persisted.channel_id,
        runId: persisted.id,
        outcome: 'failed',
        code: interruptionKind,
        failureStage: 'shared_copy',
      });
      logger?.warn?.('[BotsDispatcher] queued run failed before execution', {
        code: interruptionKind,
        runId: persisted.id,
        failedSharedFileCount: Array.isArray(failedFileIds) ? failedFileIds.length : 0,
      });
      await notifyRunSettled({ run: persisted });
      return persisted;
    },

    // True while this process owns the run: it is executing here, or its
    // terminal outcome is journaled and awaiting persistence. Sweeps must not
    // resume such a run.
    // Gateway callback: the Bot asked the member a quick-reply question during
    // this run. It replaces any earlier question (one question per turn).
    recordRunQuestion({ run, question }) {
      const runId = validateUuid(run?.id, 'run.id');
      if (!activeExecutions.has(runId) && !executionControllers.has(runId)) {
        throw new BotRunDispatcherError('Bot run is not accepting questions', 'bot_question_run_inactive', 409);
      }
      questionsByRunId.set(runId, question);
      return Object.freeze({ recorded: true });
    },

    isExecuting(runId) {
      return activeExecutions.has(runId) || executionControllers.has(runId)
        || pendingTerminalSettlements.has(runId);
    },

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
      scheduleRetriedRun(retried, principal?.id);
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
      cancelRequests.add(run.id);
      const executionController = executionControllers.get(run.id);
      executionController?.abort(new BotRunDispatcherError('Bot run was cancelled', 'bot_run_cancelled', 409));
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
      try {
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
      } finally {
        // An in-flight execution owns cleanup in its finally block. A queued
        // run has no such owner, so never retain its marker after this path.
        if (!executionController) cancelRequests.delete(run.id);
      }
    },

    async shutdown() {
      shuttingDown = true;
      for (const timer of drainRetryTimers.values()) clearTimeout(timer);
      drainRetryTimers.clear();
      pendingWakes.clear();
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
      for (const entry of pendingTerminalSettlements.values()) {
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = null;
      }
      await retryPendingTerminalSettlements().catch(() => undefined);
      cancelRequests.clear();
    },
    retryPendingTerminalSettlements,
    get pendingTerminalSettlementCount() {
      return pendingTerminalSettlements.size;
    },
  });
}
