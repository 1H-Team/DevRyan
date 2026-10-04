import {expect,test} from 'bun:test';
import {createManagedTaskScheduler} from './scheduler.js';
const input={idempotencyKey:'prompt-context',rootSessionId:'ses_root',directory:'/workspace',mode:'orchestrator',providerId:'fixture',modelId:'model',agent:'explorer',variant:null,label:'Exact child',prompt:'Exact objective',timeoutAt:null};
async function fixture(){
 let durable=null,refuse=false;const persistence={load:async()=>durable,save:async value=>{if(refuse)throw new Error('durable_commit_refused');durable=structuredClone(value);}};
 const scheduler=createManagedTaskScheduler({persistence,executor:{start:async(_task,control)=>{await control.setChildSessionId('ses_child');await control.markAccepted();return {status:'completed',recoverablePreview:'Exact result'};},abort:async()=>({aborted:true}),reconcile:async()=>({state:'unavailable'})}});
 const task=await scheduler.submit(input);await scheduler.waitForTask(task.taskId);await scheduler.flush();
 return {scheduler,task,persistence,get durable(){return durable},refuse:()=>{refuse=true}};
}

test('prompt-observed terminal CAS persists exact attempt/revision without collecting result or changing cursor',async()=>{
 const f=await fixture();try{
  const original=f.scheduler.getResultEnvelope(f.task.taskId);let checks=0;
  const scope={rootSessionId:'ses_root',directory:'/workspace',authorize:async()=>{checks++}};
  await f.scheduler.withNativePromptContext(scope,async state=>state.markPromptObserved({taskId:f.task.taskId,attempt:original.attempt,sequence:original.sequence}));
  const envelope=f.scheduler.getResultEnvelope(f.task.taskId);expect(envelope).toMatchObject({action:null,acknowledgedAt:null,sequence:original.sequence,promptObserved:{attempt:original.attempt,sequence:original.sequence}});expect(checks).toBe(2);
  expect(f.durable.resultEnvelopes[0].promptObserved).toEqual(envelope.promptObserved);
  await expect(f.scheduler.withNativePromptContext(scope,async state=>state.markPromptObserved({taskId:f.task.taskId,attempt:99,sequence:original.sequence}))).rejects.toMatchObject({code:'native_prompt_context_revision_conflict'});
  await expect(f.scheduler.withNativePromptContext({...scope,directory:'/foreign'},async()=>{})).rejects.toMatchObject({code:'native_prompt_context_fenced'});
  const replacement=createManagedTaskScheduler({persistence:f.persistence,executor:{start:async()=>{throw new Error('unexpected_start')},reconcile:async()=>({state:'unavailable'})}});
  try{await replacement.initialize();expect(replacement.getResultEnvelope(f.task.taskId).promptObserved).toEqual(envelope.promptObserved);}finally{await replacement.shutdown();}
 }finally{await f.scheduler.shutdown();}
});

test('revocation before commit and durable save failure retain unobserved result',async()=>{
 const f=await fixture();try{
  const envelope=f.scheduler.getResultEnvelope(f.task.taskId);let checks=0;
  await expect(f.scheduler.withNativePromptContext({rootSessionId:'ses_root',directory:'/workspace',authorize:async()=>{if(++checks===2)throw new Error('original_grant_revoked')}},async state=>state.markPromptObserved({taskId:f.task.taskId,attempt:envelope.attempt,sequence:envelope.sequence}))).rejects.toThrow('original_grant_revoked');
  expect(f.scheduler.getResultEnvelope(f.task.taskId).promptObserved).toBeUndefined();
  f.refuse();await expect(f.scheduler.withNativePromptContext({rootSessionId:'ses_root',directory:'/workspace',authorize:async()=>{}},async state=>state.markPromptObserved({taskId:f.task.taskId,attempt:envelope.attempt,sequence:envelope.sequence}))).rejects.toThrow('durable_commit_refused');
  expect(f.scheduler.getResultEnvelope(f.task.taskId).promptObserved).toBeUndefined();expect(f.durable.resultEnvelopes[0].promptObserved).toBeUndefined();
 }finally{await f.scheduler.shutdown().catch(()=>{});}
});
