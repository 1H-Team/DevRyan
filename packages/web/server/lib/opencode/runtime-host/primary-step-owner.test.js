import { expect, it } from 'vitest';
import { createNativePrimaryStepOwner,nativeStepPermitSha256 } from './primary-step-owner.js';

it('interrupts only the exact one-generation Stop fence during a native Step handoff', async () => {
  const permit={token:'runner',sessionID:'ses_root',revision:1};
  const event={type:'session.step.started',durable:{seq:4,aggregateID:'ses_root'},
    data:{sessionID:'ses_root',assistantMessageID:'msg_assistant',agent:'orchestrator',model:{providerID:'sim',id:'m1'}}};
  const original={sessionID:'ses_root',directory:'/project',anchorID:'msg_user',agent:'orchestrator',
    providerID:'sim',modelID:'m1',variant:'default',state:'observing',cancellationGeneration:4,tools:{read:true}};
  const assistant={info:{id:'msg_assistant',sessionID:'ses_root',role:'assistant',parentID:'msg_user',agent:'orchestrator',
    providerID:'sim',modelID:'m1',variant:'default',time:{}},turnOwnership:{source:'native-sequence',userMessageID:'msg_user'}};
  for(const mode of ['stop','legacy','disabled','double-stop','foreign-user','changed-model','changed-fallback','superseded','already-cancelled','already-superseded','revoked','stale','foreign-assistant','changed-during-assistant','changed-during-recheck','unavailable','external']){
    let record=structuredClone(original),pluginCalled=false,acks=0;
    const canonical=structuredClone(assistant);
    if(mode==='already-cancelled')record.state='cancelled';
    if(mode==='already-superseded')record.state='superseded';
    if(mode==='external'){record.providerID='cursor-acp';canonical.info.providerID='cursor-acp';}
    const failure=Object.assign(new Error('fixed handoff refusal'),{code:mode==='unavailable'?'native_primary_step_invalid':'provider_recovery_fenced'});
    const owner=createNativePrimaryStepOwner({instanceID:'controller',...(mode==='legacy'?{}:{allowStopHandoff:mode!=='disabled'}),
      getInstanceID:()=>mode==='stale'&&pluginCalled?'replacement':'controller',
      admissionOwner:{handleRpc:async()=>{if(mode==='revoked'&&pluginCalled)throw Error('native_permit_revoked');
        if(mode==='changed-during-recheck'&&pluginCalled)record.cancellationGeneration++;return permit;},
        acknowledgeStartedContinuation:async()=>{acks++;}},
      openCodeClient:{sessions:{get:async()=>({id:'ses_root',directory:'/project'}),message:async()=>{
        if(mode==='changed-during-assistant'&&pluginCalled)record.cancellationGeneration++;
        return mode==='foreign-assistant'&&pluginCalled?{...canonical,info:{...canonical.info,id:'msg_foreign'}}:structuredClone(canonical);}}},
      primaryRuntime:{readRecord:async()=>structuredClone(record),helloNative:async()=>{},plugin:async()=>{
        pluginCalled=true;record={...record,state:'cancelled',reason:'stop',cancellationGeneration:record.cancellationGeneration+1};
        if(mode==='double-stop')record.cancellationGeneration++;
        if(mode==='foreign-user')record.anchorID='msg_foreign';
        if(mode==='changed-model')record.modelID='different';
        if(mode==='changed-fallback')record.nativeFallback={pending:{previousStepID:'msg_assistant'}};
        if(mode==='superseded')record.state='superseded';
        throw failure;
      }}});
    const run=()=>mode==='external'?owner.external({sessionID:'ses_root',userMessageID:'msg_user',assistantMessageID:'msg_assistant',
      agent:'orchestrator',modelID:'m1'},async()=>{}):owner({permit,event,attempt:{traceID:'trace',spanID:'attempt'}});
    if(mode==='stop')await expect(run()).resolves.toEqual({tracked:false,stop:{sessionID:'ses_root',assistantMessageID:'msg_assistant'}});
    else await expect(run()).rejects.toBeTruthy();
    expect(acks).toBe(0);
  }
});

