import { expect, it } from 'vitest';
import { createNativeManagedTitleOwner } from './native-managed-title-owner.js';
import { createPrivilegedOpenCodeClient } from '../opencode-client/privileged.js';

const fixture = async () => {
  const assignment = { taskId: 'dvr_task_child', rootSessionId: 'ses_root', parentSessionId: 'ses_root', childSessionId: 'ses_child',
    directory: '/fixture', dispatchCallId: 'call_start', dispatchGroupId: 'msg_step', attempt: 1, sequence: 2,
    agent: 'fixer', providerId: 'fixture', modelId: 'model', variant: 'high', readOnly: false };
  const state = { config: { controllerInstanceID: 'controller_original', configurationDigest: 'a'.repeat(64) }, assignment,
    child: { id: 'ses_child', parentID: 'ses_root', directory: '/fixture', agent: 'fixer', model: { providerID: 'fixture', id: 'model', variant: 'high' } },
    root: { id: 'ses_root', directory: '/fixture' }, primary: { directory: '/fixture', anchorID: 'msg_human', objectiveID: 'msg_human', cancellationGeneration: 1, state: 'observing' },
    admission: { revision: 0, held: false, reverting: false }, captured: { captured: true, pending: false, generation: 3 },
    lease: { executionKind: 'control', preparation: 'none', state: 'published', generation: 3,
      scope: { sessionID: 'ses_root', messageID: 'msg_step', callID: 'call_start' } }, allowed: true,
    users: [{ info: { id: 'msg_child_source', role: 'user' }, parts: [{ type: 'text', text: 'Fix the selected issue' }] }],
    source: { id: 'msg_child_source', sessionID: 'ses_child', type: 'user', text: 'Fix the selected issue',
      metadata: { devryan: { v: 1, origin: 'unknown', admission: { v: 1, fingerprint: 'b'.repeat(64) } } } } };
  const options = { readConfiguration: () => structuredClone(state.config), readSession: async id => structuredClone(id === 'ses_child' ? state.child : state.root),
    readAssignment: async () => { if (!state.assignment) throw Error('cancelled assignment'); return structuredClone(state.assignment); },
    readPrimary: async () => structuredClone(state.primary), readState: async () => structuredClone(state.admission),
    readCaptured: async () => structuredClone(state.captured), readLease: async () => structuredClone(state.lease),
    captureAuthorization: async () => async () => { if (!state.allowed) throw Error('owner revoked'); },
    readUsers: async () => structuredClone(state.users), readUser: async () => structuredClone(state.source) };
  const owner = createNativeManagedTitleOwner(options);
  state.source.metadata.devryan.managedTitle = await owner.seal({ sessionID: 'ses_child', directory: '/fixture', messageID: 'msg_child_source',
    fingerprint: 'b'.repeat(64), text: state.source.text, dispatch: { taskId: assignment.taskId, sessionID: 'ses_child' } });
  return { owner, state, options, input: { sessionID: 'ses_child', directory: '/fixture', messageID: 'msg_child_source' } };
};

it('seals only the private exact dispatch and permits idempotent canonical recollection without forging human origin', async () => {
  const f = await fixture(); const first = await f.owner.capture(f.input), again = await f.owner.capture(f.input);
  await first.recheck(); await again.recheck(); expect(first.sourceMessageID).toBe('msg_child_source');
  expect(f.state.source.metadata.devryan.origin).toBe('unknown');
  await expect(f.owner.seal({ ...f.input, fingerprint: 'b'.repeat(64), text: f.state.source.text,
    dispatch: { taskId: 'dvr_foreign', sessionID: 'ses_child' } })).rejects.toMatchObject({ code: 'native_managed_title_source_invalid' });
});

it('recollects the sealed source through the actual private client without dropping canonical text',async()=>{
 const f=await fixture();
 const privateClient=createPrivilegedOpenCodeClient({getRuntime:()=>({generation:2,baseUrl:'http://127.0.0.1:9'}),
  fetchImpl:async url=>Response.json({data:new URL(url).pathname.includes('/message/')?structuredClone(f.state.source):{id:'ses_child',location:{directory:'/fixture'},metadata:{}}})});
 f.options.readUser=({sessionID,messageID,directory})=>privateClient.readUserMessage(sessionID,messageID,{directory});
 const proof=await createNativeManagedTitleOwner(f.options).capture(f.input);await proof.recheck();
 f.state.source.text+='\nchanged';await expect(proof.recheck()).rejects.toMatchObject({code:'native_managed_title_source_invalid'});
});

