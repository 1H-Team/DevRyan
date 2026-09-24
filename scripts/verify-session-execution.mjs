import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readSessionExecutionReceipt, sessionExecutionProfile, startSessionExecution } from '../packages/harness-runtime/lib/session-execution.js';
import { createSessionMutationRuntime } from '../packages/harness-runtime/lib/session-mutations.js';
import { createSessionExecutionOwner } from '../packages/harness-runtime/lib/session-execution-owner.js';
import { createSessionRevertCoordinator } from '../packages/harness-runtime/lib/session-revert-coordinator.js';
import { git } from '../packages/harness-runtime/lib/session-changes-git.js';
import { spawnConfinedProvider } from '../packages/web/server/lib/opencode/session-provider-spawn.js';
import { fileURLToPath } from 'node:url';

const launcher = process.env.DEVRYAN_TEST_EXECUTION_LAUNCHER;
if (!launcher) throw new Error('Set DEVRYAN_TEST_EXECUTION_LAUNCHER to the built native helper');
const native = (name, body, timeout) => test(name, { timeout }, body);
const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-execution-')); roots.push(root);
  const canonical = await fs.realpath(root), viewDirectory = path.join(canonical, 'worktree');
  await fs.mkdir(viewDirectory);
  return { root: canonical, viewDirectory, lease: { viewDirectory }, run: async (source, signal) => {
    let stdout = '', stderr = '';
    const handle = await startSessionExecution({ launcher, lease: { viewDirectory }, command: process.execPath,
      args: ['-e', source], env: { PATH: process.env.PATH }, signal,
      onOutput: ({ stream, data }) => { if (stream === 'stdout') stdout += data; else stderr += data; } });
    return { ...handle, output: () => ({ stdout, stderr }) };
  } };
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
  const descriptor = await fs.open(original, 'r+');
  const scratchDirectory = path.join(f.root, 'scratch'); await fs.mkdir(scratchDirectory);
  const profile = path.join(f.root, 'profile.sb');
  await fs.writeFile(profile, sessionExecutionProfile({ viewDirectory: f.viewDirectory, scratchDirectory }));
  try {
    const child = spawn(launcher, [f.viewDirectory, scratchDirectory, profile, path.join(f.root, 'termination.json'), '--',
      process.execPath, '-e', "const fs = require('node:fs'); try { fs.writeSync(3, Buffer.from('overwrite')); } catch {} fs.writeFileSync('ran', 'yes')"],
    { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe', descriptor.fd] });
    child.stdout.resume(); child.stderr.resume();
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, 0); assert.equal((await readSessionExecutionReceipt(f.lease)).terminated, true);
    assert.equal(await fs.readFile(path.join(f.viewDirectory, 'ran'), 'utf8'), 'yes');
    assert.equal(await fs.readFile(original, 'utf8'), 'preserved');
  } finally { await descriptor.close(); }
}, 20_000);

native('name resolution is reachable while other local unix sockets stay denied', async () => {
  const f = await fixture();
  const net = await import('node:net');
  // A host-side socket stands in for any local daemon (Docker, ssh-agent).
  const socketPath = path.join(f.root, 'daemon.sock');
  const server = net.createServer((socket) => socket.end('reached')).listen(socketPath);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const probe = (target) => `new Promise((resolve) => { const s = require('node:net').connect(${JSON.stringify(target)});
      s.once('connect', () => { s.destroy(); resolve('connected'); }); s.once('error', (e) => resolve(e.code)); })`;
    const handle = await f.run(`Promise.all([${probe('/private/var/run/mDNSResponder')}, ${probe(socketPath)}])
      .then(([resolver, daemon]) => require('node:fs').writeFileSync('probe', JSON.stringify({ resolver, daemon })))`);
    assert.equal((await handle.result).exitCode, 0, handle.output().stderr);
    const probe_ = JSON.parse(await fs.readFile(path.join(f.viewDirectory, 'probe'), 'utf8'));
    assert.equal(probe_.resolver, 'connected');
    assert.notEqual(probe_.daemon, 'connected');
  } finally { await new Promise((resolve) => server.close(resolve)); }
}, 20_000);

native('metadata writes cannot change the original project through an absolute path', async () => {
  const f = await fixture(), original = path.join(f.root, 'original');
  await fs.writeFile(original, 'preserved', { mode: 0o600 });
  const handle = await f.run(`const fs = require('node:fs');
    fs.writeFileSync('owned', 'private'); fs.chmodSync('owned', 0o755);
    try { fs.chmodSync(${JSON.stringify(original)}, 0o777); process.exit(2); }
    catch (error) { if (!['EPERM', 'EACCES', 'EROFS'].includes(error.code)) throw error; }`);
  assert.equal((await handle.result).exitCode, 0);
  assert.equal((await fs.stat(original)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.join(f.viewDirectory, 'owned'))).mode & 0o777, 0o755);
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

native('a real command held open across Revert publishes only its surviving contribution', async () => {
  const f = await fixture(); await git(f.viewDirectory, ['init', '--quiet']);
  const directory = f.viewDirectory;
  const file = path.join(directory, 'x'); await fs.writeFile(file, 'a=1; b=2');
  const runtime = createSessionMutationRuntime({ directory: path.join(f.root, 'ledger') });
  const owner = createSessionExecutionOwner({ runtime, launcher, verifyLauncher: async () => true,
    stopSessions: async ({ sessions }) => ({ terminated: true, sessions }) });
  const scope = (id) => ({ directory, sessionID: id, userMessageID: `p${id}`, messageID: `m${id}`, callID: `c${id}`,
    command: process.execPath, env: { PATH: process.env.PATH } });
  await owner.execute({ ...scope('a'), args: ['-e', "require('node:fs').writeFileSync('x', 'a=3; b=2')"] });
  let ready; const started = new Promise((resolve) => { ready = resolve; });
  const release = path.join(f.root, 'release');
  const b = owner.execute({ ...scope('b'), args: ['-e', `const fs = require('node:fs');
    const base = fs.readFileSync('x', 'utf8'); console.log('ready');
    const timer = setInterval(() => { if (!fs.existsSync(${JSON.stringify(release)})) return;
      clearInterval(timer); fs.writeFileSync('x', base.replace('b=2', 'b=4')); }, 10);`],
  onOutput: ({ data }) => { if (data.toString().includes('ready')) ready(); } });
  await started;
  let session = { id: 'a', directory };
  const coordinator = createSessionRevertCoordinator({ runtime, executions: owner, directory: path.join(f.root, 'coordinator'),
    conversation: { capabilities: async () => ({ legacyConversationRevert: 1 }), get: async () => session,
      revert: async ({ messageID, files }) => { session = { ...session, revert: { messageID, fileRestore: files !== false } }; return session; },
      unrevert: async () => { session = { ...session, revert: undefined }; return session; } } });
  await coordinator.revert({ directory, sessionID: 'a', messageID: 'pa' });
  assert.equal(await fs.readFile(file, 'utf8'), 'a=1; b=2');
  await fs.writeFile(release, 'go'); await b;
  assert.equal(await fs.readFile(file, 'utf8'), 'a=1; b=4');
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
      process.stdin.pipe(process.stdout);`], cwd: f.viewDirectory, env: { PATH: process.env.PATH, HOME: f.root } });
    let output = '', stderr = ''; child.stdout.on('data', (chunk) => output += chunk); child.stderr.on('data', (chunk) => stderr += chunk);
    child.stdin.end('transport-ok');
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, 0, stderr); assert.equal(output, 'transport-ok'); assert.equal(await fs.readFile(original, 'utf8'), 'preserved');
  } finally { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}, 20_000);
