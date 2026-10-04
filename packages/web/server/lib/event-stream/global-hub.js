import { createUpstreamSseReader, GEN2_UPSTREAM_STALL_TIMEOUT_MS } from './upstream-reader.js';
import { randomUUID } from 'node:crypto';
import { eventPayloadBytes } from './payload-serialization.js';
import { createBoundedTaskRunner } from './bounded-task-runner.js';
import {
  createMessageStreamGapControlPayload,
  isMessageStreamControlPayload,
  toUpstreamV2SseEvent,
} from './protocol.js';
import { createV2Requester, parseV2EventBlock } from '../opencode/opencode-client/v2.js';
import { resolveOpenCodeGeneration } from '../opencode/opencode-generation.js';
import { unwrapData, unwrapPage } from '../opencode/opencode-client/envelope.js';
import { activeSessionIDs, retryStatusFromMessages } from '../opencode/v2/projection/status.js';

// Raised from 512 → 2048 to improve recovery after brief disconnects during
// long-running agent sessions where many events accumulate quickly.
export const MESSAGE_STREAM_GLOBAL_REPLAY_LIMIT = 2048;

// Count alone is not a memory bound: message.part.updated events can carry
// entire tool outputs and patch text, so 2048 retained payloads can reach
// hundreds of MB. Evict oldest entries once the approximate serialized size of
// the buffer exceeds this budget. Clients that reconnect past the window get a
// `gap` response and resync, which the protocol already handles.
const parseByteBudget = (raw) => {
  const value = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(value) && value > 0 ? value : null;
};
export const MESSAGE_STREAM_GLOBAL_REPLAY_BYTE_BUDGET =
  parseByteBudget(process.env.OPENCHAMBER_MESSAGE_STREAM_REPLAY_BYTE_BUDGET) ?? 16 * 1024 * 1024;

// OpenCode 2 uses data-only `/api/event` frames without upstream replay. Every
// reconnect marks projection state cold, reconciles active sessions, and tells
// downstream clients to resync. Browser replay remains bounded and local.

/** Newest rows read to re-seed a cold session's history. */
export const GEN2_HISTORY_SEED_LIMIT = 100;
/** Newest rows read per active session to recover a retry status (B.3). */
export const GEN2_ACTIVE_RETRY_ROWS = 10;
/** Active sessions whose retry status one reconciliation looks up. */
export const GEN2_ACTIVE_RETRY_LOOKUP_LIMIT = 64;
/** Concurrent reseed requests. */
export const GEN2_RESEED_CONCURRENCY = 4;
/** Queued reseed requests before the oldest is dropped (and recovered by a gap). */
export const GEN2_RESEED_MAX_QUEUED = 4096;
/** Upstream event ids remembered for the defect-guard dedupe. */
export const GEN2_DEDUPE_WINDOW = 2048;

/** Diagnostic codes the hub records. */
export const GLOBAL_HUB_DIAGNOSTICS = Object.freeze({
  reseedFailed: 'opencode_v2_reseed_failed',
  reseedOverflow: 'opencode_v2_reseed_overflow',
  reseedUnavailable: 'opencode_v2_reseed_unavailable',
  duplicate: 'opencode_v2_event_duplicate',
});

/**
 * Whether a hub entry belongs on a directory-filtered stream
 * (`/api/event?directory=`, the directory WebSocket bridge). Control frames
 * and `server.connected` reach every stream; without a directory every entry
 * matches.
 * @param {{ payload?: unknown, directory?: string } | null | undefined} entry
 * @param {string | null | undefined} directory
 */
