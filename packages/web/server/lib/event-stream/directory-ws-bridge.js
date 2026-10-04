import { isMessageStreamControlPayload, sendMessageStreamWsEvent, sendMessageStreamWsFrame } from './protocol.js';
import { deriveDirectoryCompatibilityEvents } from './compatibility-events.js';
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

/**
 * Gen 2 (DESIGN.md B.7): OpenCode 2.x has no per-directory stream, so the
 * directory socket is served from the global hub with a directory filter. The
 * frames match the gen-1 bridge: `ready` once the hub is connected, events
 * labelled with the requested directory, the compatibility events, the
 * heartbeat, and the initial-error close. A replay after `lastEventId` comes
 * from the hub buffer (a `gap` frame when it cannot be proven gap-free), and
 * the hub's reconnect gaps reach the socket as `gap` frames.
 */
function acceptDirectoryMessageStreamFromHub({
  socket,
  requestedLastEventId,
  requestedDirectory,
  globalHub,
  wsClients,
  triggerHealthCheck,
  heartbeatIntervalMs,
  eventFilter,
  principal,
}) {
  let ready = false;
  let closed = false;
  let unsubscribeEvent = () => {};
  let unsubscribeStatus = () => {};

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
    if (!ready || !globalHub.isConnected()) {
      return;
    }

    sendMessageStreamWsEvent(socket, { type: 'openchamber:heartbeat', timestamp: Date.now() }, { directory: 'global' });
  }, heartbeatIntervalMs);

  const forwardOne = async (entry, signal) => {
    if (isMessageStreamControlPayload(entry.payload)) {
      // A resync request carries no data: every directory socket gets it.
      return signal.aborted ? false : sendMessageStreamWsEvent(socket, entry.payload);
    }
    const directory = requestedDirectory || entry.directory || 'global';
    if (eventFilter && !await eventFilter(principal, { payload: entry.payload, directory, eventId: entry.eventId })) {
      return true;
    }
    if (signal.aborted) return false;
    if (!sendMessageStreamWsEvent(socket, entry.payload, {
      directory,
      eventId: typeof entry.eventId === 'string' && entry.eventId.length > 0 ? entry.eventId : undefined,
    })) return false;

    for (const syntheticPayload of deriveDirectoryCompatibilityEvents(entry.payload)) {
      if (eventFilter && !await eventFilter(principal, { payload: syntheticPayload, directory: 'global' })) continue;
      if (signal.aborted) return false;
      if (!sendMessageStreamWsEvent(socket, syntheticPayload, { directory: 'global' })) return false;
    }
    return true;
  };

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(pingInterval);
    clearInterval(heartbeatInterval);
    unsubscribeEvent();
    unsubscribeStatus();
    eventQueue.close();
    wsClients.delete(socket);
  };

  const eventQueue = createBoundedEventQueue({
    deliver: forwardOne,
    getBufferedBytes: () => socket.bufferedAmount ?? 0,
    onClose: reason => {
      if (reason === 'cancelled') return;
      cleanup();
      try { socket.close(1013, 'Message stream client is too slow'); } catch { /* Already disconnected. */ }
    },
  });

  const closeWithInitialError = ({ message, triggerHealthCheckFor = null }) => {
    sendMessageStreamWsFrame(socket, { type: 'error', message });
    try { socket.close(1011, message); } catch { /* Already closed. */ }
    if (triggerHealthCheckFor === true || (triggerHealthCheckFor && shouldTriggerUpstreamHealthCheck(triggerHealthCheckFor))) {
      triggerHealthCheck?.();
    }
    cleanup();
  };

  const markReady = () => {
    if (ready || closed || socket.readyState !== 1) return;
    if (!sendMessageStreamWsFrame(socket, { type: 'ready', scope: 'directory' })) {
      cleanup();
      return;
    }
    ready = true;
    const { events, gap } = globalHub.replayAfter(requestedLastEventId, { directory: requestedDirectory });
    if (gap && requestedLastEventId) {
      sendMessageStreamWsFrame(socket, { type: 'gap', scope: 'directory', lastEventId: requestedLastEventId });
    }
    for (const entry of events) {
      void eventQueue.enqueue(entry);
    }
  };

  socket.on('close', cleanup);
  socket.on('error', () => {
    cleanup();
    try { socket.close(1011, 'Message stream connection failed'); } catch { /* Already closed. */ }
  });

  unsubscribeEvent = globalHub.subscribeDirectoryEvent(requestedDirectory, (entry) => {
    if (!ready || closed) return;
    void eventQueue.enqueue(entry);
  });
  unsubscribeStatus = globalHub.subscribeStatus((status) => {
    if (closed) return;
    if (status.type === 'connect') {
      markReady();
      return;
    }
    if (ready || status.type !== 'initial-error') return;
    const error = status.error;
    if (error?.type === 'upstream_unavailable') {
      closeWithInitialError({
        message: `OpenCode event stream unavailable (${error.status})`,
        triggerHealthCheckFor: error.response,
      });
      return;
    }
    closeWithInitialError({
      message: status.buildUrlFailed ? 'OpenCode service unavailable' : 'Failed to connect to OpenCode event stream',
      triggerHealthCheckFor: !status.buildUrlFailed,
    });
  });

  globalHub.start();
  if (globalHub.isConnected()) {
    markReady();
  }
}

export function acceptDirectoryMessageStreamWsConnection({
  socket,
  requestedLastEventId,
  requestedDirectory,
  wsClients,
  triggerHealthCheck,
  heartbeatIntervalMs,
  eventFilter = null,
  principal = null,
  globalHub = null,
}) {
  try {
    if (globalHub?.resolveGeneration?.() !== 2) throw new Error('Unsupported OpenCode runtime');
  } catch {
    sendMessageStreamWsFrame(socket, { type: 'error', message: 'OpenCode service unavailable' });
    try { socket.close(1011, 'OpenCode service unavailable'); } catch { /* Already closed. */ }
    wsClients.delete(socket);
    return;
  }
  acceptDirectoryMessageStreamFromHub({
    socket,
    requestedLastEventId,
    requestedDirectory,
    globalHub,
    wsClients,
    triggerHealthCheck,
    heartbeatIntervalMs,
    eventFilter,
    principal,
  });
}
