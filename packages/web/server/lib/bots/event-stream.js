import { randomUUID } from 'node:crypto';
import {
  BOT_EVENT_MAX_BYTES, BOT_SNAPSHOT_FORMAT, BOT_SNAPSHOT_PART_KIND,
  encodeBotSnapshot, splitBotSnapshot,
} from '@openchamber/bots-runtime/event-snapshot.js';

import { createBotEventDiagnostics } from './event-diagnostics.js';
import { withBotAbort } from './request-lifetime.js';

const MAX_EVENT_BYTES = BOT_EVENT_MAX_BYTES;

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

const clonePayload = (value, onEncoded = () => {}) => {
  let encoded;
  try {
    encoded = JSON.stringify(value ?? {});
  } catch {
    fail('Bot event payload is invalid');
  }
  const bytes = Buffer.byteLength(encoded, 'utf8');
  onEncoded(bytes);
  if (bytes > MAX_EVENT_BYTES) {
    fail('Bot event payload is too large', 'bot_event_too_large', 413);
  }
  return JSON.parse(encoded);
};

const sseFrame = (event) => (
  `id: ${event.id}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`
);

const coalescingKey = (event) => {
  const message = event.payload?.message;
  const messageId = event.kind === 'message.streaming'
    ? event.payload?.messageId
    : event.kind === 'message.updated' && message?.role === 'assistant' && message.finalizedAt === null
      ? message.id : null;
  if (typeof messageId !== 'string' || !messageId) return null;
  return JSON.stringify([event.kind, event.botId, event.channelId, messageId]);
};

const writeFrame = async (response, frame, signal, timeoutMs) => {
  signal.throwIfAborted();
  if (response.writableEnded || response.destroyed) {
    fail('Bot event connection closed', 'bot_event_connection_closed', 499);
  }
  if (response.write(frame) !== false) return;
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      response.removeListener?.('drain', drained);
      response.removeListener?.('error', failed);
      signal.removeEventListener('abort', aborted);
    };
    const drained = () => { cleanup(); resolve(); };
    const failed = (error) => { cleanup(); reject(error); };
    const aborted = () => failed(signal.reason);
    const timer = setTimeout(() => failed(new BotEventStreamError(
      'Bot event consumer is too slow', 'bot_event_backpressure', 503,
    )), timeoutMs);
    timer.unref?.();
    response.once?.('drain', drained);
    response.once?.('error', failed);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
};

