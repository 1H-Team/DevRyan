import {afterEach,expect,test} from 'bun:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createPrimaryRecoveryController} from './provider-recovery.js';
import {validatePrimaryRecoveryRecord} from './provider-recovery-policy.js';

const cleanup=[];afterEach(async()=>{for(const action of cleanup.splice(0).reverse())await action();});
const execution={providerID:'openai',modelID:'fixture',agent:'build',variant:'default'};
const attempt={traceID:'a'.repeat(32),spanID:'b'.repeat(16)},permitSha256='c'.repeat(64),configurationDigest='d'.repeat(64);
const text='The previous response was interrupted. Continue from where you left off without repeating completed content.';
const fingerprint=createHash('sha256').update(text).digest('hex');
const assistant=(id,parentID)=>({info:{id,sessionID:'ses_test',role:'assistant',parentID,...execution,time:{}},parts:[],turnOwnership:{source:'native-sequence',userMessageID:parentID}});
async function fixture(){
 const root=path.resolve('.cache/v2-validation');await fs.mkdir(root,{recursive:true});const directory=await fs.mkdtemp(path.join(root,'stream-owner-'));cleanup.push(()=>fs.rm(directory,{recursive:true,force:true}));
 let authorized=true;
 let time=10_000;
 const state={session:{id:'ses_test',directory:'/project'},complete:true,status:'busy',blocked:false,managedBarrierState:'clear',executionOutcomes:[],
  messages:[{info:{id:'msg_original',role:'user'},parts:[{type:'text',text:'Original'}]},assistant('msg_first','msg_original')]};
 const controller=createPrimaryRecoveryController({directory:path.join(directory,'provider-recovery'),now:()=>time,mode:'observe',isManaged:()=>true,authorize:async()=>authorized,observeTurn:async()=>structuredClone(state),
  abortSession:async()=>{},promptSession:async()=>{throw Error('Legacy recovery must never dispatch');},pollMs:1_000_000,progressTimeoutMs:false});
 await controller.initialize();cleanup.push(()=>controller.drain());
 await controller.plugin({action:'hello',instanceID:'fixture',policyVersion:1,version:'2.0.30'},undefined,undefined,{authorize:async()=>{},isCurrent:()=>true});
 await controller.admit({sessionID:'ses_test',directory:'/project',primary:true,executionGeneration:2,body:{messageID:'msg_original',agent:execution.agent,
  model:{providerID:execution.providerID,modelID:execution.modelID},variant:execution.variant,tools:{read:true}}});
 await controller.plugin({action:'step',sessionID:'ses_test',instanceID:'fixture',userMessageID:'msg_original',assistantMessageID:'msg_first',execution,nativeAttempt:attempt,nativePermitSha256:permitSha256});
 const base={sessionID:'ses_test',directory:'/project',instanceID:'fixture',configurationDigest,permitSha256,execution,requestID:'request-first'};
 const transition=(action,extra={})=>controller.nativeStreamContinuation({...base,action,...extra},async()=>{if(!authorized)throw Error('Revoked');});
 return {controller,state,transition,base,revoke:()=>{authorized=false;},advance:ms=>{time+=ms;}};
}
const reserve=f=>f.transition('reserve',{attempt,outputEventID:'evt_output',assistantMessageID:'msg_first',fingerprint:'e'.repeat(64)});
function synthetic(f,id='msg_synthetic'){
 const previous=f.state.messages.find(row=>row.info.id==='msg_first');previous.info.time.completed=1;previous.info.error={type:'provider.transport',message:'Fixture failed'};
 f.state.messages.push({info:{id,sessionID:'ses_test',role:'user'},parts:[{type:'text',synthetic:true,text}]});
}
const bind=f=>f.transition('bind',{eventID:'evt_synthetic',eventSeq:10,userMessageID:'msg_synthetic',fingerprint});

