import { expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Global } from '@opencode/util/global';
import { Effect } from 'effect';
import { HttpClientRequest } from 'effect/unstable/http';
import { createBotNativeServer, createBotNativeTools, createBotNativeOAuthMiddleware } from '../../web/server/lib/bots/native-server.mjs';

const token = 'a'.repeat(43);
const environment = { DEVRYAN_BOT_GATEWAY_URL: 'http://egress:43121', DEVRYAN_BOT_RUNTIME_TOKEN: token,
  DEVRYAN_BOT_RUN_ID: '11111111-1111-4111-8111-111111111111',
  DEVRYAN_BOT_CHANNEL_ID: '22222222-2222-4222-8222-222222222222',
  DEVRYAN_BOT_REVISION_ID: '33333333-3333-4333-8333-333333333333', DEVRYAN_BOT_CHATGPT_IMAGE_GENERATION: '0' };

test('API-key native Bot startup, structured requests, cancellation, persistence and isolation retain the actual v2 graph', async () => {
  const parent = fileURLToPath(new URL('../../../.cache/bot-native-tests', import.meta.url));
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'runtime-'));
  const directory = path.join(root, 'workspace'), configDirectory = path.join(root, 'config');
  await fs.mkdir(directory); await fs.mkdir(configDirectory);
  const bodies = [];
  let blockedStarted, blockedSettled;
  const blocked = new Promise(resolve => { blockedStarted = resolve; });
  const settled = new Promise(resolve => { blockedSettled = resolve; });
  const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json();
    bodies.push(body);
    expect(request.headers.get('authorization')).toBe('Bearer bot-native-fixture-key');
    if (body.messages.some(message => message.content === 'Block until cancelled')) {
      blockedStarted();
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(': waiting\n\n')); },
        cancel() { blockedSettled(); } }), { headers: { 'content-type': 'text/event-stream' } });
    }
    const structured = body.tools?.length === 1 && body.tools[0].function.name === 'generate_object';
    const delta = structured ? { tool_calls: [{ index: 0, id: 'call_fixture', type: 'function',
      function: { name: 'generate_object', arguments: JSON.stringify(body.messages.some(message => message.content === 'Invalid structured result') ? {} : { ok: true }) } }] }
      : { role: 'assistant', content: 'Native Bot completion' };
    return new Response([{ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: body.model,
      choices: [{ index: 0, delta, finish_reason: null }] },
    { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: body.model,
      choices: [{ index: 0, delta: {}, finish_reason: structured ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } }]
      .map(row => `data: ${JSON.stringify(row)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } });
  await fs.writeFile(path.join(root, 'auth.json'), JSON.stringify({ owned: { type: 'api', key: 'bot-native-fixture-key' } }));
  await fs.writeFile(path.join(configDirectory, 'opencode.json'), JSON.stringify({ plugins: [],
    mcp: { servers: {} }, snapshots: false, warming: false, update: 'disable', share: 'disabled',
    permissions: [{ action: '*', resource: '*', effect: 'deny' }],
    providers: { owned: { package: '@opencode/ai/providers/openai-compatible', env: [],
      settings: { baseURL: `${provider.url}v1` }, models: { fixture: { capabilities: { tools: true, input: ['text'], output: ['text'] },
        limit: { context: 32768, input: 16384, output: 4096 }, variants: [{ id: 'high', body: { temperature: 0.1 } }] } } } },
    agents: { bot: { mode: 'primary', system: 'Fixture', model: { providerID: 'owned', model: 'fixture' } } },
  }));
  const options = { directory, configDirectory, databasePath: path.join(root, 'native.db'), authPath: path.join(root, 'auth.json'), environment,
    overrides: [Global.node.replace(Global.layerWith({ home: root, data: root, config: configDirectory,
      cache: root, state: root, tmp: root, bin: root, log: root, repos: root }))] };
  let runtime;
  const request = (url, body, authorized = true) => runtime.fetch(new Request(`http://localhost${url}`, {
    method: body === undefined ? 'GET' : 'POST', headers: {
      ...(authorized ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json',
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  try {
    runtime = await createBotNativeServer(options);
    expect((await request('/devryan/ready', undefined, false)).status).toBe(401);
    expect(await (await request('/devryan/ready')).json()).toEqual({ ready: true, generation: 2, opencode: { version: '2.0.24' } });
    expect((await request('/api/credential')).status).toBe(404);
    expect((await request('/api/provider?directory=/other')).status).toBe(400);
    expect((await request('/api/provider?location[directory]=/other')).status).toBe(400);
    expect((await request(`/api/provider?location[directory]=${encodeURIComponent(directory)}&location[directory]=/other`)).status).toBe(400);
    expect((await request('/api/session?location[workspace]=other')).status).toBe(400);
    expect((await request('/api/session?location[directory]=/other', {})).status).toBe(400);
    const created = await request('/api/session', { title: 'Bot persisted fixture' });
    expect(created.status).toBe(200);
    const session = (await created.json()).data;
    expect(session.id).toMatch(/^ses/);
    expect((await request('/devryan/bot/prompt', { sessionID: session.id })).status).toBe(400);
    expect((await request('/devryan/bot/structured', { model: {}, prompt: 'bad', schema: {}, system: '' })).status).toBe(400);
    const structuredInput = { model: { providerID: 'owned', id: 'fixture', variant: 'high' }, prompt: 'Return fixture result',
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }, system: 'Fixture system', title: 'private' };
    const structured = await request('/devryan/bot/structured', structuredInput);
    expect(structured.status).toBe(200);
    expect(await structured.json()).toEqual({ output: { ok: true } });
    expect(bodies.at(-1).temperature).toBe(0.1);
    expect(bodies.at(-1).tools.map(item => item.function.name)).toEqual(['generate_object']);
    const invalidStructured = await request('/devryan/bot/structured', { ...structuredInput, prompt: 'Invalid structured result' });
    expect(invalidStructured.status).toBe(502);
    expect((await (await request('/api/session')).json()).data).toHaveLength(1);
    const accepted = await request('/devryan/bot/prompt', { sessionID: session.id, model: structuredInput.model,
      prompt: { id: 'msg_fixture_native_bot', text: 'Complete this native turn', delivery: 'queue', metadata: { fixture: true } } });
    expect(accepted.status).toBe(200);
    const deadline = Date.now() + 5_000;
    let messages = [];
    while (Date.now() < deadline) {
      messages = (await (await request(`/api/session/${session.id}/message`)).json()).data;
      if (JSON.stringify(messages).includes('Native Bot completion')) break;
      await Bun.sleep(10);
    }
    expect(JSON.stringify(messages)).toContain('Native Bot completion');
    const controller = new AbortController();
    const cancelled = runtime.fetch(new Request('http://localhost/devryan/bot/structured', { method: 'POST',
      headers: { authorization: `Bearer ${token}` }, signal: controller.signal,
      body: JSON.stringify({ ...structuredInput, prompt: 'Block until cancelled' }),
    }));
    await blocked;
    controller.abort();
    expect((await cancelled).status).toBe(502);
    await settled;
    await runtime.close();
    runtime = await createBotNativeServer(options);
    const restored = await request(`/api/session/${session.id}`);
    expect(restored.status).toBe(200);
    expect((await restored.json()).data.title).toBe('Bot persisted fixture');
  } finally { await runtime?.close(); await provider.stop(true); await fs.rm(root, { recursive: true, force: true }); }
}, 30_000);


test('native Bot SIWC image refusal precedes dependency file reads, OAuth access and provider requests', async () => {
  let executions = 0, accessCalls = 0;
  const tools = await createBotNativeTools({ directory: '/workspace', openaiOAuth: true,
    access: async () => { accessCalls++; throw new Error('unexpected access'); },
    environment: { ...environment, DEVRYAN_BOT_CHATGPT_IMAGE_GENERATION: '1' },
    imageToolFactory: async () => ({ args: {}, execute: async () => { executions++; throw new Error('reference file read would begin here'); } }),
  });
  const image = { prompt: 'fixture', out: 'fixture.png', quality: 'medium', images: ['reference.png'] };
  await expect(tools.devryan_image.execute(image, { directory: '/workspace' })).rejects.toMatchObject({ code: 'native_image_generation_siwc_unsupported' });
  await expect(tools.devryan_bot.execute({ operation: 'image.generate', payload: image }, { directory: '/workspace' }))
    .rejects.toMatchObject({ code: 'native_image_generation_siwc_unsupported' });
  expect(executions).toBe(0); expect(accessCalls).toBe(0);
});

test('native OAuth structured executor reuses SIWC projection and forwards other providers unchanged', async () => {
  const sent = [], forward = request => { throw new Error(`Unexpected forwarding: ${request.url}`); };
  const middleware = createBotNativeOAuthMiddleware({
    access: async () => ({ accessToken: 'synthetic-access', accountId: 'synthetic-subject', expiresAt: Date.now() + 3600000 }),
    fetchImpl: async (url, input) => {
      sent.push({ url: String(url), body: JSON.parse(input.body), headers: new Headers(input.headers) });
      return new Response('data: {"type":"response.completed","response":{"id":"fixture","status":"completed","output":[]}}\n\n',
        { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const body = { model: 'fixture', input: [{ role: 'system', content: [{ type: 'input_text', text: 'Schema output' }] }],
    tools: [{ type: 'function', name: 'generate_object', parameters: { type: 'object' } }],
    tool_choice: { type: 'function', name: 'generate_object' }, store: true, temperature: 0.2 };
  const request = HttpClientRequest.bodyText(HttpClientRequest.post('https://api.openai.com/v1/responses'), JSON.stringify(body), 'application/json');
  const response = await Effect.runPromise(middleware(request, forward));
  await Effect.runPromise(response.text);
  expect(sent).toHaveLength(1);
  expect(sent[0].body).toMatchObject({ store: false, stream: true, input: [{ role: 'developer' },
    { type: 'additional_tools', tools: [{ type: 'function', name: 'generate_object' }] }] });
  expect(sent[0].body.tools).toBeUndefined();expect(sent[0].body.temperature).toBeUndefined();
  expect(sent[0].headers.get('chatgpt-account-id')).toBeNull();
  const other = HttpClientRequest.post('https://provider.invalid/v1/responses');
  const forwarded = [];
  expect(await Effect.runPromise(middleware(other, original => { forwarded.push(original); return Effect.succeed('untouched'); }))).toBe('untouched');
  expect(forwarded).toEqual([other]);expect(sent).toHaveLength(1);
});

test('native OAuth structured executor releases the shared physical send when cancelled', async () => {
  let begin, settle;const began = new Promise(resolve => { begin = resolve; }), settled = new Promise(resolve => { settle = resolve; });
  const middleware = createBotNativeOAuthMiddleware({ access: async () => ({ accessToken: 'synthetic-access' }),
    fetchImpl: (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { settle();reject(new Error('cancelled')); }, { once: true });begin();
    }) });
  const request = HttpClientRequest.bodyText(HttpClientRequest.post('https://api.openai.com/v1/responses'), JSON.stringify({ input: [] }), 'application/json');
  const abort = new AbortController();
  const pending = Effect.runPromise(middleware(request, () => Effect.die('Unexpected forward')), { signal: abort.signal });
  pending.catch(() => {});await began;abort.abort();await settled;
  await expect(pending).rejects.toThrow();
});
