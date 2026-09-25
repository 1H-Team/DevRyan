import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import request from '../../test-supertest.js';
import { registerOpenCodeProxy } from './proxy.js';
import {
  OPENCODE_ROUTE_GUARD_ENV,
  createOpenCodeRouteRegistry,
} from './opencode-routes.js';

const UNKNOWN_ROUTE_BODY = { error: 'Unknown OpenCode route', code: 'opencode_route_unknown' };
const TEST_DATA_DIR = path.join(os.tmpdir(), `devryan-route-guard-test-${process.pid}`);

const upstreams = [];

// Records every request that reaches the fake OpenCode server; `/doc` and SSE
// are served when configured, everything else echoes the request.
const startUpstream = async ({ doc } = {}) => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body, authorization: req.headers.authorization ?? null });
      if (req.url === '/doc' && doc) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(doc));
        return;
      }
      if (req.url.split('?')[0].endsWith('/event')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: {"type":"server.connected"}\n\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, url: req.url, body }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const upstream = {
    requests,
    port: server.address().port,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
  upstreams.push(upstream);
  return upstream;
};

const createApp = (upstream, registry) => {
  const app = express();
  registerOpenCodeProxy(app, {
    fs: {},
    os: {},
    path,
    OPEN_CODE_READY_GRACE_MS: 0,
    getRuntime: () => ({
      openCodePort: upstream.port,
      openCodeVersion: '1.18.31-devryan.1',
      isOpenCodeReady: true,
      openCodeNotReadySince: 0,
      isRestartingOpenCode: false,
    }),
    getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer route-guard-test' }),
    buildOpenCodeUrl: (requestPath) => `http://127.0.0.1:${upstream.port}${requestPath}`,
    ensureOpenCodeApiPrefix: () => {},
    openchamberDataDir: TEST_DATA_DIR,
    openCodeRouteRegistry: registry,
  });
  return app;
};

// Sends the path byte-for-byte; HTTP client libraries resolve `..`/`%2e%2e`
// segments before sending, which would hide the traversal under test.
const sendRawRequest = async (app, method, rawPath) => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path: rawPath }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject);
      req.end();
    });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
  }
};

// The live `/doc` load is stubbed out so the fake upstream only ever sees the
// requests the proxy forwards.
const createStaticRegistry = (logger = { warn: vi.fn() }) => createOpenCodeRouteRegistry({
  logger,
  fetchImpl: async () => new Response('not found', { status: 404 }),
});

afterEach(async () => {
  delete process.env[OPENCODE_ROUTE_GUARD_ENV];
  await Promise.all(upstreams.splice(0).map((upstream) => upstream.close()));
});

