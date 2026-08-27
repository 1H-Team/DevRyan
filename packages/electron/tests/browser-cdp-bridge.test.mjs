import { describe, expect, test } from 'bun:test';
import { WebSocketServer } from 'ws';

import {
  createBrowserCdpBridge,
  describeAgentInput,
  isAllowedBridgeOrigin,
  isBlockedBridgeMethod,
  MAX_FRAME_BYTES,
  parseBridgeFrame,
} from '../browser-cdp-bridge.mjs';

const flushPromises = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const createFakeClock = () => {
  let current = 0;
  let sequence = 0;
  const timers = new Map();

  const setTimer = (callback, delay) => {
    const handle = { id: ++sequence, unref() {} };
    timers.set(handle, {
      callback,
      dueAt: current + Math.max(0, Number(delay) || 0),
      sequence,
    });
    return handle;
  };

  const clearTimer = (handle) => {
    timers.delete(handle);
  };

  const advance = (milliseconds) => {
    const target = current + milliseconds;
    for (;;) {
      const next = Array.from(timers.entries())
        .filter(([, timer]) => timer.dueAt <= target)
        .sort((left, right) => (
          left[1].dueAt - right[1].dueAt || left[1].sequence - right[1].sequence
        ))[0];
      if (!next) break;
      const [handle, timer] = next;
      timers.delete(handle);
      current = timer.dueAt;
      timer.callback();
    }
    current = target;
  };

  return { advance, clearTimer, now: () => current, setTimer };
};

const createEmitter = () => {
  const handlers = new Map();
  const on = (event, handler) => {
    const current = handlers.get(event) ?? new Set();
    current.add(handler);
    handlers.set(event, current);
    return handler;
  };
  const off = (event, handler) => {
    handlers.get(event)?.delete(handler);
  };
  const once = (event, handler) => {
    const wrapped = (...args) => {
      off(event, wrapped);
      handler(...args);
    };
    wrapped.original = handler;
    on(event, wrapped);
  };
  const emit = (event, ...args) => {
    for (const handler of Array.from(handlers.get(event) ?? [])) handler(...args);
  };
  const removeListener = (event, handler) => {
    for (const candidate of Array.from(handlers.get(event) ?? [])) {
      if (candidate === handler || candidate.original === handler) off(event, candidate);
    }
  };
  return { on, off, once, emit, removeListener };
};

const createFakeCrypto = () => {
  let counter = 0;
  return {
    randomBytes(size) {
      counter += 1;
      const value = String(counter).padStart(size * 2, '0');
      return { toString: () => value };
    },
  };
};

const createFakeSocket = () => {
  const emitter = createEmitter();
  return {
    ...emitter,
    sent: [],
    closed: null,
    send(payload) {
      this.sent.push(JSON.parse(payload));
    },
    close(code, reason) {
      if (!this.closed) this.closed = { code, reason };
      queueMicrotask(() => emitter.emit('close', code, reason));
    },
    peerClose() {
      emitter.emit('close', 1000, 'peer closed');
    },
  };
};

const createFakeDebugger = ({ attachError = null, sendCommand } = {}) => {
  const emitter = createEmitter();
  let attached = false;
  return {
    ...emitter,
    commands: [],
    attach() {
      if (attachError) throw attachError;
      attached = true;
    },
    detach() {
      attached = false;
    },
    isAttached() {
      return attached;
    },
    async sendCommand(method, params) {
      this.commands.push({ method, params });
      if (sendCommand) return sendCommand(method, params);
      return {};
    },
  };
};

const createFakeGuest = ({
  name = 'guest',
  attachError = null,
  sendCommand,
} = {}) => {
  const emitter = createEmitter();
  let destroyed = false;
  const debuggerApi = createFakeDebugger({ attachError, sendCommand });
  return {
    ...emitter,
    name,
    debugger: debuggerApi,
    isDestroyed: () => destroyed,
    getURL: () => `https://${name}.example/`,
    getTitle: () => `${name} title`,
    destroy() {
      destroyed = true;
      emitter.emit('destroyed');
    },
  };
};

