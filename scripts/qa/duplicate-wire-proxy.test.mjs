import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import tls from 'node:tls';
import { once } from 'node:events';
import { createHash, X509Certificate } from 'node:crypto';
import { duplicateLiveFixture } from './duplicate-live-fixture.mjs';
import { DUPLICATE_WIRE_ROUTES, createDuplicateWireProxy, projectDuplicateWire, resolveDuplicateWireRoute } from './duplicate-wire-proxy.mjs';
import { DUPLICATE_PROVIDER_ROUTES } from '../../packages/web/server/lib/opencode/duplicate-provider-route.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Item shapes emitted by @ai-sdk/xai 3.0.102 convertToXaiResponsesInput and
// XaiResponsesLanguageModel.getArgs under OpenCode's xAI defaults (store=false).
const xaiManagedBody = (fixture, model = 'grok-4.7') => {
  const task = JSON.stringify({ task: { taskId: 'dvr_task_qa_continuity', status: 'failed' }, resultEnvelope: { envelopeId: 'env_qa_continuity' },
    resultHeader: { schemaVersion: 1, taskId: 'dvr_task_qa_continuity', envelopeId: 'env_qa_continuity', outcome: { status: 'failed' }, criticalFailures: [fixture.body] } });
  const reference = JSON.stringify({ schemaVersion: 1, observation: 'identical-managed-result', taskId: 'dvr_task_qa_continuity',
    envelopeId: 'env_qa_continuity', reference: { messageID: 'msg_seed', callID: 'call_one' }, instruction: 'Use the retained observation.' });
  const call = (id, name, input) => ({ type: 'function_call', id, call_id: id, name, arguments: JSON.stringify(input), status: 'completed' });
  return { model, input: [
    { role: 'system', content: 'You are the builder.' },
    { role: 'user', content: [{ type: 'input_text', text: 'Earlier request' }] },
    { type: 'reasoning', id: 'rs_synthetic', summary: [], status: 'completed', encrypted_content: 'opaque' },
    call('call_one', 'devryan_task', { action: 'status', taskId: 'dvr_task_qa_continuity' }),
    { type: 'function_call_output', call_id: 'call_one', output: task },
    call('call_two', 'devryan_task', { action: 'status', taskId: 'dvr_task_qa_continuity' }),
    { type: 'function_call_output', call_id: 'call_two', output: reference },
    call('call_read', 'read', { filePath: 'unique-evidence.txt' }),
    { type: 'function_call_output', call_id: 'call_read', output: `uniqueProof=${fixture.uniqueProof}` },
    { role: 'assistant', content: 'Evidence gathered.', id: 'msg_assistant' },
    { role: 'user', content: [{ type: 'input_text', text: fixture.prompt }] },
  ], reasoning: { effort: 'medium' }, store: false, include: ['reasoning.encrypted_content'], prompt_cache_key: 'ses_synthetic',
  tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }], tool_choice: 'auto', stream: true };
};

