import { serializeEventPayload } from './payload-serialization.js';

export const MESSAGE_STREAM_GLOBAL_WS_PATH = '/api/global/event/ws';
export const MESSAGE_STREAM_DIRECTORY_WS_PATH = '/api/event/ws';
export const MESSAGE_STREAM_WS_HEARTBEAT_INTERVAL_MS = 15 * 1000;
// Per-client pending outbound WS buffer, not a payload or stream-size limit.
// Healthy clients stay near 0; this only trips when a client is far behind.
// Raised from 4 MB → 16 MB to tolerate bursts during long agent sessions
// (e.g. ultrawork / multi-tool loops) where the browser briefly falls behind.
export const MESSAGE_STREAM_WS_MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

// Threshold at which we emit a backpressure warning frame so the client can
// proactively start shedding low-priority updates before the hard disconnect.
export const MESSAGE_STREAM_WS_BACKPRESSURE_WARN_BYTES = 12 * 1024 * 1024;

export function parseSseEventEnvelope(block) {
  if (!block || typeof block !== 'string') {
    return null;
  }

  const eventId = block
    .split('\n')
    .find((line) => line.startsWith('id:'))
    ?.slice(3)
    .trim() || null;

  const dataLines = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^\s/, ''));

  if (dataLines.length === 0) {
    return null;
  }

  const payloadText = dataLines.join('\n').trim();
  if (!payloadText) {
    return null;
  }

  try {
    const parsed = JSON.parse(payloadText);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.payload === 'object' &&
      parsed.payload !== null
    ) {
      return {
        eventId,
        directory: typeof parsed.directory === 'string' && parsed.directory.length > 0 ? parsed.directory : null,
        payload: parsed.payload,
      };
    }

    const directory =
      typeof parsed?.directory === 'string' && parsed.directory.length > 0
        ? parsed.directory
        : typeof parsed?.properties?.directory === 'string' && parsed.properties.directory.length > 0
          ? parsed.properties.directory
          : null;

    return {
      eventId,
      directory,
      payload: parsed,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Gen 2 (OpenCode 2.x, DESIGN.md B.7)
//
// The 2.0.20 `/api/event` stream is data-only: the event id lives in the JSON
// envelope, never on an `id:` line, and `: heartbeat` comment frames keep the
// connection alive. The block parser itself is the client's
// (`opencode-client/v2.js` `parseV2EventBlock`); these helpers adapt its result
// to the upstream reader and carry hub control frames to WebSocket clients.

/** Upstream-reader result for a comment-only block: resets nothing, emits nothing. */
export const MESSAGE_STREAM_UPSTREAM_KEEPALIVE = Object.freeze({ keepalive: true });

/**
 * Adapts a gen-2 parsed block (`{kind: 'comment'}` or
 * `{kind: 'event', eventId, directory, envelope}`) to the upstream reader's
 * shape. The reader sees no `eventId` (so it never resumes with
 * `Last-Event-ID`); the hub reads the upstream id from `upstreamEventId`.
 * @param {unknown} parsed
 * @returns {{ eventId: null, upstreamEventId: string | null, directory: string | null, payload: Record<string, unknown> }
 *   | typeof MESSAGE_STREAM_UPSTREAM_KEEPALIVE | null}
 */
export function toUpstreamV2SseEvent(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.kind === 'comment') return MESSAGE_STREAM_UPSTREAM_KEEPALIVE;
  if (parsed.kind !== 'event' || !parsed.envelope || typeof parsed.envelope !== 'object') return null;
  return {
    eventId: null,
    upstreamEventId: typeof parsed.eventId === 'string' && parsed.eventId.length > 0 ? parsed.eventId : null,
    directory: typeof parsed.directory === 'string' && parsed.directory.length > 0 ? parsed.directory : null,
    payload: parsed.envelope,
  };
}

/** Payload type of the hub's gap control entry (never an OpenCode event). */
export const MESSAGE_STREAM_GAP_CONTROL_TYPE = 'devryan.stream.gap';

// Control payloads are recognised by identity, so an upstream event can never
// forge one by its type string.
const controlPayloads = new WeakSet();

