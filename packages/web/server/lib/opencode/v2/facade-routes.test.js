import express from 'express';
import request from '../../../test-supertest.js';
import { describe, expect, it, vi } from 'vitest';
import { createOpenCodeV2FacadeRouter } from './facade-routes.js';
import { buildDevryanPromptMetadata, buildV2PromptContent, buildV2PromptFingerprint, createOpenCodeAdmission, PROMPT_ORIGIN_HEADER } from './admission.js';

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
    expect((await request(app).post('/api/session/ses_a/prompt_async').set('x-devryan-message-id', 'msg_a').send(prompt)).status).toBe(204);
    expect(client.prompts.prompt).toHaveBeenCalledWith('ses_a', prompt, expect.objectContaining({ headers: { 'x-devryan-message-id': 'msg_a' } }));
    // An older UI's alias header keeps its prompt identity.
    expect((await request(app).post('/api/session/ses_a/prompt_async').set('x-openchamber-message-id', 'msg_b').send(prompt)).status).toBe(204);
    expect(client.prompts.prompt).toHaveBeenLastCalledWith('ses_a', prompt, expect.objectContaining({ headers: { 'x-devryan-message-id': 'msg_b' } }));
  });

  it('omits finished display-only tool output from history pages only on request', async () => {
    const tool = (id, name, state) => ({ id, messageID: 'msg_a', sessionID: 'ses_a', type: 'tool', tool: name, callID: id, state });
    const done = (output) => ({ status: 'completed', input: {}, output, title: 't', metadata: { output }, time: { start: 1, end: 2 } });
    const parts = [
      tool('prt_read', 'read', done('é'.repeat(50))),
      tool('prt_fetch', 'webfetch', done('<html>')),
      tool('prt_running', 'read', { status: 'running', input: {}, time: { start: 1 } }),
      tool('prt_failed', 'read', { status: 'error', input: {}, error: 'missing', time: { start: 1, end: 2 } }),
      ...['bash', 'grep', 'glob', 'task', 'devryan_task', 'skill', 'todowrite', 'question', 'edit']
        .map((name) => tool(`prt_${name}`, name, done(`${name} output`))),
    ];
    const record = { info: { id: 'msg_a', role: 'assistant' }, parts };
    const { app, client } = setup();
    client.sessions.messages.mockResolvedValue({ records: [record] });
    client.sessions.message = vi.fn(async () => record);

    expect((await request(app).get('/api/session/ses_a/message?limit=10')).body).toEqual([record]);
    const trimmed = (await request(app).get('/api/session/ses_a/message?limit=10&toolOutput=omit')).body[0].parts;
    expect(trimmed[0].state).toEqual({ ...parts[0].state, output: '', outputOmitted: true, outputBytes: 100 });
    expect(trimmed[1].state).toMatchObject({ output: '', outputOmitted: true, outputBytes: 6 });
    expect(trimmed.slice(2)).toEqual(parts.slice(2));
    expect(client.sessions.messages).toHaveBeenLastCalledWith('ses_a', { limit: 10, before: undefined }, expect.any(Object));
    // Expanding a row re-reads the one message, which always carries full output.
    expect((await request(app).get('/api/session/ses_a/message/msg_a?toolOutput=omit')).body).toEqual(record);

    for (const value of ['full', 'true', '']) {
      expect((await request(app).get(`/api/session/ses_a/message?toolOutput=${value}`)).status).toBe(400);
    }
    expect(client.sessions.messages).toHaveBeenCalledTimes(2);
  });

  it.each(['human', undefined, 'managed-primary', 'native', 'Human Being', ['human', 'human']])(
    'carries only the exact UI human marker into real admission (%j)', async header => {
      const sessionID = 'ses_origin', messageID = 'msg_origin';
      const origin = header === 'human' ? 'human' : 'unknown';
      const body = { messageID, parts: [{ type: 'text', text: 'Accepted input' }] };
      const content = buildV2PromptContent(body.parts);
      const fingerprint = buildV2PromptFingerprint({ sessionID, messageID, content, selection: {}, origin,
        resume: true, delivery: 'queue', planMode: false });
      const canonical = { id: messageID, sessionID, type: 'user', text: content.text,
        metadata: { devryan: buildDevryanPromptMetadata({ origin, parts: content.segments, admission: { v: 1, fingerprint } }, { text: content.text }) } };
      const fetchImpl = vi.fn(async (url, init = {}) => {
        expect(init.method ?? 'GET').toBe('GET');
        const path = new URL(url).pathname;
        if (path.endsWith('/inbox')) return Response.json({ data: [] });
        expect(path).toBe(`/api/session/${sessionID}/message/${messageID}`);
        return Response.json({ data: canonical });
      });
      const admission = createOpenCodeAdmission({ getRuntime: () => ({ generation: 2, baseUrl: 'http://fixture.invalid' }), fetchImpl });
      const prompt = vi.fn(admission.prompt);
      const { app } = setup({ openCodeClient: { generation: () => 2, prompts: { prompt } } });
      const sending = request(app).post(`/api/session/${sessionID}/prompt_async`);
      if (header !== undefined) sending.set(PROMPT_ORIGIN_HEADER, header);
      expect((await sending.send(body)).status).toBe(204);
      expect(prompt).toHaveBeenCalledOnce();
      const options = prompt.mock.calls[0][2];
      expect(options.headers[PROMPT_ORIGIN_HEADER]).toBe(header === 'human' ? 'human' : undefined);
      expect(options.origin).toBeUndefined();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    },
  );

  it('omits large tool media from browser message reads unless inline attachments are requested', async () => {
    const { app, client } = setup();
    const largeUri = `data:image/png;base64,${'A'.repeat(64 * 1024)}`;
    const record = { info: { id: 'msg_a', role: 'assistant' }, parts: [{
      id: 'prt_tool', type: 'tool', tool: 'shot', state: { status: 'completed', attachments: [{ id: 'att', type: 'file', mime: 'image/png', url: largeUri }] },
    }] };
    client.sessions.message = vi.fn(async () => record);
    client.sessions.messages.mockResolvedValueOnce({ records: [record] });
    const page = await request(app).get('/api/session/ses_a/message');
    expect(page.body[0].parts[0].state.attachments[0]).toMatchObject({ url: '', devryanOmitted: { bytes: 48 * 1024 } });
    const single = await request(app).get('/api/session/ses_a/message/msg_a');
    expect(single.body.parts[0].state.attachments[0].url).toBe('');
    const inline = await request(app).get('/api/session/ses_a/message/msg_a?attachments=inline');
    expect(inline.body.parts[0].state.attachments[0].url).toBe(largeUri);
    expect((await request(app).get('/api/session/ses_a/message/msg_a?attachments=all')).status).toBe(400);
    // An invalid value is refused before dispatch.
    expect(client.sessions.message).toHaveBeenCalledTimes(2);
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

  it('lists global history across locations and includes archived sessions when asked', async () => {
    const { app, client } = setup();
    client.sessions.list.mockResolvedValue([{ id: 'ses_a', time: { updated: 2 } }]);
    await request(app).get('/api/experimental/session?archived=true&limit=200').expect(200);
    // No last-used directory scopes the list, and archived=true filters nothing.
    expect(client.sessions.list.mock.calls[0][0]).toEqual({ directory: undefined, parentID: undefined, roots: undefined, search: undefined });
    expect(client.sessions.list.mock.calls[0][1].directory).toBeUndefined();
    await request(app).get('/api/experimental/session?archived=false&directory=/project').expect(200);
    expect(client.sessions.list.mock.calls[1][0]).toMatchObject({ directory: '/project', archived: false });
    expect(client.sessions.list.mock.calls[1][1].directory).toBe('/project');
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
