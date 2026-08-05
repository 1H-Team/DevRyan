import { WebSocketServer } from 'ws';

import { parseRequestPathname } from '../terminal/index.js';
import {
  MESSAGE_STREAM_DIRECTORY_WS_PATH,
  MESSAGE_STREAM_GLOBAL_WS_PATH,
  MESSAGE_STREAM_WS_HEARTBEAT_INTERVAL_MS,
  sendMessageStreamWsEvent,
} from './protocol.js';
import { createGlobalMessageStreamHub } from './global-hub.js';
import { createGlobalMessageStreamWsBridge } from './global-ws-bridge.js';
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
    // A slow or suspended client otherwise makes Node buffer events without
    // bound in the socket write queue. Past this ceiling, drop the connection —
    // the client reconnects with Last-Event-ID and replays the gap.
    const SSE_MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
    const writeEntry = async (entry) => {
      if (res.writableEnded || res.destroyed) {
        return false;
      }
      if (eventFilter && !await eventFilter(req.principal, entry)) {
        return true;
      }
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

    let eventQueue = Promise.resolve(true);
    const enqueueEntry = (entry) => {
      eventQueue = eventQueue.then((canContinue) => canContinue ? writeEntry(entry) : false);
      return eventQueue;
    };
    const unsubscribe = globalHub.subscribeEvent((entry) => {
      void enqueueEntry(entry);
    });
    const requestedLastEventId = getRequestLastEventId(req);
    const { events } = typeof globalHub.replayAfter === 'function'
      ? globalHub.replayAfter(requestedLastEventId)
      : { events: [] };
    for (const entry of events) {
      if (entry?.eventId && deliveredEventIds.has(entry.eventId)) {
        continue;
      }
      await enqueueEntry(entry);
    }
    replayPhase = false;
    deliveredEventIds.clear();

    globalHub.start?.();

    const heartbeat = setInterval(() => {
      if (res.writableEnded || res.destroyed) {
        return;
      }
      res.write(':heartbeat\n\n');
    }, heartbeatIntervalMs);
    heartbeat.unref?.();

    const unregisterConnection = typeof registerConnection === 'function'
      ? registerConnection(req.principal, () => res.destroy?.())
      : () => {};
    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe?.();
      unregisterConnection();
      req.off?.('close', cleanup);
      req.off?.('error', cleanup);
    };

    req.on?.('close', cleanup);
    req.on?.('error', cleanup);
  };
}

export function createGlobalUiEventBroadcaster({
  sseClients,
  wsClients,
  writeSseEvent,
  globalEventHub = null,
}) {
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
          void Promise.resolve(filter(res.devRyanPrincipal, { payload, directory, eventId }))
            .then((allowed) => {
              if (allowed) writeSseEvent(res, payload);
            })
            .catch(() => undefined);
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
  processForwardedEventPayload,
  wsClients,
  triggerHealthCheck,
  heartbeatIntervalMs = MESSAGE_STREAM_WS_HEARTBEAT_INTERVAL_MS,
  upstreamStallTimeoutMs = DEFAULT_UPSTREAM_STALL_TIMEOUT_MS,
  upstreamReconnectDelayMs = DEFAULT_UPSTREAM_RECONNECT_DELAY_MS,
  fetchImpl = fetch,
  globalEventHub = null,
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
  });

  const globalBridge = createGlobalMessageStreamWsBridge({
    globalHub,
    ownsGlobalHub,
    wsClients,
    processForwardedEventPayload,
    triggerHealthCheck,
    heartbeatIntervalMs,
    eventFilter,
  });

  wsServer.on('connection', (socket, req) => {
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
      processForwardedEventPayload,
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
