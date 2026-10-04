import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPrimaryRecoveryHost } from './provider-recovery-host.js';

const cleanup = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });
async function nativeSelectionHost(overrides = {}) {
  const prompts = [];
  const messages = [
    { info: { id: 'msg_user', sessionID: 'ses_test', role: 'user' }, parts: [{ type: 'text', text: 'Original request' }] },
    { info: { id: 'msg_assistant', sessionID: 'ses_test', role: 'assistant', parentID: 'msg_user', time: { completed: 1 } }, parts: [] },
  ];
  const client = { generation: () => 2,
    health: { probe: async () => ({ ready: true, version: '2.0.20' }),
      runtimeInfo: async () => ({ version: '2.0.20' }) },
    sessions: { get: async () => ({ id: 'ses_test', directory: '/project' }), status: async () => ({}),
      messages: async () => ({ records: messages }), todo: async () => [], abort: async () => true },
    interaction: { permissions: { list: async () => [] }, questions: { list: async () => [] } },
    catalog: { tools: async () => ({ ids: ['read'] }) },
    prompts: { prompt: async (_id, body, options) => {
      prompts.push(body);
      await options.beforePromptDispatch?.({ sessionID: 'ses_test', messageID: body.messageID, directory: '/project', body,
        execution: { providerID: body.model.providerID, modelID: body.model.modelID, agent: body.agent, variant: body.variant } });
      return null;
    } },
  };
  const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-primary-selection-'));
  cleanup.push(() => fs.rm(dataDirectory, { recursive: true, force: true }));
  const host = createPrimaryRecoveryHost({ dataDirectory, isManaged: () => true, mode: 'enforce', openCodeClient: client,
    buildOpenCodeUrl: () => { throw new Error('v1 transport unavailable'); }, authorize: async () => true,
    managedBarrier: async () => ({ state: 'clear' }), progressTimeoutMs: false, ...overrides });
  await host.initialize(); cleanup.push(() => host.drain());
  return { host, prompts, messages, client };
}

test('private native hello verifies the canonical pin without asserting readiness or enabling recovery', async () => {
  const f = await nativeSelectionHost();
  const reads = [];
  f.client.health.probe = async () => ({ ready: false, version: null, reason: 'ready_route_missing' });
  f.client.health.runtimeInfo = async options => {
    reads.push(options);
    return { version: '2.0.20' };
  };
  // Public plugin callers cannot choose the private version-only path.
  await expect(f.host.plugin({ action: 'hello', policyVersion: 1, instanceID: 'forged', transport: 'native-v2' }))
    .rejects.toMatchObject({ code: 'recovery_runtime_unverified' });
  expect(reads).toHaveLength(0);
  const hello = await f.host.helloNative({ policyVersion: 1, instanceID: 'native-owner' });
  expect(hello).toMatchObject({ instanceID: 'native-owner', supported: false, enforced: false });
  expect(reads).toHaveLength(1);
  expect(reads[0].signal).toBeInstanceOf(AbortSignal);
  expect(reads[0].maxResponseBytes).toBe(16 * 1024 * 1024);
  expect(typeof reads[0].onResponseRead).toBe('function');
});

test('private native hello rejects unknown, malformed, mismatched and replaced runtime evidence', async () => {
  const f = await nativeSelectionHost();
  for (const version of [null, 'unknown', '1.18.25', '2.0.21', '2.0.20-dev', ' 2.0.20 ', 2]) {
    f.client.health.runtimeInfo = async () => ({ version });
    await expect(f.host.helloNative({ policyVersion: 1, instanceID: 'native-owner' }))
      .rejects.toMatchObject({ code: 'recovery_runtime_unverified' });
  }
  f.client.health.runtimeInfo = async () => null;
  await expect(f.host.helloNative({ policyVersion: 1, instanceID: 'native-owner' }))
    .rejects.toMatchObject({ code: 'recovery_runtime_unverified' });
  f.client.health.runtimeInfo = async () => { throw Object.assign(new Error('changed'), { code: 'opencode_runtime_changed' }); };
  await expect(f.host.helloNative({ policyVersion: 1, instanceID: 'native-owner' }))
    .rejects.toMatchObject({ code: 'opencode_runtime_changed' });
  f.client.health.runtimeInfo = async options => { options.onResponseRead({ phase: 'chunk', bytes: 16 * 1024 * 1024 + 1 }); };
  await expect(f.host.helloNative({ policyVersion: 1, instanceID: 'native-owner' }))
    .rejects.toMatchObject({ code: 'recovery_response_too_large' });
  f.client.generation = () => 1;
  await expect(f.host.helloNative({ policyVersion: 1, instanceID: 'native-owner' }))
    .rejects.toMatchObject({ code: 'opencode_generation_invalid' });
});

