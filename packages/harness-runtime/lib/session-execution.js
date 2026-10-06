import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileAtomic } from './atomic-file.js';
import { writableInputDirectories } from './execution-inputs.js';
import { ensureWindowsPrivateDirectory, createWindowsPrivateFile, readWindowsPrivateFile } from './windows-private-files.js';

const error = (code) => Object.assign(new Error(code), { code, status: 409 });

/** @returns {{ protocol: 'devryan.windows-process-identity/1', pid: number,
 * startIdentity: string, active: boolean, inJob: boolean }} */
export function parseWindowsExecutionProcessIdentity(raw, pid) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 4096) throw error('mutation_termination_unconfirmed');
  let value;
  try { value = JSON.parse(raw); } catch { throw error('mutation_termination_unconfirmed'); }
  if (!value || Object.keys(value).sort().join(',') !== 'active,inJob,pid,protocol,startIdentity'
    || value.protocol !== 'devryan.windows-process-identity/1' || value.pid !== pid
    || !Number.isSafeInteger(pid) || pid < 1 || pid > 0xffffffff
    || typeof value.startIdentity !== 'string' || !/^win32:[a-f0-9]{16}$/.test(value.startIdentity)
    || typeof value.active !== 'boolean' || typeof value.inJob !== 'boolean') throw error('mutation_termination_unconfirmed');
  return value;
}
const sbString = (value) => {
  if (typeof value !== 'string' || /[\u0000-\u001f]/.test(value)) throw error('invalid_execution_path');
  return JSON.stringify(value);
};

// Verified launcher identities keyed by the exact file identities hashed.
// Any rewrite, rename-over, chmod or replacement changes ino/ctime and forces
// a full re-hash; only successful verifications are remembered.
const verifiedLaunchers = new Map();
// Only regular files are cached: a symlink's own identity does not change
// when its target is rewritten, so linked artifacts are always re-hashed.
const fileIdentity = async (file) => {
  const stat = await fs.lstat(file, { bigint: true });
  if (!stat.isFile()) return null;
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].join(':');
};
const identityOf = async (files) => {
  const identities = await Promise.all(files.map(fileIdentity));
  return identities.includes(null) ? null : identities.join('|');
};

export async function verifySessionExecutionLauncher({ launcher, platform = process.platform }) {
  if (!['darwin', 'linux', 'win32'].includes(platform) || !path.isAbsolute(launcher ?? '')) return false;
  const cacheKey = `${platform}\0${process.arch}\0${launcher}`;
  try {
    const spawnLibrary = platform === 'darwin' ? path.join(path.dirname(launcher), `${path.basename(launcher)}-spawn.dylib`) : null;
    const artifacts = [launcher, `${launcher}.json`, ...(spawnLibrary ? [spawnLibrary] : [])];
    const identity = await identityOf(artifacts);
    if (identity && verifiedLaunchers.get(cacheKey) === identity) return true;
    verifiedLaunchers.delete(cacheKey);
    const manifest = JSON.parse(await fs.readFile(`${launcher}.json`, 'utf8'));
    const stat = await fs.lstat(launcher);
    if (!stat.isFile() || stat.size > 1024 * 1024 || manifest.version !== 1 || manifest.policy !== (platform === 'win32' ? 3 : 2) || manifest.acceptance !== true
      || manifest.platform !== platform || manifest.arch !== process.arch || manifest.binary !== path.basename(launcher)) return false;
    if (platform === 'darwin') {
      if (manifest.spawnLibrary !== `${path.basename(launcher)}-spawn.dylib`) return false;
      if (createHash('sha256').update(await fs.readFile(path.join(path.dirname(launcher), manifest.spawnLibrary))).digest('hex') !== manifest.spawnSha256) return false;
    }
    if (createHash('sha256').update(await fs.readFile(launcher)).digest('hex') !== manifest.sha256) return false;
    // Re-read identities after hashing: a concurrent replacement is not cached.
    if (identity && await identityOf(artifacts) === identity) {
      verifiedLaunchers.set(cacheKey, identity);
      while (verifiedLaunchers.size > 8) verifiedLaunchers.delete(verifiedLaunchers.keys().next().value);
    }
    return true;
  } catch { verifiedLaunchers.delete(cacheKey); return false; }
}

const validateDeniedReadDirectories = (directories) => {
  if (!Array.isArray(directories) || directories.length > 32 || directories.some(directory =>
    typeof directory !== 'string' || !path.isAbsolute(directory) || /[\u0000-\u001f]/.test(directory))) throw error('invalid_execution_path');
};

