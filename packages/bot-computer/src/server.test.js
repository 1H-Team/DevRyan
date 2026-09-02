import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { closeComputerHttpServer, createComputerHttpServer, startComputerService } from './server.js';
import { createControlLeaseManager } from './control.js';
import { createScreencastBroker } from './screencast.js';

const TOKEN = 'computer-runtime-token-0123456789abcdef';
const servers = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeComputerHttpServer));
});

const fixture = async ({ browserOverrides = {}, rotateEgressToken, readiness, releaseInput } = {}) => {
  const calls = [];
  const screencast = createScreencastBroker({ now: () => 1234 });
  const browser = {
    execute: async (command, args) => { calls.push(['agent', command, args]); return { command }; },
    executeHuman: async (command, args) => { calls.push(['human', command, args]); return { command }; },
    subscribeScreencast: async (subscriber) => screencast.subscribe(subscriber),
    resetProfile: async () => ({ reset: true }),
    status: () => ({ running: true, launching: false }),
    ...browserOverrides,
  };
  const control = createControlLeaseManager({ randomBytes: () => Buffer.alloc(18, 6), releaseInput });
  const server = createComputerHttpServer({
    token: TOKEN,
    browser,
    control,
    screencast,
    rotateEgressToken: rotateEgressToken || (() => undefined),
    readiness: readiness || (() => true),
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, browser, control, screencast, calls };
};

const request = ({ port, pathname, body, token = TOKEN, headers = {} }) => new Promise((resolve, reject) => {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const client = http.request({
    host: '127.0.0.1',
    port,
    method: body === undefined ? 'GET' : 'POST',
    path: pathname,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.byteLength) } : {}),
      ...headers,
    },
  }, (response) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => resolve({
      statusCode: response.statusCode,
      headers: response.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    }));
  });
  client.once('error', reject);
  client.end(payload);
});

