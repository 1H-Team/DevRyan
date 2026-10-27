import { expect, test } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCursorSdkRuntime } from '@devryan/cursor-sdk-runtime';
import { createManagedTaskScheduler } from '@devryan/orchestration-runtime';
import { createSessionExecutionOwner } from '../../../../../harness-runtime/lib/session-execution-owner.js';
import { executionSignal } from '../../../../../harness-runtime/lib/execution-admission.js';
import { createNativeAdmissionOwner } from './native-admission-owner.js';
import { createNativeCursorOwner } from './native-cursor-owner.js';
import { credentialMutationFingerprint as fingerprint } from './native-credential-mutation-owner.js';
import { createNativeConsumerFixture } from '../test-native-consumer-client.js';
import { createWebManagedOpenCodeExecutor } from '../../orchestration/open-code-executor.js';

test('parent Stop cancels Cursor preparation and persists cancellation before making the task terminal', async () => {
 const directory=realpathSync(mkdtempSync(join(tmpdir(),'devryan-cursor-parent-stop-')));
 const preparing=Promise.withResolvers(),cleaning=Promise.withResolvers(),cleanup=Promise.withResolvers();
 let processLease,claims=0,finished=false,scheduler;const records=[],events=[];
 const ledger={registerNativeSession:async()=>{},nativeAdmissionState:async()=>({revision:0,held:false}),
  capturedSessionState:async()=>({captured:true,pending:false,generation:1}),
  leaseForCall:async scope=>scope.sessionID==='ses_root'
   ? {directory,generation:1,executionKind:'control',preparation:'none',state:'published',scope:{sessionID:'ses_root',callID:'call_parent'}}
   : processLease,
  reserve:async input=>(processLease={token:'lease_process',directory,generation:1,state:'preparing',scope:input}),
  prepare:async()=>{const signal=executionSignal();preparing.resolve();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));signal.throwIfAborted();},
  claimLease:async()=>{claims++;throw Error('Cancelled preparation must not launch');},
  cancelUnstartedCall:async()=>{cleaning.resolve();await cleanup.promise;processLease.state='cancelled';},
  cleanupLease:async()=>true,
 };
 const execution=createSessionExecutionOwner({runtime:ledger,launcher:'/fixture/launcher',verifyLauncher:async()=>true,stopSessions:async()=>{throw Error('Unused provider stop');}});
 const native=createNativeAdmissionOwner({directory,ownerID:'fixture',runtime:ledger,
  withSessionLock:async(_ids,action)=>action(),
  getSession:async id=>({id,directory,...id==='ses_child'?{parentID:'ses_root'}:{},agent:'explorer',model:{providerID:'cursor-acp',id:'composer-2.5'}}),
  authorizeOperation:async()=>{throw Error('Unowned operation');},
  verifyManagedTaskDispatch:input=>input.operation==='settle'
   ? scheduler.verifyTaskSettlement(input.taskId,input.leaseToken) : scheduler.verifyTaskDispatch(input.taskId,input.leaseToken),
 });
 const controller={instanceID:'fixture',call:async({action,record,accepted:_accepted,...input})=>{
  if(action==='cursor-record-owned'){
   await cursorOwner.assertRecord({...input,recordFingerprint:fingerprint(record)});
   if(record.info.time?.completed){expect(scheduler.getTask('dvr_task_fixture').status).toBe('starting');expect(processLease.state).toBe('cancelled');}
   records.push(record);return {messageID:record.info.id};
  }
  expect(action).toBe('cursor-settle-owned');await cursorOwner.assertSettlement(input);
 }};
 const cursorOwner=createNativeCursorOwner({instanceID:'fixture',admissionOwner:native,runtime:ledger,
  controller:()=>controller,isReady:()=>true,abortAndWait:sessionID=>sdk.abortAndWait(sessionID),onStarted:async()=>{},
 });
 const sdk=createCursorSdkRuntime({storageDir:directory,env:{},readAuth:()=>({'cursor-acp':{key:'synthetic-fixture'}}),
  loadSdk:async()=>({Cursor:{models:{list:async()=>[{id:'composer-2.5'}]}}}),getWorkspaceDiff:async()=>'',
  emitEvent:event=>events.push(event),logger:{error:()=>{},warn:()=>{},info:()=>{}},
  ownedPrompt:({modelSelection:_selection,...scope})=>{
   const metadata={devryan:{v:1,origin:'native',agent:'explorer',providerID:'cursor-acp',modelID:'composer-2.5',planMode:false,parts:[{kind:'text',length:7}],admission:{v:1,fingerprint:'a'.repeat(64)}}};
   return native.withAcceptedOperation({sessionID:scope.sessionID,messageID:scope.userMessageID,fingerprint:'a'.repeat(64),metadata,
    request:{id:scope.userMessageID,text:'Inspect',metadata,delivery:'queue'}},()=>cursorOwner.ownedPrompt(scope));
  },
  onPersistRecord:input=>cursorOwner.persist(input),
  executionAdapter:{beforePrompt:async()=>null,start:input=>cursorOwner.withExecution(input,()=>execution.start({...input,
   userMessageID:input.messageID,messageID:input.assistantMessageID,callID:`cursor_${input.assistantMessageID}`}))},
 });
 const client=createNativeConsumerFixture({baseUrl:()=> 'http://fixture/',headers:()=>({}),readFixture:async(url,init={})=>{
  const pathname=new URL(url).pathname;
  if(pathname==='/session'&&init.method==='POST')return Response.json({id:'ses_child'});
  if(pathname==='/session/ses_child')return Response.json({id:'ses_child',directory});
  throw Error(`Unexpected fixture request ${pathname}`);
 }});
 const executor=createWebManagedOpenCodeExecutor({openCodeClient:client,cursorSdkRuntime:sdk,cursorReadOnly:true,
  nativeTaskDispatch:(scope,action)=>native.withManagedTaskDispatch(scope,action),pollIntervalMs:1,idleStablePolls:1,
 });
 scheduler=createManagedTaskScheduler({executor,createTaskId:()=> 'dvr_task_fixture',createLeaseToken:()=> 'dvr_lease_fixture',abortTimeoutMs:1000});
 try{
  const task=await scheduler.submit({idempotencyKey:'fixture',rootSessionId:'ses_root',parentTaskId:null,directory,mode:'orchestrator',
   dispatchCallId:'call_parent',providerId:'cursor-acp',modelId:'composer-2.5',agent:'explorer',variant:null,readOnly:true,label:'Inspect',prompt:'Inspect',timeoutAt:null});
  await preparing.promise;
  const stopped=scheduler.cancelTask(task.taskId).finally(()=>{finished=true;});
  await cleaning.promise;await Promise.resolve();
  expect(finished).toBe(false);expect(claims).toBe(0);expect(sdk.getSessionStatus().ses_child.type).toBe('busy');
  expect(events.some(event=>event.type==='session.status'&&event.properties.status.type==='idle')).toBe(false);
  await expect(scheduler.verifyTaskDispatch(task.taskId,'dvr_lease_fixture')).rejects.toMatchObject({code:'native_managed_task_lease_invalid'});
  cleanup.resolve();
  expect((await stopped).status).toBe('aborted');
  expect(records.at(-1).info.finish).toBe('cancelled');expect(records.at(-1).parts).toEqual([]);
  expect(events.filter(event=>event.type==='session.error')).toEqual([]);
  expect(events.filter(event=>event.type==='session.status').at(-1).properties.status.type).toBe('idle');
  await expect(scheduler.verifyTaskSettlement(task.taskId,'dvr_lease_fixture')).rejects.toMatchObject({code:'native_managed_task_lease_invalid'});
 }finally{cleanup.resolve();await sdk.dispose();await cursorOwner.close();native.dispose();await scheduler.shutdown();rmSync(directory,{recursive:true,force:true});}
},5000);