export function matchesMessageStreamDirectory(entry, directory) {
  if (!entry) return false;
  if (typeof directory !== 'string' || directory.length === 0) return true;
  if (isMessageStreamControlPayload(entry.payload)) return true;
  if (entry.directory === directory) return true;
  return entry.directory === 'global' && entry.payload?.type === 'server.connected';
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const encode = (value) => encodeURIComponent(String(value));

export function createGlobalMessageStreamHub({
  getOpenCodeAuthHeaders,
  fetchImpl = fetch,
  upstreamReconnectDelayMs,
  replayLimit = MESSAGE_STREAM_GLOBAL_REPLAY_LIMIT,
  replayByteBudget = MESSAGE_STREAM_GLOBAL_REPLAY_BYTE_BUDGET,
  transformEventPayload,
  openCodeClient = null,
  getOpenCodeRuntime = null,
  generation2StallTimeoutMs = GEN2_UPSTREAM_STALL_TIMEOUT_MS,
  recordDiagnostic = null,
}) {
  const eventSubscribers = new Set();
  const statusSubscribers = new Set();
  const replay = [];
  const replaySizes = [];
  // Gen 2 only: the connection epoch each buffered entry arrived in. An entry
  // from before the latest upstream reconnect cannot prove gap-free replay.
  const replayEpochs = [];
  let replayEpoch = 0;
  let replayTotalBytes = 0;
  let syntheticEventSequence = 0;
  const bootID = randomUUID();
  let cursorSequence = 0;

  let controller = null;
  let reader = null;
  let connected = false;
  let everConnected = false;
  let buildUrlFailed = false;

  // Gen 2 state.
  /** Generation of the current (or last) upstream connection. */
  let connectionGeneration = null;
  let upstreamConnections = 0;
  let projector = null;
  let drainScheduled = false;
  let reseedOverflowNoted = false;
  let reseedUnavailableNoted = false;
  const dedupeIds = new Set();
  const dedupeOrder = [];
  // Sessions whose status a live event set while an `/api/session/active`
  // reconciliation was in flight: live state is authoritative over that snapshot.
  const activeReconciliations = new Set();
  const requestV2 = typeof getOpenCodeRuntime === 'function'
    ? createV2Requester({
      getRuntime: getOpenCodeRuntime,
      getAuthHeaders: getOpenCodeAuthHeaders,
      fetchImpl,
      ...(typeof recordDiagnostic === 'function' ? { recordDiagnostic } : {}),
    })
    : null;

  const diagnostic = (code, details = {}) => {
    if (typeof recordDiagnostic !== 'function') return;
    try {
      recordDiagnostic({ code, generation: 2, ...details });
    } catch {
      // Observer only.
    }
  };

  const notifySubscriber = (kind, subscriber, payload) => {
    try {
      const result = subscriber(payload);
      if (result && typeof result.catch === 'function') {
        result.catch((error) => {
          console.warn(`Global message stream ${kind} subscriber failed:`, error);
        });
      }
    } catch (error) {
      console.warn(`Global message stream ${kind} subscriber failed:`, error);
    }
  };

  const notifyStatus = (status) => {
    for (const subscriber of Array.from(statusSubscribers)) {
      notifySubscriber('status', subscriber, status);
    }
  };

  // The payload dominates; its serialization is shared with client delivery.
  const approxEventSizeBytes = (normalized) => {
    try {
      return eventPayloadBytes(normalized.payload) + Buffer.byteLength(JSON.stringify(normalized.envelope ?? null)) + 128;
    } catch {
      return 1024;
    }
  };

  const rememberReplayEvent = (normalized) => {
    if (!normalized?.eventId) {
      return;
    }
    const size = approxEventSizeBytes(normalized);
    replay.push(normalized);
    replaySizes.push(size);
    replayEpochs.push(replayEpoch);
    replayTotalBytes += size;
    // Always keep at least the newest event, even if it alone busts the budget.
    while (
      replay.length > 1 &&
      (replay.length > replayLimit || replayTotalBytes > replayByteBudget)
    ) {
      replay.shift();
      replayTotalBytes -= replaySizes.shift() ?? 0;
      replayEpochs.shift();
    }
  };

  const notifyEvent = (normalized) => {
    for (const subscriber of Array.from(eventSubscribers)) {
      notifySubscriber('event', subscriber, normalized);
    }
  };

  const normalizeEventId = (value) => (
    typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
  );

  const withoutUpstreamPayload = (envelope) => {
    if (!envelope || typeof envelope !== 'object' || !('payload' in envelope)) return envelope;
    const { payload: _upstreamPayload, ...routing } = envelope;
    return routing;
  };

  const normalizeEvent = ({ envelope, payload }) => {
    const directory =
      typeof envelope?.directory === 'string' && envelope.directory.length > 0 ? envelope.directory : 'global';
    // Transport cursors do not change the event's own identity or envelope.
    // Upstream reconnection continues to use only upstream-supplied SSE IDs.
    const eventId = normalizeEventId(envelope?.eventId) ?? `devryan-${bootID}-${++cursorSequence}`;
    return {
      // The upstream envelope also holds the untransformed payload, which can
      // carry multi-MB diff bodies the transform removed. Replay retains only
      // its routing fields.
      envelope: withoutUpstreamPayload(envelope),
      payload,
      directory,
      eventId,
    };
  };

  const transformPayload = (payload) => {
    if (typeof transformEventPayload !== 'function') return payload;
    try {
      const transformed = transformEventPayload(payload);
      return transformed || payload;
    } catch (error) {
      console.warn('Global message stream payload transform failed:', error);
      return payload;
    }
  };

  const resolveGeneration = () => resolveOpenCodeGeneration(openCodeClient);

  const noteLiveStatuses = (projected) => {
    for (const entry of projected) {
      const sessionID = entry?.payload?.type === 'session.status' ? entry.payload.properties?.sessionID : undefined;
      if (typeof sessionID !== 'string') continue;
      for (const touched of activeReconciliations) touched.add(sessionID);
    }
  };

  /**
   * The active snapshot with every session a live event moved since the fetch
   * began restated as its live status, so the reconciliation cannot undo it.
   */
  const withLiveStatuses = (target, body, retryBySession, touched) => {
    if (touched.size === 0) return body;
    const data = { ...(isRecord(body) && isRecord(body.data) ? body.data : {}) };
    for (const sessionID of touched) {
      const live = target.sessionStatus(sessionID);
      if (live?.type === 'idle') {
        delete data[sessionID];
        retryBySession.delete(sessionID);
        continue;
      }
      data[sessionID] = isRecord(data[sessionID]) ? data[sessionID] : {};
      retryBySession.set(sessionID, live?.type === 'retry' ? live : null);
    }
    return { ...(isRecord(body) ? body : {}), data };
  };

  /** Publishes projected v1 payloads (live or seeded) through replay and fan-out. */
  const publishProjected = (projected) => {
    for (const entry of projected) {
      if (!isRecord(entry) || !isRecord(entry.payload)) continue;
      const normalized = normalizeEvent({
        envelope: { directory: entry.directory, eventId: entry.eventId },
        payload: transformPayload(entry.payload),
      });
      rememberReplayEvent(normalized);
      notifyEvent(normalized);
    }
  };

  /** Asks connected clients to resync: a control entry, never buffered for replay. */
  const broadcastGap = (reason) => {
    notifyStatus({ type: 'gap', scope: 'global', reason });
    notifyEvent({
      envelope: { directory: 'global' },
      payload: createMessageStreamGapControlPayload({ scope: 'global', reason }),
      directory: 'global',
      eventId: undefined,
      synthetic: true,
      control: 'gap',
    });
  };

  /** Defect guard: 2.0.20 has no replay, so a repeated upstream id is never re-projected. */
  const seenUpstreamId = (eventId) => {
    if (!eventId) return false;
    if (dedupeIds.has(eventId)) return true;
    dedupeIds.add(eventId);
    dedupeOrder.push(eventId);
    if (dedupeOrder.length > GEN2_DEDUPE_WINDOW) dedupeIds.delete(dedupeOrder.shift());
    return false;
  };

  const publishV2UpstreamEvent = (event) => {
    if (!projector) return;
    const upstreamEventId = normalizeEventId(event?.envelope?.upstreamEventId);
    if (seenUpstreamId(upstreamEventId)) {
      diagnostic(GLOBAL_HUB_DIAGNOSTICS.duplicate, { eventId: upstreamEventId });
      return;
    }
    let projected;
    try {
      projected = projector.project(event.payload);
    } catch (error) {
      // The projector never throws by contract; a defect must not stop the stream.
      console.warn('Global message stream gen-2 projection failed:', error);
      return;
    }
    if (projected.length === 0) return;
    if (activeReconciliations.size > 0) noteLiveStatuses(projected);
    publishProjected(projected);
  };

  const readMessageRows = async (sessionID, limit, label) => {
    const body = await requestV2({
      label,
      path: `/api/session/${encode(sessionID)}/message`,
      query: { order: 'desc', limit },
      allowNotFound: true,
    });
    if (body === null) return null;
    // Newest first on the wire; the projector wants seq order.
    return unwrapPage(body).data.slice().reverse();
  };

  /** Runs one reseed request; returns the payloads to publish. */
  const executeReseed = async (target, request) => {
    switch (request.kind) {
      case 'gap':
        broadcastGap(request.reason ?? 'projector');
        return [];
      case 'session': {
        const body = await requestV2({
          label: 'hub.reseed.session',
          path: `/api/session/${encode(request.sessionID)}`,
          allowNotFound: true,
        });
        return target.applySession(request.sessionID, body === null ? null : unwrapData(body), request);
      }
      case 'history': {
        const rows = await readMessageRows(request.sessionID, GEN2_HISTORY_SEED_LIMIT, 'hub.reseed.history');
        return target.applyHistory(request.sessionID, rows ?? [], request);
      }
      case 'message': {
        const body = await requestV2({
          label: 'hub.reseed.message',
          path: `/api/session/${encode(request.sessionID)}/message/${encode(request.messageID)}`,
          allowNotFound: true,
        });
        return target.applyMessage(request.sessionID, body === null ? null : unwrapData(body), request);
      }
      case 'active': {
        const touched = new Set();
        activeReconciliations.add(touched);
        try {
          const body = await requestV2({ label: 'hub.reseed.active', path: '/api/session/active' });
          const retryBySession = new Map();
          const sessionIDs = [...activeSessionIDs(body)].slice(0, GEN2_ACTIVE_RETRY_LOOKUP_LIMIT);
          await Promise.all(sessionIDs.map(async (sessionID) => {
            const rows = await readMessageRows(sessionID, GEN2_ACTIVE_RETRY_ROWS, 'hub.reseed.active').catch(() => null);
            // A failed lookup leaves the session busy (B.3).
            if (rows) retryBySession.set(sessionID, retryStatusFromMessages(rows));
          }));
          if (target !== projector) return [];
          return target.applyActive(withLiveStatuses(target, body, retryBySession, touched), retryBySession, request);
        } finally {
          activeReconciliations.delete(touched);
        }
      }
      case 'form-cancel':
        await requestV2({
          label: 'hub.reseed.form-cancel',
          method: 'DELETE',
          path: `/api/session/${encode(request.sessionID)}/form/${encode(request.formID)}`,
          allowNotFound: true,
        });
        return [];
      default:
        return [];
    }
  };

  const runReseed = async (target, request) => {
    if (target !== projector || !target.beginReseed(request)) return;
    if (!requestV2 && request.kind !== 'gap') {
      if (!reseedUnavailableNoted) {
        reseedUnavailableNoted = true;
        diagnostic(GLOBAL_HUB_DIAGNOSTICS.reseedUnavailable, { kind: request.kind });
      }
      target.reseedFailed(request);
      return;
    }
    let projected;
    try {
      projected = await executeReseed(target, request);
    } catch (error) {
      diagnostic(GLOBAL_HUB_DIAGNOSTICS.reseedFailed, {
        kind: request.kind,
        reason: request.reason,
        message: error instanceof Error ? error.message : String(error),
      });
      target.reseedFailed(request);
      return;
    }
    // A projector replaced meanwhile owns none of this state.
    if (target !== projector || !Array.isArray(projected) || projected.length === 0) return;
    publishProjected(projected);
  };

  const reseedRunner = createBoundedTaskRunner({
    concurrency: GEN2_RESEED_CONCURRENCY,
    maxQueued: GEN2_RESEED_MAX_QUEUED,
    onError: (error) => {
      console.warn('Global message stream gen-2 reseed failed:', error);
    },
    onDrop: () => {
      // The dropped request is unknown, so recover the way a reconnect does:
      // every session goes cold (its flags reset) and clients resync.
      if (reseedOverflowNoted) return;
      reseedOverflowNoted = true;
      diagnostic(GLOBAL_HUB_DIAGNOSTICS.reseedOverflow, {});
      projector?.handleGap('reseed_overflow');
      broadcastGap('reseed_overflow');
    },
  });

  const drainReseeds = () => {
    drainScheduled = false;
    const target = projector;
    if (!target) return;
    const requests = target.takeReseedRequests();
    if (requests.length === 0) return;
    // A new overflow episode starts once the backlog has drained.
    if (reseedRunner.stats().queued === 0) reseedOverflowNoted = false;
    for (const request of requests) {
      reseedRunner.run(() => runReseed(target, request));
    }
  };

  // Never awaited by the projector; coalesces the requests of one event.
  const scheduleReseedDrain = () => {
    if (drainScheduled) return;
    drainScheduled = true;
    queueMicrotask(drainReseeds);
  };

  const ensureProjector = () => {
    if (projector) return projector;
    projector = openCodeClient.events.createProjector({
      onReseedRequested: scheduleReseedDrain,
      ...(typeof recordDiagnostic === 'function' ? { recordDiagnostic } : {}),
    });
    return projector;
  };

  /** Every gen-2 connection is a gap (B.7). */
  const handleV2Connect = (reconnect) => {
    if (reconnect) {
      replayEpoch += 1;
    }
    const target = ensureProjector();
    target?.handleGap(reconnect ? 'upstream_reconnect' : 'cold_start');
    if (reconnect) {
      broadcastGap('upstream_reconnect');
    }
  };

  const parseUpstreamBlock = (block) => toUpstreamV2SseEvent(parseV2EventBlock(block));

  const resolveStallTimeoutMs = () => (
    typeof generation2StallTimeoutMs === 'function' ? generation2StallTimeoutMs() : generation2StallTimeoutMs
  );

  const buildUpstreamUrl = () => {
    buildUrlFailed = false;
    try {
      connectionGeneration = resolveGeneration();
      return new URL(openCodeClient.events.url());
    } catch {
      buildUrlFailed = true;
      throw new Error('OpenCode service unavailable');
    }
  };

  const start = () => {
    if (reader) {
      return;
    }

    controller = new AbortController();
    reader = createUpstreamSseReader({
      signal: controller.signal,
      stallTimeoutMs: resolveStallTimeoutMs,
      reconnectDelayMs: upstreamReconnectDelayMs,
      fetchImpl,
      buildUrl: buildUpstreamUrl,
      parseBlock: parseUpstreamBlock,
      resumeWithLastEventId: false,
      getHeaders: getOpenCodeAuthHeaders,
      onConnect() {
        connected = true;
        const wasReady = everConnected;
        everConnected = true;
        upstreamConnections += 1;
        handleV2Connect(upstreamConnections > 1);
        notifyStatus({ type: 'connect', wasReady });
      },
      onDisconnect({ reason }) {
        connected = false;
        notifyStatus({ type: 'disconnect', reason });
      },
      onEvent: publishV2UpstreamEvent,
      onError(error) {
        if (controller?.signal.aborted) {
          return;
        }

        notifyStatus({
          type: everConnected ? 'error' : 'initial-error',
          error,
          buildUrlFailed,
        });
      },
    });

    void reader.start();
  };

  const stop = () => {
    connected = false;
    reader?.stop();
    if (controller && !controller.signal.aborted) {
      controller.abort();
    }
    reader = null;
    controller = null;
    everConnected = false;
    buildUrlFailed = false;
    // The replay buffer intentionally survives stop(): the hub stops whenever
    // the last client disconnects, and a reconnecting client relies on replay
    // to bridge exactly that window. The byte budget above is the memory bound.
  };

  return {
    start,
    stop,
    isConnected() {
      return connected;
    },
    hasConnected() {
      return everConnected;
    },
    publishSyntheticEvent({ payload, directory, eventId } = {}) {
      if (!payload || typeof payload !== 'object') {
        return null;
      }
      syntheticEventSequence += 1;
      const normalizedDirectory =
        typeof directory === 'string' && directory.length > 0
          ? directory
          : typeof payload?.properties?.directory === 'string' && payload.properties.directory.length > 0
            ? payload.properties.directory
            : 'global';
      const normalizedEventId = typeof eventId === 'string' && eventId.length > 0
        ? eventId
        : `synthetic-${bootID}-${syntheticEventSequence}`;
      const normalized = {
        ...normalizeEvent({
          envelope: {
            directory: normalizedDirectory,
            eventId: normalizedEventId,
          },
          payload,
        }),
        synthetic: true,
      };
      rememberReplayEvent(normalized);
      notifyEvent(normalized);
      return normalized;
    },
    subscribeEvent(subscriber) {
      eventSubscribers.add(subscriber);
      return () => {
        eventSubscribers.delete(subscriber);
      };
    },
    subscribeStatus(subscriber) {
      statusSubscribers.add(subscriber);
      return () => {
        statusSubscribers.delete(subscriber);
      };
    },
    replayAfter(eventId, { directory, unanchored = false } = {}) {
      if (!eventId && unanchored !== true) {
        return { events: [], gap: false };
      }

      const filter = (entries) => (
        typeof directory === 'string' && directory.length > 0
          ? entries.filter((entry) => matchesMessageStreamDirectory(entry, directory))
          : entries
      );
      // A previously ready browser can lose its first event before learning a
      // cursor. Replay the same bounded buffer and require canonical resync;
      // an initial cursor-free subscription still starts without history.
      if (!eventId) return { events: filter(replay.slice()), gap: true };
      const index = replay.findIndex((entry) => entry.eventId === eventId);
      if (index !== -1) {
        // Gen 2: an id from before the latest upstream reconnect precedes a gap.
        return { events: filter(replay.slice(index + 1)), gap: replayEpochs[index] < replayEpoch };
      }
      // Client's lastEventId is not in the current buffer. Either it predates
      // the (bounded) replay window or it is from a previous OpenCode process.
      // Either way, we cannot prove gap-free replay — surface the gap so the
      // bridge can ask the client to resync. Hand back the full buffer so the
      // client still gets *some* recent context to render against.
      return { events: filter(replay.slice()), gap: true };
    },
    /**
     * Subscribes to the entries of one directory (DESIGN.md B.7): the gen-2
     * directory streams are served from this hub instead of an upstream
     * per-directory stream.
     * @param {string | null | undefined} directory
     * @param {(entry: unknown) => unknown} subscriber
     */
    subscribeDirectoryEvent(directory, subscriber) {
      const filtered = (entry) => (matchesMessageStreamDirectory(entry, directory) ? subscriber(entry) : undefined);
      eventSubscribers.add(filtered);
      return () => {
        eventSubscribers.delete(filtered);
      };
    },
    /** The generation the next connection uses; throws when the runtime generation is unknown. */
    resolveGeneration,
    /** Generation of the current (or last) upstream connection. */
    connectionGeneration() {
      return connectionGeneration;
    },
    /** The live native projector (null before connection), for slug-free client lookups. */
    getProjector() {
      return projector;
    },
    reseedStats() {
      return reseedRunner.stats();
    },
  };
}