it('tracks an external Cursor step only with canonical turn ownership and a current original grant', async () => {
  const scope = { directory: '/project', sessionID: 'ses_cursor', userMessageID: 'msg_user',
    assistantMessageID: 'msg_cursor', agent: 'orchestrator', modelID: 'composer', variant: 'default' };
  let parentID = 'msg_user', current = true, steps = 0, acknowledgements = 0;
  const owner = createNativePrimaryStepOwner({ instanceID: 'native-instance',
    admissionOwner: { handleRpc: async () => { throw Error('external step must not acquire a native runner'); },
      acknowledgeStartedContinuation: async () => { acknowledgements++; } },
    openCodeClient: { sessions: {
      get: async () => ({ id: scope.sessionID, directory: scope.directory }),
      message: async () => ({ info: { id: scope.assistantMessageID, sessionID: scope.sessionID, role: 'assistant',
        parentID, agent: scope.agent, providerID: 'cursor-acp', modelID: scope.modelID, variant: scope.variant, time: {} },
      turnOwnership: { source: 'native-sequence', userMessageID: parentID } }),
    } },
    primaryRuntime: {
      readRecord: async () => ({ ...scope, anchorID: scope.userMessageID, providerID: 'cursor-acp' }),
      helloNative: async () => {}, plugin: async () => { steps++; },
    },
  });
  const recheck = async () => { if (!current) throw Error('original caller revoked'); };
  await expect(owner.external(scope, recheck)).resolves.toEqual({ tracked: true });
  parentID = 'msg_foreign';
  await expect(owner.external(scope, recheck)).rejects.toMatchObject({ code: 'native_primary_step_invalid' });
  parentID = scope.userMessageID; current = false;
  await expect(owner.external(scope, recheck)).rejects.toThrow('original caller revoked');
  expect({ steps, acknowledgements }).toEqual({ steps: 1, acknowledgements: 1 });
});

it('binds the primary step only after admission and exact native turn verification', async () => {
  const calls = [];
  const permit = { token: 'owned-runner', sessionID: 'ses_root' };
  const event = { type: 'session.step.started', durable: { seq: 4, aggregateID: 'ses_root' },
    data: { sessionID: 'ses_root', assistantMessageID: 'msg_assistant', agent: 'orchestrator', model: { providerID: 'sim', id: 'm1' } } };
  let userID = 'msg_user', tracked = true;
  const owner = createNativePrimaryStepOwner({ directory: '/different-constructor-root', instanceID: 'native-instance',
    admissionOwner: { handleRpc: async (method, input) => { calls.push(method);
      expect(input.existingPermit ?? input.permit).toBe(permit); return permit; },
    acknowledgeStartedContinuation: async input => { calls.push({ action: 'acknowledge', ...input }); } },
    openCodeClient: { sessions: {
      get: async (id, options) => { expect(id).toBe('ses_root'); expect(options).toBeUndefined(); return { id: 'ses_root', directory: '/project' }; },
      message: async () => ({ info: { id: 'msg_assistant', sessionID: 'ses_root', role: 'assistant', parentID: userID,
        agent: 'orchestrator', providerID: 'sim', modelID: 'm1', time: {} },
      turnOwnership: { source: 'native-sequence', userMessageID: userID } }),
    } },
    primaryRuntime: {
      readRecord: async () => tracked ? { sessionID: 'ses_root', directory: '/project', anchorID: 'msg_user', agent: 'orchestrator',
        providerID: 'sim', modelID: 'm1', variant: null } : null,
      helloNative: async input => { calls.push({ action: 'hello-native', ...input }); },
      plugin: async input => { calls.push(input); },
    },
  });
  const attempt={traceID:'actual-trace',spanID:'actual-attempt'};
  await owner({ permit, event, attempt });
  expect(calls).toEqual(['native.admission.authorize',
    { action: 'hello-native', policyVersion: 1, instanceID: 'native-instance' },
    'native.admission.recheck',
    { action: 'step', instanceID: 'native-instance', sessionID: 'ses_root', userMessageID: 'msg_user',
      assistantMessageID: 'msg_assistant', execution: { providerID: 'sim', modelID: 'm1', agent: 'orchestrator', variant: null },
      nativeAttempt:attempt,nativePermitSha256:nativeStepPermitSha256(permit) },
    'native.admission.recheck',
    { action: 'acknowledge', sessionID: 'ses_root', userMessageID: 'msg_user', assistantMessageID: 'msg_assistant' }]);
  const beforeMalformed=calls.length;
  await expect(owner({permit,event,attempt:{spanID:'missing-trace'}})).rejects.toMatchObject({code:'native_primary_step_invalid'});
  expect(calls).toHaveLength(beforeMalformed);
  userID = 'msg_foreign';
  await expect(owner({ permit, event })).rejects.toMatchObject({ code: 'native_primary_step_invalid', status: 403, statusCode: 403 });
  expect(calls.filter(call => call?.action === 'step')).toHaveLength(1);
  tracked = false;
  expect(await owner({ permit, event })).toEqual({ tracked: false });
  expect(calls.slice(-2)).toEqual(['native.admission.recheck',
    { action: 'acknowledge', sessionID: 'ses_root', userMessageID: 'msg_foreign', assistantMessageID: 'msg_assistant' }]);
});

