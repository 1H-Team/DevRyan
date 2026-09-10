// Opt-in transport conformance fixture. Only temporary config and loopback providers.
// Run from the repository root with DEVRYAN_TEST_OPENCODE_BIN set explicitly.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createPrimaryRecoveryHost } from '../../packages/harness-runtime/index.js';

const binary = process.env.DEVRYAN_TEST_OPENCODE_BIN;
if (!binary || !path.isAbsolute(binary)) throw new Error('Set DEVRYAN_TEST_OPENCODE_BIN to the OpenCode binary under test');
const fault = process.env.DEVRYAN_RECOVERY_FAULT ?? 'heartbeat';
if (!['heartbeat', 'silent-sse', 'non-sse', 'missing-headers', 'semantic', 'upstream-timeout', 'tool-input'].includes(fault)) throw new Error('Unsupported fixture fault');
await fs.mkdir(path.resolve('.tmp'), { recursive: true });
const root = await fs.mkdtemp(path.resolve('.tmp/provider-recovery-fixture-'));
const initialized = spawnSync('git', ['init', '--quiet', root]);
if (initialized.status !== 0) throw new Error('Could not isolate the fixture Git root');
await fs.writeFile(path.join(root, '.gitignore'), '*\n');
const sentinel = path.join(root, 'recovery-sentinel.txt');
await fs.writeFile(sentinel, 'original fixture content\n');
const configRoot = path.join(root, 'config');
await fs.mkdir(configRoot, { recursive: true });
const providerID = process.env.DEVRYAN_RECOVERY_PROVIDER ?? (['upstream-timeout', 'tool-input'].includes(fault) ? 'anthropic' : 'openai');
if (!['openai', 'anthropic'].includes(providerID)) throw new Error('Unsupported fixture provider');
if (['upstream-timeout', 'tool-input'].includes(fault) && providerID !== 'anthropic') throw new Error('Claude error fixtures require anthropic');
const modelID = providerID === 'anthropic' ? 'claude-fixture' : 'gpt-fixture';
const model = `${providerID}/${modelID}`;
const config = { model, default_agent: 'orchestrator', enabled_providers: [providerID],
  plugin: [pathToFileURL(path.resolve('packages/web/server/default-config/plugins/devryan-primary-recovery.mjs')).href],
  agent: { orchestrator: { mode: 'primary', model, prompt: 'Respond to the user.' } },
  provider: { [providerID]: { options: { apiKey: 'fixture', timeout: 900, headersTimeout: 300, chunkTimeout: 300 },
    models: { [modelID]: { name: 'Fixture', limit: { context: 100000, output: 1000 } } } } } };
if (fault === 'semantic') config.provider[providerID].options.timeout = 10000;

