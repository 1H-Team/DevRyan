import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareSessionExecution, readSessionExecutionReceipt, removeExecutionSocketDirectory, startSessionExecution } from '../packages/harness-runtime/lib/session-execution.js';
import { createSessionMutationRuntime } from '../packages/harness-runtime/lib/session-mutations.js';
import { createSessionExecutionOwner } from '../packages/harness-runtime/lib/session-execution-owner.js';
import { createSessionRevertCoordinator } from '../packages/harness-runtime/lib/session-revert-coordinator.js';
import { git } from '../packages/harness-runtime/lib/session-changes-git.js';
import { fileURLToPath } from 'node:url';
import { createWindowsPrivateFile, createWindowsPrivateFileOwner, ensureWindowsPrivateDirectory, readWindowsPrivateFile } from '../packages/harness-runtime/lib/windows-private-files.js';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readOnlyShellLease } from '../packages/web/server/lib/opencode/native-readonly-shell.js';

const launcher = process.env.DEVRYAN_TEST_EXECUTION_LAUNCHER;
if (!launcher) throw new Error('Set DEVRYAN_TEST_EXECUTION_LAUNCHER to the built native helper');
const native = (name, body, timeout) => test(name, { timeout }, body);
const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
async function fixture({ scope, readOnly = false } = {}) {
  const root = process.platform === 'win32' ? path.join(os.tmpdir(), `devryan-execution-${randomUUID()}`)
    : await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-execution-'));
  if (process.platform === 'win32') await ensureWindowsPrivateDirectory(launcher, root);
  roots.push(root);
  const canonical = await fs.realpath(root), viewDirectory = path.join(canonical, 'worktree');
  if (process.platform === 'win32') await ensureWindowsPrivateDirectory(launcher, viewDirectory);
  else await fs.mkdir(viewDirectory);
  const originalLease = { viewDirectory, ...(scope ? { scope } : {}) };
  const lease = readOnly ? await readOnlyShellLease(originalLease) : originalLease;
  const start = async (command, args, signal) => {
    let stdout = '', stderr = '';
    const handle = await startSessionExecution({ launcher, lease, command, args, env: { PATH: process.env.PATH }, signal,
      onOutput: ({ stream, data }) => { if (stream === 'stdout') stdout += data; else stderr += data; } });
    const result = handle.result.catch(cause => {
      // Retain the native operation/error number without printing worker output.
      const refusal = process.platform === 'win32' ? /^([a-z ]{1,80}) failed \(([0-9]{1,10})\)$/.exec(stderr.trim()) : null;
      if (cause instanceof Error && refusal) cause.message += `: ${refusal[1]} failed (${refusal[2]})`;
      throw cause;
    });
    return { ...handle, result, output: () => ({ stdout, stderr }) };
  };
  return { root: canonical, viewDirectory, lease, run: (source, signal) => start(process.execPath, ['-e', source], signal),
    // Through /bin/sh, as `npm run` starts scripts: macOS strips DYLD_* here.
    shell: (script, signal) => start('/bin/sh', ['-c', script], signal),
    exec: (command, args, signal) => start(command, args, signal) };
}

native('Plan boundary preserves workspace reads and denies writes and localhost POST without changing ordinary execution', async t => {
  if (process.platform === 'win32') { t.skip('LPAC read-only workspace/network policy unavailable'); return; }
  const plan = await fixture({readOnly:true}), implementation = await fixture();
  for (const f of [plan, implementation]) await fs.writeFile(path.join(f.viewDirectory,'tracked'),'original');
  let requests=0;
  const server=createServer((_request,response)=>{requests++;response.end('accepted');});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  try {
    const endpoint=`http://127.0.0.1:${server.address().port}/fixture`;
    const source=`const fs=require('node:fs'),http=require('node:http');
      const result={read:fs.readFileSync('tracked','utf8'),write:false,post:false};
      try{fs.writeFileSync('tracked','changed');result.write=true;}catch(e){if(!['EPERM','EACCES','EROFS'].includes(e.code))throw e;}
      const request=http.request(${JSON.stringify(endpoint)},{method:'POST'},response=>{response.resume();response.on('end',()=>{result.post=true;console.log(JSON.stringify(result));});});
      request.on('error',()=>console.log(JSON.stringify(result)));request.setTimeout(1000,()=>request.destroy());request.end('fixture');`;
    const blocked=await plan.run(source);assert.equal((await blocked.result).exitCode,0,blocked.output().stderr);
    assert.deepEqual(JSON.parse(blocked.output().stdout),{read:'original',write:false,post:false});
    assert.equal(await fs.readFile(path.join(plan.viewDirectory,'tracked'),'utf8'),'original');assert.equal(requests,0);
    const allowed=await implementation.run(source);assert.equal((await allowed.result).exitCode,0,allowed.output().stderr);
    assert.deepEqual(JSON.parse(allowed.output().stdout),{read:'original',write:true,post:true});assert.equal(requests,1);
  } finally {await new Promise(resolve=>server.close(resolve));}
},20_000);

