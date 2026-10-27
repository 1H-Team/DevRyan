import { expect, test } from 'vitest';
import { projectManagedTaskResult, readManagedResultReference, createCompactResultHeader, prepareManagedResultMetadata, fitManagedToolOutput, projectRequiredCheckEvidence } from '@devryan/orchestration-runtime';
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
  const check={name:'unit',status:'passed',coverage:{contentHash:'a'.repeat(64)},evidence:{exitCode:0,checkedContentHash:'a'.repeat(64)}};
  const result={...projectManagedTaskResult(completed,done,'compact'),resultHeader:createCompactResultHeader({task:completed,envelope:done,checks:[check],observedAt:1}),capabilities:{policies:{compactResults:true}}};
  const collection=createNativeManagedResultCollection();collection.collect(result,scope,task.taskId);
  expect(()=>collection.assertDisposition(scope,task.taskId,'continue',result)).not.toThrow();
  expect(()=>collection.assertDisposition(scope,task.taskId,'collect',result)).not.toThrow();
  expect(()=>collection.assertDisposition(scope,task.taskId,'abandon',result)).toThrow('completed_requires_continue');
  expect(()=>collection.assertDisposition(scope,task.taskId,'continue',{...result,task:{...completed,manualRecoveryRequired:true}})).toThrow('manual_model_recovery_required');
  const forged=structuredClone(result);forged.resultHeader.verification.checks[0].evidence.exitCode=1;
  expect(()=>createNativeManagedResultCollection().collect(forged,scope,task.taskId)).toThrow('header_invalid');
});
test.each(['pending','failed','blocked'])('a real %s verification header remains readable and cannot waive required detail',status=>{
  const completed={...task,status:'completed',partial:false,recoverablePreview:'Result.\n**Status:** complete'},done={...envelope,...completed};
  const check={name:'unit',status,reason:'required_evidence_unavailable',coverage:{contentHash:null},evidence:null};
  const result={...projectManagedTaskResult(completed,done,'compact'),resultContractVersion:2,
    resultHeader:createCompactResultHeader({task:completed,envelope:done,checks:[check],observedAt:1})};
  const collection=createNativeManagedResultCollection();
  expect(result.resultHeader.verification).toMatchObject({status,ready:false});
  collection.collect(result,{...scope,resultContractVersion:2},task.taskId);
  expect(()=>collection.assertDisposition(scope,task.taskId,'continue',result)).toThrow('detail_required');
  const forged=structuredClone(result);forged.resultHeader.detail.requiredBeforeDisposition=false;
  expect(()=>createNativeManagedResultCollection().collect(forged,{...scope,resultContractVersion:2},task.taskId)).toThrow('header_invalid');
});
test('an authenticated current-content waiver permits disposition without becoming a test pass',()=>{
  const completed={...task,status:'completed',partial:false,recoverablePreview:'Result.\n**Status:** complete'},done={...envelope,...completed};
  const hash='a'.repeat(64),declarations=[{name:'unit',command:'bun test',paths:['src/one.js']}];
  const checks=projectRequiredCheckEvidence(declarations,[{name:'unit',status:'waived',callId:'waiver_call',messageId:null,exitCode:null,
    observedAt:1,contentHash:hash,waiver:{source:'authenticated-user',userId:'user_one',reason:'Explicitly waived for this change'}}],{unit:hash});
  const result={...projectManagedTaskResult(completed,done,'compact'),resultContractVersion:2,
    resultHeader:createCompactResultHeader({task:completed,envelope:done,checks,observedAt:1})};
  const collection=createNativeManagedResultCollection(),v2={...scope,resultContractVersion:2};
  collection.collect(result,v2,task.taskId);
  expect(result.resultHeader.verification).toMatchObject({status:'waived',ready:true,checks:[{status:'waived',evidence:{exitCode:null}}]});
  expect(()=>collection.assertDisposition(v2,task.taskId,'continue',result)).not.toThrow();
  for(const mutate of [value=>{value.resultHeader.verification.status='passed';},
    value=>{value.resultHeader.verification.checks[0].waiver.source='model';},
    value=>{value.resultHeader.verification.checks[0].coverage.contentHash='b'.repeat(64);}]){
    const forged=structuredClone(result);mutate(forged);
    expect(()=>createNativeManagedResultCollection().collect(forged,v2,task.taskId)).toThrow('header_invalid');
  }
});
test('missing collection, oversized/foreign pages and changed byte coverage fail closed',()=>{
  const collection=createNativeManagedResultCollection(),result=projected();
  expect(()=>collection.assertDisposition(scope,task.taskId,'abandon',result)).toThrow('wait_required');collection.collect(result,scope,task.taskId);
  const cursor=result.resultReference.nextCursor,page=readManagedResultReference({task,resultEnvelope:envelope,resultCursor:cursor});
  for(const changed of [{...page,taskId:'dvr_task_other'},{...page,totalBytes:page.totalBytes+1},{...page,text:'x'.repeat(9000)}])
    expect(()=>collection.acceptPage(scope,task.taskId,cursor,{resultReference:changed})).toThrow('page_invalid');
});

