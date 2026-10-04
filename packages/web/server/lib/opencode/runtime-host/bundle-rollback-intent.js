import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {BUNDLE_DOCUMENT_MAX_BYTES} from './bundle-document-limits.js';
import {createHash} from 'node:crypto';
import {NATIVE_BUNDLE_CREDENTIAL_CONTRACT} from './native-bundle-credential-contract.js';
import {isBundleCredentialOwnerEvidence} from './bundle-credential-owner-guard.js';
import { canonicalJSON, sha256, saveBundleJSON } from './bundle-migration-inventory.js';

const fail = code => Object.assign(new Error(code), { code, status: 503 });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exact=(value,keys)=>record(value)&&Object.keys(value).every(key=>keys.includes(key))&&keys.every(key=>Object.hasOwn(value,key));
const absolute=value=>typeof value==='string'&&path.isAbsolute(value)&&path.normalize(value)===value&&!/[\u0000-\u001f]/.test(value);
const identity=value=>exact(value,['pid','startIdentity'])&&Number.isSafeInteger(value.pid)&&value.pid>0&&typeof value.startIdentity==='string'&&value.startIdentity.length>0&&value.startIdentity.length<=128&&!/[\u0000-\u001f]/.test(value.startIdentity);
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
export const rollbackIntentPath = root => path.join(root, 'rollback', 'intent.json');
export function parseRollbackIntent(value) {
  if (!record(value)||Object.keys(value).some(key=>!['protocol','state','revision','candidateBundleID','targetBundleID','candidateDescriptorSha256','candidatePreparedSha256','candidateManifestSha256','targetDescriptorSha256','targetPreparedSha256','targetManifestSha256','expectedTargetCredentialSha256','nativeCredentialSha256','hostOwners','files','checkpoint','settlement','completion','resumeRevision'].includes(key)) || value.protocol !== 'devryan.bundle.rollback-intent/1'
    || !['pending', 'completed', 'resuming', 'resumed'].includes(value.state)
    || !Number.isSafeInteger(value.revision) || value.revision < 1 || !id(value.candidateBundleID) || !id(value.targetBundleID)
    || value.candidateBundleID === value.targetBundleID || !hash(value.candidateDescriptorSha256)
    || !hash(value.candidatePreparedSha256) || !hash(value.candidateManifestSha256) || !hash(value.targetDescriptorSha256)
    || !hash(value.targetManifestSha256) || !hash(value.targetPreparedSha256) || !hash(value.expectedTargetCredentialSha256) || !hash(value.nativeCredentialSha256) || !isBundleCredentialOwnerEvidence(value.hostOwners)
    || !Array.isArray(value.files) || value.files.length > 32768 || !record(value.checkpoint) || !record(value.settlement)
    || !exact(value.settlement,['host','controller','credentialDrained','storesDrained','registries'])||!identity(value.settlement.host)
    || !Number.isSafeInteger(value.settlement.host?.pid) || value.settlement.host.pid < 1
    || typeof value.settlement.host.startIdentity !== 'string' || !value.settlement.host.startIdentity
    || value.settlement.credentialDrained !== true || value.settlement.storesDrained !== true
    || !record(value.settlement.controller) || value.settlement.controller.code !== 0 || value.settlement.controller.signal !== null
    || value.settlement.controller.receipt?.terminated !== true || value.settlement.controller.receipt.confined !== true
    || value.settlement.controller.receipt.cancelled !== false || value.settlement.controller.receipt.exitCode !== 0
    || !hash(value.settlement.controller.receiptSha256)
    || !Number.isSafeInteger(value.settlement.controller.pid) || value.settlement.controller.pid < 1
    ||!identity({pid:value.settlement.controller.pid,startIdentity:value.settlement.controller.startIdentity})
    || !/^[a-f0-9-]{32,64}$/.test(value.settlement.controller.instanceID??'')
    ||!exact(value.settlement.controller,['pid','startIdentity','instanceID','code','signal','receipt','receiptSha256'])
    ||!exact(value.settlement.controller.receipt,['path','terminated','confined','cancelled','exitCode'])
    || !absolute(value.settlement.controller.receipt.path)
    ||!Array.isArray(value.settlement.registries)||value.settlement.registries.length!==2
    ||value.settlement.registries.some((row,index)=>!exact(row,['name','sha256'])||row.name!==['managed-opencode-processes.json','managed-native-provider-processes.json'][index]||!(row.sha256===null||hash(row.sha256)))) throw fail('bundle_rollback_proof_invalid');
  if (!exact(value.checkpoint,['checkpointID','ownerID','generation','databasePath','webDataDirectory','webConfigDirectory','opencodeConfigDirectory','settledAt'])||!id(value.checkpoint.checkpointID)||!id(value.checkpoint.ownerID)||value.checkpoint.ownerID!==value.candidateBundleID||value.checkpoint.generation!==2||!Number.isFinite(value.checkpoint.settledAt)||value.checkpoint.settledAt<=0
    ||['databasePath','webDataDirectory','webConfigDirectory','opencodeConfigDirectory'].some(key=>!absolute(value.checkpoint[key])))throw fail('bundle_rollback_proof_invalid');
  if (value.files.some(row => !exact(row,['path','sha256']) || typeof row.path !== 'string'||row.path.length>4096||/[\u0000-\u001f]/.test(row.path) || path.isAbsolute(row.path)
    || row.path.split('/').some(part => !part || part === '.' || part === '..') || !hash(row.sha256))
    || new Set(value.files.map(row => row.path)).size !== value.files.length) throw fail('bundle_rollback_proof_invalid');
  if (['resuming', 'resumed'].includes(value.state) && (!Number.isSafeInteger(value.resumeRevision)
    || ![value.revision+1,value.revision+2].includes(value.resumeRevision))) throw fail('bundle_rollback_proof_invalid');
  if(value.state==='completed'&&!value.completion||value.state==='pending'&&value.completion!==undefined||!['resuming','resumed'].includes(value.state)&&value.resumeRevision!==undefined)throw fail('bundle_rollback_proof_invalid');
  if (value.completion!==undefined && (!record(value.completion) || value.completion.protocol !== NATIVE_BUNDLE_CREDENTIAL_CONTRACT
    || value.completion.status !== 'projected' || value.completion.sourceBundleID !== value.candidateBundleID
    || value.completion.targetBundleID !== value.targetBundleID || value.completion.targetManifestSha256 !== value.targetManifestSha256
    || value.completion.sourceSha256 !== value.nativeCredentialSha256 || value.completion.appliedSha256 !== value.nativeCredentialSha256
    || value.completion.expectedTargetSha256 !== value.expectedTargetCredentialSha256
    ||!exact(value.completion,['protocol','status','sourceBundleID','targetBundleID','targetManifestSha256','sourceSha256','appliedSha256','expectedTargetSha256']))) throw fail('bundle_rollback_proof_invalid');
  return value;
}
export function readRollbackIntentSync(root) {
  const file = rollbackIntentPath(root);
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(file) !== file || stat.size > BUNDLE_DOCUMENT_MAX_BYTES) throw fail('bundle_rollback_proof_invalid');
  let handle;
  try {handle=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const opened=fs.fstatSync(handle);if(opened.ino!==stat.ino||opened.dev!==stat.dev)throw fail('bundle_rollback_proof_invalid');const bytes=fs.readFileSync(handle),after=fs.lstatSync(file);if(bytes.length>BUNDLE_DOCUMENT_MAX_BYTES||after.ino!==opened.ino||after.dev!==opened.dev||after.mtimeMs!==opened.mtimeMs||after.ctimeMs!==opened.ctimeMs)throw fail('bundle_rollback_proof_invalid');return parseRollbackIntent(JSON.parse(bytes)); }
  catch { throw fail('bundle_rollback_proof_invalid'); }finally{if(handle!==undefined)fs.closeSync(handle);}
}
export const rollbackIntentUnresolved = (intent, selection) => Boolean(intent && !(
  intent.state === 'completed' && selection.revision>intent.revision+1
  ||['resuming','resumed'].includes(intent.state)&&selection.revision>intent.resumeRevision
  ||intent.state === 'completed' && selection.selectedBundleID === intent.targetBundleID
    && selection.revision === intent.revision + 1 && selection.preparedManifestSha256 === intent.targetPreparedSha256 && selection.reconciliationRequired === false
  || ['resuming', 'resumed'].includes(intent.state) && selection.selectedBundleID === intent.candidateBundleID
    && selection.revision === intent.resumeRevision && selection.preparedManifestSha256 === intent.candidatePreparedSha256 && selection.reconciliationRequired === false));
