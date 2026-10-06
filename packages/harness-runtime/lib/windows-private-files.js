import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

/** @typedef {{ protocol: 'devryan.windows-file-identity/1', volume: string, fileId: string,
 * type: 'file' | 'directory', reparsePoint: boolean, linkCount: number,
 * currentOwner: boolean, privateAcl: boolean }} WindowsFileIdentity */
const refused = () => Object.assign(new Error('private_windows_file_unverified'), { code: 'private_windows_file_unverified' });
const DEFAULT_PRIVATE_BYTES = 16 * 1024 * 1024;
const MAX_PRIVATE_BYTES = 64 * 1024 * 1024;
const privateBound = maximum => {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_PRIVATE_BYTES) throw refused();
  return maximum;
};

/** @returns {WindowsFileIdentity} */
export function parseWindowsFileIdentity(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 4096) throw refused();
  let value;
  try { value = JSON.parse(raw); } catch { throw refused(); }
  if (!value || Object.keys(value).sort().join(',') !== 'currentOwner,fileId,linkCount,privateAcl,protocol,reparsePoint,type,volume'
    || value.protocol !== 'devryan.windows-file-identity/1' || typeof value.volume !== 'string' || !/^[a-f0-9]{16}$/.test(value.volume)
    || typeof value.fileId !== 'string' || !/^[a-f0-9]{32}$/.test(value.fileId) || !['file', 'directory'].includes(value.type)
    || !Number.isSafeInteger(value.linkCount) || value.linkCount < 1
    || ['reparsePoint', 'currentOwner', 'privateAcl'].some(key => typeof value[key] !== 'boolean')) throw refused();
  return value;
}

// The caller owns launcher verification. Native compilation probes deliberately
// use unaccepted helpers; this operation grants no execution admission.
async function nativeFileOperation(launcher, operation, target, bytes, argumentsAfterTarget = [], maximum = DEFAULT_PRIVATE_BYTES) {
  privateBound(maximum);
  if (process.platform !== 'win32' || typeof launcher !== 'string' || !path.win32.isAbsolute(launcher)
    || typeof target !== 'string' || !/^[A-Za-z]:\\/.test(target) || path.win32.resolve(target) !== target
    || /[\u0000-\u001f]/.test(target)) throw refused();
  const nativeOperation = maximum > DEFAULT_PRIVATE_BYTES ? operation.replace(/private-file$/, 'private-ledger') : operation;
  const raw = await new Promise((resolve, reject) => {
    const reading = operation === '--read-private-file';
    const child = execFile(launcher, [nativeOperation, target, ...argumentsAfterTarget], { encoding: reading ? 'buffer' : 'utf8', timeout: maximum > DEFAULT_PRIVATE_BYTES || operation.includes('update-tree') || ['--copy-private-tree', '--inspect-private-copy-tree','--inspect-update-file', '--rename-private-file', '--truncate-private-file', '--prune-private-publications'].includes(operation) ? 120000 : 5000,
      maxBuffer: reading ? maximum + 4096 : 4096, windowsHide: true },
      (error, stdout, stderr) => {
        if (!error) { resolve(stdout); return; }
        const failure = refused();
        if (operation.startsWith('--create-private-') && error.code === 125
          && /^exclusive private (?:directory|file) failed \((?:80|183)\)\r?\n$/.test(stderr)) failure.code = 'EEXIST';
        if (operation === '--read-private-file' && error.code === 125
          && /^private read handle failed \(2\)\r?\n$/.test(stderr)) failure.code = 'ENOENT';
        if (operation === '--read-private-file' && error.code === 125
          && /^anchored directory parent failed \((?:2|3)\)\r?\n$/.test(stderr)) failure.code = 'ENOENT';
        if (operation === '--inspect-update-tree' && error.code === 125 && /^update tree held input failed \((?:2|3)\)\r?\n$/.test(stderr)) failure.code = 'ENOENT';
        if (operation === '--inspect-update-file' && error.code === 125 && /^update download private file failed \(2\)\r?\n$/.test(stderr)) failure.code = 'ENOENT';
        if (['--publish-private-file', '--delete-private-file'].includes(operation) && error.code === 125
          && /^publication old compare and swap failed \(13\)\r?\n$/.test(stderr)) failure.code = 'private_windows_publication_conflict';
        if (error.code === 125 && /^private namespace durability prerequisite failed \([0-9]+\)\r?\n$/.test(stderr)) {
          failure.code = 'private_windows_namespace_durability_unavailable';
        }
        reject(failure);
      });
    child.stdin.on('error', () => {}); // The callback reports a refused or closed helper.
    child.stdin.end(bytes);
  });
  if (operation === '--read-private-file') return parseWindowsPrivateFileRead(raw, maximum);
  if (operation === '--inspect-namespace-durability') return parseWindowsNamespaceDurability(raw);
  if (operation === '--inspect-private-publication') return parseWindowsPublicationState(raw);
  if (operation === '--delete-private-file') return parseWindowsPrivateDeletion(raw, maximum);
  if (['--recover-private-publication', '--inspect-private-settlement'].includes(operation)) {
    let value; try { value = JSON.parse(raw); } catch { throw refused(); }
    return value?.protocol === 'devryan.windows-private-deletion/1' ? parseWindowsPrivateDeletion(raw, maximum) : parseWindowsPrivatePublication(raw, maximum);
  }
  if (operation === '--publish-private-file') return parseWindowsPrivatePublication(raw, maximum);
  if (operation === '--copy-private-tree') return parseWindowsPrivateTreeCopy(raw);
  if (operation === '--inspect-private-copy-tree') return parseWindowsPrivateTree(raw,false);
  if (operation.includes('update-tree')) return parseWindowsPrivateTree(raw, operation !== '--inspect-update-tree');
  if (['--inspect-update-file', '--rename-private-file', '--truncate-private-file'].includes(operation)) return parseWindowsLargePrivateFile(raw);
  if (operation === '--prune-private-publications') return parseWindowsPublicationPruning(raw);
  return parseWindowsFileIdentity(raw);
}

