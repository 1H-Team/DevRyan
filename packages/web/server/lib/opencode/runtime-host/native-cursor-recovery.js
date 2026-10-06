import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {writeFileAtomic,withCrossProcessFileLock} from '../../../../../harness-runtime/lib/atomic-file.js';
import {readSessionExecutionReceipt} from '../../../../../harness-runtime/lib/session-execution.js';
import {credentialMutationFingerprint as fingerprint} from './native-credential-mutation-owner.js';

const fail=code=>Object.assign(new Error(code),{code,status:503,statusCode:503});
const fields=['controllerInstanceID','directory','sessionID','userMessageID','assistantMessageID','agent','modelID','variant'];
const checked=value=>{
 if(!value||value.version!==1||typeof value.ownerID!=='string'||!value.scope||Object.keys(value.scope).some(key=>!fields.includes(key))
  ||Object.keys(value).some(key=>!['version','ownerID','scope','revision','phase','leaseToken','leaseGeneration'].includes(key))
  ||fields.filter(key=>key!=='variant').some(key=>typeof value.scope[key]!=='string'||!value.scope[key]||value.scope[key].length>4096)
  ||value.scope.variant!==undefined&&(typeof value.scope.variant!=='string'||value.scope.variant.length>256)
  ||!path.isAbsolute(value.scope.directory)||!Number.isSafeInteger(value.revision)||value.revision<0
  ||!['pending','starting','bound'].includes(value.phase)||value.phase==='bound'&&(typeof value.leaseToken!=='string'
   ||!Number.isSafeInteger(value.leaseGeneration)||value.leaseGeneration<0))throw fail('native_cursor_recovery_invalid');
 return value;
};

/** Write-ahead lifecycle identities only. Existing ledger and launcher receipts
 * remain the sole process/publication authority. An uncertain intent is retained. */
