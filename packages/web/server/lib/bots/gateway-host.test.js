import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BOT_PRIVATE_GATEWAY_PATH,
  BOT_PRIVATE_OAUTH_PATH,
  createBotGatewayHost,
} from './gateway-host.js';

const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const RUN_ID = 'a0000000-0000-4000-8000-000000000001';
const CHANNEL_ID = 'c0000000-0000-4000-8000-000000000001';
const REVISION_ID = 'd0000000-0000-4000-8000-000000000001';
const gateways = [];

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.shutdown()));
});

const request = ({ address, token, body, headers = {}, method = 'POST', path = BOT_PRIVATE_GATEWAY_PATH }) => (
  new Promise((resolve, reject) => {
    const encoded = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    const call = http.request({
      host: address.host,
      port: address.port,
      method,
      path,
      headers: {
        host: `host.docker.internal:${address.port}`,
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'content-length': String(encoded.byteLength),
        ...headers,
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    call.once('error', reject);
    call.end(encoded);
  })
);

const issue = (gateway, overrides = {}) => gateway.issueCapability({
  botId: BOT_ID,
  runId: RUN_ID,
  channelId: CHANNEL_ID,
  revisionId: REVISION_ID,
  scopeKey: `channel:${CHANNEL_ID}`,
  kind: 'reasoning',
  operations: ['memory.search', 'library.search'],
  ...overrides,
});

const validBody = (overrides = {}) => ({
  runId: RUN_ID,
  channelId: CHANNEL_ID,
  revisionId: REVISION_ID,
  operation: 'memory.search',
  payload: { query: 'quarterly operations' },
  ...overrides,
});

describe('private Docker Bot gateway host', () => {
  it('keeps OAuth out of tool operations and rejects caller-selected scope, browser and computer requests', async () => {
    const handleOAuth = vi.fn(async (claims) => ({ generation: claims.runId, accessToken: 'fixture-short-lived' }));
    const handleOperation = vi.fn();
    const gateway = createBotGatewayHost({ handleOperation, handleOAuth });
    gateways.push(gateway);
    await gateway.start();
    const address = gateway.getAddress();
    const { token } = issue(gateway);
    const call = (overrides = {}) => request({ address, token, path: BOT_PRIVATE_OAUTH_PATH,
      body: { operation: 'access', protocol: 1 }, ...overrides });
    expect((await call()).status).toBe(200);
    expect(handleOperation).not.toHaveBeenCalled();
    for (const overrides of [
      { body: { operation: 'access', protocol: 1, botId: BOT_ID } },
      { body: { operation: 'access', protocol: 1, connectionId: 'host:openai' } },
      { body: { operation: 'access', protocol: 1, url: 'https://example.com' } },
      { headers: { origin: 'http://127.0.0.1' } },
      { headers: { cookie: 'session=fixture' } },
      { token: issue(gateway, { kind: 'computer' }).token },
    ]) expect((await call(overrides)).status).toBe(403);
    expect((await request({ address, token, body: validBody({ operation: 'access' }) })).status).toBe(403);
    expect(handleOAuth).toHaveBeenCalledTimes(1);
  });

  it('does not release access credentials when a run is revoked during refresh', async () => {
    let finish;
    let started;
    const ready = new Promise((resolve) => { started = resolve; });
    const gateway = createBotGatewayHost({ handleOperation: vi.fn(), handleOAuth: async () => {
      started();
      return new Promise((resolve) => { finish = resolve; });
    } });
    gateways.push(gateway);
    await gateway.start();
    const pending = request({ address: gateway.getAddress(), token: issue(gateway).token,
      path: BOT_PRIVATE_OAUTH_PATH, body: { operation: 'access', protocol: 1 } });
    await ready;
    gateway.revokeRun(RUN_ID);
    finish({ accessToken: 'must-not-leak' });
    expect(await pending).toEqual({ status: 403, body: { code: 'bot_oauth_access_denied' } });
  });
  it('binds a random loopback port and authorizes exact run/channel/revision claims', async () => {
    const handleOperation = vi.fn(async ({ claims, operation, payload }) => ({
      botId: claims.botId,
      operation,
      count: payload.query.length,
    }));
    const gateway = createBotGatewayHost({ handleOperation });
    gateways.push(gateway);
    await gateway.start();
    const address = gateway.getAddress();
    expect(address).toMatchObject({ host: '127.0.0.1' });
    expect(address.port).toBeGreaterThan(0);
    expect(address.dockerGatewayUrl).toBe(`http://host.docker.internal:${address.port}`);
    const capability = issue(gateway);
    expect(capability.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    await expect(request({
      address,
      token: capability.token,
      body: validBody(),
    })).resolves.toEqual({
      status: 200,
      body: {
        ok: true,
        result: { botId: BOT_ID, operation: 'memory.search', count: 20 },
      },
    });
    expect(handleOperation).toHaveBeenCalledWith(expect.objectContaining({
      claims: expect.objectContaining({ runId: RUN_ID, scopeKey: `channel:${CHANNEL_ID}` }),
      operation: 'memory.search',
    }));
  });

  it('reuses a preferred loopback port and falls back to a random port when it is taken', async () => {
    const bound = [];
    const first = createBotGatewayHost({ handleOperation: async () => ({ ok: true }), onBound: (port) => { bound.push(port); } });
    gateways.push(first);
    await first.start();
    const preferred = first.getAddress().port;
    await first.shutdown();

    const reused = createBotGatewayHost({ handleOperation: async () => ({ ok: true }), port: preferred, onBound: (port) => { bound.push(port); } });
    gateways.push(reused);
    await reused.start();
    expect(reused.getAddress().port).toBe(preferred);

    const fallback = createBotGatewayHost({
      handleOperation: async () => ({ ok: true }),
      port: preferred,
      onBound: (port) => { bound.push(port); },
      logger: { warn: vi.fn(), error: vi.fn() },
    });
    gateways.push(fallback);
    await fallback.start();
    expect(fallback.getAddress().port).toBeGreaterThan(0);
    expect(fallback.getAddress().port).not.toBe(preferred);
    expect(bound).toEqual([preferred, preferred, fallback.getAddress().port]);
  });

  it('rejects non-Docker/browser origins, mismatched claims, operations, and bearer tokens', async () => {
    const handleOperation = vi.fn(async () => ({}));
    const gateway = createBotGatewayHost({ handleOperation });
    gateways.push(gateway);
    await gateway.start();
    const address = gateway.getAddress();
    const capability = issue(gateway);

    const cases = [
      { headers: { host: `127.0.0.1:${address.port}` }, body: validBody(), status: 403 },
      { headers: { origin: 'https://attacker.test' }, body: validBody(), status: 403 },
      { body: validBody({ runId: 'a0000000-0000-4000-8000-000000000002' }), status: 403 },
      { body: validBody({ operation: 'computer.command' }), status: 403 },
      { token: 'x'.repeat(43), body: validBody(), status: 401 },
    ];
    for (const testCase of cases) {
      const response = await request({
        address,
        token: testCase.token || capability.token,
        body: testCase.body,
        headers: testCase.headers,
      });
      expect(response.status).toBe(testCase.status);
    }
    expect(handleOperation).not.toHaveBeenCalled();
  });

  it('enforces body and response limits without logging bearer or payload content', async () => {
    const warnings = [];
    const logger = { warn: (...args) => warnings.push(args) };
    const gateway = createBotGatewayHost({
      handleOperation: async () => ({ secretEcho: 'response-too-large'.repeat(10) }),
      bodyLimit: 256,
      responseLimit: 128,
      logger,
    });
    gateways.push(gateway);
    await gateway.start();
    const address = gateway.getAddress();
    const capability = issue(gateway);
    const response = await request({ address, token: capability.token, body: validBody() });
    expect(response).toMatchObject({
      status: 502,
      body: { ok: false, error: { code: 'bot_gateway_response_too_large' } },
    });
    const oversized = await request({
      address,
      token: capability.token,
      body: validBody({ payload: { secret: 'payload-secret'.repeat(50) } }),
    }).catch((error) => ({ transportError: error }));
    if (!oversized.transportError) expect(oversized.status).toBe(413);
    const logged = JSON.stringify(warnings);
    expect(warnings).toContainEqual([
      '[BotsGateway] request rejected',
      expect.objectContaining({
        code: 'bot_gateway_body_too_large',
        statusCode: 413,
        operation: 'unknown',
      }),
    ]);
    expect(logged).not.toContain(capability.token);
    expect(logged).not.toContain('payload-secret');
    expect(logged).not.toContain('response-too-large');
  });

  it('preserves stable action-gateway error codes without a duplicated Bot prefix', async () => {
    const gateway = createBotGatewayHost({
      handleOperation: async () => {
        throw Object.assign(new Error('Bot action approval is required'), {
          code: 'bot_approval_required',
          statusCode: 409,
        });
      },
    });
    gateways.push(gateway);
    await gateway.start();
    const address = gateway.getAddress();
    const capability = issue(gateway, { operations: ['action.request'] });

    await expect(request({
      address,
      token: capability.token,
      body: validBody({ operation: 'action.request' }),
    })).resolves.toEqual({
      status: 409,
      body: {
        ok: false,
        error: {
          code: 'DEVRYAN_BOT_APPROVAL_REQUIRED',
          message: 'Bot action approval is required',
        },
      },
    });
  });

  it('revokes run capabilities and shuts down without leaving a listener', async () => {
    const gateway = createBotGatewayHost({ handleOperation: async () => ({}) });
    gateways.push(gateway);
    await gateway.start();
    const address = gateway.getAddress();
    const capability = issue(gateway);
    expect(gateway.revokeRun(RUN_ID)).toBe(1);
    expect((await request({ address, token: capability.token, body: validBody() })).status).toBe(401);
    await gateway.shutdown();
    expect(gateway.getAddress()).toBeNull();
    await expect(request({ address, token: capability.token, body: validBody() })).rejects.toBeTruthy();
  });
});
