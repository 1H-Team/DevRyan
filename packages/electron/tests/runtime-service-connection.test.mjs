import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import test from 'node:test';
import { runtimeServiceRequestSignal } from '../runtime-service-startup.mjs';

const mainSource = await fs.readFile(new URL('../main.mjs', import.meta.url), 'utf8');
const leaseSource = mainSource.slice(mainSource.indexOf('const registerDesktopHostLease = async'),
  mainSource.indexOf('const startDesktopHostBroker = async'));
const bootstrapSource = mainSource.slice(mainSource.indexOf('const bootstrapRuntimeServiceSession = async'),
  mainSource.indexOf('// prepare-update exists'));
const createLease = new Function('session', 'runtimeServiceRequestSignal', `${leaseSource}\nreturn registerDesktopHostLease;`);
const createBootstrap = new Function('session', 'runtimeServiceRequestSignal', 'unsealRuntimeServiceBootstrapToken',
  'safeStorage', 'setRuntimeServiceCookie', `${bootstrapSource}\nreturn bootstrapRuntimeServiceSession;`);

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

test('bootstrap headers that never arrive abort against the remaining connection deadline', async () => {
  let cookieWrites = 0, signal;
  const bootstrap = createBootstrap({ defaultSession: { fetch: (url, options) => {
    signal = options.signal;
    return fetch(url, options);
  } } }, runtimeServiceRequestSignal, () => 'fixture', {}, async () => { cookieWrites++; });
  await withServer(() => {}, async origin => {
    await assert.rejects(bootstrap(origin, {}, Date.now() + 100), error => error.name === 'TimeoutError');
    assert.equal(signal.aborted, true);
    assert.equal(cookieWrites, 0);
  });
});

test('lease JSON bodies that never finish abort, including the compatibility fallback request', async () => {
  for (const compatibilityFallback of [false, true]) {
    const signals = [];
    const register = createLease({ defaultSession: { fetch: (url, options) => {
      signals.push(options.signal);
      return fetch(url, options);
    } } }, runtimeServiceRequestSignal);
    let requests = 0;
    await withServer((_req, res) => {
      requests++;
      res.writeHead(compatibilityFallback && requests === 1 ? 400 : 200, { 'Content-Type': 'application/json' });
      if (compatibilityFallback && requests === 1) res.end('{}');
      else res.flushHeaders();
    }, async origin => {
      await assert.rejects(register(origin, broker, Date.now() + 150),
        error => error.name === 'AbortError' || error.name === 'TimeoutError');
      assert.equal(requests, compatibilityFallback ? 2 : 1);
      assert.ok(signals.every(signal => signal === signals[0] && signal.aborted));
    });
  }
});

test('an already expired deadline refuses bootstrap and lease requests before transmission', async () => {
  const session = { defaultSession: { fetch: () => assert.fail('No HTTP request after the retry deadline') } };
  const bootstrap = createBootstrap(session, runtimeServiceRequestSignal, () => 'fixture', {}, () => assert.fail('No cookie write'));
  const register = createLease(session, runtimeServiceRequestSignal);
  await assert.rejects(bootstrap('http://127.0.0.1:44001', {}, Date.now() - 1), { code: 'runtime_service_connection_timeout' });
  await assert.rejects(register('http://127.0.0.1:44001', broker, Date.now() - 1), { code: 'runtime_service_connection_timeout' });
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