export function windowsSessionExecutionProfile({ viewDirectory, scratchDirectory, auxiliaryDirectory }) {
  const roots = [viewDirectory, scratchDirectory, auxiliaryDirectory];
  for (const directory of roots) {
    if (typeof directory !== 'string' || !/^[A-Za-z]:\\/.test(directory)
      || path.win32.resolve(directory) !== directory || /[\u0000-\u001f]/.test(directory)) throw error('invalid_execution_path');
  }
  const root = path.win32.dirname(viewDirectory);
  const cacheRelative = path.win32.relative(auxiliaryDirectory, root);
  if (scratchDirectory !== path.win32.join(root, 'scratch')
    || cacheRelative === '' || cacheRelative !== '..' && !cacheRelative.startsWith('..\\') && !path.win32.isAbsolute(cacheRelative)) {
    throw error('invalid_execution_path');
  }
  const bytes = Buffer.from(['DevRyan-Windows-LPAC-1', ...roots, ''].join('\0'), 'utf16le');
  if (bytes.length > 65536) throw error('invalid_execution_path');
  return bytes;
}

export function sessionExecutionProfile({ viewDirectory, scratchDirectory, auxiliaryDirectory, socketDirectory, writableDirectories = [], deniedReadDirectories = [], chromiumRendezvous = false }) {
  validateDeniedReadDirectories(deniedReadDirectories);
  const writeThrough = writableDirectories.map((directory) => `(require-not (subpath ${sbString(directory)}))`).join(' ');
  return `(version 1)
(allow default)
${deniedReadDirectories.map(directory => `(deny file-read* (subpath ${sbString(directory)}))\n`).join('')}(deny file-write* (require-all (require-not (subpath ${sbString(viewDirectory)})) (require-not (subpath ${sbString(scratchDirectory)})) ${auxiliaryDirectory ? `(require-not (subpath ${sbString(auxiliaryDirectory)}))` : ''} ${socketDirectory ? `(require-not (subpath ${sbString(socketDirectory)}))` : ''} ${writeThrough} (require-not (literal "/dev/null"))))
(deny mach-lookup)
${chromiumRendezvous ? `; Headless Chromium's helpers fetch their IPC ports from the browser process
; that launched them; its rendezvous server hands ports only to its own
; children. This is the one mach service a confined process may look up.
(allow mach-lookup (global-name-regex #"^org\\.chromium\\.Chromium\\.MachPortRendezvousServer\\.[0-9]+$"))
` : ''}(deny network-outbound (remote unix-socket))
; TCP stays available, so name resolution must too: the system resolver socket
; is the only local daemon a confined process may reach (no other mach services).
(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))
${socketDirectory ? `; Sockets this execution's own processes create (for example the agent-browser
; daemon) live in its private short directory; no host daemon can be reached there.
(allow network-outbound (remote unix-socket (subpath ${sbString(socketDirectory)})))
` : ''}(deny process-info-setcontrol)
(deny signal)
(allow signal (target same-sandbox))
(deny process-info*)
(allow process-info* (target same-sandbox))
(deny mach-priv-task-port)
(allow mach-priv-task-port (target same-sandbox))
(deny ipc-posix-shm*)
(deny syscall-unix (syscall-number 82) (syscall-number 147))
; posix_spawn attributes can change process groups inside the kernel. ENOSYS
; lets libuv and other runtimes fall back to fork/exec under the same policy.
(deny syscall-unix (with errno 78) (syscall-number 244))
`;
}

export async function readSessionExecutionReceipt(lease, { launcher } = {}) {
  const file = path.join(path.dirname(lease.viewDirectory), 'termination.json');
  let bytes;
  if (process.platform === 'win32') {
    if (!launcher) throw error('mutation_termination_unconfirmed');
    bytes = (await readWindowsPrivateFile(launcher, file)).bytes;
  } else {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > 1024) {
        throw error('mutation_termination_unconfirmed');
      }
      const buffer = Buffer.alloc(1025), read = await handle.read(buffer, 0, buffer.length, 0);
      const after = await handle.stat(), named = await fs.lstat(file);
      if (read.bytesRead !== stat.size || !named.isFile() || stat.dev !== named.dev || stat.ino !== named.ino
        || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs || after.nlink !== 1) {
        throw error('mutation_termination_unconfirmed');
      }
      bytes = buffer.subarray(0, read.bytesRead);
    } finally { await handle.close(); }
  }
  if (bytes.length > 1024) throw error('mutation_termination_unconfirmed');
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw error('mutation_termination_unconfirmed'); }
  if (!value || Object.keys(value).sort().join(',') !== 'cancelled,confined,exitCode,terminated' || value.terminated !== true
    || typeof value.confined !== 'boolean' || !Number.isInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 0xffffffff
    || typeof value.cancelled !== 'boolean') {
    throw error('mutation_termination_unconfirmed');
  }
  return value;
}