const selectionReceipt = (id, variant = 'default') => ({ sessionID: 'ses_test', directory: '/project', messageID: id,
  body: { messageID: id, agent: 'orchestrator', model: { providerID: 'openai', modelID: 'm1' }, parts: [{ type: 'text', text: 'Original request' }] },
  execution: { providerID: 'openai', modelID: 'm1', agent: 'orchestrator', variant } });

test('generation2 defers primary ownership until accepted selection and keeps request contexts isolated', async () => {
  const f = await nativeSelectionHost();
  const receipt = selectionReceipt('msg_first', 'high');
  expect(await f.host.handleRequest('POST', '/api/session/ses_test/prompt_async', receipt.body, { owner: 'first' })).toBeNull();
  expect(await f.host.readRecord('ses_test')).toBeNull();
  await f.host.admitNativePrompt(receipt);
  expect(await f.host.readRecord('ses_test')).toBeNull();
  await f.host.withPromptAdmissionContext('POST', '/api/session/ses_test/prompt_async', { owner: 'first' }, async () => {
    await Promise.resolve();
    await f.host.admitNativePrompt(receipt);
  });
  const original = await f.host.readRecord('ses_test');
  expect(original).toMatchObject({ anchorID: 'msg_first', variant: 'high', owner: 'first', executionGeneration: 2 });
  await f.host.admitNativePrompt(selectionReceipt('msg_unrelated'), { owner: 'second', sessionID: 'ses_other' });
  expect(await f.host.readRecord('ses_test')).toEqual(original);
  await expect(f.host.admitNativePrompt({ ...selectionReceipt('msg_refused'), execution: null }, { owner: 'second' }))
    .rejects.toMatchObject({ code: 'recovery_execution_selection_required' });
  expect(await f.host.readRecord('ses_test')).toEqual(original);
});

test('generation2 explicit continuation replays frozen default and admits only inside dispatch selection callback', async () => {
  const f = await nativeSelectionHost();
  await f.host.admitNativePrompt(selectionReceipt('msg_user'), { owner: 'owner' });
  const record = await f.host.readRecord('ses_test');
  const result = await f.host.handleRequest('POST', '/api/session/ses_test/recovery/continue', {
    revision: record.revision, messageID: 'msg_continue',
  });
  expect(result.status).toBe(200);
  expect(f.prompts).toHaveLength(1);
  expect(f.prompts[0]).toMatchObject({ messageID: 'msg_continue', variant: 'default', agent: 'orchestrator',
    model: { providerID: 'openai', modelID: 'm1' } });
  expect(await f.host.readRecord('ses_test')).toMatchObject({ anchorID: 'msg_continue', objectiveID: 'msg_user',
    variant: 'default', executionGeneration: 2, owner: 'owner' });
});

test('lost native dispatch acknowledgement is explicit and does not roll back or overwrite another primary', async () => {
  const f = await nativeSelectionHost();
  await f.host.admitNativePrompt(selectionReceipt('msg_user'), { owner: 'owner' });
  await f.host.markNativePromptUncertain(selectionReceipt('msg_other'));
  expect((await f.host.readRecord('ses_test')).state).toBe('observing');
  await f.host.markNativePromptUncertain(selectionReceipt('msg_user'));
  expect(await f.host.readRecord('ses_test')).toMatchObject({ state: 'needs_attention', reason: 'prompt_dispatch_uncertain',
    anchorID: 'msg_user', variant: 'default' });
});


