import express from 'express';
import request from '../../../test-supertest.js';
import { describe, expect, it, vi } from 'vitest';
import { createOpenCodeV2FacadeRouter } from './facade-routes.js';

const setup = (overrides = {}) => {
  const client = {
    generation: () => 2,
    sessions: { list: vi.fn(async () => []), get: vi.fn(async (id) => ({ id })),
      create: vi.fn(async () => ({ id: 'ses_new' })), update: vi.fn(async () => ({ id: 'ses_a', title: 'new' })),
      messages: vi.fn(async () => ({ records: [], cursor: 'v2:next' })), abort: vi.fn(async () => true),
      remove: vi.fn(async () => true), fork: vi.fn(async () => ({ id: 'ses_fork' })) },
    prompts: { prompt: vi.fn(async () => null), command: vi.fn(async () => null), compact: vi.fn(async () => true) },
    catalog: Object.fromEntries(['agents', 'commands', 'skills', 'providerList', 'providers', 'config', 'mcp', 'path', 'project', 'vcs', 'tools']
      .map((key) => [key, vi.fn(async () => key === 'tools' ? { ids: ['read'], definitions: [] } : { key })])),
    interaction: { permissions: { reply: vi.fn(async () => true), list: vi.fn(async () => []) },
      questions: { reply: vi.fn(async () => true), list: vi.fn(async () => []), reject: vi.fn(async () => true) } },
  };
  const fetchImpl = vi.fn(async () => Response.json({ version: '2.0.20' }));
  const app = express();
  app.get('/api/config/settings', (_req, res) => res.json({ owned: true }));
  app.use('/api', createOpenCodeV2FacadeRouter({ openCodeClient: client,
    getOpenCodeRuntime: () => ({ generation: 2, baseUrl: 'http://127.0.0.1:12345' }),
    resolveRequestDirectory: () => '/workspace', getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic fixture-only' }),
    fetchImpl, ...overrides }));
  app.use((_req, res) => res.status(418).json({ legacy: true }));
  return { app, client, fetchImpl };
};

