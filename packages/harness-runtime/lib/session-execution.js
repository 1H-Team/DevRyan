import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileAtomic } from './atomic-file.js';

const error = (code) => Object.assign(new Error(code), { code, status: 409 });
const sbString = (value) => {
  if (typeof value !== 'string' || /[\u0000-\u001f]/.test(value)) throw error('invalid_execution_path');
  return JSON.stringify(value);
};

export async function verifySessionExecutionLauncher({ launcher, platform = process.platform }) {
  if (!['darwin', 'linux', 'win32'].includes(platform) || !path.isAbsolute(launcher ?? '')) return false;
  try {
    const manifest = JSON.parse(await fs.readFile(`${launcher}.json`, 'utf8'));
    const stat = await fs.lstat(launcher);
    if (!stat.isFile() || stat.size > 1024 * 1024 || manifest.version !== 1 || manifest.policy !== 2 || manifest.acceptance !== true
      || manifest.platform !== platform || manifest.arch !== process.arch || manifest.binary !== path.basename(launcher)) return false;
    if (platform === 'darwin') {
      if (manifest.spawnLibrary !== `${path.basename(launcher)}-spawn.dylib`) return false;
      if (createHash('sha256').update(await fs.readFile(path.join(path.dirname(launcher), manifest.spawnLibrary))).digest('hex') !== manifest.spawnSha256) return false;
    }
    return createHash('sha256').update(await fs.readFile(launcher)).digest('hex') === manifest.sha256;
  } catch { return false; }
}

