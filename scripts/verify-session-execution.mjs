import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { prepareSessionExecution, readSessionExecutionReceipt, removeExecutionSocketDirectory, startSessionExecution } from '../packages/harness-runtime/lib/session-execution.js';
import { createSessionMutationRuntime } from '../packages/harness-runtime/lib/session-mutations.js';
import { createSessionExecutionOwner } from '../packages/harness-runtime/lib/session-execution-owner.js';
import { createSessionRevertCoordinator } from '../packages/harness-runtime/lib/session-revert-coordinator.js';
import { git } from '../packages/harness-runtime/lib/session-changes-git.js';
import { spawnConfinedProvider } from '../packages/web/server/lib/opencode/session-provider-spawn.js';
import { fileURLToPath } from 'node:url';
import { createWindowsPrivateFile, createWindowsPrivateFileOwner, ensureWindowsPrivateDirectory, readWindowsPrivateFile } from '../packages/harness-runtime/lib/windows-private-files.js';
import { randomUUID } from 'node:crypto';

const launcher = process.env.DEVRYAN_TEST_EXECUTION_LAUNCHER;
if (!launcher) throw new Error('Set DEVRYAN_TEST_EXECUTION_LAUNCHER to the built native helper');
const native = (name, body, timeout) => test(name, { timeout }, body);
const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
async function fixture({ scope } = {}) {
  const root = process.platform === 'win32' ? path.join(os.tmpdir(), `devryan-execution-${randomUUID()}`)
    : await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-execution-'));
  if (process.platform === 'win32') await ensureWindowsPrivateDirectory(launcher, root);
  roots.push(root);
  const canonical = await fs.realpath(root), viewDirectory = path.join(canonical, 'worktree');
  if (process.platform === 'win32') await ensureWindowsPrivateDirectory(launcher, viewDirectory);
  else await fs.mkdir(viewDirectory);
  const lease = { viewDirectory, ...(scope ? { scope } : {}) };
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
    shell: (script, signal) => start('/bin/sh', ['-c', script], signal) };
}

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

native('the provider transport streams through native confinement and cannot mutate its logical project', async () => {
  const f = await fixture(), original = path.join(f.root, 'original'); await fs.writeFile(original, 'preserved');
  // Bootstrap only this disposable candidate for the public adapter's identity
  // check. The build's real manifest stays disabled until all probes pass.
  const candidate = path.join(f.root, path.basename(launcher));
  const manifest = JSON.parse(await fs.readFile(`${launcher}.json`, 'utf8'));
  await fs.copyFile(launcher, candidate); await fs.chmod(candidate, 0o755);
  if (manifest.spawnLibrary) await fs.copyFile(path.join(path.dirname(launcher), manifest.spawnLibrary), path.join(f.root, manifest.spawnLibrary));
  await fs.writeFile(`${candidate}.json`, JSON.stringify({ ...manifest, acceptance: true }));
  const saved = Object.fromEntries(['DEVRYAN_PROVIDER_WORKER', 'DEVRYAN_EXECUTION_LAUNCHER', 'DEVRYAN_PROVIDER_STORAGE'].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { DEVRYAN_PROVIDER_WORKER: fileURLToPath(new URL('../packages/web/server/lib/opencode/session-provider-worker.mjs', import.meta.url)),
    DEVRYAN_EXECUTION_LAUNCHER: candidate, DEVRYAN_PROVIDER_STORAGE: path.join(f.root, 'providers') });
  try {
    const child = spawnConfinedProvider({ command: process.execPath, args: ['-e', `const fs=require('node:fs');
      try { fs.writeFileSync(${JSON.stringify(original)}, 'lost'); process.exit(2); }
      catch (error) { if (!['EPERM','EACCES','EROFS'].includes(error.code)) throw error; }
      try { fs.writeFileSync('in-project', 'lost'); process.exit(3); }
      catch (error) { if (!['EPERM','EACCES','EROFS'].includes(error.code)) throw error; }
      if (process.platform === 'darwin' && fs.realpathSync(process.cwd()) !== ${JSON.stringify(await fs.realpath(f.viewDirectory))}) process.exit(4);
      if (process.env.CLAUDE_CODE_OAUTH_TOKEN !== 'devryan-fixture-token') process.exit(5);
      process.stdin.pipe(process.stdout);`], cwd: f.viewDirectory,
      // A caller-supplied token keeps the worker off the real keychain login.
      env: { PATH: process.env.PATH, HOME: f.root, CLAUDE_CODE_OAUTH_TOKEN: 'devryan-fixture-token' } });
    let output = '', stderr = ''; child.stdout.on('data', (chunk) => output += chunk); child.stderr.on('data', (chunk) => stderr += chunk);
    child.stdin.end('transport-ok');
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, 0, stderr); assert.equal(output, 'transport-ok'); assert.equal(await fs.readFile(original, 'utf8'), 'preserved');
  } finally { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}, 20_000);