test('only a v2 owner scope admits larger pages and keeps that ceiling through later reads',()=>{
 const preview='🙂'.repeat(16000),largeTask={...task,recoverablePreview:preview},largeEnvelope={...envelope,recoverablePreview:preview};
 const result=projectManagedTaskResult(largeTask,largeEnvelope,'reference',24*1024),collection=createNativeManagedResultCollection();
 expect(()=>collection.collect({...result,resultContractVersion:2},scope,task.taskId)).toThrow('page_invalid');
 const v2={...scope,resultContractVersion:2};collection.collect(result,v2,task.taskId);
 let cursor=result.resultReference.nextCursor;
 while(cursor){
  const next=readManagedResultReference({task:largeTask,resultEnvelope:largeEnvelope,resultCursor:cursor,maxPageBytes:24*1024});
  const oversized={...next,text:'x'.repeat(24*1024+1)};
  expect(()=>collection.acceptPage(v2,task.taskId,cursor,{resultReference:oversized})).toThrow('page_invalid');
  collection.acceptPage(v2,task.taskId,cursor,{resultReference:next});cursor=next.nextCursor;
 }
 expect(()=>collection.assertDisposition(v2,task.taskId,'retry',result)).not.toThrow();
});

test('larger v2 metadata pages preserve all references and cannot satisfy missing report coverage',async()=>{
 const refs=Array.from({length:600},(_,index)=>({type:'message',id:`msg_${index}`,description:'a'.repeat(64)}));
 const retainedTask={...task,canonicalRefs:refs},retainedEnvelope={...envelope,canonicalRefs:refs};
 const metadata=await prepareManagedResultMetadata(projectManagedTaskResult(retainedTask,retainedEnvelope,'compact'));
 const first=fitManagedToolOutput(size=>metadata.project(size),48*1024,24*1024),v2={...scope,resultContractVersion:2};
 expect(Buffer.byteLength(first.metadataReference.text)).toBeGreaterThan(8*1024);
 const collection=createNativeManagedResultCollection();collection.collect(first,v2,task.taskId);
 let text=first.metadataReference.text,cursor=first.metadataReference.nextCursor;
 while(cursor){
  const next=fitManagedToolOutput(size=>metadata.read(cursor,size),48*1024,24*1024);
  expect(Buffer.byteLength(JSON.stringify(next))).toBeLessThanOrEqual(48*1024);
  collection.acceptPage(v2,task.taskId,cursor,next);text+=next.metadataReference.text;cursor=next.metadataReference.nextCursor;
 }
 expect(JSON.parse(text).resultEnvelope.canonicalRefs).toEqual(refs);
 expect(()=>collection.assertDisposition(v2,task.taskId,'retry',first)).toThrow('detail_required');
});

const identity={controllerInstanceID:'controller',configurationDigest:'a'.repeat(64),objectiveID:'msg_objective',cancellationGeneration:1,
  stepID:'msg_delivery',attempt:{traceID:'b'.repeat(32),spanID:'c'.repeat(16)},permitSha256:'d'.repeat(64)};
const invocation={messageID:'msg_delivery',callID:'call_wait',input:{action:'wait',task_id:task.taskId}};
const canonical=(output,overrides={})=>({info:{id:'msg_delivery',sessionID:scope.rootSessionId,role:'assistant'},parts:[{type:'tool',tool:'devryan_task',callID:'call_wait',
  state:{status:'completed',input:invocation.input,output:JSON.stringify(output),metadata:{},...overrides}}]});
