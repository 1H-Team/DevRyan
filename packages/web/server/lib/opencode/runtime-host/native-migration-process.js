import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID,randomBytes } from 'node:crypto';
import { startParentDeathWatchdog } from '../parent-death-watchdog.js';
import { NATIVE_PROCESS_LIMITS, parseNativeMigrationRequest, parseNativeMigrationReceipt } from './native-process-protocol.js';
import {canonicalJSON} from './bundle-migration-inventory.js';

const fail = code => Object.assign(new Error(code), { code, status: 503 });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** Offline importer: success requires a bound receipt, scope completion and actual owned OS exit. */
export async function runNativeMigrationProcess({ binary, environment, cwd, request: input, timeoutMs = 120_000, beforeSpawn,windowsOwner }) {
  const request = parseNativeMigrationRequest(input);
  if (!path.isAbsolute(binary ?? '') || !path.isAbsolute(cwd ?? '') || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1 || timeoutMs > 300_000 || !(await fs.stat(binary)).isFile()) throw fail('native_migration_launch_invalid');
  if(process.platform!=='win32'&&!windowsOwner)await beforeSpawn?.();
  const migrationInstanceID = process.platform==='win32'||windowsOwner?randomBytes(16).toString('hex'):randomUUID();
  const {bytes,code,signal:signalName,stderrBytes}=process.platform==='win32'||windowsOwner
    ?await runWindowsMigration({binary,request,windowsOwner,migrationInstanceID,beforeSpawn})
    :await runPosixMigration({binary,cwd,environment,request,timeoutMs,migrationInstanceID});
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
  const persisted = windowsOwner?(await windowsOwner.read(request.receiptPath)).bytes:await fs.readFile(request.receiptPath);
  const persistedReceipt = parseNativeMigrationReceipt(JSON.parse(persisted.toString('utf8')));
  if (sha256(persisted) !== wire.sha256
    || Object.keys(receipt).some(key => persistedReceipt[key] !== receipt[key])) throw fail('native_migration_receipt_mismatch');
  for (const [suffix, expected] of [['.source.json', receipt.sourceInventorySha256], ['.verification.json', receipt.verificationSha256]]) {
    const file = request.receiptPath + suffix;
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 * 1024 || (windowsOwner?(await windowsOwner.largeFile(file)).token.split(':')[2]:sha256(await fs.readFile(file))) !== expected) throw fail('native_migration_inventory_mismatch');
  }
  return receipt;
}

async function runPosixMigration({binary,cwd,environment,request,timeoutMs,migrationInstanceID}){
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
  const result=await outcome;return {...result,stderrBytes};
}

async function runWindowsMigration({binary,request,windowsOwner,migrationInstanceID,beforeSpawn}){
 if(typeof windowsOwner?.beginNativeImport!=='function'||typeof beforeSpawn!=='function')throw fail('private_windows_storage_authority_unavailable');
 const root=path.dirname(request.isolatedRoot),bundles=path.dirname(root),controlRoot=path.dirname(bundles);
 if(path.basename(bundles)!=='bundles'||request.isolatedRoot!==path.join(root,'global')
   ||request.candidateDatabasePath!==path.join(root,'opencode','opencode.db')||request.receiptPath!==path.join(root,'sources','migration.json'))throw fail('native_migration_launch_invalid');
 const receiptParent=path.join(controlRoot,'native-import-receipts');await windowsOwner.ensureDirectory(receiptParent);
 const controller=await windowsOwner.largeFile(binary);
 const expectedRootToken=await windowsOwner.tree(root,{exclusions:'none'}),expectedArtifactToken=await windowsOwner.tree(path.dirname(binary));
 const nativeReceipt=path.join(receiptParent,migrationInstanceID+'.json');
 const lease=windowsOwner.beginNativeImport({operation:'migrate',rootExclusions:'none',mutating:true,controller:binary,controllerSha256:controller.token.split(':')[2],root,expectedRootToken,expectedArtifactToken,nativeReceipt,nonce:migrationInstanceID});
 try{
  await lease.ready;await lease.assertHeld();
  const verified=await beforeSpawn();
  const acceptedController=verified?.manifest?.files?.find(row=>row.role==='controller'&&path.resolve(verified.directory,row.path)===binary);
  if(verified?.controller!==binary||verified.directory!==path.dirname(binary)||acceptedController?.sha256!==controller.token.split(':')[2])throw fail('native_runtime_artifacts_unverified');
  await lease.assertHeld();await lease.writeRequest(Buffer.from(JSON.stringify(request)+'\n'));
  const result=await lease.finish();
  if(Buffer.byteLength(result.stdout)>NATIVE_PROCESS_LIMITS.messageBytes||Buffer.byteLength(result.stderr)>NATIVE_PROCESS_LIMITS.bootBytes)throw fail('native_migration_output_bound');
  let persistedNative;try{persistedNative=JSON.parse((await windowsOwner.read(nativeReceipt)).bytes.toString('utf8'));}catch{throw fail('native_migration_exit_unconfirmed');}
  if(!result.receipt||result.receipt.nonce!==migrationInstanceID||result.receipt.controllerToken!==controller.token
    ||result.receipt.jobSettled!==true||result.receipt.namespaceFlushed!==true||result.receipt.exitCode!==0
    ||result.receipt.operation!=='migrate'||result.receipt.rootExclusions!=='none'||result.receipt.mutating!==true
    ||canonicalJSON(persistedNative)!==canonicalJSON(result.receipt)||result.receipt.rootToken!==await windowsOwner.tree(root,{exclusions:'none'}))throw fail('native_migration_exit_unconfirmed');
  return {bytes:Buffer.from(result.stdout),stderrBytes:Buffer.byteLength(result.stderr),code:0,signal:null};
 }catch(error){try{await lease.cancel();}catch(cleanup){throw new AggregateError([error,cleanup],'Native importer settlement failed');}throw error;}
}
