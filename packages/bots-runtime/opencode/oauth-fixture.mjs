// Runs only inside the disposable, network-disabled acceptance container.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createOpenAiOAuthCoordinator } from '/src/opencode/openai-oauth-coordinator.js';
import { createOpenAiOAuthBridge } from '/src/opencode/openai-oauth-bridge.js';
import { createBotGatewayHost } from '/src/bots/gateway-host.js';
import { createBotNativeClient } from '/fixture-repository/packages/web/server/lib/bots/native-client.js';
import {
  createGatewayOriginRegistry,
  createGatewayRelayAgent,
  isGatewayRelayPath,
  relayGatewayRequest,
  sendGatewayRelayFailure,
} from '/src/egress/gateway-relay.js';

assert.equal(JSON.parse(await fs.readFile('/opt/devryan/node_modules/@opencode/core/package.json', 'utf8')).version, '2.0.26');
assert.equal(JSON.parse(await fs.readFile('/opt/devryan/node_modules/opencode-gpt-imagegen/package.json', 'utf8')).version, '0.1.12');

let rotation = 0;
let auth = { type: 'oauth', methodID: 'chatgpt-siwc', clientId: 'fixture-registered-client', accountId: 'fixture-account',
  scopes: ['chatgpt.tokens.use.direct'], metadata: { subject: 'fixture-account' },
  access: 'fixture-access-0', refresh: 'fixture-refresh-0', expires: 0 };