const treeTokenPattern = /^[a-f0-9]{16}:[a-f0-9]{32}:[a-f0-9]{64}:(?:0|[1-9][0-9]*):[1-9][0-9]*$/;
const largeFileTokenPattern = /^[a-f0-9]{16}:[a-f0-9]{32}:[a-f0-9]{64}:(?:0|[1-9][0-9]*)$/;
export const isWindowsPrivateControlName = name => typeof name === 'string'
  && (/^\.DevRyan-publication\.(?:lock|intent)$/i.test(name) || /^\.DevRyan-publication-[a-f0-9]{32}\.(?:receipt|backup|candidate)$/i.test(name));
const checkedTreeToken = token => parseWindowsPrivateTree(JSON.stringify({protocol:'devryan.windows-update-tree/1',token,namespaceFlushed:false}),false);
export function parseWindowsPrivateTreeCopy(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 4096) throw refused();
  let value; try { value = JSON.parse(raw); } catch { throw refused(); }
  if (!value || Object.keys(value).sort().join(',') !== 'destinationParentFileId,destinationParentVolume,destinationToken,exclusions,namespaceFlushed,protocol,sourceParentFileId,sourceParentVolume,sourceToken'
    || value.protocol !== 'devryan.windows-private-tree-copy/1' || value.namespaceFlushed !== true || !['none','runtime-bundle'].includes(value.exclusions)
    || ['sourceParentVolume','destinationParentVolume'].some(key=>typeof value[key]!=='string'||!/^[a-f0-9]{16}$/.test(value[key]))
    || ['sourceParentFileId','destinationParentFileId'].some(key=>typeof value[key]!=='string'||!/^[a-f0-9]{32}$/.test(value[key]))) throw refused();
  checkedTreeToken(value.sourceToken); checkedTreeToken(value.destinationToken); return value;
}
export function parseWindowsPrivateTree(raw, namespaceFlushed) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 4096) throw refused();
  let value; try { value = JSON.parse(raw); } catch { throw refused(); }
  if (!value || Object.keys(value).sort().join(',') !== 'namespaceFlushed,protocol,token' || value.protocol !== 'devryan.windows-update-tree/1'
    || value.namespaceFlushed !== namespaceFlushed || typeof value.token !== 'string' || !treeTokenPattern.test(value.token)) throw refused();
  const parts = value.token.split(':');
  if (!Number.isSafeInteger(Number(parts[3])) || Number(parts[3]) > 8 * 1024 ** 3
    || !Number.isSafeInteger(Number(parts[4])) || Number(parts[4]) < 1 || Number(parts[4]) > 65536) throw refused();
  return value.token;
}
export function parseWindowsLargePrivateFile(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 4096) throw refused();
  let value; try { value = JSON.parse(raw); } catch { throw refused(); }
  if (!value || Object.keys(value).sort().join(',') !== 'protocol,size,token' || value.protocol !== 'devryan.windows-update-file/1'
    || typeof value.token !== 'string' || !largeFileTokenPattern.test(value.token) || !Number.isSafeInteger(value.size) || value.size < 0 || value.size > 8 * 1024 ** 3
    || Number(value.token.split(':')[3]) !== value.size) throw refused();
  return value;
}
export function parseWindowsPublicationPruning(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 4096) throw refused();
  let value; try { value = JSON.parse(raw); } catch { throw refused(); }
  if (!value || Object.keys(value).sort().join(',') !== 'namespaceFlushed,protocol,pruned,retained'
    || value.protocol !== 'devryan.windows-publication-pruning/1' || value.namespaceFlushed !== true
    || !Number.isSafeInteger(value.pruned) || value.pruned < 0 || value.pruned > 4096
    || !Number.isSafeInteger(value.retained) || value.retained < 0 || value.retained > 33) throw refused();
  return value;
}

