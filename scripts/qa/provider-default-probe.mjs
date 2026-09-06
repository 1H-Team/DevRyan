import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { reservePort, startOwnedProcess } from './process.mjs';

// Contract probe: actual OpenCode request resolution, with a local model endpoint.
// This deliberately excludes provider plugins and is not live-provider acceptance.
export async function probeProviderDefault({ binary, outputRoot }) {
  const temporary = await mkdtemp(path.join(outputRoot, 'variant-'));
  const workspace = path.join(temporary, 'workspace');
  await mkdir(workspace);
  execFileSync('git', ['init', '--quiet', workspace]);
  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    requests.push({ reasoning: body.reasoning, reasoning_effort: body.reasoning_effort });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ id: 'chatcmpl-qa', object: 'chat.completion.chunk', created: 1, model: 'qa-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const port = await reservePort();
  const config = {
    provider: { qa: { npm: '@ai-sdk/openai-compatible', name: 'QA', options: { baseURL: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: 'synthetic-qa' },
      models: { 'qa-model': { name: 'QA model', reasoning: true, limit: { context: 32000, output: 2000 }, variants: { medium: { reasoningEffort: 'medium' }, high: { reasoningEffort: 'high' } } } } } },
    model: 'qa/qa-model', agent: { build: { model: 'qa/qa-model', variant: 'medium' }, title: { disable: true } },
  };
  const configPath = path.join(temporary, 'opencode.json');
  await writeFile(configPath, JSON.stringify(config));
  const child = startOwnedProcess(binary, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: workspace,
    env: { ...process.env, XDG_CONFIG_HOME: path.join(temporary, 'config'), XDG_DATA_HOME: path.join(temporary, 'data'), XDG_CACHE_HOME: path.join(temporary, 'cache'),
      XDG_STATE_HOME: path.join(temporary, 'state'), OPENCODE_CONFIG: configPath, OPENCODE_CONFIG_DIR: path.join(temporary, 'overlay'), OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true' } });
  const origin = `http://127.0.0.1:${port}`;
  const request = async (route, body) => {
    const response = await fetch(origin + route, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-opencode-directory': workspace },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`OpenCode ${route}: HTTP ${response.status}`);
    return response.json();
  };
  const results = [];
  try {
    const deadline = Date.now() + 60000;
    while (true) {
      child.check();
      try { await request('/global/health'); break; } catch (error) { if (Date.now() > deadline) throw error; }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    for (const variant of [undefined, '', 'high']) {
      const session = await request('/session', { title: 'Variant contract probe' });
      const before = requests.length;
      const reply = await request(`/session/${session.id}/message`, { model: { providerID: 'qa', modelID: 'qa-model' }, agent: 'build', ...(variant !== undefined ? { variant } : {}), parts: [{ type: 'text', text: 'Reply done.' }] });
      results.push({ requested: variant ?? '(omitted)', persistedVariant: reply.info?.variant, error: reply.info?.error?.name, requests: requests.slice(before) });
    }
    const evidence = { version: execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim(), results };
    await writeFile(path.join(outputRoot, 'provider-default-probe.json'), JSON.stringify(evidence, null, 2));
    return evidence;
  } finally {
    await child.stop();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputRoot = path.resolve('.cache/qa/native-default-probe');
  await mkdir(outputRoot, { recursive: true });
  console.log(JSON.stringify(await probeProviderDefault({ binary: process.env.DEVRYAN_QA_OPENCODE_BINARY || 'opencode', outputRoot })));
}
