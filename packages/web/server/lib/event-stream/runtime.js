import { WebSocketServer } from 'ws';

import { parseRequestPathname } from '../terminal/index.js';
import {
  MESSAGE_STREAM_DIRECTORY_WS_PATH,
  MESSAGE_STREAM_GLOBAL_WS_PATH,
  MESSAGE_STREAM_WS_HEARTBEAT_INTERVAL_MS,
  sendMessageStreamWsEvent,
} from './protocol.js';
import { createGlobalMessageStreamHub } from './global-hub.js';
import { stripEventDiffContent } from '../opencode/diff-summary.js';
import { createGlobalMessageStreamWsBridge } from './global-ws-bridge.js';
import { createBoundedEventQueue } from './bounded-event-queue.js';
import { acceptDirectoryMessageStreamWsConnection } from './directory-ws-bridge.js';
import {
  DEFAULT_UPSTREAM_RECONNECT_DELAY_MS,
  DEFAULT_UPSTREAM_STALL_TIMEOUT_MS,
} from './upstream-reader.js';

function getRequestLastEventId(req) {
  const header = req?.headers?.['last-event-id'];
  if (typeof header === 'string' && header.trim().length > 0) {
    return header.trim();
  }
  if (Array.isArray(header)) {
    const first = header.find((entry) => typeof entry === 'string' && entry.trim().length > 0);
    if (first) return first.trim();
  }
  const queryValue = req?.query?.lastEventId;
  if (typeof queryValue === 'string' && queryValue.trim().length > 0) {
    return queryValue.trim();
  }
  return '';
}

function serializeMessageStreamSseEvent({ payload, directory, eventId }) {
  const lines = [];
  if (typeof eventId === 'string' && eventId.length > 0) {
    lines.push(`id: ${eventId}`);
  }
  lines.push(`data: ${JSON.stringify({
    ...(typeof directory === 'string' && directory.length > 0 ? { directory } : {}),
    payload,
  })}`);
  return `${lines.join('\n')}\n\n`;
}

export function createGlobalMessageStreamSseHandler({
  globalHub,
  heartbeatIntervalMs = MESSAGE_STREAM_WS_HEARTBEAT_INTERVAL_MS,
  eventFilter = null,
  registerConnection = null,
}) {
  return async (req, res) => {
    if (!globalHub || typeof globalHub.subscribeEvent !== 'function') {
      res.status?.(503);
      res.end?.(JSON.stringify({ error: 'Global message stream is unavailable' }));
      return;
    }

    res.status?.(200);
    res.setHeader?.('Content-Type', 'text/event-stream');
    res.setHeader?.('Cache-Control', 'no-cache');
    res.setHeader?.('Connection', 'keep-alive');
    res.setHeader?.('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    if (res.socket && typeof res.socket.setNoDelay === 'function') {
      res.socket.setNoDelay(true);
    }

    // Dedupe is only needed while the one-shot replay overlaps the live
    // subscription; afterwards the set would grow one id per event for the
    // connection's lifetime, so tracking stops once replay completes.
    let replayPhase = true;
    const deliveredEventIds = new Set();
    let closed = false;
    let heartbeat = null;
    let unsubscribe = () => {};
    let unregisterConnection = () => {};
    // A slow or suspended client otherwise makes Node buffer events without
    // bound in the socket write queue. Past this ceiling, drop the connection —
    // the client reconnects with Last-Event-ID and replays the gap.
    const SSE_MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
    const writeEntry = async (entry, signal) => {
      if (signal.aborted || res.writableEnded || res.destroyed) {
        return false;
      }
      if (eventFilter && !await eventFilter(req.principal, entry)) {
        return true;
      }
      if (signal.aborted || res.writableEnded || res.destroyed) return false;
      if (replayPhase && typeof entry?.eventId === 'string' && entry.eventId.length > 0) {
        deliveredEventIds.add(entry.eventId);
      }
      res.write(serializeMessageStreamSseEvent(entry));
      if ((res.socket?.writableLength ?? 0) > SSE_MAX_BUFFERED_BYTES) {
        res.destroy?.();
        return false;
      }
      return true;
    };

    const eventQueue = createBoundedEventQueue({
      deliver: writeEntry,
      getBufferedBytes: () => res.socket?.writableLength ?? 0,
      onClose: reason => {
        cleanup();
        if (reason !== 'cancelled') res.destroy?.();
      },
    });
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      eventQueue.close();
      deliveredEventIds.clear();
      unsubscribe();
      unregisterConnection();
      req.off?.('close', cleanup);
      req.off?.('error', cleanup);
      res.off?.('close', cleanup);
    };
    // Install cancellation before replay: authorization can remain pending while
    // the browser disconnects, or the principal's access is revoked.
    req.on?.('close', cleanup);
    req.on?.('error', cleanup);
    res.on?.('close', cleanup);
    if (typeof registerConnection === 'function') {
      unregisterConnection = registerConnection(req.principal, () => { cleanup(); res.destroy?.(); });
      if (closed) { unregisterConnection(); return; }
    }
    unsubscribe = globalHub.subscribeEvent((entry) => {
      void eventQueue.enqueue(entry);
    });
    if (closed) { unsubscribe(); return; }
    const requestedLastEventId = getRequestLastEventId(req);
    const { events, gap } = typeof globalHub.replayAfter === 'function'
      ? globalHub.replayAfter(requestedLastEventId)
      : { events: [] };
    if (gap && requestedLastEventId && req.headers?.['x-devryan-replay-gap'] === '1') {
      // No id line: this control frame must not advance the replay cursor.
      res.write('event: devryan.replay-gap\ndata: {"replayGap":{"scope":"global"}}\n\n');
    }
    let replayDone = Promise.resolve(true);
    // Admit the bounded replay snapshot before yielding to live delivery. Awaiting
    // each filter here allows newer live events to overtake remaining replay.
    for (const entry of events) {
      if (closed) return;
      if (entry?.eventId && deliveredEventIds.has(entry.eventId)) {
        continue;
      }
      replayDone = eventQueue.enqueue(entry);
    }
    if (!await replayDone || closed) return;
    replayPhase = false;
    deliveredEventIds.clear();

    globalHub.start?.();

    heartbeat = setInterval(() => {
      if (res.writableEnded || res.destroyed) {
        return;
      }
      res.write(':heartbeat\n\n');
    }, heartbeatIntervalMs);
    heartbeat.unref?.();

  };
}

