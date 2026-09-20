import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { reservePort, startOwnedProcess } from './qa/process.mjs';
import { git } from '../packages/harness-runtime/lib/session-changes-git.js';
import { verifySessionExecutionLauncher } from '../packages/harness-runtime/lib/session-execution.js';
import { createSessionExecutionHost } from '../packages/web/server/lib/opencode/session-execution-host.js';
import { createManagedOrchestrationPrivateHost } from '../packages/web/server/lib/orchestration/private-host.js';
import { registerScopedSessionRevertRoute } from '../packages/web/server/lib/opencode/session-scoped-revert.js';
import { applyContextModeHotfix } from '../packages/web/server/lib/opencode/context-mode-hotfix.js';
import { pathToFileURL } from 'node:url';
import { startRevertModelFixture } from './qa/revert-model-fixture.mjs';
import { createCursorSdkRuntime } from '../packages/cursor-sdk-runtime/index.js';
import { createWebManagedOpenCodeExecutor } from '../packages/web/server/lib/orchestration/open-code-executor.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const binary = process.env.DEVRYAN_TEST_OPENCODE_BINARY;
const launcher = process.env.DEVRYAN_TEST_EXECUTION_LAUNCHER;
assert(path.isAbsolute(binary ?? '') && await verifySessionExecutionLauncher({ launcher }), 'Compatible runtime artifacts required');
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-execution-journey-')));
const directory = path.join(root, 'project');
const dataDirectory = path.join(root, 'app-data');
const origin = `http://127.0.0.1:${await reservePort()}`;
const ownedReceipts = [];
let cursor;
const host = createSessionExecutionHost({ dataDirectory, getLauncher: () => launcher,
  fetchImpl: async (...args) => { const response = await fetch(...args); if (!response.ok) console.error("Fixture request failed", String(args[0]), await response.clone().text()); return response; },
  buildOpenCodeUrl: (route) => origin + route, recordReceipt: (receipt) => ownedReceipts.push(receipt),
  stopCursor: ({ sessionID }) => cursor?.abortAndWait(sessionID) });