test('two native Continue successors are consumed once before preparation; third proposal enters attention',async()=>{
 const f=await fixture();
 for(let n=1;n<=2;n++){
  const r=await f.controller.readRecord('ses_test'),previous=f.state.messages.find(row=>row.info.id===r.stepID);
  await f.transition('reserve',{attempt,outputEventID:'evt_output'+n,assistantMessageID:r.stepID,fingerprint:'e'.repeat(64)});
  expect((await f.controller.readRecord('ses_test')).nativeStream.consumed).toBe(n-1);
  previous.info.time.completed=n;previous.info.error={type:'provider.transport'};
  const userMessageID='msg_synthetic'+n;f.state.messages.push({info:{id:userMessageID,sessionID:'ses_test',role:'user'},parts:[{type:'text',synthetic:true,text}]});
  await f.transition('bind',{eventID:'evt_synthetic'+n,eventSeq:n*10,userMessageID,fingerprint});
  await f.transition('prepare',{requestID:'next'+n});
  expect((await f.controller.readRecord('ses_test')).nativeStream.consumed).toBe(n);
  await expect(f.transition('prepare',{requestID:'next'+n})).rejects.toMatchObject({code:'native_stream_continuation_fenced'});
  await f.transition('send',{requestID:'next'+n,attempt});
  const next=assistant('msg_next'+n,userMessageID);f.state.messages.push(next);
  await f.controller.adoptOwnedNativeContinuation({sessionID:'ses_test',instanceID:'fixture',userMessageID,assistantMessageID:next.info.id,execution,nativeAttempt:attempt,nativePermitSha256:permitSha256});
  await f.controller.plugin({action:'step',sessionID:'ses_test',instanceID:'fixture',userMessageID,assistantMessageID:next.info.id,execution,nativeAttempt:attempt,nativePermitSha256:permitSha256});
  expect((await f.controller.readRecord('ses_test')).nativeStream.consumed).toBe(n);
  expect((await f.controller.readRecord('ses_test')).anchorID).toBe('msg_original');
 }
 const r=await f.controller.readRecord('ses_test');
 expect(await f.transition('reserve',{attempt,outputEventID:'evt_third',assistantMessageID:r.stepID,fingerprint:'e'.repeat(64)})).toBe(false);
 expect(await f.controller.readRecord('ses_test')).toMatchObject({state:'needs_attention',reason:'provider_stream_interrupted',nativeStream:{consumed:2}});
 await expect(f.transition('prepare')).rejects.toMatchObject({code:'native_stream_continuation_fenced'});
 const receipts=await f.controller.nativeStreamContinuationReceipts('ses_test','msg_original');expect(receipts).toHaveLength(2);
 await f.controller.admit({sessionID:'ses_test',directory:'/project',primary:true,executionGeneration:2,objectiveID:'msg_original',body:{messageID:'msg_ownedcontinue',agent:execution.agent,
  model:{providerID:execution.providerID,modelID:execution.modelID},variant:execution.variant}});
 expect((await f.controller.readRecord('ses_test')).nativeStream).toEqual({consumed:2});
 expect(await f.controller.nativeStreamContinuationReceipts('ses_test','msg_original')).toEqual(receipts);
 await f.controller.admit({sessionID:'ses_test',directory:'/project',primary:true,executionGeneration:2,body:{messageID:'msg_newhuman',agent:execution.agent,
  model:{providerID:execution.providerID,modelID:execution.modelID},variant:execution.variant}});
 expect(await f.controller.nativeStreamContinuationReceipts('ses_test','msg_original')).toEqual(receipts);
 expect((await f.controller.readRecord('ses_test')).nativeStream).toBeUndefined();
 expect(await f.controller.nativeStreamContinuationReceipts('ses_test','msg_newhuman')).toEqual([]);
 await f.controller.admit({sessionID:'ses_test',directory:'/project',primary:true,executionGeneration:2,objectiveID:'msg_original',body:{messageID:'msg_returncontinue',agent:execution.agent,
  model:{providerID:execution.providerID,modelID:execution.modelID},variant:execution.variant}});
 expect((await f.controller.readRecord('ses_test')).nativeStream).toEqual({consumed:2});
 expect(await f.controller.nativeStreamContinuationReceipts('ses_test','msg_original')).toEqual(receipts);
 await expect(f.controller.discardNativeStreamContinuationReceipts({directory:'/project',sessions:['ses_test']},async()=>{throw Error('Unconfirmed removal');})).rejects.toThrow('Unconfirmed removal');
 expect(await f.controller.nativeStreamContinuationReceipts('ses_test','msg_original')).toEqual(receipts);
 await f.controller.discardNativeStreamContinuationReceipts({directory:'/foreign',sessions:['ses_test']},async()=>{});
 expect(await f.controller.nativeStreamContinuationReceipts('ses_test','msg_original')).toEqual(receipts);
 await f.controller.discardNativeStreamContinuationReceipts({directory:'/project',sessions:['ses_test']},async()=>{});
 expect(await f.controller.nativeStreamContinuationReceipts('ses_test','msg_original')).toEqual([]);
});

