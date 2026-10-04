import {test,expect} from 'bun:test';
import fs from 'node:fs/promises';import path from 'node:path';import {pathToFileURL} from 'node:url';
import {createManagedTaskScheduler} from '../../packages/orchestration-runtime/index.js';
import {createPrimaryRecoveryController,createPrimaryRecoveryHost} from '../../packages/harness-runtime/index.js';
import {createNativeSlimContextOwner} from '../../packages/web/server/lib/opencode/runtime-host/native-slim-context-owner.js';
import {nativeStepPermitSha256} from '../../packages/web/server/lib/opencode/runtime-host/primary-step-owner.js';
import {rewriteReviewedSlimServer} from '../../packages/web/server/lib/opencode/runtime-host/reviewed-package-transforms.js';
import type * as ReviewedSlim from '../../packages/web/runtime/reviewed-inputs/slim-2.2.25/dist/server/index.js';
const directory='/workspace';
async function originalFixture(){const root=await fs.mkdtemp(path.resolve('.cache/v2-validation/slim-owner-'));const file=path.join(root,'reviewed.mjs');await fs.writeFile(file,rewriteReviewedSlimServer(await fs.readFile(new URL('../../packages/web/runtime/reviewed-inputs/slim-2.2.25/dist/server/index.js',import.meta.url))).contents);const originals:typeof ReviewedSlim=await import(pathToFileURL(file).href);return {root,originals};}
test('Node context owner runs the original taskboard against real terminal envelope CAS without collecting results',async()=>{
 const f=await originalFixture();let saved:unknown,live=true,child=false;
 const scheduler=createManagedTaskScheduler({persistence:{load:async()=>null,save:async value=>{saved=structuredClone(value)}},executor:{start:async(_task,control)=>{await control.setChildSessionId('ses_child');await control.markAccepted();return {status:'completed',recoverablePreview:'Actual completed result'};},abort:async()=>({aborted:true}),reconcile:async()=>({state:'unavailable'}),readRecoverableResult:async()=>{throw new Error('context_cannot_collect_result')}}});
 try{
  const task=await scheduler.submit({idempotencyKey:'taskboard',rootSessionId:'ses_root',directory,mode:'orchestrator',providerId:'saved',modelId:'one',agent:'explorer',variant:null,label:'Actual task',prompt:'Actual objective',timeoutAt:null});await scheduler.waitForTask(task.taskId);
  const primary=createPrimaryRecoveryController({directory:path.join(f.root,'primary'),isManaged:()=>true,authorize:async()=>true,observeTurn:async()=>null,abortSession:async()=>{},promptSession:async()=>{}});await primary.initialize();
  try{
   await primary.admit({sessionID:'ses_root',directory,primary:true,executionGeneration:2,body:{messageID:'msg_first',agent:'orchestrator',model:{providerID:'saved',modelID:'one'},variant:'default'}});
   const owner=createNativeSlimContextOwner({originals:f.originals,primaryRuntime:{...primary,helloNative:async()=>{throw Error('existing_bound_path_must_not_handshake')}},getManagedRuntime:()=>scheduler,locations:[{directory}],openCodeClient:{sessions:{get:async()=>({id:'ses_root',directory,...child?{parentID:'ses_parent'}:{}}),message:async()=>{throw new Error('ordinary_context_cannot_read_step')},messages:async()=>{throw new Error('ordinary_context_cannot_read_history')}}},admissionOwner:{captureSessionHookAuthorization:async()=>async()=>{if(!live)throw new Error('actual_hook_revoked')}}});
   const permit={token:'a'.repeat(64),sessionID:'ses_root',revision:0},first={info:{id:'msg_first',role:'user',sessionID:'ses_root',agent:'orchestrator'},parts:[{type:'text',text:'Exact objective'}]};
   const output=await owner.transformMessages({permit,directory,sessionID:'ses_root',phase:'context',messages:[first]});expect(JSON.stringify(output)).toContain('Actual completed result');expect(scheduler.getResultEnvelope(task.taskId)?.promptObserved).toBeUndefined();
   const tail={...first,info:{...first.info,id:'msg_limit'},parts:[{type:'text',text:''}]},oversized=[...output.messages,tail];
   tail.parts[0].text='x'.repeat(4*1024*1024-Buffer.byteLength(JSON.stringify(oversized))-32);
   await expect(owner.transformMessages({permit,directory,sessionID:'ses_root',phase:'context',messages:oversized})).rejects.toThrow('native_slim_context_limit');expect(scheduler.getResultEnvelope(task.taskId)?.promptObserved).toBeUndefined();
   // Limit refusal clears presentation state, so a successful fresh board is
   // rendered before the later prompt can acknowledge its terminal observation.
   const fresh=await owner.transformMessages({permit,directory,sessionID:'ses_root',phase:'context',messages:[first]});
   const next=await owner.transformMessages({permit,directory,sessionID:'ses_root',phase:'context',messages:[...fresh.messages,{...first,info:{...first.info,id:'msg_next'}}]});expect(JSON.stringify(next)).toContain('background-job-board-v2');expect(scheduler.getResultEnvelope(task.taskId)).toMatchObject({action:null,acknowledgedAt:null,promptObserved:{attempt:task.attempt}});expect(JSON.stringify(saved)).toContain('promptObserved');
   child=true;expect(await owner.transformMessages({permit,directory,sessionID:'ses_root',phase:'context',messages:[first]})).toEqual({messages:[first],presentationInsertions:[]});
   live=false;await expect(owner.transformMessages({permit,directory,sessionID:'ses_root',phase:'context',messages:[first]})).rejects.toThrow('actual_hook_revoked');
  }finally{await primary.drain();}
 }finally{await scheduler.shutdown();await fs.rm(f.root,{recursive:true,force:true});}
});
test('Node retry owner uses actual original chain choice and reserves separate default native execution on the real primary',async()=>{
 const f=await originalFixture();let live=true,authorized=true;const sent:unknown[]=[];
 const execution={providerID:'saved',modelID:'one',agent:'orchestrator',variant:'high'};
 const attempt={traceID:'a'.repeat(32),spanID:'b'.repeat(16)},permit={token:'b'.repeat(64),revision:0,sessionID:'ses_root'};
 const messages:Array<{info:Record<string,unknown>;parts:readonly unknown[];nativeStatus?:{source:string;kind:string};turnOwnership?:{source:string;userMessageID:string}}>=[{info:{id:'msg_user',role:'user'},parts:[{type:'text',text:'Exact objective'}]},{info:{id:'msg_failed',sessionID:'ses_root',parentID:'msg_user',role:'assistant',time:{},...execution},parts:[],turnOwnership:{source:'native-sequence',userMessageID:'msg_user'}}];
 const observation={session:{id:'ses_root',directory},complete:true,status:'idle',blocked:false,messages};
 const primary=createPrimaryRecoveryController({directory:path.join(f.root,'primary'),isManaged:()=>true,authorize:async()=>authorized,isNativeFallbackError:f.originals.isReviewedSlimFailoverError,observeTurn:async()=>structuredClone(observation),abortSession:async()=>{},promptSession:async(_r,body)=>{sent.push(body)}});
 try{
  await primary.initialize();await primary.plugin({action:'hello',policyVersion:1,instanceID:'actual-controller',version:'2.0.20'});await primary.admit({sessionID:'ses_root',directory,primary:true,executionGeneration:2,body:{messageID:'msg_user',agent:execution.agent,model:{providerID:execution.providerID,modelID:execution.modelID},variant:execution.variant}});await primary.plugin({action:'step',instanceID:'actual-controller',sessionID:'ses_root',userMessageID:'msg_user',assistantMessageID:'msg_failed',execution,nativeAttempt:attempt,nativePermitSha256:nativeStepPermitSha256(permit)});
  let historyReads=0,stepReads=0,missingSource=false;
  const owner=createNativeSlimContextOwner({getInstanceID:()=> 'actual-controller',originals:f.originals,primaryRuntime:{...primary,helloNative:async()=>{throw Error('existing_bound_path_must_not_handshake')}},getManagedRuntime:async()=>{throw new Error('retry_cannot_create_tasks')},locations:[{directory,compatibility:{slim:{nativeRuntime:{fallback:{enabled:true},runtimeChains:{orchestrator:['saved/one','saved/two','saved/last']}}}}}],openCodeClient:{sessions:{get:async()=>structuredClone(observation.session),
   message:async(_id:string,messageID:string)=>{stepReads++;return structuredClone(messages.find(message=>message.info.id===messageID));},
   messages:async(_id: string,page: {limit:number;before?:string},options: {directory:string;maxResponseBytes:number;timeoutMs:number})=>{
    historyReads++;expect(page.limit).toBe(100);expect(options).toMatchObject({directory,maxResponseBytes:16*1024*1024,timeoutMs:5000});
    if(missingSource)return {records:[],cursor:'repeated'};
    const end=page.before?Number(page.before):messages.length,start=Math.max(0,end-page.limit);
    return {records:structuredClone(messages.slice(start,end)),...start?{cursor:String(start)}:{}};
   }}},admissionOwner:{captureSessionHookAuthorization:async()=>async()=>{if(!live)throw new Error('retry_revoked')}}});
  const input={permit,attempt,directory,sessionID:'ses_root',phase:'retry' as const,event:{sessionID:'ses_root',agent:'orchestrator',model:{providerID:'saved',id:'one'},error:{statusCode:429},attempt:1,decision:{retry:true as const,delay:100}}};
  expect(await owner.retry(input)).toEqual({decision:{retry:false}});expect(sent).toHaveLength(0);expect(await primary.readRecord('ses_root')).toMatchObject({...execution,nativeFallback:{execution:{providerID:'saved',modelID:'two',agent:'orchestrator',variant:'default'}}});
  messages[1].info={...messages[1].info,time:{completed:10},error:{statusCode:429}};
  await primary.observe({type:'session.status',properties:{sessionID:'ses_root',status:{type:'idle'}}});expect(sent).toHaveLength(1);expect(sent[0]).toMatchObject({model:{providerID:'saved',modelID:'two'},variant:'default'});
  const recovery=await primary.readRecord('ses_root');if(!recovery?.recoveryID||!recovery.recoveryPrompt)throw new Error('actual_fallback_missing');
  const recoveryUser={devryanContextKey:'actual-recovery-user',info:{id:recovery.recoveryID,role:'user',sessionID:'ses_root'},parts:structuredClone(recovery.recoveryPrompt.parts)};
  messages.push(recoveryUser);
  const backupRetry={...input,event:{...input.event,model:{providerID:'saved',id:'two'}}};
  expect(await owner.retry(backupRetry)).toEqual({decision:{retry:false}});
  expect(await primary.readRecord('ses_root')).toEqual(recovery);expect(sent).toHaveLength(1);
  await expect(owner.retry({...backupRetry,event:{...backupRetry.event,model:{providerID:'foreign',id:'two'}}})).rejects.toThrow('native_slim_retry_primary_fenced');
  const context={...input,phase:'context' as const,messages:[recoveryUser]};
  // The real controller's reserved read-only prompt must reach inference without
  // opening the scheduler or acknowledging taskboard terminal envelopes.
  expect(await owner.transformMessages(context)).toEqual({messages:[recoveryUser],presentationInsertions:[]});
  expect(await primary.readRecord('ses_root')).toEqual(recovery);
  const status={...recoveryUser,devryanContextKey:'actual-status',info:{...recoveryUser.info,id:'msg_status'},nativeStatus:{source:'native-sequence',kind:'status-only'}};
  messages.push(status);
  const {nativeStatus,...projectedStatus}=status;void nativeStatus;
  const skill={info:{role:'user'},parts:[{type:'text',text:'SDK skill context'}]};
  const presentation={...context,messages:[recoveryUser,projectedStatus,skill]};
  expect(await owner.transformMessages(presentation)).toEqual({messages:presentation.messages,presentationInsertions:[]});
  const shortLength=messages.length;
  messages.push(...Array.from({length:110},(_,index)=>({...status,info:{...status.info,id:`msg_status${index}`}})));
  const beforePages=historyReads;
  expect(await owner.transformMessages(presentation)).toEqual({messages:presentation.messages,presentationInsertions:[]});
  expect(historyReads-beforePages).toBe(2);messages.splice(shortLength);
  const foreign={...recoveryUser,info:{...recoveryUser.info,id:'msg_foreign'}};
  messages.push(foreign);
  await expect(owner.transformMessages(context)).rejects.toThrow('native_slim_context_primary_fenced');messages.pop();
  missingSource=true;await expect(owner.transformMessages(context)).rejects.toThrow('native_slim_context_source_unavailable');missingSource=false;
  authorized=false;await expect(owner.transformMessages(context)).rejects.toMatchObject({code:'native_fallback_fenced'});authorized=true;
  await primary.plugin({action:'hello',policyVersion:1,instanceID:'actual-controller',version:'2.0.21'});
  await expect(owner.transformMessages(context)).rejects.toMatchObject({code:'native_fallback_fenced'});
  await primary.plugin({action:'hello',policyVersion:1,instanceID:'actual-controller',version:'2.0.20'});
  const step={info:{id:'msg_recoveryStep',sessionID:'ses_root',role:'assistant',parentID:recovery.recoveryID,time:{}},parts:[],
   turnOwnership:{source:'native-sequence',userMessageID:recovery.recoveryID}};
  messages.push(step);
  await primary.plugin({action:'step',instanceID:'actual-controller',sessionID:'ses_root',userMessageID:recovery.recoveryID,
   assistantMessageID:'msg_recoveryStep',execution:recovery.recoveryExecution});
  const beforeStep=historyReads;
  expect(await owner.transformMessages(presentation)).toEqual({messages:presentation.messages,presentationInsertions:[]});
  expect(historyReads).toBe(beforeStep);expect(stepReads).toBe(2);
  // A real canonical compaction adoption retains this same recovery authority.
  const compact={devryanContextKey:'actual-compaction',info:{id:'msg_compact',role:'user',sessionID:'ses_root'},
   parts:[{type:'text',synthetic:true,metadata:{compaction_continue:true},text:'Continue the same recovery.'}]};
  messages.push(compact);
  await primary.plugin({action:'message',instanceID:'actual-controller',sessionID:'ses_root',userMessageID:'msg_compact'});
  expect(await primary.readRecord('ses_root')).toMatchObject({activeUserID:'msg_compact',recoveryID:recovery.recoveryID,attemptCount:1});
  const compacted={...context,messages:[recoveryUser,compact]};
  expect(await owner.transformMessages(compacted)).toEqual({messages:compacted.messages,presentationInsertions:[]});
  expect(await owner.transformMessages(context)).toEqual({messages:context.messages,presentationInsertions:[]});
  expect(historyReads).toBeGreaterThan(0);
  live=false;await expect(owner.retry(input)).rejects.toThrow('retry_revoked');expect(sent).toHaveLength(1);
  await expect(owner.transformMessages(compacted)).rejects.toThrow('retry_revoked');live=true;
  await primary.control('ses_root','stop');
  await expect(owner.transformMessages(compacted)).rejects.toThrow('native_slim_context_primary_fenced');
  expect(sent).toHaveLength(1);
 }finally{await primary.drain();await fs.rm(f.root,{recursive:true,force:true});}
});

