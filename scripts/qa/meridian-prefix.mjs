// Opt-in real-binary regression with a loopback-only, synthetic Anthropic API.
// This never reads authentication or submits a live model request.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareMeridianFixture, isolatedClaudeEnvironment, fixtureGit, repository, studyModel, studyEffort } from './claude-quota-fixture.mjs';

export function withoutCacheMarkers(value) {
  if (Array.isArray(value)) return value.map(withoutCacheMarkers);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'cache_control').map(([key, item]) => [key, withoutCacheMarkers(item)]));
  return value;
}

const digest = value => createHash('sha256').update(JSON.stringify(withoutCacheMarkers(value)) ?? 'undefined').digest('hex');

export function gradePrefixRequests(requests, expectedResults) {
  const primary = requests.filter(row => row.primary);
  const checks = primary.map(({ step, body }, index) => {
    const previous = primary[index - 1]?.body;
    const previousMessages = previous?.messages ?? [];
    const resultBlocks = body.messages.flatMap(message => Array.isArray(message.content)
      ? message.content.filter(block => block.type === 'tool_result') : []);
    const missingResults = expectedResults.filter(result => result.step < step)
      .filter(result => !resultBlocks.some(block => block.tool_use_id === result.id
        && block.content === result.content && block.is_error !== true)).map(result => result.id);
    return { step, system: digest(body.system), tools: digest(body.tools),
      systemStable: !previous || digest(previous.system) === digest(body.system),
      toolsStable: !previous || digest(previous.tools) === digest(body.tools),
      previousMessagesStable: previousMessages.every((message, i) => digest(message) === digest(body.messages[i])),
      missingResults };
  });
  return {
    passed: checks.length > 2 && requests.every(row => row.primary) && checks.every(check => check.systemStable && check.toolsStable
      && check.previousMessagesStable && check.missingResults.length === 0),
    providerRequests: requests.length, clientRequests: primary.length,
    hiddenRequests: requests.filter(row => !row.primary).length, checks,
  };
}

export async function parseAnthropicResponse(response) {
  if (!response.ok) throw new Error(`Fixture proxy failed: HTTP ${response.status}`);
  if (!response.headers.get('content-type')?.includes('text/event-stream')) return response.json();
  const blocks = new Map();
  let stopReason;
  for (const frame of (await response.text()).split('\n\n')) {
    const text = frame.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
    if (!text) continue;
    const event = JSON.parse(text);
    if (event.type === 'error') throw new Error(`Fixture provider failed: ${event.error?.type ?? 'unknown'}`);
    if (event.type === 'content_block_start') blocks.set(event.index, { ...event.content_block, json: '' });
    if (event.type === 'content_block_delta') {
      const block = blocks.get(event.index);
      if (!block) throw new Error('Fixture stream has a delta without a block');
      if (event.delta.type === 'input_json_delta') block.json += event.delta.partial_json;
      if (event.delta.type === 'text_delta') block.text = (block.text ?? '') + event.delta.text;
      if (event.delta.type === 'thinking_delta') block.thinking = (block.thinking ?? '') + event.delta.thinking;
      if (event.delta.type === 'signature_delta') block.signature = (block.signature ?? '') + event.delta.signature;
    }
    if (event.type === 'message_delta') stopReason = event.delta.stop_reason;
  }
  const content = [...blocks.values()].map(({ json, ...block }) => block.type === 'tool_use'
    ? { ...block, input: json ? JSON.parse(json) : block.input } : block);
  return { type: 'message', content, stop_reason: stopReason };
}

function sendSyntheticResponse(response, body, blocks, id) {
  const reason = blocks.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn';
  const usage = { input_tokens: 20, output_tokens: 4, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const message = { id, type: 'message', role: 'assistant', content: blocks, model: body.model,
    stop_reason: reason, stop_sequence: null, usage };
  if (!body.stream) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(message));
    return;
  }
  const events = [['message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { ...usage, output_tokens: 0 } } }]];
  for (const [index, block] of blocks.entries()) {
    const initial = block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' };
    const delta = block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text };
    events.push(['content_block_start', { type: 'content_block_start', index, content_block: initial }],
      ['content_block_delta', { type: 'content_block_delta', index, delta }],
      ['content_block_stop', { type: 'content_block_stop', index }]);
  }
  events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 4 } }],
    ['message_stop', { type: 'message_stop' }]);
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(''));
}