export function sessionExecutionProfile({ viewDirectory, scratchDirectory, auxiliaryDirectory }) {
  return `(version 1)
(allow default)
(deny file-write* (require-all (require-not (subpath ${sbString(viewDirectory)})) (require-not (subpath ${sbString(scratchDirectory)})) ${auxiliaryDirectory ? `(require-not (subpath ${sbString(auxiliaryDirectory)}))` : ''} (require-not (literal "/dev/null"))))
(deny mach-lookup)
(deny network-outbound (remote unix-socket))
(deny process-info-setcontrol)
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

export async function readSessionExecutionReceipt(lease) {
  const file = path.join(path.dirname(lease.viewDirectory), 'termination.json');
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.size > 1024) throw error('mutation_termination_unconfirmed');
  let value;
  try { value = JSON.parse(await fs.readFile(file, 'utf8')); } catch { throw error('mutation_termination_unconfirmed'); }
  if (value?.terminated !== true || typeof value.confined !== 'boolean' || !Number.isInteger(value.exitCode) || typeof value.cancelled !== 'boolean') {
    throw error('mutation_termination_unconfirmed');
  }
  return value;
}

export async function prepareSessionExecution({ launcher, lease }) {
  if (!['darwin', 'linux', 'win32'].includes(process.platform)) throw error('mutation_platform_unsupported');
  if (!path.isAbsolute(launcher ?? '')) throw error('mutation_runtime_unsupported');
  const viewDirectory = await fs.realpath(lease.viewDirectory);
  const root = path.dirname(viewDirectory), scratchDirectory = path.join(root, 'scratch');
  const workingDirectory = await fs.realpath(lease.workingDirectory ?? viewDirectory);
  const relative = path.relative(viewDirectory, workingDirectory);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw error('invalid_execution_path');
  await fs.mkdir(scratchDirectory, { recursive: true, mode: 0o700 });
  const auxiliaryDirectory = lease.auxiliaryDirectory ? path.resolve(lease.auxiliaryDirectory) : scratchDirectory;
  await fs.mkdir(auxiliaryDirectory, { recursive: true, mode: 0o700 });
  if (process.platform === 'darwin') {
    const shellEnvironment = `export DYLD_INSERT_LIBRARIES=${'\'' + `${launcher}-spawn.dylib`.replaceAll('\'', '\'\\\'\'') + '\''}\n`;
    await fs.writeFile(path.join(scratchDirectory, '.zshenv'), shellEnvironment, { mode: 0o600 });
    await fs.writeFile(path.join(scratchDirectory, '.bash-env'), shellEnvironment, { mode: 0o600 });
  }
  const profile = path.join(root, `sandbox-${randomUUID()}.sb`);
  await writeFileAtomic(profile, sessionExecutionProfile({ viewDirectory, scratchDirectory, auxiliaryDirectory }));
  const cancelEvent = `Local\\DevRyan-execution-${randomUUID()}`;
  return { launcher, arguments: [viewDirectory, scratchDirectory, profile, path.join(root, 'termination.json'), '--'],
    cwd: workingDirectory, profile, scratchDirectory,
    environment: { DEVRYAN_EXECUTION_CWD: workingDirectory, DEVRYAN_EXECUTION_CANCEL_EVENT: cancelEvent,
      DEVRYAN_EXECUTION_CACHE: auxiliaryDirectory, CONTEXT_MODE_DIR: auxiliaryDirectory,
      CONTEXT_MODE_DATA_DIR: auxiliaryDirectory,
      ...(process.platform === 'darwin' ? { DYLD_INSERT_LIBRARIES: `${launcher}-spawn.dylib`,
        ZDOTDIR: scratchDirectory, BASH_ENV: path.join(scratchDirectory, '.bash-env') } : {}),
      TMPDIR: scratchDirectory, TMP: scratchDirectory, TEMP: scratchDirectory } };
}

/** Starts only the reviewed native launcher. Commands never inherit host fds
 * or gain write access to the ledger, original project, or dependencies. */
export async function startSessionExecution({ launcher, lease, command, args = [], env = {}, signal, onOutput, input, interactive = false }) {
  if (typeof command !== 'string' || !command || !Array.isArray(args)
    || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) throw error('invalid_execution_command');
  signal?.throwIfAborted();
  const prepared = await prepareSessionExecution({ launcher, lease });
  if (signal?.aborted) { await fs.rm(prepared.profile, { force: true }); signal.throwIfAborted(); }
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
  const cancel = () => {
    if (cancellationRequested) return;
    cancellationRequested = true;
    if (process.platform !== 'win32') { terminate('SIGTERM'); return; }
    // An early cancellation can race event creation. Retry while this owned
    // supervisor is alive; a forced kill would lose its durable acknowledgement.
    const signalEvent = () => execFile(launcher, ['--cancel', prepared.environment.DEVRYAN_EXECUTION_CANCEL_EVENT], { timeout: 1000, windowsHide: true }, (cause) => {
      if (cause && child.exitCode === null && child.signalCode === null) setTimeout(signalEvent, 20).unref();
    });
    signalEvent();
  };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const result = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', async (code, signal) => {
      const unconfirmed = () => Object.assign(error('mutation_termination_unconfirmed'), { exitCode: code, signal });
      let value;
      try { value = await readSessionExecutionReceipt(lease); } catch { reject(unconfirmed()); return; }
      if (code !== value.exitCode) {
        reject(unconfirmed()); return;
      }
      resolve(value);
    });
  }).finally(async () => {
    signal?.removeEventListener('abort', cancel);
    await fs.rm(prepared.profile, { force: true });
  });
  return { pid: child.pid, child, cancel, result };
}

/** Provider transports and title generation have no file contribution. They
 * still need the same OS boundary: a prompt requesting no tools is not one. */
export async function startReadOnlySessionExecution({ launcher, storage, environment, auxiliaryDirectory, ...input }) {
  if (!path.isAbsolute(storage ?? '') || !await verifySessionExecutionLauncher({ launcher })) throw error('mutation_runtime_unsupported');
  await fs.mkdir(storage, { recursive: true, mode: 0o700 });
  const root = await fs.mkdtemp(path.join(await fs.realpath(storage), 'provider-'));
  const lease = { viewDirectory: path.join(root, 'worktree'), workingDirectory: path.join(root, 'worktree'), auxiliaryDirectory };
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
