import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {armCompiledRollbackCrash,withRollbackProofControl} from './package-cold-recovery.mjs';

const cache=path.resolve('.cache/v2-validation');await fs.mkdir(cache,{recursive:true});
async function fixture(){
 const root=await fs.mkdtemp(path.join(cache,'cold-recovery-control-')),digest='a'.repeat(64),candidateRoot=path.join(root,'bundles/B');
 await fs.mkdir(path.join(root,'rollback'),{mode:0o700});
 const candidate={bundleID:'B',sourceBundleID:'A',launch:{opencodeDatabasePath:path.join(candidateRoot,'opencode/opencode.db'),artifactManifestSha256:digest}};
 const intent={protocol:'devryan.bundle.rollback-intent/1',state:'pending',revision:2,candidateBundleID:'B',targetBundleID:'A',candidateDescriptorSha256:digest,candidatePreparedSha256:digest,candidateManifestSha256:digest,targetDescriptorSha256:digest,targetPreparedSha256:digest,targetManifestSha256:digest,expectedTargetCredentialSha256:digest,nativeCredentialSha256:digest,
  hostOwners:{protocol:'devryan.bundle.credential-owners/2',sha256:digest,accountDirectories:{}},files:[{path:'opencode/opencode.db',sha256:digest}],
  checkpoint:{checkpointID:'checkpoint',ownerID:'B',generation:2,databasePath:candidate.launch.opencodeDatabasePath,webDataDirectory:path.join(candidateRoot,'web-data'),webConfigDirectory:path.join(candidateRoot,'config/openchamber'),opencodeConfigDirectory:path.join(candidateRoot,'config/opencode'),settledAt:1},
  settlement:{host:{pid:12,startIdentity:'fixture host'},controller:{pid:13,startIdentity:'fixture controller',instanceID:'00000000-0000-4000-8000-000000000001',code:0,signal:null,receipt:{path:path.join(candidateRoot,'.native-controller/00000000-0000-4000-8000-000000000001/termination.json'),terminated:true,confined:true,cancelled:false,exitCode:0},receiptSha256:digest},credentialDrained:true,storesDrained:true,registries:[{name:'managed-opencode-processes.json',sha256:null},{name:'managed-native-provider-processes.json',sha256:null}]}};
 const child=new EventEmitter(),signals=[];child.pid=12;child.kill=signal=>{signals.push(signal);return true;};
 const ready=()=>child.emit('message',{type:'application-rollback-crash-ready',revision:2,bundleID:'B',result:{status:'passed',mode:'rollback-crash',candidateSessionID:'ses_fixture'}});
 const publish=async(value=intent)=>{const temp=path.join(root,'rollback/pending.tmp');await fs.writeFile(temp,JSON.stringify(value)+'\n',{mode:0o600});await fs.rename(temp,path.join(root,'rollback/intent.json'));};
 return {root,intent,candidate,child,signals,ready,publish,options:{child,controlRoot:root,candidate,revision:2,hostStartIdentity:'fixture host'}};
}
async function observed(work){let timer;try{return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Watcher did not settle')),2000);})]);}finally{clearTimeout(timer);}}
test('pending-intent crash probe kills only its exact original host after real-file publication',async()=>{
 const f=await fixture(),probe=armCompiledRollbackCrash(f.options);
 try{
  f.ready();assert.deepEqual(f.signals,[]);await f.publish();const result=await observed(probe.ready);
  assert.deepEqual(f.signals,['SIGKILL']);assert.equal(result.crashProof.host.pid,f.child.pid);assert.equal(result.crashProof.revision,2);assert.equal(result.crashProof.checkpointID,'checkpoint');assert.match(result.crashProof.intentSha256,/^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.root,'rollback/intent.json'),'utf8')),f.intent);
 }finally{probe.close();await fs.rm(f.root,{recursive:true,force:true});}
});
test('foreign original process and missed intent barrier fail without any crash signal',async()=>{
 for(const mode of ['foreign','missed']){
  const f=await fixture(),probe=armCompiledRollbackCrash(f.options);
  try{
   f.ready();const rejected=assert.rejects(observed(probe.ready));
   if(mode==='foreign'){const changed=structuredClone(f.intent);changed.settlement.host.pid=99;await f.publish(changed);}else f.child.emit('close',0,null);
   await rejected;assert.deepEqual(f.signals,[]);
  }finally{probe.close();await fs.rm(f.root,{recursive:true,force:true});}
 }
});
test('missing and changed proof controls restore original inode bytes and private mode even on failure',async()=>{
 const f=await fixture();await f.publish();const file=path.join(f.root,'rollback/intent.json'),original=await fs.readFile(file),before=await fs.lstat(file);
 try{
  for(const kind of ['missing','changed']){
   await assert.rejects(withRollbackProofControl({controlRoot:f.root,kind},async()=>{
    if(kind==='missing')await assert.rejects(fs.stat(file),{code:'ENOENT'});
    else{const changed=JSON.parse(await fs.readFile(file,'utf8'));assert.notEqual(changed.candidatePreparedSha256,f.intent.candidatePreparedSha256);assert.deepEqual(changed.checkpoint,f.intent.checkpoint);}
    throw Error('negative fixture result');
   }),/negative fixture result/);
   const after=await fs.lstat(file);assert.equal(after.ino,before.ino);assert.equal(after.mode,before.mode);assert.deepEqual(await fs.readFile(file),original);assert.deepEqual(await fs.readdir(path.dirname(file)),['intent.json']);
  }
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
test('negative proof cleanup never overwrites an unexpected concurrent replacement',async()=>{
 const f=await fixture();await f.publish();const file=path.join(f.root,'rollback/intent.json');
 try{
  await assert.rejects(withRollbackProofControl({controlRoot:f.root,kind:'changed'},()=>fs.writeFile(file,'unexpected replacement')),/Negative control proof changed concurrently/);
  assert.equal(await fs.readFile(file,'utf8'),'unexpected replacement');
  const backup=(await fs.readdir(path.dirname(file))).find(name=>name.startsWith('.intent-control-'));assert.ok(backup);assert.deepEqual(JSON.parse(await fs.readFile(path.join(path.dirname(file),backup),'utf8')),f.intent);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