// macOS caps Unix socket paths at 104 bytes and a private view's scratch path
// alone exceeds that, so each execution gets a short private runtime directory
// for sockets its own processes create, exported as XDG_RUNTIME_DIR. The
// agent-browser daemon appends /agent-browser/namespaces/devryan/run/ and a
// 34-character lease session (77 bytes), so the directory is spelled through
// /tmp (os.tmpdir() is itself too long) and must stay within 26 bytes. The
// profile matches the resolved /private/tmp path. Keyed by the lease, so
// cleanup needs no stored state.
export const executionSocketRoot = () => path.join('/private/tmp', `dr-${process.getuid()}`);
export function executionSocketDirectory(lease, platform = process.platform) {
  if (platform !== 'darwin') return null;
  const identity = lease.token ?? path.resolve(path.dirname(lease.viewDirectory));
  return path.join(executionSocketRoot(), createHash('sha256').update(identity).digest('hex').slice(0, 8));
}
const shortSocketSpelling = (directory) => directory.replace(/^\/private\/tmp\//, '/tmp/');

// /private/tmp is shared: a directory another user created, a symlink or a
// widened mode would let a different principal observe or plant sockets.
export const ownedPrivateDirectory = async (directory) => {
  try { await fs.mkdir(directory, { mode: 0o700 }); }
  catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) throw error('invalid_execution_path');
};

async function prepareExecutionSocketDirectory(lease, requested) {
  // Explicit null is the repository-local/native-test mode: no shared /tmp
  // directory is created or later removed.
  if (requested === null) return null;
  if (requested !== undefined && (!path.isAbsolute(requested) || requested.includes('\0'))) throw error('invalid_execution_path');
  const directory = requested ?? executionSocketDirectory(lease);
  if (!directory) return null;
  if (requested !== undefined) await validateOwnedSocketPath(lease, directory, false);
  await ownedPrivateDirectory(path.dirname(directory));
  await ownedPrivateDirectory(directory);
  if (requested !== undefined) await validateOwnedSocketPath(lease, directory, true);
  return directory;
}

const validateOwnedSocketPath = async (lease, directory, exists) => {
  if (!path.isAbsolute(lease?.viewDirectory ?? '') || !path.isAbsolute(directory ?? '') || directory.includes('\0')) throw error('invalid_execution_path');
  const root = await fs.realpath(path.dirname(lease.viewDirectory));
  if (directory !== path.resolve(directory) || !directory.startsWith(`${root}${path.sep}`)) throw error('invalid_execution_path');
  if (!exists) {
    if (await fs.realpath(path.dirname(directory)) !== path.dirname(directory)) throw error('invalid_execution_path');
    return;
  }
  const stat = await fs.lstat(directory).catch(cause => { if (cause.code === 'ENOENT') return null; throw cause; });
  if (!stat) return;
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700 || await fs.realpath(directory) !== directory) throw error('invalid_execution_path');
};

export async function removeExecutionSocketDirectory(lease, socketDirectory = undefined) {
  if (socketDirectory === undefined && path.isAbsolute(lease?.viewDirectory ?? '')) {
    const policy = path.join(path.dirname(lease.viewDirectory), 'no-execution-socket.json');
    const stat = await fs.lstat(policy).catch(cause => { if (cause.code === 'ENOENT') return null; throw cause; });
    if (stat) {
      if (!stat.isFile() || stat.size > 4096) throw error('invalid_execution_socket_policy');
      const value = JSON.parse(await fs.readFile(policy, 'utf8'));
      if (value.version !== 1) throw error('invalid_execution_socket_policy');
      if (value.disabled === true && Object.keys(value).every(key => ['version', 'disabled'].includes(key))) return;
      if (typeof value.directory !== 'string' || Object.keys(value).some(key => !['version', 'directory'].includes(key))) throw error('invalid_execution_socket_policy');
      await validateOwnedSocketPath(lease, value.directory, true);
      await fs.rm(value.directory, { recursive: true, force: true });
      return;
    }
  }
  const directory = socketDirectory === undefined ? executionSocketDirectory(lease) : socketDirectory;
  if (directory) {
    if (socketDirectory !== undefined && directory !== executionSocketDirectory(lease)) await validateOwnedSocketPath(lease, directory, true);
    await fs.rm(directory, { recursive: true, force: true });
  }
}

/** Best effort: removes socket directories a crashed host never cleaned. Only
 * this user's hash-named directories older than the bound are touched. */
export async function sweepExecutionSocketDirectories({ root = executionSocketRoot(), olderThanMs = 24 * 60 * 60_000, now = Date.now(), platform = process.platform } = {}) {
  if (platform !== 'darwin') return 0;
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch (cause) { if (cause.code === 'ENOENT') return 0; throw cause; }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9a-f]{8}$/.test(entry.name)) continue;
    const directory = path.join(root, entry.name);
    const stat = await fs.lstat(directory).catch(() => null);
    if (!stat?.isDirectory() || stat.uid !== process.getuid() || now - stat.mtimeMs < olderThanMs) continue;
    await fs.rm(directory, { recursive: true, force: true }); removed += 1;
  }
  return removed;
}