export function createNativeCursorRecovery({directory,ownerID,runtime,windowsOwner,windowsLauncher}){
 if(!path.isAbsolute(directory)||typeof ownerID!=='string'||!ownerID)throw fail('native_cursor_recovery_configuration');
 const pending=new Set();
 const ensureDirectory=async()=>{
  if(process.platform==='win32'){
   if(typeof windowsOwner?.ensureDirectory!=='function')throw fail('private_windows_publication_authority_unavailable');
   await windowsOwner.ensureDirectory(directory);return;
  }
  let existing=directory;
  for(;;){try{const stat=await fs.lstat(existing);
    if(!stat.isDirectory()||await fs.realpath(existing)!==existing)throw fail('native_cursor_recovery_path_invalid');break;
   }catch(error){if(error.code!=='ENOENT')throw error;const parent=path.dirname(existing);if(parent===existing)throw fail('native_cursor_recovery_path_invalid');existing=parent;}}
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  if(await fs.realpath(directory)!==directory)throw fail('native_cursor_recovery_path_invalid');
 };
 const key=scope=>createHash('sha256').update(`${scope.directory}\0${scope.sessionID}\0${scope.assistantMessageID}`).digest('hex');
 const file=scope=>path.join(directory,`${key(scope)}.json`);
 const observed=new Map();
 const read=async name=>{
  if(process.platform==='win32'){
   if(typeof windowsOwner?.read!=='function')throw fail('private_windows_read_authority_unavailable');
   let prior;try{prior=await windowsOwner.read(name);}catch(error){if(error.code==='ENOENT'){observed.set(name,null);return null;}throw error;}
   if(prior.bytes.length>64*1024)throw fail('native_cursor_recovery_invalid');
   const value=checked(JSON.parse(prior.bytes.toString('utf8')));
   if(value.ownerID!==ownerID||name!==file(value.scope))throw fail('native_cursor_recovery_owner_mismatch');
   observed.set(name,prior);return value;
  }
  let stat;try{stat=await fs.lstat(name);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  if(!stat.isFile()||stat.size>64*1024)throw fail('native_cursor_recovery_invalid');
  const value=checked(JSON.parse(await fs.readFile(name,'utf8')));
  if(value.ownerID!==ownerID||name!==file(value.scope))throw fail('native_cursor_recovery_owner_mismatch');return value;
 };
 const locked=(scope,action)=>{
  checked({version:1,ownerID,scope,revision:0,phase:'pending'});
  const operation=(async()=>{if(await fs.realpath(scope.directory)!==scope.directory)throw fail('native_cursor_recovery_path_invalid');await ensureDirectory();
   return withCrossProcessFileLock(path.join(directory,'.lock'),()=>action(file(scope)),{windowsLauncher});})();
  pending.add(operation);void operation.finally(()=>pending.delete(operation)).catch(()=>{});return operation;
 };
 const save=async(name,value)=>{
  const bytes=Buffer.from(JSON.stringify(checked(value))+'\n');
  if(process.platform==='win32'){await windowsOwner.write(name,bytes,{expected:observed.get(name)});observed.delete(name);return;}
  await writeFileAtomic(name,bytes,{mode:0o600,directoryMode:0o700});
 };
 const remove=async name=>{
  if(process.platform==='win32'){await windowsOwner.delete(name,{expected:observed.get(name)});observed.delete(name);return;}
  await fs.rm(name);
 };
 const change=(scope,action)=>locked(scope,async name=>{
  const value=await read(name);if(!value||fingerprint(value.scope)!==fingerprint(scope))throw fail('native_cursor_recovery_scope_invalid');
  return action(name,value);
 });
 return {
  stage:({scope,revision})=>locked(scope,async name=>{
   const existing=await read(name);
   if(existing){if(fingerprint(existing.scope)!==fingerprint(scope)||existing.revision!==revision)throw fail('native_cursor_recovery_scope_invalid');return;}
   if((await fs.readdir(directory)).filter(name=>/^[a-f0-9]{64}\.json$/.test(name)).length>=128)throw fail('native_cursor_recovery_limit');
   await save(name,{version:1,ownerID,scope,revision,phase:'pending'});
  }),
  starting:scope=>change(scope,async(name,value)=>{
   if(value.phase!=='pending')throw fail('native_cursor_recovery_phase_invalid');await save(name,{...value,phase:'starting'});
  }),
  bind:(scope,lease)=>change(scope,async(name,value)=>{
   if(value.phase!=='starting'||lease.scope.sessionID!==scope.sessionID||lease.scope.messageID!==scope.assistantMessageID
    ||lease.scope.userMessageID!==scope.userMessageID||lease.scope.callID!==`cursor_${scope.assistantMessageID}`)throw fail('native_cursor_recovery_scope_invalid');
   await save(name,{...value,phase:'bound',leaseToken:lease.token,leaseGeneration:lease.generation});
  }),
  complete:scope=>change(scope,name=>remove(name)),
  async recover({directory:projectDirectory,settle}){
   await Promise.allSettled([...pending]);
   if(await fs.realpath(projectDirectory)!==projectDirectory)throw fail('native_cursor_recovery_path_invalid');await ensureDirectory();
   const names=await fs.readdir(directory);if(names.filter(name=>/^[a-f0-9]{64}\.json$/.test(name)).length>128)throw fail('native_cursor_recovery_limit');
   for(const name of names.filter(name=>/^[a-f0-9]{64}\.json$/.test(name)).sort()){
    const value=await read(path.join(directory,name));if(!value||value.scope.directory!==projectDirectory)continue;
    await change(value.scope,async(filename,current)=>{
     const scope=current.scope,callID=`cursor_${scope.assistantMessageID}`;
     const lease=await runtime.leaseForCall({directory:scope.directory,sessionID:scope.sessionID,callID});
     if(lease){
      if(current.phase==='pending'||current.phase==='bound'&&(lease.token!==current.leaseToken||lease.generation!==current.leaseGeneration)
       ||lease.directory!==scope.directory||lease.scope.sessionID!==scope.sessionID||lease.scope.userMessageID!==scope.userMessageID
       ||lease.scope.messageID!==scope.assistantMessageID||lease.scope.callID!==callID
       ||lease.executionKind!=='process'||!['published','cancelled'].includes(lease.state))throw fail('native_cursor_recovery_termination_unconfirmed');
      if(!lease.cancelledBeforeStart){const receipt=await readSessionExecutionReceipt(lease,{launcher:windowsLauncher});
       if(receipt.terminated!==true||receipt.confined!==true)throw fail('native_cursor_recovery_termination_unconfirmed');}
     }else if(current.phase!=='pending'){
      const [outcome]=await runtime.executionOutcomes({directory:scope.directory,sessionID:scope.sessionID,calls:[{callID,messageID:scope.assistantMessageID}]});
      if(outcome?.outcome!=='never_started')throw fail('native_cursor_recovery_termination_unconfirmed');
     }
     await settle(scope,current.revision);await remove(filename);
    });
   }
  },
  async drain(){const settled=await Promise.allSettled([...pending]);const errors=settled.filter(row=>row.status==='rejected').map(row=>row.reason);
   if(errors.length)throw new AggregateError(errors,'native_cursor_recovery_drain_failed');},
 };
}