export function createBotEventStream({
  loadSnapshot = async () => ({}),
  filterSnapshot = async (_principal, snapshot) => snapshot,
  canDeliver = async () => true,
  epoch = randomUUID(),
  heartbeatMs = 25_000,
  snapshotTimeoutMs = 30_000,
  writeTimeoutMs = 15_000,
  maxPendingEvents = 256,
  maxPendingBytes = 4 * 1024 * 1024,
  recordDiagnostic = () => {},
} = {}) {
  if (typeof loadSnapshot !== 'function' || typeof filterSnapshot !== 'function'
    || typeof canDeliver !== 'function' || typeof epoch !== 'string' || !epoch
    || !Number.isFinite(heartbeatMs) || heartbeatMs < 1_000
    || !Number.isSafeInteger(snapshotTimeoutMs) || snapshotTimeoutMs < 1
    || !Number.isSafeInteger(writeTimeoutMs) || writeTimeoutMs < 1
    || !Number.isSafeInteger(maxPendingEvents) || maxPendingEvents < 1
    || !Number.isSafeInteger(maxPendingBytes) || maxPendingBytes < 1) {
    throw new TypeError('Bot event stream is misconfigured');
  }
  const subscribers = new Set();
  const snapshotSources = new Map([['base', loadSnapshot]]);
  const liveFrames = new WeakMap();
  let sequence = 0;
  let shutdown = false;

  const loadCombinedSnapshot = async (principal, diagnostics, signal) => {
    const combined = {};
    for (const [name, loader] of snapshotSources) {
      signal.throwIfAborted();
      diagnostics.stage(`snapshot.${name}`);
      const projection = await withBotAbort(loader(principal, { signal }), signal);
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
    diagnostics.stage('snapshot.filter');
    return withBotAbort(filterSnapshot(principal, combined), signal);
  };

  const releasePending = (subscriber, bytes) => {
    subscriber.pendingCount = Math.max(0, subscriber.pendingCount - 1);
    subscriber.pendingBytes = Math.max(0, subscriber.pendingBytes - bytes);
  };

  const closeSubscriber = (subscriber, reason = 'disposed', error = null) => {
    if (subscriber.closed) return;
    subscriber.closed = true;
    subscriber.pending.length = 0;
    subscriber.coalesced.clear();
    subscriber.pendingCount = 0;
    subscriber.pendingBytes = 0;
    subscribers.delete(subscriber);
    if (error) subscriber.diagnostics.failure(error, error.statusCode || 503);
    subscriber.controller.abort(error || new BotEventStreamError(
      'Bot event connection closed', 'bot_event_connection_closed', 499,
    ));
    subscriber.disposeSignal();
    subscriber.onClose(reason);
  };

  const sendEvent = async (subscriber, event) => {
    const signal = subscriber.controller.signal;
    signal.throwIfAborted();
    const timer = setTimeout(() => closeSubscriber(subscriber, 'backpressure', new BotEventStreamError(
      'Bot event consumer is too slow', 'bot_event_backpressure', 503,
    )), writeTimeoutMs);
    timer.unref?.();
    try { await withBotAbort(subscriber.send(event), signal); }
    finally { clearTimeout(timer); }
  };

  const removeSuperseded = (subscriber, key) => {
    if (!key) return;
    const entry = subscriber.coalesced.get(key);
    if (!entry) return;
    subscriber.coalesced.delete(key);
    const index = subscriber.pending.indexOf(entry);
    if (index < 0) return;
    subscriber.pending.splice(index, 1);
    releasePending(subscriber, entry.bytes);
  };

  // Only this pump waits on the socket. Publication acknowledges authorized
  // queue admission, so a slow viewer cannot hold up durable Bot operations.
  const pump = (subscriber) => {
    if (subscriber.closed || !subscriber.ready || subscriber.pumping) return;
    subscriber.pumping = true;
    void (async () => {
      while (!subscriber.closed && subscriber.pending.length > 0) {
        const entry = subscriber.pending.shift();
        if (entry.key) subscriber.coalesced.delete(entry.key);
        try { await sendEvent(subscriber, entry.event); }
        finally { releasePending(subscriber, entry.bytes); }
      }
    })().catch((error) => {
      closeSubscriber(subscriber, 'delivery_failed', subscriber.closed ? null : error);
    }).finally(() => {
      subscriber.pumping = false;
      if (subscriber.pending.length > 0) pump(subscriber);
    });
  };

  const open = async ({
    principal, send, signal, snapshotFormat = null, onClose = () => {},
    diagnostics = createBotEventDiagnostics(recordDiagnostic),
  } = {}) => {
    if (shutdown) fail('Bot event stream has shut down', 'bots_unavailable', 503);
    if (!principal?.id || typeof send !== 'function') {
      fail('Bot event subscription requires authentication', 'bot_authentication_required', 401);
    }
    signal?.throwIfAborted();
    const subscriber = {
      principal,
      send,
      ready: false,
      closed: false,
      pending: [],
      coalesced: new Map(),
      pumping: false,
      pendingCount: 0,
      pendingBytes: 0,
      delivery: Promise.resolve(),
      controller: new AbortController(),
      diagnostics,
      onClose,
      disposeSignal: () => {},
    };
    subscribers.add(subscriber);
    const aborted = () => closeSubscriber(subscriber, 'request_closed');
    let transferTimeout = null;
    signal?.addEventListener('abort', aborted, { once: true });
    const timeout = setTimeout(() => closeSubscriber(subscriber, 'snapshot_timeout', new BotEventStreamError(
      'Bot snapshot timed out', 'bot_event_snapshot_timeout', 503,
    )), snapshotTimeoutMs);
    timeout.unref?.();
    subscriber.disposeSignal = () => {
      clearTimeout(timeout);
      clearTimeout(transferTimeout);
      signal?.removeEventListener('abort', aborted);
    };
    const lifetime = subscriber.controller.signal;
    diagnostics.record('opening');
    try {
      const combined = await loadCombinedSnapshot(principal, diagnostics, lifetime);
      lifetime.throwIfAborted();
      diagnostics.stage('snapshot.serialize');
      const encoded = snapshotFormat === BOT_SNAPSHOT_FORMAT ? encodeBotSnapshot(combined) : null;
      let snapshotBytes = encoded?.bytes || 0;
      if (encoded) diagnostics.snapshot(encoded.bytes);
      const snapshot = encoded && encoded.bytes > MAX_EVENT_BYTES
        ? null
        : encoded ? JSON.parse(encoded.text) : clonePayload(combined, (bytes) => {
          snapshotBytes = bytes;
          diagnostics.snapshot(bytes);
        });
      clearTimeout(timeout);
      // Allow a modest 64 KiB/s transfer rate plus one blocked-write budget,
      // without allowing hundreds of individually slow parts to live for hours.
      transferTimeout = setTimeout(() => closeSubscriber(subscriber, 'snapshot_transfer_timeout', new BotEventStreamError(
        'Bot snapshot transfer timed out', 'bot_event_snapshot_transfer_timeout', 503,
      )), writeTimeoutMs + Math.ceil(snapshotBytes / (64 * 1024)) * 1_000);
      transferTimeout.unref?.();
      if (subscriber.closed) return () => {};
      diagnostics.stage('snapshot.send');
      if (encoded && snapshot === null) {
        for (const part of splitBotSnapshot(encoded.text)) {
          lifetime.throwIfAborted();
          await sendEvent(subscriber, Object.freeze({
            id: `${epoch}:0`, sequence: 0, kind: BOT_SNAPSHOT_PART_KIND, payload: part,
          }));
        }
      } else {
        await sendEvent(subscriber, Object.freeze({
          id: `${epoch}:0`, sequence: 0, kind: 'snapshot', payload: snapshot,
        }));
      }
      lifetime.throwIfAborted();
      clearTimeout(transferTimeout);
      subscriber.ready = true;
      pump(subscriber);
      diagnostics.stage('live');
      diagnostics.record('ready');
    } catch (error) {
      if (!subscriber.closed) diagnostics.failure(error, error?.statusCode || error?.status || 500);
      closeSubscriber(subscriber, 'failed');
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
      const eventSequence = ++sequence;
      let delivered = 0;
      const targets = [...subscribers].filter((subscriber) => audience.has(subscriber.principal.id));
      if (targets.length === 0) return Object.freeze({ sequence: eventSequence, delivered });
      const event = Object.freeze({
          id: `${epoch}:${eventSequence}`,
          sequence: eventSequence,
          kind: normalizedKind,
          ...(botId ? { botId } : {}),
          ...(channelId ? { channelId } : {}),
          payload: clonePayload(payload),
        });
      const frame = sseFrame(event);
      liveFrames.set(event, frame);
      const eventBytes = Buffer.byteLength(frame, 'utf8');
      const key = coalescingKey(event);
      // Reserve delivery order before awaiting the visibility lookup; concurrent
      // publishers must not duplicate sequence IDs or overtake earlier events.
      await Promise.all(targets.map((subscriber) => {
        removeSuperseded(subscriber, key);
        if (subscriber.pendingCount + 1 > maxPendingEvents || subscriber.pendingBytes + eventBytes > maxPendingBytes) {
          closeSubscriber(subscriber, 'backpressure', new BotEventStreamError(
            'Bot event consumer is too slow', 'bot_event_backpressure', 503,
          ));
          return undefined;
        }
        subscriber.pendingCount += 1;
        subscriber.pendingBytes += eventBytes;
        subscriber.delivery = subscriber.delivery.catch(() => undefined).then(async () => {
          let retained = false;
          try {
            if (subscriber.closed || !await withBotAbort(
              canDeliver(subscriber.principal, botId), subscriber.controller.signal,
            )) return;
            if (subscriber.closed) return;
            removeSuperseded(subscriber, key);
            const entry = { event, bytes: eventBytes, key };
            subscriber.pending.push(entry);
            if (key) subscriber.coalesced.set(key, entry);
            retained = true;
            pump(subscriber);
            delivered += 1;
          } catch (error) {
            closeSubscriber(subscriber, 'delivery_failed', subscriber.closed ? null : error);
          } finally {
            if (!retained) releasePending(subscriber, eventBytes);
          }
        });
        return subscriber.delivery;
      }));
      return Object.freeze({ sequence: eventSequence, delivered });
    },

    async writeSse({ principal, request, response, diagnostics = createBotEventDiagnostics(recordDiagnostic) } = {}) {
      if (!response || typeof response.write !== 'function' || typeof response.setHeader !== 'function') {
        throw new TypeError('Bot SSE response is invalid');
      }
      let connected = false;
      let close = null;
      let heartbeat = null;
      let cleaned = false;
      const controller = new AbortController();
      const cleanup = (reason = 'disposed') => {
        if (cleaned) return;
        cleaned = true;
        clearInterval(heartbeat);
        controller.abort(new BotEventStreamError('Bot event connection closed', 'bot_event_connection_closed', 499));
        close?.();
        request?.removeListener?.('aborted', requestAborted);
        request?.removeListener?.('close', requestClosed);
        response.removeListener?.('close', responseClosed);
        response.removeListener?.('finish', responseFinished);
        response.removeListener?.('error', responseFailed);
        if (connected && !response.writableEnded && !response.destroyed) {
          if (['backpressure', 'delivery_failed', 'snapshot_timeout', 'snapshot_transfer_timeout', 'response_error', 'heartbeat_failed', 'failed', 'shutdown'].includes(reason)
            && typeof response.destroy === 'function') response.destroy();
          else response.end?.();
        }
        diagnostics.record('closed', { reason, statusCode: response.statusCode || 200 });
      };
      const requestAborted = () => cleanup('request_closed');
      const requestClosed = () => { if (request?.aborted || response.destroyed) requestAborted(); };
      const responseClosed = () => cleanup('response_closed');
      const responseFinished = () => cleanup('response_finished');
      const responseFailed = (error) => { diagnostics.failure(error, 503); cleanup('response_error'); };
      request?.once?.('aborted', requestAborted);
      request?.once?.('close', requestClosed);
      response.once?.('close', responseClosed);
      response.once?.('finish', responseFinished);
      response.once?.('error', responseFailed);
      if (request?.aborted || response.destroyed || response.writableEnded) {
        cleanup('request_closed');
        return cleanup;
      }
      try {
        close = await open({
          principal, diagnostics, signal: controller.signal, onClose: cleanup,
          snapshotFormat: request?.query?.snapshot,
          send: async (event) => {
            if (cleaned) controller.signal.throwIfAborted();
            if (!connected) {
              response.status?.(200);
              response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
              response.setHeader('Cache-Control', 'no-cache, no-transform');
              response.setHeader('Connection', 'keep-alive');
              response.setHeader('X-Accel-Buffering', 'no');
              response.flushHeaders?.();
              connected = true;
              diagnostics.record('connected', { statusCode: 200 });
            }
            await writeFrame(response, liveFrames.get(event) || sseFrame(event), controller.signal, writeTimeoutMs);
          },
        });
        if (cleaned) { close(); return cleanup; }
        heartbeat = setInterval(() => {
          // Never pile heartbeat writes on a socket that is already backed up.
          if (response.writableNeedDrain || response.writableLength > 0) return;
          void writeFrame(response, ': heartbeat\n\n', controller.signal, writeTimeoutMs)
            .catch((error) => { diagnostics.failure(error, 503); cleanup('heartbeat_failed'); });
        }, heartbeatMs);
        heartbeat.unref?.();
      } catch (error) {
        const disconnected = cleaned && error?.code === 'bot_event_connection_closed';
        cleanup('failed');
        if (!disconnected) throw error;
      }
      return cleanup;
    },

    getSequence: () => sequence,
    getSubscriberCount: () => subscribers.size,

    shutdown() {
      shutdown = true;
      snapshotSources.clear();
      for (const subscriber of [...subscribers]) closeSubscriber(subscriber, 'shutdown');
    },
  });
}