// A ledger view is <storage>/<project>/views/<token>/worktree. No write-through
// grant may overlap the ledger storage; other layouts protect their own root.
const ledgerStorageOf = (viewDirectory) => {
  const views = path.dirname(path.dirname(viewDirectory));
  return path.basename(views) === 'views' ? path.dirname(path.dirname(views)) : path.dirname(viewDirectory);
};

export async function prepareSessionExecution({ launcher, lease, socketDirectory: requestedSocketDirectory, workerBrowsers = true, deniedReadDirectories = [] }) {
  if (!['darwin', 'linux', 'win32'].includes(process.platform)) throw error('mutation_platform_unsupported');
  if (!path.isAbsolute(launcher ?? '')) throw error('mutation_runtime_unsupported');
  validateDeniedReadDirectories(deniedReadDirectories);
  if (deniedReadDirectories.length && !['darwin', 'win32'].includes(process.platform)) throw error('mutation_platform_unsupported');
  const deniedRoots = await Promise.all(deniedReadDirectories.map(async directory => {
    const resolved = await fs.realpath(directory);
    if (!(await fs.stat(resolved)).isDirectory()) throw error('invalid_execution_path');
    return resolved;
  }));
  const viewDirectory = await fs.realpath(lease.viewDirectory);
  const root = path.dirname(viewDirectory), scratchDirectory = path.join(root, 'scratch');
  const workingDirectory = await fs.realpath(lease.workingDirectory ?? viewDirectory);
  const relative = path.relative(viewDirectory, workingDirectory);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw error('invalid_execution_path');
  if (process.platform === 'win32') await ensureWindowsPrivateDirectory(launcher, scratchDirectory);
  else await fs.mkdir(scratchDirectory, { recursive: true, mode: 0o700 });
  // Ledger/restart cleanup receives only the durable lease, not this call's
  // constructor options. Persist explicit no-socket selection in its owned
  // parent so that cleanup never probes the legacy global socket directory.
  const noSocketPolicy = path.join(root, 'no-execution-socket.json');
  if (requestedSocketDirectory === null) await writeFileAtomic(noSocketPolicy, JSON.stringify({ version: 1, disabled: true }));
  else await fs.rm(noSocketPolicy, { force: true });
  // Seatbelt matches resolved paths; dependency overlays link caches here.
  const requestedAuxiliary = lease.auxiliaryDirectory ? path.resolve(lease.auxiliaryDirectory) : scratchDirectory;
  if (process.platform === 'win32') await ensureWindowsPrivateDirectory(launcher, requestedAuxiliary);
  else await fs.mkdir(requestedAuxiliary, { recursive: true, mode: 0o700 });
  const auxiliaryDirectory = await fs.realpath(requestedAuxiliary);
  // Session-scoped tool calls on macOS may launch headless Chromium (a
  // project's Playwright check); provider transports never can.
  const sessionScoped = process.platform === 'darwin' && typeof lease.scope?.sessionID === 'string' && lease.scope.sessionID.length > 0;
  const browsers = sessionScoped && workerBrowsers && workerBrowsersEnabled();
  // A detached child's group can be signalled (see native/session-group-darwin.h).
  const groupSignals = sessionScoped && workerGroupSignalsEnabled();
  if (process.platform === 'darwin') {
    const shellEnvironment = `export DYLD_INSERT_LIBRARIES=${'\'' + `${launcher}-spawn.dylib`.replaceAll('\'', '\'\\\'\'') + '\''}\n`;
    await fs.writeFile(path.join(scratchDirectory, '.zshenv'), shellEnvironment, { mode: 0o600 });
    await fs.writeFile(path.join(scratchDirectory, '.bash-env'), shellEnvironment, { mode: 0o600 });
  }
  const nodeEnvironment = browsers || groupSignals ? await workerNodeEnvironment({ launcher, scratchDirectory, browsers, groupSignals }) : {};
  const socketDirectory = await prepareExecutionSocketDirectory(lease, requestedSocketDirectory);
  if (requestedSocketDirectory !== undefined && requestedSocketDirectory !== null) {
    await writeFileAtomic(noSocketPolicy, JSON.stringify({ version: 1, directory: socketDirectory }));
  }
  const sessionTemporaryDirectory = await prepareSessionTemporaryDirectory(auxiliaryDirectory, lease, launcher);
  // Only the macOS profile grants write-through; the Linux and Windows
  // launchers are not approved for production and keep inputs read-only.
  const writableDirectories = process.platform === 'darwin' ? await writableInputDirectories({
    inputs: lease.inputs, projectDirectory: lease.projectDirectory,
    protectedDirectories: [ledgerStorageOf(viewDirectory), auxiliaryDirectory],
  }) : [];
  const profile = path.join(root, `sandbox-${randomUUID()}.sb`);
  if (process.platform === 'win32') {
    for (const denied of deniedRoots) for (const granted of [viewDirectory, scratchDirectory, auxiliaryDirectory]) {
      for (const [parent, child] of [[denied, granted], [granted, denied]]) {
        const relative = path.relative(parent, child);
        if (!relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) throw error('invalid_execution_path');
      }
    }
    await createWindowsPrivateFile(launcher, profile, windowsSessionExecutionProfile({ viewDirectory, scratchDirectory, auxiliaryDirectory }));
  } else await writeFileAtomic(profile, sessionExecutionProfile({ viewDirectory, scratchDirectory, auxiliaryDirectory, socketDirectory, writableDirectories,
    deniedReadDirectories: deniedRoots, chromiumRendezvous: browsers }));
  const cancelEvent = `Local\\DevRyan-execution-${randomUUID()}`;
  return { launcher, arguments: [viewDirectory, scratchDirectory, profile, path.join(root, 'termination.json'), '--'],
    cwd: workingDirectory, profile, scratchDirectory, socketDirectory,
    environment: { DEVRYAN_EXECUTION_WORKER: '1', HOME: scratchDirectory,
      ...(process.platform === 'win32' ? { USERPROFILE: scratchDirectory, LOCALAPPDATA: scratchDirectory, APPDATA: scratchDirectory } : {}),
      DEVRYAN_EXECUTION_CWD: lease.logicalWorkingDirectory ?? workingDirectory, DEVRYAN_EXECUTION_CANCEL_EVENT: cancelEvent,
      DEVRYAN_EXECUTION_CACHE: auxiliaryDirectory,
      ...(sessionTemporaryDirectory ? { DEVRYAN_SESSION_TMP: sessionTemporaryDirectory } : {}),
      ...(socketDirectory ? { XDG_RUNTIME_DIR: shortSocketSpelling(socketDirectory) } : {}),
      ...(process.platform === 'darwin' ? { DYLD_INSERT_LIBRARIES: `${launcher}-spawn.dylib`,
        ZDOTDIR: scratchDirectory, BASH_ENV: path.join(scratchDirectory, '.bash-env') } : {}),
      TMPDIR: scratchDirectory, TMP: scratchDirectory, TEMP: scratchDirectory,
      TMPPREFIX: path.join(scratchDirectory, 'zsh'), ...workerLanguageServerEnvironment(), ...nodeEnvironment,
      // The spawn adapter reads the same switch inside the worker.
      ...(process.platform === 'darwin' && !workerGroupSignalsEnabled() ? { DEVRYAN_WORKER_GROUP_SIGNALS: '0' } : {}) } };
}