const tunnel = (origin, authority) => new Promise((resolve, reject) => {
  const { hostname, port } = new URL(origin);
  const request = http.request({ host: hostname, port, method: 'CONNECT', path: authority, agent: false });
  request.once('connect', (response, socket) => resolve({ statusCode: response.statusCode, socket }));
  request.once('error', reject); request.end();
});
// A client through the proxy exactly as HTTPS_PROXY + NODE_EXTRA_CA_CERTS
// clients connect: CONNECT, then TLS verified against the temporary CA.
const send = async (proxy, { host, method = 'POST', target, chunks = [], headers = {} }) => {
  const { statusCode, socket } = await tunnel(proxy.origin, `${host}:443`);
  if (statusCode !== 200) { socket.destroy(); return { connectStatus: statusCode }; }
  const secure = tls.connect({ socket, servername: host, ca: await fs.readFile(proxy.cert) });
  await once(secure, 'secureConnect');
  return new Promise(resolve => {
    const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const request = http.request({ method, path: target, createConnection: () => secure,
      headers: { host, ...(method === 'POST' ? { 'content-type': 'application/json', 'content-length': length } : {}), ...headers } });
    request.once('response', response => {
      const parts = []; response.on('data', chunk => parts.push(chunk));
      response.once('end', () => { secure.destroy(); resolve({ statusCode: response.statusCode, body: Buffer.concat(parts) }); });
    });
    request.once('error', error => { secure.destroy(); resolve({ error: error.code ?? 'error' }); });
    (async () => {
      // Separate TLS records, so the proxy receives separate request chunks.
      for (const chunk of chunks) { if (request.destroyed) return; request.write(chunk); await new Promise(done => setTimeout(done, 20)); }
      request.end();
    })();
  });
};
const sse = events => events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
const fakeUpstream = body => {
  const calls = [];
  return { calls, fetchImpl: async (url, init) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers, body: Buffer.from(init.body) });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  } };
};

test('wire routes are registered per provider and bound to the host-attested transports', () => {
  assert.deepEqual(Object.keys(DUPLICATE_WIRE_ROUTES).sort(), ['openai', 'xai']);
  for (const [provider, route] of Object.entries(DUPLICATE_WIRE_ROUTES)) {
    assert.equal(route.provider, provider);
    assert.equal(route.transportIdentity, DUPLICATE_PROVIDER_ROUTES[provider]);
    assert.equal(route.transport, 'responses'); assert.equal(route.auth, 'oauth'); assert.equal(Object.isFrozen(route), true);
    assert.equal(resolveDuplicateWireRoute(provider), route);
  }
  assert.deepEqual([DUPLICATE_WIRE_ROUTES.openai.host, DUPLICATE_WIRE_ROUTES.openai.path], ['chatgpt.com', '/backend-api/codex/responses']);
  assert.deepEqual([DUPLICATE_WIRE_ROUTES.xai.host, DUPLICATE_WIRE_ROUTES.xai.path], ['api.x.ai', '/v1/responses']);
  assert.throws(() => resolveDuplicateWireRoute('anthropic'), { message: 'unsupported-route:anthropic-meridian' });
  for (const [providerID, message] of [['cursor-acp', 'unsupported-route:cursor-acp'], ['__proto__', 'unsupported-route:__proto__'],
    ['toString', 'unsupported-route:unknown'], ['grok', 'unsupported-route:grok'], [undefined, 'unsupported-route:unknown'],
    ['Not A Provider', 'unsupported-route:unknown'], [{ toString: () => 'xai' }, 'unsupported-route:unknown']]) {
    assert.throws(() => resolveDuplicateWireRoute(providerID), { message }, String(providerID));
  }
});

test('xAI Responses bodies project reference, call-pair and fixture evidence without content', () => {
  const fixture = duplicateLiveFixture(5);
  const body = xaiManagedBody(fixture);
  const observation = projectDuplicateWire(JSON.stringify(body));
  assert.equal(observation.trialIndex, 5);
  assert.equal(observation.managedReferences, 1); assert.equal(observation.skillReferences, 0);
  assert.equal(observation.referencesResolve, true); assert.equal(observation.callPairsIntact, true);
  assert.deepEqual(observation.factHashes, [hash(fixture.facts)]);
  assert.deepEqual(observation.uniqueProofHashes, [hash(fixture.uniqueProof)]);
  assert.equal(observation.model, 'grok-4.7'); assert.equal(observation.reasoningEffort, 'medium');
  assert.equal(observation.conversationIdentifier, createHash('sha256').update('ses_synthetic').digest('hex'));
  assert.equal(observation.history.length, body.input.length);
  for (const secret of [fixture.facts.handoffCode, fixture.uniqueProof, 'DUPLICATE_QA_FACT', 'ses_synthetic']) assert.equal(JSON.stringify(observation).includes(secret), false);
  // An orphaned output or a reference to a missing source fails integrity.
  const orphan = structuredClone(body); orphan.input.splice(3, 1);
  assert.equal(projectDuplicateWire(JSON.stringify(orphan)).callPairsIntact, false);
  assert.equal(projectDuplicateWire(JSON.stringify(orphan)).referencesResolve, true);
  const unresolved = structuredClone(body); unresolved.input.splice(3, 2);
  assert.equal(projectDuplicateWire(JSON.stringify(unresolved)).referencesResolve, false);
  const skill = structuredClone(body);
  skill.input[6].output = '<devryan_skill_reuse>The byte-identical completed skill content is retained earlier in this active context.</devryan_skill_reuse>';
  assert.equal(projectDuplicateWire(JSON.stringify(skill)).skillReferences, 1);
});

