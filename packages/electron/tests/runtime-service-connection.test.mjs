import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import test, { describe } from 'node:test';
import { bootstrapRuntimeServiceSession, registerDesktopHostLease } from '../runtime-service-connection.mjs';
import { connectionFixture, deferred, okResponse, serviceDescriptor, settle } from './runtime-service-connection-fixture.mjs';

const mainSource = await fs.readFile(new URL('../main.mjs', import.meta.url), 'utf8');

const withServer = async (handler, run) => {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(origin);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
};

const broker = { leaseId: 'fixture', port: 44001, token: 'fixture', capabilities: ['browser_observation'] };
const bootstrapWith = (fetchImpl, options) => bootstrapRuntimeServiceSession({
  fetch: fetchImpl, descriptor: {}, unsealBootstrapToken: () => 'fixture', ...options,
});

describe('desktop-host requests', () => {
  test('bootstrap headers that never arrive abort against the remaining connection deadline', async () => {
    let cookieWrites = 0, signal;
    await withServer(() => {}, async origin => {
      await assert.rejects(bootstrapWith((url, options) => {
        signal = options.signal;
        return fetch(url, options);
      }, { url: origin, deadline: Date.now() + 100, setRuntimeServiceCookie: async () => { cookieWrites++; } }),
      error => error.name === 'TimeoutError');
      assert.equal(signal.aborted, true);
      assert.equal(cookieWrites, 0);
    });
  });

  test('lease JSON bodies that never finish abort, including the compatibility fallback request', async () => {
    for (const compatibilityFallback of [false, true]) {
      const signals = [];
      let requests = 0;
      await withServer((_req, res) => {
        requests++;
        res.writeHead(compatibilityFallback && requests === 1 ? 400 : 200, { 'Content-Type': 'application/json' });
        if (compatibilityFallback && requests === 1) res.end('{}');
        else res.flushHeaders();
      }, async origin => {
        await assert.rejects(registerDesktopHostLease({ fetch: (url, options) => {
          signals.push(options.signal);
          return fetch(url, options);
        }, url: origin, broker, deadline: Date.now() + 150 }),
        error => error.name === 'AbortError' || error.name === 'TimeoutError');
        assert.equal(requests, compatibilityFallback ? 2 : 1);
        assert.ok(signals.every(signal => signal === signals[0] && signal.aborted));
      });
    }
  });

  test('an already expired deadline refuses bootstrap and lease requests before transmission', async () => {
    const refuse = () => assert.fail('No HTTP request after the retry deadline');
    await assert.rejects(bootstrapWith(refuse, {
      url: 'http://127.0.0.1:44001', deadline: Date.now() - 1, setRuntimeServiceCookie: () => assert.fail('No cookie write'),
    }), { code: 'runtime_service_connection_timeout' });
    await assert.rejects(registerDesktopHostLease({
      fetch: refuse, url: 'http://127.0.0.1:44001', broker, deadline: Date.now() - 1,
    }), { code: 'runtime_service_connection_timeout' });
  });

  test('an aborted connection aborts its requests and installs no renderer session', async () => {
    const connection = new AbortController();
    let signal, cookieWrites = 0;
    const response = deferred();
    const pending = bootstrapWith((_url, options) => { signal = options.signal; return response.promise; }, {
      url: 'http://127.0.0.1:44001', signal: connection.signal, setRuntimeServiceCookie: async () => { cookieWrites++; },
    });
    connection.abort(Object.assign(new Error('replaced'), { code: 'runtime_service_connection_superseded' }));
    assert.equal(signal.aborted, true);
    response.resolve(okResponse({}, { 'set-cookie': 'devryan_runtime_service=fixture' }));
    await assert.rejects(pending, { code: 'runtime_service_connection_superseded' });
    assert.equal(cookieWrites, 0);
  });
});

