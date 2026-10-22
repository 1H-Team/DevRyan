import { describe, expect, it } from 'vitest';
import { createNativeManagedTaskOwner } from './managed-task-owner.js';
import { createNativeAdmissionOwner } from './native-admission-owner.js';

describe('native managed task owner', () => {
  it.each(['before', 'during'])('cancels %s control preparation without submission and settles an acquired lease', async phase => {
    const controller = new AbortController(), captures = [], calls = [];
    const reason = Error('caller disconnected');
    const run = createNativeManagedTaskOwner({
      admissionOwner: { recheckExecution: async () => {}, withPermit: async (_input, action) => action(),
        withManagedTaskCatalogInvocation: async (_input, action) => action() },
      taskContext: { authorizeNativeTaskInvocation: async () => ({ readOnly: true }) },
      executionHost: { nativeManagedControl: async input => {
        captures.push(input.action);
        if (input.action === 'begin') controller.abort(reason);
        return { lease: { token: 'acquired' } };
      } }, getManagedRuntime: () => ({ handleRpc: async input => { calls.push(input); } }),
    });
    if (phase === 'before') controller.abort(reason);
    await expect(run({ tool: 'devryan_task', authorization: { input: { provenance: { id: 'devryan.managed-task', kind: 'plugin' } } },
      input: { action: 'start', agent: 'explorer', prompt: 'Inspect' } }, { signal: controller.signal })).rejects.toBe(reason);
    expect(calls).toEqual([]);
    expect(captures).toEqual(phase === 'before' ? [] : ['begin', 'finish']);
  });
  it('uses host Plan authority and saved execution; rejects caller model and read-only overrides', async () => {
    const calls = [];
    const captures = [];
    const run = createNativeManagedTaskOwner({ admissionOwner: { withManagedTaskCatalogInvocation: async (_input, action) => action(), recheckExecution: async () => {}, withPermit: async (_input, action) => action() },
      taskContext: { authorizeNativeTaskInvocation: async () => ({ readOnly: true }) },
      executionHost: { nativeManagedControl: async input => { captures.push(input); return { lease: { token: 'control_1' } }; },
        plugin: async () => { throw Error('legacy bridge must remain closed'); } },
      getManagedRuntime: () => ({ handleRpc: async request => {
        expect(captures.map(value => value.action)).toEqual(['begin']); calls.push(request); return { task: { taskId: 'task_1' } };
      } }) });
    const input = { tool: 'devryan_task', authorization: { input: { provenance: { id: 'devryan.managed-task', kind: 'plugin' } } },
      sessionID: 'ses_root', messageID: 'msg_assistant', callID: 'call_1', directory: '/project',
      input: { action: 'start', agent: 'fixer', prompt: 'Inspect this bug' } };
    await run(input);
    expect(calls[0]).toMatchObject({ method: 'submit', params: { readOnly: true, mode: 'orchestrator',
      providerId: '', modelId: '', variant: null, dispatchGroupId: 'msg_assistant', dispatchCallId: 'call_1' } });
    expect(calls[0].params).not.toHaveProperty('timeoutAt');
    expect(captures.map(value => value.action)).toEqual(['begin', 'finish']);
    expect(captures[0]).toEqual({ action: 'begin', invocation: input });
    expect(captures[1]).toEqual({ action: 'finish', token: 'control_1', invocation: input });
    await expect(run({ ...input, input: { ...input.input, readOnly: false } })).rejects.toThrow('native_task_input_invalid');
    await expect(run({ ...input, input: { ...input.input, model_id: 'other' } })).rejects.toThrow('native_task_input_invalid');
    expect(calls).toHaveLength(1);
  });
  it('rechecks ownership on every bounded wait and stops on revocation', async () => {
    let checks = 0, waits = 0;
    const run = createNativeManagedTaskOwner({ admissionOwner: { withManagedTaskCatalogInvocation: async (_input, action) => action(), recheckExecution: async () => { if (++checks === 3) throw Error('revoked'); } },
      taskContext: { authorizeNativeTaskInvocation: async () => ({ readOnly: false }) },
      getManagedRuntime: () => ({ handleRpc: async ({ params }) => { waits += 1; expect(params.waitTimeoutMs).toBe(25_000); return { task: { status: 'running' } }; } }) });
    await expect(run({ tool: 'devryan_task', authorization: { input: { provenance: { id: 'devryan.managed-task', kind: 'plugin' } } },
      input: { action: 'wait', task_id: 'task_1' } })).rejects.toThrow('revoked');
    expect(waits).toBe(1);
  });
  it('serializes cancellation with holds and rejects malformed cancellation options', async () => {
    const calls = [];
    const run = createNativeManagedTaskOwner({ admissionOwner: { withManagedTaskCatalogInvocation: async (_input, action) => action(), recheckExecution: async () => {},
      withPermit: async (_input, action) => { calls.push('locked'); return action(); } },
    taskContext: { authorizeNativeTaskInvocation: async () => { calls.push('policy'); return { readOnly: false }; } },
    getManagedRuntime: () => ({ handleRpc: async () => { calls.push('cancel'); return { task: { status: 'aborted' } }; } }) });
    const input = { tool: 'devryan_task', authorization: { input: { provenance: { id: 'devryan.managed-task', kind: 'plugin' } } },
      input: { action: 'cancel', task_id: 'task_1', cascade: true, reason: 'User stopped task' } };
    await run(input);
    expect(calls).toEqual(['policy', 'locked', 'policy', 'cancel']);
    await expect(run({ ...input, input: { ...input.input, cascade: 'true' } })).rejects.toThrow('native_task_input_invalid');
    await expect(run({ ...input, input: { ...input.input, reason: 1 } })).rejects.toThrow('native_task_reason_required');
    expect(calls.filter(call => call === 'cancel')).toHaveLength(1);
  });
});

