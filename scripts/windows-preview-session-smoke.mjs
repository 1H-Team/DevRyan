import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const within = async (check, label, timeout = 30_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await sleep(100);
  }
  throw new Error(`Preview smoke timed out: ${label}`);
};

// Real stock OpenCode talks to this disposable provider. No live credentials or paid APIs.
async function createProvider(key, marker) {
  let hold = false;
  let calls = 0;
  let authenticated = 0;
  let failure;
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    try {
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/v1/chat/completions');
      assert.equal(req.headers.authorization, `Bearer ${key}`);
      authenticated++;
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        assert.ok(size <= 1024 * 1024, 'provider request bound');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(body.stream, true);
      assert.ok(Array.isArray(body.messages));
      calls++;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      const packet = (delta, finish = null) => `data: ${JSON.stringify({ id: `chatcmpl-preview-${calls}`,
        object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model,
        choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.write(packet({ role: 'assistant', content: hold ? 'Waiting for abort.' : marker }));
      if (hold) return; // The abort test owns this connection; server.closeAllConnections bounds cleanup.
      res.end(`${packet({}, 'stop')}data: [DONE]\n\n`);
    } catch (error) {
      failure ??= error;
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    baseURL: `http://127.0.0.1:${server.address().port}/v1`,
    get calls() { if (failure) throw failure; return calls; },
    get authenticated() { if (failure) throw failure; return authenticated; },
    hold() { hold = true; },
    async close() {
      const closed = new Promise(resolve => server.close(resolve));
      for (const socket of sockets) socket.destroy();
      await closed;
      if (failure) throw failure;
    },
  };
}