/**
 * A hub control payload asking WebSocket clients to resync: it serializes as
 * the top-level `{type: 'gap', scope, reason?}` frame the UI already handles.
 * @param {{ scope?: 'global', reason?: string }} [options]
 */
export function createMessageStreamGapControlPayload({ scope = 'global', reason } = {}) {
  const properties = typeof reason === 'string' && reason.length > 0 ? { scope, reason } : { scope };
  const payload = Object.freeze({ type: MESSAGE_STREAM_GAP_CONTROL_TYPE, properties: Object.freeze(properties) });
  controlPayloads.add(payload);
  return payload;
}

/** True for a payload made by {@link createMessageStreamGapControlPayload}. */
export function isMessageStreamControlPayload(payload) {
  return Boolean(payload) && typeof payload === 'object' && controlPayloads.has(payload);
}

/** The WebSocket frame of a control payload. */
function serializeMessageStreamControlFrame(payload) {
  return JSON.stringify({ type: 'gap', ...payload.properties });
}

export function sendMessageStreamWsFrame(socket, payload) {
  if (!socket || socket.readyState !== 1) {
    return false;
  }

  const buffered = typeof socket.bufferedAmount === 'number' ? socket.bufferedAmount : 0;

  if (buffered > MESSAGE_STREAM_WS_MAX_BUFFERED_BYTES) {
    try {
      socket.close(1013, 'Message stream client is too slow');
    } catch {
    }
    return false;
  }

  try {
    socket.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
    const bufferedAfter = typeof socket.bufferedAmount === 'number' ? socket.bufferedAmount : 0;
    if (bufferedAfter > MESSAGE_STREAM_WS_MAX_BUFFERED_BYTES) {
      try {
        socket.close(1013, 'Message stream client is too slow');
      } catch {
      }
      return false;
    }

    // Emit a one-shot backpressure warning when the buffer is building up.
    // The flag prevents sending repeated warnings that would themselves
    // increase the buffer.  It resets once the buffer drains below the
    // threshold.
    if (bufferedAfter > MESSAGE_STREAM_WS_BACKPRESSURE_WARN_BYTES) {
      if (!socket._ocBackpressureWarned) {
        socket._ocBackpressureWarned = true;
        try {
          socket.send(JSON.stringify({
            type: 'backpressure',
            bufferedBytes: bufferedAfter,
            maxBytes: MESSAGE_STREAM_WS_MAX_BUFFERED_BYTES,
          }));
        } catch {
          // Best-effort warning — ignore send failures.
        }
      }
    } else if (socket._ocBackpressureWarned) {
      socket._ocBackpressureWarned = false;
    }

    return true;
  } catch {
    return false;
  }
}

/** Byte-identical to `JSON.stringify({ type: 'event', payload, eventId?, directory? })`,
 * reusing the payload's shared serialization. A hub control payload
 * ({@link createMessageStreamGapControlPayload}) becomes its top-level frame. */
export function serializeMessageStreamWsEvent(payload, options = {}) {
  if (isMessageStreamControlPayload(payload)) return serializeMessageStreamControlFrame(payload);
  const eventId = typeof options.eventId === 'string' && options.eventId.length > 0 ? options.eventId : null;
  const directory = typeof options.directory === 'string' && options.directory.length > 0 ? options.directory : null;
  const payloadJson = serializeEventPayload(payload);
  if (payloadJson === undefined) {
    return JSON.stringify({ type: 'event', ...(eventId ? { eventId } : {}), ...(directory ? { directory } : {}) });
  }
  return `{"type":"event","payload":${payloadJson}${eventId ? `,"eventId":${JSON.stringify(eventId)}` : ''}${directory ? `,"directory":${JSON.stringify(directory)}` : ''}}`;
}

export function sendMessageStreamWsEvent(socket, payload, options = {}) {
  let frame;
  // An unserializable payload fails this delivery, as before, never the caller.
  try { frame = serializeMessageStreamWsEvent(payload, options); } catch { return false; }
  return sendMessageStreamWsFrame(socket, frame);
}