const invocation = {tool:'devryan_task',authorization:{input:{provenance:{kind:'plugin',id:'devryan.managed-task'}}},
  directory:'/project',sessionID:'ses_root',messageID:'msg_assistant',callID:'call_1'};
const terminal = (id='dvr_task_one',status='failed',preview='retained detail') => ({task:{taskId:id,rootSessionId:'ses_root',directory:'/project',status},
  resultEnvelope:{envelopeId:`dvr_result_${id}`,taskId:id,rootSessionId:'ses_root',directory:'/project',status,action:null,partial:status!=='completed',recoverablePreview:preview}});
it.each(['continue','retry','resume','abandon'])('actual admission owner permits bounded %s barrier inspection without widening result-read authority',async action=>{
 const owner=createNativeAdmissionOwner({directory:invocation.directory,ownerID:'test',
  runtime:{registerNativeSession:async()=>{},nativeAdmissionState:async()=>({revision:0,held:false})},
  getSession:async id=>({id,directory:invocation.directory}),authorizeOperation:async()=>{},withSessionLock:async(_id,run)=>run()});
 const args={action,task_id:'dvr_task_one'},authorization={operation:'tool.execute',sessionID:invocation.sessionID,messageID:invocation.messageID,
  input:{toolID:'devryan_task',callID:invocation.callID,provenance:{kind:'plugin',id:'devryan.managed-task'},input:args}};
 try{
  const permit=await owner.handleRpc('native.admission.authorize',authorization),input={...invocation,input:args,authorization,permit};
  await expect(owner.withManagedResultRead(input,async()=>{})).rejects.toMatchObject({code:'native_managed_result_read_required'});
  const prior=terminal();prior.resultEnvelope.action=action;
  const run=adapter(async request=>request.method==='snapshot'?{available:true,bridgeReady:true,tasks:[prior.task],resultEnvelopes:[prior.resultEnvelope],recoveryWarning:null}
   :request.method==='barrier_status'?{state:'clear',taskIds:[]}:prior,{admissionOwner:owner});
  expect(await run(input)).toMatchObject({state:'already_dispositioned',barrier:{state:'clear'}});
 }finally{owner.dispose();}
});

