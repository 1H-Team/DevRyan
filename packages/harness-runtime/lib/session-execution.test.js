import { afterEach, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { executionSocketDirectory, ownedPrivateDirectory, prepareSessionExecution, removeExecutionSocketDirectory,
  sessionExecutionProfile, sweepExecutionSocketDirectories, verifySessionExecutionLauncher } from './session-execution.js';

const roots = [], leases = [];
afterEach(async () => {
  await Promise.all(leases.splice(0).map((lease) => removeExecutionSocketDirectory(lease)));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
const prepareTracked = (root, viewDirectory) => {
  const lease = { viewDirectory }; leases.push(lease);
  return prepareSessionExecution({ launcher: path.join(root, 'launcher'), lease });
};

test('all confined workers use their scratch home and temporary paths, including QA-preloaded providers', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-execution-home-')); roots.push(root);
  const viewDirectory = path.join(root, 'view'); await fs.mkdir(viewDirectory);
  const prepared = await prepareTracked(root, viewDirectory);
  expect(prepared.environment).toMatchObject({ DEVRYAN_EXECUTION_WORKER: '1', HOME: prepared.scratchDirectory,
    TMPDIR: prepared.scratchDirectory, TMP: prepared.scratchDirectory, TEMP: prepared.scratchDirectory,
    TMPPREFIX: path.join(prepared.scratchDirectory, 'zsh') });
});

test('confined workers skip per-call language-server downloads unless the kill switch restores them', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-execution-lsp-')); roots.push(root);
  const viewDirectory = path.join(root, 'view'); await fs.mkdir(viewDirectory);
  const previous = process.env.DEVRYAN_WORKER_LSP_DOWNLOAD;
  try {
    delete process.env.DEVRYAN_WORKER_LSP_DOWNLOAD;
    const prepared = await prepareTracked(root, viewDirectory);
    expect(prepared.environment.OPENCODE_DISABLE_LSP_DOWNLOAD).toBe('true');
    process.env.DEVRYAN_WORKER_LSP_DOWNLOAD = '1';
    const restored = await prepareTracked(root, viewDirectory);
    expect('OPENCODE_DISABLE_LSP_DOWNLOAD' in restored.environment).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.DEVRYAN_WORKER_LSP_DOWNLOAD;
    else process.env.DEVRYAN_WORKER_LSP_DOWNLOAD = previous;
  }
});

test('an intact artifact without native acceptance cannot attest complete confinement', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-execution-manifest-')); roots.push(root);
  const launcher = path.join(root, 'DevRyan-execution-linux');
  const bytes = Buffer.from('fixture binary'); await fs.writeFile(launcher, bytes);
  await fs.writeFile(`${launcher}.json`, JSON.stringify({ version: 1, policy: 2, acceptance: false, platform: 'linux', arch: process.arch,
    binary: path.basename(launcher), sha256: createHash('sha256').update(bytes).digest('hex') }));
  expect(await verifySessionExecutionLauncher({ launcher, platform: 'linux' })).toBe(false);
});

test('native artifact verification rejects changed bytes and unsupported policy versions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-execution-manifest-')); roots.push(root);
  const launcher = path.join(root, 'DevRyan-execution-darwin');
  const bytes = Buffer.from('fixture binary'); await fs.writeFile(launcher, bytes);
  const manifest = { version: 1, policy: 2, acceptance: true, platform: 'darwin', arch: process.arch,
    binary: path.basename(launcher), sha256: createHash('sha256').update(bytes).digest('hex'),
    spawnLibrary: `${path.basename(launcher)}-spawn.dylib`, spawnSha256: createHash('sha256').update(bytes).digest('hex') };
  await fs.writeFile(`${launcher}-spawn.dylib`, bytes);
  await fs.writeFile(`${launcher}.json`, JSON.stringify(manifest));
  expect(await verifySessionExecutionLauncher({ launcher, platform: 'darwin' })).toBe(true);
  await fs.appendFile(launcher, 'changed');
  expect(await verifySessionExecutionLauncher({ launcher, platform: 'darwin' })).toBe(false);
  await fs.writeFile(launcher, bytes);
  await fs.writeFile(`${launcher}.json`, JSON.stringify({ ...manifest, policy: 3 }));
  expect(await verifySessionExecutionLauncher({ launcher, platform: 'darwin' })).toBe(false);
});

