import {afterEach,expect,it} from 'vitest';
import {createManagedTaskRecord,createManagedTaskResultEnvelope} from '@devryan/orchestration-runtime';
import {createWebManagedOrchestrationRuntime} from './runtime.js';
import {createNativeManagedTaskOwner} from '../opencode/runtime-host/managed-task-owner.js';
import {createNativeManagedPublicationReader} from '../opencode/runtime-host/native-managed-publication-owner.js';

const cleanups=[];afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
async function fixture(limits,{count=2,report=index=>'Verified child report '+index+'\n'+'x'.repeat(30*1024),harnessPolicies={waitAny:true,compactResults:false}}={}){
 const tasks=Array.from({length:count},(_,offset)=>offset+1).map(index=>({...createManagedTaskRecord({taskId:'dvr_task_v2_'+index,idempotencyKey:'task-'+index,rootSessionId:'ses_root',parentTaskId:null,
  childSessionId:'ses_child_'+index,directory:'/project',sequence:index,mode:'orchestrator',providerId:'fixture',modelId:'fixture',agent:'explorer',variant:null,
  label:'Result '+index,prompt:'Inspect '+index,attempt:1,priorTaskId:null,executionKind:'start',createdAt:1,timeoutAt:null}),
  status:'completed',startedAt:2,finishedAt:3,partial:false,failureReason:null,recoverablePreview:report(index),canonicalRefs:[{type:'message',id:'msg_child_'+index}]}));
 let saved={version:1,tasks,resultEnvelopes:tasks.map(task=>createManagedTaskResultEnvelope(task,{sequence:task.sequence+10,createdAt:4,resumable:false}))};
 const runtime=createWebManagedOrchestrationRuntime({persistence:{load:async()=>structuredClone(saved),save:async value=>{saved=structuredClone(value);}},
  executor:{start:async()=>{throw Error('Terminal fixture cannot launch');}},now:()=>100,harnessPolicies});
 await runtime.initialize();cleanups.push(()=>runtime.shutdown());
 const cancellation=new AbortController();let committedObserver;
 let configuration={controllerInstanceID:'controller',configurationDigest:'a'.repeat(64)},primary={directory:'/project',stepID:'msg_wait',anchorID:'msg_objective',cancellationGeneration:0,revision:1,
  nativeStepWitness:{attempt:{traceID:'b'.repeat(32),spanID:'c'.repeat(16)}}},calls=0;
 const messages=[];
 const step=id=>{if(messages.some(message=>message.info.id===id))id+='_'+primary.revision;
  primary={...primary,stepID:id,revision:primary.revision+1};messages.push({info:{id,sessionID:'ses_root',role:'assistant'},parts:[]});};step('msg_wait');
 const admissionOwner={recheckExecution:async input=>{if(input.messageID!==primary.stepID)throw Error('stale native tool');},withPermit:async(_input,action)=>{
   const result=await action();if(result?.resultEnvelope?.action||result?.committed===true)committedObserver?.();return result;},
  withManagedResultRead:async(_input,action)=>action(),withManagedTaskCatalogInvocation:async(_input,action)=>action()};
 const publication=createNativeManagedPublicationReader({readConfiguration:()=>configuration,recheckExecution:input=>admissionOwner.recheckExecution(input),
  readPrimaryRecord:async()=>structuredClone(primary),readMessages:async()=>messages});
 const createOwner=()=>createNativeManagedTaskOwner({admissionOwner,taskContext:{authorizeNativeTaskInvocation:async()=>({readOnly:false,objectiveID:primary.anchorID})},
  readResultPublication:publication,readToolOutputLimits:()=>limits,getManagedRuntime:()=>runtime});
 let owner=createOwner();
 const invoke=async(input,{publish=true,truncated=false}={})=>{
  const callID='call_'+(++calls),part={type:'tool',tool:'devryan_task',callID,state:{status:'running',input}};messages.at(-1).parts.push(part);
  const invocation={tool:'devryan_task',sessionID:'ses_root',directory:'/project',messageID:primary.stepID,callID,input,permit:{token:'private'},nativeAttempt:primary.nativeStepWitness.attempt,
   authorization:{input:{provenance:{kind:'plugin',id:'devryan.managed-task'}}}};
  try{const result=await owner(invocation,{signal:cancellation.signal});if(publish)part.state={status:'completed',input,output:JSON.stringify(result),metadata:{truncated}};return result;}
  catch(error){part.state={status:'error',input};throw error;}
 };
 return {runtime,tasks,invoke,step,restart:()=>{owner=createOwner();},afterCommit:observer=>{committedObserver=observer;},stop:()=>cancellation.abort(Error('Stopped after durable commit')),change:kind=>{
  if(kind==='configuration')configuration={...configuration,configurationDigest:'e'.repeat(64)};
  else if(kind==='controller')configuration={...configuration,controllerInstanceID:'replaced'};
  else primary={...primary,revision:primary.revision+1,...kind==='objective'?{anchorID:'msg_unrelated'}:{cancellationGeneration:1}};
 }};
}
// The 30 KiB fixture reports exceed one inline page, so at least one later read Step remains.
const collect=async f=>{
 const waited=await f.invoke({action:'wait_any',task_ids:f.tasks.map(task=>task.taskId),until:'settled'});
 let cursors=waited.results.map(result=>({task_id:result.task.taskId,result_cursor:result.resultReference.nextCursor})),reply;
 expect(cursors.every(read=>read.result_cursor)).toBe(true);
 while(cursors.length){
  f.step('msg_read');reply=await f.invoke({action:'read_result',reads:cursors});
  cursors=reply.results.filter(row=>row.resultReference.nextCursor).map(row=>({task_id:row.taskId,result_cursor:row.resultReference.nextCursor}));
 }
 return reply;
};
it('actual scheduler v2 batch pages publish before a later Step commits ordered lean dispositions; duplicates bind exact action identity',async()=>{
 const f=await fixture();await collect(f);
 const args={action:'continue',task_ids:f.tasks.map(task=>task.taskId)};
 expect((await f.invoke(args)).failed.map(row=>row.code)).toEqual(['native_task_later_review_step_required','native_task_later_review_step_required']);
 f.step('msg_review');const result=await f.invoke(args);
 expect(result.failed).toEqual([]);expect(result.notProcessed).toEqual([]);expect(result.committed.map(row=>row.taskId)).toEqual(args.task_ids);
 f.step('msg_duplicate');expect((await f.invoke(args)).committed).toEqual(result.committed);
 await expect(f.invoke({action:'abandon',task_id:args.task_ids[0]})).rejects.toThrow('disposition_conflict');
 f.change('objective');expect((await f.invoke(args)).failed.every(row=>row.code==='native_task_disposition_conflict')).toBe(true);
});
it.each(['configuration','controller','objective','generation'])('owning publication reader and real scheduler reject %s changes without acknowledgement',async kind=>{
 const f=await fixture();await collect(f);f.step('msg_review');f.change(kind);
 const result=await f.invoke({action:'continue',task_ids:f.tasks.map(task=>task.taskId)});
 expect(result.committed).toEqual([]);expect(result.failed.every(row=>row.code==='native_task_publication_scope_changed')).toBe(true);
 for(const task of f.tasks)expect((await f.runtime.handleRpc({method:'status',params:{taskId:task.taskId,rootSessionId:'ses_root',directory:'/project'}})).resultEnvelope.action).toBeNull();
});
it('native truncation/undelivered output and restart cannot manufacture collection; explicit recollection restores the same envelopes',async()=>{
 const f=await fixture();const waited=await f.invoke({action:'wait',task_id:f.tasks[0].taskId},{truncated:true});f.step('msg_read');
 await expect(f.invoke({action:'read_result',task_id:f.tasks[0].taskId,result_cursor:waited.resultReference.nextCursor})).rejects.toThrow('not_published');
 f.restart();f.step('msg_new_review');expect((await f.invoke({action:'continue',task_ids:[f.tasks[0].taskId]})).failed[0].code).toBe('native_task_wait_required');
 f.step('msg_recollect');await collect(f);f.step('msg_final_review');expect((await f.invoke({action:'continue',task_ids:f.tasks.map(task=>task.taskId)})).committed).toHaveLength(2);
});
it('bulk continue reports the first durable commit truthfully when Stop/post-operation failure fences the remaining tasks',async()=>{
 const f=await fixture();await collect(f);f.step('msg_review');f.afterCommit(()=>{f.stop();throw Error('Post-operation observer failed');});
 const reply=await f.invoke({action:'continue',task_ids:f.tasks.map(task=>task.taskId)});
 expect(reply.committed.map(row=>row.taskId)).toEqual([f.tasks[0].taskId]);expect(reply.failed).toEqual([]);expect(reply.notProcessed).toEqual([f.tasks[1].taskId]);
 for(const [index,task] of f.tasks.entries())expect((await f.runtime.handleRpc({method:'status',params:{taskId:task.taskId,rootSessionId:'ses_root',directory:'/project'}})).resultEnvelope.action).toBe(index===0?'continue':null);
});
it('scalar v2 acknowledgement returns its durable truth receipt after a post-operation configuration fence',async()=>{
 const f=await fixture();await collect(f);f.step('msg_review');f.afterCommit(()=>{f.change('configuration');throw Error('Configuration replaced after commit');});
 const reply=await f.invoke({action:'continue',task_id:f.tasks[0].taskId});
 expect(reply).toMatchObject({committed:true,taskId:f.tasks[0].taskId,action:'continue',projectionError:'native_task_post_commit_fenced'});
 expect((await f.runtime.handleRpc({method:'status',params:{taskId:f.tasks[0].taskId,rootSessionId:'ses_root',directory:'/project'}})).resultEnvelope.action).toBe('continue');
});