// Exported for deterministic child-lifetime tests. Production callers use the
// constructor owner; fixture hooks confer no native or platform acceptance.
export function beginWindowsPrivateStream(launcher, file, { offset, maximum, expected }, { spawnProcess = spawn, timeoutMs = 120000, terminationMs = 5000 } = {}) {
  if (process.platform !== 'win32' || !path.win32.isAbsolute(launcher ?? '') || !/^[A-Za-z]:\\/.test(file ?? '')
    || path.win32.resolve(file) !== file || /[\u0000-\u001f]/.test(file) || !Number.isSafeInteger(offset) || offset < 0
    || !Number.isSafeInteger(maximum) || maximum < offset || maximum > 8 * 1024 ** 3
    || expected !== 'absent' && (typeof expected !== 'string' || !largeFileTokenPattern.test(expected))) throw refused();
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000 || !Number.isSafeInteger(terminationMs) || terminationMs < 1 || terminationMs > 5000) throw refused();
  return beginWindowsPrivateOperation(launcher, ['--write-update-download', file, String(offset), String(maximum), expected], 'devryan.windows-update-download/1', parseWindowsLargePrivateFile, {spawnProcess,timeoutMs,terminationMs});
}
function beginWindowsPrivateOperation(launcher, args, protocol, parseResult, {spawnProcess=spawn,timeoutMs=120000,terminationMs=5000,outputMaximum=4096,binaryResult=false}={}) {
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000||!Number.isSafeInteger(terminationMs)||terminationMs<1||terminationMs>5000)throw refused();
  const child = spawnProcess(launcher, args,
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = Buffer.alloc(0), errors = '', readyResolve, readyReject, settledReject, failure = null, closed = false, readySeen=false, terminationTimer, cancelTimer;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const terminate = error => {
    if (closed || failure) return;
    failure = error; readyReject(error); child.stdin.destroy();
    // ChildProcess retains the Windows process handle. This targets the exact
    // spawned SDK process; no numeric-PID taskkill/descendant inference.
    try { child.kill('SIGKILL'); } catch { /* The retained child close still has a bounded confirmation deadline. */ }
    terminationTimer = setTimeout(() => {
      const unconfirmed = Object.assign(refused(), { code: 'private_windows_stream_termination_unconfirmed' });
      readyReject(unconfirmed); settledReject(unconfirmed);
    }, terminationMs);
  };
  const timer = setTimeout(() => terminate(Object.assign(refused(), { code: 'private_windows_stream_timeout' })), timeoutMs);
  child.stdout.on('data', chunk => {
    if(output.length+chunk.length>outputMaximum){terminate(refused());return;}
    output=Buffer.concat([output,chunk]);
    const newline=output.indexOf(10);
    if(newline<0){if(output.length>4096)terminate(refused());return;}
    if(newline>4096){terminate(refused());return;}
    if(readySeen)return;
    try {
      const value = JSON.parse(output.subarray(0,newline).toString('utf8'));
      if (Object.keys(value).sort().join(',') !== 'protocol,status' || value.protocol !== protocol || value.status !== 'held') throw refused();
      readySeen=true;readyResolve();
    } catch (error) { terminate(error); }
  });
  child.stderr.on('data', chunk => { errors = (errors + chunk.toString('utf8')).slice(0, 4096); }); child.stdin.on('error', () => {});
  const settled = new Promise((resolve, reject) => {
    settledReject = reject;
    child.on('error', error => {
      if (child.pid) { terminate(error); return; }
      // A failed spawn has no native process. Errors after creation (including
      // kill failure) leave the close-confirmation deadline intact.
      closed = true; clearTimeout(timer); clearTimeout(terminationTimer); clearTimeout(cancelTimer); child.stdin.destroy(); readyReject(error); reject(error);
    });
    child.once('close', code => {
      closed = true; clearTimeout(timer); clearTimeout(terminationTimer); clearTimeout(cancelTimer);
      try {
        if (failure) throw failure;
        const lines = output.toString('utf8').trim().split('\n');
        if (code !== 0 || !readySeen || !binaryResult && lines.length !== 2) {
          const failure = refused();
          if (/private namespace durability prerequisite failed/.test(errors)) failure.code = 'private_windows_namespace_durability_unavailable';
          throw failure;
        }
        resolve(parseResult(binaryResult?output.subarray(output.indexOf(10)+1):lines[1]));
      } catch (error) { readyReject(error); reject(error); }
    });
  }); void settled.catch(() => {});
  return { ready, write: bytes => new Promise((resolve, reject) => {
    if (closed || failure) { reject(failure ?? refused()); return; }
    child.stdin.write(bytes, error => error ? reject(error) : resolve());
  }),
    assertHeld: () => { if (!readySeen || closed || failure) throw failure ?? refused(); },
    abort: () => { terminate(Object.assign(refused(),{code:'private_windows_stream_cancelled'}));return settled.catch(error=>{if(error.code==='private_windows_stream_termination_unconfirmed')throw error;return null;}); },
    finish: bytes => { child.stdin.end(bytes); return settled; }, cancel: () => {
      if (!closed && !failure) { child.stdin.end(); cancelTimer ??= setTimeout(() => terminate(Object.assign(refused(), { code: 'private_windows_stream_cancelled' })), terminationMs); }
      return settled.catch(error => { if (error.code === 'private_windows_stream_termination_unconfirmed') throw error; return null; });
    } };
}
export function parseWindowsNativeImportReceipt(raw) {
  if(typeof raw!=='string'||Buffer.byteLength(raw)>4096)throw refused();
  let value;try{value=JSON.parse(raw);}catch{throw refused();}
  if(!value||Object.keys(value).sort().join(',')!=='controllerToken,environmentToken,exitCode,gitToken,jobSettled,mutating,namespaceFlushed,nonce,operation,protocol,rootExclusions,rootToken'
    ||value.protocol!=='devryan.windows-native-import/1'||typeof value.nonce!=='string'||!/^[a-f0-9]{32}$/.test(value.nonce)
    ||value.namespaceFlushed!==true||value.jobSettled!==true||value.exitCode!==0||typeof value.controllerToken!=='string'
    ||!['migrate','relocate-bundle-harness'].includes(value.operation)||!['none','runtime-bundle'].includes(value.rootExclusions)||typeof value.mutating!=='boolean'
    ||value.operation==='migrate'&&(value.rootExclusions!=='none'||!value.mutating||value.gitToken!==null)
    ||value.operation==='relocate-bundle-harness'&&(value.rootExclusions!=='runtime-bundle'||typeof value.gitToken!=='string'||typeof value.environmentToken!=='string'))throw refused();
  checkedTreeToken(value.rootToken);
  for(const token of [value.controllerToken,value.gitToken].filter(token=>token!==null))parseWindowsLargePrivateFile(JSON.stringify({protocol:'devryan.windows-update-file/1',token,size:Number(token.split(':')[3])}));
  if(value.environmentToken!==null)checkedTreeToken(value.environmentToken);return value;
}
export function parseWindowsNativeImportFrame(raw) {
  if(!Buffer.isBuffer(raw)||raw.length>2*1024*1024+8192)throw refused();
  const receiptEnd=raw.indexOf(10);if(receiptEnd<1||receiptEnd>4096)throw refused();
  const receipt=parseWindowsNativeImportReceipt(raw.subarray(0,receiptEnd).toString('utf8'));
  const sizesEnd=raw.indexOf(10,receiptEnd+1);if(sizesEnd<0||sizesEnd-receiptEnd>32)throw refused();
  const sizes=raw.subarray(receiptEnd+1,sizesEnd).toString('ascii');
  if(!/^(?:0|[1-9][0-9]*):(?:0|[1-9][0-9]*)$/.test(sizes))throw refused();
  const [stdoutBytes,stderrBytes]=sizes.split(':').map(Number);
  if(stdoutBytes>1024*1024||stderrBytes>1024*1024||raw.length!==sizesEnd+1+stdoutBytes+stderrBytes)throw refused();
  return {receipt,stdout:raw.subarray(sizesEnd+1,sizesEnd+1+stdoutBytes),stderr:raw.subarray(sizesEnd+1+stdoutBytes)};
}
export function beginWindowsNativeImport(launcher,{controller,controllerSha256,expectedArtifactToken,root,expectedRootToken,nativeReceipt,nonce,operation='migrate',rootExclusions='none',mutating=true,environmentRoot=root},hooks) {
  const paths=[launcher,controller,root,nativeReceipt,environmentRoot];
  if(process.platform!=='win32'||paths.some(value=>typeof value!=='string'||!/^[A-Za-z]:\\/.test(value)||path.win32.resolve(value)!==value||/[\u0000-\u001f]/.test(value))
    ||!/^[a-f0-9]{64}$/.test(controllerSha256??'')||!/^[a-f0-9]{32}$/.test(nonce??'')||path.win32.basename(nativeReceipt)!==`${nonce}.json`
    ||!['migrate','relocate-bundle-harness'].includes(operation)||!['none','runtime-bundle'].includes(rootExclusions)||typeof mutating!=='boolean'
    ||operation==='migrate'&&(rootExclusions!=='none'||!mutating)||operation==='relocate-bundle-harness'&&(rootExclusions!=='runtime-bundle'||environmentRoot===root))throw refused();
  checkedTreeToken(expectedArtifactToken);checkedTreeToken(expectedRootToken);
  const parse=raw=>{const result=parseWindowsNativeImportFrame(raw);if(result.receipt.nonce!==nonce||result.receipt.controllerToken.split(':')[2]!==controllerSha256
    ||result.receipt.operation!==operation||result.receipt.rootExclusions!==rootExclusions||result.receipt.mutating!==mutating
    ||(result.receipt.environmentToken!==null)!==(environmentRoot!==root))throw refused();return result;};
  const lease=beginWindowsPrivateOperation(launcher,['--hold-native-import',controller,controllerSha256,expectedArtifactToken,root,expectedRootToken,nativeReceipt,nonce,operation,rootExclusions,mutating?'1':'0',environmentRoot],
    'devryan.windows-native-import/1',parse,{...hooks,outputMaximum:2*1024*1024+8192,binaryResult:true});
  let written=false;
  return {ready:lease.ready,assertHeld:lease.assertHeld,writeRequest:bytes=>{
    lease.assertHeld();if(written||!Buffer.isBuffer(bytes)||bytes.length<1||bytes.length>16*1024*1024)throw refused();written=true;return lease.write(bytes);
  },finish:()=>{lease.assertHeld();if(!written)throw refused();return lease.finish();},cancel:lease.abort};
}
export function beginWindowsSqliteOutput(launcher, root, basename, hooks) {
  if (process.platform !== 'win32' || !/^[A-Za-z]:\\/.test(launcher??'') || !/^[A-Za-z]:\\/.test(root??'') || path.win32.resolve(root)!==root
    || /[\u0000-\u001f]/.test(root) || typeof basename!=='string' || basename.length>255 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(basename)
    || isWindowsPrivateControlName(basename)) throw refused();
  const lease=beginWindowsPrivateOperation(launcher,['--hold-sqlite-output',root,basename],'devryan.windows-sqlite-output/1',parseWindowsLargePrivateFile,hooks);
  return {ready:lease.ready,assertHeld:lease.assertHeld,commit:()=>lease.finish(Buffer.from('commit\n')),cancel:lease.cancel};
}

