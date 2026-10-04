import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { sessionExecutionProfile, verifySessionExecutionLauncher } from '@openchamber/harness-runtime/lib/session-execution.js';
import { startParentDeathWatchdog } from '../parent-death-watchdog.js';
import { registerManagedOpenCodeProcess, unregisterManagedOpenCodeProcess, reapOrphanedManagedOpenCodeProcesses } from '../managed-process-registry.js';
import { NATIVE_PROCESS_LIMITS, parseNativeBoot, parseNativeCommand, parseNativeReply, encodeNativeProcessMessage } from './native-process-protocol.js';

const failure = code => Object.assign(new Error(code), { code, status: 503 });
const deadline = async (work, timeoutMs, code) => {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(failure(code)), timeoutMs); })]); }
  finally { clearTimeout(timer); }
};

// Controller state is a selected bundle, never an agent mutation view. Its
// supervisor receipt lives outside every directory the child may write.
export const prepareSupervisedController = async (boot, supervisor) => {
  if (process.platform !== 'darwin' || !await verifySessionExecutionLauncher({ launcher: supervisor.launcher })) throw failure('native_controller_supervisor_unavailable');
  const databaseDirectory = path.dirname(boot.databasePath), auxiliaryDirectory = path.dirname(boot.globals.home);
  const bundleRoot = path.dirname(databaseDirectory);
  if (databaseDirectory !== path.join(bundleRoot, 'opencode') || auxiliaryDirectory !== path.join(bundleRoot, 'global')) throw failure('native_controller_roots_invalid');
  for (const directory of [databaseDirectory, auxiliaryDirectory, ...Object.values(boot.globals)]) {
    if (await fs.promises.realpath(directory) !== directory || !(await fs.promises.stat(directory)).isDirectory()) throw failure('native_controller_roots_invalid');
  }
  if (Object.entries(boot.globals).some(([key, directory]) => key !== 'config' && !directory.startsWith(auxiliaryDirectory + path.sep))) throw failure('native_controller_roots_invalid');
  const deniedReadDirectories = supervisor.deniedReadDirectories ?? [];
  sessionExecutionProfile({ viewDirectory: databaseDirectory, scratchDirectory: boot.globals.tmp, auxiliaryDirectory, deniedReadDirectories });
  for (const directory of deniedReadDirectories) if (await fs.promises.realpath(directory) !== directory || !(await fs.promises.stat(directory)).isDirectory()) throw failure('native_controller_roots_invalid');
  const controlBase = path.join(bundleRoot, '.native-controller');
  try { await fs.promises.mkdir(controlBase, { mode: 0o700 }); }
  catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
  if (await fs.promises.realpath(controlBase) !== controlBase || !(await fs.promises.lstat(controlBase)).isDirectory()) throw failure('native_controller_roots_invalid');
  const controlDirectory = path.join(controlBase, boot.instanceID);
  await fs.promises.mkdir(controlDirectory, { mode: 0o700 });
  const profile = path.join(controlDirectory, 'controller.sb'), receiptPath = path.join(controlDirectory, 'termination.json');
  await fs.promises.writeFile(profile, sessionExecutionProfile({ viewDirectory: databaseDirectory, scratchDirectory: boot.globals.tmp,
    auxiliaryDirectory, socketDirectory: null, deniedReadDirectories }), { flag: 'wx', mode: 0o600 });
  return { profile, receiptPath, arguments: [databaseDirectory, boot.globals.tmp, profile, receiptPath, '--'] };
};