test('unbound and failed binding reservations remain durable; Stop alone releases their pending budget',async()=>{
 const f=await fixture();await reserve(f);
 await expect(f.transition('prepare')).rejects.toMatchObject({code:'native_stream_continuation_fenced'});
 synthetic(f);await expect(f.transition('bind',{eventID:'evt_synthetic',eventSeq:10,userMessageID:'msg_synthetic',fingerprint:'f'.repeat(64)})).rejects.toMatchObject({code:'native_stream_continuation_fenced'});
 expect((await f.controller.readRecord('ses_test')).nativeStream.pending).toBeDefined();
 await expect(f.controller.admit({sessionID:'ses_test',directory:'/project',primary:true,executionGeneration:2,objectiveID:'msg_original',body:{messageID:'msg_ownedcontinue',agent:execution.agent,
  model:{providerID:execution.providerID,modelID:execution.modelID},variant:execution.variant}})).rejects.toMatchObject({code:'native_stream_continuation_fenced'});
 await f.controller.control('ses_test','stop');
 expect((await f.controller.readRecord('ses_test')).nativeStream).toEqual({consumed:0});
 await expect(bind(f)).rejects.toMatchObject({code:'native_stream_continuation_fenced'});
});

test('a consumed successor without Step adoption keeps its budget through Stop and historical objective admission',async()=>{
 const f=await fixture();await reserve(f);synthetic(f);await bind(f);await f.transition('prepare',{requestID:'next'});
 await f.controller.control('ses_test','stop');
 const admit=(messageID,objectiveID)=>f.controller.admit({sessionID:'ses_test',directory:'/project',primary:true,executionGeneration:2,objectiveID,
  body:{messageID,agent:execution.agent,model:{providerID:execution.providerID,modelID:execution.modelID},variant:execution.variant}});
 await admit('msg_otherhuman');await admit('msg_returncontinue','msg_original');
 expect((await f.controller.readRecord('ses_test')).nativeStream).toEqual({consumed:1});
 expect(await f.controller.nativeStreamContinuationReceipts('ses_test','msg_original')).toEqual([]);
});

test('new humans, unresolved tools, receipts, barriers, selection and permit changes fence native continuation',async()=>{
 for(const change of ['human','tool','receipt','barrier','request','selection','permit','controller','configuration']){
  const f=await fixture();
  if(change==='human')f.state.messages.push({info:{id:'msg_human',role:'user'},parts:[{type:'text',text:'New objective'}]});
  if(change==='tool')f.state.messages.at(-1).parts.push({type:'tool',callID:'call_fixture',state:{status:'error'}});
  if(change==='receipt')f.state.executionOutcomesUnavailable=true;
  if(change==='barrier')f.state.managedBarrierState='active';
  if(change==='request')f.state.blocked=true;
  const extra=change==='selection'?{execution:{...execution,variant:'changed'}}:change==='permit'?{permitSha256:'f'.repeat(64)}:change==='controller'?{instanceID:'foreign'}:{};
  if(change==='configuration'){
   await reserve(f);synthetic(f);await bind(f);
   await expect(f.transition('prepare',{configurationDigest:'f'.repeat(64)})).rejects.toMatchObject({code:'native_stream_continuation_fenced'});
  }else await expect(f.transition('reserve',{attempt,outputEventID:'evt_output',assistantMessageID:'msg_first',fingerprint:'e'.repeat(64),...extra})).rejects.toMatchObject({code:'native_stream_continuation_fenced'});
 }
});

test('plain Retry preparation/send reserves nothing; persisted budget rejects corruption',async()=>{
 const f=await fixture();await f.transition('prepare');await f.transition('send',{attempt});
 const record=await f.controller.readRecord('ses_test');expect(record.nativeStream).toBeUndefined();
 expect(()=>validatePrimaryRecoveryRecord({...record,nativeStream:{consumed:3}})).toThrow('invalid native stream continuation');
 expect(()=>validatePrimaryRecoveryRecord({...record,nativeStream:{consumed:1,pending:{}}})).toThrow('invalid native stream continuation');
});