export function createGlobalUiEventBroadcaster({
  sseClients,
  wsClients,
  writeSseEvent,
  globalEventHub = null,
  registerRetentionConnection = null,
}) {
  const filteredQueues = new WeakMap();
  return (payload, options = {}) => {
    const directory = typeof options.directory === 'string' && options.directory.length > 0 ? options.directory : 'global';
    const eventId = typeof options.eventId === 'string' && options.eventId.length > 0 ? options.eventId : undefined;
    const publishedToGlobalHub = Boolean(globalEventHub?.publishSyntheticEvent?.({
      payload,
      directory,
      eventId,
    }));
    const hasSseClients = sseClients.size > 0;
    const hasWsClients = !publishedToGlobalHub && wsClients.size > 0;
    if (!hasSseClients && !hasWsClients && !publishedToGlobalHub) {
      return;
    }

    if (hasSseClients) {
      for (const res of sseClients) {
        const filter = res.devRyanEventFilter;
        if (typeof filter === 'function') {
          let queue = filteredQueues.get(res);
          if (!queue) {
            const cancel = () => queue.close();
            queue = createBoundedEventQueue({
              getBufferedBytes: () => res.socket?.writableLength ?? 0,
              deliver: async (entry, signal) => {
                if (!await res.devRyanEventFilter(res.devRyanPrincipal, entry)) return true;
                if (signal.aborted || res.destroyed || res.writableEnded || !sseClients.has(res)) return false;
                writeSseEvent(res, entry.payload);
                return true;
              },
              onClose: reason => {
                filteredQueues.delete(res);
                sseClients.delete(res);
                res.off?.('close', cancel);
                if (reason !== 'cancelled') res.destroy?.();
              },
            });
            filteredQueues.set(res, queue);
            res.once?.('close', cancel);
          }
          void queue.enqueue({ payload, directory, eventId });
          continue;
        }
        try {
          writeSseEvent(res, payload);
        } catch {
        }
      }
    }

    if (hasWsClients) {
      for (const socket of Array.from(wsClients)) {
        const sent = sendMessageStreamWsEvent(socket, payload, {
          directory,
          eventId,
        });
        if (!sent) {
          wsClients.delete(socket);
        }
      }
    }
  };
}

