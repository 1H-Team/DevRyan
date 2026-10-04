import { createBoundedEventQueue } from '../../event-stream/bounded-event-queue.js';
import { matchesMessageStreamDirectory } from '../../event-stream/global-hub.js';
import { serializeEventPayload } from '../../event-stream/payload-serialization.js';
import { createMessageStreamGapControlPayload, isMessageStreamControlPayload } from '../../event-stream/protocol.js';
import { serializeMessageStreamSseEvent } from '../../event-stream/runtime.js';
import { resolveFacadeDirectory, sendOpenCodeFacadeError } from './facade-routes.js';

/** Gen-2 SSE is another subscriber of the one projected, authorized hub. */
export const createOpenCodeV2SseHandler = ({ globalMessageStreamHub, resolveRequestDirectory,
  eventFilter = null, registerConnection = null, heartbeatIntervalMs = 15_000 } = {}) => async (req, res) => {
  const hub = typeof globalMessageStreamHub === 'function' ? globalMessageStreamHub() : globalMessageStreamHub;
  if (!hub?.subscribeEvent || !hub?.replayAfter) {
    return res.status(503).json({ error: 'OpenCode event stream is unavailable', code: 'opencode_unavailable', retryable: true });
  }
  const global = (req.originalUrl || req.url).split('?')[0].replace(/\/$/, '') === '/api/global/event';
  const subscriptionReady = global && req.headers['x-devryan-subscription-ready'] === '1';
  if (subscriptionReady && (typeof hub.subscribeStatus !== 'function' || typeof hub.isConnected !== 'function')) {
    return res.status(503).json({ error: 'OpenCode event stream readiness is unavailable', code: 'opencode_unavailable', retryable: true });
  }
  if (req.principal?.scope === 'managed' && typeof eventFilter !== 'function') {
    return res.status(503).json({ error: 'OpenCode event authorization is unavailable', code: 'opencode_unavailable', retryable: true });
  }
  let directory;
  try { directory = global ? undefined : await resolveFacadeDirectory(req, resolveRequestDirectory); }
  catch (error) { return sendOpenCodeFacadeError(res, error); }
  // A directory stream must not silently become a cross-project subscription.
  if (!global && !directory) return res.status(400).json({ error: 'A directory is required', code: 'opencode_location_required' });
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.socket?.setNoDelay?.(true);
  let closed = false;
  let heartbeat;
  let unsubscribe = () => {};
  let unsubscribeStatus = () => {};
  let unregister = () => {};
  let replayAdmitted = false;
  let readySent = false;
  const sendSubscriptionReady = () => {
    if (closed || readySent || !replayAdmitted || !hub.isConnected() || res.destroyed || res.writableEnded) return;
    readySent = true;
    // Id-less transport control: no session activity or replay cursor is minted.
    res.write('event: devryan.subscription-ready\ndata: {"type":"ready","scope":"global"}\n\n');
  };
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    queue.close();
    unsubscribe();
    unsubscribeStatus();
    unregister();
    req.off('aborted', cleanup);
    res.off('close', cleanup);
    res.off('error', cleanup);
  };
  const queue = createBoundedEventQueue({
    getBufferedBytes: () => res.writableLength ?? res.socket?.writableLength ?? 0,
    deliver: async (entry, signal) => {
      if (closed || signal.aborted || res.destroyed) return false;
      if (!matchesMessageStreamDirectory(entry, directory)) return true;
      const control = isMessageStreamControlPayload(entry.payload);
      // Only locally branded controls bypass per-session filtering. They carry
      // no session data and must reach managed clients so they can resync.
      if (!control && eventFilter && !await eventFilter(req.principal, entry)) return true;
      if (closed || signal.aborted || res.destroyed) return false;
      const frame = control ? `event: devryan.replay-gap\ndata: ${JSON.stringify({ replayGap: entry.payload.properties })}\n\n`
        : global ? serializeMessageStreamSseEvent(entry)
        : `${entry.eventId ? `id: ${entry.eventId}\n` : ''}data: ${serializeEventPayload(entry.payload)}\n\n`;
      if (res.write(frame)) return true;
      // Serialize writes while Node applies backpressure, retaining the same
      // bounded queue used for asynchronous ownership filtering on WebSockets.
      await new Promise((resolve) => {
        const done = () => {
          res.off('drain', done); res.off('close', done); res.off('error', done);
          signal.removeEventListener('abort', done); resolve();
        };
        res.once('drain', done); res.once('close', done); res.once('error', done);
        signal.addEventListener('abort', done, { once: true });
        if (signal.aborted || res.destroyed) done();
      });
      return !closed && !signal.aborted && !res.destroyed;
    },
    onClose: (reason) => { cleanup(); if (reason !== 'cancelled') res.destroy(); },
  });
  req.once('aborted', cleanup);
  res.once('close', cleanup);
  res.once('error', cleanup);
  if (registerConnection) {
    unregister = registerConnection(req.principal, () => { cleanup(); res.destroy(); }) ?? (() => {});
    if (closed) { unregister(); return; }
  }
  if (subscriptionReady) {
    // Observe before checking or starting, including changes during replay auth.
    unsubscribeStatus = hub.subscribeStatus(status => {
      if (status.type === 'disconnect') { cleanup(); res.destroy(); }
      else if (status.type === 'connect') sendSubscriptionReady();
    });
    if (closed) { unsubscribeStatus(); return; }
  }
  const cursor = typeof req.headers['last-event-id'] === 'string' ? req.headers['last-event-id']
    : typeof req.query.lastEventId === 'string' ? req.query.lastEventId : '';
  // Read and enqueue replay before subscription can enqueue any newer event.
  // Both operations are synchronous; no event-loop gap occurs between them.
  const unanchored = !cursor && subscriptionReady && req.headers['x-devryan-replay-unanchored'] === '1';
  const replay = hub.replayAfter(cursor, { directory, ...(unanchored ? { unanchored: true } : {}) });
  let replayDone = Promise.resolve(true);
  if ((cursor || unanchored) && replay.gap) {
    replayDone = queue.enqueue({ directory: directory ?? 'global', payload: createMessageStreamGapControlPayload({ scope: global ? 'global' : 'directory' }) });
  }
  for (const entry of replay.events) replayDone = queue.enqueue(entry);
  if (closed) return;
  unsubscribe = hub.subscribeEvent((entry) => { void queue.enqueue(entry); });
  if (closed) { unsubscribe(); return; }
  if (subscriptionReady) {
    // Admit the whole bounded snapshot synchronously, then await its auth/drain.
    // New live entries share the same queue and cannot overtake replay.
    if (!await replayDone || closed) return;
    replayAdmitted = true;
    sendSubscriptionReady();
  }
  hub.start?.();
  if (closed) return;
  heartbeat = setInterval(() => {
    if (!closed && !res.writableNeedDrain) res.write(':heartbeat\n\n');
  }, heartbeatIntervalMs);
  heartbeat.unref?.();
};