describe('gen-2 browser facade', () => {
  it('preserves earlier DevRyan routes and refuses legacy runtime identity', async () => {
    const { app, client, fetchImpl } = setup();
    expect((await request(app).get('/api/config/settings')).body).toEqual({ owned: true });
    client.generation = () => 1;
    expect((await request(app).get('/api/session')).status).toBe(503);
    expect((await request(app).get('/api/opencode-v2/info')).status).toBe(503);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('serves unscoped UI bootstrap catalogs using the authoritative workspace', async () => {
    const { app, client } = setup();
    for (const path of ['path', 'global/config', 'provider', 'lsp']) expect((await request(app).get(`/api/${path}`)).status).toBe(200);
    expect(client.catalog.path).toHaveBeenCalledWith({ directory: '/workspace' }, expect.objectContaining({ directory: '/workspace' }));
    expect((await request(app).get('/api/lsp')).body).toEqual([]);
  });

  it('rejects ambiguous directories and invalid scalar queries without dispatch', async () => {
    const { app, client } = setup();
    expect((await request(app).get('/api/session?directory=/a').set('x-opencode-directory', '%2Fb')).status).toBe(400);
    expect((await request(app).get('/api/session?limit=no')).status).toBe(400);
    expect((await request(app).get('/api/session?roots=1')).status).toBe(400);
    expect(client.sessions.list).not.toHaveBeenCalled();
  });

  it('keeps the message cursor opaque and preserves the prompt identity header', async () => {
    const { app, client } = setup();
    const response = await request(app).get('/api/session/ses_a/message?limit=10&before=v2%3Aopaque');
    expect(response.headers['x-next-cursor']).toBe('v2:next');
    expect(client.sessions.messages).toHaveBeenCalledWith('ses_a', { limit: 10, before: 'v2:opaque' }, expect.any(Object));
    const prompt = { parts: [{ type: 'text', text: 'hello' }] };
    expect((await request(app).post('/api/session/ses_a/prompt_async').set('x-openchamber-message-id', 'msg_a').send(prompt)).status).toBe(204);
    expect(client.prompts.prompt).toHaveBeenCalledWith('ses_a', prompt, expect.objectContaining({ headers: { 'x-openchamber-message-id': 'msg_a' } }));
  });

  it('allows only title updates and rejects create privilege injection', async () => {
    const { app, client } = setup();
    for (const body of [{ metadata: {} }, { permissions: [] }, { time: { archived: 1 } }, { title: 'new', agent: 'x' }]) {
      expect((await request(app).patch('/api/session/ses_a').send(body)).status).toBe(400);
    }
    expect(client.sessions.update).not.toHaveBeenCalled();
    expect((await request(app).patch('/api/session/ses_a').send({ title: 'new' })).status).toBe(200);
    expect((await request(app).post('/api/session').send({ metadata: { devryan: {} } })).status).toBe(400);
    expect(client.sessions.create).not.toHaveBeenCalled();
  });

  it('keeps an explicit native create refusal and treats malformed acknowledgements as uncertain', async () => {
    const recordCreationTiming = vi.fn();
    const { app, client } = setup({ recordCreationTiming });
    client.sessions.create.mockRejectedValueOnce(Object.assign(new Error('Directory denied'), {
      code: 'native_directory_denied', statusCode: 403,
    }));
    const refused = await request(app).post('/api/session').send({ title: 'new' });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('native_directory_denied');
    client.sessions.create.mockResolvedValueOnce({ title: 'missing identity' });
    const uncertain = await request(app).post('/api/session').send({ title: 'new' });
    expect(uncertain.status).toBe(502);
    expect(uncertain.body).toMatchObject({ code: 'session_create_outcome_unknown', retryable: false });
    expect(client.sessions.create).toHaveBeenCalledTimes(2);
    expect(recordCreationTiming.mock.calls.map(([record]) => record.mark)).toEqual([
      'session.creation.request_received', 'session.creation.upstream_create_started',
      'session.creation.request_received', 'session.creation.upstream_create_started', 'session.creation.outcome_unknown',
    ]);
  });

  it('aborts the pending typed create at its deadline without retrying the mutation', async () => {
    const { app, client } = setup();
    let signal;
    client.sessions.create.mockImplementationOnce((_input, options) => new Promise((_resolve, reject) => {
      signal = options.signal;
      expect(options.directory).toBe('/workspace');
      expect(options.timeoutMs).toBeGreaterThan(0);
      expect(options.timeoutMs).toBeLessThanOrEqual(40);
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }));
    const response = await request(app).post('/api/session').set('x-devryan-creation-budget-ms', '40').send({ title: 'new' });
    expect(response.status).toBe(502);
    expect(response.body).toMatchObject({ code: 'session_create_outcome_unknown', retryable: false });
    expect(signal.aborted).toBe(true);
    expect(client.sessions.create).toHaveBeenCalledTimes(1);
  });

  it('keeps all sessions tied at a global-history timestamp on one page', async () => {
    const { app, client } = setup();
    client.sessions.list.mockResolvedValue([
      { id: 'ses_c', time: { updated: 1 } }, { id: 'ses_b', time: { updated: 2 } }, { id: 'ses_a', time: { updated: 2 } },
    ]);
    const first = await request(app).get('/api/experimental/session?limit=1&archived=false');
    expect(first.body.map((row) => row.id)).toEqual(['ses_a', 'ses_b']);
    expect(first.headers['x-next-cursor']).toBe('2');
    expect((await request(app).get('/api/experimental/session?limit=1&cursor=2')).body.map((row) => row.id)).toEqual(['ses_c']);
  });

  it('only permits raw browser-class routes, even when the legacy guard is disabled', async () => {
    const { app, fetchImpl } = setup();
    for (const path of ['/api/opencode-v2/session', '/api/opencode-v2/credential', '/api/opencode-v2/experimental/config',
      '/api/opencode-v2/debug/location', '/api/opencode-v2/session/ses_a%2Fshell', '/api/opencode-v2//info']) {
      expect((await request(app).get(path)).status).toBe(404);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    const response = await request(app).get('/api/opencode-v2/info?secret=never-forward').set('Authorization', 'Bearer browser-only');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ version: '2.0.20' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe('http://127.0.0.1:12345/api/info');
    expect(new Headers(init.headers).get('Authorization')).toBe('Basic fixture-only');
  });

  it('fails unknown and unsupported capabilities locally', async () => {
    const { app, fetchImpl } = setup();
    for (const [method, path] of [['post', '/session/ses_a/share'], ['delete', '/session/ses_a/share'],
      ['post', '/session/ses_a/shell'], ['post', '/mcp/server/auth'], ['get', '/file?path=.'],
      ['patch', '/session/ses_a/message/msg_a/part/prt_a'], ['post', '/session/ses_a/message']]) {
      const response = await request(app)[method](`/api${path}`).send({});
      expect(response.status, path).toBe(501);
      expect(response.body.code).toBe('capability_unavailable');
    }
    for (const path of ['/session/ses_a/synthetic', '/session/ses_a/revert/stage', '/experimental/generate', '/nope']) {
      expect((await request(app).post(`/api${path}`).send({})).status).toBe(404);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('preserves typed runtime errors and never replays failed writes', async () => {
    const { app, client } = setup();
    client.prompts.prompt.mockRejectedValue(Object.assign(new Error('Runtime changed'), { code: 'opencode_runtime_changed', statusCode: 503, retryable: true }));
    const response = await request(app).post('/api/session/ses_a/prompt_async').send({ parts: [] });
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('opencode_runtime_changed');
    expect(client.prompts.prompt).toHaveBeenCalledTimes(1);
  });
});