const createFakeServer = (port) => {
  const emitter = createEmitter();
  let listening = false;
  const server = {
    ...emitter,
    closeCalls: 0,
    address: () => (listening ? { address: '127.0.0.1', family: 'IPv4', port } : null),
    close() {
      this.closeCalls += 1;
      listening = false;
      queueMicrotask(() => emitter.emit('close'));
    },
    connect(socket, { url, origin } = {}) {
      emitter.emit('connection', socket, { url, headers: { origin } });
    },
  };
  queueMicrotask(() => {
    listening = true;
    emitter.emit('listening');
  });
  return server;
};

const createHarness = ({
  commandTimeoutMs = 1_000,
  orphanTimeoutMs = 5_000,
  maxInFlightCommands = 64,
  now,
  setTimer,
  clearTimer,
} = {}) => {
  const inputs = [];
  const statuses = [];
  const servers = [];
  const closed = [];
  const bridge = createBrowserCdpBridge({
    createWebSocketServer: () => {
      const server = createFakeServer(51_234 + servers.length);
      servers.push(server);
      return server;
    },
    crypto: createFakeCrypto(),
    onAgentInput: (input) => inputs.push(input),
    onStatusChange: (status) => statuses.push(status),
    commandTimeoutMs,
    orphanTimeoutMs,
    maxInFlightCommands,
    now,
    setTimer,
    clearTimer,
  });

  const createLease = async (leaseId, metadata = {}, guest = null) => {
    const started = await bridge.createLease({
      leaseId,
      metadata,
      onClosed: (event) => closed.push(event),
    });
    if (guest) bridge.bindLeaseGuest(leaseId, guest, { ownerWindowId: 42 });
    return started;
  };

  const connect = (started, { url, origin } = {}) => {
    const socket = createFakeSocket();
    const requestUrl = url ?? new URL(started.wsUrl).pathname;
    servers.at(-1).connect(socket, { url: requestUrl, origin });
    return socket;
  };

  return { bridge, createLease, connect, inputs, statuses, servers, closed };
};

const sendFrame = async (socket, frame, isBinary = false) => {
  socket.emit('message', Buffer.from(typeof frame === 'string' ? frame : JSON.stringify(frame)), isBinary);
  await flushPromises();
};

const attach = async (socket, id = 1) => {
  await sendFrame(socket, { id, method: 'Target.attachToTarget', params: { flatten: true } });
  return socket.sent.find((frame) => frame.id === id)?.result?.sessionId;
};

describe('parseBridgeFrame', () => {
  test('accepts a well-formed command and defaults params', () => {
    const parsed = parseBridgeFrame(JSON.stringify({ id: 1, method: 'Page.enable' }));
    expect(parsed.ok).toBe(true);
    expect(parsed.message).toEqual({ id: 1, method: 'Page.enable', params: {}, sessionId: null });
  });

  test('keeps a string sessionId', () => {
    const parsed = parseBridgeFrame(JSON.stringify({ id: 2, method: 'DOM.enable', sessionId: 'ABC' }));
    expect(parsed.message.sessionId).toBe('ABC');
  });

  test('rejects malformed, oversized, and mistyped frames', () => {
    expect(parseBridgeFrame(Buffer.from('x')).ok).toBe(false);
    expect(parseBridgeFrame('not json').ok).toBe(false);
    expect(parseBridgeFrame('[]').ok).toBe(false);
    expect(parseBridgeFrame(JSON.stringify({ method: 'Page.enable' })).ok).toBe(false);
    expect(parseBridgeFrame(JSON.stringify({ id: 1.5, method: 'Page.enable' })).ok).toBe(false);
    expect(parseBridgeFrame(JSON.stringify({ id: 1 })).ok).toBe(false);
    expect(parseBridgeFrame(JSON.stringify({ id: 1, method: 'X', params: [] })).ok).toBe(false);
    expect(parseBridgeFrame(JSON.stringify({ id: 1, method: 'X', sessionId: 5 })).ok).toBe(false);
    expect(parseBridgeFrame(`"${'a'.repeat(MAX_FRAME_BYTES + 1)}"`).ok).toBe(false);
  });
});