/** request(relativePath, init) supplies the desktop owner's cookie in memory. */
export async function runWindowsPreviewSessionSmoke({ baseUrl, request, phase = 'initial', fixtureRoot }) {
  assert.ok(path.isAbsolute(fixtureRoot), 'isolated absolute fixture root required');
  const origin = new URL(baseUrl);
  assert.equal(origin.protocol, 'http:');
  assert.equal(origin.hostname, '127.0.0.1');
  assert.equal(typeof request, 'function');
  assert.ok(['initial', 'restart'].includes(phase));
  const directory = path.join(fixtureRoot, 'project');
  await fs.mkdir(directory, { recursive: true });
  const markerPath = path.join(fixtureRoot, 'session-smoke.json');
  const headers = { 'x-opencode-directory': encodeURIComponent(directory) };
  const call = async (route, { method = 'GET', body, ...options } = {}) => {
    const response = await request(route, { ...options, method,
      headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: options.signal ?? AbortSignal.timeout(30_000) });
    assert.ok(response.ok, `${method} ${route.split('?')[0]} returned ${response.status}`);
    return response;
  };
  const json = async (route, options) => (await call(route, options)).json();
  const health = await json('/health');
  assert.equal(health.openCode?.runtimeMode ?? health.runtimeMode, 'standard-preview');
  assert.equal(health.openCode?.version, '2.0.20');
  assert.equal(health.isOpenCodeReady, true);
  const evidence = { phase, runtimeMode: 'standard-preview', scenarios: [] };
  evidence.scenarios.push('authenticated-runtime-readiness');

  if (phase === 'restart') {
    const saved = JSON.parse(await fs.readFile(markerPath, 'utf8'));
    const messages = await json(`/api/session/${saved.sessionID}/message`);
    assert.ok(JSON.stringify(messages).includes(saved.marker), 'history survives application restart');
    assert.equal(await (await call('/api/fs/read?path=' + encodeURIComponent(path.join(directory, 'preview.txt')))).text(), saved.marker);
    evidence.scenarios.push('history-after-application-restart', 'files-after-application-restart');
    return { ...evidence, status: 'passed' };
  }

  const marker = `Windows preview ${randomUUID()}`;
  const key = `disposable-fixture-${randomUUID()}`;
  const provider = await createProvider(key, marker);
  const streamAbort = new AbortController();
  let streamTask;
  let streamed = '';
  try {
    await fs.writeFile(path.join(directory, 'opencode.json'), JSON.stringify({
      model: 'devryan-preview-fixture/smoke',
      providers: { 'devryan-preview-fixture': {
        package: '@opencode/ai/providers/openai-compatible', env: [],
        settings: { baseURL: provider.baseURL, transport: 'http' },
        models: { smoke: { capabilities: { tools: true, input: ['text'], output: ['text'] }, limit: { context: 32768, output: 4096 } } },
      } },
      agents: { build: { mode: 'primary', model: 'devryan-preview-fixture/smoke' }, title: { disabled: true } },
    }));
    await json('/api/config/reload', { method: 'POST', body: {} });
    evidence.scenarios.push('runtime-restart');
    await json('/api/fs/write', { method: 'POST', body: { path: path.join(directory, 'preview.txt'), content: marker } });
    assert.equal(await (await call('/api/fs/read?path=' + encodeURIComponent(path.join(directory, 'preview.txt')))).text(), marker);
    const denied = await request('/api/fs/read?path=' + encodeURIComponent(path.join(directory, '..', 'session-smoke.json')), { headers });
    assert.ok([400, 403].includes(denied.status), 'file traversal refused');
    evidence.scenarios.push('project-file-read-write', 'file-traversal-refused');

    await within(async () => (await json('/api/provider/auth'))['devryan-preview-fixture']?.some(method => method.type === 'api'), 'provider catalog activation');
    await json('/api/auth/devryan-preview-fixture', { method: 'PUT', body: { type: 'api', key } });
    evidence.scenarios.push('provider-api-key-setup');
    const stream = await call('/api/global/event', { signal: streamAbort.signal });
    assert.ok(stream.headers.get('content-type')?.includes('text/event-stream'));
    streamTask = (async () => {
      try {
        for await (const chunk of stream.body) {
          streamed += Buffer.from(chunk).toString('utf8');
          assert.ok(streamed.length < 4 * 1024 * 1024, 'SSE evidence bound');
        }
      } catch (error) { if (!streamAbort.signal.aborted) throw error; }
    })();
    // Attach rejection handling immediately; assertions below still observe the failure.
    streamTask.catch(() => {});
    const model = { providerID: 'devryan-preview-fixture', modelID: 'smoke' };
    const session = await json('/api/session', { method: 'POST', body: { title: 'Windows preview fixture', model, agent: 'build' } });
    assert.ok(typeof session.id === 'string');
    await call(`/api/session/${session.id}/prompt_async`, { method: 'POST', body: { model, agent: 'build', parts: [{ type: 'text', text: 'Reply with the fixture message.' }] } });
    await within(async () => {
      const messages = await json(`/api/session/${session.id}/message`);
      return JSON.stringify(messages).includes(marker) && messages.some(row => row.info?.role === 'assistant' && row.info?.time?.completed);
    }, 'chat completion');
    await within(() => streamed.includes(marker), 'SSE text');
    assert.ok(provider.authenticated > 0);
    evidence.scenarios.push('api-key-authenticated-provider-request', 'chat-completion', 'sse-text', 'session-history');

    provider.hold();
    const previousCalls = provider.calls;
    await call(`/api/session/${session.id}/prompt_async`, { method: 'POST', body: { model, agent: 'build', parts: [{ type: 'text', text: 'Wait until aborted.' }] } });
    await within(() => provider.calls > previousCalls, 'abort request started');
    await call(`/api/session/${session.id}/abort`, { method: 'POST', body: {} });
    await within(async () => {
      const status = await json('/api/session/status');
      return !status[session.id] || status[session.id]?.type === 'idle';
    }, 'abort settled');
    evidence.scenarios.push('active-chat-abort');

    for (const [method, route, body] of [
      ['POST', `/api/session/${session.id}/revert`, {}],
      ['POST', '/api/session', { parentID: session.id }],
      ['POST', '/api/provider/openai/oauth/authorize', {}],
      ['GET', '/api/bots'], ['POST', '/api/terminal', {}],
    ]) {
      const response = await request(route, { method, headers: { ...headers, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
      assert.ok([403, 404, 405, 409, 501, 503].includes(response.status), `${route} must refuse preview access, got ${response.status}`);
    }
    evidence.scenarios.push('unsupported-routes-refused');
    await fs.writeFile(markerPath, JSON.stringify({ sessionID: session.id, marker }));
    return { ...evidence, status: 'passed' };
  } finally {
    streamAbort.abort();
    await streamTask;
    await provider.close();
  }
}