native('native boundary denies absolute, symlink and hardlink writes while allowing the private view', async () => {
  const f = await fixture(); const original = path.join(f.root, 'original');
  await fs.writeFile(original, 'preserved'); await fs.symlink(original, path.join(f.viewDirectory, 'link'));
  const handle = await f.run(`const fs = require('node:fs');
    fs.writeFileSync('owned', 'private');
    const targets = [${JSON.stringify(original)}, 'link'];
    try { fs.linkSync(${JSON.stringify(original)}, 'hardlink'); targets.push('hardlink'); }
    catch (error) { if (!['EPERM', 'EACCES', 'EROFS', 'EXDEV'].includes(error.code)) throw error; }
    for (const file of targets) {
      try { fs.writeFileSync(file, 'lost'); process.exit(2); } catch (error) { if (!['EPERM', 'EACCES', 'EROFS'].includes(error.code)) throw error; }
    }`);
  const receipt = await handle.result;
  assert.equal(handle.output().stderr, ''); assert.equal(receipt.terminated, true); assert.equal(receipt.exitCode, 0);
  assert.equal(await fs.readFile(original, 'utf8'), 'preserved');
  assert.equal(await fs.readFile(path.join(f.viewDirectory, 'owned'), 'utf8'), 'private');
}, 20_000);

if (process.platform === 'win32') native('LPAC denies private host and other execution reads and cannot rewrite its sealed runtime', async () => {
  const f = await fixture(), other = await fixture();
  const secret = path.join(f.root, 'host-secret'), foreign = path.join(other.viewDirectory, 'other-execution');
  await fs.writeFile(secret, 'private-fixture-only'); await fs.writeFile(foreign, 'other-fixture-only');
  const handle = await f.run(`const fs = require('node:fs');
    for (const file of ${JSON.stringify([secret, foreign])}) {
      try { fs.readFileSync(file); process.exit(2); }
      catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; }
    }
    try { fs.writeFileSync(process.execPath, 'changed'); process.exit(3); }
    catch (error) { if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error; }
    fs.writeFileSync('owned', 'private'); process.stdout.write('read-boundary-held');`);
  const receipt = await handle.result;
  assert.equal(receipt.confined, true); assert.equal(receipt.exitCode, 0, handle.output().stderr);
  assert.equal(handle.output().stdout, 'read-boundary-held');
  assert.equal(await fs.readFile(secret, 'utf8'), 'private-fixture-only');
  assert.equal(await fs.readFile(foreign, 'utf8'), 'other-fixture-only');
  assert.equal(await fs.readFile(path.join(f.viewDirectory, 'owned'), 'utf8'), 'private');
}, 20_000);

native('ignored output folders are written through while dependencies, escapes and hardlinked host files stay read-only', async () => {
  if (process.platform !== 'darwin') return;
  const f = await fixture();
  // The project lives beside the execution root: a grant may never overlap it.
  const project = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-project-'))), outside = path.join(f.root, 'outside');
  roots.push(project);
  await fs.mkdir(path.join(project, '.artifacts', 'cache', 'deps'), { recursive: true });
  await fs.mkdir(path.join(project, 'node_modules', 'pkg'), { recursive: true }); await fs.mkdir(outside);
  await fs.writeFile(path.join(project, '.artifacts', 'cache', 'deps', 'old.js'), 'stale');
  await fs.writeFile(path.join(project, 'node_modules', 'pkg', 'index.js'), 'dependency');
  const hostFile = path.join(outside, 'host'); await fs.writeFile(hostFile, 'preserved');
  await fs.symlink(outside, path.join(project, '.artifacts', 'escape'));
  for (const input of ['.artifacts', 'node_modules']) await fs.symlink(path.join(project, input), path.join(f.viewDirectory, input));
  const lease = { viewDirectory: f.viewDirectory, projectDirectory: project, inputs: ['.artifacts', 'node_modules'] };
  let stderr = '';
  const handle = await startSessionExecution({ launcher, lease, command: process.execPath, env: { PATH: process.env.PATH },
    onOutput: ({ stream, data }) => { if (stream === 'stderr') stderr += data; },
    args: ['-e', `const fs = require('node:fs');
    fs.unlinkSync('.artifacts/cache/deps/old.js'); fs.writeFileSync('.artifacts/cache/deps/new.js', 'fresh');
    fs.writeFileSync('.artifacts/run.log', 'log');
    const denied = ['node_modules/pkg/index.js', 'node_modules/planted', '.artifacts/escape/planted'];
    try { fs.linkSync(${JSON.stringify(hostFile)}, '.artifacts/hardlink'); denied.push('.artifacts/hardlink'); }
    catch (error) { if (!['EPERM', 'EACCES', 'EROFS', 'EXDEV'].includes(error.code)) throw error; }
    for (const file of denied) {
      try { fs.writeFileSync(file, 'lost'); process.exit(2); } catch (error) { if (!['EPERM', 'EACCES', 'EROFS'].includes(error.code)) throw error; }
    }`] });
  assert.equal((await handle.result).exitCode, 0, stderr);
  assert.deepEqual(await fs.readdir(path.join(project, '.artifacts', 'cache', 'deps')), ['new.js']);
  assert.equal(await fs.readFile(path.join(project, '.artifacts', 'run.log'), 'utf8'), 'log');
  assert.equal(await fs.readFile(path.join(project, 'node_modules', 'pkg', 'index.js'), 'utf8'), 'dependency');
  assert.equal(await fs.readFile(hostFile, 'utf8'), 'preserved');
  assert.deepEqual(await fs.readdir(outside), ['host']);
}, 20_000);

