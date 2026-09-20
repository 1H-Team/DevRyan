import { sendMessageStreamWsEvent, sendMessageStreamWsFrame } from './protocol.js';
import { createBoundedEventQueue } from './bounded-event-queue.js';

function shouldTriggerUpstreamHealthCheck(upstream) {
  if (!upstream) {
    return true;
  }

  if (!upstream.body) {
    return upstream.ok || upstream.status >= 500;
  }

  return upstream.status >= 500;
}

export function createGlobalMessageStreamWsBridge({
  globalHub,
  ownsGlobalHub,
  wsClients,
  triggerHealthCheck,
  heartbeatIntervalMs,
  eventFilter = null,
}) {
  const clients = new Set();
  const clientLastEventIds = new Map();
  const readyClients = new Set();
  const clientPrincipals = new Map();
  const clientQueues = new Map();
  const clientTimers = new Map();

  const removeClient = (socket) => {
    clientQueues.get(socket)?.close();
    for (const timer of clientTimers.get(socket) ?? []) clearInterval(timer);
    clientTimers.delete(socket);
    clients.delete(socket);
    clientLastEventIds.delete(socket);
    readyClients.delete(socket);
    clientPrincipals.delete(socket);
    clientQueues.delete(socket);
    wsClients.delete(socket);
  };

  const sendIfAllowed = (socket, entry) => {
    void clientQueues.get(socket)?.enqueue(entry);
  };

  const replayEvents = (socket, requestedLastEventId) => {
    const { events, gap } = globalHub.replayAfter(requestedLastEventId);
    if (gap && requestedLastEventId) {
      // Best-effort warning: the client's lastEventId rolled out of the
      // server-side buffer. The client should treat its cached directory
      // state as potentially stale and force a resync, but we still flush
      // whatever recent context we have below so the UI is not blank.
      sendMessageStreamWsFrame(socket, {
        type: 'gap',
        scope: 'global',
        lastEventId: requestedLastEventId,
      });
    }
    for (const entry of events) {
      sendIfAllowed(socket, entry);
    }
  };

  const markReady = (socket, requestedLastEventId) => {
    if (socket.readyState !== 1) {
      return;
    }

    const sent = sendMessageStreamWsFrame(socket, {
      type: 'ready',
      scope: 'global',
    });
    if (!sent) {
      removeClient(socket);
      return;
    }

    readyClients.add(socket);
    wsClients.add(socket);
    replayEvents(socket, requestedLastEventId);
  };

  const stopHubIfUnused = () => {
    if (ownsGlobalHub && clients.size === 0) {
      globalHub.stop();
    }
  };

  const closeClientsWithInitialError = ({ message, closeReason = message, triggerHealthCheckFor = null }) => {
    for (const socket of Array.from(clients)) {
      sendMessageStreamWsFrame(socket, { type: 'error', message });
      try {
        socket.close(1011, closeReason);
      } catch {
      }
      removeClient(socket);
    }

    if (triggerHealthCheckFor === true || (triggerHealthCheckFor && shouldTriggerUpstreamHealthCheck(triggerHealthCheckFor))) {
      triggerHealthCheck?.();
    }

    if (ownsGlobalHub) {
      globalHub.stop();
    }
  };

  const unsubscribeEvent = globalHub.subscribeEvent(({ payload, directory, eventId }) => {
    for (const socket of Array.from(clients)) {
      if (!readyClients.has(socket)) {
        continue;
      }
      sendIfAllowed(socket, { payload, directory, eventId });
    }

  });

  const unsubscribeStatus = globalHub.subscribeStatus((status) => {
    if (status.type === 'connect') {
      for (const socket of Array.from(clients)) {
        if (!readyClients.has(socket)) {
          markReady(socket, clientLastEventIds.get(socket) ?? '');
        }
      }
      return;
    }

    if (status.type === 'initial-error') {
      const error = status.error;
      if (error?.type === 'upstream_unavailable') {
        closeClientsWithInitialError({
          message: `OpenCode event stream unavailable (${error.status})`,
          closeReason: 'OpenCode event stream unavailable',
          triggerHealthCheckFor: error.response,
        });
        return;
      }

      closeClientsWithInitialError({
        message: status.buildUrlFailed ? 'OpenCode service unavailable' : 'Failed to connect to OpenCode event stream',
        closeReason: status.buildUrlFailed ? 'OpenCode service unavailable' : 'Failed to connect to OpenCode event stream',
        triggerHealthCheckFor: !status.buildUrlFailed,
      });
      return;
    }

    if (status.type === 'error' && status.error?.type === 'stream_error') {
      console.warn('Message stream WS proxy error:', status.error.error);
    }
  });

  const accept = (socket, { requestedLastEventId = '', principal = null } = {}) => {
    const pingInterval = setInterval(() => {
      if (socket.readyState !== 1) {
        return;
      }

      try {
        socket.ping();
      } catch {
      }
    }, heartbeatIntervalMs);

    const heartbeatInterval = setInterval(() => {
      if (!globalHub.isConnected()) {
        return;
      }

      sendMessageStreamWsEvent(socket, { type: 'openchamber:heartbeat', timestamp: Date.now() }, { directory: 'global' });
    }, heartbeatIntervalMs);
    clientTimers.set(socket, [pingInterval, heartbeatInterval]);

    socket.on('close', () => {
      clearInterval(pingInterval);
      clearInterval(heartbeatInterval);
      removeClient(socket);
      stopHubIfUnused();
    });

    socket.on('error', () => {
      removeClient(socket);
      stopHubIfUnused();
      try { socket.close(1011, 'Message stream connection failed'); } catch { /* Already closed. */ }
    });

    clients.add(socket);
    clientPrincipals.set(socket, principal);
    clientLastEventIds.set(socket, requestedLastEventId);
    clientQueues.set(socket, createBoundedEventQueue({
      getBufferedBytes: () => socket.bufferedAmount ?? 0,
      deliver: async (entry, signal) => {
        if (signal.aborted || !clients.has(socket)) return false;
        if (eventFilter && !await eventFilter(clientPrincipals.get(socket), entry)) return true;
        if (signal.aborted || !clients.has(socket)) return false;
        return sendMessageStreamWsEvent(socket, entry.payload, { directory: entry.directory, eventId: entry.eventId });
      },
      onClose: reason => {
        if (reason === 'cancelled') return;
        try { socket.close(1013, 'Message stream client is too slow'); } catch { /* Cleanup still runs. */ }
        removeClient(socket);
        stopHubIfUnused();
      },
    }));
    globalHub.start();
    if (globalHub.isConnected()) {
      markReady(socket, requestedLastEventId);
    }
  };

  const close = () => {
    unsubscribeEvent();
    unsubscribeStatus();
    if (ownsGlobalHub) {
      globalHub.stop();
    }
    for (const socket of Array.from(clients)) {
      removeClient(socket);
    }
  };

  return {
    accept,
    close,
  };
}