const bridge = createManagedOrchestrationPrivateHost({ handleRpc: ({ method, params }) => {
  assert.equal(method, 'session_execution'); return host.plugin(params);
} });
let upstream, server, held, model, traceTimer;
const request = async (route, body, base = origin) => {
  const url = new URL(route, base); url.searchParams.set('directory', directory);
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120_000) });
  const value = await response.json(); assert.equal(response.status, 200, `${route}: ${JSON.stringify(value)}`); return value;
};
const until = async (fn) => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    upstream.check(); if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Runtime journey timed out');
};
try {
  await fs.mkdir(dataDirectory);
  await fs.mkdir(directory); await git(directory, ['init', '--quiet']);
  await fs.writeFile(path.join(directory, 'example'), 'a=1; b=2');
  await fs.chmod(path.join(directory, 'example'), 0o600);
  model = await startRevertModelFixture();
  const contextSource = path.resolve(process.env.DEVRYAN_TEST_CONTEXT_MODE_CONFIG || '.cache/context-mode-worker-check');
  const contextConfig = path.join(root, 'context-config'), contextModules = path.join(contextConfig, 'node_modules');
  await fs.mkdir(contextModules, { recursive: true });
  for (const entry of await fs.readdir(path.join(contextSource, 'node_modules'))) {
    if (entry === 'context-mode') await fs.cp(await fs.realpath(path.join(contextSource, 'node_modules', entry)), path.join(contextModules, entry), { recursive: true });
    else await fs.symlink(path.join(contextSource, 'node_modules', entry), path.join(contextModules, entry), 'dir');
  }
  const hotfix = applyContextModeHotfix({ configDirectory: contextConfig }); assert(hotfix.ok, hotfix.error);
  const env = { PATH: process.env.PATH, HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_DATA_HOME: path.join(root, 'data'), XDG_CACHE_HOME: path.join(root, 'cache'), XDG_STATE_HOME: path.join(root, 'state'),
    OPENCODE_TEST_HOME: path.join(root, 'home'), OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(root, 'managed'),
    OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
    OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: 'true',
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [pathToFileURL(path.join(contextModules, 'context-mode/build/adapters/opencode/plugin.js')).href],
      model: 'fixture/fixture', small_model: 'fixture/fixture', provider: { fixture: model.config, 'cursor-acp': { ...model.config, models: { 'composer-2.5': model.config.models.fixture } } },
      mcp: {}, snapshot: false, permission: 'allow' }),
    ...await bridge.start(), DEVRYAN_EXECUTION_BOUNDARY: '1', DEVRYAN_EXECUTION_TRACE: '1' };
  await fs.mkdir(env.HOME);
  await fs.writeFile(path.join(env.HOME, '.devryan-qa-home'), 'isolated Revert verification');
  await fs.writeFile(path.join(root, 'credentials.env.json'), '{}');
  const providerProbe = path.join(root, 'provider-probe.mjs');
  await fs.writeFile(providerProbe, `import assert from 'node:assert/strict';
    import { spawnConfinedProvider } from ${JSON.stringify(new URL('../packages/web/server/lib/opencode/session-provider-spawn.js', import.meta.url).href)};
    const child=spawnConfinedProvider({command:${JSON.stringify(process.execPath)},cwd:${JSON.stringify(directory)},
      env:{PATH:process.env.PATH,HOME:process.env.HOME},args:['-e',${JSON.stringify(`const fs=require('node:fs');
        try{fs.writeFileSync(${JSON.stringify(path.join(directory, 'example'))},'lost');process.exit(2)}
        catch(error){if(!['EPERM','EACCES','EROFS'].includes(error.code))throw error}process.stdin.pipe(process.stdout);`)}]});
    let output='',stderr='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>stderr+=c);
    child.stdin.end('compiled-claude-transport');
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)});
    assert.equal(code,0,stderr);assert.equal(output,'compiled-claude-transport');`);
  await promisify(execFile)(binary, [providerProbe], { cwd: directory, timeout: 60_000, env: {
    ...env, BUN_BE_BUN: '1', DEVRYAN_EXECUTION_LAUNCHER: launcher,
    DEVRYAN_PROVIDER_WORKER: path.resolve('packages/web/server/lib/opencode/session-provider-worker.mjs'),
    DEVRYAN_PROVIDER_STORAGE: path.join(root, 'provider-probe-state'),
  } });
  assert.equal(await fs.readFile(path.join(directory, 'example'), 'utf8'), 'a=1; b=2');
  console.log('PASS: Claude provider transport from the compiled Bun host preserves the read-only project');
  upstream = startOwnedProcess(binary, ['serve', '--hostname', '127.0.0.1', '--port', new URL(origin).port,
    '--print-logs', '--log-level', 'ERROR'], { cwd: directory, env });
  let traceOffset = 0;
  traceTimer = setInterval(() => { const trace = upstream.getLog(); process.stdout.write(trace.slice(traceOffset)); traceOffset = trace.length; }, 1000);
  await until(() => fetch(origin + '/global/health', { signal: AbortSignal.timeout(3000) }).then(async (r) => {
    const healthy = r.ok; await r.text(); return healthy;
  }, () => false));
  assert.equal((await request('/session/revert-capabilities')).executionBoundary, 1);
  const express = createRequire(new URL('../packages/web/package.json', import.meta.url))('express');
  const app = express(); registerScopedSessionRevertRoute(app, { sessionRevertCoordinator: host.coordinator });
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const web = `http://127.0.0.1:${server.address().port}`;
  const a = await request('/session', { title: 'Confined chat A' });
  const b = await request('/session', { title: 'Confined chat B' });
  const shell = (sessionID, command) => request(`/session/${sessionID}/shell`, { agent: 'build',
    model: { providerID: 'opencode', modelID: 'big-pickle' }, command });
  const node = (code) => `'${process.execPath.replaceAll("'", "'\\''")}' -e '${code.replaceAll("'", "'\\''")}'`;
  const first = await shell(a.id, node('require("node:fs").writeFileSync("example", "a=3; b=2")'));
  assert.equal(await fs.readFile(path.join(directory, 'example'), 'utf8'), 'a=3; b=2');
  const release = path.join(root, 'release');
  held = shell(b.id, node(`const fs=require("node:fs"), base=fs.readFileSync("example","utf8"); console.log("waiting-for-revert");
    const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(t);fs.writeFileSync("example",base.replace("b=2","b=4"))}},25)`));
  void held.catch(() => {});
  await until(async () => (await request(`/session/${b.id}/message`)).some((m) => m.parts.some((p) => p.type === 'tool'
    && JSON.stringify(p.state.metadata ?? p.state.output ?? "").includes('waiting-for-revert'))));
  const userMessageID = first.info.parentID;
  await request(`/api/openchamber/session/${a.id}/scoped-revert`, { messageID: userMessageID }, web);
  assert.equal(await fs.readFile(path.join(directory, 'example'), 'utf8'), 'a=1; b=2');
  await fs.writeFile(release, 'go'); await held;
  assert.equal(await fs.readFile(path.join(directory, 'example'), 'utf8'), 'a=1; b=4');
  await request(`/api/openchamber/session/${a.id}/scoped-unrevert`, {}, web);
  assert.equal(await fs.readFile(path.join(directory, 'example'), 'utf8'), 'a=3; b=4');
  assert.equal((await fs.stat(path.join(directory, 'example'))).mode & 0o777, 0o600);
  assert.equal(ownedReceipts.length, 2);
  assert(ownedReceipts.every((receipt) => receipt.source === 'confined-execution'));
  console.log('PASS: concurrent shell Revert, late publication, and Redo');
  const invoke = async (sessionID, name, args) => {
    const result = await request(`/session/${sessionID}/message`, { model: { providerID: 'fixture', modelID: 'fixture' },
      agent: 'build', parts: [{ type: 'text', text: `DEVRYAN_FIXTURE_TOOL:${JSON.stringify({ name, args })}` }] });
    const messages = await request(`/session/${sessionID}/message`);
    const call = messages.filter((message) => message.info.parentID === result.info.parentID)
      .flatMap((message) => message.parts).find((part) => part.type === 'tool' && part.tool === name);
    assert(call, `The real dispatcher did not call ${name}: ${JSON.stringify({ result, calls: messages.flatMap((message) => message.parts).filter((part) => part.type === 'tool'),
      available: model.requests.at(-1)?.tools?.map((tool) => tool.function?.name) })}`);
    assert.equal(call.state.status, 'completed', JSON.stringify(call));
    return { result, call };
  };
  const direct = await request('/session', { title: 'Direct file tools' });
  await invoke(direct.id, 'write', { filePath: path.join(directory, 'direct.txt'), content: 'first\n' });
  await invoke(direct.id, 'edit', { filePath: path.join(directory, 'direct.txt'), oldString: 'first', newString: 'second' });
  assert.equal(await fs.readFile(path.join(directory, 'direct.txt'), 'utf8'), 'second\n');
  const attached = await request(`/session/${direct.id}/message`, { noReply: true,
    model: { providerID: 'fixture', modelID: 'fixture' }, agent: 'build',
    parts: [{ type: 'file', mime: 'text/plain', url: pathToFileURL(path.join(directory, 'direct.txt')).href }] });
  assert(attached.parts.some((part) => part.type === 'text' && part.text.includes('second')), 'Attached file expansion retains its read-only context');
  console.log('PASS: native Write and Edit dispatch through confined views and file attachment expansion');
  const context = await request('/session', { title: 'Native Context Mode' });
  await invoke(context.id, 'ctx_execute', { language: 'javascript', code: 'require("node:fs").writeFileSync("context.txt", "owned-context"); console.log("context-written")' });
  assert.equal(await fs.readFile(path.join(directory, 'context.txt'), 'utf8'), 'owned-context');
  await invoke(context.id, 'ctx_index', { content: 'concurrentrevertfixture identifies content retained across private executions.', source: 'Revert fixture' });
  const search = await invoke(context.id, 'ctx_search', { queries: ['concurrentrevertfixture'] });
  assert(search.call.state.output.includes('concurrentrevertfixture'), search.call.state.output);
  console.log('PASS: Context Mode execution and retrieval share logical project identity');
  const parent = await request('/session', { title: 'Descendant ownership' });
  const child = await invoke(parent.id, 'task', { description: 'Write the fixture', subagent_type: 'general',
    prompt: `DEVRYAN_FIXTURE_TOOL:${JSON.stringify({ name: 'write', args: { filePath: path.join(directory, 'child.txt'), content: 'child-owned' } })}` });
  assert.equal(await fs.readFile(path.join(directory, 'child.txt'), 'utf8'), 'child-owned');
  const managed = createWebManagedOpenCodeExecutor({ buildOpenCodeUrl: (route) => origin + route,
    getOpenCodeAuthHeaders: () => ({}), pollIntervalMs: 50, idleStablePolls: 1,
    registerExecutionChild: (input) => host.plugin({ ...input, action: 'child' }) });
  const managedResult = await managed.start({ taskId: 'dvr_revert_fixture', rootSessionId: parent.id,
    dispatchCallId: child.call.callID, childSessionId: null, directory, providerId: 'fixture', modelId: 'fixture',
    agent: 'build', variant: null, label: 'Managed Revert descendant',
    prompt: `DEVRYAN_FIXTURE_TOOL:${JSON.stringify({ name: 'ctx_execute', args: {
      language: 'javascript', code: 'require("node:fs").writeFileSync("managed-child.txt", "managed-owned")' } })}` },
  { setChildSessionId: async () => true, markAccepted: async () => true });
  assert.equal(managedResult.status, 'completed', JSON.stringify(managedResult));
  assert.equal(await fs.readFile(path.join(directory, 'managed-child.txt'), 'utf8'), 'managed-owned');
  await host.coordinator.revert({ directory, sessionID: parent.id, messageID: child.result.info.parentID });
  await assert.rejects(fs.access(path.join(directory, 'child.txt')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(directory, 'managed-child.txt')), { code: 'ENOENT' });
  console.log('PASS: native and managed task descendants are included in their parent Revert');
  const active = await request('/session', { title: 'Active target cancellation' });
  const activeRun = shell(active.id, node('require("node:fs").writeFileSync("cancelled.txt","private-only"); console.log("cancel-target-ready"); setInterval(()=>{},1000)'));
  void activeRun.catch(() => {});
  let activeMessages;
  await until(async () => { activeMessages = await request(`/session/${active.id}/message`);
    return activeMessages.some((message) => message.parts.some((part) => part.type === 'tool' && JSON.stringify(part.state.metadata ?? part.state.output ?? "").includes('cancel-target-ready'))); });
  await host.coordinator.revert({ directory, sessionID: active.id, messageID: activeMessages.find((message) => message.info.role === 'user').info.id });
  await activeRun;
  await assert.rejects(fs.access(path.join(directory, 'cancelled.txt')), { code: 'ENOENT' });
  assert.equal((await host.runtime.activeLeases({ directory, sessions: [active.id] })).length, 0);
  console.log('PASS: Revert cancels the target process tree before acknowledging');
  const worker = path.join(root, 'cursor-fixture.mjs');
  await fs.writeFile(worker, `import fs from 'node:fs'; let raw=''; for await(const chunk of process.stdin) raw+=chunk;
    const input=JSON.parse(raw); const held=JSON.stringify(input).includes('HoldCursor'); fs.writeFileSync(held?'cursor-held.txt':'cursor.txt','cursor-owned');
    if(held){console.log(JSON.stringify({type:'message',message:{type:'assistant',message:{content:[{type:'text',text:'cursor-active-ready'}]}}}));await new Promise(()=>{setInterval(()=>{},1000)});}
    console.log(JSON.stringify({type:'message',message:{type:'assistant',message:{content:[{type:'text',text:'Cursor fixture complete.'}]}}}));
    console.log(JSON.stringify({type:'done',status:'finished'}));`);
  cursor = createCursorSdkRuntime({ storageDir: path.join(root, 'cursor'), workerPath: worker, nodeBinary: process.execPath,
    loadSdk: async () => ({ Cursor: { models: { list: async () => [] } } }),
    env: {}, readAuth: () => ({ 'cursor-acp': { key: 'isolated-fixture' } }), usePersistentWorkerForPrompts: false,
    executionAdapter: { start: host.startCursor, startReadOnly: host.startReadOnly, beforePrompt: host.beforeCursorPrompt },
    onPersistRecord: host.persistCursorRecord });
  const cursorSession = await request('/session', { title: 'Captured Cursor' });
  const cursorPrompt = async () => cursor.handlePromptAsync({ directory, sessionID: cursorSession.id,
    body: { model: { providerID: 'cursor-acp', modelID: 'composer-2.5' }, parts: [{ type: 'text', text: 'Write the fixture' }] } });
  await cursorPrompt(); await until(async () => (await cursor.getSessionMessages(cursorSession.id)).some((m) => m.info.time?.completed));
  await cursor.abortAndWait(cursorSession.id);
  const cursorMessages = await request(`/session/${cursorSession.id}/message`);
  assert.equal(await fs.readFile(path.join(directory, 'cursor.txt'), 'utf8'), 'cursor-owned');
  await host.coordinator.revert({ directory, sessionID: cursorSession.id, messageID: cursorMessages[0].info.id });
  await assert.rejects(fs.access(path.join(directory, 'cursor.txt')), { code: 'ENOENT' });
  await cursorPrompt(); await until(async () => await fs.access(path.join(directory, 'cursor.txt')).then(() => true, () => false));
  await cursor.abortAndWait(cursorSession.id);
  assert.equal((await request(`/session/${cursorSession.id}`)).revert, undefined);
  console.log('PASS: Cursor messages, confined publication, Revert, and a new prompt');
  const activeCursor = await request('/session', { title: 'Active Cursor cancellation' });
  await cursor.handlePromptAsync({ directory, sessionID: activeCursor.id, body: {
    model: { providerID: 'cursor-acp', modelID: 'composer-2.5' }, parts: [{ type: 'text', text: 'HoldCursor' }] } });
  let activeCursorMessages;
  await until(async () => { activeCursorMessages = await cursor.getSessionMessages(activeCursor.id);
    return activeCursorMessages.some((m) => m.parts.some((p) => p.type === 'text' && p.text === 'cursor-active-ready')); });
  await host.coordinator.revert({ directory, sessionID: activeCursor.id, messageID: activeCursorMessages[0].info.id });
  await assert.rejects(fs.access(path.join(directory, 'cursor-held.txt')), { code: 'ENOENT' });
  assert.equal((await host.runtime.activeLeases({ directory, sessions: [activeCursor.id] })).length, 0);
  console.log('PASS: active Cursor cancellation waits for native termination and persistence');
  if (process.env.DEVRYAN_TEST_REVERT_UI === '1') {
    const { verifyRevertUi } = await import('./qa/revert-ui.mjs');
    for (const mode of ['web', 'electron']) await verifyRevertUi({ mode, root, dataDirectory, directory, upstream: origin, environment: env, request, invoke, shell, node, until });
  }
} catch (cause) {
  console.error(upstream?.getLog()); throw cause;
} finally {
  clearInterval(traceTimer);
  await cursor?.dispose();
  await upstream?.stop(); await held?.catch(() => {});
  await model?.stop();
  if (server) await new Promise((resolve) => server.close(resolve));
  await bridge.stop(); await host.drain(); await fs.rm(root, { recursive: true, force: true });
}
