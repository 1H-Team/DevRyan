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
import { pathToFileURL } from 'node:url';
import { startRevertModelFixture } from './qa/revert-model-fixture.mjs';
import { createCursorSdkRuntime } from '../packages/cursor-sdk-runtime/index.js';
import { resolveCursorRipgrepPath } from '../packages/cursor-sdk-runtime/ripgrep-path.js';
import { createWebManagedOpenCodeExecutor } from '../packages/web/server/lib/orchestration/open-code-executor.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createExecutionHostOwner, executionHostOwnerLost } from '../packages/harness-runtime/lib/execution-host-owner.js';

const binary = process.env.DEVRYAN_TEST_OPENCODE_BINARY;
const launcher = process.env.DEVRYAN_TEST_EXECUTION_LAUNCHER;
assert(path.isAbsolute(binary ?? '') && await verifySessionExecutionLauncher({ launcher }), 'Compatible runtime artifacts required');
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-execution-journey-')));
const directory = path.join(root, 'project');
const dataDirectory = path.join(root, 'app-data');
const origin = `http://127.0.0.1:${await reservePort()}`;
const ownedReceipts = [];
const executionCalls = [];
let cursor;
let failToolAdmission = false;
let skillCompletionGate = null;
const holdSkillCompletion = () => {
  assert.equal(skillCompletionGate, null);
  let release;
  skillCompletionGate = new Promise(resolve => { release = resolve; });
  return () => { skillCompletionGate = null; release(); };
};
const host = createSessionExecutionHost({ dataDirectory, getLauncher: () => launcher,
  fetchImpl: async (...args) => { const response = await fetch(...args); if (!response.ok) console.error("Fixture request failed", String(args[0]), await response.clone().text()); return response; },
  buildOpenCodeUrl: (route) => origin + route, recordReceipt: (receipt) => ownedReceipts.push(receipt),
  stopCursor: ({ sessionID }) => cursor?.abortAndWait(sessionID) });
