import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createNativeCursorOwner} from '../../packages/web/server/lib/opencode/runtime-host/native-cursor-owner.js';
import {verifyExecutionArtifacts} from '../../packages/web/server/lib/opencode/execution-artifacts.js';
import {startReadOnlySessionExecution} from '../../packages/harness-runtime/lib/session-execution.js';

/** Actual accepted supervisor proof for the readonly owner's close boundary.
 * The scoped key authorization is fixture-owned; this is not full native account parity. */
export async function verifyCursorReadOnlyShutdown(){
 const cache=path.resolve('.cache/v2-validation');await fs.mkdir(cache,{recursive:true});
 const root=await fs.realpath(await fs.mkdtemp(path.join(cache,'cursor-readonly-close-')));
 const artifacts=await verifyExecutionArtifacts({directory:path.resolve('packages/web/runtime',`${process.platform}-${process.arch}`)});
 let handle,receipt,resolveStarted;
 const started=new Promise(resolve=>{resolveStarted=resolve;});
 const owner=createNativeCursorOwner({instanceID:'readonly-fixture',isReady:()=>true,admissionOwner:{},runtime:{},
  controller:()=>({instanceID:'readonly-fixture',call:async({action,...input})=>{
   assert.equal(action,'cursor-readonly-key-owned');await owner.assertReadOnlyKey(input);
   return {key:'synthetic-fixture-key',credentialID:'cred_fixture',expectedFingerprint:'a'.repeat(64)};
  }}),abortAndWait:async()=>{},onStarted:async()=>{}});
 const work=owner.withReadOnly({kind:'title',directory:root,sessionID:'ses_owned'},{revision:0,recheck:async()=>{}},async()=>{
  handle=await owner.withReadOnlyExecution(()=>startReadOnlySessionExecution({launcher:artifacts.launcher,
   storage:path.join(root,'readers'),socketDirectory:null,workerBrowsers:false,command:'/bin/sh',args:['-c','printf ready; exec /bin/sleep 30'],
   env:{PATH:'/usr/bin:/bin'},onOutput:({stream,data})=>{if(stream==='stdout'&&data.toString().includes('ready'))resolveStarted();}}));
  receipt=await handle.result;
  if(receipt.cancelled)throw Object.assign(Error('Fixture readonly interrupted'),{code:'execution_cancelled'});
 });
 const rejected=assert.rejects(work,error=>error.code==='execution_cancelled');
 try{
  await Promise.race([started,new Promise((_resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Actual readonly process did not start')),10_000);timer.unref();})]);
  const pid=handle.child.pid;assert.ok(pid>0);process.kill(pid,0);
  await owner.close();await rejected;
  assert.equal(receipt.terminated,true);assert.equal(receipt.confined,true);assert.equal(receipt.cancelled,true);
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  const evidence={schema:1,root,pid,receipt,scope:'fixture-original-grant-real-accepted-supervisor'};
  await fs.writeFile(path.join(root,'result.json'),JSON.stringify(evidence,null,2)+'\n');return evidence;
 }finally{
  if(handle){handle.cancel();await handle.result.catch(()=>{});}
  await work.catch(()=>{});await owner.close();
 }
}
if(import.meta.url===pathToFileURL(process.argv[1]).href)console.log(JSON.stringify(await verifyCursorReadOnlyShutdown()));