it('adopts an owned continuation through the private primary method while preserving its saved selection', async () => {
  const record = { sessionID: 'ses_root', directory: '/project', anchorID: 'msg_user', agent: 'orchestrator',
    providerID: 'sim', modelID: 'm1', variant: 'high' };
  const calls = [];
  let variant = 'high', allowed = true, revoked = false;
  const permit = { token: 'owned-runner', sessionID: 'ses_root' };
  const event = { type: 'session.step.started', durable: { seq: 4, aggregateID: 'ses_root' },
    data: { sessionID: 'ses_root', assistantMessageID: 'msg_assistant', agent: 'orchestrator', model: { providerID: 'sim', id: 'm1' } } };
  const owner = createNativePrimaryStepOwner({ directory: '/project', instanceID: 'native-instance',
    admissionOwner: { handleRpc: async method => {
      if (method === 'native.admission.recheck' && revoked) throw new Error('native_permit_revoked');
      return permit;
    }, acknowledgeStartedContinuation: async () => { calls.push('acknowledge'); } },
    openCodeClient: { sessions: {
      get: async () => ({ id: 'ses_root', directory: '/project' }),
      message: async () => ({ info: { id: 'msg_assistant', sessionID: 'ses_root', role: 'assistant', parentID: 'msg_notice',
        agent: 'orchestrator', providerID: 'sim', modelID: 'm1', variant, time: {} },
      turnOwnership: { source: 'native-sequence', userMessageID: 'msg_notice' } }),
    } }, primaryRuntime: {
      readRecord: async () => record,
      helloNative: async () => { calls.push('hello-native'); },
      plugin: async input => { calls.push(input.action); },
      adoptOwnedNativeContinuation: async input => {
        calls.push('adopt');
        expect(input).toEqual({ instanceID: 'native-instance', sessionID: 'ses_root', userMessageID: 'msg_notice',
          assistantMessageID: 'msg_assistant', execution: { providerID: 'sim', modelID: 'm1', agent: 'orchestrator', variant: 'high' } });
        if (!allowed) throw new Error('native_continuation_fenced');
        return { ...record, activeUserID: 'msg_notice' };
      },
    } });
  await owner({ permit, event });
  expect(calls).toEqual(['hello-native', 'adopt', 'step', 'acknowledge']);
  allowed = false;
  await expect(owner({ permit, event })).rejects.toThrow('native_continuation_fenced');
  variant = 'low';
  await expect(owner({ permit, event })).rejects.toThrow('native_primary_step_invalid');
  variant = 'high'; revoked = true;
  await expect(owner({ permit, event })).rejects.toThrow('native_permit_revoked');
  expect(calls).toEqual(['hello-native', 'adopt', 'step', 'acknowledge', 'adopt']);
});