test('original retry before a lazy native Step retains an exact choice until the actual assistant is published',async()=>{
 const f=await originalFixture();
 try{
  for(const scenario of ['initial','later','exhausted','unavailable']){
   const previous=scenario==='later',available=scenario==='initial'||previous;
   const execution={providerID:'saved',modelID:'one',agent:'orchestrator',variant:'high'};
   const permit={token:'c'.repeat(64),revision:0,sessionID:'ses_lazy'},attempt={traceID:'a'.repeat(32),spanID:'b'.repeat(16)};
   const messages:Array<{info:Record<string,unknown>;parts:readonly unknown[];turnOwnership?:{source:string;userMessageID:string}}>=[{info:{id:'msg_user',sessionID:'ses_lazy',role:'user'},parts:[{type:'text',text:'Exact objective'}]}];
   const observation={session:{id:'ses_lazy',directory},complete:true,status:'busy',blocked:false,messages};
   const sent:unknown[]=[];let instance='actual-controller',live=true,nativeInfoReads=0,revokeHello=false;
   const client={generation:()=>2 as const,health:{probe:async()=>({ready:true,version:'2.0.20'}),runtimeInfo:async()=>{nativeInfoReads++;if(revokeHello)live=false;return {version:'2.0.20'}}},sessions:{get:async()=>structuredClone(observation.session),children:async()=>[],status:async()=>observation.status==='idle'?{}:{ses_lazy:{type:observation.status}},messages:async()=>({records:structuredClone(messages)}),message:async(_id:string,messageID:string)=>structuredClone(messages.find(message=>message.info.id===messageID)),todo:async()=>[],abort:async()=>true},interaction:{permissions:{list:async()=>[]},questions:{list:async()=>[]}},catalog:{tools:async()=>({ids:['read','glob','grep']})},prompts:{prompt:async()=>{throw Error('native_fallback_must_use_existing_dispatch_owner')}}};
   const primary=createPrimaryRecoveryHost({dataDirectory:path.join(f.root,scenario),isManaged:()=>true,authorize:async()=>true,isNativeFallbackError:f.originals.isReviewedSlimFailoverError,openCodeClient:client,dispatchNativeRecovery:async(_record,body)=>{sent.push(body)},managedBarrier:async()=>({state:'clear'}),progressTimeoutMs:false});
   try{
    await primary.initialize();
    if(previous)await primary.helloNative({policyVersion:1,instanceID:instance});
    await primary.admitNativePrompt({sessionID:'ses_lazy',messageID:'msg_user',directory,execution,body:{messageID:'msg_user',agent:execution.agent,model:{providerID:execution.providerID,modelID:execution.modelID},variant:execution.variant}},{sessionID:'ses_lazy',owner:null});
    if(previous){
     messages.push({info:{id:'msg_previous',sessionID:'ses_lazy',role:'assistant',parentID:'msg_user',time:{},...execution},parts:[],turnOwnership:{source:'native-sequence',userMessageID:'msg_user'}});
     await primary.plugin({action:'step',instanceID:instance,sessionID:'ses_lazy',userMessageID:'msg_user',assistantMessageID:'msg_previous',execution,nativeAttempt:{traceID:'a'.repeat(32),spanID:'c'.repeat(16)},nativePermitSha256:nativeStepPermitSha256(permit)});
     messages[1].info.time={completed:10};
    }
    const owner=createNativeSlimContextOwner({getInstanceID:()=>instance,originals:f.originals,primaryRuntime:primary,getManagedRuntime:async()=>{throw Error('retry_cannot_create_tasks')},locations:[{directory,compatibility:{slim:{nativeRuntime:{fallback:{enabled:true},runtimeChains:{orchestrator:available?['saved/one','saved/two']:scenario==='exhausted'?['saved/one']:[]}}}}}],openCodeClient:{sessions:{get:async()=>structuredClone(observation.session),message:async(_id:string,messageID:string)=>structuredClone(messages.find(message=>message.info.id===messageID)),messages:async()=>({records:structuredClone(messages)})}},admissionOwner:{captureSessionHookAuthorization:async()=>async()=>{if(!live||instance!=='actual-controller')throw Error('retry_revoked')}}});
    const input={permit,attempt,directory,sessionID:'ses_lazy',phase:'retry' as const,event:{sessionID:'ses_lazy',agent:execution.agent,model:{providerID:'saved',id:'one'},error:{statusCode:429},attempt:1,decision:{retry:true as const,delay:100}}};
    await expect(owner.retry({...input,attempt:undefined})).rejects.toThrow('native_slim_retry_primary_fenced');
    if(scenario==='initial'){
     expect(nativeInfoReads).toBe(0);revokeHello=true;
     await expect(owner.retry(input)).rejects.toThrow('retry_revoked');
     expect((await primary.readRecord('ses_lazy'))?.nativeFallback).toBeUndefined();
     live=true;revokeHello=false;
    }
    const beforeInfo=nativeInfoReads;
    expect(await owner.retry(input)).toEqual({decision:{retry:false}});expect(nativeInfoReads).toBe(beforeInfo+1);
    expect(messages.filter(message=>message.info.role==='assistant')).toHaveLength(previous?1:0);expect(sent).toHaveLength(0);
    const pending=await primary.readRecord('ses_lazy');
    expect(pending).toMatchObject({state:'observing',stepID:previous?'msg_previous':null,nativeFallback:{stepID:null,...available?{execution:{providerID:'saved',modelID:'two',variant:'default'}}:{},pending:{instanceID:instance,previousStepID:previous?'msg_previous':null,attempt,permitSha256:nativeStepPermitSha256(permit)}}});
    instance='foreign-controller';
    await expect(owner.retry(input)).rejects.toThrow('retry_revoked');
    instance='actual-controller';expect(await primary.readRecord('ses_lazy')).toEqual(pending);
    // Match the SDK's lazy failure order: retry first, then its actual Started,
    // then completion/error. The hook creates neither history nor a recovery send.
    const assistant:{info:Record<string,unknown>;parts:readonly unknown[];turnOwnership:{source:string;userMessageID:string}}={info:{id:'msg_failed',sessionID:'ses_lazy',role:'assistant',parentID:'msg_user',time:{},...execution},parts:[],turnOwnership:{source:'native-sequence',userMessageID:'msg_user'}};
    messages.push(assistant);
    await primary.plugin({action:'step',instanceID:instance,sessionID:'ses_lazy',userMessageID:'msg_user',assistantMessageID:'msg_failed',execution,nativeAttempt:attempt,nativePermitSha256:nativeStepPermitSha256(permit)});
    expect(await primary.readRecord('ses_lazy')).toMatchObject({stepID:'msg_failed',nativeFallback:{stepID:'msg_failed'}});
    expect((await primary.readRecord('ses_lazy'))?.nativeFallback?.pending).toBeUndefined();expect(sent).toHaveLength(0);
    assistant.info={...assistant.info,time:{completed:20},error:{statusCode:429}};observation.status='idle';
    await primary.observe({type:'session.status',properties:{sessionID:'ses_lazy',status:{type:'idle'}}});
    expect(sent).toHaveLength(available?1:0);
    if(available)expect(sent[0]).toMatchObject({model:{providerID:'saved',modelID:'two'},variant:'default'});
    else expect(await primary.readRecord('ses_lazy')).toMatchObject({state:'needs_attention',reason:scenario==='exhausted'?'native_fallback_exhausted':'native_fallback_unavailable',stepID:'msg_failed'});
    live=false;await expect(owner.retry(input)).rejects.toThrow('retry_revoked');
    instance='replacement';expect(sent).toHaveLength(available?1:0);
   }finally{await primary.drain();}
  }
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