const providerCalls = [];
const diagnostics = [];
const children = [];
const clients = [];
let childLogs = '';
let refusedWebsocketUpgrades = 0, attachmentObserved = false, blockedStarted, blockedClosed;
const blocked = new Promise(resolve => { blockedStarted = resolve; });
const closed = new Promise(resolve => { blockedClosed = resolve; });
const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAD0lEQVR4nGP4TwAwjAwFAIS1/wF0QtmAAAAAAElFTkSuQmCC', 'base64');
const server = https.createServer({ key: await fs.readFile('/fixture-tls/key.pem'), cert: await fs.readFile('/fixture-tls/cert.pem') }, async (req, res) => {
  try {
    // This offline provider owns HTTP only; exercise native's HTTP fallback explicitly.
    if (req.method === 'GET' && req.headers.upgrade?.toLowerCase() === 'websocket') {
      refusedWebsocketUpgrades++;
      res.writeHead(426).end();
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (req.url === '/api/accounts/oauth/token') {
      assert.equal(new URLSearchParams(raw).get('client_id'), 'fixture-registered-client');
      assert.equal(new URLSearchParams(raw).get('resource'), 'https://api.openai.com/v1');
      assert.equal(new URLSearchParams(raw).get('refresh_token'), `fixture-refresh-${rotation}`);
      rotation++;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ access_token: `fixture-access-${rotation}`, refresh_token: `fixture-refresh-${rotation}`, expires_in: 3600 }));
      return;
    }
    assert.equal(req.url, '/v1/responses');
    assert.equal(req.headers.authorization, `Bearer fixture-access-${rotation}`);
    assert.equal(req.headers['chatgpt-account-id'], undefined);
    const body = JSON.parse(raw);
    if (JSON.stringify(body.input).includes('Attachment fixture')) {
      assert.ok(body.input.some(item => item.content?.some(part => part.type === 'input_image' && part.image_url?.startsWith('data:image/png;base64,'))));
      attachmentObserved = true;
    }
    providerCalls.push({ model: body.model, reasoning: body.reasoning, rotation, image: body.tool_choice?.type === 'image_generation' });
    res.setHeader('content-type', 'text/event-stream');
    const event = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`);
    if (JSON.stringify(body.input).includes('Block structured fixture')) {
      res.on('close', () => blockedClosed());
      res.write(': waiting\n\n');
      blockedStarted();
      return;
    }
    {
      const text = JSON.stringify(body.input).includes('JSON fixture') ? '{"answer":"fixture"}' : 'Fixture reply';
      const blockImage = JSON.stringify(body.input).includes('Generate blocked image');
      const imageCall = (blockImage || JSON.stringify(body.input).includes('Generate fixture image')) && !body.input.some(item => item.type === 'function_call_output');
      const localTools = body.input.filter(item => item.type === 'additional_tools').flatMap(item => item.tools);
      const structuredCall = localTools.some(tool => tool.name === 'generate_object');
      if (structuredCall) assert.deepEqual(localTools.map(tool => tool.name), ['generate_object']);
      const item = imageCall || structuredCall
        ? { id: 'fc_fixture', type: 'function_call', call_id: 'call_fixture', name: imageCall ? 'devryan_image' : 'generate_object', status: 'completed',
          arguments: JSON.stringify(imageCall ? { prompt: blockImage ? 'Block image fixture' : 'A fixture pixel', out: blockImage ? '/workspace/cancelled.png' : '/workspace/pixel.png', quality: 'low' }
            : JSON.stringify(body.input).includes('Invalid structured fixture') ? {} : { answer: 'fixture' }) }
        : { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
      const response = { id: 'resp_fixture', object: 'response', created_at: Math.floor(Date.now() / 1000), model: body.model, status: 'in_progress', output: [] };
      event({ type: 'response.created', response });
      event({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
      if (imageCall || structuredCall) {
        event({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments });
        event({ type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: item.arguments });
      } else {
        event({ type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
        event({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text });
        event({ type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text });
      }
      event({ type: 'response.output_item.done', output_index: 0, item });
      event({ type: 'response.completed', response: { ...response, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 } } } });
    }
    res.end();
  } catch (error) {
    console.error('Fixture rejected provider request:', error.message);
    res.writeHead(500).end('fixture request mismatch');
  }
});
await new Promise((resolve) => server.listen(443, '127.0.0.1', resolve));
const coordinator = createOpenAiOAuthCoordinator({ readAuth: () => auth,
  compareAndSwap: (expected, next) => { if (auth !== expected) return false; auth = next; return true; },
  recordDiagnostic: (entry) => diagnostics.push(entry) });
// The native host owns readiness; this fixture exercises its coordinator directly.
coordinator.markReady();
const bridge = createOpenAiOAuthBridge({ coordinator: { ...coordinator, markReady() {
  console.log('Managed OAuth plugin handshake');
  coordinator.markReady();
} } });
const claimsByRun = new Map();
const gateway = createBotGatewayHost({ handleOperation: async () => { throw new Error('No fixture tools expected'); },
  handleOAuth: async (claims, operation) => {
    assert.equal(claimsByRun.get(claims.runId), claims.botId);
    return operation === 'ready' ? { protocol: 1, oauth: true } : coordinator.access({ expectedAccountId: 'fixture-account' });
  } });
await gateway.start();
// A Bot container has no route to the host, so its gateway calls go through the
// egress relay. The acceptance run exercises the real relay: `egress` and
// `host.docker.internal` both resolve to loopback inside this container.
const gatewayOriginRegistry = createGatewayOriginRegistry({
  initialOrigin: gateway.getAddress().dockerGatewayUrl,
});
const relayAgent = createGatewayRelayAgent();
const relay = http.createServer(async (request, response) => {
  if (!isGatewayRelayPath(request.url)) {
    response.writeHead(404).end();
    return;
  }
  try {
    await relayGatewayRequest({
      request,
      response,
      originRegistry: gatewayOriginRegistry,
      agent: relayAgent,
    });
  } catch (error) {
    sendGatewayRelayFailure(response, error);
  }
});
await new Promise((resolve) => relay.listen(43121, '127.0.0.1', resolve));

async function launch(name, port, environment) {
  console.log(`Starting isolated ${name}`);
  const base = `/tmp/${name}`;
  await fs.mkdir(`${base}/data/opencode`, { recursive: true });
  await fs.mkdir(`${base}/home`, { recursive: true });
  await fs.mkdir(`${base}/config`, { recursive: true });
  await fs.writeFile(`${base}/data/opencode/auth.json`, JSON.stringify({ openai: { type: 'oauth', accountId: 'fixture-account', access: '', refresh: '', expires: 0 } }));
  const config = { plugins: [], default_agent: 'bot', snapshots: false, warming: false, update: 'disable', share: 'disabled',
    permissions: [{ action: '*', resource: '*', effect: 'deny' }],
    agents: { bot: { mode: 'primary', model: { providerID: 'openai', model: 'gpt-6-astra' },
      permissions: [{ action: '*', resource: '*', effect: 'deny' }, { action: 'devryan_image', resource: '*', effect: 'allow' }] }, title: { disabled: true } } };
  await fs.writeFile(`${base}/config/opencode.json`, JSON.stringify(config));
  const source = `import {createBotNativeServer} from '/opt/devryan/packages/web/server/lib/bots/native-server.mjs';
    const runtime=await createBotNativeServer({configDirectory:${JSON.stringify(`${base}/config`)},
      databasePath:${JSON.stringify(`${base}/data/opencode/native.db`)},authPath:${JSON.stringify(`${base}/data/opencode/auth.json`)}});
    const server=Bun.serve({hostname:'127.0.0.1',port:${port},fetch:runtime.fetch});
    process.once('SIGTERM',()=>{void runtime.close().then(()=>server.stop(true)).then(()=>process.exit(0));});`;
  const child = spawn('/usr/local/bin/bun', ['--eval', source], {
    cwd: '/workspace', env: { ...process.env, ...environment, HOME: `${base}/home`, XDG_DATA_HOME: `${base}/data`,
      XDG_CONFIG_HOME: `${base}/config`, XDG_CACHE_HOME: `${base}/cache` }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  child.stdout.on('data', (chunk) => { childLogs = (childLogs + chunk).slice(-16000); });
  child.stderr.on('data', (chunk) => { childLogs = (childLogs + chunk).slice(-16000); });
  const url = `http://127.0.0.1:${port}`;
  const headers = { authorization: `Bearer ${environment.DEVRYAN_BOT_RUNTIME_TOKEN}`, 'content-type': 'application/json' };
  let healthy = false;
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null || child.signalCode) throw new Error(`Fixture OpenCode exited (${child.signalCode || child.exitCode}): ${childLogs}`);
    try {
      const response = await fetch(`${url}/devryan/ready`, { headers, signal: AbortSignal.timeout(500) });
      const ready = await response.json();
      if (response.ok && ready.ready && ready.generation === 2 && ready.opencode.version === '2.0.26') { healthy = true; break; }
    } catch { /* bounded startup wait */ }
    await delay(100);
  }
  if (!healthy) throw new Error('Fixture OpenCode health deadline exceeded');
  const client = createBotNativeClient({ baseUrl: url, token: environment.DEVRYAN_BOT_RUNTIME_TOKEN, runId: environment.DEVRYAN_BOT_RUN_ID });
  clients.push(client);
  const events = [];
  const subscription = client.subscribeEvents({ onEvent: event => events.push(event) });
  const providers = await client.provider.list();
  assert.equal(providers.error, undefined);
  return { url, headers, child, client, events, subscription };
}
async function chat({client}, prompt, files) {
  const created = await client.session.create({ title: 'OAuth fixture' });
  assert.equal(created.error, undefined);
  const session = created.data;
  const response = await client.session.promptAsync({ sessionID: session.id, agent: 'bot', model: { providerID: 'openai', modelID: 'gpt-6-astra' },
    parts: [{ type: 'text', text: prompt }, ...(files ?? []).map(file => ({ type: 'file', url: file.uri, filename: file.name, mime: 'image/png' }))] });
  assert.equal(response.error, undefined);
  assert.equal(response.data, true);
  let output;
  const contains = (value, text) => typeof value === 'string' ? value.includes(text)
    : value !== null && typeof value === 'object' && Object.values(value).some(child => contains(child, text));
  for (let i=0;i<250;i++) {
    output = await client.session.messages({ sessionID: session.id });
    assert.equal(output.error, undefined);
    if (contains(output, prompt === 'JSON fixture' ? '{"answer":"fixture"}' : 'Fixture reply')) return session.id;
    await delay(100);
  }
  assert.fail('Native Bot fixture response deadline exceeded');
}
try {
  const environments = [1, 2].map((n) => {
    const runId = `a0000000-0000-4000-8000-00000000000${n}`;
    const botId = `b0000000-0000-4000-8000-00000000000${n}`;
    const channelId = `c0000000-0000-4000-8000-00000000000${n}`;
    const revisionId = `d0000000-0000-4000-8000-00000000000${n}`;
    claimsByRun.set(runId, botId);
    const capability = gateway.issueCapability({ runId, botId, channelId, revisionId, scopeKey: `channel:${channelId}`, kind: 'reasoning', operations: ['memory.search'] });
    return { DEVRYAN_BOT_GATEWAY_URL: 'http://egress:43121', DEVRYAN_BOT_RUNTIME_TOKEN: capability.token,
      DEVRYAN_BOT_RUN_ID: runId, DEVRYAN_BOT_CHANNEL_ID: channelId, DEVRYAN_BOT_REVISION_ID: revisionId, DEVRYAN_BOT_CHATGPT_IMAGE_GENERATION: '1' };
  });
  const bots = await Promise.all(environments.map((env, i) => launch(`bot${i}`, 4098 + i, env)));
  await Promise.all([coordinator.access({expectedAccountId:'fixture-account'}), ...bots.map((runtime) => chat(runtime, 'Hello'))]);
  assert.equal(rotation, 1);
  auth = { ...auth, expires: 0 };
  await Promise.all([coordinator.access({expectedAccountId:'fixture-account'}), ...bots.map((runtime) => chat(runtime, 'JSON fixture'))]);
  assert.equal(rotation, 2);
  auth = { ...auth, expires: 0 };
  await chat(bots[0], 'Generate fixture image');
  assert.equal(rotation, 3);
  // SIWC plan usage does not support image generation. The native tool must
  // refuse before provider dispatch or filesystem publication. API-key image
  // generation is qualified by the compiled reviewed-package image lane.
  assert.equal(await fs.stat('/workspace/pixel.png').catch(() => null), null);
  assert.equal(providerCalls.some(call => call.image), false);
  const attachmentSession = await chat(bots[0], 'Attachment fixture', [{ uri: `data:image/png;base64,${imageBytes.toString('base64')}`, name: 'pixel.png' }]);
  assert.equal(attachmentObserved, true);
  const { url, headers } = bots[0];
  const before = (await (await fetch(`${url}/api/session`, { headers })).json()).data.length;
  const structuredInput = { model: { providerID: 'openai', id: 'gpt-6-astra' }, prompt: 'Structured fixture', system: 'Only fixture JSON',
    schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false } };
  const structured = prompt => fetch(`${url}/devryan/bot/structured`, { method: 'POST', headers,
    body: JSON.stringify({ ...structuredInput, prompt }), signal: AbortSignal.timeout(25000) });
  const generated = await structured('Structured fixture');
  assert.equal(generated.status, 200, await generated.clone().text());
  assert.deepEqual(await generated.json(), { output: { answer: 'fixture' } });
  assert.equal((await structured('Invalid structured fixture')).status, 502);
  const abort = new AbortController();
  const cancelled = fetch(`${url}/devryan/bot/structured`, { method: 'POST', headers,
    body: JSON.stringify({ ...structuredInput, prompt: 'Block structured fixture' }), signal: abort.signal }).catch(error => error);
  await blocked; abort.abort();
  assert.equal((await cancelled).name, 'AbortError');
  await Promise.race([closed, delay(5000).then(() => { throw new Error('Native structured provider cancellation did not settle'); })]);
  assert.equal((await (await fetch(`${url}/api/session`, { headers })).json()).data.length, before);
  const exited = new Promise(resolve => bots[0].child.once('exit', resolve));
  assert.ok(bots[0].events.some(event => event.type === 'message.updated'));
  bots[0].client.close();
  await bots[0].subscription;
  bots[0].child.kill('SIGTERM');
  assert.equal(await exited, 0);
  // The supervisor allocates a new published endpoint when replacing a container.
  bots[0] = await launch('bot0', 4100, environments[0]);
  const restored = await fetch(`${bots[0].url}/api/session/${attachmentSession}/message`, { headers });
  assert.equal(restored.status, 200);
  assert.ok((await restored.text()).includes('Fixture reply'));
  await chat(bots[0], 'Hello after restart');
  assert.equal(JSON.parse(await fs.readFile('/tmp/bot0/data/opencode/auth.json', 'utf8')).openai.refresh, '');
  assert.equal(providerCalls.some((call) => call.image), false);
  assert.ok(providerCalls.filter((call) => !call.image).every((call) => call.model === 'gpt-6-astra'));
  assert.ok(!JSON.stringify(diagnostics).match(/fixture-access|fixture-refresh|fixture-account/));
  console.log(JSON.stringify({ passed: true, runtime: 'OpenCode 2.0.26', chatRequests: providerCalls.filter((c) => !c.image).length,
    imageRequests: providerCalls.filter((c) => c.image).length, coordinatedRefreshes: rotation, attachmentObserved,
    structured: true, cancellationSettled: true, siwcImageRefused: true, restart: true,
    hostClientAndEvents: true, refusedWebsocketUpgrades, transport: 'HTTP', internet: 'disabled' }));
} catch (error) {
  console.error(childLogs);
  for (const name of ['bot0', 'bot1']) {
    try { console.error((await fs.readFile(`/tmp/${name}/data/opencode/log/opencode.log`, 'utf8')).slice(-10000)); } catch { /* absent fixture */ }
  }
  throw error;
} finally {
  for (const client of clients) client.close();
  for (const child of children) child.kill('SIGKILL');
  relayAgent.destroy();
  relay.closeAllConnections();
  await new Promise((resolve) => relay.close(resolve));
  await gateway.shutdown();
  await bridge.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