function requirePrivate(identity, type) {
  if (identity.type !== type || identity.reparsePoint || !identity.currentOwner || !identity.privateAcl
    || type === 'file' && identity.linkCount !== 1) throw refused();
  return identity;
}

export async function ensureWindowsPrivateDirectory(launcher, directory) {
  let identity;
  try { identity = await nativeFileOperation(launcher, '--create-private-directory', directory); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    identity = await nativeFileOperation(launcher, '--inspect-path', directory);
  }
  return requirePrivate(identity, 'directory');
}

export async function createWindowsPrivateFile(launcher, file, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 1048576) throw refused();
  return requirePrivate(await nativeFileOperation(launcher, '--create-private-file', file, bytes), 'file');
}

export function parseWindowsPrivateFileRead(raw, maximum = DEFAULT_PRIVATE_BYTES) {
  privateBound(maximum);
  if (!Buffer.isBuffer(raw)) throw refused();
  const end = raw.indexOf(10);
  if (end < 0 || end > 4096 || raw.length - end - 1 > maximum) throw refused();
  const identity = requirePrivate(parseWindowsFileIdentity(raw.subarray(0, end).toString('utf8')), 'file');
  return { identity, bytes: raw.subarray(end + 1) };
}

export async function readWindowsPrivateFile(launcher, file) {
  return nativeFileOperation(launcher, '--read-private-file', file);
}

