// Runs only inside the disposable, network-disabled acceptance container.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createOpenAiOAuthCoordinator } from '/src/opencode/openai-oauth-coordinator.js';
import { createOpenAiOAuthBridge } from '/src/opencode/openai-oauth-bridge.js';
import { createBotGatewayHost } from '/src/bots/gateway-host.js';
import botPlugin from './devryan-bot-tools.mjs';

assert.equal(JSON.parse(await fs.readFile('/opt/devryan/node_modules/opencode-ai/package.json', 'utf8')).version, '1.18.25');
assert.equal(JSON.parse(await fs.readFile('/opt/devryan/node_modules/opencode-gpt-imagegen/package.json', 'utf8')).version, '0.1.10');

let rotation = 0;
let auth = { type: 'oauth', accountId: 'fixture-account', access: 'fixture-access-0', refresh: 'fixture-refresh-0', expires: 0 };
const providerCalls = [];
const diagnostics = [];
const children = [];
let childLogs = '';
const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPz8AAAAASUVORK5CYII=', 'base64');
const server = https.createServer({ key: await fs.readFile('/fixture-tls/key.pem'), cert: await fs.readFile('/fixture-tls/cert.pem') }, async (req, res) => {
  try {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (req.url === '/oauth/token') {
      assert.equal(new URLSearchParams(raw).get('refresh_token'), `fixture-refresh-${rotation}`);
      rotation++;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ access_token: `fixture-access-${rotation}`, refresh_token: `fixture-refresh-${rotation}`, expires_in: 3600 }));
      return;
    }
    assert.equal(req.url, '/backend-api/codex/responses');
    assert.equal(req.headers.authorization, `Bearer fixture-access-${rotation}`);
    assert.equal(req.headers['chatgpt-account-id'], 'fixture-account');
    const body = JSON.parse(raw);
    providerCalls.push({ model: body.model, rotation, image: body.tool_choice?.type === 'image_generation' });
    res.setHeader('content-type', 'text/event-stream');
    const event = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`);
    if (body.tool_choice?.type === 'image_generation') {
      event({ type: 'response.output_item.done', item: { type: 'image_generation_call', result: imageBytes.toString('base64') } });
    } else {
      const text = JSON.stringify(body.input).includes('JSON fixture') ? '{"answer":"fixture"}' : 'Fixture reply';
      const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
      const response = { id: 'resp_fixture', object: 'response', created_at: Math.floor(Date.now() / 1000), model: body.model, status: 'in_progress', output: [] };
      event({ type: 'response.created', response });
      event({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
      event({ type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      event({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text });
      event({ type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text });
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

async function launch(name, port, environment, plugin) {
  console.log(`Starting isolated ${name}`);
  const base = `/tmp/${name}`;
  await fs.mkdir(`${base}/data/opencode`, { recursive: true });
  await fs.mkdir(`${base}/home`, { recursive: true });
  await fs.mkdir(`${base}/config/opencode`, { recursive: true });
  await fs.symlink('/opt/devryan/node_modules', `${base}/config/opencode/node_modules`);
  await fs.writeFile(`${base}/config/opencode/package.json`, JSON.stringify({ dependencies: { '@opencode-ai/plugin': '1.18.25' } }));
  await fs.copyFile('/opt/devryan/package-lock.json', `${base}/config/opencode/package-lock.json`);
  await fs.writeFile(`${base}/data/opencode/auth.json`, JSON.stringify({ openai: { type: 'oauth', accountId: 'fixture-account', access: '', refresh: '', expires: 0 } }));
  const config = { plugin: [plugin], model: 'openai/gpt-5.4', default_agent: 'fixture',
    agent: { fixture: { mode: 'primary', permission: { '*': 'deny' } }, title: { disable: true } },
    provider: { openai: { models: { 'gpt-5.4': { name: 'Fixture', limit: { context: 128000, output: 4096 } } } } } };
  await fs.writeFile(`${base}/config.json`, JSON.stringify(config));
  const child = spawn('/opt/devryan/node_modules/.bin/opencode', ['serve', '--hostname', '127.0.0.1', '--port', String(port), '--print-logs', '--log-level', 'DEBUG'], {
    cwd: '/workspace', env: { ...process.env, ...environment, HOME: `${base}/home`, XDG_DATA_HOME: `${base}/data`,
      XDG_CONFIG_HOME: `${base}/config`, XDG_CACHE_HOME: `${base}/cache`, OPENCODE_CONFIG: `${base}/config.json`,
      OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  child.stdout.on('data', (chunk) => { childLogs = (childLogs + chunk).slice(-16000); });
  child.stderr.on('data', (chunk) => { childLogs = (childLogs + chunk).slice(-16000); });
  const url = `http://127.0.0.1:${port}`;
  let healthy = false;
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null || child.signalCode) throw new Error(`Fixture OpenCode exited (${child.signalCode || child.exitCode}): ${childLogs}`);
    try {
      if ((await fetch(`${url}/global/health`, { signal: AbortSignal.timeout(500) })).ok) { healthy = true; break; }
    } catch { /* bounded startup wait */ }
    await delay(100);
  }
  if (!healthy) throw new Error('Fixture OpenCode health deadline exceeded');
  const providers = await fetch(`${url}/provider`, { signal: AbortSignal.timeout(60000) });
  assert.equal(providers.status, 200, await providers.text());
  return url;
}
async function chat(url, prompt) {
  const session = await (await fetch(`${url}/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
  const response = await fetch(`${url}/session/${session.id}/message`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: { providerID: 'openai', modelID: 'gpt-5.4' }, agent: 'fixture', parts: [{ type: 'text', text: prompt }], tools: {} }),
    signal: AbortSignal.timeout(25000) });
  const output = await response.json();
  assert.equal(response.status, 200);
  assert.equal(output.info?.error, undefined, JSON.stringify(output.info?.error));
  assert.ok(output.parts?.some((part) => part.type === 'text' && part.text.includes(prompt === 'JSON fixture' ? '{"answer":"fixture"}' : 'Fixture reply')), JSON.stringify(output));
}
try {
  const host = await launch('host', 4097, await bridge.environment(), 'file:///opt/devryan/devryan-openai-oauth.mjs');
  assert.equal(coordinator.getAuthState(), 'unknown');
  const environments = [1, 2].map((n) => {
    const runId = `a0000000-0000-4000-8000-00000000000${n}`;
    const botId = `b0000000-0000-4000-8000-00000000000${n}`;
    const channelId = `c0000000-0000-4000-8000-00000000000${n}`;
    const revisionId = `d0000000-0000-4000-8000-00000000000${n}`;
    claimsByRun.set(runId, botId);
    const capability = gateway.issueCapability({ runId, botId, channelId, revisionId, scopeKey: `channel:${channelId}`, kind: 'reasoning', operations: ['memory.search'] });
    return { DEVRYAN_BOT_GATEWAY_URL: capability.dockerGatewayUrl, DEVRYAN_BOT_RUNTIME_TOKEN: capability.token,
      DEVRYAN_BOT_RUN_ID: runId, DEVRYAN_BOT_CHANNEL_ID: channelId, DEVRYAN_BOT_REVISION_ID: revisionId, DEVRYAN_BOT_CHATGPT_IMAGE_GENERATION: '1' };
  });
  const bots = await Promise.all(environments.map((env, i) => launch(`bot${i}`, 4098 + i, env, 'file:///opt/devryan/devryan-bot-tools.mjs')));
  await Promise.all([chat(host, 'Hello'), ...bots.map((url) => chat(url, 'Hello'))]);
  assert.equal(rotation, 1);
  auth = { ...auth, expires: 0 };
  await Promise.all([chat(host, 'Hello'), ...bots.map((url) => chat(url, 'JSON fixture'))]);
  assert.equal(rotation, 2);
  Object.assign(process.env, environments[0], { XDG_DATA_HOME: '/data' });
  await fs.mkdir('/data/opencode', { recursive: true });
  await fs.writeFile('/data/opencode/auth.json', '{}', { mode: 0o600 });
  const tools = await botPlugin({});
  auth = { ...auth, expires: 0 };
  await tools.tool.devryan_image.execute({ prompt: 'A fixture pixel', out: '/workspace/pixel.png', quality: 'low' }, { directory: '/workspace' });
  assert.equal(rotation, 3);
  assert.deepEqual(await fs.readFile('/workspace/pixel.png'), imageBytes);
  assert.equal(JSON.parse(await fs.readFile('/data/opencode/auth.json', 'utf8')).openai.refresh, '');
  assert.ok(providerCalls.some((call) => call.image));
  assert.ok(providerCalls.filter((call) => !call.image).every((call) => call.model === 'gpt-5.4'));
  assert.ok(!JSON.stringify(diagnostics).match(/fixture-access|fixture-refresh|fixture-account/));
  console.log(JSON.stringify({ passed: true, runtime: 'OpenCode 1.18.25', chatRequests: providerCalls.filter((c) => !c.image).length,
    imageRequests: providerCalls.filter((c) => c.image).length, coordinatedRefreshes: rotation, internet: 'disabled' }));
} catch (error) {
  console.error(childLogs);
  for (const name of ['host', 'bot0', 'bot1']) {
    try { console.error((await fs.readFile(`/tmp/${name}/data/opencode/log/opencode.log`, 'utf8')).slice(-10000)); } catch { /* absent fixture */ }
  }
  throw error;
} finally {
  for (const child of children) child.kill('SIGKILL');
  await gateway.shutdown();
  await bridge.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