test('xAI route forwards only registered OAuth Responses traffic byte-for-byte and keeps hashes and usage only', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'duplicate-wire-xai-'));
  const fixture = duplicateLiveFixture(5);
  const stream = sse([
    { type: 'response.created', response: { id: 'resp_synthetic', model: 'grok-4.7', status: 'in_progress' } },
    { type: 'response.output_text.delta', delta: '{"state":"failed"}' },
    { type: 'response.completed', response: { id: 'resp_synthetic', model: 'grok-4.7', status: 'completed',
      usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 1024 }, output_tokens: 40,
        output_tokens_details: { reasoning_tokens: 10 }, cost_in_usd_ticks: 123456 } } },
  ]);
  const upstream = fakeUpstream(stream);
  const proxy = await createDuplicateWireProxy({ root, context: () => ({ arm: 'candidate', index: 5, phase: 'continuity' }),
    providerID: 'xai', model: 'grok-4.7', maximumRequests: 5, fetchImpl: upstream.fetchImpl });
  try {
    assert.equal(proxy.route, DUPLICATE_WIRE_ROUTES.xai);
    const names = new X509Certificate(await fs.readFile(proxy.cert)).subjectAltName;
    assert.match(names, /DNS:api\.x\.ai/); assert.doesNotMatch(names, /chatgpt\.com/);

    const bytes = Buffer.from(JSON.stringify(xaiManagedBody(fixture)));
    const split = bytes.indexOf(Buffer.from('世')) + 1; // inside a three-byte sequence
    const reply = await send(proxy, { host: 'api.x.ai', target: '/v1/responses', chunks: [bytes.subarray(0, split), bytes.subarray(split)],
      headers: { authorization: 'Bearer synthetic-oauth-access' } });
    assert.equal(reply.statusCode, 200); assert.equal(reply.body.toString(), stream);
    assert.equal(upstream.calls.length, 1);
    assert.equal(upstream.calls[0].url, 'https://api.x.ai/v1/responses'); assert.equal(upstream.calls[0].method, 'POST');
    assert.equal(Buffer.compare(upstream.calls[0].body, bytes), 0, 'forwarded bytes are the client bytes');
    assert.equal(upstream.calls[0].headers.authorization, 'Bearer synthetic-oauth-access');
    assert.equal(upstream.calls[0].headers.host, undefined);

    const [row] = proxy.evidence;
    assert.deepEqual([row.arm, row.index, row.phase, row.requestIndex, row.status, row.statusCode, row.gap, row.providerError],
      ['candidate', 5, 'continuity', 1, 'complete', 200, null, false]);
    assert.equal(row.request.bytes, bytes.length);
    assert.equal(row.request.bodyHash, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(row.request.trialIndex, 5); assert.equal(row.request.referencesResolve, true); assert.equal(row.request.callPairsIntact, true);
    assert.equal(row.request.factHashes.includes(hash(fixture.facts)), true);
    assert.equal(row.request.uniqueProofHashes.includes(hash(fixture.uniqueProof)), true);
    const usage = row.usageObservation;
    assert.deepEqual([usage.provider, usage.auth, usage.transport, usage.route, usage.requestedModel, usage.responseModel, usage.responseID, usage.purpose],
      ['xai', 'oauth', 'responses', 'xai-oauth-responses-v1', 'grok-4.7', 'grok-4.7', 'resp_synthetic', 'main']);
    assert.deepEqual([usage.tokens.totalInput, usage.tokens.cacheRead, usage.tokens.totalOutput, usage.tokens.reasoning], [1200, 1024, 40, 10]);
    assert.equal(usage.cost.provenance, 'unknown', 'OAuth usage ticks are not provider-billed evidence');

    // Unregistered connects, paths, methods, models, sizes and counts fail closed.
    assert.equal((await send(proxy, { host: 'chatgpt.com', target: '/backend-api/codex/responses' })).connectStatus, 403);
    assert.equal((await send(proxy, { host: 'auth.x.ai', target: '/oauth2/token' })).connectStatus, 403);
    assert.equal((await send(proxy, { host: 'api.x.ai', target: '/v1/chat/completions', chunks: [bytes] })).statusCode, 502);
    assert.equal((await send(proxy, { host: 'api.x.ai', method: 'GET', target: '/v1/models' })).statusCode, 502);
    const other = Buffer.from(JSON.stringify(xaiManagedBody(fixture, 'grok-3-mini')));
    assert.equal((await send(proxy, { host: 'api.x.ai', target: '/v1/responses', chunks: [other] })).statusCode, 502);
    const oversized = Buffer.from(JSON.stringify({ model: 'grok-4.7', input: 'x'.repeat(2 * 1024 * 1024) }));
    await send(proxy, { host: 'api.x.ai', target: '/v1/responses', chunks: [oversized] });
    assert.equal((await send(proxy, { host: 'api.x.ai', target: '/v1/responses', chunks: [bytes] })).statusCode, 502);
    assert.deepEqual(proxy.failures, ['unregistered-connect:chatgpt.com:443', 'unregistered-connect:auth.x.ai:443',
      'unregistered-request', 'unregistered-request', 'unregistered-model', 'oversized-request', 'unregistered-request']);
    assert.equal(upstream.calls.length, 1, 'no refused request reached the upstream');
    assert.deepEqual(proxy.evidence.slice(1).map(row => [row.status, row.failure, row.request]), [
      ['failed', 'unregistered-request', undefined], ['failed', 'unregistered-request', undefined], ['failed', 'unregistered-model', undefined],
      ['failed', 'oversized-request', undefined], ['failed', 'unregistered-request', undefined]]);
    const retained = JSON.stringify({ evidence: proxy.evidence, failures: proxy.failures, metadata: proxy.metadata });
    for (const secret of ['synthetic-oauth-access', fixture.facts.handoffCode, fixture.uniqueProof, 'DUPLICATE_QA_FACT', 'ses_synthetic', 'Evidence gathered']) {
      assert.equal(retained.includes(secret), false, secret);
    }
  } finally { await proxy.close(); }
  await assert.rejects(fs.access(path.join(root, 'wire-key.pem')));
  await fs.rm(root, { recursive: true, force: true });
});