/** One owned child and its bounded private protocol. A bound socket remains admission-closed until OPEN. */
export async function createNativeControllerProcess(options) {
  const boot = parseNativeBoot(options.boot), { binary, environment, cwd, timeoutMs = 30_000 } = options;
  if (!path.isAbsolute(binary ?? '') || !path.isAbsolute(cwd ?? '') || !/^[a-f0-9-]{32,64}$/.test(boot.instanceID)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw failure('native_process_launch_invalid');
  if (!(await fs.promises.stat(binary)).isFile()) throw failure('native_process_launch_invalid');
  const registryOptions = { registryPath: path.join(boot.globals.state, 'managed-opencode-processes.json') };
  const previous = await reapOrphanedManagedOpenCodeProcesses(registryOptions);
  if (previous.kept.length || previous.reaped.some(record => !record.terminated)) throw failure('native_process_owner_unsettled');
  await options.beforeSpawn?.();
  const supervised = options.supervisor ? await prepareSupervisedController(boot, options.supervisor) : undefined;
  const command = supervised ? options.supervisor.launcher : binary;
  const args = [...(supervised ? [...supervised.arguments, binary] : []), 'serve', '--native-instance', boot.instanceID];
  const child = spawn(command, args, {
    cwd, env: { ...environment, ...(supervised ? { DEVRYAN_EXECUTION_WORKER: '1', DEVRYAN_EXECUTION_CWD: cwd,
      DYLD_INSERT_LIBRARIES: `${command}-spawn.dylib` } : {}) },
    stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true,
  });
  const startedAt = Date.now(), pending = new Map(), decoder = new StringDecoder('utf8');
  let buffer = '', bound, fatal, closing = false, closeWork, exitResult;
  let resolveBound, rejectBound, resolveExit, rejectExit;
  const binding = new Promise((resolve, reject) => { resolveBound = resolve; rejectBound = reject; });
  void binding.catch(() => {});
  const exited = new Promise((resolve, reject) => { resolveExit = resolve; rejectExit = reject; });
  // Exit cleanup may reject while the owner is still serving another request.
  void exited.catch(() => {});
  const rejectPending = cause => {
    rejectBound(cause);
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(cause); }
    pending.clear();
  };
  const signal = name => { if (child.exitCode === null && child.signalCode === null) child.kill(name); };
  const fail = cause => { fatal ??= cause; rejectPending(fatal); signal('SIGTERM'); };
  child.on('error', fail); child.stdin.on('error', fail);
  const watchdog = startParentDeathWatchdog({ childPid: child.pid, nativeInstanceID: boot.instanceID });
  child.once('exit', () => {
    // Native plugin children belong to this child's process group.
    if (!supervised && process.platform !== 'win32' && child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already drained. */ } }
    watchdog.dispose();
  });
  let stderrBytes = 0, stderrTail = '', observationUnavailable = false;
  const observationMarker = 'native_observation_unavailable';
  child.once('close', (code, signalName) => {
    exitResult = { pid: child.pid ?? null, code, signal: signalName, expected: closing, instanceID: boot.instanceID, startedAt,
      ...(observationUnavailable ? { observationUnavailable: true } : {}) };
    watchdog.dispose();
    rejectPending(fatal ?? failure('native_process_exited'));
    void (async () => {
      if (supervised) {
        const stat = await fs.promises.lstat(supervised.receiptPath);
        if (!stat.isFile() || stat.size > 1024) throw failure('native_controller_termination_unconfirmed');
        const receipt = JSON.parse(await fs.promises.readFile(supervised.receiptPath, 'utf8'));
        if (receipt.terminated !== true || receipt.confined !== true || receipt.exitCode !== code || typeof receipt.cancelled !== 'boolean'
          || signalName !== null) throw failure('native_controller_termination_unconfirmed');
        exitResult.receipt = { path: supervised.receiptPath, ...receipt };
        await fs.promises.rm(supervised.profile);
      }
      if (child.pid) unregisterManagedOpenCodeProcess(child.pid, registryOptions);
      await options.afterExit?.(exitResult);
      if (options.logFile) await fs.promises.appendFile(options.logFile, JSON.stringify({ event: 'native-process-exit', ...exitResult, stderrBytes }) + '\n', { mode: 0o600 });
      try { options.onExit?.(exitResult); } catch { /* Observer cannot own cleanup. */ }
      resolveExit(exitResult);
    })().catch(rejectExit);
  });
  // Raw provider/plugin output can contain credentials. Only lifecycle facts
  // enter this log; structured runtime diagnostics retain their own redaction.
  child.stderr.on('data', chunk => {
    stderrBytes += chunk.byteLength;
    if (observationUnavailable) return;
    const text = stderrTail + chunk.toString('utf8');
    if (text.includes(observationMarker)) {
      observationUnavailable = true; stderrTail = '';
      try { options.onObservationUnavailable?.(boot.instanceID); } catch { /* Evidence failure cannot alter execution. */ }
    } else stderrTail = text.slice(-(observationMarker.length - 1));
  });
  child.stdout.on('data', chunk => {
    if (fatal) return;
    try {
      buffer += decoder.write(chunk);
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (Buffer.byteLength(line) > NATIVE_PROCESS_LIMITS.messageBytes) throw failure('native_process_protocol_overflow');
        const reply = parseNativeReply(JSON.parse(line));
        if (reply.type === 'bound') {
          if (bound || reply.bundleID !== boot.bundleID || reply.instanceID !== boot.instanceID || reply.buildId !== boot.buildId) throw failure('native_process_identity_mismatch');
          bound = reply; resolveBound(reply); continue;
        }
        if (!bound && reply.id === 'boot' && !reply.ok) {
          const code = /^(?:native|opencode)_[a-z0-9_]{1,80}$/.test(reply.error.code) ? reply.error.code : 'native_process_failed';
          throw failure(code);
        }
        const request = pending.get(reply.id);
        if (!bound || !request) throw failure('native_process_response_uncorrelated');
        pending.delete(reply.id); clearTimeout(request.timer);
        if (reply.ok) request.resolve(reply.result);
        else request.reject(Object.assign(new Error(reply.error.code), { code: reply.error.code, status: reply.error.status }));
      }
      if (Buffer.byteLength(buffer) > NATIVE_PROCESS_LIMITS.messageBytes) throw failure('native_process_protocol_overflow');
    } catch (cause) { fail(cause); }
  });
  const call = (input, { timeoutMs: requestTimeout = timeoutMs } = {}) => {
    if (fatal || exitResult) return Promise.reject(fatal ?? failure('native_process_exited'));
    if (!bound || pending.size >= NATIVE_PROCESS_LIMITS.inFlight) return Promise.reject(failure('native_process_busy'));
    if (!Number.isSafeInteger(requestTimeout) || requestTimeout < 1 || requestTimeout > 300_000) return Promise.reject(failure('native_process_timeout_invalid'));
    const command = parseNativeCommand({ ...input, protocol: 1, id: randomUUID() });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A timed-out command may already have changed native state. Refuse
        // every later request until the owner has completed exit recovery.
        fail(failure('native_process_command_timeout'));
      }, requestTimeout);
      pending.set(command.id, { resolve, reject, timer });
      child.stdin.write(encodeNativeProcessMessage(command), cause => { if (cause) fail(cause); });
    });
  };
  const killAndWaitForExit = () => {
    closing = true;
    // The supervisor terminates the confined controller group and persists
    // its receipt; killing the supervisor itself would lose that authority.
    signal(supervised ? 'SIGTERM' : 'SIGKILL');
    return exited;
  };
  const killForRecovery = () => deadline(killAndWaitForExit(), timeoutMs, 'native_process_exit_unconfirmed');
  try {
    if (watchdog.error) throw failure(watchdog.error.code);
    if (child.pid) registerManagedOpenCodeProcess({ childPid: child.pid, binary, nativeInstanceID: boot.instanceID,
      ownerPid: process.pid, hostRuntime: 'web', hostname: '127.0.0.1', startedAt, workingDirectory: cwd }, registryOptions);
    child.stdin.write(encodeNativeProcessMessage(boot), cause => { if (cause) fail(cause); });
    await deadline(binding, timeoutMs, 'native_process_boot_timeout');
  } catch (cause) {
    try { await killForRecovery(); }
    catch (cleanup) { throw Object.assign(cleanup, { nativeProcessUnsettled: true }); }
    throw cause;
  }
  return {
    url: bound.url, port: bound.port, instanceID: boot.instanceID, pid: child.pid, startedAt, bound,
    hasExited: () => exitResult !== undefined, call, killForRecovery, killAndWaitForExit,
    close() {
      if (closeWork) return closeWork;
      closing = true;
      closeWork = (async () => {
        if (exitResult) { await exited; throw failure('native_process_close_unconfirmed'); }
        try {
          await call({ action: 'close' });
          child.stdin.end();
          const result = await deadline(exited, timeoutMs, 'native_process_exit_unconfirmed');
          if (result.code !== 0 || result.signal) throw failure('native_process_close_unconfirmed');
          return result;
        } catch (cause) { await killForRecovery(); throw cause; }
      })();
      return closeWork;
    },
  };
}