// Kill switch: DEVRYAN_WORKER_BROWSERS=0 restores the previous worker
// environment and profile exactly.
const workerBrowsersEnabled = () => process.env.DEVRYAN_WORKER_BROWSERS !== '0';
export const NODE_SPAWN_PRELOAD = '.devryan-node-spawn.cjs';

// Playwright resolves browsers from $HOME/Library/Caches/ms-playwright, and a
// worker's HOME is its per-call scratch. Use the host's cache (read and
// execute only; the profile still denies writes to it) when it is a real
// directory this user owns. An explicit host setting is kept as is.
async function hostPlaywrightBrowsers() {
  const configured = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (typeof configured === 'string' && configured) return configured;
  // The host's HOME, as Playwright itself resolves it (Bun's os.homedir() ignores later HOME changes).
  const home = process.env.HOME || os.homedir();
  const cache = await fs.realpath(path.join(home, 'Library', 'Caches', 'ms-playwright')).catch(() => null);
  if (!cache) return null;
  const stat = await fs.stat(cache).catch(() => null);
  return stat?.isDirectory() && stat.uid === process.getuid() ? cache : null;
}

// Kill switch: DEVRYAN_WORKER_GROUP_SIGNALS=0 restores plain kernel group
// signals (a detached child's group does not exist and cannot be signalled).
const workerGroupSignalsEnabled = () => process.env.DEVRYAN_WORKER_GROUP_SIGNALS !== '0';