test('launcher verification is cached by file identity and invalidated by any replacement', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-execution-cache-')); roots.push(root);
  const launcher = path.join(root, 'DevRyan-execution-darwin');
  const bytes = Buffer.from('fixture binary'); await fs.writeFile(launcher, bytes);
  const manifest = { version: 1, policy: 2, acceptance: true, platform: 'darwin', arch: process.arch,
    binary: path.basename(launcher), sha256: createHash('sha256').update(bytes).digest('hex'),
    spawnLibrary: `${path.basename(launcher)}-spawn.dylib`, spawnSha256: createHash('sha256').update(bytes).digest('hex') };
  await fs.writeFile(`${launcher}-spawn.dylib`, bytes);
  await fs.writeFile(`${launcher}.json`, JSON.stringify(manifest));
  expect(await verifySessionExecutionLauncher({ launcher, platform: 'darwin' })).toBe(true);
  const reads = spyOn(fs, 'readFile');
  try {
    expect(await verifySessionExecutionLauncher({ launcher, platform: 'darwin' })).toBe(true);
    expect(reads).not.toHaveBeenCalled();
    // Same bytes written again still changes the identity and forces a re-hash.
    await fs.writeFile(`${launcher}-spawn.dylib`, Buffer.from('replaced library'));
    expect(await verifySessionExecutionLauncher({ launcher, platform: 'darwin' })).toBe(false);
    await fs.writeFile(`${launcher}-spawn.dylib`, bytes);
    expect(await verifySessionExecutionLauncher({ launcher, platform: 'darwin' })).toBe(true);
    expect(reads).toHaveBeenCalled();
  } finally { reads.mockRestore(); }
});

test('a symlinked launcher artifact is always re-hashed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-execution-link-')); roots.push(root);
  const launcher = path.join(root, 'DevRyan-execution-darwin');
  const bytes = Buffer.from('fixture binary'); await fs.writeFile(launcher, bytes);
  const target = path.join(root, 'real-spawn.dylib'); await fs.writeFile(target, bytes);
  await fs.symlink(target, `${launcher}-spawn.dylib`);
  await fs.writeFile(`${launcher}.json`, JSON.stringify({ version: 1, policy: 2, acceptance: true, platform: 'darwin', arch: process.arch,
    binary: path.basename(launcher), sha256: createHash('sha256').update(bytes).digest('hex'),
    spawnLibrary: `${path.basename(launcher)}-spawn.dylib`, spawnSha256: createHash('sha256').update(bytes).digest('hex') }));
  expect(await verifySessionExecutionLauncher({ launcher, platform: 'darwin' })).toBe(true);
  await fs.writeFile(target, Buffer.from('rewritten target'));
  expect(await verifySessionExecutionLauncher({ launcher, platform: 'darwin' })).toBe(false);
});

const darwinTest = test.skipIf(process.platform !== 'darwin');
// Unix socket paths must fit in 104 bytes, so socket fixtures live in short
// /private/tmp directories rather than os.tmpdir().
const shortRoot = async () => { const root = await fs.mkdtemp('/private/tmp/drx-'); roots.push(root); return root; };

darwinTest('each execution gets a short private socket directory that cleanup removes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-execution-socket-')); roots.push(root);
  const viewDirectory = path.join(root, 'view'); await fs.mkdir(viewDirectory);
  const lease = { viewDirectory };
  try {
    const prepared = await prepareSessionExecution({ launcher: path.join(root, 'launcher'), lease });
    const directory = executionSocketDirectory(lease);
    const runtimeDirectory = prepared.environment.XDG_RUNTIME_DIR;
    expect(runtimeDirectory).toBe(directory.replace(/^\/private\/tmp\//, '/tmp/'));
    expect(await fs.realpath(runtimeDirectory)).toBe(directory);
    // agent-browser adds /agent-browser/namespaces/devryan/run/<34-char lease>.sock (77 bytes).
    expect(Buffer.byteLength(runtimeDirectory) + 77).toBeLessThanOrEqual(103);
    const stat = await fs.lstat(directory);
    expect(stat.isDirectory() && (stat.mode & 0o777) === 0o700 && stat.uid === process.getuid()).toBe(true);
    expect(await fs.readFile(prepared.profile, 'utf8')).toContain(`(remote unix-socket (subpath ${JSON.stringify(directory)}))`);
    expect(executionSocketDirectory({ token: 'a', viewDirectory })).not.toBe(executionSocketDirectory({ token: 'b', viewDirectory }));
  } finally { await removeExecutionSocketDirectory(lease); }
  expect(await fs.lstat(executionSocketDirectory(lease)).catch((cause) => cause.code)).toBe('ENOENT');
});