/** @typedef {{protocol: 'devryan.windows-private-publication/1', status: 'published', nonce: string,
 * parentVolume: string, parentFileId: string, volume: string, fileId: string,
 * size: number, sha256: string, namespaceFlushed: true}} WindowsPrivatePublication */
/** @returns {WindowsPrivatePublication} */
export function parseWindowsPrivatePublication(raw, maximum = DEFAULT_PRIVATE_BYTES) {
  privateBound(maximum);
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 4096) throw refused();
  let value; try { value = JSON.parse(raw); } catch { throw refused(); }
  if (!value || Object.keys(value).sort().join(',') !== 'fileId,namespaceFlushed,nonce,parentFileId,parentVolume,protocol,sha256,size,status,volume'
    || value.protocol !== 'devryan.windows-private-publication/1' || value.status !== 'published' || value.namespaceFlushed !== true
    || ['parentVolume', 'volume'].some(key => typeof value[key] !== 'string' || !/^[a-f0-9]{16}$/.test(value[key]))
    || ['parentFileId', 'fileId', 'nonce'].some(key => typeof value[key] !== 'string' || !/^[a-f0-9]{32}$/.test(value[key]))
    || value.parentVolume !== value.volume || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)
    || !Number.isSafeInteger(value.size) || value.size < 0 || value.size > maximum) throw refused();
  return value;
}

