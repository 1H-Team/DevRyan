import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { startParentDeathWatchdog } from '../parent-death-watchdog.js';
import { NATIVE_PROCESS_LIMITS, parseNativeMigrationRequest, parseNativeMigrationReceipt } from './native-process-protocol.js';

const fail = code => Object.assign(new Error(code), { code, status: 503 });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** Offline importer: success requires a bound receipt, scope completion and actual owned OS exit. */
export async function runNativeMigrationProcess({ binary, environment, cwd, request: input, timeoutMs = 120_000, beforeSpawn }) {
  const request = parseNativeMigrationRequest(input);
  if (!path.isAbsolute(binary ?? '') || !path.isAbsolute(cwd ?? '') || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1 || timeoutMs > 300_000 || !(await fs.stat(binary)).isFile()) throw fail('native_migration_launch_invalid');
  await beforeSpawn?.();
  const migrationInstanceID = randomUUID();
  const child = spawn(binary, ['--migrate', '--native-instance', migrationInstanceID], {
    cwd, env: { ...environment }, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true,
  });
  let cause, output = Buffer.alloc(0), stderrBytes = 0, killTimer, exitTimer, rejectExit;
  const signal = name => {
    if (!child.pid) return;
    try { if (process.platform !== 'win32') process.kill(-child.pid, name); else child.kill(name); }
    catch (error) { if (error.code !== 'ESRCH') cause ??= fail('native_migration_termination_failed'); }
  };
  const terminate = error => {
    cause ??= error;
    signal('SIGTERM');
    killTimer ??= setTimeout(() => signal('SIGKILL'), 1000);
    exitTimer ??= setTimeout(() => rejectExit(fail('native_migration_exit_unconfirmed')), 5000);
  };
  const watchdog = startParentDeathWatchdog({ childPid: child.pid, migrationInstanceID });
  const outcome = new Promise((resolve, reject) => {
    rejectExit = reject;
    const timer = setTimeout(() => terminate(fail('native_migration_timeout')), timeoutMs);
    child.on('error', error => terminate(error));
    child.stdin.on('error', error => terminate(error));
    child.stdout.on('data', bytes => {
      if (output.length + bytes.length > NATIVE_PROCESS_LIMITS.messageBytes) terminate(fail('native_migration_output_bound'));
      else output = Buffer.concat([output, bytes]);
    });
    child.stderr.on('data', bytes => {
      stderrBytes += bytes.length;
      if (stderrBytes > NATIVE_PROCESS_LIMITS.bootBytes) terminate(fail('native_migration_stderr_bound'));
    });
    child.once('close', (code, signalName) => {
      clearTimeout(timer); clearTimeout(killTimer); clearTimeout(exitTimer); watchdog.dispose();
      // No importer descendant may retain this offline process group.
      signal('SIGKILL');
      if (cause) reject(cause);
      else resolve({ bytes: output, code, signal: signalName });
    });
    if (watchdog.error) terminate(fail(watchdog.error.code));
    else child.stdin.end(`${JSON.stringify(request)}\n`);
  });
  const { bytes, code, signal: signalName } = await outcome;
  const protocolFailure = failureCode => {
    const lines = bytes.toString('utf8').split('\n').filter(Boolean);
    const jsonLines = lines.filter(line => { try { JSON.parse(line); return true; } catch { return false; } }).length;
    return Object.assign(fail(failureCode), { protocolEvidence: { stdoutBytes: bytes.length, stderrBytes,
      lineCount: lines.length, jsonLineCount: jsonLines, nonJSONLineCount: lines.length - jsonLines, code, signal: signalName } });
  };
  let wire;
  try { wire = JSON.parse(bytes.toString('utf8')); } catch { throw protocolFailure(code !== 0 || signalName ? 'native_migration_exit_unconfirmed' : 'native_migration_receipt_invalid'); }
  if (wire?.protocol === 'devryan-native-migration/1' && wire.ok === false) {
    if (signalName || code === 0 || Object.keys(wire).some(key => !['protocol', 'ok', 'error'].includes(key))
      || !wire.error || Object.keys(wire.error).some(key => !['code', 'status'].includes(key))
      || !/^[a-z][a-z0-9_]{0,127}$/.test(wire.error.code ?? '') || !Number.isInteger(wire.error.status)
      || wire.error.status < 400 || wire.error.status > 599) throw fail('native_migration_receipt_invalid');
    throw Object.assign(new Error(wire.error.code), { code: wire.error.code, status: wire.error.status });
  }
  if (code !== 0 || signalName) throw fail('native_migration_exit_unconfirmed');
  if (!wire || typeof wire !== 'object' || Array.isArray(wire)
    || Object.keys(wire).some(key => !['protocol', 'ok', 'receipt', 'receiptPath', 'sha256'].includes(key))
    || wire.protocol !== 'devryan-native-migration/1' || wire.ok !== true || wire.receiptPath !== request.receiptPath
    || !/^[a-f0-9]{64}$/.test(wire.sha256 ?? '')) throw fail('native_migration_receipt_invalid');
  const receipt = parseNativeMigrationReceipt(wire.receipt);
  if (receipt.requestID !== request.requestID || receipt.bundleID !== request.bundleID
    || receipt.databasePath !== request.candidateDatabasePath) throw fail('native_migration_receipt_mismatch');
  const stat = await fs.lstat(request.receiptPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > NATIVE_PROCESS_LIMITS.messageBytes) throw fail('native_migration_receipt_invalid');
  const persisted = await fs.readFile(request.receiptPath);
  const persistedReceipt = parseNativeMigrationReceipt(JSON.parse(persisted.toString('utf8')));
  if (sha256(persisted) !== wire.sha256
    || Object.keys(receipt).some(key => persistedReceipt[key] !== receipt[key])) throw fail('native_migration_receipt_mismatch');
  for (const [suffix, expected] of [['.source.json', receipt.sourceInventorySha256], ['.verification.json', receipt.verificationSha256]]) {
    const file = request.receiptPath + suffix;
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 * 1024 || sha256(await fs.readFile(file)) !== expected) throw fail('native_migration_inventory_mismatch');
  }
  return receipt;
}
