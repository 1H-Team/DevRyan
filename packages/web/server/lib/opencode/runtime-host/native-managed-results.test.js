import { expect, test } from 'vitest';
import { projectManagedTaskResult, readManagedResultReference, createCompactResultHeader } from '@openchamber/orchestration-runtime';
import { createNativeManagedResultCollection } from './native-managed-results.js';

const scope = {rootSessionId:'ses_root',directory:'/project'};
const task = {sequence:1,finishedAt:2,recoveryLineageId:null,childPromptedAt:null,firstAssistantPartAt:null,waitingReason:null,transportRecovery:null,requiredChecks:[],requiredCheckReceipts:[],owner:'devryan',idempotencyKey:'test',dispatchGroupId:null,dispatchCallId:null,dispatchWaveId:null,mode:'orchestrator',readOnly:false,providerId:'p',modelId:'m',agent:'fixer',variant:null,label:'Test',prompt:'Fix',leaseToken:null,createdAt:1,updatedAt:1,startedAt:1,completedAt:2,timeoutAt:null,taskId:'dvr_task_one',rootSessionId:'ses_root',directory:'/project',status:'failed',parentTaskId:null,childSessionId:'ses_child',partial:true,failureReason:null,attempt:1,priorTaskId:null,executionKind:'start',recoverablePreview:'😀'.repeat(5000),canonicalRefs:[]};
const envelope = {envelopeId:'dvr_result_one',...task,action:null,partial:true,recoverablePreview:'😀'.repeat(5000)};
const projected = () => projectManagedTaskResult(task,envelope,'reference');

test('real shared UTF-8 result pages must be collected in order before disposition',()=>{
  const collection=createNativeManagedResultCollection(),result=projected();
  collection.collect(result,scope,task.taskId);
  expect(()=>collection.assertDisposition(scope,task.taskId,'retry',result)).toThrow('detail_required');
  const first=result.resultReference.nextCursor;
  expect(()=>collection.next(scope,task.taskId,'forged')).toThrow('cursor_mismatch');
  const page=readManagedResultReference({task,resultEnvelope:envelope,resultCursor:first});
  collection.acceptPage(scope,task.taskId,first,{resultReference:page});
  expect(()=>collection.acceptPage(scope,task.taskId,first,{resultReference:page})).toThrow('cursor_mismatch');
  let cursor=page.nextCursor;
  while(cursor){const next=readManagedResultReference({task,resultEnvelope:envelope,resultCursor:cursor});collection.acceptPage(scope,task.taskId,cursor,{resultReference:next});cursor=next.nextCursor;}
  expect(()=>collection.assertDisposition(scope,task.taskId,'retry',result)).not.toThrow();
  expect(()=>collection.assertDisposition(scope,task.taskId,'retry',{...result,task:{...task,directory:'/elsewhere'}})).toThrow('scope_invalid');
  expect(()=>collection.assertDisposition(scope,task.taskId,'retry',{...result,resultEnvelope:{...result.resultEnvelope,envelopeId:'dvr_result_new'}})).toThrow('result_changed');
});
test('compact headers skip detail only with actual current check receipts; manual recovery remains fenced',()=>{
  const completed={...task,status:'completed',partial:false,recoverablePreview:'**Status:** complete'},done={...envelope,...completed};
  const check={name:'unit',status:'passed',coverage:{contentHash:'a'},evidence:{exitCode:0,checkedContentHash:'a'}};
  const result={...projectManagedTaskResult(completed,done,'compact'),resultHeader:createCompactResultHeader({task:completed,envelope:done,checks:[check],observedAt:1}),capabilities:{policies:{compactResults:true}}};
  const collection=createNativeManagedResultCollection();collection.collect(result,scope,task.taskId);
  expect(()=>collection.assertDisposition(scope,task.taskId,'continue',result)).not.toThrow();
  expect(()=>collection.assertDisposition(scope,task.taskId,'abandon',result)).toThrow('completed_requires_continue');
  expect(()=>collection.assertDisposition(scope,task.taskId,'continue',{...result,task:{...completed,manualRecoveryRequired:true}})).toThrow('manual_model_recovery_required');
  const forged=structuredClone(result);forged.resultHeader.verification.checks[0].evidence.exitCode=1;
  expect(()=>createNativeManagedResultCollection().collect(forged,scope,task.taskId)).toThrow('header_invalid');
});
test('missing collection, oversized/foreign pages and changed byte coverage fail closed',()=>{
  const collection=createNativeManagedResultCollection(),result=projected();
  expect(()=>collection.assertDisposition(scope,task.taskId,'abandon',result)).toThrow('wait_required');collection.collect(result,scope,task.taskId);
  const cursor=result.resultReference.nextCursor,page=readManagedResultReference({task,resultEnvelope:envelope,resultCursor:cursor});
  for(const changed of [{...page,taskId:'dvr_task_other'},{...page,totalBytes:page.totalBytes+1},{...page,text:'x'.repeat(9000)}])
    expect(()=>collection.acceptPage(scope,task.taskId,cursor,{resultReference:changed})).toThrow('page_invalid');
});
