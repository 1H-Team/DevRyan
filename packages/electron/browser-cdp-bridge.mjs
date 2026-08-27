// Session-scoped CDP bridge for the in-app browser pane.
//
// One loopback WebSocket server is shared by every active lease. Each lease
// gets an unguessable capability path, one explicitly bound browser surface,
// and at most one controlling client. Closing any one of those resources only
// tears down its lease; the listener is stopped after the final lease closes.

export const BRIDGE_PROTOCOL_VERSION = '1.3';

export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const MAX_IN_FLIGHT_COMMANDS = 64;
export const COMMAND_TIMEOUT_MS = 30_000;
export const ORPHAN_TIMEOUT_MS = 2 * 60 * 1000;

// Commands that would let a controlling client escape its pinned guest or
// reach browser-wide state. agent-browser needs none of them.
const BLOCKED_METHODS = new Set([
  'Target.createTarget',
  'Target.closeTarget',
  'Target.disposeBrowserContext',
  'Target.createBrowserContext',
  'Target.activateTarget',
  'Target.exposeDevToolsProtocol',
  'Browser.close',
  'Browser.crash',
  'Browser.setDownloadBehavior',
  'Page.setDownloadBehavior',
  'Page.crash',
  'Page.close',
  'Browser.grantPermissions',
  'Browser.setPermission',
]);

// Electron's webContents.debugger has no Browser/Target root session. These
// bounded methods are synthesized around the lease's one pinned page target.
const isRootSyntheticMethod = (method) => (
  method === 'Browser.getVersion'
  || method === 'Target.setDiscoverTargets'
  || method === 'Target.getTargets'
  || method === 'Target.attachToTarget'
  || method === 'Target.detachFromTarget'
);

// agent-browser 0.33.2 probes the page with a root Runtime.evaluate before its
// flattened Target.attachToTarget handshake. The guest debugger already is the
// page session, so forwarding this one root command is both sufficient and
// narrower than accepting arbitrary session-less CDP commands.
const isRootForwardedMethod = (method) => method === 'Runtime.evaluate';

const isTargetDomainMethod = (method) => method.startsWith('Target.');
const isBrowserDomainMethod = (method) => method.startsWith('Browser.');
const isBrowserWideDomainMethod = (method) => (
  isTargetDomainMethod(method)
  || isBrowserDomainMethod(method)
  || method.startsWith('Memory.')
  || method.startsWith('Security.')
  || method.startsWith('SystemInfo.')
  || method.startsWith('Tethering.')
);

export const parseBridgeFrame = (raw) => {
  if (typeof raw !== 'string') return { ok: false, error: 'Only text frames are supported' };
  if (Buffer.byteLength(raw, 'utf8') > MAX_FRAME_BYTES) return { ok: false, error: 'Frame too large' };

  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'Malformed JSON' };
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return { ok: false, error: 'Frame must be an object' };
  }
  if (!Number.isInteger(message.id)) return { ok: false, error: 'Frame requires an integer id' };
  if (typeof message.method !== 'string' || message.method.length === 0) {
    return { ok: false, error: 'Frame requires a method' };
  }
  if (message.params !== undefined && (typeof message.params !== 'object' || message.params === null || Array.isArray(message.params))) {
    return { ok: false, error: 'params must be an object' };
  }
  if (message.sessionId !== undefined && typeof message.sessionId !== 'string') {
    return { ok: false, error: 'sessionId must be a string' };
  }
  return {
    ok: true,
    message: {
      id: message.id,
      method: message.method,
      params: message.params ?? {},
      sessionId: typeof message.sessionId === 'string' ? message.sessionId : null,
    },
  };
};

export const isBlockedBridgeMethod = (method) => BLOCKED_METHODS.has(method);

// CLI clients send no Origin. A browser page reaching the loopback bridge does.
export const isAllowedBridgeOrigin = (origin) => origin === undefined || origin === null || origin === '';