for (const change of ['foreignRoot', 'replacementAssignment', 'cancelled', 'newHuman', 'rootStop', 'rootGeneration', 'controller', 'configuration', 'controlCall', 'controlStep', 'sourceText', 'sourceID', 'owner']) {
  it(`refuses managed title ${change} before a collected marker can grant authority`, async () => {
    const f = await fixture(); const proof = await f.owner.capture(f.input);
    if (change === 'foreignRoot') f.state.assignment.rootSessionId = 'ses_foreign';
    if (change === 'replacementAssignment') f.state.assignment.attempt++;
    if (change === 'cancelled') f.state.assignment = null;
    if (change === 'newHuman') f.state.primary.anchorID = 'msg_new_human';
    if (change === 'rootStop') f.state.admission.held = true;
    if (change === 'rootGeneration') f.state.captured.generation++;
    if (change === 'controller') f.state.config.controllerInstanceID = 'controller_replaced';
    if (change === 'configuration') f.state.config.configurationDigest = 'c'.repeat(64);
    if (change === 'controlCall') f.state.lease.scope.callID = 'call_other';
    if (change === 'controlStep') f.state.lease.scope.messageID = 'msg_other';
    if (change === 'sourceText') f.state.source.text += ' replacement';
    if (change === 'sourceID') f.state.users.push({ info: { id: 'msg_new_input', role: 'user' }, parts: [] });
    if (change === 'owner') f.state.allowed = false;
    await expect(proof.recheck()).rejects.toThrow(); await expect(f.owner.capture(f.input)).rejects.toThrow();
  });
}