export async function saveRollbackIntent(root, intent) {
  parseRollbackIntent(intent);
  await saveBundleJSON(rollbackIntentPath(root), intent);
}
export async function assertPrivateBundleControlRoot(root, uid = process.getuid?.()) {
  if (!Number.isSafeInteger(uid) || !path.isAbsolute(root) || path.normalize(root) !== root) throw fail('bundle_recovery_owner_required');
  for (const file of [root, path.join(root, 'selection.json'), path.join(root, 'rollback'), rollbackIntentPath(root)]) {
    const stat = await fs.promises.lstat(file).catch(()=>{throw fail(file===rollbackIntentPath(root)?'bundle_recovery_proof_required':'bundle_recovery_owner_required');});
    if ((file===root||file===path.join(root,'rollback')?!stat.isDirectory():!stat.isFile())||stat.isSymbolicLink() || await fs.promises.realpath(file) !== file || stat.uid !== uid
      || (stat.mode & 0o077) !== 0) throw fail('bundle_recovery_owner_required');
  }
}
export function processIdentity(pid, run = spawnSync) {
  const result = run('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
  if (result.error || result.signal || ![0, 1].includes(result.status)) throw fail('bundle_recovery_process_unavailable');
  const text = String(result.stdout ?? '').trim().replace(/\s+/g, ' ');
  if (result.status === 1 && !text) return null;
  if (result.status !== 0 || !text || text.length > 128) throw fail('bundle_recovery_process_unavailable');
  return { pid, startIdentity: text };
}
export async function assertRollbackPhysicalExit(intent, candidate, readIdentity = processIdentity) {
  const { host, controller } = intent.settlement;
  for (const original of [host, controller]) {
    const current = await readIdentity(original.pid);
    if (current?.startIdentity === original.startIdentity) throw fail('bundle_recovery_original_process_active');
  }
  const expected = path.join(path.dirname(candidate.launch.opencodeDatabasePath), '..', '.native-controller', controller.instanceID, 'termination.json');
  if (path.normalize(controller.receipt.path) !== path.normalize(expected)) throw fail('bundle_rollback_proof_invalid');
  if(await fs.promises.realpath(controller.receipt.path).catch(()=>null)!==controller.receipt.path)throw fail('bundle_recovery_exit_unverified');
  const receipt = JSON.parse(await readClosureFile(controller.receipt.path,1024));
  if (sha256(canonicalJSON(receipt)) !== controller.receiptSha256 || receipt.terminated !== true || receipt.confined !== true
    || receipt.exitCode !== 0 || receipt.cancelled !== false) throw fail('bundle_recovery_exit_unverified');
  if(canonicalJSON(await captureRollbackRegistries(candidate.launch.global.state))!==canonicalJSON(intent.settlement.registries))throw fail('bundle_recovery_exit_unverified');
}

/** Closed B inventory, bounded in count/bytes; WAL index and owner scratch/logs
 * are transient. Durable DB/WAL, history, credentials and metadata remain pinned. */
export async function captureRollbackFiles(root){
 const rows=[];let directories=0,total=0;
 const walk=async(directory,relative='')=>{
  if(++directories>8192||await fs.promises.realpath(directory)!==directory)throw fail('bundle_recovery_inventory_invalid');
  for(const entry of (await fs.promises.readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
   const name=relative?relative+'/'+entry.name:entry.name,file=path.join(directory,entry.name);
   if(name==='.native-controller'||/^global\/(log|tmp|cache)(\/|$)/.test(name)||name==='opencode/opencode.db-shm'
    ||/(^|\/)[^/]+\.tmp-[^/]+$/.test(name)||['web-data/orchestration/owner.lock','web-data/harness/provider-recovery/runtime-owner.lock'].includes(name)
    ||/^web-data\/harness\/session-mutations\/[a-f0-9]{64}\/(context-cache(\/|$)|owner\.lock|git\/index[^/]*)$/.test(name)
    ||/^web-data\/harness\/(provider-recovery|context)\/[^/]+\.lock$/.test(name))continue;
   const stat=await fs.promises.lstat(file);if(stat.isSymbolicLink())throw fail('bundle_recovery_inventory_invalid');
   if(stat.isDirectory()){await walk(file,name);continue;}
   if(!stat.isFile()||rows.length>=32768||(total+=stat.size)>16*1024**3)throw fail('bundle_recovery_inventory_invalid');
   const handle=await fs.promises.open(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
   try{const before=await handle.stat(),digest=createHash('sha256');for await(const chunk of handle.createReadStream({autoClose:false}))digest.update(chunk);
    const after=await fs.promises.lstat(file);if(before.ino!==stat.ino||before.dev!==stat.dev||after.ino!==before.ino||after.dev!==before.dev||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw fail('bundle_recovery_inventory_invalid');
    rows.push({path:name,sha256:digest.digest('hex')});
   }finally{await handle.close();}
  }
 };await walk(root);return rows;
}

async function readClosureFile(file,max){
 const stat=await fs.promises.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>max||await fs.promises.realpath(file)!==file)throw fail('bundle_recovery_exit_unverified');
 const handle=await fs.promises.open(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const before=await handle.stat(),bytes=await handle.readFile(),after=await fs.promises.lstat(file);if(bytes.length>max||stat.ino!==before.ino||stat.dev!==before.dev||after.ino!==before.ino||after.dev!==before.dev||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw fail('bundle_recovery_exit_unverified');return bytes;}finally{await handle.close();}
}
/** Original registries supplement supervised group termination; a missing
 * registry is recorded as absence, never interpreted as an ACK. */
export async function captureRollbackRegistries(stateDirectory){
 if(!absolute(stateDirectory)||await fs.promises.realpath(stateDirectory)!==stateDirectory)throw fail('bundle_recovery_exit_unverified');
 const rows=[];for(const name of ['managed-opencode-processes.json','managed-native-provider-processes.json']){
  const file=path.join(stateDirectory,name);let bytes;try{bytes=await readClosureFile(file,1024*1024);}catch(error){if(error.code!=='ENOENT')throw error;}
  if(bytes){let value;try{value=JSON.parse(bytes);}catch{throw fail('bundle_recovery_exit_unverified');}if(!record(value)||![1,2].includes(value.version)||!Array.isArray(value.processes)||value.processes.length)throw fail('bundle_recovery_exit_unverified');}
  rows.push({name,sha256:bytes?sha256(bytes):null});
 }return rows;
}