darwinTest('socket directories fail closed unless privately owned', async () => {
  const root = await shortRoot();
  await fs.mkdir(path.join(root, 'open'), { mode: 0o755 }); await fs.chmod(path.join(root, 'open'), 0o755);
  await expect(ownedPrivateDirectory(path.join(root, 'open'))).rejects.toMatchObject({ code: 'invalid_execution_path' });
  await fs.mkdir(path.join(root, 'target'), { mode: 0o700 }); await fs.symlink(path.join(root, 'target'), path.join(root, 'link'));
  await expect(ownedPrivateDirectory(path.join(root, 'link'))).rejects.toMatchObject({ code: 'invalid_execution_path' });
  await expect(ownedPrivateDirectory(path.join(root, 'fresh'))).resolves.toBeUndefined();
});

darwinTest('the profile reaches only sockets in its own directory and writes nowhere else in /private/tmp', async () => {
  const root = await shortRoot();
  const [viewDirectory, scratchDirectory, socketDirectory, host] = ['v', 's', 'k', 'h'].map((name) => path.join(root, name));
  for (const directory of [viewDirectory, scratchDirectory, socketDirectory, host]) await fs.mkdir(directory, { mode: 0o700 });
  const net = await import('node:net');
  // A host-side socket stands in for any local daemon (Docker, ssh-agent).
  const hostSocket = path.join(host, 'daemon.sock');
  const server = net.createServer((socket) => socket.end('reached')).listen(hostSocket);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const profile = sessionExecutionProfile({ viewDirectory, scratchDirectory, socketDirectory });
    const script = `const net = require('node:net');
      const probe = (target) => new Promise((resolve) => { const s = net.connect(target);
        s.once('connect', () => { s.destroy(); resolve('connected'); }); s.once('error', (e) => resolve(e.code)); });
      const own = net.createServer((s) => s.end()).listen(${JSON.stringify(path.join(socketDirectory, 'own.sock'))}, async () => {
        const result = { own: await probe(${JSON.stringify(path.join(socketDirectory, 'own.sock'))}), host: await probe(${JSON.stringify(hostSocket)}),
          resolver: await probe('/private/var/run/mDNSResponder') };
        try { require('node:fs').writeFileSync(${JSON.stringify(path.join(host, 'escape'))}, 'x'); result.write = 'allowed'; }
        catch (e) { result.write = e.code; }
        console.log(JSON.stringify(result)); own.close();
      });`;
    const run = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, '-e', script], { cwd: viewDirectory, encoding: 'utf8' });
    expect(run.status).toBe(0);
    const result = JSON.parse(run.stdout.trim());
    expect(result.own).toBe('connected');
    expect(result.resolver).toBe('connected');
    expect(result.host).not.toBe('connected');
    expect(result.write).not.toBe('allowed');
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

darwinTest('the sweep removes only stale hash-named socket directories', async () => {
  const root = await shortRoot();
  for (const name of ['0123abcd', 'fedc9876', 'not-a-lease']) await fs.mkdir(path.join(root, name));
  const old = new Date(Date.now() - 48 * 60 * 60_000);
  await fs.utimes(path.join(root, '0123abcd'), old, old); await fs.utimes(path.join(root, 'not-a-lease'), old, old);
  expect(await sweepExecutionSocketDirectories({ root })).toBe(1);
  expect((await fs.readdir(root)).sort()).toEqual(['fedc9876', 'not-a-lease']);
});