describe('bridge policy helpers', () => {
  test('retains the lifecycle blocklist', () => {
    expect(isBlockedBridgeMethod('Target.createTarget')).toBe(true);
    expect(isBlockedBridgeMethod('Target.closeTarget')).toBe(true);
    expect(isBlockedBridgeMethod('Browser.setDownloadBehavior')).toBe(true);
    expect(isBlockedBridgeMethod('Page.close')).toBe(true);
    expect(isBlockedBridgeMethod('Page.navigate')).toBe(false);
    expect(isBlockedBridgeMethod('Accessibility.getFullAXTree')).toBe(false);
  });

  test('only allows origin-less clients', () => {
    expect(isAllowedBridgeOrigin(undefined)).toBe(true);
    expect(isAllowedBridgeOrigin('')).toBe(true);
    expect(isAllowedBridgeOrigin('https://evil.example')).toBe(false);
    expect(isAllowedBridgeOrigin('null')).toBe(false);
  });

  test('describes input commands for the cursor overlay', () => {
    expect(describeAgentInput('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10, y: 20 }))
      .toEqual({ kind: 'move', x: 10, y: 20, button: null, clickCount: 0 });
    expect(describeAgentInput('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 2, button: 'left', clickCount: 1 }))
      .toEqual({ kind: 'down', x: 1, y: 2, button: 'left', clickCount: 1 });
    expect(describeAgentInput('Input.dispatchMouseEvent', { type: 'mouseReleased' }).kind).toBe('up');
    expect(describeAgentInput('Input.insertText', { text: 'hello' })).toEqual({ kind: 'text', length: 5 });
    expect(describeAgentInput('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a' }).kind).toBe('key');
    expect(describeAgentInput('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 3, y: 4 }] }))
      .toEqual({ kind: 'touch', x: 3, y: 4, touchType: 'touchStart' });
    expect(describeAgentInput('Page.navigate', {})).toBeNull();
  });
});

describe('multi-lease bridge lifecycle and routing', () => {
  test('awaits a real ephemeral listener before publishing its port', async () => {
    let listeningObserved = false;
    const bridge = createBrowserCdpBridge({
      createWebSocketServer: (options) => {
        const server = new WebSocketServer(options);
        server.on('listening', () => { listeningObserved = true; });
        return server;
      },
      crypto: createFakeCrypto(),
      orphanTimeoutMs: 5_000,
    });

    const started = await bridge.createLease({ leaseId: 'real-listener' });
    expect(listeningObserved).toBe(true);
    expect(started).toMatchObject({ ok: true, state: 'waiting_for_guest', leaseId: 'real-listener' });
    expect(started.port).toBeGreaterThan(0);
    expect(started.wsUrl).not.toContain(':0/');
    expect(bridge.status()).toMatchObject({ state: 'ready', running: true, leaseCount: 1 });
    bridge.closeAll('test_complete');
    expect(bridge.isRunning).toBe(false);
  });

  test('creates before guest binding and keeps tokens out of statuses and callbacks', async () => {
    const harness = createHarness();
    const started = await harness.createLease('lease-a', {
      rootSessionId: 'root-a',
      leaseToken: 'must-not-leak',
      wsUrl: 'must-not-leak',
    });
    expect(started.state).toBe('waiting_for_guest');
    expect(harness.bridge.getLeaseStatus('lease-a')).toMatchObject({
      state: 'waiting_for_guest',
      guestAttached: false,
      metadata: { rootSessionId: 'root-a' },
    });

    const guest = createFakeGuest({ name: 'a' });
    expect(harness.bridge.bindLeaseGuest('lease-a', guest, { ownerWindowId: 7 })).toMatchObject({
      ok: true,
      state: 'ready',
      guestAttached: true,
      ownerWindowId: 7,
    });
    harness.bridge.touchLease('lease-a', { title: 'Updated', token: 'still-private' });
    expect(harness.bridge.getLeaseStatus('lease-a').metadata).toEqual({ rootSessionId: 'root-a', title: 'Updated' });
    expect(JSON.stringify(harness.bridge.status())).not.toContain(new URL(started.wsUrl).pathname.split('/').at(-1));

    harness.bridge.closeLease('lease-a', 'explicit_release');
    expect(harness.closed).toEqual([{ leaseId: 'lease-a', reason: 'explicit_release' }]);
    expect(JSON.stringify(harness.closed)).not.toContain('must-not-leak');
  });

  test('routes concurrent clients to their own bound guests', async () => {
    const harness = createHarness();
    const guestA = createFakeGuest({ name: 'a', sendCommand: () => ({ source: 'a' }) });
    const guestB = createFakeGuest({ name: 'b', sendCommand: () => ({ source: 'b' }) });
    const startedA = await harness.createLease('lease-a', {}, guestA);
    const startedB = await harness.createLease('lease-b', {}, guestB);
    expect(harness.servers).toHaveLength(1);

    const socketA = harness.connect(startedA);
    const socketB = harness.connect(startedB);
    const sessionA = await attach(socketA);
    const sessionB = await attach(socketB);
    await sendFrame(socketA, { id: 2, method: 'DOM.enable', params: { side: 'a' }, sessionId: sessionA });
    await sendFrame(socketB, { id: 2, method: 'Page.enable', params: { side: 'b' }, sessionId: sessionB });

    expect(guestA.debugger.commands).toEqual([{ method: 'DOM.enable', params: { side: 'a' } }]);
    expect(guestB.debugger.commands).toEqual([{ method: 'Page.enable', params: { side: 'b' } }]);
    expect(socketA.sent.find((frame) => frame.id === 2)).toEqual({ id: 2, result: { source: 'a' }, sessionId: sessionA });
    expect(socketB.sent.find((frame) => frame.id === 2)).toEqual({ id: 2, result: { source: 'b' }, sessionId: sessionB });
  });

  test('isolates capability paths and rejects browser origins without disturbing leases', async () => {
    const harness = createHarness();
    const startedA = await harness.createLease('lease-a', {}, createFakeGuest({ name: 'a' }));
    await harness.createLease('lease-b', {}, createFakeGuest({ name: 'b' }));

    const badToken = harness.connect(startedA, { url: '/devtools/page/not-a-token' });
    const tokenWithQuery = harness.connect(startedA, { url: `${new URL(startedA.wsUrl).pathname}?steal=1` });
    const browserOrigin = harness.connect(startedA, { origin: 'https://evil.example' });
    expect(badToken.closed?.code).toBe(1008);
    expect(tokenWithQuery.closed?.code).toBe(1008);
    expect(browserOrigin.closed?.code).toBe(1008);
    expect(harness.bridge.status()).toMatchObject({ leaseCount: 2, clients: 0 });

    const valid = harness.connect(startedA);
    expect(valid.closed).toBeNull();
    expect(harness.bridge.getLeaseStatus('lease-a').state).toBe('connected');
    expect(harness.bridge.getLeaseStatus('lease-b').state).toBe('ready');
  });

  test('allows one client per lease while other leases remain connectable', async () => {
    const harness = createHarness();
    const startedA = await harness.createLease('lease-a', {}, createFakeGuest({ name: 'a' }));
    const startedB = await harness.createLease('lease-b', {}, createFakeGuest({ name: 'b' }));
    const firstA = harness.connect(startedA);
    const secondA = harness.connect(startedA);
    const firstB = harness.connect(startedB);

    expect(firstA.closed).toBeNull();
    expect(secondA.closed).toEqual({ code: 1013, reason: 'lease already in use' });
    expect(firstB.closed).toBeNull();
    expect(harness.bridge.status().clients).toBe(2);
  });

  test('keeps the in-flight cap independent for each lease', async () => {
    const pendingA = [];
    const pendingB = [];
    const harness = createHarness({ maxInFlightCommands: 2 });
    const guestA = createFakeGuest({
      name: 'a',
      sendCommand: () => new Promise((resolve) => pendingA.push(resolve)),
    });
    const guestB = createFakeGuest({
      name: 'b',
      sendCommand: () => new Promise((resolve) => pendingB.push(resolve)),
    });
    const startedA = await harness.createLease('lease-a', {}, guestA);
    const startedB = await harness.createLease('lease-b', {}, guestB);
    const socketA = harness.connect(startedA);
    const socketB = harness.connect(startedB);
    const sessionA = await attach(socketA);
    const sessionB = await attach(socketB);

    await sendFrame(socketA, { id: 2, method: 'Runtime.evaluate', params: { expression: '1' }, sessionId: sessionA });
    await sendFrame(socketA, { id: 3, method: 'Runtime.evaluate', params: { expression: '2' }, sessionId: sessionA });
    await sendFrame(socketA, { id: 4, method: 'Runtime.evaluate', params: { expression: '3' }, sessionId: sessionA });
    await sendFrame(socketB, { id: 2, method: 'Runtime.evaluate', params: { expression: '4' }, sessionId: sessionB });

    expect(socketA.sent.find((frame) => frame.id === 4)?.error?.message).toContain('Too many');
    expect(guestA.debugger.commands).toHaveLength(2);
    expect(guestB.debugger.commands).toHaveLength(1);
    expect(harness.bridge.getLeaseStatus('lease-a').inFlight).toBe(2);
    expect(harness.bridge.getLeaseStatus('lease-b').inFlight).toBe(1);
    for (const resolve of [...pendingA, ...pendingB]) resolve({});
    await flushPromises();
  });

  test('tags input events with the originating lease', async () => {
    const harness = createHarness();
    const startedA = await harness.createLease('lease-a', {}, createFakeGuest({ name: 'a' }));
    const startedB = await harness.createLease('lease-b', {}, createFakeGuest({ name: 'b' }));
    const socketA = harness.connect(startedA);
    const socketB = harness.connect(startedB);
    const sessionA = await attach(socketA);
    const sessionB = await attach(socketB);

    await sendFrame(socketA, {
      id: 2,
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mousePressed', x: 24, y: 76, button: 'left', clickCount: 1 },
      sessionId: sessionA,
    });
    await sendFrame(socketB, { id: 2, method: 'Input.insertText', params: { text: 'hello' }, sessionId: sessionB });

    expect(harness.inputs).toEqual([
      { leaseId: 'lease-a', kind: 'down', x: 24, y: 76, button: 'left', clickCount: 1 },
      { leaseId: 'lease-b', kind: 'text', length: 5 },
    ]);
  });

  test('supports the agent-browser 0.33.2 root probe and setAutoAttach fallback', async () => {
    const guest = createFakeGuest({
      name: 'handshake',
      sendCommand: (method) => {
        if (method === 'Target.setAutoAttach' || method === 'Page.navigate') throw new Error(`rejected ${method}`);
        return { value: 42 };
      },
    });
    const harness = createHarness();
    const started = await harness.createLease('lease-handshake', {}, guest);
    const socket = harness.connect(started);

    await sendFrame(socket, { id: 1, method: 'Runtime.evaluate', params: { expression: 'document.readyState' } });
    expect(socket.sent.find((frame) => frame.id === 1)).toEqual({ id: 1, result: { value: 42 } });
    await sendFrame(socket, { id: 2, method: 'Target.setDiscoverTargets', params: { discover: true } });
    await sendFrame(socket, { id: 3, method: 'Target.getTargets' });
    const targetId = socket.sent.find((frame) => frame.id === 3).result.targetInfos[0].targetId;
    await sendFrame(socket, { id: 4, method: 'Target.attachToTarget', params: { flatten: true, targetId } });
    const sessionId = socket.sent.find((frame) => frame.id === 4).result.sessionId;
    await sendFrame(socket, {
      id: 5,
      method: 'Target.setAutoAttach',
      params: { autoAttach: true, flatten: true },
      sessionId,
    });
    await sendFrame(socket, { id: 6, method: 'Page.navigate', params: { url: 'https://example.com' }, sessionId });

    expect(socket.sent.find((frame) => frame.id === 5)).toEqual({ id: 5, result: {}, sessionId });
    expect(guest.debugger.commands.some((entry) => entry.method === 'Target.setAutoAttach')).toBe(false);
    expect(socket.sent.find((frame) => frame.id === 6)?.error?.message).toBe('rejected Page.navigate');
    expect(socket.sent.find((frame) => frame.id === 6)?.sessionId).toBe(sessionId);
  });

  test('prevents a leased page from escaping through browser-level CDP domains', async () => {
    const harness = createHarness();
    const guest = createFakeGuest({ name: 'isolated-target' });
    const started = await harness.createLease('lease-isolated-target', {}, guest);
    const socket = harness.connect(started);
    const sessionId = await attach(socket);

    for (const [id, method, params] of [
      [2, 'Target.getTargets', {}],
      [3, 'Target.attachToTarget', { targetId: 'some-other-electron-target', flatten: false }],
      [4, 'Target.sendMessageToTarget', { sessionId: 'foreign', message: '{}' }],
      [5, 'Browser.getWindowForTarget', { targetId: 'some-other-electron-target' }],
      [6, 'Browser.setWindowBounds', { windowId: 1, bounds: { windowState: 'minimized' } }],
      [7, 'SystemInfo.getInfo', {}],
      [8, 'Memory.startSampling', {}],
      [9, 'Security.setIgnoreCertificateErrors', { ignore: true }],
    ]) {
      await sendFrame(socket, { id, method, params, sessionId });
      expect(socket.sent.find((frame) => frame.id === id)?.error?.message).toContain('not permitted');
    }

    guest.debugger.emit('message', {}, 'Target.targetCreated', {
      targetInfo: { targetId: 'foreign', type: 'page', url: 'https://private.example/' },
    });
    guest.debugger.emit('message', {}, 'Browser.downloadWillBegin', {
      guid: 'foreign-download',
      url: 'https://private.example/file',
    });
    expect(guest.debugger.commands).toHaveLength(0);
    expect(socket.sent.some((frame) => frame.method === 'Target.targetCreated')).toBe(false);
    expect(socket.sent.some((frame) => frame.method === 'Browser.downloadWillBegin')).toBe(false);
  });

  test('forwards debugger events only to the owning client', async () => {
    const harness = createHarness();
    const guestA = createFakeGuest({ name: 'a' });
    const guestB = createFakeGuest({ name: 'b' });
    const startedA = await harness.createLease('lease-a', {}, guestA);
    const startedB = await harness.createLease('lease-b', {}, guestB);
    const socketA = harness.connect(startedA);
    const socketB = harness.connect(startedB);
    const sessionA = await attach(socketA);
    await attach(socketB);

    guestA.debugger.emit('message', {}, 'Page.frameNavigated', { frame: { id: 'a' } });
    expect(socketA.sent.find((frame) => frame.method === 'Page.frameNavigated')).toEqual({
      method: 'Page.frameNavigated',
      params: { frame: { id: 'a' } },
      sessionId: sessionA,
    });
    expect(socketB.sent.find((frame) => frame.method === 'Page.frameNavigated')).toBeUndefined();
  });

  test('rejects blocked, unknown-session, session-less, binary, and malformed commands', async () => {
    const harness = createHarness();
    const guestA = createFakeGuest({ name: 'a' });
    const guestB = createFakeGuest({ name: 'b' });
    const startedA = await harness.createLease('lease-a', {}, guestA);
    const startedB = await harness.createLease('lease-b', {}, guestB);
    const socketA = harness.connect(startedA);
    const socketB = harness.connect(startedB);

    await sendFrame(socketA, { id: 1, method: 'Target.createTarget', params: { url: 'https://evil/' } });
    await sendFrame(socketA, { id: 2, method: 'DOM.enable', sessionId: 'nope' });
    await sendFrame(socketA, { id: 3, method: 'DOM.enable' });
    expect(socketA.sent.find((frame) => frame.id === 1).error.message).toContain('not permitted');
    expect(socketA.sent.find((frame) => frame.id === 2).error.message).toContain('Unknown sessionId');
    expect(socketA.sent.find((frame) => frame.id === 3).error.message).toContain('require a sessionId');
    expect(guestA.debugger.commands).toHaveLength(0);

    await sendFrame(socketA, '{}', true);
    expect(socketA.closed?.code).toBe(1003);
    expect(harness.bridge.getLeaseStatus('lease-a').state).toBe('not_found');
    expect(harness.bridge.getLeaseStatus('lease-b').state).toBe('connected');
    await sendFrame(socketB, 'not json');
    expect(socketB.closed?.code).toBe(1008);
  });

  test('socket closure removes only its lease and the final lease stops the server', async () => {
    const harness = createHarness();
    const startedA = await harness.createLease('lease-a', {}, createFakeGuest({ name: 'a' }));
    const startedB = await harness.createLease('lease-b', {}, createFakeGuest({ name: 'b' }));
    const socketA = harness.connect(startedA);
    const socketB = harness.connect(startedB);
    socketA.peerClose();

    expect(harness.bridge.getLeaseStatus('lease-a').state).toBe('not_found');
    expect(harness.bridge.getLeaseStatus('lease-b').state).toBe('connected');
    expect(harness.bridge.isRunning).toBe(true);
    expect(harness.servers[0].closeCalls).toBe(0);

    socketB.peerClose();
    expect(harness.bridge.status()).toMatchObject({ running: false, leaseCount: 0, clients: 0 });
    expect(harness.servers[0].closeCalls).toBe(1);
  });

  test('debugger detach and guest destruction clean up only their lease', async () => {
    const harness = createHarness();
    const guestA = createFakeGuest({ name: 'a' });
    const guestB = createFakeGuest({ name: 'b' });
    const startedA = await harness.createLease('lease-a', {}, guestA);
    await harness.createLease('lease-b', {}, guestB);
    const socketA = harness.connect(startedA);

    guestA.debugger.emit('detach', {}, 'replaced_with_devtools');
    expect(socketA.closed?.code).toBe(1001);
    expect(harness.closed.at(-1)).toEqual({ leaseId: 'lease-a', reason: 'debugger_detached' });
    expect(harness.bridge.getLeaseStatus('lease-b').state).toBe('ready');

    guestB.destroy();
    expect(harness.closed.at(-1)).toEqual({ leaseId: 'lease-b', reason: 'guest_closed' });
    expect(harness.bridge.isRunning).toBe(false);
  });

  test('debugger conflict closes only the affected lease', async () => {
    const harness = createHarness();
    const conflictGuest = createFakeGuest({ name: 'conflict', attachError: new Error('already attached') });
    const startedA = await harness.createLease('lease-a', {}, conflictGuest);
    await harness.createLease('lease-b', {}, createFakeGuest({ name: 'b' }));
    const socketA = harness.connect(startedA);

    expect(socketA.closed).toEqual({ code: 1011, reason: 'debugger_conflict' });
    expect(harness.bridge.getLeaseStatus('lease-a').state).toBe('not_found');
    expect(harness.bridge.getLeaseStatus('lease-b').state).toBe('ready');
    expect(harness.bridge.isRunning).toBe(true);
  });

  test('explicit release fences stale socket and command completions from a replacement', async () => {
    let resolveOldCommand;
    const oldGuest = createFakeGuest({
      name: 'old',
      sendCommand: () => new Promise((resolve) => { resolveOldCommand = resolve; }),
    });
    const harness = createHarness();
    const first = await harness.createLease('reused-id', {}, oldGuest);
    const oldSocket = harness.connect(first);
    const oldSession = await attach(oldSocket);
    await sendFrame(oldSocket, { id: 2, method: 'Runtime.evaluate', params: {}, sessionId: oldSession });
    expect(harness.bridge.getLeaseStatus('reused-id').inFlight).toBe(1);

    harness.bridge.closeLease('reused-id', 'explicit_release');
    const replacementGuest = createFakeGuest({ name: 'replacement' });
    const replacement = await harness.createLease('reused-id', {}, replacementGuest);
    const replacementSocket = harness.connect(replacement);
    expect(harness.servers).toHaveLength(2);

    oldSocket.emit('close', 1000, 'stale close');
    resolveOldCommand({ stale: true });
    await flushPromises();

    expect(harness.bridge.getLeaseStatus('reused-id').state).toBe('connected');
    expect(replacementSocket.sent.some((frame) => frame.stale || frame.result?.stale)).toBe(false);
    expect(replacementGuest.debugger.commands).toHaveLength(0);
  });

  test('orphan reclamation is per lease and never expires an in-flight command', async () => {
    let resolvePending;
    const pendingGuest = createFakeGuest({
      name: 'pending',
      sendCommand: () => new Promise((resolve) => { resolvePending = resolve; }),
    });
    const harness = createHarness({ orphanTimeoutMs: 35, commandTimeoutMs: 500 });
    await harness.createLease('idle', {}, createFakeGuest({ name: 'idle' }));
    const pendingStart = await harness.createLease('pending', {}, pendingGuest);
    const pendingSocket = harness.connect(pendingStart);
    const pendingSession = await attach(pendingSocket);
    await sendFrame(pendingSocket, { id: 2, method: 'Runtime.evaluate', params: {}, sessionId: pendingSession });

    await wait(55);
    expect(harness.bridge.getLeaseStatus('idle').state).toBe('not_found');
    expect(harness.bridge.getLeaseStatus('pending').state).toBe('connected');
    expect(harness.bridge.getLeaseStatus('pending').inFlight).toBe(1);

    resolvePending({});
    await flushPromises();
    await wait(15);
    expect(harness.bridge.getLeaseStatus('pending').state).toBe('connected');
    await wait(35);
    expect(harness.bridge.getLeaseStatus('pending').state).toBe('not_found');
    expect(harness.closed.at(-1)).toEqual({ leaseId: 'pending', reason: 'orphan_timeout' });
    expect(harness.bridge.isRunning).toBe(false);
  });

  test('presentation metadata cannot extend an orphan lease', async () => {
    const clock = createFakeClock();
    const harness = createHarness({
      orphanTimeoutMs: 40,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    await harness.createLease('metadata-churn', {}, createFakeGuest({ name: 'metadata-churn' }));

    clock.advance(15);
    expect(harness.bridge.updateLeaseMetadata('metadata-churn', { title: 'frame 1' }).ok).toBe(true);
    clock.advance(15);
    expect(harness.bridge.updateLeaseMetadata('metadata-churn', { title: 'frame 2' }).ok).toBe(true);
    clock.advance(10);

    expect(harness.bridge.getLeaseStatus('metadata-churn').state).toBe('not_found');
    expect(harness.closed.at(-1)).toEqual({ leaseId: 'metadata-churn', reason: 'orphan_timeout' });
  });

  test('closeAll releases every lease and stops the shared server', async () => {
    const harness = createHarness();
    const started = await harness.createLease('lease-a', {}, createFakeGuest({ name: 'a' }));
    const socket = harness.connect(started);
    await harness.createLease('lease-b', {}, createFakeGuest({ name: 'b' }));

    expect(harness.bridge.closeAll('setting_disabled')).toBe(2);
    expect(socket.closed).toEqual({ code: 1001, reason: 'setting_disabled' });
    expect(harness.closed).toEqual([
      { leaseId: 'lease-a', reason: 'setting_disabled' },
      { leaseId: 'lease-b', reason: 'setting_disabled' },
    ]);
    expect(harness.bridge.status()).toMatchObject({ state: 'stopped', running: false, leaseCount: 0 });
    expect(harness.servers[0].closeCalls).toBe(1);
  });
});