test('OpenAI route keeps its ChatGPT origin and refuses xAI; Anthropic Meridian is refused before any file exists', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'duplicate-wire-openai-'));
  try {
    for (const [providerID, model, message] of [['anthropic', 'claude-opus-5-5', 'unsupported-route:anthropic-meridian'],
      ['openai', undefined, 'unregistered-model'], ['xai', '', 'unregistered-model'], [undefined, 'gpt-6-astra', 'unsupported-route:unknown']]) {
      await assert.rejects(createDuplicateWireProxy({ root, context: () => ({}), providerID, model }), { message });
    }
    assert.deepEqual(await fs.readdir(root), []);
    const stream = sse([{ type: 'response.completed', response: { id: 'resp_openai', model: 'gpt-6-astra', status: 'completed',
      usage: { input_tokens: 900, input_tokens_details: { cached_tokens: 512 }, output_tokens: 12 } } }]);
    const upstream = fakeUpstream(stream);
    const proxy = await createDuplicateWireProxy({ root, context: () => ({ arm: 'baseline', index: null, phase: 'warmup' }),
      providerID: 'openai', model: 'gpt-6-astra', fetchImpl: upstream.fetchImpl });
    try {
      const names = new X509Certificate(await fs.readFile(proxy.cert)).subjectAltName;
      assert.match(names, /DNS:chatgpt\.com/); assert.doesNotMatch(names, /x\.ai/);
      assert.equal((await send(proxy, { host: 'api.x.ai', target: '/v1/responses' })).connectStatus, 403);
      const body = Buffer.from(JSON.stringify({ model: 'gpt-6-astra', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'READY?' }] }] }));
      assert.equal((await send(proxy, { host: 'chatgpt.com', target: '/backend-api/codex/responses', chunks: [body] })).statusCode, 200);
      assert.equal(upstream.calls[0].url, 'https://chatgpt.com/backend-api/codex/responses');
      assert.deepEqual(proxy.failures, ['unregistered-connect:api.x.ai:443']);
      const usage = proxy.evidence[0].usageObservation;
      assert.deepEqual([proxy.evidence[0].status, usage.provider, usage.auth, usage.transport, usage.route, usage.tokens.totalInput],
        ['complete', 'openai', 'oauth', 'responses', 'openai-chatgpt-managed-responses-v1', 900]);
    } finally { await proxy.close(); }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('idle() waits for in-flight forwarded requests and reports a timeout', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'duplicate-wire-idle-'));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fetchImpl = async () => {
    const body = new ReadableStream({ async start(controller) {
      await gate;
      controller.enqueue(new TextEncoder().encode(sse([{ type: 'response.completed', response: { id: 'resp_idle', model: 'grok-4.7', status: 'completed' } }])));
      controller.close();
    } });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const proxy = await createDuplicateWireProxy({ root, context: () => ({ arm: 'baseline', index: null, phase: 'warmup' }),
    providerID: 'xai', model: 'grok-4.7', maximumRequests: 5, fetchImpl });
  try {
    assert.equal(await proxy.idle(10), true);
    const pending = send(proxy, { host: 'api.x.ai', target: '/v1/responses', chunks: [Buffer.from(JSON.stringify({ model: 'grok-4.7', input: [], stream: true }))] });
    while (!proxy.evidence.length) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(await proxy.idle(50), false);
    const drained = proxy.idle(5000);
    release();
    assert.equal(await drained, true);
    assert.equal((await pending).statusCode, 200);
    assert.equal(proxy.evidence[0].status, 'complete');
  } finally { release(); await proxy.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('a metadata catalog that fails after its headers were sent ends that response without crashing the proxy', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'duplicate-wire-metadata-'));
  const fetchImpl = async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"partial":'));
    setTimeout(() => controller.error(new Error('upstream cut')), 20);
  } }), { status: 200, headers: { 'content-type': 'application/json' } });
  const proxy = await createDuplicateWireProxy({ root, context: () => ({ arm: 'baseline', index: null, phase: 'warmup' }),
    providerID: 'xai', model: 'grok-4.7', maximumRequests: 5, fetchImpl });
  try {
    // The client sees a cut response (no clean end), so bound the wait.
    await Promise.race([send(proxy, { host: 'models.dev', method: 'GET', target: '/api.json' }),
      new Promise(resolve => setTimeout(resolve, 1000).unref())]);
    while (proxy.metadata.at(-1)?.statusCode !== null) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(proxy.metadata.at(-1), { route: 'model-catalog', statusCode: null });
    // The proxy keeps serving after the failure.
    assert.equal(await proxy.idle(10), true);
  } finally { await proxy.close(); await fs.rm(root, { recursive: true, force: true }); }
});
