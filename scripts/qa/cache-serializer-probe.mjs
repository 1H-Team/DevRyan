// Explicit real-binary, loopback-only verification; never part of offline suites.
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { reservePort, startOwnedProcess } from './process.mjs';
import { initializeCacheStudy } from './cache-study.mjs';
import { projectWireRequest } from './cache-wire-evidence.mjs';

export function gradeSerializedPrefix(first, second) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  return { instructionsStable: same(first.instructions, second.instructions), toolsStable: same(first.tools, second.tools),
    priorHistoryStable: first.history?.length > 0 && same(first.history, second.history?.slice(0, first.history.length)),
    cacheParametersStable: first.cacheParametersHash === second.cacheParametersHash };
}
function respond(res, body, ordinal) {
  const emit = event => res.write('data: ' + JSON.stringify(event) + '\n\n');
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  if (body.model.startsWith('grok')) {
    emit({ id: `chat_${ordinal}`, object: 'chat.completion.chunk', created: 1, model: body.model,
      choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10000, completion_tokens: 10, total_tokens: 10015,
        prompt_tokens_details: { cached_tokens: 6000 }, completion_tokens_details: { reasoning_tokens: 5 } } });
    res.end('data: [DONE]\n\n'); return;
  }
  const item = { id: `msg_${ordinal}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done', annotations: [] }] };
  const response = { id: `resp_${ordinal}`, object: 'response', created_at: 1, model: body.model, status: 'in_progress', output: [] };
  emit({ type: 'response.created', response });
  emit({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
  emit({ type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
  emit({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'done' });
  emit({ type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: 'done' });
  emit({ type: 'response.output_item.done', output_index: 0, item });
  emit({ type: 'response.completed', response: { ...response, status: 'completed', output: [item], usage: {
    input_tokens: 10000, output_tokens: 10, total_tokens: 10010, input_tokens_details: { cached_tokens: 6000, cache_write_tokens: 3000 }, output_tokens_details: { reasoning_tokens: 2 },
  } } });
  res.end();
}

export async function runCacheSerializerProbe({ binary }) {
  if (!path.isAbsolute(binary)) throw new Error('Explicit absolute OpenCode binary required');
  const root = fileURLToPath(new URL('../../.cache/qa/', import.meta.url));
  await fs.mkdir(root, { recursive: true });
  const output = await fs.mkdtemp(path.join(root, 'cache-serializer-')), runtimeRoot = path.join(output, 'runtime');
  const home = path.join(runtimeRoot, 'home'), workspace = path.join(runtimeRoot, 'workspace');
  await fs.mkdir(home, { recursive: true }); await fs.mkdir(workspace);
  await fs.writeFile(path.join(home, '.devryan-qa-home'), 'owned QA home\n');
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'init', '--quiet', workspace]);
  const requests = [], results = [];
  const upstream = http.createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new Error('Fixture request too large'); }
      const body = JSON.parse(raw);
      requests.push({ path: req.url, ...projectWireRequest(raw, req.headers) });
      respond(res, body, requests.length);
    } catch { res.writeHead(500); res.end('Fixture rejected request'); }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  const models = [['openai', 'gpt-5.6-sol'], ['openai', 'gpt-6-astra'], ['xai', 'grok-4.6']];
  const runtimeVersion = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
  await initializeCacheStudy({ runtimeRoot, home, runtimeVersion, routes: models.map(([provider, model]) => ({
    id: model, provider, model, auth: 'api_key', transport: provider === 'xai' ? 'chat_completions' : 'responses', origin,
    path: provider === 'xai' ? '/v1/chat/completions' : '/v1/responses',
  })) });
  const provider = {};
  for (const [id, model] of models) {
    provider[id] ??= { options: { baseURL: origin + '/v1', apiKey: 'synthetic-qa' }, models: {} };
    provider[id].models[model] = { name: model, reasoning: true, limit: { context: 128000, output: 1000 }, variants: { medium: { reasoningEffort: 'medium' } } };
  }
  const config = path.join(runtimeRoot, 'opencode.json');
  await fs.writeFile(config, JSON.stringify({ provider, model: 'openai/gpt-5.6-sol', agent: { title: { disable: true } },
    plugin: [new URL('./cache-wire-plugin.mjs', import.meta.url).href], enabled_providers: ['openai', 'xai'] }));
  const port = await reservePort();
  const child = startOwnedProcess(binary, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: workspace,
    env: { PATH: process.env.PATH, HOME: home, OPENCODE_TEST_HOME: home, LANG: 'en_US.UTF-8',
      XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'), XDG_CACHE_HOME: path.join(home, 'cache'), XDG_STATE_HOME: path.join(home, 'state'),
      OPENCODE_CONFIG: config, OPENCODE_CONFIG_DIR: path.join(home, 'overlay'), OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true',
      OPENCODE_DISABLE_PROJECT_CONFIG: 'true', DEVRYAN_QA_RUNTIME_ROOT: runtimeRoot, DEVRYAN_QA_HOME: home } });
  const request = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-opencode-directory': workspace },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`OpenCode fixture HTTP ${response.status}`);
    return response.json();
  };
  let cleanup;
  try {
    const deadline = Date.now() + 60000;
    while (true) {
      child.check();
      try { await request('/global/health'); break; } catch (error) { if (Date.now() >= deadline) throw error; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    for (const [providerID, modelID] of models) {
      const session = await request('/session', { title: 'Cache serializer fixture' });
      const replies = [];
      for (let turn = 0; turn < 2; turn++) {
        await fs.writeFile(path.join(runtimeRoot, 'cache-context.json'), JSON.stringify({ phase: 'aa', purpose: 'main', sessionID: session.id,
          rootSessionID: session.id, use: turn ? 'warm' : 'first', runtimeVersion }));
        const reply = await request(`/session/${session.id}/message`, { model: { providerID, modelID }, variant: 'medium', agent: 'build',
          parts: [{ type: 'text', text: 'Reply done.' }] });
        replies.push({ error: reply.info?.error?.name ?? null, tokens: reply.info?.tokens, correct: reply.parts?.some(part => part.type === 'text' && part.text === 'done') === true });
      }
      const pair = requests.filter(row => row.model === modelID);
      results.push({ providerID, modelID, replies, attempts: pair.length, checks: pair.length === 2 ? gradeSerializedPrefix(...pair) : null });
    }
  } finally {
    cleanup = await child.stop(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    for (const file of ['cache-wire.ndjson', 'cache-attempts.json']) await fs.copyFile(path.join(runtimeRoot, file), path.join(output, file)).catch(() => {});
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
  const wire = (await fs.readFile(path.join(output, 'cache-wire.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
  const reservations = JSON.parse(await fs.readFile(path.join(output, 'cache-attempts.json'), 'utf8')).attempts;
  const observerChecks = { dispatchesMatch: wire.filter(row => row.type === 'dispatch').length === requests.length,
    responsesMatch: wire.filter(row => row.type === 'response').length === requests.length,
    reservationsMatch: reservations.length === requests.length,
    noGaps: wire.every(row => !row.gap && row.type !== 'gap'),
    actualModelObserved: wire.filter(row => row.type === 'response').every(row => row.usageObservation?.responseModel === row.usageObservation?.requestedModel) };
  const evidence = { version: 1, runtimeVersion, liveProvider: false, results, observerChecks, requests, cleanup, output };
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2));
  return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const evidence = await runCacheSerializerProbe({ binary: process.argv[2] });
  console.log(JSON.stringify({ output: evidence.output, results: evidence.results, observerChecks: evidence.observerChecks, cleanup: evidence.cleanup }));
  if (evidence.results.some(row => row.attempts !== 2 || row.replies.some(reply => !reply.correct || reply.error)
    || Object.values(row.checks ?? {}).some(check => !check)) || Object.values(evidence.observerChecks).some(check => !check)) process.exitCode = 1;
}