test('native primary boundary preserves unmanaged, child and implicit-selection opt-outs', async () => {
  const unmanaged = await nativeSelectionHost({ isManaged: () => false });
  const managed = await nativeSelectionHost();
  const receipt = { ...selectionReceipt('msg_optout'), execution: null };
  await unmanaged.host.admitNativePrompt(receipt, { owner: 'owner' });
  await managed.host.admitNativePrompt({ ...receipt, parentID: 'ses_parent' }, { owner: 'owner' });
  await managed.host.admitNativePrompt({ ...receipt, body: { messageID: 'msg_optout', parts: [] } }, { owner: 'owner' });
  expect(await unmanaged.host.readRecord('ses_test')).toBeNull();
  expect(await managed.host.readRecord('ses_test')).toBeNull();
  expect(unmanaged.host.requiresNativePromptSelection()).toBe(false);
  expect(managed.host.requiresNativePromptSelection()).toBe(false);
  await managed.host.withPromptAdmissionContext('POST', '/api/session/ses_test/prompt_async', { owner: 'owner' }, async () => {
    expect(managed.host.requiresNativePromptSelection()).toBe(true);
    await expect(managed.host.admitNativePrompt(receipt)).rejects.toMatchObject({ code: 'recovery_execution_selection_required' });
  });
  await managed.host.admitNativePrompt(selectionReceipt('msg_user'), { owner: 'owner' });
  const prior = await managed.host.readRecord('ses_test');
  await managed.host.admitNativePrompt({ ...receipt, body: { messageID: 'msg_other', parts: [] } }, { owner: 'owner' });
  await expect(managed.host.admitNativePrompt({ ...receipt, messageID: 'msg_other' }, { owner: 'owner' }))
    .rejects.toMatchObject({ code: 'recovery_execution_selection_required' });
  expect(await managed.host.readRecord('ses_test')).toEqual(prior);
});

test('reserved native TODO admission preserves the original owner, objective and budget instead of admitting a new root',async()=>{
 const f=await nativeSelectionHost();
 await f.host.helloNative({instanceID:'native',policyVersion:1});
 await f.host.admitNativePrompt(selectionReceipt('msg_user'),{owner:'original-owner'});
 Object.assign(f.messages[1].info,{agent:'orchestrator',providerID:'openai',modelID:'m1',variant:'default'});
 f.messages[1].turnOwnership={source:'native-sequence',userMessageID:'msg_user'};
 await f.host.plugin({action:'step',instanceID:'native',sessionID:'ses_test',userMessageID:'msg_user',assistantMessageID:'msg_assistant'});
 const prompt={messageID:'msg_todo',agent:'orchestrator',model:{providerID:'openai',modelID:'m1'},variant:'default',tools:{},objectiveID:'msg_user',
  parts:[{type:'text',synthetic:true,text:'[devryan-open-todo-continuation:v1]\nContinue the same open TODO.'}]};
 await f.host.reserveNativeContinuation({instanceID:'native',sessionID:'ses_test',directory:'/project',anchorUserMessageID:'msg_user',
  assistantMessageID:'msg_assistant',userMessageID:'msg_todo',kind:'orchestrator_todo',execution:{providerID:'openai',modelID:'m1',agent:'orchestrator',variant:'default'}},prompt);
 const before=await f.host.readRecord('ses_test');
 await f.host.admitNativePrompt({...selectionReceipt('msg_todo'),body:prompt},{owner:'different-inherited-request'});
 expect(await f.host.readRecord('ses_test')).toEqual(before);
 await expect(f.host.admitNativePrompt({...selectionReceipt('msg_todo'),body:{...prompt,parts:[{type:'text',synthetic:true,text:'Forged continuation'}]}}))
  .rejects.toMatchObject({code:'native_primary_continuation_fenced'});
 expect(before).toMatchObject({owner:'original-owner',anchorID:'msg_user',continuationID:'msg_todo',todoContinuationCount:1});
 await expect(f.host.admitNativePrompt({...selectionReceipt('msg_todo'),execution:{providerID:'openai',modelID:'changed',agent:'orchestrator',variant:'default'}},{owner:'original-owner'}))
  .rejects.toMatchObject({code:'native_primary_continuation_fenced'});
 expect(await f.host.readRecord('ses_test')).toEqual(before);
});

