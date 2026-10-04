import http from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from '../../test-supertest.js';
import { registerOpenCodeProxy } from './proxy.js';

const UNKNOWN_ROUTE_BODY = { error: 'Unknown OpenCode route', code: 'opencode_route_unknown' };
const createApp = () => {
  const fetchImpl = vi.fn();
  const messages = vi.fn(async () => ({ records: [], cursor: null }));
  const reply = vi.fn(async () => true);
  const app = express();
  registerOpenCodeProxy(app, {
    OPEN_CODE_READY_GRACE_MS: 0,
    getRuntime: () => ({ openCodePort: 4096, isOpenCodeReady: true }),
    getOpenCodeRuntime: () => ({ generation: 2, baseUrl: 'http://127.0.0.1:4096' }),
    getOpenCodeAuthHeaders: () => ({}),
    openCodeClient: { generation: () => 2, sessions: { messages }, interaction: { questions: { reply } } },
    resolveRequestDirectory: () => '/workspace',
    fetchImpl,
  });
  return { app, fetchImpl, messages, reply };
};

// Preserve raw traversal bytes: URL clients otherwise normalize before sending.
const sendRawRequest = async (app, rawPath) => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path: rawPath }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject);
      req.end();
    });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
};

const originalGuard = process.env.DEVRYAN_OPENCODE_ROUTE_GUARD;
afterEach(() => {
  if (originalGuard === undefined) delete process.env.DEVRYAN_OPENCODE_ROUTE_GUARD;
  else process.env.DEVRYAN_OPENCODE_ROUTE_GUARD = originalGuard;
});

describe('native OpenCode browser boundary', () => {
  it('denies unknown, legacy companion, privileged and ambiguous paths without fetching', async () => {
    const { app, fetchImpl } = createApp();
    for (const pathname of ['/api/doc', '/api/model', '/api/global/health', '/api/opencode-v2/credential', '/api/SESSION/ses_1/message']) {
      await request(app).get(pathname).expect(404).expect(UNKNOWN_ROUTE_BODY);
    }
    for (const pathname of ['/api/session/retention-control', '/api/session/ses_1/external-message', '/api/session/ses_1/synthetic']) {
      await request(app).post(pathname).send({}).expect(404).expect(UNKNOWN_ROUTE_BODY);
    }
    for (const pathname of ['/api/session/%2e%2e/doc', '/api/session/../doc', '/api/find/..%2F..%2Fdoc/..']) {
      const response = await sendRawRequest(app, pathname);
      expect(response.status).toBe(404);
      expect(JSON.parse(response.body)).toEqual(UNKNOWN_ROUTE_BODY);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('dispatches permitted requests only through typed native client operations', async () => {
    const { app, messages, reply, fetchImpl } = createApp();
    await request(app).get('/api/session/ses_1/message?directory=%2Ftmp%2Fproject&limit=10').expect(200).expect([]);
    expect(messages).toHaveBeenCalledWith('ses_1', { limit: 10, before: undefined }, expect.objectContaining({ directory: '/tmp/project' }));
    await request(app).post('/api/question/que_1/reply?directory=%2Ftmp%2Fproject').send({ answers: [['yes']] }).expect(200).expect('true');
    expect(reply).toHaveBeenCalledWith('que_1', { answers: [['yes']] }, expect.objectContaining({ directory: '/tmp/project' }));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('cannot restore legacy pass-through with the retired guard environment variable', async () => {
    process.env.DEVRYAN_OPENCODE_ROUTE_GUARD = '0';
    const { app, fetchImpl } = createApp();
    await request(app).get('/api/model?x=1').expect(404).expect(UNKNOWN_ROUTE_BODY);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