let requests = 0;
const timers = new Set();
let host;
let sseAbort;
let stage = 'startup';
const errors = [];
const diagnostics = [];
const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
  if (req.method !== 'POST') return Response.json({ data: [] });
  requests++;
  if (requests === 1 && fault === 'missing-headers') return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(new Response(null, { status: 504 })), 5000); timers.add(timer);
    req.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(new Response(null, { status: 499 })); });
  });
  const encode = (type, data) => new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  return new Response(new ReadableStream({ start(controller) {
    if (providerID === 'anthropic' && (requests > 1 || ['upstream-timeout', 'tool-input'].includes(fault))) {
      controller.enqueue(encode('message_start', { message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: modelID,
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }));
      if (requests === 1) {
        if (fault === 'tool-input') {
          controller.enqueue(encode('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_fixture', name: 'edit', input: {} } }));
          controller.enqueue(encode('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ filePath: sentinel, oldString: 'original fixture content', newString: 'unexpected mutation' }).slice(0, -1) } }));
        }
        controller.enqueue(encode('error', { error: { type: 'upstream_timeout', message: 'Upstream stalled: no data for 208771ms' } }));
      } else {
        controller.enqueue(encode('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }));
        controller.enqueue(encode('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Recovered safely.' } }));
        controller.enqueue(encode('content_block_stop', { index: 0 }));
        controller.enqueue(encode('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }));
        controller.enqueue(encode('message_stop', {}));
      }
      controller.close(); return;
    }
    if (requests === 1) {
      if (fault === 'silent-sse' || fault === 'non-sse') return;
      const timer = setInterval(() => { try { controller.enqueue(new TextEncoder().encode(': fixture-heartbeat\n\n')); } catch { clearInterval(timer); } }, 40); timers.add(timer);
      req.signal.addEventListener('abort', () => { clearInterval(timer); try { controller.close(); } catch {} });
      return;
    }
    const response = { id: 'resp_fixture', object: 'response', created_at: 1, model: 'gpt-fixture', status: 'completed',
      output: [{ id: 'item_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Recovered safely.', annotations: [] }] }],
      usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
    controller.enqueue(encode('response.created', { response: { ...response, status: 'in_progress', output: [] } }));
    controller.enqueue(encode('response.output_item.added', { output_index: 0, item: { id: 'item_fixture', type: 'message', role: 'assistant', content: [] } }));
    controller.enqueue(encode('response.content_part.added', { output_index: 0, item_id: 'item_fixture', content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }));
    controller.enqueue(encode('response.output_text.delta', { output_index: 0, item_id: 'item_fixture', content_index: 0, delta: 'Recovered safely.' }));
    controller.enqueue(encode('response.output_text.done', { output_index: 0, item_id: 'item_fixture', content_index: 0, text: 'Recovered safely.' }));
    controller.enqueue(encode('response.output_item.done', { output_index: 0, item: response.output[0] }));
    controller.enqueue(encode('response.completed', { response })); controller.close();
  } }), { headers: { 'content-type': requests === 1 && fault === 'non-sse' ? 'application/json' : 'text/event-stream' } });
} });
const bridge = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
  if (req.headers.get('authorization') !== 'Bearer fixture') return new Response(null, { status: 403 });
  try {
    const envelope = await req.json();
    const result = await host.plugin(envelope.params);
    return Response.json({ ok: true, result });
  } catch (error) {
    errors.push(error.code ?? error.message);
    return Response.json({ ok: false, error: { code: error.code ?? 'fixture_error' } }, { status: 409 });
  }
} });
const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
const port = reservation.port; reservation.stop(true);
const base = `http://127.0.0.1:${port}`;
config.provider[providerID].options.baseURL = `http://127.0.0.1:${provider.port}/v1`;
const child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
  cwd: root, env: { PATH: process.env.PATH, XDG_CONFIG_HOME: configRoot, XDG_DATA_HOME: path.join(root, 'data'),
    XDG_CACHE_HOME: path.join(root, 'cache'), XDG_STATE_HOME: path.join(root, 'state'),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_TEST_HOME: root, OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true', OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
    OPENCODE_DISABLE_CLAUDE_CODE: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true',
    DEVRYAN_ORCHESTRATION_URL: `http://127.0.0.1:${bridge.port}/rpc`, DEVRYAN_ORCHESTRATION_TOKEN: 'fixture' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', (data) => { logs = (logs + data).slice(-30000); });
child.stderr.on('data', (data) => { logs = (logs + data).slice(-30000); });
const request = async (route, body) => {
  const response = await fetch(`${base}${route}`, { ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return response.status === 204 ? null : response.json();
};
try {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Fixture OpenCode exited during startup');
    try {
      const health = await fetch(`${base}/global/health`, { signal: AbortSignal.timeout(5000) });
      if (health.ok) break;
    } catch { await Bun.sleep(100); }
    if (i === 99) throw new Error(`fixture did not start: ${logs}`);
  }
  stage = 'host';
  host = createPrimaryRecoveryHost({
    // This gate vouches only for this isolated fake provider. It cannot certify
    // the production Meridian/Agent SDK integration. No production setting is changed.
    isAnthropicConformant: () => providerID === 'anthropic',
    dataDirectory: path.join(root, 'host'), mode: 'enforce', anthropicMode: 'enforce', progressTimeoutMs: fault === 'semantic' ? 1000 : 5000,
    buildOpenCodeUrl: (route) => `${base}${route}`, isManaged: () => true, authorize: async () => true,
    managedBarrier: async () => ({ state: 'clear' }), recordIncident: (incident) => diagnostics.push(incident) });
  await host.initialize();
  sseAbort = new AbortController();
  const events = await fetch(`${base}/global/event`, { signal: sseAbort.signal });
  void (async () => {
    const reader = events.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
    try { while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let split;
      while ((split = buffer.indexOf('\n\n')) >= 0) {
        const packet = buffer.slice(0, split); buffer = buffer.slice(split + 2);
        const data = packet.split('\n').find((line) => line.startsWith('data: '));
        if (data) { const event = JSON.parse(data.slice(6)); host.observe(event.payload ?? event); }
      }
    } } catch (error) { if (!sseAbort.signal.aborted) errors.push(error.message); }
  })();
  stage = 'session';
  const session = await request('/session', { title: 'Isolated recovery conformance' });
  const messageID = `msg_${(BigInt(Date.now()) * 4096n).toString(16).slice(-12)}00000000000001`;
  const body = { messageID, agent: 'orchestrator', model: { providerID, modelID },
    variant: 'xhigh',
    parts: [{ type: 'text', text: 'Please respond with a short acknowledgement.' }] };
  stage = 'admission';
  const admitted = await host.handleRequest('POST', `/session/${session.id}/prompt_async?directory=${encodeURIComponent(root)}`, body);
  if (admitted) throw new Error(`Admission failed: ${JSON.stringify(admitted)}`);
  stage = 'prompt';
  await request(`/session/${session.id}/prompt_async`, body);
  let snapshot;
  for (let i = 0; i < 1200; i++) {
    snapshot = await host.getSnapshot(session.id);
    if (snapshot.record.state === 'completed' || snapshot.record.state === 'needs_attention') break;
    await Bun.sleep(100);
  }
  if (await fs.readFile(sentinel, 'utf8') !== 'original fixture content\n') throw new Error('Recovery mutated the sentinel');
  const report = { fault, providerID, transport: 'loopback-fake-provider', productionClaudeConformance: false, root, requests, snapshot, errors, diagnostics };
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ fault, root, requests, state: snapshot.record.state, reason: snapshot.record.reason, attemptCount: snapshot.record.attemptCount, errors }));
  if (fault === 'tool-input') {
    if (requests !== 1 || snapshot.record.attemptCount !== 0 || snapshot.record.reason !== 'recovery_tool_outcome_unknown') throw new Error('Interrupted tool input must never be replayed');
  } else if (fault === 'semantic') {
    if (requests !== 1 || snapshot.record.attemptCount !== 0 || snapshot.record.reason !== 'provider_progress_timeout') throw new Error('Semantic cutoff conformance failed');
  } else if (snapshot.record.reason === 'native_retry_fenced') {
    // Retryable transport failures reach the existing native-retry fence before
    // finalization. That path must stop without replaying the provider request.
    if (requests !== 1 || snapshot.record.attemptCount !== 0 || snapshot.record.state !== 'needs_attention'
      || !errors.includes('provider_retry_requires_reconciliation')
      || errors.some((error) => error !== 'provider_retry_requires_reconciliation')) {
      throw new Error('Native retry fencing conformance failed');
    }
  } else if (requests !== 2 || snapshot.record.attemptCount !== 1 || snapshot.record.state !== 'completed') {
    throw new Error('Transient recovery conformance failed; inspect the isolated report');
  }
  await fs.writeFile(path.join(root, 'runtime.log'), logs);
} catch (error) {
  console.log(JSON.stringify({ stage, error: error.message, root, errors, diagnostics, logs }, null, 2));
  process.exitCode = 1;
} finally {
  await fs.writeFile(path.join(root, 'runtime.log'), logs);
  for (const timer of timers) { clearTimeout(timer); clearInterval(timer); }
  sseAbort?.abort();
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited; clearTimeout(killTimer);
  }
  await host?.drain(); bridge.stop(true); provider.stop(true);
}