test('native fallback dispatch uses fresh exact constructor authority and receipt leaves objective budgets intact',async()=>{
 let dispatched;
 const f=await nativeSelectionHost({isNativeFallbackError:error=>error?.statusCode===429,dispatchNativeRecovery:async(record,prompt)=>{dispatched={record,prompt};}});
 await f.host.helloNative({policyVersion:1,instanceID:'native-owner'});await f.host.admitNativePrompt(selectionReceipt('msg_user'),{owner:'original'});
 await f.host.plugin({action:'step',sessionID:'ses_test',userMessageID:'msg_user',assistantMessageID:'msg_assistant',instanceID:'native-owner'});
 f.messages.at(-1).info.error={statusCode:429};
 const before=await f.host.readRecord('ses_test');
 await f.host.reserveNativeFallback({sessionID:'ses_test',userMessageID:'msg_user',assistantMessageID:'msg_assistant',instanceID:'native-owner',currentExecution:{providerID:before.providerID,modelID:before.modelID,agent:before.agent,variant:before.variant}},
  {authorize:async()=>{},choose:async()=>({tried:['openai/gpt-5.6-sol'],exhaustion:0,execution:{providerID:'saved',modelID:'fallback',agent:'orchestrator',variant:'default'}})});
 await f.host.observe({type:'session.status',properties:{sessionID:'ses_test',status:{type:'idle'}}});
 expect(dispatched).toBeDefined();expect(f.prompts).toHaveLength(0);
 const record=await f.host.readRecord('ses_test');const captured=await f.host.captureNativeRecoveryDispatch({sessionID:'ses_test',directory:'/project',messageID:record.recoveryID});expect(captured.prompt).toEqual(dispatched.prompt);
 const receipt={...selectionReceipt(record.recoveryID),body:dispatched.prompt,execution:record.recoveryExecution};
 await f.host.admitNativePrompt(receipt,{owner:'unrelated-inherited-context'});expect(await f.host.readRecord('ses_test')).toEqual(record);
 await expect(f.host.admitNativePrompt({...receipt,body:{...receipt.body,tools:{read:true}}})).rejects.toMatchObject({code:'native_fallback_fenced'});
 await f.host.control('ses_test','stop');await expect(captured.recheck()).rejects.toMatchObject({code:'native_fallback_fenced'});
});

test('native command admission keeps local owner and opt-outs while fencing the exact durable write',async()=>{
 const f=await nativeSelectionHost();let checks=0;
 const receipt=selectionReceipt('msg_command');
 await f.host.admitNativePrompt(receipt,{owner:null,sessionID:'ses_test',authorizeWrite:async()=>{checks++;}});
 expect(await f.host.readRecord('ses_test')).toMatchObject({anchorID:'msg_command',owner:null,variant:'default'});
 expect(checks).toBe(2);
 const prior=await f.host.readRecord('ses_test');
 let reads=0;
 await expect(f.host.admitNativePrompt(selectionReceipt('msg_revoked'),{owner:'original',authorizeWrite:async()=>{
  if(++reads===2)throw Object.assign(Error('revoked'),{code:'revoked'});
 }})).rejects.toMatchObject({code:'revoked'});
 expect(await f.host.readRecord('ses_test')).toEqual(prior);
 await f.host.markNativePromptUncertain(selectionReceipt('msg_revoked'));
 expect(await f.host.readRecord('ses_test')).toEqual(prior);
 await f.host.admitNativePrompt({...selectionReceipt('msg_child'),parentID:'ses_parent'},{owner:null,authorizeWrite:async()=>{throw Error('child must opt out');}});
 const unmanaged=await nativeSelectionHost({isManaged:()=>false});
 await unmanaged.host.admitNativePrompt(receipt,{owner:null,authorizeWrite:async()=>{throw Error('unmanaged must opt out');}});
 expect(await unmanaged.host.readRecord('ses_test')).toBeNull();
});