native('background descendants are stopped before the supervisor acknowledges termination', async () => {
  const f = await fixture();
  const code = `const fs = require('node:fs'); setInterval(() => fs.appendFileSync('background', 'x'), 2);`;
  const handle = await f.run(`const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(code)}], { stdio: 'ignore' });
    child.unref();`);
  assert.equal((await handle.result).exitCode, 0);
  const file = path.join(f.viewDirectory, 'background');
  const before = await fs.readFile(file).catch(() => Buffer.alloc(0));
  // This delay is the assertion window: no writer may survive the receipt.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(await fs.readFile(file).catch(() => Buffer.alloc(0)), before);
}, 20_000);

native('the command cannot retain an inherited writable project handle', async () => {
  const f = await fixture(), original = path.join(f.root, 'original');
  await fs.writeFile(original, 'preserved');
  const prepared = await prepareSessionExecution({ launcher, lease: f.lease });
  const descriptor = await fs.open(original, 'r+');
  try {
    const child = spawn(launcher, [...prepared.arguments,
      process.execPath, '-e', "const fs = require('node:fs'); try { fs.writeSync(3, Buffer.from('overwrite')); } catch {} fs.writeFileSync('ran', 'yes')"],
    { cwd: prepared.cwd, env: { PATH: process.env.PATH, ...prepared.environment }, stdio: ['ignore', 'pipe', 'pipe', descriptor.fd] });
    child.stdout.resume(); child.stderr.resume();
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, 0); assert.equal((await readSessionExecutionReceipt(f.lease, { launcher })).terminated, true);
    assert.equal(await fs.readFile(path.join(f.viewDirectory, 'ran'), 'utf8'), 'yes');
    assert.equal(await fs.readFile(original, 'utf8'), 'preserved');
  } finally {
    await descriptor.close(); await fs.rm(prepared.profile, { force: true });
    await removeExecutionSocketDirectory(f.lease, prepared.socketDirectory);
  }
}, 20_000);

