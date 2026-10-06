import { afterEach, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { executionSocketDirectory, NODE_SPAWN_PRELOAD, ownedPrivateDirectory, prepareSessionExecution, removeExecutionSocketDirectory,
  sessionExecutionProfile, windowsSessionExecutionProfile, parseWindowsExecutionProcessIdentity, readSessionExecutionReceipt, sweepExecutionSocketDirectories, sweepSessionTemporaryDirectories, verifySessionExecutionLauncher } from './session-execution.js';

const roots = [], leases = [];
test('Windows cancellation identity refuses recycled or widened process observations', () => {
  const value = { protocol: 'devryan.windows-process-identity/1', pid: 12, startIdentity: 'win32:0123456789abcdef', active: true, inJob: true };
  expect(parseWindowsExecutionProcessIdentity(JSON.stringify(value), 12)).toEqual(value);
  for (const change of [{ pid: 13 }, { startIdentity: '12' }, { active: 'true' }, { extra: true }]) {
    expect(() => parseWindowsExecutionProcessIdentity(JSON.stringify({ ...value, ...change }), 12)).toThrow('mutation_termination_unconfirmed');
  }
});
afterEach(async () => {
  for (const lease of leases.splice(0)) await removeExecutionSocketDirectory(lease);
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
const prepareTracked = (root, viewDirectory) => {
  const lease = { viewDirectory }; leases.push(lease);
  return prepareSessionExecution({ launcher: path.join(root, 'launcher'), lease });
};

test('termination receipt refuses linked, widened and malformed evidence through a held file', async () => {
  if (process.platform === 'win32') return; // Native ACL/handle cases run in the Windows SDK inventory.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-receipt-')); roots.push(root);
  const lease = { viewDirectory: path.join(root, 'view') }, file = path.join(root, 'termination.json');
  const valid = { terminated: true, confined: true, cancelled: false, exitCode: 0 };
  await fs.writeFile(file, JSON.stringify(valid), { mode: 0o600 });
  expect(await readSessionExecutionReceipt(lease)).toEqual(valid);
  for (const changed of [{ terminated: false }, { exitCode: -1 }, { exitCode: 0x100000000 }, { extra: 'unreviewed' }]) {
    await fs.writeFile(file, JSON.stringify({ ...valid, ...changed }));
    await expect(readSessionExecutionReceipt(lease)).rejects.toMatchObject({ code: 'mutation_termination_unconfirmed' });
  }
  await fs.writeFile(file, JSON.stringify(valid)); await fs.chmod(file, 0o644);
  await expect(readSessionExecutionReceipt(lease)).rejects.toMatchObject({ code: 'mutation_termination_unconfirmed' });
  await fs.chmod(file, 0o600); await fs.link(file, path.join(root, 'linked'));
  await expect(readSessionExecutionReceipt(lease)).rejects.toMatchObject({ code: 'mutation_termination_unconfirmed' });
  await fs.unlink(file); await fs.symlink(path.join(root, 'linked'), file);
  await expect(readSessionExecutionReceipt(lease)).rejects.toBeDefined();
});

test('Windows policy binds canonical roots without widening the writable scope over its runtime', () => {
  const roots = { viewDirectory: 'C:\\Private-Δ\\one\\worktree', scratchDirectory: 'C:\\Private-Δ\\one\\scratch', auxiliaryDirectory: 'C:\\Private-Δ\\cache' };
  const bytes = windowsSessionExecutionProfile(roots);
  expect(bytes.toString('utf16le').split('\0')).toEqual(['DevRyan-Windows-LPAC-1', ...Object.values(roots), '']);
  for (const update of [{ auxiliaryDirectory: 'C:\\Private-Δ' }, { auxiliaryDirectory: 'C:\\Private-Δ\\one' },
    { scratchDirectory: 'C:\\Private-Δ\\one' }, { viewDirectory: 'C:\\Private-Δ\\one\\..\\worktree' },
    { auxiliaryDirectory: '\\\\server\\share' }, { viewDirectory: 'relative' }, { auxiliaryDirectory: 'C:\\bad\npath' }]) {
    expect(() => windowsSessionExecutionProfile({ ...roots, ...update })).toThrow('invalid_execution_path');
  }
});

test('all confined workers use their scratch home and temporary paths, including QA-preloaded providers', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-execution-home-')); roots.push(root);
  const viewDirectory = path.join(root, 'view'); await fs.mkdir(viewDirectory);
  const prepared = await prepareTracked(root, viewDirectory);
  expect(prepared.environment).toMatchObject({ DEVRYAN_EXECUTION_WORKER: '1', HOME: prepared.scratchDirectory,
    TMPDIR: prepared.scratchDirectory, TMP: prepared.scratchDirectory, TEMP: prepared.scratchDirectory,
    TMPPREFIX: path.join(prepared.scratchDirectory, 'zsh') });
});

test('each session gets one durable temporary directory in the execution cache that survives its calls', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-execution-session-tmp-')); roots.push(root);
  const auxiliaryDirectory = path.join(root, 'context-cache');
  const prepare = async (token, sessionID) => {
    const viewDirectory = path.join(root, token, 'worktree'); await fs.mkdir(viewDirectory, { recursive: true });
    const lease = { token, viewDirectory, auxiliaryDirectory, scope: { sessionID } }; leases.push(lease);
    return prepareSessionExecution({ launcher: path.join(root, 'launcher'), lease });
  };
  const first = await prepare('one', 'ses_a');
  const directory = first.environment.DEVRYAN_SESSION_TMP;
  expect(path.relative(await fs.realpath(auxiliaryDirectory), directory)).toMatch(/^session-tmp\/[0-9a-f]{16}$/);
  await fs.writeFile(path.join(directory, 'server.log'), 'kept');
  expect((await prepare('two', 'ses_a')).environment.DEVRYAN_SESSION_TMP).toBe(directory);
  expect(await fs.readFile(path.join(directory, 'server.log'), 'utf8')).toBe('kept');
  expect((await prepare('three', 'ses_b')).environment.DEVRYAN_SESSION_TMP).not.toBe(directory);
  // A worker may replace its directory (or the root) with a link; it is never followed.
  const host = path.join(root, 'host'); await fs.mkdir(host);
  await fs.rm(directory, { recursive: true }); await fs.symlink(host, directory);
  expect((await prepare('four', 'ses_a')).environment.DEVRYAN_SESSION_TMP).toBe(directory);
  expect((await fs.lstat(directory)).isDirectory()).toBe(true);
  await fs.rm(path.dirname(directory), { recursive: true }); await fs.symlink(host, path.dirname(directory));
  await prepare('five', 'ses_a');
  expect((await fs.lstat(path.dirname(directory))).isDirectory()).toBe(true);
  expect(await fs.readdir(host)).toEqual([]);
  // Calls without a session scope (provider transports) get none.
  const plain = await prepareTracked(root, path.join(root, 'one', 'worktree'));
  expect('DEVRYAN_SESSION_TMP' in plain.environment).toBe(false);
});

test('the session temporary sweep removes only idle hash-named directories', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-execution-session-sweep-')); roots.push(root);
  const base = path.join(root, 'session-tmp');
  for (const name of ['0123456789abcdef', 'fedcba9876543210', 'keep-me', 'aaaaaaaaaaaaaaaa']) await fs.mkdir(path.join(base, name), { recursive: true });
  const old = new Date(Date.now() - 8 * 24 * 60 * 60_000);
  for (const name of ['0123456789abcdef', 'keep-me', 'aaaaaaaaaaaaaaaa']) await fs.utimes(path.join(base, name), old, old);
  expect(await sweepSessionTemporaryDirectories({ auxiliaryDirectory: root, keep: path.join(base, 'aaaaaaaaaaaaaaaa') })).toBe(1);
  expect((await fs.readdir(base)).sort()).toEqual(['aaaaaaaaaaaaaaaa', 'fedcba9876543210', 'keep-me']);
  expect(await sweepSessionTemporaryDirectories({ auxiliaryDirectory: path.join(root, 'absent') })).toBe(0);
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

darwinTest('session-scoped workers get the host browser cache, the Node spawn preload, group signals and one Chromium lookup', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-execution-browsers-')); roots.push(root);
  const saved = { HOME: process.env.HOME, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
    NODE_OPTIONS: process.env.NODE_OPTIONS, DEVRYAN_WORKER_BROWSERS: process.env.DEVRYAN_WORKER_BROWSERS,
    DEVRYAN_WORKER_GROUP_SIGNALS: process.env.DEVRYAN_WORKER_GROUP_SIGNALS };
  const home = path.join(root, 'home'), cache = path.join(home, 'Library', 'Caches', 'ms-playwright');
  await fs.mkdir(cache, { recursive: true });
  const launcher = path.join(root, 'launcher');
  let index = 0;
  const prepare = async (scope = { sessionID: 'ses_browser' }) => {
    const viewDirectory = path.join(root, `call-${index += 1}`, 'worktree'); await fs.mkdir(viewDirectory, { recursive: true });
    const lease = { token: `t${index}`, viewDirectory, ...(scope ? { scope } : {}) }; leases.push(lease);
    const prepared = await prepareSessionExecution({ launcher, lease });
    return { prepared, profile: await fs.readFile(prepared.profile, 'utf8') };
  };
  const machRules = (profile) => profile.split('\n').filter((line) => line.includes('mach-lookup'));
  try {
    process.env.HOME = home;
    delete process.env.PLAYWRIGHT_BROWSERS_PATH; delete process.env.DEVRYAN_WORKER_BROWSERS; delete process.env.DEVRYAN_WORKER_GROUP_SIGNALS;
    process.env.NODE_OPTIONS = '--max-old-space-size=4096';

    const { prepared, profile } = await prepare();
    const preload = path.join(prepared.scratchDirectory, NODE_SPAWN_PRELOAD);
    expect(prepared.environment.PLAYWRIGHT_BROWSERS_PATH).toBe(await fs.realpath(cache));
    expect(prepared.environment.NODE_OPTIONS).toBe(`--require ${JSON.stringify(preload)} --max-old-space-size=4096`);
    expect((await fs.stat(preload)).mode & 0o777).toBe(0o600);
    const source = await fs.readFile(preload, 'utf8');
    expect(source).toContain(JSON.stringify(`${launcher}-spawn.dylib`));
    // A detached child's group is named, and signalled through the launcher.
    expect(source).toContain(`const launcher = ${JSON.stringify(launcher)}`);
    expect(source).toContain("'--signal-group'");
    expect('DEVRYAN_WORKER_GROUP_SIGNALS' in prepared.environment).toBe(false);
    expect(machRules(profile)).toEqual([
      '(deny mach-lookup)',
      '(allow mach-lookup (global-name-regex #"^org\\.chromium\\.Chromium\\.MachPortRendezvousServer\\.[0-9]+$"))',
    ]);

    process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/browsers';
    expect((await prepare()).prepared.environment.PLAYWRIGHT_BROWSERS_PATH).toBe('/opt/browsers');
    delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    await fs.rm(cache, { recursive: true });
    const missing = await prepare();
    expect('PLAYWRIGHT_BROWSERS_PATH' in missing.prepared.environment).toBe(false);
    expect(missing.prepared.environment.NODE_OPTIONS).toContain(NODE_SPAWN_PRELOAD);

    // Provider transports and title calls have no session scope.
    const unscoped = await prepare(null);
    expect('NODE_OPTIONS' in unscoped.prepared.environment).toBe(false);
    expect(machRules(unscoped.profile)).toEqual(['(deny mach-lookup)']);

    // Without browsers the preload still delivers group signals, and only those.
    process.env.DEVRYAN_WORKER_BROWSERS = '0';
    const groupsOnly = await prepare();
    expect('PLAYWRIGHT_BROWSERS_PATH' in groupsOnly.prepared.environment).toBe(false);
    expect(machRules(groupsOnly.profile)).toEqual(['(deny mach-lookup)']);
    const groupsSource = await fs.readFile(path.join(groupsOnly.prepared.scratchDirectory, NODE_SPAWN_PRELOAD), 'utf8');
    expect(groupsSource).toContain("'--signal-group'");
    expect(groupsSource).not.toContain('DYLD_INSERT_LIBRARIES');

    process.env.DEVRYAN_WORKER_BROWSERS = '1'; process.env.DEVRYAN_WORKER_GROUP_SIGNALS = '0';
    const browsersOnly = await prepare();
    expect(await fs.readFile(path.join(browsersOnly.prepared.scratchDirectory, NODE_SPAWN_PRELOAD), 'utf8')).not.toContain('--signal-group');
    // The spawn adapter reads the same switch inside the worker.
    expect(browsersOnly.prepared.environment.DEVRYAN_WORKER_GROUP_SIGNALS).toBe('0');

    process.env.DEVRYAN_WORKER_BROWSERS = '0';
    const disabled = await prepare();
    expect('NODE_OPTIONS' in disabled.prepared.environment).toBe(false);
    expect('PLAYWRIGHT_BROWSERS_PATH' in disabled.prepared.environment).toBe(false);
    expect(machRules(disabled.profile)).toEqual(['(deny mach-lookup)']);
    await expect(fs.lstat(path.join(disabled.prepared.scratchDirectory, NODE_SPAWN_PRELOAD))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
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

test('explicit lease-local socket policy survives restart and rejects forged cleanup paths', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(process.env.TMPDIR, 'native-private-socket-'))); roots.push(root);
  const viewDirectory = path.join(root, 'worktree'); await fs.mkdir(viewDirectory, { mode: 0o700 });
  const lease = { viewDirectory }, socketDirectory = path.join(root, 'scratch', 's');
  const prepared = await prepareSessionExecution({ launcher: path.join(root, 'launcher'), lease, socketDirectory, workerBrowsers: false });
  expect(prepared.socketDirectory).toBe(socketDirectory);
  expect(await fs.readFile(prepared.profile, 'utf8')).toContain(`(remote unix-socket (subpath ${JSON.stringify(socketDirectory)}))`);
  expect(JSON.parse(await fs.readFile(path.join(root, 'no-execution-socket.json'), 'utf8'))).toEqual({ version: 1, directory: socketDirectory });
  await fs.writeFile(path.join(socketDirectory, 'owned-daemon-state'), 'owned');
  await removeExecutionSocketDirectory(lease); // No constructor option survives a restart.
  expect(await fs.lstat(socketDirectory).catch(error => error.code)).toBe('ENOENT');
  await removeExecutionSocketDirectory(lease); // Lost cleanup ACK is idempotent.
  const outside = await fs.realpath(await fs.mkdtemp(path.join(process.env.TMPDIR, 'foreign-socket-'))); roots.push(outside);
  await fs.writeFile(path.join(outside, 'preserve'), 'foreign');
  const policy = path.join(root, 'no-execution-socket.json');
  await fs.writeFile(policy, JSON.stringify({ version: 1, directory: outside }));
  await expect(removeExecutionSocketDirectory(lease)).rejects.toMatchObject({ code: 'invalid_execution_path' });
  expect(await fs.readFile(path.join(outside, 'preserve'), 'utf8')).toBe('foreign');
  await fs.symlink(outside, socketDirectory);
  await fs.writeFile(policy, JSON.stringify({ version: 1, directory: socketDirectory }));
  await expect(removeExecutionSocketDirectory(lease)).rejects.toMatchObject({ code: 'invalid_execution_path' });
  expect(await fs.readFile(path.join(outside, 'preserve'), 'utf8')).toBe('foreign');
  await expect(prepareSessionExecution({ launcher: path.join(root, 'launcher'), lease, socketDirectory: outside, workerBrowsers: false }))
    .rejects.toMatchObject({ code: 'invalid_execution_path' });
});