const retainedIdentity = { revision: 'a'.repeat(64), messageID: 'msg_retained', payloadHash: 'b'.repeat(64) };
const retainedSnapshot = () => ({ revision: retainedIdentity.revision, state: 'paused', inputs: [{
  messageID: retainedIdentity.messageID, payloadHash: retainedIdentity.payloadHash, type: 'user', delivery: 'queue',
  location: 'queued', preview: 'Saved input', attachmentCount: 0, canResume: true, canDiscard: true, reason: null,
}] });
const attachRetainedOwner = (host, overrides = {}) => host.setRecoveredInputOwner({ has: id => id === 'ses_test',
  snapshot: async id => id === 'ses_test' ? retainedSnapshot() : undefined,
  details: async (_id, input) => ({ ...input, type: 'user', delivery: 'queue', location: 'queued', text: 'Full saved input', files: [] }),
  action: async () => {}, ...overrides });

test('retained input is inspectable without a primary record or watchdog and full text is lazy', async () => {
  const f = await nativeSelectionHost();
  const details = [];
  attachRetainedOwner(f.host, { details: async (id, identity) => {
    details.push({ id, identity }); return { ...identity, text: 'Full saved input', files: [] };
  } });
  const result = await f.host.handleRequest('GET', '/api/session/ses_test/recovery');
  expect(result).toMatchObject({ status: 200, body: { record: null, supported: false, recoveredInput: retainedSnapshot() } });
  expect(details).toHaveLength(0);
  expect(JSON.stringify(result.body)).not.toContain('Full saved input');
  const query = new URLSearchParams(retainedIdentity);
  const full = await f.host.handleRequest('GET', `/api/session/ses_test/recovery/input?${query}`);
  expect(full).toMatchObject({ status: 200, body: { text: 'Full saved input' } });
  expect(details).toEqual([{ id: 'ses_test', identity: retainedIdentity }]);
  expect(f.prompts).toHaveLength(0);
});

test('retained actions bind exact ID/hash/revision and fresh owner, then reread the inventory', async () => {
  const f = await nativeSelectionHost();
  const calls = []; let retained = retainedSnapshot();
  attachRetainedOwner(f.host, { snapshot: async () => retained, action: async (id, action, identity, context) => {
    calls.push({ id, action, identity, context });
    if (identity.revision !== retainedIdentity.revision) throw Object.assign(Error('stale'), { code: 'recovery_revision_conflict', statusCode: 409 });
    retained = undefined;
    return { ignored: true };
  } });
  for (const action of ['resume-input', 'discard-input']) {
    retained = retainedSnapshot();
    const result = await f.host.handleRequest('POST', `/api/session/ses_test/recovery/${action}`, retainedIdentity, { owner: 'fresh-owner' });
    expect(result).toMatchObject({ status: 200, body: { record: null, recoveredInput: undefined } });
    expect(result.body.ignored).toBeUndefined();
  }
  expect(calls).toEqual(['resume-input','discard-input'].map(action => ({ id: 'ses_test', action, identity: retainedIdentity, context: { owner: 'fresh-owner' } })));
  const stale = await f.host.handleRequest('POST', '/api/session/ses_test/recovery/resume-input', { ...retainedIdentity, revision: 'c'.repeat(64) });
  expect(stale).toMatchObject({ status: 409, body: { code: 'recovery_revision_conflict' } });
  expect(f.prompts).toHaveLength(0);
});

test('paused inventory fences old Continue and intent before mutation while session Stop remains available', async () => {
  const f = await nativeSelectionHost();
  await f.host.admitNativePrompt(selectionReceipt('msg_user'), { owner: 'original' });
  attachRetainedOwner(f.host);
  const before = await f.host.readRecord('ses_test');
  for (const action of ['continue', 'intent']) {
    const result = await f.host.handleRequest('POST', `/api/session/ses_test/recovery/${action}`, { revision: before.revision, messageID: 'msg_new' });
    expect(result).toMatchObject({ status: 409, body: { code: 'recovered_input_pending' } });
    expect(await f.host.readRecord('ses_test')).toEqual(before);
  }
  expect(f.prompts).toHaveLength(0);
  let aborts = 0; f.client.sessions.abort = async () => { aborts++; return true; };
  const stopped = await f.host.handleRequest('POST', '/api/session/ses_test/recovery/cancel', { revision: before.revision });
  expect(stopped).toMatchObject({ status: 200, body: { stopConfirmed: false, record: { state: 'cancelled' }, recoveredInput: retainedSnapshot() } });
  expect(aborts).toBe(1);
  expect(f.prompts).toHaveLength(0);
});