export function parseWindowsPublicationState(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 4096) throw refused();
  let value; try { value = JSON.parse(raw); } catch { throw refused(); }
  if (!value || Object.keys(value).sort().join(',') !== 'nonce,protocol,status'
    || value.protocol !== 'devryan.windows-publication-state/1' || !['none', 'pending', 'published', 'deleted'].includes(value.status)
    || (value.status === 'none' ? value.nonce !== null : typeof value.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(value.nonce))) throw refused();
  return value;
}

export function parseWindowsPrivateDeletion(raw, maximum = DEFAULT_PRIVATE_BYTES) {
  privateBound(maximum);
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 4096) throw refused();
  let value; try { value = JSON.parse(raw); } catch { throw refused(); }
  if (!value || Object.keys(value).sort().join(',') !== 'namespaceFlushed,nonce,oldToken,parentFileId,parentVolume,protocol,status'
    || value.protocol !== 'devryan.windows-private-deletion/1' || value.status !== 'deleted' || value.namespaceFlushed !== true
    || typeof value.parentVolume !== 'string' || !/^[a-f0-9]{16}$/.test(value.parentVolume)
    || ['parentFileId', 'nonce'].some(key => typeof value[key] !== 'string' || !/^[a-f0-9]{32}$/.test(value[key]))
    || value.oldToken !== null && (typeof value.oldToken !== 'string' || !/^[a-f0-9]{16}:[a-f0-9]{32}:[a-f0-9]{64}:(?:0|[1-9][0-9]*)$/.test(value.oldToken)
      || value.oldToken.slice(0, 16) !== value.parentVolume || Number(value.oldToken.split(':')[3]) > maximum)) throw refused();
  return value;
}

export function parseWindowsNamespaceDurability(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 4096) throw refused();
  let value; try { value = JSON.parse(raw); } catch { throw refused(); }
  if (!value || Object.keys(value).sort().join(',') !== 'directoryFlushed,fileId,protocol,publicationQualified,volume,windowsError'
    || value.protocol !== 'devryan.windows-namespace-durability/1' || value.publicationQualified !== false
    || typeof value.volume !== 'string' || !/^[a-f0-9]{16}$/.test(value.volume)
    || typeof value.fileId !== 'string' || !/^[a-f0-9]{32}$/.test(value.fileId)
    || typeof value.directoryFlushed !== 'boolean' || !Number.isSafeInteger(value.windowsError)
    || value.windowsError < 0 || value.windowsError > 0xffffffff || value.directoryFlushed !== (value.windowsError === 0)) throw refused();
  return value;
}