test('v2 handler returns are only candidates; exact completed publication and a later ordered Step are required',()=>{
 const collection=createNativeManagedResultCollection(),result=projected();collection.collect(result,scope,task.taskId);
 collection.stagePublication(scope,[task.taskId],invocation,identity,result);
 collection.stagePublication(scope,[task.taskId],invocation,identity,result);
 expect(()=>collection.stagePublication(scope,[task.taskId],invocation,identity,{...result,changed:true})).toThrow('publication_changed');
 const snapshot={identity,messages:[canonical(result)]};
 for(const state of [{status:'running'},{metadata:{truncated:true}},{output:JSON.stringify(result)+' '},{input:{action:'status',task_id:task.taskId}}])
  expect(()=>collection.assertPublished(scope,task.taskId,{identity,messages:[canonical(result,state)]})).toThrow('not_published');
 expect(()=>collection.assertPublished(scope,task.taskId,snapshot)).not.toThrow();
 expect(()=>collection.assertPublished(scope,task.taskId,snapshot,true)).toThrow('later_review_step_required');
 const later={info:{id:'msg_review',sessionID:scope.rootSessionId,role:'assistant'},parts:[]};
 const reviewed={identity:{...identity,stepID:'msg_review'},messages:[canonical(result),later]};
 expect(()=>collection.assertPublished(scope,task.taskId,reviewed,true)).not.toThrow();
 expect(()=>collection.assertPublished(scope,task.taskId,{...reviewed,messages:[later,canonical(result)]},true)).toThrow('later_review_step_required');
 for(const changed of [{objectiveID:'msg_new'},{cancellationGeneration:2},{controllerInstanceID:'new'},{configurationDigest:'e'.repeat(64)}])
  expect(()=>collection.assertPublished(scope,task.taskId,{...reviewed,identity:{...reviewed.identity,...changed}},true)).toThrow('scope_changed');
});
test('delivery metrics observe only exact canonical publication and never grant review or omit required pages',()=>{
 const events=[],collection=createNativeManagedResultCollection({onDelivery:event=>events.push(event)}),result=projected();
 collection.collect(result,scope,task.taskId);collection.stagePublication(scope,[task.taskId],invocation,identity,result);
 expect(events).toEqual([]);
 expect(()=>collection.assertPublished(scope,task.taskId,{identity,messages:[canonical(result,{metadata:{truncated:true}})]})).toThrow('not_published');
 expect(events).toEqual([]);
 const snapshot={identity,messages:[canonical(result)]};
 collection.assertPublished(scope,task.taskId,snapshot);
 expect(events[0].payload).toMatchObject({section:'publication',serializedBytes:Buffer.byteLength(JSON.stringify(result)),repeatedBytes:0});
 expect(events[1].payload).toMatchObject({section:'report',startBytes:0,endBytes:result.resultReference.returnedBytes});
 collection.assertPublished(scope,task.taskId,snapshot);expect(events).toHaveLength(2);
 expect(()=>collection.assertPublished(scope,task.taskId,snapshot,true)).toThrow('later_review_step_required');
 expect(()=>collection.assertDisposition(scope,task.taskId,'abandon',result)).toThrow('detail_required');
});
test('a worktree move cannot inherit collected pages or publication authority from its source directory',()=>{
 const collection=createNativeManagedResultCollection(),result=projected();
 collection.collect(result,scope,task.taskId);collection.stagePublication(scope,[task.taskId],invocation,identity,result);
 collection.assertPublished(scope,task.taskId,{identity,messages:[canonical(result)]});
 const movedScope={...scope,directory:'/project-worktrees/moved'};
 expect(()=>collection.collect(result,movedScope,task.taskId)).toThrow('scope_invalid');
 expect(()=>collection.next(movedScope,task.taskId,result.resultReference.nextCursor)).toThrow('wait_required');
 const moved={...result,task:{...result.task,directory:movedScope.directory},resultEnvelope:{...result.resultEnvelope,directory:movedScope.directory}};
 collection.collect(moved,movedScope,task.taskId);
 expect(()=>collection.assertPublished(movedScope,task.taskId,{identity,messages:[canonical(moved)]})).toThrow('not_published');
 expect(()=>collection.assertDisposition(movedScope,task.taskId,'abandon',moved)).toThrow('detail_required');
});
test('v2 last needed page publication cannot inherit review authority from an earlier Step; recollection after restart is explicit',()=>{
 const collection=createNativeManagedResultCollection(),result=projected();collection.collect(result,scope,task.taskId);
 collection.stagePublication(scope,[task.taskId],invocation,identity,result);
 const cursor=result.resultReference.nextCursor,page=readManagedResultReference({task,resultEnvelope:envelope,resultCursor:cursor});
 collection.acceptPage(scope,task.taskId,cursor,{resultReference:page});
 const read={messageID:'msg_page',callID:'call_page',input:{action:'read_result',task_id:task.taskId,result_cursor:cursor}},output={resultReference:page};
 collection.stagePublication(scope,[task.taskId],read,{...identity,stepID:'msg_page'},output);
 const publishedPage={info:{id:'msg_page',sessionID:scope.rootSessionId,role:'assistant'},parts:[{type:'tool',tool:'devryan_task',callID:'call_page',state:{status:'completed',input:read.input,output:JSON.stringify(output),metadata:{}}}]};
 const snapshot={identity:{...identity,stepID:'msg_page'},messages:[canonical(result),publishedPage]};
 expect(()=>collection.assertPublished(scope,task.taskId,snapshot,true)).toThrow('later_review_step_required');
 expect(()=>createNativeManagedResultCollection().assertPublished(scope,task.taskId,snapshot,true)).toThrow('native_task_wait_required');
 collection.collect(result,scope,task.taskId,true);
 expect(()=>collection.assertPublished(scope,task.taskId,snapshot,true)).toThrow('not_published');
 expect(()=>collection.next(scope,task.taskId,page.nextCursor)).toThrow('cursor_mismatch');
});
test('v2 metadata/reference coverage cannot skip to a report cursor or disposition before all required sections',async()=>{
 const result=projectManagedTaskResult(task,envelope,'compact'),metadata=await prepareManagedResultMetadata(result),first=metadata.project(100),collection=createNativeManagedResultCollection();
 collection.collect(first,scope,task.taskId);
 expect(()=>collection.next(scope,task.taskId,first.resultReference.nextCursor)).toThrow('cursor_mismatch');
 expect(()=>collection.assertDisposition(scope,task.taskId,'retry',first)).toThrow('detail_required');
 let joined=first.metadataReference.text,cursor=first.metadataReference.nextCursor;
 while(cursor){const next=metadata.read(cursor,100);joined+=next.metadataReference.text;collection.acceptPage(scope,task.taskId,cursor,next);cursor=next.metadataReference.nextCursor;}
 expect(JSON.parse(joined).resultEnvelope.canonicalRefs).toEqual(envelope.canonicalRefs);
 cursor=first.resultReference.nextCursor;
 while(cursor){const next=readManagedResultReference({task,resultEnvelope:envelope,resultCursor:cursor});collection.acceptPage(scope,task.taskId,cursor,{resultReference:next});cursor=next.nextCursor;}
 expect(()=>collection.assertDisposition(scope,task.taskId,'retry',first)).not.toThrow();
});