export const describeAgentInput = (method, params) => {
  if (method === 'Input.dispatchMouseEvent') {
    const type = String(params?.type || '');
    const kind = type === 'mousePressed' ? 'down'
      : type === 'mouseReleased' ? 'up'
        : type === 'mouseWheel' ? 'wheel'
          : 'move';
    return {
      kind,
      x: Number(params?.x) || 0,
      y: Number(params?.y) || 0,
      button: typeof params?.button === 'string' ? params.button : null,
      clickCount: Number(params?.clickCount) || 0,
    };
  }
  if (method === 'Input.dispatchKeyEvent') {
    return { kind: 'key', keyType: String(params?.type || ''), key: typeof params?.key === 'string' ? params.key : null };
  }
  if (method === 'Input.insertText') {
    return { kind: 'text', length: typeof params?.text === 'string' ? params.text.length : 0 };
  }
  if (method === 'Input.dispatchTouchEvent') {
    const touch = Array.isArray(params?.touchPoints) ? params.touchPoints[0] : null;
    return { kind: 'touch', x: Number(touch?.x) || 0, y: Number(touch?.y) || 0, touchType: String(params?.type || '') };
  }
  return null;
};

const buildTargetInfo = (targetId, url, title) => ({
  targetId,
  type: 'page',
  title: title || 'DevRyan Browser',
  url: url || 'about:blank',
  attached: true,
  canAccessOpener: false,
  browserContextId: 'openchamber-browser',
});

const removeListener = (emitter, event, listener) => {
  if (!emitter || !listener) return;
  if (typeof emitter.off === 'function') {
    emitter.off(event, listener);
    return;
  }
  if (typeof emitter.removeListener === 'function') emitter.removeListener(event, listener);
};

const publicMetadata = (metadata) => {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  const result = {};
  for (const [key, value] of Object.entries(metadata)) {
    // Capability-bearing values are bridge-private even if a caller happened
    // to copy one into metadata.
    if (/token|ws_?url/i.test(key)) continue;
    result[key] = value;
  }
  return result;
};

const errorMessage = (error, fallback) => (
  error && typeof error === 'object' && typeof error.message === 'string'
    ? error.message
    : fallback
);

const formatWsHost = (host) => (host.includes(':') && !host.startsWith('[') ? `[${host}]` : host);

const webSocketCloseReason = (reason) => {
  let value = String(reason || '');
  while (Buffer.byteLength(value, 'utf8') > 123) value = value.slice(0, -1);
  return value;
};

/**
 * @param {object} deps
 * @param {(options: object) => object} deps.createWebSocketServer ws.WebSocketServer-compatible factory
 * @param {{ randomBytes: (size: number) => { toString: (enc: string) => string } }} deps.crypto
 * @param {(input: object) => void} [deps.onAgentInput]
 * @param {(detail: object) => void | Promise<void>} [deps.onBeforeCommand]
 * @param {(detail: object) => void | Promise<void>} [deps.onAfterCommand]
 * @param {(status: object) => void} [deps.onStatusChange]
 * @param {(message: string, error?: unknown) => void} [deps.log]
 * @param {string} [deps.host]
 * @param {number} [deps.commandTimeoutMs]
 * @param {number} [deps.orphanTimeoutMs]
 * @param {number} [deps.maxInFlightCommands]
 * @param {() => number} [deps.now]
 * @param {(callback: () => void, delay: number) => ReturnType<typeof setTimeout>} [deps.setTimer]
 * @param {(timer: ReturnType<typeof setTimeout>) => void} [deps.clearTimer]
 */