test('an earlier errored tool requires exact durable no-start proof before reserving a later interrupted output',async()=>{
 const f=await fixture();
 f.state.messages.splice(1,0,{...assistant('msg_denied','msg_original'),parts:[{type:'tool',callID:'denied_call',tool:'write',state:{status:'error'}}]});
 await expect(reserve(f)).rejects.toMatchObject({code:'native_stream_continuation_fenced'});
 f.state.executionOutcomes=[{sessionID:'ses_test',messageID:'msg_denied',callID:'foreign_call',outcome:'never_started'}];
 await expect(reserve(f)).rejects.toMatchObject({code:'native_stream_continuation_fenced'});
 f.state.executionOutcomes=[{sessionID:'ses_test',messageID:'msg_denied',callID:'denied_call',outcome:'never_started'}];
 expect(await reserve(f)).toBe(true);
 expect((await f.controller.readRecord('ses_test')).nativeStream.consumed).toBe(0);
});

test('explicit original-input intent still prepares a request while suppressing another automatic continuation',async()=>{
 const f=await fixture();await f.controller.control('ses_test','intent');
 expect(await f.transition('prepare')).toBe(true);expect(await f.transition('send',{attempt})).toBe(true);
 expect(await reserve(f)).toBe(false);expect((await f.controller.readRecord('ses_test')).nativeStream).toBeUndefined();
});

test('lost Synthetic and lost successor Step expire on the existing progress contract without releasing budget',async()=>{
 for(const phase of ['pending','committed']){
  const f=await fixture();await reserve(f);
  if(phase==='committed'){synthetic(f);await bind(f);await f.transition('prepare',{requestID:'next'});await f.transition('send',{requestID:'next',attempt});}
  f.advance(300_001);await f.controller.reconcile();
  const record=await f.controller.readRecord('ses_test');expect(record).toMatchObject({state:'needs_attention',reason:'provider_stream_interrupted'});
  expect(record.nativeStream.consumed).toBe(phase==='pending'?0:1);expect(record.nativeStream[phase]).toBeDefined();
  await expect(f.transition('prepare',{requestID:'late'})).rejects.toMatchObject({code:'native_stream_continuation_fenced'});
 }
});

test('only new exact attempt transport I/O keeps a committed proof live; duplicate or foreign progress cannot extend it',async()=>{
 const f=await fixture();await reserve(f);synthetic(f);await bind(f);await f.transition('prepare',{requestID:'next'});await f.transition('send',{requestID:'next',attempt});
 f.advance(250_000);await f.transition('progress',{requestID:'next',attempt,observedUnits:1});
 f.advance(100_000);await f.controller.reconcile();expect((await f.controller.readRecord('ses_test')).state).toBe('observing');
 await expect(f.transition('progress',{requestID:'next',attempt:{...attempt,spanID:'f'.repeat(16)},observedUnits:2})).rejects.toMatchObject({code:'native_stream_continuation_fenced'});
 await expect(f.transition('progress',{requestID:'next',attempt,observedUnits:1})).rejects.toMatchObject({code:'native_stream_continuation_fenced'});
 f.advance(250_000);await f.controller.reconcile();expect((await f.controller.readRecord('ses_test')).state).toBe('needs_attention');
});

test('expired successor admission and the Step backstop cannot adopt a new assistant',async()=>{
 const f=await fixture();await reserve(f);synthetic(f);await bind(f);f.advance(300_001);
 expect(await f.transition('prepare',{requestID:'late'})).toBe(false);expect((await f.controller.readRecord('ses_test')).nativeStream.consumed).toBe(0);
 const g=await fixture();await reserve(g);synthetic(g);await bind(g);await g.transition('prepare',{requestID:'next'});await g.transition('send',{requestID:'next',attempt});
 g.state.messages.push(assistant('msg_late','msg_synthetic'));g.advance(300_001);
 await expect(g.controller.adoptOwnedNativeContinuation({sessionID:'ses_test',instanceID:'fixture',userMessageID:'msg_synthetic',assistantMessageID:'msg_late',execution,nativeAttempt:attempt,nativePermitSha256:permitSha256})).rejects.toMatchObject({code:'provider_stream_interrupted'});
 expect(await g.controller.nativeStreamContinuationReceipts('ses_test','msg_original')).toEqual([]);
 expect(await g.controller.readRecord('ses_test')).toMatchObject({state:'needs_attention',reason:'provider_stream_interrupted',nativeStream:{consumed:1}});
});