test('retained routes reject malformed or duplicated identities before calling the owner', async () => {
  const f = await nativeSelectionHost(); let calls = 0;
  attachRetainedOwner(f.host, { details: async () => { calls++; }, action: async () => { calls++; } });
  for (const identity of [{}, { ...retainedIdentity, messageID: 'msg_wrong/route' }, { ...retainedIdentity, payloadHash: 'bad' },
    { ...retainedIdentity, revision: 1 }, { ...retainedIdentity, extra: 'authority' }]) {
    const result = await f.host.handleRequest('POST', '/api/session/ses_test/recovery/discard-input', identity);
    expect(result).toMatchObject({ status: 400, body: { code: 'recovered_input_identity_required' } });
  }
  const query = new URLSearchParams(retainedIdentity); query.append('messageID', 'msg_other');
  expect(await f.host.handleRequest('GET', `/api/session/ses_test/recovery/input?${query}`))
    .toMatchObject({ status: 400, body: { code: 'recovered_input_identity_required' } });
  expect(calls).toBe(0);
});

test('constructor-only recovered owner reauthorization never reads the native transport', async () => {
  let allowed = false, calls = 0;
  const f = await nativeSelectionHost({ authorize: async record => { calls++; expect(record.owner).toBe('original'); return allowed; } });
  const record = { owner: 'original', sessionID: 'ses_test', directory: '/project' };
  f.client.sessions.get = async () => { throw Error('native observation is forbidden'); };
  await expect(f.host.authorizeRecoveredInputOwner(record)).rejects.toMatchObject({ code: 'native_recovered_input_fenced', statusCode: 403 });
  allowed = true; await f.host.authorizeRecoveredInputOwner(record);
  expect(calls).toBe(2);
  expect(await f.host.nativeStartupRecords()).toEqual([]);
});

test('controller events are explicitly partial even after the native inventory resolves', async () => {
  const events = []; let inventoryReads = 0;
  const f = await nativeSelectionHost({ publishEvent: event => events.push(event) });
  attachRetainedOwner(f.host, { has: () => false, snapshot: async () => { inventoryReads++; return undefined; } });
  await f.host.admitNativePrompt(selectionReceipt('msg_user'), { owner: 'original' });
  expect(events.at(-1)).toMatchObject({ properties: { sessionID: 'ses_test', recovery: { recoveredInputPartial: true } } });
  expect(inventoryReads).toBe(0);
  const full = await f.host.handleRequest('GET', '/api/session/ses_test/recovery');
  expect(full.status).toBe(200);
  expect(full.body.recoveredInputPartial).toBeUndefined();
  expect(full.body.recoveredInput).toBeUndefined();
  expect(inventoryReads).toBe(1);
});


test('unsupported identities never fall back to raw recovery transport', async () => {
  for (const openCodeClient of [undefined, {}, { generation: () => 1 }, { generation: () => 3 }]) {
    let requests = 0;
    const f = await nativeSelectionHost({ openCodeClient, fetchImpl: () => { requests++; throw Error('raw runtime forbidden'); } });
    await expect(f.host.helloNative({ policyVersion: 1, instanceID: 'owned' })).rejects.toMatchObject({ code: 'opencode_generation_invalid' });
    expect(requests).toBe(0);
    expect(await f.host.readRecord('ses_test')).toBeNull();
  }
});
test('Stop persists the native cancellation fence even if descendant settlement fails', async () => {
  const f = await nativeSelectionHost({ cancelDescendants: async () => { throw Error('child unavailable'); } });
  await f.host.admitNativePrompt(selectionReceipt('msg_user'), { owner: 'original' });
  let aborts = 0; f.client.sessions.abort = async () => { aborts++; return true; };
  const before = await f.host.readRecord('ses_test');
  expect(await f.host.handleRequest('POST', '/api/session/ses_test/recovery/cancel', { revision: before.revision }))
    .toMatchObject({ status: 409, body: { code: 'provider_stop_unconfirmed' } });
  expect(await f.host.readRecord('ses_test')).toMatchObject({ state: 'cancelled' });
  expect(aborts).toBe(1); expect(f.prompts).toHaveLength(0);
});