describe('OpenCode /api pass-through route guard', () => {
  it('answers unknown routes with a local 404 and never forwards them', async () => {
    const upstream = await startUpstream();
    const logger = { warn: vi.fn() };
    const app = createApp(upstream, createStaticRegistry(logger));

    await request(app).get('/api/health-check-that-opencode-lacks?directory=%2Fsecret').expect(404).expect(UNKNOWN_ROUTE_BODY);
    await request(app).get('/api/model').expect(404).expect(UNKNOWN_ROUTE_BODY);
    await request(app).delete('/api/global/health').expect(404).expect(UNKNOWN_ROUTE_BODY);
    await request(app).post('/api/session/ses_1/definitely-not-a-route').send({ x: 1 }).expect(404).expect(UNKNOWN_ROUTE_BODY);
    await request(app).head('/api/global/health').expect(404);
    for (const traversal of ['/api/session/%2e%2e/doc', '/api/session/../doc', '/api/find/..%2F..%2Fdoc/..']) {
      const response = await sendRawRequest(app, 'GET', traversal);
      expect(response.status).toBe(404);
      expect(JSON.parse(response.body)).toEqual(UNKNOWN_ROUTE_BODY);
    }

    expect(upstream.requests).toEqual([]);
    const warnings = logger.warn.mock.calls.flat().join('\n');
    expect(warnings).toContain('rejected unknown OpenCode route GET /health-check-that-opencode-lacks (source=proxy');
    expect(warnings).not.toContain('secret');
  });

  it('forwards known routes with path parameters, query strings and bodies unchanged', async () => {
    const upstream = await startUpstream();
    const app = createApp(upstream, createStaticRegistry());

    const message = await request(app)
      .get('/api/session/ses_1/message/msg_2?directory=%2Ftmp%2Fproject&workspace=w%201')
      .expect(200);
    expect(message.body.url).toBe('/session/ses_1/message/msg_2?directory=%2Ftmp%2Fproject&workspace=w%201');

    const reply = await request(app)
      .post('/api/question/que_1/reply?directory=%2Ftmp%2Fproject')
      .set('content-type', 'application/json')
      .send({ answers: [['yes']] })
      .expect(200);
    expect(reply.body).toEqual({
      method: 'POST',
      url: '/question/que_1/reply?directory=%2Ftmp%2Fproject',
      body: JSON.stringify({ answers: [['yes']] }),
    });

    // Companion-only routes stay routable.
    await request(app).get('/api/session/revert-capabilities?directory=%2Ftmp').expect(200);
    await request(app).get('/api/file/content?path=a.ts').expect(200);

    expect(upstream.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
      'GET /session/ses_1/message/msg_2?directory=%2Ftmp%2Fproject&workspace=w%201',
      'POST /question/que_1/reply?directory=%2Ftmp%2Fproject',
      'GET /session/revert-capabilities?directory=%2Ftmp',
      'GET /file/content?path=a.ts',
    ]);
    expect(upstream.requests.every(({ authorization }) => authorization === 'Bearer route-guard-test')).toBe(true);
  });

  it('keeps the SSE streams and explicit handlers working', async () => {
    const upstream = await startUpstream();
    const app = createApp(upstream, createStaticRegistry());

    const events = await request(app).get('/api/event?directory=%2Ftmp').expect(200);
    expect(events.headers['content-type']).toContain('text/event-stream');
    expect(events.text).toContain('server.connected');
    await request(app).get('/api/global/event').expect(200);
    await request(app).post('/api/mcp/my-server/connect').expect(200);
    await request(app).post('/api/mcp/my-server/auth/callback').send({ code: 'c' }).expect(200);

    expect(upstream.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
      'GET /event?directory=%2Ftmp',
      'GET /global/event',
      'POST /mcp/my-server/connect',
      'POST /mcp/my-server/auth/callback',
    ]);
  });

  it('switches to the live /doc table once OpenCode serves it', async () => {
    const upstream = await startUpstream({
      doc: {
        openapi: '3.1.0',
        paths: {
          '/global/health': { get: {} },
          '/session/{sessionID}': { get: {} },
          '/brand/new/{id}': { post: {} },
        },
      },
    });
    const registry = createOpenCodeRouteRegistry({ logger: { warn: vi.fn() } });
    const app = createApp(upstream, registry);

    // The first request is served from the static table while /doc loads.
    await request(app).get('/api/agent').expect(200);
    await expect(registry.refresh()).resolves.toBe(true);
    expect(registry.getSource()).toBe('live');

    const docRequest = upstream.requests.find(({ url }) => url === '/doc');
    expect(docRequest).toEqual(expect.objectContaining({ method: 'GET', authorization: 'Bearer route-guard-test' }));

    await request(app).post('/api/brand/new/x1').send({}).expect(200);
    await request(app).get('/api/agent').expect(404).expect(UNKNOWN_ROUTE_BODY);
    // SSE stays available even though this spec omits it.
    await request(app).get('/api/event').expect(200);

    expect(upstream.requests.map(({ method, url }) => `${method} ${url}`).filter((entry) => entry !== 'GET /doc')).toEqual([
      'GET /agent',
      'POST /brand/new/x1',
      'GET /event',
    ]);
  });

  it('forwards everything when DEVRYAN_OPENCODE_ROUTE_GUARD=0', async () => {
    const upstream = await startUpstream();
    const app = createApp(upstream, createStaticRegistry());
    process.env[OPENCODE_ROUTE_GUARD_ENV] = '0';

    await request(app).get('/api/model?x=1').expect(200);

    expect(upstream.requests.map(({ method, url }) => `${method} ${url}`)).toEqual(['GET /model?x=1']);
  });
});
