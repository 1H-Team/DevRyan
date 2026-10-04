import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {watch,readFileSync} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {readRollbackIntentSync,rollbackIntentPath,assertRollbackPhysicalExit,captureRollbackFiles} from '../../packages/web/server/lib/opencode/runtime-host/bundle-rollback-intent.js';
import {readRuntimeBundleBinding} from '../../packages/web/server/lib/opencode/runtime-host/runtime-bundle-binding.js';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=code=>Object.assign(new Error(code),{code});
const coldDriver=fileURLToPath(new URL('./package-cold-recovery-driver.mjs',import.meta.url));
const cli=fileURLToPath(new URL('../../packages/web/bin/cli.js',import.meta.url));

/** Observe the real transition's atomic pending intent and crash its exact host.
 * A missed barrier fails this qualification; no checkpoint or ACK is invented. */
export function armCompiledRollbackCrash({child,controlRoot,candidate,revision,hostStartIdentity}){
 let watcher,timer,done=false,driverEvidence,resolve,reject;
 const ready=new Promise((yes,no)=>{resolve=yes;reject=no;});void ready.catch(()=>{});
 const finish=(error,result)=>{
  if(done)return;done=true;watcher?.close();clearTimeout(timer);child.off('message',message);child.off('close',closed);
  if(error)reject(error);else resolve(result);
 };
 const check=()=>{
  if(done||!driverEvidence)return;
  try{
   const intent=readRollbackIntentSync(controlRoot);if(!intent)return;
   assert.equal(intent.state,'pending','Original rollback pending-intent crash barrier was missed');
   assert.equal(intent.revision,revision);assert.equal(intent.candidateBundleID,candidate.bundleID);assert.equal(intent.targetBundleID,candidate.sourceBundleID);
   assert.equal(intent.candidateManifestSha256,candidate.launch.artifactManifestSha256);
   assert.equal(intent.checkpoint.databasePath,candidate.launch.opencodeDatabasePath);
   assert.equal(intent.settlement.host.pid,child.pid);assert.equal(intent.settlement.host.startIdentity,hostStartIdentity);
   const intentSha256=hash(readFileSync(rollbackIntentPath(controlRoot)));
   assert.equal(child.kill('SIGKILL'),true,'Original rollback host could not be stopped at its pending intent');
   finish(null,{driverEvidence,crashProof:{intentSha256,revision,candidateBundleID:intent.candidateBundleID,targetBundleID:intent.targetBundleID,
    checkpointID:intent.checkpoint.checkpointID,host:intent.settlement.host,controller:intent.settlement.controller,
    source:'observed-original-production-rollback-pending-intent-after-physical-controller-settlement'}});
  }catch(error){finish(error);}
 };
 const message=value=>{
  if(value?.type!=='application-rollback-crash-ready')return;
  try{
   assert.equal(driverEvidence,undefined);assert.equal(value.result?.mode,'rollback-crash');assert.equal(value.result?.status,'passed');
   assert.equal(value.revision,revision);assert.equal(value.bundleID,candidate.bundleID);
   assert.ok(Buffer.byteLength(JSON.stringify(value))<=65536);driverEvidence=value.result;
   timer=setTimeout(()=>finish(fail('compiled_rollback_crash_barrier_timeout')),45000);check();
  }catch(error){finish(error);}
 };
 const closed=()=>finish(fail('compiled_rollback_crash_barrier_missed'));
 child.on('message',message);child.once('close',closed);
 try{watcher=watch(path.dirname(rollbackIntentPath(controlRoot)),(_event,name)=>{if(name==null||name.toString()==='intent.json')check();});watcher.on('error',error=>finish(error));}
 catch(error){finish(error);}
 return {ready,close:()=>finish(fail('compiled_rollback_crash_probe_closed'))};
}

/** Negative controls temporarily hide the original inode, then restore that
 * same inode, bytes and mode. Only the deliberately invalid copy is written. */
export async function withRollbackProofControl({controlRoot,kind},action){
 assert.ok(['missing','changed'].includes(kind));const file=rollbackIntentPath(controlRoot),original=await fs.readFile(file),stat=await fs.lstat(file);
 assert.ok(stat.isFile()&&!stat.isSymbolicLink());const backup=path.join(path.dirname(file),'.intent-control-'+randomUUID());
 await fs.rename(file,backup);let replacement;
 try{
  if(kind==='changed'){
   const value=JSON.parse(original);value.candidatePreparedSha256=(value.candidatePreparedSha256[0]==='a'?'b':'a')+value.candidatePreparedSha256.slice(1);
   replacement=Buffer.from(JSON.stringify(value)+'\n');await fs.writeFile(file,replacement,{flag:'wx',mode:stat.mode&0o777});
  }
  return await action();
 }finally{
  if(replacement){assert.deepEqual(await fs.readFile(file),replacement,'Negative control proof changed concurrently');await fs.unlink(file);}
  // link is exclusive: a concurrent replacement is never overwritten.
  await fs.link(backup,file);await fs.unlink(backup);
  const restored=await fs.lstat(file);assert.equal(restored.ino,stat.ino);assert.equal(restored.dev,stat.dev);assert.equal(restored.mode,stat.mode);assert.deepEqual(await fs.readFile(file),original);
 }
}