export async function runMeridianPrefixProbe({ installedModules, claudeExecutable, arm = 'candidate',
  steps = 6, parallelTools = 2, stream = true, suppressScratchpad = true,
  outputRoot = path.join(repository, '.cache/qa/meridian-prefix') } = {}) {
  if (!Number.isSafeInteger(steps) || steps < 3 || steps > 20
    || !Number.isSafeInteger(parallelTools) || parallelTools < 1 || parallelTools > 4) throw new Error('Expected 3–20 handoffs and 1–4 parallel tools');
  const fixture = await prepareMeridianFixture({ outputRoot, arm, installedModules });
  // createProxyServer (unlike startProxyServer) does not initialize the module's
  // executable selection for streaming. Seed that configuration in this owned
  // copy; starting the full server would enable unrelated auth refresh timers.
  const entry = fixture.entry;
  const source = await fs.readFile(entry, 'utf8');
  const bootstrapAnchor = 'var claudeExecutable = "";';
  if (source.split(bootstrapAnchor).length !== 2) throw new Error('Fixture executable bootstrap is incompatible');
  await fs.writeFile(entry, source.replace(bootstrapAnchor, `var claudeExecutable = ${JSON.stringify(claudeExecutable)};`));
  const claudeVersion = execFileSync(claudeExecutable, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim().split(' ')[0];
  fixtureGit(fixture.workspace, ['init', '--quiet']);
  for (let index = 0; index < steps; index++) await fs.writeFile(path.join(fixture.workspace, `fixture-${index}.txt`), 'Initial fixture\n');
  fixtureGit(fixture.workspace, ['add', '.']);
  fixtureGit(fixture.workspace, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Fixture']);
  const previousEnvironment = { ...process.env };
  const environment = isolatedClaudeEnvironment(fixture, claudeExecutable);
  if (!suppressScratchpad) environment.MERIDIAN_SUPPRESS_SCRATCHPAD = '0';
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, environment);
  const requests = [];
  const expectedResults = [];
  const replies = [];
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error('Offline prefix probe interrupted'));
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  let step = 0;
  let withinStep = 0;
  let proxy;
  const gateway = createServer(async (request, response) => {
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) throw new Error('Synthetic request exceeds bound');
        chunks.push(chunk);
      }
      if (!request.url.startsWith('/v1/messages')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}'); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const tool = (body.tools ?? []).find(entry => /read$/.test(entry.name));
      const statusClassifier = !tool && String(body.model).includes('haiku')
        && JSON.stringify(body.messages).includes('Current state:');
      const primary = !statusClassifier && withinStep++ === 0;
      requests.push({ step, primary, kind: statusClassifier ? 'native-status-classifier' : 'main', body });
      if (statusClassifier) {
        sendSyntheticResponse(response, body, [{ type: 'text', text: JSON.stringify({ state: 'working', tempo: 'steady', detail: 'Reading fixture files', needs: null }) }], `msg_status_${requests.length}`);
        return;
      }
      if (!tool) throw new Error('Claude did not register the fixture read tool');
      const blocks = primary && step < steps ? Array.from({ length: parallelTools }, (_, index) => ({
        type: 'tool_use', id: `toolu_fixture_${requests.length}_${index}`, name: tool.name,
        input: { file: `fixture-${step}.txt`, part: index },
      })) : [{ type: 'text', text: 'Fixture complete.' }];
      sendSyntheticResponse(response, body, blocks, `msg_fixture_${requests.length}`);
    } catch {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ type: 'error', error: { type: 'fixture_error', message: 'Synthetic gateway failed' } }));
    }
  });
  try {
    await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
    const { createProxyServer } = await import(pathToFileURL(path.join(fixture.packageRoot, 'dist/server.js')).href);
    proxy = createProxyServer({ silent: true, maxConcurrent: 1,
      profiles: [{ id: 'offline', type: 'api', apiKey: 'fixture-only-not-a-credential', baseUrl: `http://127.0.0.1:${gateway.address().port}` }],
      defaultProfile: 'offline', pluginDir: path.join(fixture.root, 'plugins'), pluginConfigPath: path.join(fixture.root, 'plugins.json') });
    const messages = [{ role: 'user', content: 'Read each fixture, preserve the results, then review them. This is an offline deterministic fixture.' }];
    const tools = [{ name: 'read', description: 'Read one part of a fixture.', input_schema: {
      type: 'object', properties: { file: { type: 'string' }, part: { type: 'integer' } }, required: ['file', 'part'],
    } }];
    // The last two requests finish the tool loop and exercise an ordinary warm
    // user continuation with no pending tool checkpoint.
    for (step = 0; step < steps + 2; step++) {
      controller.signal.throwIfAborted();
      withinStep = 0;
      if (step < steps) await fs.writeFile(path.join(fixture.workspace, `fixture-${step}.txt`), `Changed fixture ${step}\n`);
      const response = await proxy.app.fetch(new Request('http://127.0.0.1/v1/messages', {
        method: 'POST', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]),
        headers: { 'content-type': 'application/json', 'x-opencode-session': 'offline-prefix-probe',
          'x-opencode-agent-mode': 'subagent', 'x-opencode-agent-name': 'designer', 'x-opencode-effort': studyEffort },
        body: JSON.stringify({ model: studyModel, stream, max_tokens: 1024, system: 'Fixture system prompt.', messages, tools }),
      }));
      const reply = await parseAnthropicResponse(response);
      // The client SSE closes before the SDK drain. Keep the synthetic response
      // script on this turn until its lease ends, so a late hidden request cannot
      // accidentally consume the next turn's programmed response.
      const drainDeadline = Date.now() + 15_000;
      while (proxy.getInFlightCount() > 0) {
        controller.signal.throwIfAborted();
        if (Date.now() >= drainDeadline) throw new Error('Fixture SDK drain did not finish');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      replies.push({ step, status: response.status, stopReason: reply.stop_reason });
      messages.push({ role: 'assistant', content: reply.content });
      const calls = reply.content.filter(block => block.type === 'tool_use');
      if (step < steps && calls.length !== parallelTools) throw new Error('Parallel client tool envelope is incomplete');
      const results = calls.map(call => {
        const content = `Fixture result ${step}/${call.input.part}: preserve this value.`;
        expectedResults.push({ step, id: call.id, content });
        return { type: 'tool_result', tool_use_id: call.id, content };
      });
      messages.push({ role: 'user', content: results.length ? results : 'Review the preserved fixture results without using tools.' });
    }
    const grade = gradePrefixRequests(requests, expectedResults);
    const telemetry = await (await proxy.app.fetch(new Request('http://127.0.0.1/telemetry/requests?limit=100'))).json();
    const logs = await (await proxy.app.fetch(new Request('http://127.0.0.1/telemetry/logs?limit=200'))).json();
    const observedVersions = [...new Set(requests.flatMap(row => (row.body.system ?? [])
      .map(block => /cc_version=([0-9]+\.[0-9]+\.[0-9]+)/.exec(block.text ?? '')?.[1]).filter(Boolean)))];
    if (observedVersions.length !== 1 || observedVersions[0] !== claudeVersion) throw new Error('Observed Claude executable differs from the requested version');
    const result = { arm, kind: 'offline-synthetic-api-real-claude-executable', claudeExecutable, claudeVersion, observedVersions,
      model: studyModel, effort: studyEffort, stream, suppressScratchpad, parallelTools, steps,
      sourceSha256: fixture.sourceSha256, root: fixture.root, ...grade, replies,
      sdkSessions: new Set(telemetry.map(row => row.sdkSessionId).filter(Boolean)).size };
    await fs.writeFile(path.join(fixture.root, 'synthetic-requests.json'), JSON.stringify(requests, null, 2));
    await fs.writeFile(path.join(fixture.root, 'result.json'), JSON.stringify(result, null, 2));
    await fs.writeFile(path.join(fixture.root, 'telemetry.json'), JSON.stringify({ telemetry, logs }, null, 2));
    return result;
  } catch (error) {
    await fs.writeFile(path.join(fixture.root, 'synthetic-requests.json'), JSON.stringify(requests, null, 2));
    const telemetry = proxy ? await (await proxy.app.fetch(new Request('http://127.0.0.1/telemetry/requests?limit=100'))).json().catch(() => []) : [];
    const logs = proxy ? await (await proxy.app.fetch(new Request('http://127.0.0.1/telemetry/logs?limit=200'))).json().catch(() => []) : [];
    await fs.writeFile(path.join(fixture.root, 'telemetry.json'), JSON.stringify({ telemetry, logs }, null, 2));
    await fs.writeFile(path.join(fixture.root, 'failure.json'), JSON.stringify({ arm, step, replies, expectedResults,
      error: error instanceof Error ? error.message : 'Fixture failed' }, null, 2));
    console.log(JSON.stringify({ arm, root: fixture.root, failedStep: step }));
    throw error;
  } finally {
    controller.abort(new Error('Offline prefix probe closing'));
    proxy?.beginDrain();
    const deadline = Date.now() + 15_000;
    while (proxy?.getInFlightCount() > 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    gateway.closeAllConnections();
    if (gateway.listening) await new Promise(resolve => gateway.close(resolve));
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, previousEnvironment);
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    if (proxy?.getInFlightCount() > 0) throw new Error('Offline fixture SDK cleanup did not settle');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const values = {};
  const allowed = new Set(['--modules', '--claude', '--arm', '--steps', '--parallel', '--stream', '--output', '--scratchpad']);
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.has(args[i]) || !args[i + 1]) throw new Error('Expected --modules PATH --claude EXECUTABLE [--arm control|candidate] [--steps N] [--parallel N] [--stream true|false] [--output DIR]');
    values[args[i]] = args[i + 1];
  }
  if (values['--stream'] && !['true', 'false'].includes(values['--stream'])) throw new Error('Stream must be true or false');
  if (values['--scratchpad'] && !['true', 'false'].includes(values['--scratchpad'])) throw new Error('Scratchpad must be true or false');
  const result = await runMeridianPrefixProbe({ installedModules: values['--modules'], claudeExecutable: values['--claude'],
    arm: values['--arm'], steps: Number(values['--steps'] ?? 6), parallelTools: Number(values['--parallel'] ?? 2),
    stream: values['--stream'] !== 'false', suppressScratchpad: values['--scratchpad'] !== 'false', outputRoot: values['--output'] });
  console.log(JSON.stringify({ ...result, checks: result.checks.map(({ missingResults, ...row }) => ({ ...row, missingResults: missingResults.length })) }));
  if (!result.passed) process.exitCode = 1;
}