it.each([false,true])('failed publication capture cannot accept a final page; the same cursor remains retryable (batch=%s)',async batch=>{
 const result=terminal(),id=result.task.taskId;
 result.resultReference={taskId:id,envelopeId:result.resultEnvelope.envelopeId,text:'a',totalBytes:2,returnedBytes:1,complete:false,nextCursor:'last'};
 const page={taskId:id,resultReference:{...result.resultReference,text:'b',returnedBytes:2,complete:true,nextCursor:null}};
 const messages=[],identity={controllerInstanceID:'test',configurationDigest:'a'.repeat(64),objectiveID:'objective',cancellationGeneration:0,
  attempt:{traceID:'b'.repeat(32),spanID:'c'.repeat(16)},permitSha256:'d'.repeat(64)};
 let throwCapture=false,readReturned=false,acks=0;
 const run=adapter(async request=>{
  if(request.method==='read_result'){readReturned=true;return batch?{resultContractVersion:2,results:[page],failed:[],notProcessed:[]}:page;}
  if(request.method==='acknowledge'){acks++;return {resultEnvelope:{...result.resultEnvelope,action:'abandon'}};}
  return result;
 },{readResultPublication:async input=>{
  if(throwCapture&&readReturned)throw Error('publication reader failed');
  return {identity:{...identity,stepID:input.messageID},messages:[...messages,{info:{id:input.messageID,sessionID:'ses_root',role:'assistant'},parts:[]}]};
 }});
 const wait={...invocation,messageID:'msg_wait',callID:'wait',input:{action:'wait',task_id:id}},output=await run(wait);
 messages.push({info:{id:wait.messageID,sessionID:'ses_root',role:'assistant'},parts:[{type:'tool',tool:'devryan_task',callID:wait.callID,
  state:{status:'completed',input:wait.input,output:JSON.stringify(output),metadata:{}}}]});
 const read={...invocation,messageID:'msg_read',callID:'read',input:batch?{action:'read_result',reads:[{task_id:id,result_cursor:'last'}]}:{action:'read_result',task_id:id,result_cursor:'last'}};
 throwCapture=true;await expect(run(read)).rejects.toThrow('publication reader failed');throwCapture=false;
 await expect(run({...invocation,messageID:'msg_later',input:{action:'abandon',task_id:id}})).rejects.toThrow('detail_required');
 expect(acks).toBe(0);readReturned=false;
 const retry=await run(read);expect(batch?retry.results[0]:retry).toEqual(page);
 await expect(run({...invocation,messageID:'msg_later',input:{action:'abandon',task_id:id}})).rejects.toThrow('not_published');
 expect(acks).toBe(0);
});
function adapter(handleRpc,extra={}) {
  return createNativeManagedTaskOwner({admissionOwner:{withManagedTaskCatalogInvocation:async(_input,action)=>action(),recheckExecution:async()=>{},withPermit:async(_input,run)=>run()},
    taskContext:{authorizeNativeTaskInvocation:async()=>({readOnly:false})},getManagedRuntime:()=>({handleRpc}),...extra});
}
it.each(['catalog', 'permit', 'control'])('a durable start remains a committed receipt after a late %s failure', async phase => {
  const controls = [], late = Object.assign(Error('late private failure'), { code: 'configuration_changed' });
  const run = adapter(async request => {
    expect(request.method).toBe('submit');
    return { task: { taskId: 'dvr_task_committed', rootSessionId: invocation.sessionID, directory: invocation.directory, status: 'queued' } };
  }, { admissionOwner: { recheckExecution: async () => {},
    withPermit: async (_input, action) => { const result = await action(); if (phase === 'permit') throw late; return result; },
    withManagedTaskCatalogInvocation: async (_input, action) => { const result = await action(); if (phase === 'catalog') throw late; return result; } },
    executionHost: { nativeManagedControl: async input => {
      controls.push(input.action); if (input.action === 'finish' && phase === 'control') throw late;
      return { lease: { token: 'owned-control' } };
    } } });
  expect(await run({ ...invocation, input: { action: 'start', agent: 'fixer', prompt: 'Owned task' } })).toEqual({ committed: true,
    taskId: 'dvr_task_committed', rootSessionId: invocation.sessionID, action: 'start', status: 'queued', projectionError: 'native_task_post_commit_fenced' });
  expect(controls).toEqual(['begin', 'finish']);
});
it('large retained sibling reports stay internal while already-dispositioned recovery returns a bounded lean barrier',async()=>{
 const result=terminal('dvr_task_done','completed');result.resultEnvelope.action='continue';
 const siblings=Array.from({length:20},(_,index)=>{const value=terminal('dvr_task_sibling_'+index,'completed','x'.repeat(64000));value.resultEnvelope.action='continue';return value;});
 const snapshot={available:true,bridgeReady:true,recoveryWarning:null,tasks:siblings.map(row=>({...row.task,recoverablePreview:row.resultEnvelope.recoverablePreview})),resultEnvelopes:siblings.map(row=>row.resultEnvelope)};
 expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeGreaterThan(48*1024);
 const run=adapter(async request=>request.method==='snapshot'?snapshot:request.method==='barrier_status'?{state:'clear',taskIds:[]}:result,
  {readResultPublication:async()=>{throw Error('A read-only already-dispositioned wait needs no new publication authority');}});
 const output=await run({...invocation,input:{action:'wait',task_id:result.task.taskId}});
 expect(output).toMatchObject({state:'already_dispositioned',taskId:result.task.taskId,barrier:{state:'clear',taskIds:[]}});
 expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(48*1024);
});
it('requires terminal collection before disposition, preserves manual recovery and follows up through the scheduler',async()=>{
  const calls=[],result=terminal();
  const run=adapter(async request=>{calls.push(request);return request.method==='acknowledge'?{acknowledged:true}:result;});
  await expect(run({...invocation,input:{action:'retry',task_id:result.task.taskId}})).rejects.toThrow('wait_required');
  await run({...invocation,input:{action:'wait',task_id:result.task.taskId}});
  await expect(run({...invocation,input:{action:'retry',task_id:result.task.taskId,provider_id:'caller'}})).rejects.toThrow('input_invalid');
  result.task.manualRecoveryRequired=true;
  await expect(run({...invocation,input:{action:'retry',task_id:result.task.taskId}})).rejects.toThrow('manual_model_recovery_required');
  delete result.task.manualRecoveryRequired;
  expect(await run({...invocation,input:{action:'retry',task_id:result.task.taskId,agent:'fixer',prompt:'Reframed task'}})).toEqual({acknowledged:true});
  expect(calls.at(-1)).toMatchObject({method:'acknowledge',params:{action:'retry',agent:'fixer',prompt:'Reframed task',resultMode:'reference',resultContractVersion:1}});
});
it('wait_any returns one bounded private slice and validates exact selected results',async()=>{
  let calls=0;const result=terminal();
  const run=adapter(async request=>{expect(request.method).toBe('wait_any');expect(request.params.waitTimeoutMs).toBe(25000);calls++;
    return {schemaVersion:2,rootSessionId:'ses_root',cursor:`cursor_${calls}`,results:calls===1?[]:[result],readyTaskIds:calls===1?[]:[result.task.taskId],
      attention:[],pendingTaskIds:calls===1?[result.task.taskId]:[],unacknowledgedTaskIds:calls===1?[]:[result.task.taskId],
      dispositioned:[],changedTaskIds:calls===1?[]:[result.task.taskId],settled:calls!==1};});
  const request={...invocation,input:{action:'wait_any',task_ids:[result.task.taskId]}};
  expect((await run(request)).settled).toBe(false);expect(calls).toBe(1);
  expect((await run(request)).settled).toBe(true);expect(calls).toBe(2);
  const foreign=adapter(async()=>({schemaVersion:2,rootSessionId:'ses_root',cursor:'x',results:[terminal('dvr_task_foreign')],readyTaskIds:['dvr_task_foreign'],attention:[],pendingTaskIds:[],unacknowledgedTaskIds:[],dispositioned:[],changedTaskIds:[],settled:true}));
  await expect(foreign({...invocation,input:{action:'wait_any',task_ids:[result.task.taskId]}})).rejects.toThrow('wait_any_invalid');
});
it('normalizes a stale collection cursor before one long slice without changing sealed input',async()=>{
  const args={action:'wait_any',task_ids:['dvr_task_one'],after_cursor:'stale_cursor'},calls=[];
  const run=adapter(async request=>{calls.push(request.params);return {schemaVersion:2,rootSessionId:'ses_root',cursor:'fresh_cursor',cursorReset:calls.length===1,
    results:[],readyTaskIds:[],attention:[],pendingTaskIds:['dvr_task_one'],unacknowledgedTaskIds:[],dispositioned:[],changedTaskIds:[],settled:false};});
  expect(await run({...invocation,input:args})).toMatchObject({settled:false,cursor:'fresh_cursor'});
  expect(calls.map(value=>[value.afterCursor,value.waitTimeoutMs])).toEqual([['stale_cursor',1],['fresh_cursor',25000]]);
  expect(args.after_cursor).toBe('stale_cursor');
});
it('uses separate canonical plan authority and passes the original final recheck to the actual write owner',async()=>{
  const calls=[];const run=adapter(async()=>{throw Error('no scheduler plan writes');},{taskContext:{
    authorizeNativeTaskInvocation:async()=>{throw Error('Builder cannot delegate');},authorizeNativePlanInvocation:async input=>calls.push(input),
    handleNativePlanRpc:async(input,recheck)=>{await recheck();return {content:input.text};}}});
  expect(await run({...invocation,input:{action:'plan_update',expected_version:'version',text:'# Progress'}})).toEqual({content:'# Progress'});
  expect(calls).toHaveLength(1);
});
it('copies required checks into the scheduler declaration and refuses invalid paths before ledger begin',async()=>{
  const control=[],submitted=[];
  const run=adapter(async request=>{submitted.push(request);return {task:{taskId:'dvr_task_one'}};},{executionHost:{nativeManagedControl:async input=>{control.push(input.action);return {lease:{token:'real-control'}};}}});
  const args={action:'start',agent:'fixer',prompt:'Fix',required_checks:[{name:'unit',command:'bun test',paths:['src/app.js']}]};
  await run({...invocation,input:args});expect(submitted[0].params.requiredChecks).toEqual(args.required_checks);
  await expect(run({...invocation,input:{...args,required_checks:[{name:'unit',command:'bun test',paths:['../outside']}]}})).rejects.toThrow();
  expect(control).toEqual(['begin','finish']);
});
it('recognizes missing/dispositioned tasks only after the current authoritative barrier, without a replacement dispatch',async()=>{
  const missing=Object.assign(Error('retained task expired'),{code:'task_not_found'});let state='clear',acks=0;
  const run=adapter(async request=>{if(request.method==='snapshot')return {available:true,bridgeReady:true,tasks:[],resultEnvelopes:[],recoveryWarning:null};if(request.method==='barrier_status')return {rootSessionId:'ses_root',state,taskIds:state==='clear'?[]:['dvr_task_other']};
    if(request.method==='acknowledge'){acks++;throw Error('must not acknowledge twice');}throw missing;});
  expect(await run({...invocation,input:{action:'wait',task_id:'dvr_task_old'}})).toMatchObject({state:'stale_task_reference',dispositionRequired:false});
  state='active';await expect(run({...invocation,input:{action:'wait',task_id:'dvr_task_old'}})).rejects.toBe(missing);
  const prior=terminal();prior.resultEnvelope.action='retry';
  const done=adapter(async request=>request.method==='snapshot'?{available:true,bridgeReady:true,tasks:[prior.task],resultEnvelopes:[prior.resultEnvelope],recoveryWarning:null}:request.method==='barrier_status'?{rootSessionId:'ses_root',state:'active',taskIds:['dvr_task_followup']}:prior);
  expect(await done({...invocation,input:{action:'retry',task_id:prior.task.taskId}})).toMatchObject({state:'already_dispositioned',barrier:{taskIds:['dvr_task_followup']}});
  expect(acks).toBe(0);
});
it('parallel starts queued behind the session permit get a full commit budget once they hold it',async()=>{
  let tail=Promise.resolve(),submitted=0;
  const serialized=action=>{const run=tail.then(action);tail=run.catch(()=>{});return run;};
  const options={startPhaseTimeoutMs:100,executionHost:{nativeManagedControl:async()=>({lease:{token:'control'}})},
    admissionOwner:{recheckExecution:async()=>{},withManagedTaskCatalogInvocation:async(_input,action)=>action(),withPermit:async(_input,action)=>serialized(action)}};
  // Five 40 ms commits queue for 200 ms in total, twice one start's budget.
  const run=adapter(async request=>{expect(request.method).toBe('submit');await new Promise(resolve=>setTimeout(resolve,40));submitted++;
    return {task:{taskId:`dvr_task_parallel_${submitted}`,rootSessionId:invocation.sessionID,directory:invocation.directory,status:'queued'}};},options);
  const results=await Promise.all(Array.from({length:5},(_,index)=>run({...invocation,callID:`call_${index}`,input:{action:'start',agent:'explorer',prompt:`Scope ${index}`}})));
  expect(results.map(result=>result.task.taskId).sort()).toEqual(Array.from({length:5},(_,index)=>`dvr_task_parallel_${index+1}`));
  const stalled=adapter((_request,context)=>new Promise((_resolve,reject)=>context.signal.addEventListener('abort',()=>reject(context.signal.reason))),options);
  await expect(stalled({...invocation,input:{action:'start',agent:'explorer',prompt:'Stalled'}})).rejects.toMatchObject({code:'native_task_start_timeout'});
});