for (const change of ['generation', 'configuration']) it(`fences ${change} changed while the final canonical user read is held`, async () => {
  const f = await fixture(); let release, held;
  const started = new Promise(resolve => { held = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let wait = false;
  f.options.readUsers = async () => { if (wait) { held(); await gate; } return structuredClone(f.state.users); };
  const owner = createNativeManagedTitleOwner(f.options), proof = await owner.capture(f.input); wait = true;
  const checking = proof.recheck(); await started;
  if (change === 'generation') f.state.primary.cancellationGeneration++;
  else f.state.config.configurationDigest = 'd'.repeat(64);
  release(); await expect(checking).rejects.toMatchObject({ code: 'native_managed_title_source_invalid' });
});

it('refreshes root fences after an awaited permissions check', async () => {
  const f = await fixture(); let changed = false;
  f.options.captureAuthorization = async () => async () => { if (!changed) { changed = true; f.state.primary.cancellationGeneration++; } };
  await expect(createNativeManagedTitleOwner(f.options).capture(f.input)).rejects.toMatchObject({ code: 'native_managed_title_source_invalid' });
});

const makeHuman = f => {
  f.state.source.metadata.devryan.origin = 'human';
  delete f.state.source.metadata.devryan.managedTitle;
};
it('human title authority survives only a volatile canonical session update timestamp',async()=>{
  const f=await fixture();makeHuman(f);let updated=0;
  const read=f.options.readSession;
  f.options.readSession=async(...input)=>({...await read(...input),time:{created:1,updated:++updated}});
  const proof=await createNativeManagedTitleOwner(f.options).captureHuman(f.input);
  await proof.recheck();expect(updated).toBeGreaterThan(2);
});
it('human title source recheck preserves exact attachment identity even when text and admission metadata stay unchanged',async()=>{
  const f=await fixture();makeHuman(f);
  f.state.users[0].parts.push({type:'file',id:'file_owned',url:'file:///fixture/source.png',mime:'image/png'});
  const proof=await f.owner.captureHuman(f.input);
  f.state.users[0].parts[1].url='file:///fixture/replacement.png';
  await expect(proof.recheck()).rejects.toMatchObject({code:'native_managed_title_source_invalid'});
});
it('accepts only the latest canonical human source and fences replay or Synthetic replacement', async () => {
  const f = await fixture();
  await expect(f.owner.captureHuman(f.input)).rejects.toMatchObject({ code: 'native_managed_title_source_invalid' });
  makeHuman(f); const proof = await f.owner.captureHuman(f.input); await proof.recheck();
  expect(proof.text).toBe(f.state.source.text);
  f.state.users.push({ info: { id: 'msg_next_human', role: 'user' }, parts: [] });
  await expect(proof.recheck()).rejects.toMatchObject({ code: 'native_managed_title_source_invalid' });
  f.state.users.pop(); f.state.source.type = 'synthetic';
  await expect(f.owner.captureHuman(f.input)).rejects.toMatchObject({ code: 'native_managed_title_source_invalid' });
});
it('refuses a newer accepted human arriving during the awaited human scope check', async () => {
  const f = await fixture(); makeHuman(f);
  let hold = false, started, release;
  const entered = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { release = resolve; });
  f.options.captureAuthorization = async () => async () => { if (hold) { started(); await gate; } };
  const proof = await createNativeManagedTitleOwner(f.options).captureHuman(f.input); hold = true;
  const checking = proof.recheck(); await entered;
  f.state.users.push({ info: { id: 'msg_new_human', role: 'user' }, parts: [] });
  release(); await expect(checking).rejects.toMatchObject({ code: 'native_managed_title_source_invalid' });
});
for (const lineage of ['missing', 'cycle', 'tooDeep']) it(`fails closed with a typed refusal for ${lineage} human ancestry`, async () => {
  const f = await fixture(); makeHuman(f);
  const original = f.options.readSession;
  f.options.readSession = async sessionID => {
    if (sessionID === 'ses_child') return structuredClone(f.state.child);
    if (lineage === 'missing') return null;
    if (lineage === 'cycle') return { id: 'ses_root', parentID: 'ses_child', directory: '/fixture' };
    const depth = sessionID === 'ses_root' ? 0 : Number(sessionID.slice(4));
    if (depth < 300) return { id: sessionID, parentID: `ses_${depth + 1}`, directory: '/fixture' };
    return original(sessionID);
  };
  await expect(createNativeManagedTitleOwner(f.options).captureHuman(f.input)).rejects.toMatchObject({ code: 'native_managed_title_source_invalid' });
});
it('keeps the exact assistant dispatch identity while its control lease becomes published', async () => {
  const f = await fixture(); f.state.lease.state = 'ready';
  const proof = await f.owner.capture(f.input); f.state.lease.state = 'published'; await proof.recheck();
  f.state.lease.scope.messageID = 'msg_foreign_assistant';
  await expect(proof.recheck()).rejects.toMatchObject({ code: 'native_managed_title_source_invalid' });
});

it('root human reopening rejects A after canonical B and cannot alternate historical IDs to buy cycles', async () => {
  const f = await fixture(); makeHuman(f);
  const A = { ...structuredClone(f.state.source), sessionID: 'ses_root', id: 'msg_A' };
  const B = { ...structuredClone(A), id: 'msg_B', text: 'Next accepted human' };
  const sources = new Map([[A.id, A], [B.id, B]]);
  f.options.readUser = async ({ messageID }) => structuredClone(sources.get(messageID));
  f.state.users = [{ info: { id: A.id, role: 'user' }, parts: [] }];
  const owner = createNativeManagedTitleOwner(f.options), input = { sessionID: 'ses_root', directory: '/fixture', messageID: A.id };
  const proofA = await owner.captureHuman(input); await proofA.recheck();
  f.state.users.push({ info: { id: B.id, role: 'user' }, parts: [] });
  const proofB = await owner.captureHuman({ ...input, messageID: B.id }); await proofB.recheck();
  for (let replay = 0; replay < 3; replay++) await expect(owner.captureHuman(input)).rejects.toMatchObject({ code: 'native_managed_title_source_invalid' });
  await expect(proofA.recheck()).rejects.toMatchObject({ code: 'native_managed_title_source_invalid' });
});