test('page advancement rolls back when publication staging rejects, including an earlier valid sibling',()=>{
 const collection=createNativeManagedResultCollection(),result=projected();
 collection.collect(result,scope,task.taskId);collection.stagePublication(scope,[task.taskId],invocation,identity,result);
 const cursor=result.resultReference.nextCursor,reference=readManagedResultReference({task,resultEnvelope:envelope,resultCursor:cursor});
 const read={taskID:task.taskId,cursor,result:{resultReference:reference}};
 const current={...invocation,messageID:'msg_page',callID:'call_page'};
 expect(()=>collection.acceptPublishedPages(scope,[read],current,{...identity,objectiveID:'changed'},read.result)).toThrow('scope_changed');
 expect(collection.next(scope,task.taskId,cursor).reference).toEqual(result.resultReference);
 expect(()=>collection.acceptPublishedPages(scope,[read,{...read,taskID:'dvr_task_missing'}],current,identity,read.result)).toThrow('wait_required');
 expect(collection.next(scope,task.taskId,cursor).reference).toEqual(result.resultReference);
 collection.acceptPublishedPages(scope,[read],current,{...identity,stepID:current.messageID},read.result);
 expect(collection.publicationMessageIDs(scope,[task.taskId])).toEqual(['msg_delivery','msg_page']);
 expect(()=>collection.assertPublished(scope,task.taskId,{identity:{...identity,stepID:'msg_review'},messages:[canonical(result),
  {info:{id:'msg_review',sessionID:scope.rootSessionId,role:'assistant'},parts:[]}]},true)).toThrow('not_published');
});