export const createBrowserCdpBridge = ({
  createWebSocketServer,
  crypto,
  onAgentInput,
  onBeforeCommand,
  onAfterCommand,
  onStatusChange,
  log = () => {},
  host = '127.0.0.1',
  commandTimeoutMs = COMMAND_TIMEOUT_MS,
  orphanTimeoutMs = ORPHAN_TIMEOUT_MS,
  maxInFlightCommands = MAX_IN_FLIGHT_COMMANDS,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) => {
  const leases = new Map(); // leaseId -> lease (the authoritative generation)
  const leaseIdsByToken = new Map();
  let serverState = null; // { server, ready, port, promise }

  const isCurrentLease = (lease, token = lease?.token) => (
    Boolean(lease)
    && lease.token === token
    && leases.get(lease.leaseId)?.token === token
  );

  const countClients = () => {
    let count = 0;
    for (const lease of leases.values()) {
      if (lease.client) count += 1;
    }
    return count;
  };

  const status = () => ({
    state: serverState?.ready ? 'ready' : serverState ? 'starting' : 'stopped',
    running: Boolean(serverState?.ready),
    port: serverState?.ready ? serverState.port : 0,
    clients: countClients(),
    leaseCount: leases.size,
  });

  const emitStatus = () => {
    try {
      onStatusChange?.(status());
    } catch (error) {
      log('[cdp-bridge] onStatusChange failed', error);
    }
  };

  const getLeaseStatus = (leaseId) => {
    const lease = leases.get(leaseId);
    if (!lease) return { ok: false, state: 'not_found', leaseId };
    const state = lease.client ? 'connected' : lease.guest ? 'ready' : 'waiting_for_guest';
    return {
      ok: true,
      state,
      leaseId,
      running: Boolean(serverState?.ready),
      bound: Boolean(lease.guest),
      guestAttached: Boolean(lease.guest),
      clients: lease.client ? 1 : 0,
      inFlight: lease.inFlight.size,
      ownerWindowId: lease.ownerWindowId,
      lastActivityAt: lease.lastActivityAt,
      metadata: publicMetadata(lease.metadata),
    };
  };

  const sendToLease = (lease, payload) => {
    if (!isCurrentLease(lease) || !lease.client) return false;
    try {
      lease.client.send(JSON.stringify(payload));
      return true;
    } catch (error) {
      log(`[cdp-bridge] failed to send frame for lease ${lease.leaseId}`, error);
      return false;
    }
  };

  const sendError = (lease, id, message, code = -32000, cdpSessionId = null) => {
    const payload = { id, error: { code, message } };
    if (cdpSessionId) payload.sessionId = cdpSessionId;
    sendToLease(lease, payload);
  };

  const clearCommand = (lease, id, commandFence) => {
    const entry = lease.inFlight.get(id);
    if (!entry || (commandFence && entry.fence !== commandFence)) return false;
    clearTimer(entry.timer);
    lease.inFlight.delete(id);
    return true;
  };

  const clearOrphanTimer = (lease) => {
    if (!lease.orphanTimer) return;
    clearTimer(lease.orphanTimer);
    lease.orphanTimer = null;
  };

  let closeLeaseWithToken;

  const scheduleOrphanTimer = (lease) => {
    if (!isCurrentLease(lease)) return;
    clearOrphanTimer(lease);
    if (!Number.isFinite(orphanTimeoutMs) || orphanTimeoutMs <= 0) return;

    const elapsed = Math.max(0, now() - lease.lastActivityAt);
    const delay = Math.max(1, orphanTimeoutMs - elapsed);
    const token = lease.token;
    lease.orphanTimer = setTimer(() => {
      if (!isCurrentLease(lease, token)) return;
      lease.orphanTimer = null;
      if (lease.inFlight.size > 0) {
        // Completion/timeout will touch the lease and schedule a fresh timer.
        return;
      }
      if (now() - lease.lastActivityAt < orphanTimeoutMs) {
        scheduleOrphanTimer(lease);
        return;
      }
      closeLeaseWithToken(lease.leaseId, token, 'orphan_timeout');
    }, delay);
    lease.orphanTimer.unref?.();
  };

  const touchRecord = (lease) => {
    if (!isCurrentLease(lease)) return false;
    lease.lastActivityAt = now();
    scheduleOrphanTimer(lease);
    return true;
  };

  const removeGuestDestroyedListener = (lease) => {
    removeListener(lease.guest, 'destroyed', lease.guestDestroyedListener);
    lease.guestDestroyedListener = null;
  };

  const detachDebugger = (lease) => {
    const guest = lease.guest;
    if (!guest) return;
    removeListener(guest.debugger, 'message', lease.debuggerMessageListener);
    removeListener(guest.debugger, 'detach', lease.debuggerDetachListener);
    lease.debuggerMessageListener = null;
    lease.debuggerDetachListener = null;
    const ownedAttachment = lease.debuggerAttached;
    lease.debuggerAttached = false;
    if (!ownedAttachment) return;
    try {
      if (guest.debugger.isAttached()) guest.debugger.detach();
    } catch (error) {
      log(`[cdp-bridge] debugger detach failed for lease ${lease.leaseId}`, error);
    }
  };

  const stopServerIfUnused = () => {
    if (leases.size > 0 || !serverState) return;
    const state = serverState;
    serverState = null;
    try {
      state.server.close();
    } catch (error) {
      log('[cdp-bridge] failed to close server', error);
    }
  };

  closeLeaseWithToken = (leaseId, token, reason = 'released', socketCode = 1001) => {
    const lease = leases.get(leaseId);
    if (!lease || lease.token !== token) return false;

    // Delete the fenced generation before invoking any API that may synchronously
    // emit close/detach/destroyed callbacks or create a replacement lease.
    leases.delete(leaseId);
    leaseIdsByToken.delete(token);
    clearOrphanTimer(lease);
    for (const [id, entry] of lease.inFlight) {
      clearTimer(entry.timer);
      lease.inFlight.delete(id);
    }
    removeGuestDestroyedListener(lease);
    detachDebugger(lease);

    const socket = lease.client;
    lease.client = null;
    lease.guest = null;
    if (socket) {
      try {
        socket.close(socketCode, webSocketCloseReason(reason));
      } catch {
        // The peer may already have closed the socket.
      }
    }

    stopServerIfUnused();
    emitStatus();
    try {
      lease.onClosed?.({ leaseId, reason });
    } catch (error) {
      log(`[cdp-bridge] onClosed failed for lease ${leaseId}`, error);
    }
    return true;
  };

  const closeLease = (leaseId, reason = 'released') => {
    const lease = leases.get(leaseId);
    if (!lease) return false;
    return closeLeaseWithToken(leaseId, lease.token, reason);
  };

  const closeAll = (reason = 'bridge_stopped') => {
    const snapshot = Array.from(leases.values(), (lease) => ({ leaseId: lease.leaseId, token: lease.token }));
    for (const lease of snapshot) closeLeaseWithToken(lease.leaseId, lease.token, reason);
    stopServerIfUnused();
    emitStatus();
    return snapshot.length;
  };

  const finishForwardedCommand = (lease, message, commandFence, outcome) => {
    if (!isCurrentLease(lease) || !clearCommand(lease, message.id, commandFence)) return;
    touchRecord(lease);
    const session = message.sessionId ? lease.cdpSessionId : null;
    if (outcome.ok) {
      const payload = { id: message.id, result: outcome.result ?? {} };
      if (session) payload.sessionId = session;
      sendToLease(lease, payload);
      return;
    }
    sendError(lease, message.id, outcome.message, -32000, session);
  };

  const forwardCommand = (lease, message) => {
    if (!isCurrentLease(lease)) return;
    const guest = lease.guest;
    if (!guest || guest.isDestroyed()) {
      closeLeaseWithToken(lease.leaseId, lease.token, 'guest_closed');
      return;
    }
    if (lease.inFlight.has(message.id)) {
      sendError(lease, message.id, 'Duplicate in-flight command id', -32600, message.sessionId ? lease.cdpSessionId : null);
      touchRecord(lease);
      return;
    }
    if (lease.inFlight.size >= maxInFlightCommands) {
      sendError(lease, message.id, 'Too many in-flight commands', -32000, message.sessionId ? lease.cdpSessionId : null);
      touchRecord(lease);
      return;
    }

    const input = describeAgentInput(message.method, message.params);
    if (input) {
      try {
        onAgentInput?.({ leaseId: lease.leaseId, ...input });
      } catch (error) {
        log(`[cdp-bridge] onAgentInput failed for lease ${lease.leaseId}`, error);
      }
    }

    const commandFence = Symbol(`command:${message.id}`);
    const token = lease.token;
    const timer = setTimer(() => {
      if (!isCurrentLease(lease, token) || !clearCommand(lease, message.id, commandFence)) return;
      touchRecord(lease);
      sendError(
        lease,
        message.id,
        `Command timed out: ${message.method}`,
        -32000,
        message.sessionId ? lease.cdpSessionId : null,
      );
    }, commandTimeoutMs);
    timer.unref?.();
    lease.inFlight.set(message.id, { fence: commandFence, timer });

    const commandDetail = { leaseId: lease.leaseId, method: message.method };
    let beforeCommand;
    try {
      beforeCommand = onBeforeCommand?.(commandDetail);
    } catch (error) {
      beforeCommand = Promise.reject(error);
    }
    const forwarded = beforeCommand && typeof beforeCommand.then === 'function'
      ? Promise.resolve(beforeCommand).then(() => guest.debugger.sendCommand(message.method, message.params))
      : Promise.resolve().then(() => guest.debugger.sendCommand(message.method, message.params));
    forwarded
      .then((result) => {
        finishForwardedCommand(lease, message, commandFence, { ok: true, result });
      })
      .catch((error) => {
        finishForwardedCommand(lease, message, commandFence, {
          ok: false,
          message: errorMessage(error, 'Command failed'),
        });
      })
      .finally(() => {
        Promise.resolve(onAfterCommand?.(commandDetail)).catch((error) => {
          log(`[cdp-bridge] onAfterCommand failed for lease ${lease.leaseId}`, error);
        });
      });
  };

  const completeRootCommand = (lease) => {
    touchRecord(lease);
  };

  const handleRootCommand = (lease, message) => {
    const { id, method, params } = message;
    if (method === 'Browser.getVersion') {
      sendToLease(lease, {
        id,
        result: {
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          product: 'DevRyan/BrowserPane',
          revision: '',
          userAgent: '',
          jsVersion: '',
        },
      });
      completeRootCommand(lease);
      return;
    }

    if (method === 'Target.setDiscoverTargets') {
      sendToLease(lease, { id, result: {} });
      if (params?.discover === true) {
        sendToLease(lease, {
          method: 'Target.targetCreated',
          params: { targetInfo: buildTargetInfo(lease.targetId, lease.guest?.getURL?.(), lease.guest?.getTitle?.()) },
        });
      }
      completeRootCommand(lease);
      return;
    }

    if (method === 'Target.getTargets') {
      sendToLease(lease, {
        id,
        result: { targetInfos: [buildTargetInfo(lease.targetId, lease.guest?.getURL?.(), lease.guest?.getTitle?.())] },
      });
      completeRootCommand(lease);
      return;
    }

    if (method === 'Target.attachToTarget') {
      if (params?.targetId && params.targetId !== lease.targetId) {
        sendError(lease, id, 'No such target');
        completeRootCommand(lease);
        return;
      }
      if (params?.flatten === false) {
        sendError(lease, id, 'Only flattened sessions are supported');
        completeRootCommand(lease);
        return;
      }
      sendToLease(lease, { id, result: { sessionId: lease.cdpSessionId } });
      sendToLease(lease, {
        method: 'Target.attachedToTarget',
        params: {
          sessionId: lease.cdpSessionId,
          targetInfo: buildTargetInfo(lease.targetId, lease.guest?.getURL?.(), lease.guest?.getTitle?.()),
          waitingForDebugger: false,
        },
      });
      completeRootCommand(lease);
      return;
    }

    if (method === 'Target.detachFromTarget') {
      sendToLease(lease, { id, result: {} });
      completeRootCommand(lease);
      return;
    }

    sendError(lease, id, `Unsupported root method: ${method}`, -32601);
    completeRootCommand(lease);
  };

  const handleFrame = (lease, raw) => {
    if (!isCurrentLease(lease)) return;
    const parsed = parseBridgeFrame(raw);
    if (!parsed.ok) {
      log(`[cdp-bridge] rejecting frame for lease ${lease.leaseId}: ${parsed.error}`);
      closeLeaseWithToken(lease.leaseId, lease.token, 'protocol_violation', 1008);
      return;
    }

    const message = parsed.message;
    if (isBlockedBridgeMethod(message.method)) {
      sendError(lease, message.id, `Method not permitted through the browser bridge: ${message.method}`, -32601);
      touchRecord(lease);
      return;
    }

    if (!message.sessionId) {
      if (isRootSyntheticMethod(message.method)) {
        handleRootCommand(lease, message);
        return;
      }
      if (isRootForwardedMethod(message.method)) {
        forwardCommand(lease, message);
        return;
      }
      sendError(lease, message.id, 'Session-scoped commands require a sessionId', -32600);
      touchRecord(lease);
      return;
    }

    if (message.sessionId !== lease.cdpSessionId) {
      sendError(lease, message.id, 'Unknown sessionId', -32600);
      touchRecord(lease);
      return;
    }

    // A page debugger can expose the browser-level Target domain. Forwarding
    // it would let one lease enumerate or attach sibling Electron targets.
    // agent-browser 0.33.2 only needs setAutoAttach during its handshake, and
    // the pinned main-page bridge does not need child-target attachment, so
    // synthesize that one response and reject every other Target command.
    if (message.method === 'Target.setAutoAttach') {
      sendToLease(lease, { id: message.id, result: {}, sessionId: lease.cdpSessionId });
      touchRecord(lease);
      return;
    }
    if (isTargetDomainMethod(message.method)) {
      sendError(
        lease,
        message.id,
        `Method not permitted through the browser bridge: ${message.method}`,
        -32601,
        lease.cdpSessionId,
      );
      touchRecord(lease);
      return;
    }
    if (isBrowserWideDomainMethod(message.method)) {
      sendError(
        lease,
        message.id,
        `Method not permitted through the browser bridge: ${message.method}`,
        -32601,
        lease.cdpSessionId,
      );
      touchRecord(lease);
      return;
    }
    forwardCommand(lease, message);
  };

  const attachDebugger = (lease) => {
    const guest = lease.guest;
    if (!guest || guest.isDestroyed()) return { ok: false, state: 'guest_closed' };
    try {
      guest.debugger.attach(BRIDGE_PROTOCOL_VERSION);
    } catch (error) {
      log(`[cdp-bridge] debugger attach failed for lease ${lease.leaseId}`, error);
      return { ok: false, state: 'debugger_conflict' };
    }

    lease.debuggerAttached = true;
    const token = lease.token;
    lease.debuggerMessageListener = (_event, method, params) => {
      if (!isCurrentLease(lease, token)) return;
      if (isBrowserWideDomainMethod(method)) return;
      sendToLease(lease, { method, params, sessionId: lease.cdpSessionId });
    };
    lease.debuggerDetachListener = (_event, reason) => {
      if (!isCurrentLease(lease, token)) return;
      log(`[cdp-bridge] debugger detached for lease ${lease.leaseId}: ${String(reason || 'unknown')}`);
      closeLeaseWithToken(lease.leaseId, token, 'debugger_detached');
    };
    guest.debugger.on('message', lease.debuggerMessageListener);
    guest.debugger.on('detach', lease.debuggerDetachListener);
    return { ok: true, state: 'attached' };
  };

  const handleConnection = (socket, request) => {
    const origin = request?.headers?.origin;
    if (!isAllowedBridgeOrigin(origin)) {
      log('[cdp-bridge] rejecting connection with browser Origin');
      try { socket.close(1008, 'origin not allowed'); } catch { /* already closing */ }
      return;
    }

    const requestPath = String(request?.url || '');
    const prefix = '/devtools/page/';
    const capability = requestPath.startsWith(prefix) ? requestPath.slice(prefix.length) : '';
    const leaseId = capability && !capability.includes('/') && !capability.includes('?')
      ? leaseIdsByToken.get(capability)
      : null;
    const lease = leaseId ? leases.get(leaseId) : null;
    if (!lease || lease.token !== capability) {
      log('[cdp-bridge] rejecting connection with bad capability path');
      try { socket.close(1008, 'unauthorized'); } catch { /* already closing */ }
      return;
    }

    if (lease.client) {
      log(`[cdp-bridge] rejecting second controlling client for lease ${lease.leaseId}`);
      try { socket.close(1013, 'lease already in use'); } catch { /* already closing */ }
      return;
    }
    if (!lease.guest || lease.guest.isDestroyed()) {
      try { socket.close(1011, 'guest unavailable'); } catch { /* already closing */ }
      closeLeaseWithToken(lease.leaseId, lease.token, 'guest_closed');
      return;
    }

    lease.client = socket;
    const attached = attachDebugger(lease);
    if (!attached.ok) {
      lease.client = null;
      try { socket.close(1011, attached.state); } catch { /* already closing */ }
      closeLeaseWithToken(lease.leaseId, lease.token, attached.state);
      return;
    }

    const token = lease.token;
    socket.on('message', (data, isBinary) => {
      if (!isCurrentLease(lease, token) || lease.client !== socket) return;
      if (isBinary) {
        log(`[cdp-bridge] rejecting binary frame for lease ${lease.leaseId}`);
        closeLeaseWithToken(lease.leaseId, token, 'binary_frame', 1003);
        return;
      }
      handleFrame(lease, data.toString('utf8'));
    });
    socket.on('close', () => {
      if (!isCurrentLease(lease, token) || lease.client !== socket) return;
      closeLeaseWithToken(lease.leaseId, token, 'client_closed');
    });
    socket.on('error', (error) => {
      log(`[cdp-bridge] socket error for lease ${lease.leaseId}`, error);
      if (!isCurrentLease(lease, token) || lease.client !== socket) return;
      closeLeaseWithToken(lease.leaseId, token, 'socket_error', 1011);
    });
    touchRecord(lease);
    emitStatus();
  };

  const ensureServer = () => {
    if (serverState) return serverState.promise;

    let wsServer;
    try {
      wsServer = createWebSocketServer({ host, port: 0, maxPayload: MAX_FRAME_BYTES });
    } catch (error) {
      return Promise.reject(error);
    }

    const state = { server: wsServer, ready: false, port: 0, promise: null };
    serverState = state;
    wsServer.on('connection', handleConnection);
    state.promise = new Promise((resolve, reject) => {
      let settled = false;

      const handleListening = () => {
        if (settled) return;
        const address = wsServer.address();
        const nextPort = typeof address === 'object' && address && Number.isInteger(address.port)
          ? address.port
          : 0;
        if (nextPort <= 0) {
          settled = true;
          if (serverState === state) serverState = null;
          reject(new Error('WebSocket server did not publish a listening port'));
          return;
        }
        settled = true;
        state.ready = true;
        state.port = nextPort;
        emitStatus();
        resolve(state);
      };

      wsServer.on('listening', handleListening);
      wsServer.on('error', (error) => {
        if (!settled) {
          settled = true;
          if (serverState === state) serverState = null;
          try {
            wsServer.close();
          } catch {
            // A failed listener may already be closed.
          }
          reject(error);
          return;
        }
        if (serverState !== state) return;
        log('[cdp-bridge] WebSocket server error', error);
        serverState = null;
        try {
          wsServer.close();
        } catch {
          // The listener may already be closing after the error.
        }
        closeAll('server_error');
      });
      wsServer.on('close', () => {
        if (!settled) {
          settled = true;
          reject(new Error('WebSocket server closed before listening'));
        }
        if (serverState !== state) return;
        serverState = null;
        closeAll('server_closed');
      });

    });
    return state.promise;
  };

  const nextUniqueToken = () => {
    for (;;) {
      const token = crypto.randomBytes(32).toString('hex');
      if (!leaseIdsByToken.has(token)) return token;
    }
  };

  const createLease = async ({ leaseId, metadata = {}, onClosed } = {}) => {
    if (typeof leaseId !== 'string' || leaseId.length === 0) {
      return { ok: false, state: 'invalid_lease_id', leaseId: typeof leaseId === 'string' ? leaseId : null };
    }
    if (leases.has(leaseId)) return { ok: false, state: 'lease_exists', leaseId };

    const token = nextUniqueToken();
    const lease = {
      leaseId,
      token,
      metadata: publicMetadata(metadata),
      onClosed: typeof onClosed === 'function' ? onClosed : null,
      client: null,
      guest: null,
      ownerWindowId: null,
      cdpSessionId: crypto.randomBytes(16).toString('hex').toUpperCase(),
      targetId: crypto.randomBytes(16).toString('hex').toUpperCase(),
      inFlight: new Map(),
      lastActivityAt: now(),
      orphanTimer: null,
      debuggerAttached: false,
      debuggerMessageListener: null,
      debuggerDetachListener: null,
      guestDestroyedListener: null,
    };
    leases.set(leaseId, lease);
    leaseIdsByToken.set(token, leaseId);
    scheduleOrphanTimer(lease);

    let readyState;
    try {
      const readyPromise = ensureServer();
      emitStatus();
      readyState = await readyPromise;
    } catch (error) {
      if (!isCurrentLease(lease, token)) return { ok: false, state: 'lease_closed', leaseId };
      log(`[cdp-bridge] failed to start server for lease ${leaseId}`, error);
      closeLeaseWithToken(leaseId, token, 'server_start_failed');
      return { ok: false, state: 'listen_failed', leaseId };
    }
    if (!isCurrentLease(lease, token)) return { ok: false, state: 'lease_closed', leaseId };

    return {
      ok: true,
      state: lease.guest ? 'ready' : 'waiting_for_guest',
      leaseId,
      wsUrl: `ws://${formatWsHost(host)}:${readyState.port}/devtools/page/${token}`,
      port: readyState.port,
    };
  };

  const bindLeaseGuest = (leaseId, guest, { ownerWindowId } = {}) => {
    const lease = leases.get(leaseId);
    if (!lease) return { ok: false, state: 'not_found', leaseId };
    if (!guest || typeof guest !== 'object' || !guest.debugger || typeof guest.isDestroyed !== 'function') {
      return { ok: false, state: 'invalid_guest', leaseId };
    }
    if (guest.isDestroyed()) {
      closeLeaseWithToken(leaseId, lease.token, 'guest_closed');
      return { ok: false, state: 'guest_closed', leaseId };
    }
    if (
      typeof guest.debugger.attach !== 'function'
      || typeof guest.debugger.detach !== 'function'
      || typeof guest.debugger.isAttached !== 'function'
      || typeof guest.debugger.sendCommand !== 'function'
      || typeof guest.debugger.on !== 'function'
    ) {
      return { ok: false, state: 'invalid_guest', leaseId };
    }
    for (const other of leases.values()) {
      if (other !== lease && other.guest === guest) return { ok: false, state: 'guest_in_use', leaseId };
    }
    if (lease.client && lease.guest !== guest) return { ok: false, state: 'lease_in_use', leaseId };

    if (lease.guest !== guest) {
      removeGuestDestroyedListener(lease);
      detachDebugger(lease);
      lease.guest = guest;
      const token = lease.token;
      lease.guestDestroyedListener = () => {
        if (!isCurrentLease(lease, token) || lease.guest !== guest) return;
        closeLeaseWithToken(leaseId, token, 'guest_closed');
      };
      if (typeof guest.once === 'function') guest.once('destroyed', lease.guestDestroyedListener);
      else if (typeof guest.on === 'function') guest.on('destroyed', lease.guestDestroyedListener);
    }
    lease.ownerWindowId = Number.isInteger(ownerWindowId) ? ownerWindowId : null;
    touchRecord(lease);
    emitStatus();
    return getLeaseStatus(leaseId);
  };

  const mergeLeaseMetadata = (lease, metadataPatch) => {
    if (!metadataPatch || typeof metadataPatch !== 'object' || Array.isArray(metadataPatch)) return false;
    const patch = publicMetadata(metadataPatch);
    let changed = false;
    for (const [key, value] of Object.entries(patch)) {
      if (lease.metadata[key] !== value) {
        changed = true;
        break;
      }
    }
    if (!changed) return false;
    lease.metadata = { ...lease.metadata, ...patch };
    return true;
  };

  // Presentation metadata is intentionally not lease activity. A site that
  // churns document.title/history must not keep an abandoned agent lease alive.
  const updateLeaseMetadata = (leaseId, metadataPatch) => {
    const lease = leases.get(leaseId);
    if (!lease) return { ok: false, state: 'not_found', leaseId };
    if (mergeLeaseMetadata(lease, metadataPatch)) emitStatus();
    return getLeaseStatus(leaseId);
  };

  const touchLease = (leaseId, metadataPatch) => {
    const lease = leases.get(leaseId);
    if (!lease) return { ok: false, state: 'not_found', leaseId };
    mergeLeaseMetadata(lease, metadataPatch);
    touchRecord(lease);
    emitStatus();
    return getLeaseStatus(leaseId);
  };

  return {
    createLease,
    bindLeaseGuest,
    updateLeaseMetadata,
    touchLease,
    closeLease,
    closeAll,
    // Shutdown compatibility for existing Electron cleanup paths.
    stop: () => closeAll('bridge_stopped'),
    status,
    getLeaseStatus,
    get isRunning() { return Boolean(serverState?.ready); },
  };
};