test('health polling cannot spend a full request or sleep past its remaining deadline', async () => {
  let elapsed = 0;
  const requests = [], waits = [];
  const healthSource = mainSource.slice(mainSource.indexOf('const waitForHealth = async'),
    mainSource.indexOf('const pickUnusedPort = async'));
  const health = new Function('fetch', 'buildHealthUrl', 'Date', 'AbortSignal', 'setTimeout',
    `${healthSource}\nreturn waitForHealth;`)(
    async (_url, { signal }) => { requests.push(signal); elapsed += signal; throw Error('not ready'); },
    url => url, { now: () => elapsed }, { timeout: ms => ms },
    (resolve, ms) => { waits.push(ms); elapsed += ms; resolve(); },
  );
  assert.equal(await health('http://127.0.0.1:44001', 37, 100), false);
  assert.deepEqual(requests, [37]);
  assert.deepEqual(waits, [0]);
  assert.equal(elapsed, 37);
});

describe('connection identity', () => {
  const first = serviceDescriptor({ port: 57101 });
  const replacement = serviceDescriptor({ instanceId: '22222222-2222-4222-8222-222222222222', port: 57102, ownerGeneration: 4 });

  test('an attached connection publishes the service, arms one 10 s refresh and refreshes the same lease', async () => {
    const fixture = connectionFixture({ descriptors: [first] });
    assert.equal(await fixture.connection.connect(), 'http://127.0.0.1:57101');
    assert.equal(fixture.state.runtimeServiceClient, true);
    assert.equal(fixture.state.sidecarUrl, 'http://127.0.0.1:57101');
    assert.deepEqual(fixture.activeTimers().map(timer => timer.ms), [10_000]);
    fixture.activeTimers()[0].callback();
    await settle();
    assert.deepEqual(fixture.requests.filter(request => request.kind === 'lease').map(request => request.url),
      ['http://127.0.0.1:57101/api/runtime-service/desktop-host', 'http://127.0.0.1:57101/api/runtime-service/desktop-host']);
    assert.equal(fixture.warnings.length, 0);
    assert.equal(fixture.brokers.length, 1);
  });

  test('a successful refresh still in flight at disconnect is aborted and re-arms nothing', async () => {
    let held = null;
    const fixture = connectionFixture({ descriptors: [first], hold: kind => (kind === 'lease' && held) || null });
    await fixture.connection.connect();
    held = deferred();
    fixture.activeTimers()[0].callback();
    const refresh = fixture.requests.at(-1);
    await fixture.detach();
    assert.equal(refresh.signal.aborted, true, 'disconnect must abort the in-flight lease refresh');
    held.resolve(okResponse({ instanceId: first.instanceId, ownerGeneration: first.ownerGeneration, protocolVersion: 2 }));
    await settle();
    assert.equal(fixture.state.runtimeServiceClient, false);
    assert.equal(fixture.state.sidecarUrl, null);
    assert.deepEqual(fixture.activeTimers(), []);
    assert.equal(fixture.state.desktopHostBroker, null);
    assert.equal(fixture.reads(), 1);
    assert.deepEqual(fixture.warnings, []);
  });

  test('a refresh that fails after disconnect does not reconnect', async () => {
    let held = null;
    const fixture = connectionFixture({ descriptors: [first, replacement], hold: kind => (kind === 'lease' && held) || null });
    await fixture.connection.connect();
    fixture.window('http://127.0.0.1:57101/chat');
    held = deferred();
    fixture.activeTimers()[0].callback();
    await fixture.detach();
    held.reject(Object.assign(new Error('lease refused'), { code: 'desktop_host_registration_failed' }));
    held = null;
    await settle();
    assert.equal(fixture.reads(), 1, 'a disconnected connection must not look for a replacement owner');
    assert.equal(fixture.state.runtimeServiceClient, false);
    assert.equal(fixture.state.sidecarUrl, null);
    assert.deepEqual(fixture.activeTimers(), []);
    assert.equal(fixture.brokers.length, 1);
    assert.deepEqual(fixture.loads, []);
    assert.deepEqual(fixture.warnings, []);
  });

  test('a failed refresh of the current connection reconnects to the replacement and reloads its windows', async () => {
    let failRefresh = false;
    const fixture = connectionFixture({
      descriptors: [first, replacement, replacement],
      hold: (kind, port) => {
        if (kind !== 'lease' || port !== first.port || !failRefresh) return null;
        const refused = deferred();
        refused.resolve(new Response('{}', { status: 409 }));
        return refused;
      },
    });
    await fixture.connection.connect();
    fixture.window('http://127.0.0.1:57101/chat?session=1');
    fixture.window('https://example.test/other');
    failRefresh = true;
    fixture.activeTimers()[0].callback();
    await settle();
    assert.equal(fixture.state.sidecarUrl, 'http://127.0.0.1:57102');
    assert.equal(fixture.state.runtimeServiceClient, true);
    assert.deepEqual(fixture.loads, ['http://127.0.0.1:57102/chat?session=1']);
    assert.equal(fixture.activeTimers().length, 1);
    assert.equal(fixture.brokers.length, 1, 'the reconnect keeps the existing broker');
    assert.equal(fixture.warnings[0][0], '[runtime-service] desktop host lease refresh failed');
    assert.deepEqual(fixture.warnings[0][1], { code: 'desktop_host_registration_failed', rejection: { status: 409, code: null } });
  });

  test('a deferred reconnect keeps refreshing the replaced owner so the next failure retries', async () => {
    let failRefresh = false, healthy = true;
    const fixture = connectionFixture({
      descriptors: [first, replacement],
      hold: (kind, port) => {
        if (kind !== 'lease' || port !== first.port || !failRefresh) return null;
        const refused = deferred();
        refused.resolve(new Response('{}', { status: 409 }));
        return refused;
      },
      overrides: { waitForHealth: async () => healthy },
    });
    await fixture.connection.connect();
    failRefresh = true;
    healthy = false;
    fixture.activeTimers()[0].callback();
    await settle();
    assert.equal(fixture.warnings.at(-1)[0], '[runtime-service] reconnect deferred');
    assert.equal(fixture.warnings.at(-1)[1].code, 'runtime_service_unavailable');
    assert.equal(fixture.activeTimers().length, 1);
    healthy = true;
    fixture.activeTimers()[0].callback();
    await settle();
    assert.equal(fixture.state.sidecarUrl, 'http://127.0.0.1:57102');
  });

  test('disconnect during a reconnect aborts it before it publishes, re-arms, opens a broker or reloads', async () => {
    let failRefresh = false, heldBootstrap = null;
    const fixture = connectionFixture({
      descriptors: [first, replacement, replacement],
      hold: (kind, port) => {
        if (kind === 'lease' && port === first.port && failRefresh) {
          const refused = deferred();
          refused.resolve(new Response('{}', { status: 409 }));
          return refused;
        }
        if (kind === 'bootstrap' && port === replacement.port) return (heldBootstrap = deferred());
        return null;
      },
    });
    await fixture.connection.connect();
    fixture.window('http://127.0.0.1:57101/chat');
    failRefresh = true;
    fixture.activeTimers()[0].callback();
    await settle();
    assert.ok(heldBootstrap, 'the reconnect reached the replacement handshake');
    const bootstrap = fixture.requests.find(request => request.kind === 'bootstrap' && request.url.includes(':57102/'));
    await fixture.detach();
    assert.equal(bootstrap.signal.aborted, true, 'disconnect must abort the in-flight reconnect handshake');
    heldBootstrap.resolve(okResponse({}, { 'set-cookie': 'devryan_runtime_service=fixture' }));
    await settle();
    assert.equal(fixture.state.runtimeServiceClient, false);
    assert.equal(fixture.state.sidecarUrl, null);
    assert.equal(fixture.state.desktopHostBroker, null);
    assert.deepEqual(fixture.activeTimers(), []);
    assert.equal(fixture.brokers.length, 1, 'no broker is opened after disconnect');
    assert.deepEqual(fixture.loads, []);
    assert.ok(!fixture.calls.some(call => Array.isArray(call) && call[1] === 'http://127.0.0.1:57102'));
    assert.ok(!fixture.warnings.some(([message]) => message === '[runtime-service] reconnect deferred'));
  });

  test('a connection replaced during bootstrap rejects as superseded and leaves the replacement attached', async () => {
    let heldBootstrap = null;
    const fixture = connectionFixture({
      descriptors: [first, replacement],
      hold: (kind, port) => (kind === 'bootstrap' && port === first.port ? (heldBootstrap = deferred()) : null),
    });
    const stale = fixture.connection.connect();
    await settle();
    assert.ok(heldBootstrap, 'the first connection reached its handshake');
    const staleBootstrap = fixture.requests.find(request => request.kind === 'bootstrap');
    assert.equal(await fixture.connection.connect(), 'http://127.0.0.1:57102');
    assert.equal(staleBootstrap.signal.aborted, true, 'replacement must abort the earlier handshake');
    heldBootstrap.resolve(okResponse({}, { 'set-cookie': 'devryan_runtime_service=fixture' }));
    await assert.rejects(stale, error => error.code === 'runtime_service_connection_superseded' && error.retryable === false);
    assert.equal(fixture.state.sidecarUrl, 'http://127.0.0.1:57102');
    assert.equal(fixture.state.runtimeServiceClient, true);
    assert.equal(fixture.activeTimers().length, 1);
    assert.equal(fixture.brokers.length, 1);
    assert.equal(fixture.state.desktopHostBroker, fixture.brokers[0]);
    assert.equal(fixture.brokers[0].closed, false);
    assert.ok(!fixture.calls.some(call => Array.isArray(call) && call[1] === 'http://127.0.0.1:57101'));
    assert.ok(!fixture.requests.some(request => request.kind === 'lease' && request.url.includes(':57101/')));
  });

  test('a connection replaced while its broker opens closes that broker and keeps the replacement one', async () => {
    const opening = [];
    const createBroker = async () => {
      const gate = deferred();
      opening.push(gate);
      await gate.promise;
      const created = { leaseId: `lease-${opening.length}`, port: 44001, token: 'fixture', capabilities: [], closed: false };
      created.close = async () => { created.closed = true; };
      return created;
    };
    const replaced = connectionFixture({ descriptors: [first, replacement], overrides: { createBroker } });
    const stale = replaced.connection.connect();
    await settle();
    const current = replaced.connection.connect();
    await settle();
    assert.equal(opening.length, 2);
    opening[1].resolve();
    assert.equal(await current, 'http://127.0.0.1:57102');
    const attached = replaced.state.desktopHostBroker;
    opening[0].resolve();
    await assert.rejects(stale, { code: 'runtime_service_connection_superseded' });
    assert.equal(replaced.state.desktopHostBroker, attached);
    assert.equal(attached.closed, false);
    assert.equal(attached.leaseId, 'lease-2');
  });

  test('a lease from a changed owner fails the connection and closes its broker', async () => {
    const fixture = connectionFixture({
      descriptors: [first],
      hold: kind => {
        if (kind !== 'lease') return null;
        const changed = deferred();
        changed.resolve(okResponse({ instanceId: first.instanceId, ownerGeneration: 99, protocolVersion: 2 }));
        return changed;
      },
    });
    await assert.rejects(fixture.connection.connect(), { code: 'runtime_service_generation_changed' });
    assert.equal(fixture.state.runtimeServiceClient, false);
    assert.equal(fixture.state.desktopHostBroker, null);
    assert.equal(fixture.brokers[0].closed, true);
    assert.deepEqual(fixture.activeTimers(), []);
    assert.ok(!fixture.calls.includes('record'));
  });

  test('disconnect releases the lease on the attached service before closing the broker', async () => {
    const fixture = connectionFixture({ descriptors: [first] });
    await fixture.connection.connect();
    await fixture.connection.disconnect();
    const release = fixture.requests.find(request => request.kind === 'release');
    assert.equal(release.url, 'http://127.0.0.1:57101/api/runtime-service/desktop-host/lease-1');
    assert.equal(release.method, 'DELETE');
    assert.equal(fixture.brokers[0].closed, true);
    assert.deepEqual(fixture.activeTimers(), []);
  });
});
