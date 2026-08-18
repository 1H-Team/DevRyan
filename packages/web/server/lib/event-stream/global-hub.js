import { createUpstreamSseReader } from './upstream-reader.js';

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

export function createGlobalMessageStreamHub({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  fetchImpl = fetch,
  upstreamStallTimeoutMs,
  upstreamReconnectDelayMs,
  replayLimit = MESSAGE_STREAM_GLOBAL_REPLAY_LIMIT,
  replayByteBudget = MESSAGE_STREAM_GLOBAL_REPLAY_BYTE_BUDGET,
  transformEventPayload,
}) {
  const eventSubscribers = new Set();
  const statusSubscribers = new Set();
  const replay = [];
  const replaySizes = [];
  const replayEventIds = new Set();
  let replayTotalBytes = 0;
  let syntheticEventSequence = 0;

  let controller = null;
  let reader = null;
  let connected = false;
  let everConnected = false;
  let buildUrlFailed = false;

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

  const approxEventSizeBytes = (normalized) => {
    try {
      return JSON.stringify(normalized).length;
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
    replayEventIds.add(normalized.eventId);
    replayTotalBytes += size;
    // Always keep at least the newest event, even if it alone busts the budget.
    while (
      replay.length > 1 &&
      (replay.length > replayLimit || replayTotalBytes > replayByteBudget)
    ) {
      const removed = replay.shift();
      if (removed?.eventId) replayEventIds.delete(removed.eventId);
      replayTotalBytes -= replaySizes.shift() ?? 0;
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

  const normalizeEvent = ({ envelope, payload }) => {
    const directory =
      typeof envelope?.directory === 'string' && envelope.directory.length > 0 ? envelope.directory : 'global';
    const eventId = normalizeEventId(envelope?.eventId);
    return {
      envelope,
      payload,
      directory,
      eventId,
    };
  };

  const start = () => {
    if (reader) {
      return;
    }

    controller = new AbortController();
    reader = createUpstreamSseReader({
      signal: controller.signal,
      stallTimeoutMs: upstreamStallTimeoutMs,
      reconnectDelayMs: upstreamReconnectDelayMs,
      fetchImpl,
      buildUrl: () => {
        buildUrlFailed = false;
        try {
          return new URL(buildOpenCodeUrl('/global/event', ''));
        } catch {
          buildUrlFailed = true;
          throw new Error('OpenCode service unavailable');
        }
      },
      getHeaders: getOpenCodeAuthHeaders,
      onConnect() {
        connected = true;
        const wasReady = everConnected;
        everConnected = true;
        notifyStatus({ type: 'connect', wasReady });
      },
      onDisconnect({ reason }) {
        connected = false;
        notifyStatus({ type: 'disconnect', reason });
      },
      onEvent(event) {
        const upstreamEventId = normalizeEventId(event?.envelope?.eventId);
        // The upstream can replay the last event after reconnect. Drop it
        // before enrichment or subscriber fanout so every canonical side
        // effect observes a non-empty event ID at most once per replay window.
        if (upstreamEventId && replayEventIds.has(upstreamEventId)) return;

        let next = event;
        // Applied before rememberReplayEvent so reconnect replays carry the
        // same enriched payloads as the live stream.
        if (typeof transformEventPayload === 'function') {
          try {
            const payload = transformEventPayload(event.payload);
            if (payload && payload !== event.payload) {
              next = { ...event, payload };
            }
          } catch (error) {
            console.warn('Global message stream payload transform failed:', error);
          }
        }
        const normalized = normalizeEvent(next);
        rememberReplayEvent(normalized);
        notifyEvent(normalized);
      },
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
        : `synthetic-${Date.now()}-${syntheticEventSequence}`;
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
    replayAfter(eventId) {
      if (!eventId) {
        return { events: [], gap: false };
      }

      const index = replay.findIndex((entry) => entry.eventId === eventId);
      if (index !== -1) {
        return { events: replay.slice(index + 1), gap: false };
      }
      // Client's lastEventId is not in the current buffer. Either it predates
      // the (bounded) replay window or it is from a previous OpenCode process.
      // Either way, we cannot prove gap-free replay — surface the gap so the
      // bridge can ask the client to resync. Hand back the full buffer so the
      // client still gets *some* recent context to render against.
      return { events: replay.slice(), gap: true };
    },
  };
}
