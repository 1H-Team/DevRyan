import { randomUUID } from 'node:crypto';

const MAX_EVENT_BYTES = 256 * 1024;

export class BotEventStreamError extends Error {
  constructor(message, code = 'bot_event_invalid', statusCode = 400) {
    super(message);
    this.name = 'BotEventStreamError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (message, code, statusCode) => {
  throw new BotEventStreamError(message, code, statusCode);
};

const normalizeKind = (value) => {
  const kind = typeof value === 'string' ? value.trim() : '';
  if (!/^[a-z][a-z0-9_.-]{0,119}$/.test(kind)) {
    fail('Bot event kind is invalid');
  }
  return kind;
};

const clonePayload = (value) => {
  let encoded;
  try {
    encoded = JSON.stringify(value ?? {});
  } catch {
    fail('Bot event payload is invalid');
  }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_EVENT_BYTES) {
    fail('Bot event payload is too large', 'bot_event_too_large', 413);
  }
  return JSON.parse(encoded);
};

const sseFrame = (event) => (
  `id: ${event.id}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`
);

export function createBotEventStream({
  loadSnapshot = async () => ({}),
  epoch = randomUUID(),
  heartbeatMs = 25_000,
} = {}) {
  if (typeof loadSnapshot !== 'function' || typeof epoch !== 'string' || !epoch
    || !Number.isFinite(heartbeatMs) || heartbeatMs < 1_000) {
    throw new TypeError('Bot event stream is misconfigured');
  }
  const subscribers = new Set();
  const snapshotSources = new Map([['base', loadSnapshot]]);
  let sequence = 0;
  let shutdown = false;

  const loadCombinedSnapshot = async (principal) => {
    const combined = {};
    for (const loader of snapshotSources.values()) {
      const projection = await loader(principal);
      if (!projection || typeof projection !== 'object' || Array.isArray(projection)) {
        fail('Bot event snapshot is invalid', 'bot_event_snapshot_invalid', 500);
      }
      for (const [key, value] of Object.entries(projection)) {
        if (Object.hasOwn(combined, key)) {
          fail('Bot event snapshot projection conflicts', 'bot_event_snapshot_invalid', 500);
        }
        combined[key] = value;
      }
    }
    return combined;
  };

  const deliver = async (subscriber, event) => {
    if (subscriber.closed) return;
    if (!subscriber.ready) {
      subscriber.pending.push(event);
      return;
    }
    await subscriber.send(event);
  };

  const closeSubscriber = (subscriber) => {
    if (subscriber.closed) return;
    subscriber.closed = true;
    subscriber.pending.length = 0;
    subscribers.delete(subscriber);
  };

  const open = async ({ principal, send } = {}) => {
    if (shutdown) fail('Bot event stream has shut down', 'bots_unavailable', 503);
    if (!principal?.id || typeof send !== 'function') {
      fail('Bot event subscription requires authentication', 'bot_authentication_required', 401);
    }
    const subscriber = {
      principal,
      send,
      ready: false,
      closed: false,
      pending: [],
    };
    subscribers.add(subscriber);
    try {
      const snapshot = clonePayload(await loadCombinedSnapshot(principal));
      if (subscriber.closed) return () => {};
      await send(Object.freeze({
        id: `${epoch}:0`,
        sequence: 0,
        kind: 'snapshot',
        payload: snapshot,
      }));
      subscriber.ready = true;
      for (const event of subscriber.pending.splice(0)) await deliver(subscriber, event);
    } catch (error) {
      closeSubscriber(subscriber);
      throw error;
    }
    return () => closeSubscriber(subscriber);
  };

  return Object.freeze({
    open,

    addSnapshotSource(name, loader) {
      const normalizedName = typeof name === 'string' ? name.trim() : '';
      if (!/^[a-z][a-z0-9_.-]{0,119}$/.test(normalizedName) || normalizedName === 'base'
        || typeof loader !== 'function') {
        fail('Bot event snapshot source is invalid', 'bot_event_snapshot_invalid', 500);
      }
      if (snapshotSources.has(normalizedName)) {
        fail('Bot event snapshot source already exists', 'bot_event_snapshot_invalid', 500);
      }
      snapshotSources.set(normalizedName, loader);
      return () => snapshotSources.delete(normalizedName);
    },

    async publish({
      kind,
      botId = null,
      channelId = null,
      audienceUserIds,
      payload = {},
    } = {}) {
      if (shutdown) return Object.freeze({ sequence, delivered: 0 });
      const normalizedKind = normalizeKind(kind);
      if (!Array.isArray(audienceUserIds) || audienceUserIds.some((id) => typeof id !== 'string')) {
        fail('Bot event audience is invalid');
      }
      const audience = new Set(audienceUserIds);
      sequence += 1;
      let event = null;
      let delivered = 0;
      for (const subscriber of subscribers) {
        if (!audience.has(subscriber.principal.id)) continue;
        event ||= Object.freeze({
          id: `${epoch}:${sequence}`,
          sequence,
          kind: normalizedKind,
          ...(botId ? { botId } : {}),
          ...(channelId ? { channelId } : {}),
          payload: clonePayload(payload),
        });
        await deliver(subscriber, event);
        delivered += 1;
      }
      return Object.freeze({ sequence, delivered });
    },

    async writeSse({ principal, request, response } = {}) {
      if (!response || typeof response.write !== 'function' || typeof response.setHeader !== 'function') {
        throw new TypeError('Bot SSE response is invalid');
      }
      const buffered = [];
      let connected = false;
      const close = await open({
        principal,
        send: async (event) => {
          if (!connected) {
            buffered.push(event);
          } else if (!response.writableEnded && !response.destroyed) {
            response.write(sseFrame(event));
          }
        },
      });
      response.status?.(200);
      response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      response.setHeader('Cache-Control', 'no-cache, no-transform');
      response.setHeader('Connection', 'keep-alive');
      response.setHeader('X-Accel-Buffering', 'no');
      response.flushHeaders?.();
      connected = true;
      for (const event of buffered) response.write(sseFrame(event));
      const heartbeat = setInterval(() => {
        if (!response.writableEnded && !response.destroyed) response.write(': heartbeat\n\n');
      }, heartbeatMs);
      heartbeat.unref?.();
      const cleanup = () => {
        clearInterval(heartbeat);
        close();
      };
      request?.once?.('close', cleanup);
      response.once?.('close', cleanup);
      return cleanup;
    },

    getSequence: () => sequence,
    getSubscriberCount: () => subscribers.size,

    shutdown() {
      shutdown = true;
      snapshotSources.clear();
      for (const subscriber of [...subscribers]) closeSubscriber(subscriber);
    },
  });
}
