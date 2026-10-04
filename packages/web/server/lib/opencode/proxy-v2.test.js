import express from 'express';
import request from '../../test-supertest.js';
import { describe, expect, it, vi } from 'vitest';
import { registerOpenCodeProxy } from './proxy.js';

describe('generation-aware proxy dispatch', () => {
  it('bypasses every legacy upstream interceptor and denies raw paths before proxying', async () => {
    const prefix = vi.fn();
    const legacyFetch = vi.fn();
    const preflight = vi.fn();
    const client = {
      generation: () => 2,
      sessions: {
        messages: vi.fn(async () => ({ records: [], cursor: 'v2:next' })),
        create: vi.fn(async () => ({ id: 'ses_created' })),
      },
    };
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const app = express();
    registerOpenCodeProxy(app, {
      fs: {}, os: {}, path: {}, OPEN_CODE_READY_GRACE_MS: 0,
      getRuntime: () => ({ openCodePort: 12345, isOpenCodeReady: true }),
      buildOpenCodeUrl: (path) => `http://127.0.0.1:12345${path}`,
      ensureOpenCodeApiPrefix: prefix,
      getOpenCodeAuthHeaders: () => ({}),
      getOpenCodeRuntime: () => ({ generation: 2, baseUrl: 'http://127.0.0.1:12345' }),
      openCodeClient: client,
      openCodeRouteRegistry: { configure: legacyFetch, observeRuntime: legacyFetch },
      resolveRequestDirectory: () => '/workspace',
      ensureOAuthLoopbackPortAvailable: preflight,
      fetchImpl,
    });
    const messages = await request(app).get('/api/session/ses_a/message?limit=10');
    expect(messages.status).toBe(200);
    expect(messages.headers['x-next-cursor']).toBe('v2:next');
    expect((await request(app).post('/api/session').send({ title: 'new' })).body).toEqual({ id: 'ses_created' });
    const mcp = await request(app).post('/api/mcp/test/connect');
    expect(mcp.status).toBe(501);
    expect(mcp.body).toMatchObject({ code: 'capability_unavailable', capability: 'mcpOAuth' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await request(app).post('/api/provider/openai/oauth/authorize').send({})).status).toBe(501);
    expect((await request(app).post('/api/session/ses_a/synthetic').send({})).status).toBe(404);
    expect((await request(app).get('/api/opencode-v2/credential')).status).toBe(404);
    expect(prefix).not.toHaveBeenCalled();
    expect(preflight).not.toHaveBeenCalled();
    expect(legacyFetch).not.toHaveBeenCalled();
  });
});

const createNativeProxy = ({ client, getRuntime, turnTimingRuntime, parseBody = false } = {}) => {
  const fetchImpl = vi.fn();
  const app = express();
  if (parseBody) app.use(express.json());
  registerOpenCodeProxy(app, {
    OPEN_CODE_READY_GRACE_MS: 0,
    getRuntime: getRuntime ?? (() => ({ openCodePort: 4096, isOpenCodeReady: true })),
    getOpenCodeRuntime: () => ({ generation: 2, baseUrl: 'http://127.0.0.1:4096' }),
    getOpenCodeAuthHeaders: () => ({}),
    openCodeClient: client,
    resolveRequestDirectory: () => '/workspace',
    turnTimingRuntime,
    fetchImpl,
  });
  return { app, fetchImpl };
};

describe('native proxy readiness and dispatch', () => {
  it.each([undefined, {}, { generation: () => 1 }, { generation: () => 3 }])('refuses unverified runtime identity before any operation', async (client) => {
    const { app, fetchImpl } = createNativeProxy({ client });
    for (const pathname of ['/api/session', '/api/global/event', '/api/event', '/api/opencode-v2/info']) {
      const response = await request(app).get(pathname);
      expect(response.status).toBe(503);
      expect(response.body.code).toBe('opencode_generation_invalid');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('holds native session creation behind readiness without dispatching or replaying it', async () => {
    let ready = false;
    const create = vi.fn(async () => ({ id: 'ses_native' }));
    const { app } = createNativeProxy({ client: { generation: () => 2, sessions: { create } },
      getRuntime: () => ({ openCodePort: 4096, isOpenCodeReady: ready, openCodeNotReadySince: 0 }) });
    const blocked = await request(app).post('/api/session').send({ title: 'new' });
    expect(blocked.status).toBe(503);
    expect(create).not.toHaveBeenCalled();
    ready = true;
    expect((await request(app).post('/api/session').send({ title: 'new' })).body).toEqual({ id: 'ses_native' });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('preserves prompt bodies and records acceptance after successful native dispatch (parsed=%s)', async (parseBody) => {
    const marks = [];
    const prompt = vi.fn(async () => null);
    const turnTimingRuntime = { recordClientMark: (mark) => marks.push(mark) };
    const { app } = createNativeProxy({ parseBody, turnTimingRuntime,
      client: { generation: () => 2, prompts: { prompt } } });
    const body = { messageID: 'msg_user', model: { providerID: 'test', modelID: 'native' }, parts: [{ type: 'text', text: 'hello' }] };
    const response = await request(app).post('/api/session/ses_1/prompt_async?directory=%2Fproject')
      .set('x-openchamber-message-id', 'msg_user').send(body);
    expect(response.status).toBe(204);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveBeenCalledWith('ses_1', body, expect.objectContaining({ directory: '/project',
      headers: { 'x-openchamber-message-id': 'msg_user' } }));
    expect(marks.map(({ mark }) => mark)).toEqual(['send_started', 'prompt_accepted']);
    expect(marks[1]).toMatchObject({ sessionId: 'ses_1', messageId: 'msg_user', metadata: { providerID: 'test', modelID: 'native', statusCode: 204 } });
  });

  it('does not record acceptance or retry a rejected native prompt', async () => {
    const marks = [];
    const prompt = vi.fn(async () => { throw Object.assign(new Error('busy'), { statusCode: 409, code: 'session_busy' }); });
    const { app } = createNativeProxy({ client: { generation: () => 2, prompts: { prompt } },
      turnTimingRuntime: { recordClientMark: ({ mark }) => marks.push(mark) } });
    expect((await request(app).post('/api/session/ses_1/prompt_async').send({ parts: [] })).status).toBe(409);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(marks).toEqual(['send_started']);
  });

  it('removes transcript patch bodies while retaining diff counts and pagination', async () => {
    const messages = vi.fn(async () => ({ cursor: 'v2:older', records: [{ info: { id: 'msg_a', role: 'user',
      summary: { diffs: [{ file: 'a.js', additions: 1, deletions: 2, patch: 'PRIVATE_PATCH' }] } }, parts: [] }] }));
    const { app } = createNativeProxy({ client: { generation: () => 2, sessions: { messages } } });
    const response = await request(app).get('/api/session/ses_1/message');
    expect(response.status).toBe(200);
    expect(response.headers['x-next-cursor']).toBe('v2:older');
    expect(response.body[0].info.summary.diffs).toEqual([{ file: 'a.js', additions: 1, deletions: 2 }]);
    expect(response.text).not.toContain('PRIVATE_PATCH');
  });
});