export function createMessageStreamWsRuntime({
  server,
  uiAuthController,
  isRequestOriginAllowed,
  rejectWebSocketUpgrade,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  wsClients,
  triggerHealthCheck,
  heartbeatIntervalMs = MESSAGE_STREAM_WS_HEARTBEAT_INTERVAL_MS,
  upstreamStallTimeoutMs = DEFAULT_UPSTREAM_STALL_TIMEOUT_MS,
  upstreamReconnectDelayMs = DEFAULT_UPSTREAM_RECONNECT_DELAY_MS,
  fetchImpl = fetch,
  globalEventHub = null,
  registerRetentionConnection = null,
  eventFilter = null,
}) {
  const wsServer = new WebSocketServer({
    noServer: true,
  });

  const ownsGlobalHub = !globalEventHub;
  const globalHub = globalEventHub ?? createGlobalMessageStreamHub({
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    fetchImpl,
    upstreamStallTimeoutMs,
    upstreamReconnectDelayMs,
    // Same trim the server-owned hub applies: diff patch bodies never fan out.
    transformEventPayload: stripEventDiffContent,
  });

  const globalBridge = createGlobalMessageStreamWsBridge({
    globalHub,
    ownsGlobalHub,
    wsClients,
    triggerHealthCheck,
    heartbeatIntervalMs,
    eventFilter,
  });

  wsServer.on('connection', (socket, req) => {
    const releaseRetention = registerRetentionConnection?.(req);
    if (releaseRetention) socket.once('close', releaseRetention);
    const unregisterConnection = typeof uiAuthController?.registerConnection === 'function'
      ? uiAuthController.registerConnection(req.principal, () => socket.close(4001, 'Access revoked'))
      : () => {};
    socket.once('close', unregisterConnection);
    const rawUrl = typeof req?.url === 'string' ? req.url : MESSAGE_STREAM_GLOBAL_WS_PATH;
    const pathname = parseRequestPathname(rawUrl);
    const requestUrl = new URL(rawUrl, 'http://127.0.0.1');
    const isGlobalStream = pathname === MESSAGE_STREAM_GLOBAL_WS_PATH;
    const requestedLastEventId = requestUrl.searchParams.get('lastEventId')?.trim() || '';
    const requestedDirectory = requestUrl.searchParams.get('directory')?.trim() || '';

    if (isGlobalStream) {
      globalBridge.accept(socket, {
        requestedLastEventId,
        principal: req.principal,
      });
      return;
    }

    acceptDirectoryMessageStreamWsConnection({
      socket,
      requestedLastEventId,
      requestedDirectory,
      buildOpenCodeUrl,
      getOpenCodeAuthHeaders,
      wsClients,
      triggerHealthCheck,
      heartbeatIntervalMs,
      upstreamStallTimeoutMs,
      upstreamReconnectDelayMs,
      fetchImpl,
      eventFilter,
      principal: req.principal,
    });
  });

  const upgradeHandler = (req, socket, head) => {
    const pathname = parseRequestPathname(req.url);
    if (pathname !== MESSAGE_STREAM_GLOBAL_WS_PATH && pathname !== MESSAGE_STREAM_DIRECTORY_WS_PATH) {
      return;
    }

    const handleUpgrade = async () => {
      try {
        if (req.tunnelAccessDenied || socket.destroyed || req.principal?.scope === 'tunnel-bot') return;
        if (typeof uiAuthController?.ensureSessionToken === 'function') {
          const sessionToken = await uiAuthController?.ensureSessionToken?.(req, null);
          if (!sessionToken) {
            rejectWebSocketUpgrade(socket, 401, 'UI authentication required');
            return;
          }

          const originAllowed = await isRequestOriginAllowed(req);
          if (!originAllowed) {
            rejectWebSocketUpgrade(socket, 403, 'Invalid origin');
            return;
          }
        }

        wsServer.handleUpgrade(req, socket, head, (ws) => {
          wsServer.emit('connection', ws, req);
        });
      } catch {
        rejectWebSocketUpgrade(socket, 500, 'Upgrade failed');
      }
    };

    void handleUpgrade();
  };

  server.on('upgrade', upgradeHandler);

  return {
    wsServer,
    async close() {
      server.off('upgrade', upgradeHandler);
      globalBridge.close();

      try {
        for (const client of wsServer.clients) {
          try {
            client.terminate();
          } catch {
          }
        }

        await new Promise((resolve) => {
          wsServer.close(() => resolve());
        });
      } catch {
      } finally {
        wsClients.clear();
      }
    },
  };
}
