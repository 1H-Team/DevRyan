import { describe, expect, it } from 'vitest';
import { createNativeManagedTaskOwner } from './managed-task-owner.js';

describe('native managed task owner', () => {
  it('uses host Plan authority and saved execution; rejects caller model and read-only overrides', async () => {
    const calls = [];
    const captures = [];
    const run = createNativeManagedTaskOwner({ admissionOwner: { recheckExecution: async () => {}, withPermit: async (_input, action) => action() },
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
    const run = createNativeManagedTaskOwner({ admissionOwner: { recheckExecution: async () => { if (++checks === 3) throw Error('revoked'); } },
      taskContext: { authorizeNativeTaskInvocation: async () => ({ readOnly: false }) },
      getManagedRuntime: () => ({ handleRpc: async ({ params }) => { waits += 1; expect(params.waitTimeoutMs).toBe(25_000); return { task: { status: 'running' } }; } }) });
    await expect(run({ tool: 'devryan_task', authorization: { input: { provenance: { id: 'devryan.managed-task', kind: 'plugin' } } },
      input: { action: 'wait', task_id: 'task_1' } })).rejects.toThrow('revoked');
    expect(waits).toBe(1);
  });
  it('serializes cancellation with holds and rejects malformed cancellation options', async () => {
    const calls = [];
    const run = createNativeManagedTaskOwner({ admissionOwner: { recheckExecution: async () => {},
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
function adapter(handleRpc,extra={}) {
  return createNativeManagedTaskOwner({admissionOwner:{recheckExecution:async()=>{},withPermit:async(_input,run)=>run()},
    taskContext:{authorizeNativeTaskInvocation:async()=>({readOnly:false})},getManagedRuntime:()=>({handleRpc}),...extra});
}
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