// Node started through /usr/bin/env or /bin/sh has no spawn adapter, so its
// detached children carry no group name and its process.kill(-pid) asks the
// kernel for a group that cannot exist. Playwright's webServer and bounded test
// wrappers stop their servers that way, then wait forever for the exit. The
// preload names the group of each detached child and delivers a group signal
// through the verified launcher, which runs under the same profile.
const groupSignalPreload = (launcher) => `if (process.env.DEVRYAN_WORKER_GROUP_SIGNALS !== '0') {
  const childProcess = require('node:child_process');
  const signals = require('node:os').constants.signals;
  const launcher = ${JSON.stringify(launcher)}, variable = 'DEVRYAN_SPAWN_GROUP=';
  const groups = new Map();
  let started = 0;
  const spawn = childProcess.ChildProcess && childProcess.ChildProcess.prototype.spawn;
  // Another runtime that reads this preload keeps its own spawn.
  if (typeof spawn === 'function') childProcess.ChildProcess.prototype.spawn = function (options) {
    let group = null;
    if (options && options.detached === true && Array.isArray(options.envPairs)) {
      group = 'n' + process.pid + '.' + (started += 1);
      options.envPairs = options.envPairs.filter((pair) => !String(pair).startsWith(variable));
      options.envPairs.push(variable + group);
    }
    const result = spawn.call(this, options);
    if (group && Number.isInteger(this.pid)) {
      groups.set(this.pid, group);
      if (groups.size > 256) groups.delete(groups.keys().next().value);
    }
    return result;
  };
  const kill = process.kill;
  process.kill = function (pid, signal) {
    const target = Number(pid);
    const number = typeof signal === 'number' ? signal : signal === undefined ? signals.SIGTERM : signals[signal];
    if (Number.isInteger(target) && target < -1 && Number.isInteger(number)) {
      const names = [String(-target)];
      if (groups.has(-target)) names.push(groups.get(-target));
      try {
        const leader = groups.has(-target) ? String(-target) : '0';
        const outcome = childProcess.spawnSync(launcher, ['--signal-group', String(number), leader, ...names], { stdio: 'ignore', timeout: 5000 });
        if (outcome.status === 0) return true;
      } catch { /* The kernel decides. */ }
    }
    return kill.apply(this, arguments);
  };
}
`;

// macOS strips DYLD_* whenever a protected binary runs, and `npm run` passes
// through /usr/bin/env and /bin/sh, so Node started by a script would lose the
// spawn adapter (.zshenv only restores it for zsh and bash). Without it,
// Chromium cannot start its helpers: posix_spawn is denied and it has no
// fork/exec fallback. The preload names the same verified adapter; it adds no
// authority, and without it spawning fails closed as before.
async function workerNodeEnvironment({ launcher, scratchDirectory, browsers, groupSignals }) {
  const preload = path.join(scratchDirectory, NODE_SPAWN_PRELOAD);
  await fs.writeFile(preload, [
    browsers ? `if (!process.env.DYLD_INSERT_LIBRARIES) process.env.DYLD_INSERT_LIBRARIES = ${JSON.stringify(`${launcher}-spawn.dylib`)};\n` : '',
    groupSignals ? groupSignalPreload(launcher) : '',
  ].join(''), { mode: 0o600 });
  const browsersPath = browsers ? await hostPlaywrightBrowsers() : null;
  return {
    NODE_OPTIONS: [`--require ${JSON.stringify(preload)}`, process.env.NODE_OPTIONS].filter(Boolean).join(' '),
    ...(browsersPath ? { PLAYWRIGHT_BROWSERS_PATH: browsersPath } : {}),
  };
}

// TMPDIR is the per-call scratch, removed when the call ends. Logs a later
// call must read (a dev server's output, a reproduction transcript) go to this
// per-session directory inside the execution cache, which every confined call
// may write. Directories idle for a week are swept, at most hourly per project.
export const SESSION_TEMPORARY_ROOT = 'session-tmp';
export const sessionTemporaryDirectory = (auxiliaryDirectory, lease) => {
  const sessionID = lease?.scope?.sessionID;
  if (!auxiliaryDirectory || typeof sessionID !== 'string' || !sessionID) return null;
  return path.join(auxiliaryDirectory, SESSION_TEMPORARY_ROOT, createHash('sha256').update(sessionID).digest('hex').slice(0, 16));
};
const sessionTemporarySweeps = new Map();
async function prepareSessionTemporaryDirectory(auxiliaryDirectory, lease, launcher) {
  const directory = sessionTemporaryDirectory(auxiliaryDirectory, lease);
  if (!directory) return null;
  // Workers may write here, so an earlier call may have replaced either level
  // with a file or a link: never follow one, start the directory over instead.
  for (const level of [path.dirname(directory), directory]) {
    if (process.platform === 'win32') {
      await ensureWindowsPrivateDirectory(launcher, level);
      continue;
    }
    const existing = await fs.lstat(level).catch((cause) => { if (cause.code === 'ENOENT') return null; throw cause; });
    if (existing && !existing.isDirectory()) await fs.rm(level, { recursive: true, force: true });
    await fs.mkdir(level, { recursive: true, mode: 0o700 });
  }
  // Touch: the sweep measures idleness by the directory's own mtime.
  const now = new Date(); await fs.utimes(directory, now, now);
  const lastSweep = sessionTemporarySweeps.get(auxiliaryDirectory) ?? 0;
  if (now.getTime() - lastSweep > 60 * 60_000) {
    sessionTemporarySweeps.set(auxiliaryDirectory, now.getTime());
    while (sessionTemporarySweeps.size > 64) sessionTemporarySweeps.delete(sessionTemporarySweeps.keys().next().value);
    void sweepSessionTemporaryDirectories({ auxiliaryDirectory, keep: directory }).catch(() => {});
  }
  return directory;
}

