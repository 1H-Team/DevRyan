import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createCursorHttpProvider} from './opencode-v2-native/cursor-http-provider.mjs';
import {createCompiledCursorFixture} from './opencode-v2-native/compiled-cursor-fixture.mjs';
import {repositoryRoot,captureNativeAcceptanceSource} from './opencode-v2-native/artifacts.mjs';
import {fixtureSha256} from './opencode-v2-native/migration-fixture.mjs';
import {createV2MessageId} from '../packages/web/server/lib/opencode/v2/admission.js';
import {readSessionExecutionReceipt} from '../packages/harness-runtime/lib/session-execution.js';
import {resolveSqliteDriver} from '../packages/web/server/lib/opencode/db-maintenance-core.js';
import {waitFor} from './opencode-v2-native/process-lanes.mjs';
import {createRunRoot} from './qa/run-root.mjs';

const evidence=error=>({code:error.code??error.name,message:error.message,...error.missingCatalog?{missingCatalog:error.missingCatalog}:{},...error.errors?{causes:Array.from(error.errors,evidence)}:{}});
export async function runCompiledCursorDiagnostic({artifactRoot}){
 const run=createRunRoot({parent:path.join(repositoryRoot,'.cache/v2-validation'),prefix:'compiled-cursor-',owner:'scripts/verify-opencode-v2-cursor.mjs'});
 const root=await fs.realpath(run.dir),source=await captureNativeAcceptanceSource();
 const observations=[],diagnostics=[],cases=[],cleanupFailures=[];let fixture,provider,failure,selectedApiKey='owned-loopback-account-b';
 const originalBackend=process.env.CURSOR_BACKEND_URL;
 try{
  artifactRoot=await fs.realpath(artifactRoot);assert.ok(artifactRoot.startsWith(repositoryRoot+path.sep));
  provider=await createCursorHttpProvider({hold:true,expectedApiKey:()=>selectedApiKey,
   models:[{id:'composer-2.5',displayName:'Owned Composer'},{id:'auto',displayName:'Owned Auto'}],
   onRequest:row=>observations.push({phase:'cursor_http',at:Date.now(),...row})});
  // The original SDK's parent-side catalog client reads this same setting as
  // its worker. Keep every transport in this disposable process on loopback.
  process.env.CURSOR_BACKEND_URL=provider.baseURL;
  fixture=await createCompiledCursorFixture({root,artifactRoot,provider,observations,diagnostics});
  const {client,host,managed,runtimeOwner,directory,cursor}=fixture;
  const active=async()=>{const response=await fetch(new URL('/api/session/active',fixture.controller().url),{headers:runtimeOwner.getAuthHeaders()});
   assert.equal(response.status,200);return (await response.json()).data;};
  const begin=async id=>{
   const session=await client.sessions.create({title:id,agent:'orchestrator',model:{providerID:'cursor-acp',modelID:'composer-2.5'}},{directory});
   await managed.admitPrimary(session.id);
   const userMessageID=createV2MessageId();
   await client.prompts.prompt(session.id,{messageID:userMessageID,agent:'orchestrator',model:{providerID:'cursor-acp',modelID:'composer-2.5'},variant:'default',
    parts:[{id:`prt_${id}`,type:'text',text:`Owned Cursor ${id}`}]},{directory,origin:'native_acceptance'});
   const assistant=await waitFor(()=>client.sessions.messages(session.id,{}, {directory}),page=>page.records.find(row=>row.info.role==='assistant'
    &&row.info.parentID===userMessageID&&row.parts.some(part=>part.type==='text'&&part.text==='Owned Cursor transport reply')),
    'Original Cursor SDK partial transcript did not reach native REST');
   const record=assistant.records.find(row=>row.info.role==='assistant'&&row.info.parentID===userMessageID);
   await waitFor(active,value=>value[session.id]?.type==='running','Native HTTP omitted live Cursor execution');
   const primary=await managed.readPrimaryRecord(session.id);assert.equal(primary.anchorID,userMessageID);assert.equal(primary.instanceID,fixture.controller().instanceID);
   const lease=await host.runtime.leaseForCall({directory,sessionID:session.id,callID:`cursor_${record.info.id}`});assert.equal(lease.state,'ready');assert.equal(lease.executionKind,'process');
   return {id,sessionID:session.id,userMessageID,assistantMessageID:record.info.id,lease};
  };
  const settled=async(turn,{interrupted=false}={})=>{
   const lease=await waitFor(()=>host.runtime.leaseForCall({directory,sessionID:turn.sessionID,callID:`cursor_${turn.assistantMessageID}`}),
    value=>['published','cancelled'].includes(value?.state),'Real Cursor lease did not settle');
   const receipt=await readSessionExecutionReceipt(lease);assert.equal(receipt.terminated,true);assert.equal(receipt.confined,true);
   assert.equal(lease.token,turn.lease.token);
   const page=await waitFor(()=>client.sessions.messages(turn.sessionID,{}, {directory}),value=>value.records.find(row=>row.info.id===turn.assistantMessageID)?.info.time.completed,
    'Receipt-backed native Cursor assistant remained unfinished');
   const assistant=page.records.find(row=>row.info.id===turn.assistantMessageID);
   assert.equal(page.records.filter(row=>row.info.role==='user').length,1);assert.equal(page.records.filter(row=>row.info.role==='assistant').length,1);
   if(interrupted)assert.deepEqual(assistant.info.error,{name:'MessageAbortedError',data:{v2Type:'aborted',message:'Cursor execution interrupted'}});
   await waitFor(active,value=>!value[turn.sessionID],'Native HTTP kept settled Cursor execution active');
   const db=resolveSqliteDriver().open(fixture.descriptor.launch.opencodeDatabasePath,{readonly:true});
   try{const native=db.prepare('SELECT idle_outcome,time_suspended,resume_attempts FROM session_v2 WHERE id=?').get(turn.sessionID);
    assert.equal(native.time_suspended,null);assert.equal(native.resume_attempts,0);if(interrupted)assert.equal(native.idle_outcome,'interrupted');
   }finally{db.close();}
   observations.push({phase:'cursor_supervisor_verified',sessionID:turn.sessionID,assistantMessageID:turn.assistantMessageID,leaseState:lease.state,receipt});
   return {lease,receipt,assistant};
  };
  const normal=await begin('cursor-complete');
  await assert.rejects(client.prompts.prompt(normal.sessionID,{agent:'build',model:{providerID:'cursor-acp',modelID:'composer-2.5'},parts:[{type:'text',text:'Blocked busy selection'}]},{directory}),
   error=>error.code==='selection_change_while_busy');
  provider.release();const completed=await settled(normal);assert.equal(completed.lease.state,'published');assert.equal(completed.receipt.cancelled,false);
  cases.push({id:normal.id,status:'passed',source:'original-sdk-real-supervisor-native-http-primary',...normal,lease:undefined});
  const stopped=await begin('cursor-stop');
  await host.executions.cancelAndWait({directory,sessions:[stopped.sessionID]});await settled(stopped,{interrupted:true});
  cases.push({id:stopped.id,status:'passed',sessionID:stopped.sessionID,assistantMessageID:stopped.assistantMessageID});
  const reverted=await begin('cursor-revert');
  const transaction=await host.coordinator.revert({directory,sessionID:reverted.sessionID,messageID:reverted.userMessageID,scope:'tree'});
  assert.equal(transaction.verification.ok,true);assert.equal(transaction.revert.messageID,reverted.userMessageID);
  const revertedLease=await host.runtime.leaseForCall({directory,sessionID:reverted.sessionID,callID:`cursor_${reverted.assistantMessageID}`});
  const revertedReceipt=await readSessionExecutionReceipt(revertedLease);assert.equal(revertedReceipt.terminated,true);assert.equal(revertedReceipt.confined,true);
  assert.equal(revertedLease.state,'cancelled');assert.equal((await active())[reverted.sessionID],undefined);
  cases.push({id:reverted.id,status:'passed',sessionID:reverted.sessionID,transactionID:transaction.verification.transactionID});
  const crashed=await begin('cursor-controller-replacement'),old=fixture.controller();
  const exit=await old.killForRecovery();assert.equal(old.hasExited(),true);
  observations.push({phase:'cursor_controller_crash',sessionID:crashed.sessionID,instanceID:old.instanceID,pid:old.pid,...exit});
  const replacement=await runtimeOwner.start();assert.notEqual(replacement.instanceID,old.instanceID);
  await settled(crashed,{interrupted:true});
  const requestsBefore=observations.filter(row=>row.pathname==='/agent.v1.AgentService/RunSSE').length;
  assert.equal(requestsBefore,4,'Replacement unexpectedly started another Cursor inference');
  const recoveryPath=path.join(fixture.descriptor.launch.webDataDirectory,'harness/native-cursor');
  assert.deepEqual((await fs.readdir(recoveryPath)).filter(name=>name.endsWith('.json')),[]);
  cases.push({id:crashed.id,status:'passed',sessionID:crashed.sessionID,oldInstanceID:old.instanceID,newInstanceID:replacement.instanceID});
  await fixture.selectAccount(fixture.accountA);selectedApiKey='owned-loopback-account-a';
  const fresh=await begin('cursor-after-replacement');provider.release();await settled(fresh);
  const exchanges=observations.filter(row=>row.pathname==='/auth/exchange_user_api_key');assert.ok(exchanges.length>0);
  assert.equal(exchanges.every(row=>row.selectedCredentialObserved===true),true);
  cases.push({id:fresh.id,status:'passed',sessionID:fresh.sessionID,source:'fresh-supervised-capacity-after-controller-replacement'});
  const beforeReadonly=await client.sessions.messages(fresh.sessionID,{}, {directory}),inferencesBefore=observations.filter(row=>row.pathname==='/agent.v1.AgentService/RunSSE').length;
  const verified=await cursor.verifyConnection({directory});assert.equal(verified.ok,true);assert.equal(verified.configured,true);
  assert.equal(observations.findLast(row=>row.pathname==='/v1/me')?.selectedCredentialObserved,true);
  assert.equal(observations.filter(row=>row.pathname==='/agent.v1.AgentService/RunSSE').length,inferencesBefore);
  cases.push({id:'cursor-readonly-verify',status:'passed',source:'original-sdk-current-native-account'});
  const appendsBefore=observations.filter(row=>row.pathname==='/aiserver.v1.BidiService/BidiAppend').length;
  const readonlyReceiptsBefore=observations.filter(row=>row.phase==='cursor_readonly_receipt').length;
  const titleWork=cursor.generateTitle({sessionID:fresh.sessionID,directory,text:'Owned title context'});void titleWork.catch(()=>{});
  await waitFor(()=>observations.filter(row=>row.pathname==='/aiserver.v1.BidiService/BidiAppend').length,
   value=>value>appendsBefore,'Original Cursor title did not reach owned transport');provider.release();
  assert.equal(await titleWork,'Owned Cursor transport reply');
  const titleReceipts=observations.filter(row=>row.phase==='cursor_readonly_receipt').slice(readonlyReceiptsBefore);assert.equal(titleReceipts.length,1);
  assert.equal(titleReceipts[0].sessionID,fresh.sessionID);assert.equal(titleReceipts[0].directory,directory);assert.equal(titleReceipts[0].kind,'title');
  assert.equal(titleReceipts[0].receipt.terminated,true);assert.equal(titleReceipts[0].receipt.confined,true);
  assert.equal(titleReceipts[0].receipt.cancelled,false);assert.equal(titleReceipts[0].receipt.exitCode,0);
  assert.equal(observations.filter(row=>row.pathname==='/agent.v1.AgentService/RunSSE').length,inferencesBefore+1);
  assert.deepEqual(await client.sessions.messages(fresh.sessionID,{}, {directory}),beforeReadonly);
  assert.equal((await active())[fresh.sessionID],undefined);
  assert.equal(observations.filter(row=>row.pathname==='/auth/exchange_user_api_key').every(row=>row.selectedCredentialObserved===true),true);
  await assert.rejects(cursor.verifyConnection({directory:path.join(directory,'unowned')}),{code:'native_cursor_readonly_scope_required'});
  await assert.rejects(cursor.generateTitle({sessionID:reverted.sessionID,directory,text:'Refused reverted title'}),{code:'native_cursor_readonly_scope_required'});
  cases.push({id:'cursor-readonly-title',status:'passed',sessionID:fresh.sessionID,source:'original-sdk-real-readonly-supervisor-transcript-isolated'});
 }catch(error){failure=evidence(error);}
 finally{
  try{await fixture?.close();}catch(error){cleanupFailures.push(evidence(error));}
  try{await provider?.close();}catch(error){cleanupFailures.push(evidence(error));}
  if(originalBackend===undefined)delete process.env.CURSOR_BACKEND_URL;else process.env.CURSOR_BACKEND_URL=originalBackend;
 }
 const after=await captureNativeAcceptanceSource(),result={schema:1,diagnostic:true,artifactRoot,root,cases,observations,diagnostics,cleanupFailures,
  source,sourceUnchanged:source.sourceDigest===after.sourceDigest,...failure?{failure}: {}};
 await fs.writeFile(path.join(root,'result.json'),JSON.stringify(result,null,2)+'\n');
 run.finish(failure||cleanupFailures.length?'failed':'passed');
 const resultSha256=fixtureSha256(await fs.readFile(path.join(root,'result.json')));
 console.log(JSON.stringify({root,cases:cases.length,failure,cleanupFailures,sourceUnchanged:result.sourceUnchanged,resultSha256}));
 if(failure||cleanupFailures.length)process.exitCode=1;return result;
}
if(import.meta.url===pathToFileURL(process.argv[1]).href){
 const at=process.argv.indexOf('--artifact-root');assert.ok(at>=0&&process.argv[at+1],'--artifact-root is required');
 await runCompiledCursorDiagnostic({artifactRoot:path.resolve(process.argv[at+1])});
}