async function runProcess({args,environment,directory,input,timeoutMs=60000}){
 const child=spawn(process.execPath,args,{cwd:directory,env:environment,stdio:['pipe','pipe','pipe']});
 const output=[],errors=[];let outputBytes=0,errorBytes=0,timedOut=false,overflow=false,force;
 const terminate=()=>{child.kill('SIGTERM');force??=setTimeout(()=>child.kill('SIGKILL'),5000);};
 child.stdout.on('data',chunk=>{outputBytes+=chunk.length;if(outputBytes>65536){overflow=true;terminate();}else output.push(chunk);});
 child.stderr.on('data',chunk=>{errorBytes+=chunk.length;if(errorBytes<=1024*1024)errors.push(chunk);else{overflow=true;terminate();}});
 child.stdin.on('error',()=>{});child.stdin.end(input===undefined?'':JSON.stringify(input));
 const timer=setTimeout(()=>{timedOut=true;terminate();},timeoutMs);
 let exit;
 try{exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({pid:child.pid,code,signal}));});}
 finally{clearTimeout(timer);clearTimeout(force);}
 assert.equal(timedOut,false,'Cold recovery process exceeded its deadline');assert.equal(overflow,false,'Cold recovery process exceeded its bounded output');
 return {...exit,stdout:Buffer.concat(output).toString('utf8'),stderr:Buffer.concat(errors).toString('utf8')};
}

/** Fresh production recovery entry, actual CLI refusals and exact Resume B.
 * No normal app owner or feature controller is constructed by this helper. */
export async function runCompiledColdBundleRecovery({controlRoot,environment,directory,crashProof,beforeResume}){
 const proofFile=rollbackIntentPath(controlRoot),beforeProof=await fs.readFile(proofFile);
 assert.equal(hash(beforeProof),crashProof.intentSha256);const intent=readRollbackIntentSync(controlRoot);
 assert.equal(intent.state,'pending');assert.equal(intent.candidateBundleID,crashProof.candidateBundleID);
 const binding=readRuntimeBundleBinding({DEVRYAN_RUNTIME_BUNDLE_ROOT:controlRoot},{allowHeldInspection:true});
 assert.equal(binding.admission,'held');assert.equal(binding.selection.revision,crashProof.revision);assert.equal(binding.descriptor.bundleID,crashProof.candidateBundleID);
 await assertRollbackPhysicalExit(intent,binding.descriptor);
 const candidateRoot=path.dirname(binding.descriptor.preparedManifestPath),beforeFiles=await captureRollbackFiles(candidateRoot);
 const selectionFile=path.join(controlRoot,'selection.json'),selection=await fs.readFile(selectionFile);
 const unchanged=async()=>{
  assert.deepEqual(await fs.readFile(selectionFile),selection,'Refused recovery changed selection');
  assert.deepEqual(await fs.readFile(proofFile),beforeProof,'Refused recovery changed original transition proof');
  assert.deepEqual(await captureRollbackFiles(candidateRoot),beforeFiles,'Refused recovery changed retained B');
  await assertRollbackPhysicalExit(intent,binding.descriptor);
 };
 const cold=await runProcess({args:[coldDriver],environment,directory,input:{expectedRevision:crashProof.revision,candidateBundleID:crashProof.candidateBundleID}});
 await fs.writeFile(path.join(directory,'application-cold-recovery.log'),cold.stderr,{mode:0o600});
 assert.equal(cold.code,0);assert.equal(cold.signal,null);const inspected=JSON.parse(cold.stdout);assert.equal(inspected.status,'passed');await unchanged();
 const desktopRecovery=await beforeResume?.({controlRoot,environment,directory,crashProof,status:inspected});await unchanged();
 const cliRun=async revision=>{
  const result=await runProcess({args:[cli,'runtime','bundle','resume','--expected-revision',String(revision),'--json'],environment,directory});
  assert.equal(result.signal,null);return {...result,value:JSON.parse(result.stdout)};
 };
 const controls=[];
 for(const [kind,expectedCode] of [['stale','bundle_selection_revision_conflict'],['missing','bundle_recovery_proof_required'],['changed','bundle_recovery_candidate_changed']]){
  const result=kind==='stale'?await cliRun(crashProof.revision+1):await withRollbackProofControl({controlRoot,kind},()=>cliRun(crashProof.revision));
  assert.equal(result.code,2);assert.deepEqual(result.value,{status:'error',error:{code:expectedCode,message:expectedCode}});await unchanged();
  controls.push({kind,code:result.code,errorCode:expectedCode,pid:result.pid});
 }
 const resumed=await cliRun(crashProof.revision);assert.equal(resumed.code,0);assert.equal(resumed.value.status,'success');
 assert.equal(resumed.value.state,'restart_required');assert.equal(resumed.value.bundleID,crashProof.candidateBundleID);assert.equal(resumed.value.revision,crashProof.revision+1);
 const selected=readRuntimeBundleBinding({DEVRYAN_RUNTIME_BUNDLE_ROOT:controlRoot});assert.equal(selected.descriptor.bundleID,crashProof.candidateBundleID);assert.notEqual(selected.admission,'held');
 assert.equal(readRollbackIntentSync(controlRoot).state,'resumed');
 assert.deepEqual(await captureRollbackFiles(candidateRoot),beforeFiles,'Successful resume changed retained B data');
 await assertRollbackPhysicalExit(intent,binding.descriptor);
 return {status:'passed',mode:'cold-recovery',inspection:{...inspected,pid:cold.pid,code:cold.code,signal:cold.signal},controls,resumed:{...resumed.value,pid:resumed.pid,code:resumed.code},
  ...(desktopRecovery===undefined?{}:{desktopRecovery}),
  retainedCandidateUnchanged:true,originalProofSha256:crashProof.intentSha256,source:'fresh-server-index-held-entry-and-real-noninteractive-CLI-original-proof-refusal-and-resume'};
}