describe('authenticated computer HTTP API', () => {
  test('awaits held-input release before returning the lease and fences admitted human commands', async () => {
    let finishRelease;
    let markRelease;
    let assertHumanOwner;
    const releasing = new Promise((resolve) => { markRelease = resolve; });
    const released = new Promise((resolve) => { finishRelease = resolve; });
    const { port, control } = await fixture({ releaseInput: () => { markRelease(); return released; },
      browserOverrides: { executeHuman: async (_command, _args, options) => { assertHumanOwner = options.assertAuthorized; return {}; } } });
    const actor = { actorId: 'user-01', actorType: 'user' };
    const lease = control.take(actor);
    const owner = { ...actor, leaseId: lease.leaseId };
    expect((await request({ port, pathname: '/v1/control/command', body: { ...owner, command: 'snapshot', args: {} } })).statusCode).toBe(200);
    const returned = request({ port, pathname: '/v1/control/return', body: owner });
    await releasing;
    expect(() => assertHumanOwner()).toThrow();
    expect(() => control.assertAgentAvailable()).toThrow();
    finishRelease();
    const response = await returned;
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).result).toEqual({ returned: true });
    expect(control.snapshot()).toBeNull();
  });

  test('reports input-release failure without returning a successful control response', async () => {
    const { port, control } = await fixture({ releaseInput: async () => { throw new Error('CDP failed'); } });
    const actor = { actorId: 'user-01', actorType: 'user' };
    const lease = control.take(actor);
    const response = await request({ port, pathname: '/v1/control/return', body: { ...actor, leaseId: lease.leaseId } });
    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body).error.code).toBe('DEVRYAN_BOT_CONTROL_RELEASE_FAILED');
    expect(() => control.assertAgentAvailable()).toThrow();
  });

  test('keeps health public and protects every operational route', async () => {
    const { port } = await fixture();
    expect((await request({ port, pathname: '/healthz', token: null })).statusCode).toBe(200);
    const denied = await request({ port, pathname: '/v1/status', token: null });
    expect(denied.statusCode).toBe(401);
    expect(denied.headers['www-authenticate']).toContain('Bearer');
  });

  test('fails health checks when the virtual display or managed policy is unavailable', async () => {
    const { port } = await fixture({ readiness: () => false });
    const response = await request({ port, pathname: '/healthz', token: null });
    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toEqual({ ok: false });
  });

  test('routes reviewed agent commands and refuses arbitrary server paths', async () => {
    const { port, calls } = await fixture();
    const command = await request({
      port,
      pathname: '/v1/command',
      body: { command: 'snapshot', args: {} },
    });
    expect(command.statusCode).toBe(200);
    expect(calls).toEqual([['agent', 'snapshot', {}]]);
    const arbitrary = await request({ port, pathname: '/v1/evaluate', body: { script: '1+1' } });
    expect(arbitrary.statusCode).toBe(404);
  });

  test('rotates only a signed browser egress capability over the authenticated route', async () => {
    const rotated = [];
    const { port } = await fixture({ rotateEgressToken: (value) => rotated.push(value) });
    const nextToken = `drb1.${'a'.repeat(43)}.${'b'.repeat(43)}`;
    const accepted = await request({
      port,
      pathname: '/v1/egress/rotate',
      body: { token: nextToken },
    });
    expect(accepted.statusCode).toBe(200);
    expect(rotated).toEqual([nextToken]);
    expect((await request({
      port,
      pathname: '/v1/egress/rotate',
      body: { token: 'unsigned' },
    })).statusCode).toBe(400);
    expect((await request({
      port,
      pathname: '/v1/egress/rotate',
      body: { token: nextToken },
      token: null,
    })).statusCode).toBe(401);
  });

  test('requires the attributed lease for human commands', async () => {
    const { port, control, calls } = await fixture();
    const lease = control.take({ actorId: 'user-01', actorType: 'user' });
    const human = await request({
      port,
      pathname: '/v1/control/command',
      body: {
        actorId: 'user-01',
        actorType: 'user',
        leaseId: lease.leaseId,
        command: 'snapshot',
        args: {},
      },
    });
    expect(human.statusCode).toBe(200);
    expect(calls).toEqual([['human', 'snapshot', {}]]);
    const wrongActor = await request({
      port,
      pathname: '/v1/control/command',
      body: {
        actorId: 'user-02',
        actorType: 'user',
        leaseId: lease.leaseId,
        command: 'snapshot',
        args: {},
      },
    });
    expect(wrongActor.statusCode).toBe(409);
  });

  test('streams authenticated JPEG frames without adding persistence', async () => {
    let unsubscribed = 0;
    let markUnsubscribed;
    const cleanupFinished = new Promise((resolve) => { markUnsubscribed = resolve; });
    const { port, screencast } = await fixture({
      browserOverrides: {
        subscribeScreencast: async (subscriber) => {
          subscriber({
            frame: Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0xff, 0xd9]),
            width: 800,
            height: 600,
            capturedAt: 1234,
          });
          return async () => { unsubscribed += 1; markUnsubscribed(); };
        },
      },
    });
    const received = await new Promise((resolve, reject) => {
      const client = http.request({
        host: '127.0.0.1',
        port,
        path: '/v1/screencast',
        headers: {
          authorization: `Bearer ${TOKEN}`,
        },
      }, (response) => {
        response.once('data', (chunk) => {
          response.destroy();
          resolve({ statusCode: response.statusCode, contentType: response.headers['content-type'], chunk });
        });
      });
      client.once('error', reject);
      client.end();
    });
    expect(received.statusCode).toBe(200);
    expect(received.contentType).toContain('multipart/x-mixed-replace');
    expect(received.chunk.includes(Buffer.from('Content-Type: image/jpeg'))).toBe(true);
    expect(screencast.snapshot().retainedFrames).toBe(0);
    await cleanupFinished;
    expect(unsubscribed).toBe(1);
  });

  test('cleans a viewer that disconnects while subscription setup is pending', async () => {
    let releaseSubscription;
    let markStarted;
    let activeSubscriptions = 0;
    const started = new Promise((resolve) => { markStarted = resolve; });
    const pending = new Promise((resolve) => { releaseSubscription = resolve; });
    const { port } = await fixture({
      browserOverrides: {
        subscribeScreencast: async () => {
          markStarted();
          await pending;
          activeSubscriptions += 1;
          return async () => { activeSubscriptions -= 1; };
        },
      },
    });
    const client = http.request({
      host: '127.0.0.1',
      port,
      path: '/v1/screencast',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    client.on('error', () => undefined);
    client.end();
    await started;
    client.destroy();
    releaseSubscription();

    const deadline = Date.now() + 1_000;
    while (activeSubscriptions !== 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(activeSubscriptions).toBe(0);
  });

  test('returns a stable conflict before headers when the Bot browser is not open', async () => {
    const unavailable = Object.assign(new Error('The Bot has not opened its browser'), {
      code: 'DEVRYAN_BOT_BROWSER_NOT_OPEN',
      statusCode: 409,
    });
    const { port } = await fixture({
      browserOverrides: {
        subscribeScreencast: async () => { throw unavailable; },
        status: () => ({ running: false, launching: false }),
      },
    });

    const response = await request({ port, pathname: '/v1/screencast' });
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body).error.code).toBe('DEVRYAN_BOT_BROWSER_NOT_OPEN');
  });

  test('requires explicit confirmation for destructive profile reset', async () => {
    const { port } = await fixture();
    expect((await request({
      port,
      pathname: '/v1/profile/reset',
      body: { confirm: false },
    })).statusCode).toBe(400);
    expect((await request({
      port,
      pathname: '/v1/profile/reset',
      body: { confirm: true },
    })).statusCode).toBe(200);
  });

  test('resets navigation diagnostics whenever a human takes control', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-computer-service-'));
    const resets = [];
    const diagnostics = {
      recordRequest() {},
      recordEgressDenied() {},
      reset: (reason) => resets.push(reason),
      snapshot: () => null,
    };
    const virtualDisplay = {
      display: ':99',
      status: () => ({ ready: true }),
      onTerminated: () => () => undefined,
      close: async () => {},
    };
    let runtime;
    try {
      runtime = await startComputerService({
        token: TOKEN,
        runId: 'fixture-run',
        scopeMode: 'team',
        gatewayUrl: 'http://host.docker.internal:43120',
        profileDirectory: path.join(directory, 'profile'),
        scratchDirectory: path.join(directory, 'scratch'),
        egressProxyUrl: 'http://egress:43121',
        egressToken: 'drb1.fixture.signature',
        port: 0,
        host: '127.0.0.1',
        diagnostics,
        startDisplay: async () => virtualDisplay,
        verifyPolicy: async () => ({
          managedPolicy: 'enforced', javascript: 'enabled',
          firstPartyCookies: 'enabled', thirdPartyCookies: 'enabled',
        }),
      });
      runtime.control.take({ actorId: 'user-01', actorType: 'user' });
      expect(resets).toEqual(['control_taken']);
    } finally {
      await runtime?.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