native('name resolution is reachable while other local unix sockets stay denied', async () => {
  const f = await fixture();
  const net = await import('node:net');
  // A host-side socket stands in for any local daemon (Docker, ssh-agent).
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\DevRyan-fixture-${randomUUID()}` : path.join(f.root, 'daemon.sock');
  const server = net.createServer((socket) => socket.end('reached')).listen(socketPath);
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  try {
    const probe = (target) => `new Promise((resolve) => { const s = require('node:net').connect(${JSON.stringify(target)});
      s.once('connect', () => { s.destroy(); resolve('connected'); }); s.once('error', (e) => resolve(e.code)); })`;
    const resolver = process.platform === 'win32'
      ? `require('node:dns').promises.lookup('localhost').then(({ address }) => address ? 'connected' : 'unresolved')`
      : probe('/private/var/run/mDNSResponder');
    const handle = await f.run(`Promise.all([${resolver}, ${probe(socketPath)}])
      .then(([resolver, daemon]) => require('node:fs').writeFileSync('probe', JSON.stringify({ resolver, daemon })))`);
    assert.equal((await handle.result).exitCode, 0, handle.output().stderr);
    const probe_ = JSON.parse(await fs.readFile(path.join(f.viewDirectory, 'probe'), 'utf8'));
    assert.equal(probe_.resolver, 'connected');
    assert.notEqual(probe_.daemon, 'connected');
  } finally { await new Promise((resolve) => server.close(resolve)); }
}, 20_000);

native('an execution reaches sockets only in its own short directory, which termination removes', async () => {
  if (process.platform !== 'darwin') return;
  const f = await fixture();
  const handle = await f.run(`const net = require('node:net'), path = require('node:path');
    const directory = process.env.XDG_RUNTIME_DIR, file = path.join(directory, 'daemon.sock');
    const server = net.createServer((socket) => socket.end()).listen(file, () => {
      const client = net.connect(file);
      client.once('connect', () => { require('node:fs').writeFileSync('probe', JSON.stringify({ directory, connected: true })); client.destroy(); server.close(); });
      client.once('error', (e) => { require('node:fs').writeFileSync('probe', JSON.stringify({ directory, connected: e.code })); server.close(); });
    });`);
  assert.equal((await handle.result).exitCode, 0, handle.output().stderr);
  const probe = JSON.parse(await fs.readFile(path.join(f.viewDirectory, 'probe'), 'utf8'));
  assert.equal(probe.connected, true);
  // agent-browser appends /agent-browser/namespaces/devryan/run/<lease>.sock (77 bytes).
  assert.ok(Buffer.byteLength(probe.directory) + 77 <= 103);
  await assert.rejects(fs.lstat(probe.directory), { code: 'ENOENT' });
}, 20_000);

native('metadata writes cannot change the original project through an absolute path', async () => {
  const f = await fixture(), original = path.join(f.root, 'original');
  if (process.platform === 'win32') await createWindowsPrivateFile(launcher, original, Buffer.from('preserved'));
  else await fs.writeFile(original, 'preserved', { mode: 0o600 });
  const before = process.platform === 'win32' ? await readWindowsPrivateFile(launcher, original) : null;
  const ownedMode = process.platform === 'win32' ? 0o400 : 0o755;
  const handle = await f.run(`const fs = require('node:fs');
    fs.writeFileSync('owned', 'private'); fs.chmodSync('owned', ${ownedMode});
    try { fs.chmodSync(${JSON.stringify(original)}, 0o777); process.exit(2); }
    catch (error) { if (!['EPERM', 'EACCES', 'EROFS'].includes(error.code)) throw error; }`);
  assert.equal((await handle.result).exitCode, 0);
  if (process.platform === 'win32') {
    const after = await readWindowsPrivateFile(launcher, original);
    assert.deepEqual(after.identity, before.identity); assert.deepEqual(after.bytes, before.bytes);
    assert.equal((await fs.stat(path.join(f.viewDirectory, 'owned'))).mode & 0o222, 0);
    await fs.chmod(path.join(f.viewDirectory, 'owned'), 0o600); // Allow disposable fixture cleanup.
  } else {
    assert.equal((await fs.stat(original)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.join(f.viewDirectory, 'owned'))).mode & 0o777, 0o755);
  }
}, 20_000);

native('a detached spawn cannot escape execution ownership', async () => {
  const f = await fixture();
  const writer = "const fs = require('node:fs'); fs.writeFileSync('detached-pid', String(process.pid)); fs.writeFileSync('detached-output', 'started'); console.log('ready'); setInterval(() => fs.appendFileSync('detached-output', 'x'), 2)";
  const handle = await f.run(`const { spawn } = require('node:child_process');
    try {
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(writer)}], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    child.on('error', error => { if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) process.exit(2); });
    child.stdout?.once('data', () => { child.stdout.destroy(); child.unref(); });
    } catch (error) { if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) throw error; }`);
  try {
    assert.equal((await handle.result).exitCode, 0, handle.output().stderr);
    // A detached request starts inside the supervised group.
    if (process.platform === 'darwin') assert.match(await fs.readFile(path.join(f.viewDirectory, 'detached-output'), 'utf8'), /^started/);
    const file = path.join(f.viewDirectory, 'detached-output');
    const before = await fs.readFile(file).catch(() => Buffer.alloc(0));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(await fs.readFile(file).catch(() => Buffer.alloc(0)), before);
  } finally {
    // A failing confinement assertion must not leak its deliberately detached fixture.
    const pid = Number(await fs.readFile(path.join(f.viewDirectory, 'detached-pid'), 'utf8').catch(() => ''));
    if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, 'SIGKILL'); } catch { /* already reaped */ } }
  }
}, 20_000);

// A detached child asked for its own group, which the kernel denies. Its
// starter stops it by signalling that group and then waits for the exit
// (Playwright's webServer, bounded test wrappers): a signal that reaches
// nothing leaves the command running until its task deadline.
const groupProbe = `const { spawn } = require('node:child_process'); const fs = require('node:fs');
  const record = (result) => { fs.writeFileSync('probe', JSON.stringify(result)); process.exit(0); };
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  // The server replaces its worker's environment, as a launcher with its own env does.
  const server = "const { spawn } = require('node:child_process');"
    + "const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', env: { PATH: process.env.PATH } });"
    + "require('node:fs').writeFileSync('worker', String(worker.pid)); console.log('listening'); setInterval(() => {}, 1000)";
  const child = process.argv[2] === 'shell'
    ? spawn('sleep 30 & echo listening; exec sleep 30', { shell: true, detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
    : spawn(process.execPath, ['-e', server], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  child.stdout.once('data', () => {
    child.stdout.destroy();
    const worker = Number(fs.readFileSync('worker', 'utf8').trim() || 0) || null;
    let delivered; try { process.kill(-child.pid, 'SIGTERM'); delivered = true; } catch (error) { delivered = error.code; }
    if (delivered !== true) { try { process.kill(child.pid, 'SIGKILL'); } catch {} if (worker) try { process.kill(worker, 'SIGKILL'); } catch {} }
    child.once('exit', (code, signal) => setTimeout(() => {
      let after; try { process.kill(-child.pid, 0); after = 'exists'; } catch (error) { after = error.code; }
      record({ delivered, signal, worker: worker ? alive(worker) : null, after, adapter: Boolean(process.env.DYLD_INSERT_LIBRARIES) });
    }, 100));
  });
  setTimeout(() => record({ timeout: true }), 10000);`;
const groupSignals = async (leader, { adapter = false } = {}) => {
  const f = await fixture({ scope: { sessionID: 'ses_native_groups' } });
  await fs.writeFile(path.join(f.viewDirectory, 'probe.cjs'), groupProbe); await fs.writeFile(path.join(f.viewDirectory, 'worker'), '');
  // Node started by /bin/sh has no adapter; the Node it starts itself has.
  const command = adapter
    ? `exec ${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('node:child_process').spawnSync(process.execPath, ['probe.cjs', ${JSON.stringify(leader)}], { stdio: 'inherit' })`)}`
    : `exec ${JSON.stringify(process.execPath)} probe.cjs ${leader}`;
  const started = Date.now();
  const handle = await f.shell(command);
  assert.equal((await handle.result).exitCode, 0, handle.output().stderr);
  return { ...JSON.parse(await fs.readFile(path.join(f.viewDirectory, 'probe'), 'utf8')), elapsedMs: Date.now() - started };
};
native('a detached group can be signalled by the process that started it, and the command ends', async () => {
  if (process.platform !== 'darwin') return;
  const saved = process.env.DEVRYAN_WORKER_GROUP_SIGNALS;
  try {
    delete process.env.DEVRYAN_WORKER_GROUP_SIGNALS;
    // Through the Node preload: a Node leader whose worker has a replaced
    // environment, then a shell leader (macOS hides its environment).
    assert.deepEqual({ ...await groupSignals('node'), elapsedMs: 0 }, { delivered: true, signal: 'SIGTERM', worker: false, after: 'ESRCH', adapter: true, elapsedMs: 0 });
    const shell = await groupSignals('shell');
    assert.deepEqual([shell.delivered, shell.signal, shell.after], [true, 'SIGTERM', 'ESRCH']);
    assert.ok(shell.elapsedMs < 8_000, `the command ended after ${shell.elapsedMs} ms`);
    // Through the spawn adapter, for a process that has it.
    const adapted = await groupSignals('shell', { adapter: true });
    assert.deepEqual([adapted.delivered, adapted.signal, adapted.after], [true, 'SIGTERM', 'ESRCH']);
    // Kill switch: the kernel's answer, as before.
    process.env.DEVRYAN_WORKER_GROUP_SIGNALS = '0';
    const disabled = await groupSignals('node');
    assert.equal(disabled.delivered, 'ESRCH');
  } finally { if (saved === undefined) delete process.env.DEVRYAN_WORKER_GROUP_SIGNALS; else process.env.DEVRYAN_WORKER_GROUP_SIGNALS = saved; }
}, 90_000);

native('the launcher signals only well-formed groups of its own execution', async () => {
  if (process.platform !== 'darwin') return;
  const run = (args) => new Promise((resolve, reject) => {
    const child = spawn(launcher, args, { stdio: 'ignore' });
    child.once('error', reject); child.once('close', resolve);
  });
  // Outside an execution no process carries a group name: nothing is signalled.
  assert.equal(await run(['--signal-group', '0', '0', `n${process.pid}.1`]), 3);
  assert.equal(await run(['--signal-group', '0', '0', String(process.pid)]), 3);
  for (const args of [['--signal-group', '99', '0', 'n1.1'], ['--signal-group', '15', '1', 'n1.1'], ['--signal-group', '15', '0', 'bad name'],
    ['--signal-group', '15', '-4', 'n1.1'], ['--signal-group', 'x', '0', 'n1.1']]) assert.equal(await run(args), 125, args.join(' '));
}, 20_000);

native('Node started through /bin/sh regains the spawn adapter, and its children keep their working directory', async () => {
  if (process.platform !== 'darwin') return;
  const probe = `const { spawnSync } = require('node:child_process'); const fs = require('node:fs');
    fs.mkdirSync('sub', { recursive: true });
    const child = spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify({ cwd: process.cwd(), adapter: Boolean(process.env.DYLD_INSERT_LIBRARIES) }))'], { cwd: 'sub', encoding: 'utf8' });
    fs.writeFileSync('probe', child.stdout || JSON.stringify({ error: child.error?.code, stderr: child.stderr }));`;
  const run = async (scope) => {
    const f = await fixture({ scope });
    await fs.writeFile(path.join(f.viewDirectory, 'probe.cjs'), probe);
    const handle = await f.shell(`exec ${JSON.stringify(process.execPath)} probe.cjs`);
    assert.equal((await handle.result).exitCode, 0, handle.output().stderr);
    return { f, result: JSON.parse(await fs.readFile(path.join(f.viewDirectory, 'probe'), 'utf8')) };
  };
  const scoped = await run({ sessionID: 'ses_native_browser' });
  assert.equal(scoped.result.adapter, true);
  assert.equal(await fs.realpath(scoped.result.cwd), await fs.realpath(path.join(scoped.f.viewDirectory, 'sub')));
}, 30_000);

// An in-place spawn (POSIX_SPAWN_SETEXEC) is execve with spawn attributes. The
// probe checks the replaced image's descriptors, directory and signal state;
// that a failed exec leaves the caller unchanged, so posix_spawnp's next PATH
// entry starts cleanly; and that a slice execve cannot select is refused. The
// expected values are the kernel's own outside the profile, except that the
// kernel answers the foreign slice for this thin probe with EBADARCH.
const inPlaceProbe = String.raw`#define _DARWIN_C_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <mach/machine.h>
#include <pthread.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
extern char **environ;
static void handler(int signal) { (void)signal; }
static int flags(int fd) { return fcntl(fd, F_GETFD); }
static const char *disposition(int signal) {
  struct sigaction current; sigaction(signal, NULL, &current);
  return current.sa_handler == SIG_DFL ? "default" : current.sa_handler == SIG_IGN ? "ignore" : "handler";
}
static int blocked(int signal) { sigset_t mask; pthread_sigmask(SIG_SETMASK, NULL, &mask); return sigismember(&mask, signal); }
static const char *name(int error) {
  return error == ENOENT ? "ENOENT" : error == EBADF ? "EBADF" : error == ENOTSUP ? "ENOTSUP" : error == EBADARCH ? "EBADARCH" : error ? "other" : "none";
}
#define STATE "\"fds\":[%d,%d,%d,%d,%d],\"usr1\":%d,\"usr2\":%d,\"usr2Action\":\"%s\",\"termAction\":\"%s\""
#define STATE_VALUES flags(10), flags(11), flags(12), flags(13), flags(14), blocked(SIGUSR1), blocked(SIGUSR2), disposition(SIGUSR2), disposition(SIGTERM)
int main(int argc, char **argv) {
  if (argc == 3 && !strcmp(argv[1], "report")) {
    struct stat zero, copy; char cwd[1024];
    int same = !stat("/dev/zero", &zero) && !fstat(13, &copy) && copy.st_rdev == zero.st_rdev;
    printf("{\"samePid\":%s,\"dupIsZero\":%s,\"cwd\":\"%s\"," STATE "}\n", atoi(argv[2]) == getpid() ? "true" : "false",
      same ? "true" : "false", getcwd(cwd, sizeof(cwd)) ? strrchr(cwd, '/') + 1 : "?", STATE_VALUES);
    return 0;
  }
  if (argc != 3 || strcmp(argv[1], "start")) return 2;
  /* The caller: 10, 11 (/dev/zero), 12 and 14 inheritable, SIGUSR1 blocked,
   * SIGUSR2 ignored, SIGTERM caught; 3 is not open. */
  int null = open("/dev/null", O_RDONLY), zero = open("/dev/zero", O_RDONLY);
  if (null < 0 || zero < 0 || dup2(null, 10) < 0 || dup2(zero, 11) < 0 || dup2(null, 12) < 0 || dup2(null, 14) < 0) return 2;
  close(null); close(zero);
  sigset_t caller; sigemptyset(&caller); sigaddset(&caller, SIGUSR1); pthread_sigmask(SIG_SETMASK, &caller, NULL);
  signal(SIGUSR2, SIG_IGN); signal(SIGTERM, handler);
  struct stat before, after; stat(".", &before);
  /* The image keeps 0-2, 12 and 13 (a copy of 11) and runs in sub/ with only
   * SIGUSR2 blocked and reset to its default action. */
  posix_spawn_file_actions_t actions; posix_spawn_file_actions_init(&actions);
  for (int fd = 0; fd < 3; fd++) posix_spawn_file_actions_addinherit_np(&actions, fd);
  posix_spawn_file_actions_adddup2(&actions, 11, 13); posix_spawn_file_actions_addclose(&actions, 11);
  posix_spawn_file_actions_addclose(&actions, 10); posix_spawn_file_actions_addinherit_np(&actions, 12);
  posix_spawn_file_actions_addchdir_np(&actions, "sub");
  posix_spawnattr_t attributes; posix_spawnattr_init(&attributes);
  sigset_t mask; sigemptyset(&mask); sigaddset(&mask, SIGUSR2);
  posix_spawnattr_setsigmask(&attributes, &mask); posix_spawnattr_setsigdefault(&attributes, &mask);
#if defined(__arm64__)
  cpu_type_t native = CPU_TYPE_ARM64, foreign = CPU_TYPE_X86_64;
#else
  cpu_type_t native = CPU_TYPE_X86_64, foreign = CPU_TYPE_ARM64;
#endif
  size_t copied; posix_spawnattr_setbinpref_np(&attributes, 1, &native, &copied);
  posix_spawnattr_setflags(&attributes, POSIX_SPAWN_SETEXEC | POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF);
  char pid[32], self[2048], path[2048]; snprintf(pid, sizeof(pid), "%d", (int)getpid());
  snprintf(self, sizeof(self), "%s/probe", argv[2]); snprintf(path, sizeof(path), "/nonexistent-devryan:%s", argv[2]);
  char *next[] = { "probe", "report", pid, NULL };
  int missing = posix_spawn(NULL, "/nonexistent-devryan/probe", &actions, &attributes, next, environ);
  /* The adapter's own records never stand in for a descriptor the caller lacks. */
  posix_spawn_file_actions_t unopened; posix_spawn_file_actions_init(&unopened);
  posix_spawn_file_actions_addchdir_np(&unopened, "sub"); posix_spawn_file_actions_adddup2(&unopened, 3, 15);
  int lacking = posix_spawn(NULL, "/nonexistent-devryan/probe", &unopened, &attributes, next, environ);
  stat(".", &after);
  posix_spawnattr_t other; posix_spawnattr_init(&other);
  posix_spawnattr_setbinpref_np(&other, 1, &foreign, &copied); posix_spawnattr_setflags(&other, POSIX_SPAWN_SETEXEC);
  int refused = posix_spawn(NULL, self, NULL, &other, next, environ);
  printf("{\"missing\":\"%s\",\"unopened\":\"%s\",\"foreign\":\"%s\",\"cwd\":\"%s\"," STATE "}\n", name(missing), name(lacking), name(refused),
    before.st_ino == after.st_ino && before.st_dev == after.st_dev ? "same" : "changed", STATE_VALUES);
  fflush(stdout);
  setenv("PATH", path, 1);
  printf("{\"returned\":\"%s\"}\n", name(posix_spawnp(NULL, "probe", &actions, &attributes, next, environ)));
  return 3;
}
`;
native('an in-place spawn replaces the caller with its attributes and file actions, and a failed one changes nothing', async (t) => {
  if (process.platform !== 'darwin') { t.skip('macOS spawn adapter only'); return; }
  const build = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-in-place-')); roots.push(build);
  const bin = path.join(build, 'bin'), source = path.join(build, 'probe.c');
  await fs.mkdir(bin); await fs.writeFile(source, inPlaceProbe);
  await promisify(execFile)(process.env.CC || 'cc', ['-std=c11', '-O2', source, '-o', path.join(bin, 'probe')], { timeout: 60_000 });
  for (const readOnly of [true, false]) {
    const f = await fixture({ readOnly });
    await fs.mkdir(path.join(f.viewDirectory, 'sub'));
    const handle = await f.exec(path.join(bin, 'probe'), ['start', bin]);
    assert.equal((await handle.result).exitCode, 0, handle.output().stdout + handle.output().stderr);
    assert.deepEqual(handle.output().stdout.trim().split('\n').map((line) => JSON.parse(line)), [
      { missing: 'ENOENT', unopened: 'EBADF', foreign: 'ENOTSUP', cwd: 'same', fds: [0, 0, 0, -1, 0], usr1: 1, usr2: 0, usr2Action: 'ignore', termAction: 'handler' },
      { samePid: true, dupIsZero: true, cwd: 'sub', fds: [-1, -1, 0, 0, -1], usr1: 0, usr2: 1, usr2Action: 'default', termAction: 'default' },
    ], readOnly ? 'Plan profile' : 'implementation profile');
  }
}, 60_000);

// Xcode's python3 is a stub that re-executes its framework's Python in place,
// preferring its own architecture. Xcode's pip3 script names /usr/bin/xcrun as
// its interpreter, a platform binary the adapter never loads into, and exits 71
// like every xcrun call, so pip is checked as the module that script runs.
const selectedXcodePython = async () => {
  if (process.platform !== 'darwin') return null;
  const developer = await promisify(execFile)('/usr/bin/xcode-select', ['-p'], { timeout: 10_000 })
    .then(({ stdout }) => stdout.trim(), () => null);
  if (!developer || !path.isAbsolute(developer)) return null;
  const present = (file) => fs.access(file).then(() => true, () => false);
  const python = path.join(developer, 'usr', 'bin', 'python3');
  return await present(path.join(developer, 'usr', 'bin', 'xcodebuild')) && await present(python) ? python : null;
};
native("Xcode's python3 and its pip run inside the Plan and implementation profiles", async (t) => {
  const python = await selectedXcodePython();
  if (!python) { t.skip('no full Xcode with python3 is selected'); return; }
  for (const readOnly of [true, false]) {
    for (const [args, expected] of [[['--version'], /^Python 3\.\d+\.\d+$/], [['-m', 'pip', '--version'], /^pip \S+ from \S.* \(python 3\.\d+\)$/]]) {
      const handle = await (await fixture({ readOnly })).exec(python, args);
      const label = `${readOnly ? 'Plan' : 'implementation'} profile: ${python} ${args.join(' ')}`;
      assert.equal((await handle.result).exitCode, 0, `${label}: ${handle.output().stderr}`);
      assert.match(handle.output().stdout.trim(), expected, label);
    }
  }
}, 60_000);

// Headless Chromium under the confined profile, launched the way Playwright
// does (detached Node spawn with a CDP pipe on fds 3/4) through /bin/sh. It
// needs an installed Playwright headless shell and is skipped without one.
const headlessShell = async () => {
  const roots_ = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')].filter(Boolean);
  for (const base of roots_) {
    const versions = (await fs.readdir(base).catch(() => [])).filter((name) => name.startsWith('chromium_headless_shell-')).sort().reverse();
    for (const version of versions) {
      const binary = path.join(base, version, `chrome-headless-shell-mac-${process.arch === 'arm64' ? 'arm64' : 'x64'}`, 'chrome-headless-shell');
      if (await fs.access(binary).then(() => true, () => false)) return binary;
    }
  }
  return null;
};
native('headless Chromium launches, speaks CDP and renders text inside the confined profile', async (t) => {
  if (process.platform !== 'darwin') { t.skip('macOS profile only'); return; }
  const binary = await headlessShell();
  if (!binary) { t.skip('no Playwright chromium_headless_shell is installed'); return; }
  const f = await fixture({ scope: { sessionID: 'ses_native_chromium' } });
  await fs.writeFile(path.join(f.viewDirectory, 'probe.cjs'), `const { spawn, spawnSync } = require('node:child_process');
    const crypto = require('node:crypto'), fs = require('node:fs'), path = require('node:path');
    const binary = ${JSON.stringify(binary)}, scratch = process.env.TMPDIR;
    const common = ['--headless', '--no-sandbox', '--enable-unsafe-swiftshader', '--no-first-run', '--disable-breakpad', '--hide-scrollbars'];
    const shots = {};
    for (const text of ['AAAA', 'BBBB']) {
      const file = path.join(scratch, text + '.png');
      spawnSync(binary, [...common, '--user-data-dir=' + path.join(scratch, 'shot-' + text), '--window-size=400,160', '--screenshot=' + file,
        'data:text/html,<p style="font:80px Helvetica;margin:20px">' + text + '</p>'], { timeout: 30000 });
      shots[text] = fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
    }
    const child = spawn(binary, [...common, '--user-data-dir=' + path.join(scratch, 'pipe'), '--remote-debugging-pipe', 'about:blank'],
      { detached: true, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
    let stderr = '', reply = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const done = (result) => { fs.writeFileSync('probe', JSON.stringify({ ...result, shots, stderr: stderr.slice(-400) })); try { child.kill('SIGKILL'); } catch {} process.exit(0); };
    child.on('error', (error) => done({ error: error.code }));
    child.stdio[4].on('data', (chunk) => { reply += chunk; if (reply.includes('\\u0000')) done({ reply: reply.split('\\u0000')[0] }); });
    child.stdio[3].write(JSON.stringify({ id: 1, method: 'Browser.getVersion' }) + '\\u0000');
    setTimeout(() => done({ timeout: true }), 30000);`);
  const handle = await f.shell(`exec ${JSON.stringify(process.execPath)} probe.cjs`);
  assert.equal((await handle.result).exitCode, 0, handle.output().stderr);
  const probe = JSON.parse(await fs.readFile(path.join(f.viewDirectory, 'probe'), 'utf8'));
  assert.ok(probe.reply, JSON.stringify(probe));
  assert.match(JSON.parse(probe.reply).result.product, /HeadlessChrome/);
  assert.ok(probe.shots.AAAA && probe.shots.BBBB, JSON.stringify(probe));
  assert.notEqual(probe.shots.AAAA, probe.shots.BBBB);
}, 90_000);

native('cancellation acknowledges only after the command and its children stop', async () => {
  const f = await fixture();
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  const handle = await startSessionExecution({ launcher, lease: f.lease, command: process.execPath,
    args: ['-e', "console.log('ready'); setInterval(() => {}, 1000)"], env: { PATH: process.env.PATH },
    onOutput: ({ stream, data }) => { if (stream === 'stdout' && data.toString().includes('ready')) ready(); } });
  await started; handle.cancel();
  assert.equal((await handle.result).cancelled, true);
}, 20_000);

native('a real command held open across Revert publishes only its surviving contribution', async (t) => {
  const f = await fixture(); await git(f.viewDirectory, ['init', '--quiet']);
  const directory = f.viewDirectory;
  const file = path.join(directory, 'x'); await fs.writeFile(file, 'a=1; b=2');
  const windowsOwner = process.platform === 'win32' ? createWindowsPrivateFileOwner({ launcher }) : undefined;
  const authorities = { windowsOwner, windowsLauncher: process.platform === 'win32' ? launcher : undefined };
  const runtime = createSessionMutationRuntime({ directory: path.join(f.root, 'ledger'), ...authorities });
  const owner = createSessionExecutionOwner({ runtime, launcher, verifyLauncher: async () => true,
    stopSessions: async ({ sessions }) => ({ terminated: true, sessions }) });
  const scope = (id) => ({ directory, sessionID: id, userMessageID: `p${id}`, messageID: `m${id}`, callID: `c${id}`,
    command: process.execPath, env: { PATH: process.env.PATH } });
  await owner.execute({ ...scope('a'), args: ['-e', "require('node:fs').writeFileSync('x', 'a=3; b=2')"] });
  let ready; const started = new Promise((resolve) => { ready = resolve; });
  const bHandle = await owner.start({ ...scope('b'), signal: t.signal, interactive: true, args: ['-e', `const fs = require('node:fs');
    const base = fs.readFileSync('x', 'utf8'); console.log('ready');
    process.stdin.once('data', () => { fs.writeFileSync('x', base.replace('b=2', 'b=4')); process.stdin.destroy(); });`],
  onOutput: ({ data }) => { if (data.toString().includes('ready')) ready(); } });
  const b = bHandle.result;
  try {
    await Promise.race([started, b.then(() => { throw new Error('Writer exited before readiness'); })]);
    let session = { id: 'a', directory };
    const coordinator = createSessionRevertCoordinator({ runtime, executions: owner, directory: path.join(f.root, 'coordinator'), ...authorities,
      conversation: { capabilities: async () => ({ conversationOnlyRevert: 1 }), get: async () => session,
        revert: async ({ messageID, files }) => { session = { ...session, revert: { messageID, fileRestore: files !== false } }; return session; },
        unrevert: async () => { session = { ...session, revert: undefined }; return session; } } });
    await coordinator.revert({ directory, sessionID: 'a', messageID: 'pa' });
    assert.equal(await fs.readFile(file, 'utf8'), 'a=1; b=2');
    bHandle.child.stdin.end('go'); await b;
    assert.equal(await fs.readFile(file, 'utf8'), 'a=1; b=4');
  } finally {
    await owner.cancelAndWait({ directory, sessions: ['b'] });
    await b.catch(() => {});
  }
}, 60_000);