/** Best effort: removes per-session temporary directories idle past the bound. */
export async function sweepSessionTemporaryDirectories({ auxiliaryDirectory, olderThanMs = 7 * 24 * 60 * 60_000, now = Date.now(), keep = null } = {}) {
  if (!auxiliaryDirectory) return 0;
  const root = path.join(auxiliaryDirectory, SESSION_TEMPORARY_ROOT);
  if (!(await fs.lstat(root).catch(() => null))?.isDirectory()) return 0;
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch (cause) { if (cause.code === 'ENOENT') return 0; throw cause; }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9a-f]{16}$/.test(entry.name)) continue;
    const directory = path.join(root, entry.name);
    if (directory === keep) continue;
    const stat = await fs.lstat(directory).catch(() => null);
    if (!stat?.isDirectory() || now - stat.mtimeMs < olderThanMs) continue;
    await fs.rm(directory, { recursive: true, force: true }); removed += 1;
  }
  return removed;
}

// Every worker has an empty scratch cache. OpenCode's download-backed language
// servers (ESLint fetches and compiles vscode-eslint from GitHub) would then
// rebuild on each edit: 10+ s and unpinned install scripts per call. Servers
// the project already provides and TypeScript diagnostics keep working.
// DEVRYAN_WORKER_LSP_DOWNLOAD=1 restores per-call downloads.
const workerLanguageServerEnvironment = () => process.env.DEVRYAN_WORKER_LSP_DOWNLOAD === '1' ? {}
  : { OPENCODE_DISABLE_LSP_DOWNLOAD: 'true' };

/** Starts only the reviewed native launcher. Commands never inherit host fds
 * or gain write access to the ledger, original project, or dependencies. */
export async function startSessionExecution({ launcher, lease, command, args = [], env = {}, signal, onOutput, input, interactive = false, socketDirectory, workerBrowsers = true, deniedReadDirectories = [] }) {
  if (typeof command !== 'string' || !command || !Array.isArray(args)
    || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) throw error('invalid_execution_command');
  signal?.throwIfAborted();
  const prepared = await prepareSessionExecution({ launcher, lease, socketDirectory, workerBrowsers, deniedReadDirectories });
  if (signal?.aborted) {
    await fs.rm(prepared.profile, { force: true }); await removeExecutionSocketDirectory(lease, prepared.socketDirectory).catch(() => {});
    signal.throwIfAborted();
  }
  const child = spawn(launcher, [...prepared.arguments, command, ...args], {
    cwd: prepared.cwd, env: { ...env, ...prepared.environment },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  const terminate = child.kill.bind(child);
  if (!interactive) child.stdin.end(input);
  const output = (stream) => (data) => { try { onOutput?.({ stream, data }); } catch { /* Output consumers cannot own termination. */ } };
  if (onOutput || !interactive) {
    child.stdout.on('data', output('stdout')); child.stderr.on('data', output('stderr'));
  }
  let cancellationRequested = false;
  // Capture once while this owned ChildProcess is alive. Later cancellation
  // must prove the same native creation identity, even if its PID is reused.
  const supervisorIdentity = process.platform === 'win32' ? new Promise((resolve, reject) => {
    execFile(launcher, ['--inspect-process', String(child.pid)], { timeout: 5000, maxBuffer: 4096, windowsHide: true }, (cause, raw) => {
      if (cause) { reject(error('mutation_termination_unconfirmed')); return; }
      try {
        const identity = parseWindowsExecutionProcessIdentity(raw, child.pid);
        if (!identity.active) throw error('mutation_termination_unconfirmed');
        resolve(identity);
      } catch (cause) { reject(cause); }
    });
  }) : null;
  // A very short command may exit before this read-only probe. Its receipt
  // remains authoritative; failed identity capture can never signal a PID.
  void supervisorIdentity?.catch(() => {});
  const cancel = () => {
    if (cancellationRequested) return;
    cancellationRequested = true;
    if (process.platform !== 'win32') { terminate('SIGTERM'); return; }
    // An early cancellation can race event creation. Retry while this owned
    // supervisor is alive; a forced kill would lose its durable acknowledgement.
    void supervisorIdentity.then(identity => {
      const signalEvent = () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        execFile(launcher, ['--cancel', prepared.environment.DEVRYAN_EXECUTION_CANCEL_EVENT, String(identity.pid), identity.startIdentity],
          { timeout: 1000, windowsHide: true }, (cause) => {
            if (cause && child.exitCode === null && child.signalCode === null) setTimeout(signalEvent, 20).unref();
          });
      };
      signalEvent();
    }).catch(() => {}); // Unknown creation authority keeps settlement held.
  };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const result = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', async (code, signal) => {
      const unconfirmed = () => Object.assign(error('mutation_termination_unconfirmed'), { exitCode: code, signal });
      let value;
      try { value = await readSessionExecutionReceipt(lease, { launcher }); } catch { reject(unconfirmed()); return; }
      if (code !== value.exitCode) {
        reject(unconfirmed()); return;
      }
      resolve(value);
    });
  }).finally(async () => {
    signal?.removeEventListener('abort', cancel);
    await fs.rm(prepared.profile, { force: true });
    await removeExecutionSocketDirectory(lease, prepared.socketDirectory).catch(() => {});
  });
  return { pid: child.pid, child, cancel, result };
}