it('keeps the reserved fallback tuple through successive canonical compaction adoptions', async () => {
  const original = { providerID: 'saved', modelID: 'original', agent: 'orchestrator', variant: 'high' };
  const fallback = { providerID: 'saved', modelID: 'backup', agent: 'orchestrator', variant: 'default' };
  let record = { ...original, sessionID: 'ses_root', directory: '/project', anchorID: 'msg_original',
    recoveryID: 'msg_recovery', recoveryExecution: fallback, attemptCount: 1, tools: { '*': false, read: true }, state: 'recovering' };
  let parentID = 'msg_compact1', actual = fallback;
  const permit = { token: 'owned-runner', sessionID: 'ses_root' }, calls = [];
  const event = () => ({ type: 'session.step.started', durable: { seq: 4, aggregateID: 'ses_root' },
    data: { sessionID: 'ses_root', assistantMessageID: 'msg_step', agent: actual.agent,
      model: { providerID: actual.providerID, id: actual.modelID } } });
  const owner = createNativePrimaryStepOwner({ instanceID: 'native-instance',
    admissionOwner: { handleRpc: async () => permit, acknowledgeStartedContinuation: async () => { calls.push('acknowledge'); } },
    openCodeClient: { sessions: { get: async () => ({ id: 'ses_root', directory: '/project' }),
      message: async () => ({ info: { id: 'msg_step', sessionID: 'ses_root', role: 'assistant', parentID,
        agent: actual.agent, providerID: actual.providerID, modelID: actual.modelID, variant: actual.variant, time: {} },
      turnOwnership: { source: 'native-sequence', userMessageID: parentID } }) } },
    primaryRuntime: { readRecord: async () => record, helloNative: async () => {},
      adoptOwnedNativeContinuation: async input => {
        calls.push('adopt'); expect(input.execution).toEqual(fallback);
        if (!['msg_compact1','msg_compact2'].includes(input.userMessageID) || record.state === 'cancelled') {
          throw Error('native_continuation_fenced');
        }
        record = { ...record, activeUserID: input.userMessageID }; return record;
      },
      plugin: async input => { expect(input.userMessageID).toBe(record.activeUserID); expect(input.execution).toEqual(fallback); calls.push('step'); },
    } });
  for (parentID of ['msg_compact1', 'msg_compact2']) {
    await expect(owner({ permit, event: event() })).resolves.toEqual({ tracked: true });
    expect(record).toMatchObject({ ...original, recoveryExecution: fallback, attemptCount: 1, tools: { '*': false, read: true } });
  }
  expect(calls).toEqual(['adopt','step','acknowledge','adopt','step','acknowledge']);
  parentID = 'msg_foreign';
  await expect(owner({ permit, event: event() })).rejects.toThrow('native_continuation_fenced');
  actual = original;
  await expect(owner({ permit, event: event() })).rejects.toMatchObject({ code: 'native_primary_step_invalid' });
  actual = fallback; record = { ...record, state: 'cancelled' }; parentID = 'msg_compact1';
  await expect(owner({ permit, event: event() })).rejects.toThrow('native_continuation_fenced');
  expect(calls.filter(call => call === 'acknowledge')).toHaveLength(2);
});


it('rechecks the trusted current controller before a delayed native hello can bind a Step',async()=>{
  const permit={token:'owned-runner',sessionID:'ses_root'},attempt={traceID:'a'.repeat(32),spanID:'b'.repeat(16)};
  const event={type:'session.step.started',durable:{seq:4,aggregateID:'ses_root'},data:{sessionID:'ses_root',assistantMessageID:'msg_assistant',agent:'orchestrator',model:{providerID:'sim',id:'m1'}}};
  let instanceID='old-controller',hellos=0,steps=0,acknowledgements=0;
  let releaseHello;const deferred=new Promise(resolve=>{releaseHello=resolve});
  let enterHello;const entered=new Promise(resolve=>{enterHello=resolve});
  const dependencies={getInstanceID:()=>instanceID,admissionOwner:{handleRpc:async()=>permit,acknowledgeStartedContinuation:async()=>{acknowledgements++;}},openCodeClient:{sessions:{get:async()=>({id:'ses_root',directory:'/project'}),message:async()=>({info:{id:'msg_assistant',sessionID:'ses_root',role:'assistant',parentID:'msg_user',agent:'orchestrator',providerID:'sim',modelID:'m1',variant:'default',time:{}},turnOwnership:{source:'native-sequence',userMessageID:'msg_user'}})}},primaryRuntime:{readRecord:async()=>({sessionID:'ses_root',directory:'/project',anchorID:'msg_user',agent:'orchestrator',providerID:'sim',modelID:'m1',variant:'default'}),helloNative:async(input,owner)=>{enterHello();await deferred;await owner.authorize();if(!owner.isCurrent())throw Error('stale_native_hello');hellos++;expect(input.instanceID).toBe(instanceID);},plugin:async()=>{steps++;}}};
  const old=createNativePrimaryStepOwner({...dependencies,instanceID});
  const stale=expect(old({permit,event,attempt})).rejects.toThrow('stale_native_hello');
  await entered;instanceID='new-controller';releaseHello();await stale;
  expect({hellos,steps,acknowledgements}).toEqual({hellos:0,steps:0,acknowledgements:0});
  const current=createNativePrimaryStepOwner({...dependencies,instanceID});
  await expect(current({permit,event,attempt})).resolves.toEqual({tracked:true});
  expect({hellos,steps,acknowledgements}).toEqual({hellos:1,steps:1,acknowledgements:1});
});
