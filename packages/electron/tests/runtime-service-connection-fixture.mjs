import assert from 'node:assert/strict';

import { createRuntimeServiceConnection } from '../runtime-service-connection.mjs';

export const APP_VERSION = '2.1.3';

export const serviceDescriptor = (overrides = {}) => ({
  version: 1,
  instanceId: '11111111-1111-4111-8111-111111111111',
  pid: 4242,
  port: 57123,
  protocolVersion: 2,
  health: 'healthy',
  ownerGeneration: 3,
  appVersion: APP_VERSION,
  ...overrides,
});

export const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

// Lets queued promise continuations run so late completions settle.
export const settle = async () => {
  for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

export const okResponse = (body, headers = {}) => new Response(JSON.stringify(body), {
  status: 200, headers: { 'Content-Type': 'application/json', ...headers },
});

// An owner over recorded fakes. `descriptors` is read in order (the last one
// repeats); `hold(kind, port)` may return a deferred that a matching request
// waits on, ignoring its abort signal, as a response already in flight would.
export const connectionFixture = ({ descriptors = [serviceDescriptor()], hold = () => null, overrides = {} } = {}) => {
  const state = { runtimeServiceClient: false, sidecarUrl: null, desktopHostBroker: null, desktopHostLeaseRefreshTimer: null };
  const calls = [], requests = [], timers = [], brokers = [], warnings = [], loads = [], windows = [];
  const byPort = new Map(descriptors.map((descriptor) => [descriptor.port, descriptor]));
  let reads = 0;
  const fetch = async (url, options = {}) => {
    const { pathname, port } = new URL(url);
    const kind = pathname === '/auth/runtime-service-bootstrap' ? 'bootstrap'
      : pathname === '/api/runtime-service/desktop-host' ? 'lease'
        : pathname.startsWith('/api/runtime-service/desktop-host/') ? 'release'
          : pathname === '/api/runtime-service/prepare-update' ? 'prepare-update' : 'other';
    const request = { kind, url, method: options.method, signal: options.signal };
    requests.push(request);
    const held = hold(kind, Number(port), request);
    if (held) return held.promise;
    if (kind === 'bootstrap') return okResponse({}, { 'set-cookie': 'devryan_runtime_service=fixture; Path=/' });
    if (kind === 'lease') {
      const descriptor = byPort.get(Number(port));
      return okResponse({
        instanceId: descriptor.instanceId, ownerGeneration: descriptor.ownerGeneration, protocolVersion: descriptor.protocolVersion,
      });
    }
    return okResponse({});
  };
  const connection = createRuntimeServiceConnection({
    state,
    appVersion: APP_VERSION,
    fetch,
    dataDirectory: () => '/data',
    readDescriptor: async () => {
      const descriptor = descriptors[Math.min(reads, descriptors.length - 1)];
      reads += 1;
      return descriptor;
    },
    assertDescriptorOwner: async () => { calls.push('owner'); },
    isProtocolSupported: () => true,
    buildLocalUrl: (port) => `http://127.0.0.1:${port}/`,
    waitForHealth: async () => { calls.push('health'); return true; },
    unsealBootstrapToken: () => 'fixture-token',
    setRuntimeServiceCookie: async (url) => { calls.push(['cookie', url]); },
    createBroker: async () => {
      const broker = { leaseId: `lease-${brokers.length + 1}`, port: 44001, token: 'fixture', capabilities: [], closed: false };
      broker.close = async () => { broker.closed = true; };
      brokers.push(broker);
      calls.push('broker');
      return broker;
    },
    recordAppVersion: async () => { calls.push('record'); },
    getRegistration: () => assert.fail('No registration access'),
    waitForOwnerStopped: async () => assert.fail('No owner wait'),
    terminateProcess: async () => assert.fail('No signal'),
    getWindows: () => windows,
    log: { warn: (...args) => warnings.push(args) },
    setInterval: (callback, ms) => {
      const timer = { callback, ms, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearInterval: (timer) => { timer.cleared = true; },
    ...overrides,
  });
  const window = (url) => {
    const fixture = {
      isDestroyed: () => false,
      webContents: { getURL: () => url },
      loadURL: async (next) => { loads.push(next); },
    };
    windows.push(fixture);
    return fixture;
  };
  const activeTimers = () => timers.filter((timer) => !timer.cleared);
  // Detach the way main.mjs callers do: stop the broker, then drop the client state.
  const detach = async () => {
    await connection.disconnect({ notifyService: false });
    state.runtimeServiceClient = false;
    state.sidecarUrl = null;
  };
  return {
    connection, state, calls, requests, timers, brokers, warnings, loads, window, activeTimers, detach,
    reads: () => reads,
  };
};