export async function inspectWindowsNamespaceDurability(launcher, file) {
  return nativeFileOperation(launcher, '--inspect-namespace-durability', file);
}

export function windowsPublicationExpected(previous, maximum = DEFAULT_PRIVATE_BYTES) {
  privateBound(maximum);
  if (previous === null) return 'absent';
  const identity = requirePrivate(parseWindowsFileIdentity(JSON.stringify(previous?.identity)), 'file');
  if (!Buffer.isBuffer(previous?.bytes) || previous.bytes.length > maximum) throw refused();
  return `${identity.volume}:${identity.fileId}:${createHash('sha256').update(previous.bytes).digest('hex')}:${previous.bytes.length}`;
}

/** Constructor-only private owner. The host still verifies the launcher and
 * platform acceptance; this adapter never grants execution or updater admission. */
export function createWindowsPrivateFileOwner({ launcher, retainedPublications = 8, maxBytes = DEFAULT_PRIVATE_BYTES }) {
  privateBound(maxBytes);
  if (!Number.isSafeInteger(retainedPublications) || retainedPublications < 0 || retainedPublications > 32) throw refused();
  const operation = (name, file, bytes, args) => nativeFileOperation(launcher, name, file, bytes, args, maxBytes);
  const read = file => operation('--read-private-file', file);
  const write = async (file, bytes, { expected } = {}) => {
    if (!Buffer.isBuffer(bytes) || bytes.length > maxBytes) throw refused();
    const before = expected === undefined ? await read(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; }) : expected;
    const nonce = randomUUID().replaceAll('-', '');
    const result = await operation('--publish-private-file', file, bytes, [windowsPublicationExpected(before, maxBytes), nonce]);
    if (result.nonce !== nonce || result.size !== bytes.length || result.sha256 !== createHash('sha256').update(bytes).digest('hex')) throw refused();
    await operation('--prune-private-publications', file, undefined, [String(retainedPublications)]);
    return result;
  };
  const recover = async file => {
    const state = await operation('--inspect-private-publication', file);
    if (state.status === 'none') return null;
    const result = await operation(state.status === 'pending' ? '--recover-private-publication' : '--inspect-private-settlement', file, undefined, [state.nonce]);
    if (result.nonce !== state.nonce) throw refused();
    return result;
  };
  const remove = async (file, { expected } = {}) => {
    const before = expected === undefined ? await read(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; }) : expected;
    const expectedToken = windowsPublicationExpected(before, maxBytes), nonce = randomUUID().replaceAll('-', '');
    const result = await operation('--delete-private-file', file, undefined, [expectedToken, nonce]);
    if (result.nonce !== nonce || result.oldToken !== (expectedToken === 'absent' ? null : expectedToken)) throw refused();
    await operation('--prune-private-publications', file, undefined, [String(retainedPublications)]);
    return { ...result, backupPath: before === null ? null : path.win32.join(path.win32.dirname(file), `.DevRyan-publication-${nonce}.backup`) };
  };
  const quarantine = async (file, previous) => {
    const result = await remove(file, { expected: previous });
    if (!result.backupPath) throw refused();
    return result.backupPath;
  };
  const streamFile = async (source, target, { expectedSha256, expectedSize } = {}) => {
    if (!/^[a-f0-9]{64}$/.test(expectedSha256 ?? '') || !Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > 8 * 1024 ** 3
      || !path.win32.isAbsolute(source ?? '') || path.win32.resolve(source) !== source || await fs.realpath(source) !== source) throw refused();
    const named = await fs.lstat(source, { bigint: true });
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1n || named.size !== BigInt(expectedSize)) throw refused();
    const held = await fs.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); let stream;
    try {
      const before = await held.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.dev !== named.dev || before.ino !== named.ino || before.size !== named.size) throw refused();
      stream = beginWindowsPrivateStream(launcher, target, { offset: 0, maximum: Math.max(1, expectedSize), expected: 'absent' }); await stream.ready;
      const hash = createHash('sha256'); let bytes = 0;
      for await (const chunk of held.createReadStream({ autoClose: false, highWaterMark: 65536 })) {
        bytes += chunk.length; if (bytes > expectedSize) throw refused(); hash.update(chunk); await stream.write(chunk);
      }
      const after = await held.stat({ bigint: true }), current = await fs.lstat(source, { bigint: true });
      if (bytes !== expectedSize || hash.digest('hex') !== expectedSha256 || [after, current].some(value => !value.isFile() || value.nlink !== 1n
        || value.dev !== before.dev || value.ino !== before.ino || value.size !== before.size || value.mtimeNs !== before.mtimeNs || value.ctimeNs !== before.ctimeNs)) throw refused();
      const result = await stream.finish(); stream = null;
      if (result.size !== expectedSize || result.token.split(':')[2] !== expectedSha256) throw refused(); return result;
    } finally { try { if (stream) await stream.cancel(); } finally { await held.close(); } }
  };
  const transition = async (operation, source, destination, expected) => {
    if (!path.win32.isAbsolute(destination ?? '') || path.win32.resolve(destination) !== destination || /[\u0000-\u001f]/.test(destination)
      || typeof expected !== 'string' || !treeTokenPattern.test(expected)) throw refused();
    return nativeFileOperation(launcher, operation, source, undefined, [destination, expected]);
  };
  return Object.freeze({ maxBytes, read, write, recover, delete: remove, quarantine, ensureDirectory: directory => ensureWindowsPrivateDirectory(launcher, directory),
    createDirectory: async directory => requirePrivate(await nativeFileOperation(launcher,'--create-private-directory',directory),'directory'),
    tree: (target, options) => {
      if (options===undefined)return nativeFileOperation(launcher,'--inspect-update-tree',target);
      if (!options||Object.keys(options).join(',')!=='exclusions'||!['none','runtime-bundle'].includes(options.exclusions))throw refused();
      return nativeFileOperation(launcher,'--inspect-private-copy-tree',target,undefined,[options.exclusions]);
    },
    copyTree: async (source,destination,expected,{exclusions='none'}={}) => {
      checkedTreeToken(expected);
      if (!['none','runtime-bundle'].includes(exclusions)||!/^[A-Za-z]:\\/.test(destination??'')||path.win32.resolve(destination)!==destination||/[\u0000-\u001f]/.test(destination)) throw refused();
      const result=await nativeFileOperation(launcher,'--copy-private-tree',source,undefined,[destination,expected,exclusions]);
      if(result.sourceToken!==expected||result.exclusions!==exclusions)throw refused(); return result;
    },
    beginSqliteOutput: (root,basename)=>beginWindowsSqliteOutput(launcher,root,basename),
    beginNativeImport: options=>beginWindowsNativeImport(launcher,options),
    cloneTree: (source, destination, expected) => transition('--clone-update-tree', source, destination, expected),
    renameTree: (source, destination, expected) => transition('--rename-update-tree', source, destination, expected),
    removeTree: (target, expected) => { if (typeof expected !== 'string' || !treeTokenPattern.test(expected)) throw refused(); return nativeFileOperation(launcher, '--remove-update-tree', target, undefined, [expected]); },
    largeFile: target => nativeFileOperation(launcher, '--inspect-update-file', target), streamFile,
    renameFile: async (source, destination, expected) => {
      if (!path.win32.isAbsolute(destination ?? '') || path.win32.resolve(destination) !== destination || /[\u0000-\u001f]/.test(destination)
        || typeof expected !== 'string' || !largeFileTokenPattern.test(expected)) throw refused();
      const result = await nativeFileOperation(launcher, '--rename-private-file', source, undefined, [destination, expected]);
      if (result.token !== expected) throw refused(); return result;
    },
    truncate: async (target, length, expected) => {
      if (!Number.isSafeInteger(length) || length < 0 || length > 8 * 1024 ** 3 || typeof expected !== 'string' || !largeFileTokenPattern.test(expected)) throw refused();
      const result = await nativeFileOperation(launcher, '--truncate-private-file', target, undefined, [String(length), expected]);
      if (result.size !== length || result.token.slice(0, 49) !== expected.slice(0, 49)) throw refused(); return result;
    },
    append: async (target, bytes, { expected, offset, maximum } = {}) => {
      if (!Buffer.isBuffer(bytes) || bytes.length > 16 * 1024 * 1024) throw refused();
      const stream = beginWindowsPrivateStream(launcher, target, { expected, offset, maximum });
      try { await stream.ready; await stream.write(bytes); const result = await stream.finish();
        if (result.size !== offset + bytes.length) throw refused(); return result;
      } catch (error) { await stream.cancel(); throw error; }
    },
    prune: file => nativeFileOperation(launcher, '--prune-private-publications', file, undefined, [String(retainedPublications)]),
    launcher });
}