/** Provider transports and title generation have no file contribution. They
 * still need the same OS boundary: a prompt requesting no tools is not one. */
export async function startReadOnlySessionExecution({ launcher, storage, environment, auxiliaryDirectory, logicalDirectory, ...input }) {
  if (!path.isAbsolute(storage ?? '') || !await verifySessionExecutionLauncher({ launcher })) throw error('mutation_runtime_unsupported');
  await fs.mkdir(storage, { recursive: true, mode: 0o700 });
  const root = await fs.mkdtemp(path.join(await fs.realpath(storage), 'provider-'));
  // A read-only transport may run from its real project directory: the profile
  // still denies every write outside its private view, scratch and state. A
  // stable, truthful cwd keeps the provider's environment prompt (and its
  // cached prefix) identical across requests. Linux confinement clones the
  // whole host tree read-only as its private root, so the real path would be
  // visible there too, but that launcher is unverified (Landlock ABI 9 is
  // unavailable on the tested kernels) and keeps the private view.
  const logicalWorkingDirectory = process.platform === 'darwin' && path.isAbsolute(logicalDirectory ?? '')
    ? await fs.realpath(logicalDirectory).catch(() => undefined) : undefined;
  const lease = { viewDirectory: path.join(root, 'worktree'), workingDirectory: path.join(root, 'worktree'), auxiliaryDirectory,
    ...(logicalWorkingDirectory ? { logicalWorkingDirectory } : {}) };
  await fs.mkdir(lease.viewDirectory);
  let handle;
  try {
    const scratch = path.join(root, 'scratch');
    const env = { ...input.env, HOME: scratch, XDG_CONFIG_HOME: path.join(scratch, 'config'),
      XDG_DATA_HOME: path.join(scratch, 'data'), XDG_STATE_HOME: path.join(scratch, 'state'), XDG_CACHE_HOME: path.join(scratch, 'cache') };
    for (const key of Object.keys(env)) if (/^(DEVRYAN_.*(?:TOKEN|URL)|OPENCODE_SERVER_(?:PASSWORD|USERNAME))$/.test(key)) delete env[key];
    const workerInput = input.inputForLease ? await input.inputForLease(lease) : input.input;
    handle = await startSessionExecution({ ...input, input: workerInput, launcher, lease, env: environment ? await environment(env, lease) : env });
    handle.workerInput = workerInput;
  } catch (cause) { await fs.rm(root, { recursive: true, force: true }); throw cause; }
  const result = handle.result.then(async (receipt) => {
    // A missing acknowledgement leaves the private view available for recovery.
    await fs.rm(root, { recursive: true, force: true });
    if (!receipt.confined) throw error('mutation_runtime_unsupported');
    return receipt;
  });
  void result.catch(() => {});
  return { ...handle, lease, result };
}

/** Bounded host discovery helpers own no agent contribution. The supervisor
 * remains the termination authority, including timeout/output overflow. */
export async function runReadOnlySessionExecution({ maxOutputBytes = 1024 * 1024, maxErrorBytes = 64 * 1024,
  onStarted, onTermination, ...input }) {
  for (const bound of [maxOutputBytes, maxErrorBytes]) if (!Number.isSafeInteger(bound) || bound < 0 || bound > 1024 * 1024) throw error('invalid_execution_output_bound');
  const controller = new AbortController();
  const buffers = { stdout: [], stderr: [] }, sizes = { stdout: 0, stderr: 0 };
  let overflow = false;
  const handle = await startReadOnlySessionExecution({ ...input,
    signal: AbortSignal.any([controller.signal, ...(input.signal ? [input.signal] : [])]),
    onOutput: ({ stream, data }) => {
      const limit = stream === 'stdout' ? maxOutputBytes : maxErrorBytes;
      if (sizes[stream] + data.length > limit) {
        overflow = true; controller.abort(error('execution_output_overflow')); return;
      }
      sizes[stream] += data.length; buffers[stream].push(Buffer.from(data));
    } });
  try { onStarted?.(handle); } catch { handle.cancel(); }
  const receipt = await handle.result;
  try { onTermination?.(receipt); } catch { /* Observer only. */ }
  if (!receipt.confined || receipt.cancelled || overflow) throw error(overflow ? 'execution_output_overflow' : receipt.cancelled ? 'execution_cancelled' : 'mutation_runtime_unsupported');
  return { receipt, stdout: Buffer.concat(buffers.stdout), stderr: Buffer.concat(buffers.stderr) };
}