it('a terminal status collects like wait, so read_result and a receipt-only continue follow it',async()=>{
 const f=await fixture();const id=f.tasks[0].taskId;
 const status=await f.invoke({action:'status',task_id:id});
 expect(Buffer.byteLength(status.resultReference.text)).toBe(24*1024);expect(status.resultReference.nextCursor).toEqual(expect.any(String));
 f.step('msg_read');const page=await f.invoke({action:'read_result',task_id:id,result_cursor:status.resultReference.nextCursor});
 expect(page.resultReference.complete).toBe(true);expect(status.resultReference.text+page.resultReference.text).toBe(f.tasks[0].recoverablePreview);
 f.step('msg_review');
 expect(await f.invoke({action:'continue',task_id:id})).toEqual({committed:true,taskId:id,envelopeId:expect.any(String),action:'continue'});
});
it('wait results inline complete first pages without per-result capabilities or lineage bookkeeping',async()=>{
 const f=await fixture(undefined,{report:index=>'Short report '+index});
 const waited=await f.invoke({action:'wait_any',task_ids:f.tasks.map(task=>task.taskId),until:'settled'});
 expect(waited.results.map(row=>[row.resultReference.text,row.resultReference.complete])).toEqual([['Short report 1',true],['Short report 2',true]]);
 for(const row of waited.results){
  expect(row).not.toHaveProperty('capabilities');
  for(const field of ['recoveryLineageId','sequence','dispatchWaveId','priorTaskId','executionKind'])expect(row.task).not.toHaveProperty(field);
  expect(row.task).toMatchObject({taskId:expect.any(String),agent:'explorer',label:expect.any(String),childSessionId:expect.any(String),dispatchCallId:null});
 }
 f.step('msg_review');expect((await f.invoke({action:'continue',task_ids:f.tasks.map(task=>task.taskId)})).committed).toHaveLength(2);
});
// Orchestrator Steps from a settled wave to its committed disposition.
const settleWave=async f=>{
 const ids=f.tasks.map(task=>task.taskId);
 let steps=1,reply=await f.invoke({action:'wait_any',task_ids:ids,until:'settled'});
 expect(reply.settled).toBe(true);expect(reply.notReturnedTaskIds??[]).toEqual([]);expect(reply.results).toHaveLength(ids.length);
 let reads=reply.results.filter(row=>row.resultReference.nextCursor).map(row=>({task_id:row.task.taskId,result_cursor:row.resultReference.nextCursor}));
 while(reads.length){
  steps++;f.step('msg_read');reply=await f.invoke({action:'read_result',reads});expect(reply.failed).toEqual([]);
  reads=[...reply.results.filter(row=>row.resultReference.nextCursor).map(row=>({task_id:row.taskId,result_cursor:row.resultReference.nextCursor})),
   ...reads.filter(read=>reply.notProcessed.includes(read.task_id))];
 }
 steps++;f.step('msg_review');expect((await f.invoke({action:'continue',task_ids:ids})).committed.map(row=>row.taskId)).toEqual(ids);
 return steps;
};
// Typical 6 KiB child reports with default policies; larger waves add one read Step per 48 KiB reply.
it.each([[2,2],[5,2],[8,3]])('a settled wave of %i finished children commits in %i orchestrator Steps',async(count,expected)=>{
 const f=await fixture(undefined,{count,report:index=>`**Child ${index}**\n`+'r'.repeat(6*1024),harnessPolicies:{waitAny:true,compactResults:true}});
 const steps=await settleWave(f);
 expect(steps).toBe(expected);expect(steps).toBeLessThanOrEqual(3);
});