const bridge = createManagedOrchestrationPrivateHost({ handleRpc: async ({ method, params }) => {
  assert.equal(method, 'session_execution');
  executionCalls.push({ action: params.action, tool: params.tool, callID: params.callID });
  if (failToolAdmission && ['begin', 'cancel-before-start'].includes(params.action)) {
    const code = params.action === 'begin' ? 'local_execution_timeout' : 'cleanup_fixture_failed';
    throw Object.assign(new Error(code), { code });
  }
  if (params.tool === 'skill' && params.action === 'direct-finish') await skillCompletionGate;
  return host.plugin(params);
} });
let upstream, server, held, model, traceTimer, skillSource, browserHost;
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
  const skillText = (name) => `---\nname: ${name}\ndescription: Isolated execution skill fixture\n---\nSelected ${name} content. Read reference.txt relative to this skill.\n`;
  const skillRoots = [
    [path.join(root, 'home/.agents/skills/global-fixture'), 'global-fixture'],
    [path.join(directory, '.agents/skills/project-fixture'), 'project-fixture'],
    [path.join(root, 'home/custom-skills/tilde-fixture'), 'tilde-fixture'],
    [path.join(root, 'linked-skill'), 'symlink-fixture'],
  ];
  for (const [folder, name] of skillRoots) {
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, 'SKILL.md'), skillText(name));
    await fs.writeFile(path.join(folder, 'reference.txt'), `Included ${name} reference`);
  }
  await fs.symlink(path.join(root, 'linked-skill'), path.join(directory, '.agents/skills/symlink-fixture'), 'dir');
  const ripgrep = resolveCursorRipgrepPath();
  assert(path.isAbsolute(ripgrep.path), 'Pinned release ripgrep binary required');
  let skillFetches = 0;
  skillSource = http.createServer((req, res) => {
    skillFetches++;
    if (req.url === '/index.json') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ skills: [{ name: 'url-fixture', files: ['SKILL.md', 'reference.txt'], version: 'fixture-1' }] })); }
    else if (req.url === '/url-fixture/SKILL.md') res.end(skillText('url-fixture'));
    else if (req.url === '/url-fixture/reference.txt') res.end('Included URL reference');
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise((resolve) => skillSource.listen(0, '127.0.0.1', resolve));
  const skillURL = `http://127.0.0.1:${skillSource.address().port}/`;
  const transientContextPlugin = path.join(root, 'transient-context.mjs');
  const browserPlugin = path.resolve('packages/web/server/default-config/plugins/devryan-browser.mjs');
  const browserInstall = path.join(root, 'browser-install');
  const browserBinary = path.join(browserInstall, 'node_modules/agent-browser/bin/fixture');
  await fs.mkdir(path.dirname(browserBinary), { recursive: true });
  await fs.writeFile(path.join(browserInstall, 'devryan-agent-browser.json'), '{}');
  await fs.writeFile(browserBinary, `#!${process.execPath}\nimport('node:fs').then(fs=>{
    if(process.env.DEVRYAN_BROWSER_CDP_TOKEN)throw new Error('credential leaked to browser CLI');
    if(process.argv.includes('snapshot')){fs.writeFileSync('browser-owned.txt','captured-browser');console.log('Browser fixture snapshot');}
    else console.log('Connected');});`, { mode: 0o755 });
  const browserScopes = [];
  browserHost = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer fixture-host-browser');
    let body = ''; for await (const chunk of req) body += chunk;
    browserScopes.push(JSON.parse(body));
    assert.equal(browserScopes.at(-1).directory, directory);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ leaseId: 'browser_owned', wsUrl: 'ws://127.0.0.1:54321/fixture', created: true }));
  });
  await new Promise(resolve => browserHost.listen(0, '127.0.0.1', resolve));
  await fs.writeFile(transientContextPlugin, `export default async () => ({
    'experimental.chat.messages.transform': async (_input, output) => {
      const user = output.messages.findLast(message => message.info.role === 'user');
      if (user) user.parts.push({ type: 'text', synthetic: true,
        text: 'Preserve the complete fixture context through confined tool execution.',
        metadata: { 'fixture.orchestrationReminder': true } });
    },
  });`);
  const env = { PATH: [path.dirname(ripgrep.path), process.env.PATH].filter(Boolean).join(path.delimiter),
    HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_DATA_HOME: path.join(root, 'data'), XDG_CACHE_HOME: path.join(root, 'cache'), XDG_STATE_HOME: path.join(root, 'state'),
    OPENCODE_TEST_HOME: path.join(root, 'home'), OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(root, 'managed'),
    OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true', OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
    OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: 'true',
    DEVRYAN_BROWSER_CDP_DISCOVERY_URL: `http://127.0.0.1:${browserHost.address().port}/api/desktop/browser-cdp`,
    DEVRYAN_BROWSER_CDP_TOKEN: 'fixture-host-browser', DEVRYAN_AGENT_BROWSER_BIN: browserBinary,
    DEVRYAN_EXECUTION_BROWSER_PLUGIN: createHash('sha256').update(await fs.readFile(browserPlugin)).digest('hex'),
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [pathToFileURL(transientContextPlugin).href, pathToFileURL(browserPlugin).href],
      model: 'fixture/fixture', small_model: 'fixture/fixture', provider: { fixture: { ...model.config, models: { ...model.config.models, 'gpt-fixture': model.config.models.fixture } }, 'cursor-acp': { ...model.config, models: { 'composer-2.5': model.config.models.fixture } } },
      skills: { paths: ['~/custom-skills'], urls: [skillURL] },
      mcp: {}, snapshot: false, permission: 'allow',
      ...(process.platform === 'darwin' ? { shell: '/bin/zsh' } : {}) }),
    ...await bridge.start(), DEVRYAN_EXECUTION_BOUNDARY: '1', DEVRYAN_EXECUTION_TRACE: '1' };
  await fs.mkdir(env.HOME, { recursive: true });
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
  assert.equal((await request('/session/revert-capabilities')).sessionRetention, 1);
  const retentionCall = async (body, token = env.DEVRYAN_ORCHESTRATION_TOKEN) => {
    const response = await fetch(`${origin}/session/retention-control?directory=${encodeURIComponent(directory)}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-devryan-retention-token': token }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await retentionCall({ action: 'snapshot' }, 'not-authorized')).status, 403);
  const retained = await request('/session', { title: 'Retention admission fixture' });
  const snapshotResponse = await retentionCall({ action: 'snapshot' });
  assert.equal(snapshotResponse.status, 200, JSON.stringify(snapshotResponse.body));
  const nativeSnapshot = snapshotResponse.body;
  assert.equal(nativeSnapshot.complete, true); assert(nativeSnapshot.sessions.some((row) => row.id === retained.id));
  let nativeHold = (await retentionCall({ action: 'hold', instanceID: nativeSnapshot.instanceID, ids: [retained.id] })).body.token;
  assert.equal(typeof nativeHold, 'string');
  const blocked = await fetch(`${origin}/session/${retained.id}/prompt_async?directory=${encodeURIComponent(directory)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: { providerID: 'fixture', modelID: 'fixture' }, parts: [{ type: 'text', text: 'must not launch' }] }),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(blocked.status, 409); assert.deepEqual(await blocked.json(), { error: 'session_retention_in_progress', retryable: true });
  assert.equal((await request(`/session/${retained.id}/message`)).length, 0);
  assert.deepEqual((await retentionCall({ action: 'archive', instanceID: nativeSnapshot.instanceID, token: nativeHold, ids: [retained.id] })).body.completed, [retained.id]);
  assert((await request(`/session/${retained.id}`)).time.archived > 0);
  nativeHold = (await retentionCall({ action: 'hold', instanceID: nativeSnapshot.instanceID, ids: [retained.id] })).body.token;
  assert.deepEqual((await retentionCall({ action: 'delete', instanceID: nativeSnapshot.instanceID, token: nativeHold, ids: [retained.id] })).body.completed, [retained.id]);
  const lockDirectory = path.join(root, 'owner-check');
  const nativeOwner = await createExecutionHostOwner({ directory: lockDirectory, launcher });
  assert.equal(await executionHostOwnerLost({ directory: lockDirectory, launcher, id: nativeOwner.id }), false);
  nativeOwner.close(); await new Promise((resolve) => nativeOwner.signal.aborted ? resolve() : nativeOwner.signal.addEventListener('abort', resolve, { once: true }));
  assert.equal(await executionHostOwnerLost({ directory: lockDirectory, launcher, id: nativeOwner.id }), true);
  assert.throws(() => nativeOwner.assert(), /execution_owner_lost/);
  console.log('PASS: private retention authentication, held async admission, archive/delete, and native owner loss');
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
  const temporary = await request('/session', { title: 'Confined temporary files' });
  await shell(temporary.id, node('const fs=require("node:fs"),os=require("node:os"),path=require("node:path"); if(os.tmpdir()!==process.env.HOME) throw new Error("temporary files escaped scratch home"); const dir=fs.mkdtempSync(path.join(os.tmpdir(),"tool-temp-")); fs.writeFileSync(path.join(dir,"scratch"),"private"); fs.rmSync(dir,{recursive:true}); fs.writeFileSync("temp-check.txt","scratch-ok")'));
  assert.equal(await fs.readFile(path.join(directory, 'temp-check.txt'), 'utf8'), 'scratch-ok');
  if (process.platform === 'darwin') {
    const diagnostic = setTimeout(() => {
      void (async () => {
        const exists = await fs.access(path.join(directory, 'heredoc-check.txt')).then(() => true, () => false);
        const { stdout } = await promisify(execFile)('ps', ['-Ao', 'pid=,ppid=,state=,comm=']);
        const processes = stdout.split('\n').map((line) => {
          const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
          return match ? { pid: Number(match[1]), ppid: Number(match[2]), state: match[3], command: match[4] } : null;
        }).filter(Boolean);
        const relevant = new Set(processes.filter(({ command }) => /DevRyan-(?:opencode|execution)/.test(command)).map(({ pid }) => pid));
        for (let i = 0; i < 3; i++) for (const row of processes) if (relevant.has(row.ppid)) relevant.add(row.pid);
        console.error('Heredoc still running', { exists,
          processes: processes.filter(({ pid, command }) => relevant.has(pid) || /\/(?:zsh|bash|sh|cat)$/.test(command)) });
      })().catch((error) => console.error('Heredoc diagnostic failed', error));
    }, 15_000);
    let heredoc;
    try { heredoc = await shell(temporary.id, 'cat <<EOF > heredoc-check.txt\nheredoc-ok\nEOF\n'); }
    finally { clearTimeout(diagnostic); }
    assert.equal(await fs.stat(path.join(directory, 'heredoc-check.txt')).then(() => true, () => false), true,
      `Confined heredoc did not publish: ${JSON.stringify(heredoc)}`);
    assert.equal(await fs.readFile(path.join(directory, 'heredoc-check.txt'), 'utf8'), 'heredoc-ok\n',
      `Confined heredoc published unexpected content: ${JSON.stringify(heredoc)}`);
  }
  console.log('PASS: native tools keep temporary files and shell heredocs inside their scratch home');
  const invoke = async (sessionID, name, args) => {
    const result = await request(`/session/${sessionID}/message`, { model: { providerID: 'fixture', modelID: name === 'apply_patch' ? 'gpt-fixture' : 'fixture' },
      agent: 'build', parts: [{ type: 'text', text: `DEVRYAN_FIXTURE_TOOL:${JSON.stringify({ name, args })}` }] });
    const messages = await request(`/session/${sessionID}/message`);
    const call = messages.filter((message) => message.info.parentID === result.info.parentID)
      .flatMap((message) => message.parts).find((part) => part.type === 'tool' && part.tool === name);
    assert(call, `The real dispatcher did not call ${name}: ${JSON.stringify({ result, calls: messages.flatMap((message) => message.parts).filter((part) => part.type === 'tool'),
      available: model.requests.at(-1)?.tools?.map((tool) => tool.function?.name) })}`);
    assert.equal(call.state.status, 'completed', JSON.stringify(call));
    return { result, call };
  };
  const browserSession = await request('/session', { title: 'Confined browser' });
  const browserResult = await invoke(browserSession.id, 'devryan_browser', { command: 'snapshot', args: [] });
  assert(browserResult.call.state.output.includes('Browser fixture snapshot'));
  // Browser CLI output lives in the shared execution cache, outside the
  // project view. It must not become a project mutation or Revert input.
  await assert.rejects(fs.access(path.join(directory, 'browser-owned.txt')), { code: 'ENOENT' });
  assert(browserScopes.every(scope => scope.opencodeSessionID === browserSession.id && scope.messageID === browserResult.result.info.parentID));
  await host.coordinator.revert({ directory, sessionID: browserSession.id, messageID: browserResult.result.info.parentID });
  await assert.rejects(fs.access(path.join(directory, 'browser-owned.txt')), { code: 'ENOENT' });
  console.log('PASS: scoped browser capability, cache output isolation and Revert');
  const skills = await request('/session', { title: 'Selected skills' });
  // Includes consecutive calls and a return to the first skill, with real
  // global, project, tilde, symlink and downloaded-cache discovery.
  for (const name of ['global-fixture', 'project-fixture', 'tilde-fixture', 'symlink-fixture', 'url-fixture', 'project-fixture']) {
    const fetchedBefore = skillFetches;
    const loaded = await invoke(skills.id, 'skill', { name });
    assert(loaded.call.state.output.includes(`Selected ${name} content.`));
    assert(loaded.call.state.output.includes('reference.txt'));
    assert(!loaded.call.state.output.includes('/views/'), 'Skill output paths retain logical project identity');
    assert.equal(skillFetches, fetchedBefore, 'Loading must not refetch skill URLs');
    assert.deepEqual(executionCalls.filter(call => call.callID === loaded.call.callID).map(call => call.action),
      ['direct-admit', 'direct-finish'], 'Built-in skill loading must not prepare a workspace or launch a worker');
    const receipt = ownedReceipts.find(receipt => receipt.callID === loaded.call.callID);
    assert(receipt, 'Skill completion retains an owned receipt');
    assert.deepEqual(receipt.files, []);
  }
  console.log('PASS: selected global/project/tilde/symlink/URL skills, include paths, and consecutive direct receipts');
  const failed = await request('/session', { title: 'Admission failure fixture' });
  failToolAdmission = true;
  try {
    await request(`/session/${failed.id}/message`, { model: { providerID: 'fixture', modelID: 'fixture' },
      agent: 'build', parts: [{ type: 'text', text: `DEVRYAN_FIXTURE_TOOL:${JSON.stringify({ name: 'write', args: { filePath: path.join(directory, 'must-not-exist'), content: 'forbidden' } })}` }] });
    const rows = await request(`/session/${failed.id}/message`);
    const tool = rows.flatMap((row) => row.parts).find((part) => part.type === 'tool' && part.tool === 'write');
    assert.equal(tool?.state.status, 'error');
    assert.match(tool.state.error, /local_execution_timeout/);
    assert.match(tool.state.error, /execution did not start; cleanup unconfirmed/);
    await assert.rejects(fs.access(path.join(directory, 'must-not-exist')), { code: 'ENOENT' });
  } finally { failToolAdmission = false; }
  await invoke(failed.id, 'write', { filePath: path.join(directory, 'after-failure'), content: 'healthy' });
  assert.equal(await fs.readFile(path.join(directory, 'after-failure'), 'utf8'), 'healthy');
  console.log('PASS: original admission failure survives cleanup failure, no write occurs, and the next prompt succeeds');
  const direct = await request('/session', { title: 'Direct file tools' });
  await invoke(direct.id, 'write', { filePath: path.join(directory, 'direct.txt'), content: 'first\n' });
  await invoke(direct.id, 'edit', { filePath: path.join(directory, 'direct.txt'), oldString: 'first', newString: 'second' });
  assert.equal(await fs.readFile(path.join(directory, 'direct.txt'), 'utf8'), 'second\n');
  const attached = await request(`/session/${direct.id}/message`, { noReply: true,
    model: { providerID: 'fixture', modelID: 'fixture' }, agent: 'build',
    parts: [{ type: 'file', mime: 'text/plain', url: pathToFileURL(path.join(directory, 'direct.txt')).href }] });
  assert(attached.parts.some((part) => part.type === 'text' && part.text.includes('second')), 'Attached file expansion retains its read-only context');
  console.log('PASS: native Write and Edit dispatch through confined views and file attachment expansion');
  await invoke(direct.id, 'apply_patch', { patchText: [
    '*** Begin Patch', `*** Add File: ${path.join(directory, 'patch-added.txt')}`,
    `+literal ${directory}/keep-this-content`, `*** Update File: ${path.join(directory, 'direct.txt')}`,
    `*** Move to: ${path.join(directory, 'patch-moved.txt')}`, '@@', '-second', '+patched', '*** End Patch',
  ].join('\n') });
  assert.equal(await fs.readFile(path.join(directory, 'patch-added.txt'), 'utf8'), `literal ${directory}/keep-this-content\n`);
  assert.equal(await fs.readFile(path.join(directory, 'patch-moved.txt'), 'utf8'), 'patched\n');
  await assert.rejects(fs.access(path.join(directory, 'direct.txt')), { code: 'ENOENT' });
  await invoke(direct.id, 'apply_patch', { patchText: `*** Begin Patch\n*** Delete File: ${path.join(directory, 'patch-added.txt')}\n*** End Patch` });
  await assert.rejects(fs.access(path.join(directory, 'patch-added.txt')), { code: 'ENOENT' });
  console.log('PASS: native absolute patch add/update/move/delete use confined views and preserve literal file contents');
  // Built-in read-only tools take the direct receipt path: one finished,
  // already-cleaned receipt each, and no reserved lease or private view.
  await fs.writeFile(path.join(directory, 'direct-read.txt'), 'direct receipt content\n');
  const readCall = (await invoke(direct.id, 'read', { filePath: path.join(directory, 'direct-read.txt') })).call;
  assert(readCall.state.output.includes('direct receipt content'), 'Direct read returns its result');
  const grepCall = (await invoke(direct.id, 'grep', { pattern: 'direct receipt' })).call;
  const directOutcomes = await host.runtime.executionOutcomes({ directory, sessionID: direct.id,
    calls: [readCall, grepCall].map((call) => ({ messageID: call.messageID, callID: call.callID })) });
  assert.deepEqual(directOutcomes.map((row) => row.outcome), ['finished', 'finished']);
  for (const call of [readCall, grepCall]) {
    const lease = await host.runtime.leaseForCall({ directory, sessionID: direct.id, callID: call.callID });
    assert(lease?.direct === true && lease.cleaned === true && lease.state === 'published', JSON.stringify(lease));
  }
  console.log('PASS: built-in read and grep record one direct receipt each, without a reserved lease or view');

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
    prompt: `DEVRYAN_FIXTURE_TOOL:${JSON.stringify({ name: 'bash', args: {
      command: node('require("node:fs").writeFileSync("managed-child.txt", "managed-owned")'),
      description: 'Write the managed fixture' } })}` },
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
  const qaHome = path.join(root, 'qa-home'); await fs.mkdir(qaHome);
  await fs.writeFile(path.join(qaHome, '.devryan-qa-home'), 'isolated fixture');
  await fs.writeFile(worker, `import fs from 'node:fs'; import os from 'node:os'; import assert from 'node:assert/strict';
    process.env.DEVRYAN_QA_HOME=${JSON.stringify(qaHome)};
    await import(${JSON.stringify(new URL('./qa/isolated-home.mjs', import.meta.url).href)});
    assert.equal(os.homedir(),process.env.HOME); assert.notEqual(os.homedir(),process.env.DEVRYAN_QA_HOME);
    fs.mkdirSync(os.homedir()+'/.cursor',{recursive:true}); fs.writeFileSync(os.homedir()+'/.cursor/database-fixture','writable');
    let raw=''; for await(const chunk of process.stdin) raw+=chunk;
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
    for (const mode of ['web', 'electron']) await verifyRevertUi({ mode, root, dataDirectory, directory, upstream: origin, environment: env, request, invoke, shell, node, until, holdSkillCompletion });
  }
} catch (cause) {
  console.error(upstream?.getLog()); throw cause;
} finally {
  if (browserHost) await new Promise((resolve) => browserHost.close(resolve));
  if (skillSource) await new Promise((resolve) => skillSource.close(resolve));
  clearInterval(traceTimer);
  await cursor?.dispose();
  await upstream?.stop(); await held?.catch(() => {});
  await model?.stop();
  if (server) await new Promise((resolve) => server.close(resolve));
  await bridge.stop(); await host.drain(); await fs.rm(root, { recursive: true, force: true });
}
