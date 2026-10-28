import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { validateCanonicalPlanSource } from './canonical-source.js';
import { createPrimaryRecoveryController } from '../../../../harness-runtime/lib/provider-recovery.js';
const sessionID = 'ses_plan';
const user = (id, synthetic = false) => ({ info: { id, sessionID, role: 'user', metadata: { openchamberPlanMode: !synthetic } }, parts: [{ type: 'text', text: synthetic ? 'resume' : 'Plan a feature', synthetic }] });
const assistant = (id, parentID, content, error) => ({ info: { id, sessionID, role: 'assistant', parentID, time: { completed: 1 }, finish: error ? 'error' : 'stop', ...(error ? { error: { name: 'APIError' } } : {}) }, turnOwnership: { source: 'native-sequence', userMessageID: parentID }, parts: [{ type: 'text', text: content }] });
const fixture = () => {
  const records = [user('msg_root'), assistant('msg_prefix', 'msg_root', '<!--plan-->\n# Plan\n- Prefix ', true), user('msg_resume', true), assistant('msg_tail', 'msg_resume', 'tail without headings 😀\n')];
  const receipts = [{ anchorID: 'msg_root', objectiveID: 'msg_root', sourceUserMessageID: 'msg_root', previousStepID: 'msg_prefix', eventID: 'evt_resume', eventSeq: 4, userMessageID: 'msg_resume', syntheticFingerprint: createHash('sha256').update('resume').digest('hex'), assistantMessageID: 'msg_tail', ordinal: 1, successorAttempt: { traceID: 'd'.repeat(32), spanID: 'e'.repeat(16) }, permitSha256: 'a'.repeat(64), configurationDigest: 'b'.repeat(64), toolPolicySha256: 'c'.repeat(64) }];
  return { sessionID, sourceMessageID: 'msg_prefix', records, receipts };
};
const autoFixture = () => {
  const boundary={info:{id:'msg_compact',sessionID,role:'user'},parts:[{type:'compaction',auto:true}]};
  const summary=assistant('msg_compact:summary','msg_compact','PRIVATE SUMMARY');summary.info.summary=true;
  const prefix=assistant('msg_prefix','msg_root','<!--plan-->\n# Plan\n- Original ');prefix.info.finish='tool-calls';
  const records=[user('msg_root'),prefix,boundary,summary,assistant('msg_tail','msg_compact','and continuation\n')];
  const nativeSequence=[{id:'msg_root',type:'user'},{id:'msg_prefix',type:'assistant'},
    {id:'msg_compact',type:'compaction',reason:'auto',status:'completed'},{id:'msg_tail',type:'assistant'}].map((row,ordinal)=>({...row,ordinal,turnParent:row.type!=='assistant'}));
  return {sessionID,sourceMessageID:'msg_prefix',records,nativeSequence};
};
it('only completed native automatic compaction continues the original Plan source',()=>{
  for(const sourceMessageID of ['msg_prefix','msg_tail']){
    const result=validateCanonicalPlanSource({...autoFixture(),sourceMessageID});
    expect(result.content).toBe('# Plan\n- Original and continuation\n');
    expect(result.sourceIdentity).toMatchObject({rootUserMessageID:'msg_root',memberUserMessageIDs:['msg_root','msg_compact'],
      memberAssistantMessageIDs:['msg_prefix','msg_tail'],currentSourceMessageID:'msg_tail',current:true});
    expect(result.content).not.toContain('PRIVATE SUMMARY');
  }
});
it('keeps native stream receipts mandatory before and after automatic compaction',()=>{
  const before=fixture(),auto=autoFixture();
  before.records.at(-1).info.finish='tool-calls';
  before.records.push(auto.records[2],auto.records[3],assistant('msg_after_auto','msg_compact','after auto\n'));
  before.nativeSequence=[['msg_root','user'],['msg_prefix','assistant'],['msg_resume','synthetic'],['msg_tail','assistant'],['msg_compact','compaction'],['msg_after_auto','assistant']]
    .map(([id,type],ordinal)=>({id,type,ordinal,turnParent:type!=='assistant',...(type==='compaction'?{status:'completed',reason:'auto'}:{})}));
  expect(validateCanonicalPlanSource(before).content).toBe('# Plan\n- Prefix tail without headings 😀\nafter auto\n');
  expect(()=>validateCanonicalPlanSource({...before,receipts:[]})).toThrow();
  const after=autoFixture();after.records.at(-1).info.finish='error';after.records.at(-1).info.error={name:'APIError'};
  after.records.push(user('msg_resume',true),assistant('msg_after_stream','msg_resume','after stream\n'));
  after.receipts=[{...fixture().receipts[0],sourceUserMessageID:'msg_compact',previousStepID:'msg_tail',assistantMessageID:'msg_after_stream'}];
  after.nativeSequence.push({id:'msg_resume',type:'synthetic',turnParent:true,ordinal:4},{id:'msg_after_stream',type:'assistant',turnParent:false,ordinal:5});
  expect(validateCanonicalPlanSource(after).content).toBe('# Plan\n- Original and continuation\nafter stream\n');
  expect(()=>validateCanonicalPlanSource({...after,receipts:[]})).toThrow();
});
it('native skills and status-only notices cannot manufacture or interrupt objective membership',()=>{
  const f=autoFixture();
  f.records.splice(2,0,{info:{id:'msg_skill',sessionID,role:'user'},parts:[{type:'text',text:'Read-only context'}]},
    {info:{id:'msg_notice',sessionID,role:'user'},parts:[{type:'text',synthetic:true,text:'Status'}]});
  f.nativeSequence.splice(2,0,{id:'msg_skill',type:'skill',turnParent:false},{id:'msg_notice',type:'synthetic',turnParent:false});
  f.nativeSequence=f.nativeSequence.map((row,ordinal)=>({...row,ordinal}));
  expect(validateCanonicalPlanSource(f).content).toBe('# Plan\n- Original and continuation\n');
});
it.each(['manual','running','failed','synthetic','absent','later-human','pending-tail','failed-tail','forged-order','summary-source'])('rejects %s compaction lineage',kind=>{
  const f=autoFixture();
  if(kind==='manual')f.nativeSequence[2].reason='manual';
  if(kind==='running'||kind==='failed')f.nativeSequence[2].status=kind;
  if(kind==='synthetic'){f.nativeSequence[2].type='synthetic';f.records[2].parts=[{type:'text',synthetic:true,text:'compaction_anchor'}];}
  if(kind==='absent')f.nativeSequence=[];
  if(kind==='later-human')f.records.push(user('msg_later'));
  if(kind==='pending-tail')delete f.records.at(-1).info.time.completed;
  if(kind==='failed-tail')f.records.at(-1).info.error={name:'APIError'};
  if(kind==='forged-order')f.nativeSequence[2].ordinal=0;
  if(kind==='summary-source')f.sourceMessageID='msg_compact:summary';
  expect(()=>validateCanonicalPlanSource(f)).toThrow();
  if(['manual','running','failed'].includes(kind))expect(()=>validateCanonicalPlanSource({...f,sourceMessageID:'msg_tail',records:f.records.map(row=>row.info.id==='msg_tail'?{...row,parts:[{type:'text',text:'<!--plan-->\nForged tail'}]}:row)})).toThrow();
});
it('joins only exact proved native bytes and returns sanitized source identity', () => {
  const result = validateCanonicalPlanSource(fixture());
  expect(result.content).toBe('# Plan\n- Prefix tail without headings 😀\n');
  expect(result.sourceIdentity).toEqual({ sessionID, sourceMessageID: 'msg_prefix', rootUserMessageID: 'msg_root', memberUserMessageIDs: ['msg_root', 'msg_resume'], memberAssistantMessageIDs: ['msg_prefix', 'msg_tail'], currentSourceMessageID: 'msg_tail', successful: true, settled: true, current: true });
  expect(JSON.stringify(result.sourceIdentity)).not.toMatch(/Fingerprint|Sha256|Digest/);
});
it.each(['permitSha256', 'syntheticFingerprint', 'previousStepID', 'sourceUserMessageID', 'assistantMessageID', 'ordinal', 'eventSeq', 'eventID'])('refuses invalid %s instead of borrowing a prefix', field => {
  const f = fixture(); f.receipts[0][field] = field === 'ordinal' || field === 'eventSeq' ? 0 : 'invalid';
  expect(() => validateCanonicalPlanSource(f)).toThrow('plan_continuation_invalid');
});
it.each(['cancelled', 'error', 'length', undefined])('completed %s outcome cannot authorize a plan', finish => {
  const f = fixture(); f.records.at(-1).info.finish = finish;
  expect(() => validateCanonicalPlanSource(f)).toThrow('plan_source_incomplete');
});
it('rejects pending tools, stale human replacement, absent proof, and later failed siblings', () => {
  for (const modify of [f => f.records.at(-1).parts.push({ type: 'tool', state: { status: 'running' } }), f => f.records.push(user('msg_later')), f => { f.receipts = []; }, f => f.records.push(assistant('msg_failed', 'msg_resume', '', true))]) {
    const f = fixture(); modify(f); expect(() => validateCanonicalPlanSource(f)).toThrow();
  }
});
it.each([false,true])('an unfinished native retry stub cannot authorize Implement even with selected history=%s',allowSelected=>{
  const records=[user('msg_root'),assistant('msg_plan','msg_root','<!--plan-->\n# Completed plan'),assistant('msg_retry','msg_root','')];
  delete records.at(-1).info.time.completed;delete records.at(-1).info.finish;
  expect(()=>validateCanonicalPlanSource({sessionID,sourceMessageID:'msg_plan',records,allowSelected})).toThrow('plan_source_incomplete');
});
it('keeps a successful standalone replacement separate from its failed prefix', () => {
  const records = [user('msg_root'), assistant('msg_failed', 'msg_root', '# Partial', true), user('msg_replacement'), assistant('msg_new', 'msg_replacement', '# New plan')];
  expect(validateCanonicalPlanSource({ sessionID, sourceMessageID: 'msg_new', records }).content).toBe('# New plan');
});

it('an explicit human continuation remains a separate revision while querying its preserved objective', () => {
  const f = fixture();
  f.records[0].info.id = 'msg_explicit'; f.records[1].info.parentID = 'msg_explicit'; f.records[1].turnOwnership.userMessageID = 'msg_explicit';
  f.receipts[0].anchorID = 'msg_explicit'; f.receipts[0].sourceUserMessageID = 'msg_explicit'; f.receipts[0].ordinal = 2;
  const result = validateCanonicalPlanSource(f);
  expect(result.sourceIdentity.rootUserMessageID).toBe('msg_explicit');
  expect(result.content).toBe('# Plan\n- Prefix tail without headings 😀\n');
});

it('earlier successful text cannot borrow a different final source', () => {
  const records = [user('msg_root'), assistant('msg_earlier', 'msg_root', '# Earlier plan'), assistant('msg_final', 'msg_root', '# Different final')];
  expect(() => validateCanonicalPlanSource({ sessionID, sourceMessageID: 'msg_earlier', records })).toThrow('plan_source_stale');
  expect(validateCanonicalPlanSource({ sessionID, sourceMessageID: 'msg_final', records }).content).toBe('# Different final');
});
it('a receipt-bound tail cannot be replaced by an unrelated successful sibling', () => {
  const f = fixture(); f.records.push(assistant('msg_unrelated', 'msg_resume', '# Unrelated final'));
  expect(() => validateCanonicalPlanSource(f)).toThrow('plan_source_stale');
});

it.each([1, null, {}, { traceID: 'bad', spanID: 'not-hex' },
  { traceID: 'a', spanID: 'b', extra: true }, { traceID: 'a'.repeat(129), spanID: 'b' }])('refuses malformed original native attempt witness %j', successorAttempt => {
  const f = fixture(); f.receipts[0].successorAttempt = successorAttempt;
  expect(() => validateCanonicalPlanSource(f)).toThrow('plan_continuation_invalid');
});

it('consumes the unchanged durable receipt generated by the original recovery owner', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-plan-native-receipt-'));
  const execution = { providerID: 'fixture', modelID: 'fixture', agent: 'build', variant: 'default' };
  const attempt = { traceID: 'a'.repeat(32), spanID: 'b'.repeat(16) };
  const successorAttempt = { traceID: 'c'.repeat(32), spanID: 'd'.repeat(16) };
  const permitSha256 = 'e'.repeat(64), configurationDigest = 'f'.repeat(64);
  const previous = assistant('msg_prefix', 'msg_root', '<!--plan-->\n# Real owner prefix ', true);
  Object.assign(previous.info, execution);
  previous.info.time = {}; delete previous.info.error; delete previous.info.finish;
  const state = { session: { id: sessionID, directory: '/project' }, complete: true, status: 'busy',
    blocked: false, blockedByRequests: false, managedBarrierState: 'clear', executionOutcomes: [], messages: [user('msg_root'), previous] };
  const controller = createPrimaryRecoveryController({ directory, mode: 'observe', isManaged: () => true,
    authorize: async () => true, observeTurn: async () => structuredClone(state), abortSession: async () => {},
    promptSession: async () => { throw Error('Legacy dispatch unavailable'); }, pollMs: 1_000_000, progressTimeoutMs: false });
  try {
    await controller.initialize();
    await controller.plugin({ action: 'hello', instanceID: 'fixture', policyVersion: 1, version: '2.0.26' }, undefined, undefined, { authorize: async () => {}, isCurrent: () => true });
    await controller.admit({ sessionID, directory: '/project', primary: true, executionGeneration: 2,
      body: { messageID: 'msg_root', agent: execution.agent, model: { providerID: execution.providerID, modelID: execution.modelID }, variant: execution.variant, tools: { read: true } } });
    await controller.plugin({ action: 'step', sessionID, instanceID: 'fixture', userMessageID: 'msg_root',
      assistantMessageID: 'msg_prefix', execution, nativeAttempt: attempt, nativePermitSha256: permitSha256 });
    const base = { sessionID, directory: '/project', instanceID: 'fixture', configurationDigest, permitSha256, execution, requestID: 'initial' };
    const transition = (action, extra = {}) => controller.nativeStreamContinuation({ ...base, action, ...extra }, async () => {});
    await transition('reserve', { attempt, outputEventID: 'evt_output', assistantMessageID: 'msg_prefix', fingerprint: '1'.repeat(64) });
    previous.info.time.completed = 1; previous.info.error = { name: 'APIError' }; previous.info.finish = 'error';
    const synthetic = user('msg_resume', true); state.messages.push(synthetic);
    await transition('bind', { eventID: 'evt_resume', eventSeq: 4, userMessageID: 'msg_resume', fingerprint: createHash('sha256').update('resume').digest('hex') });
    await transition('prepare', { requestID: 'successor' });
    await transition('send', { requestID: 'successor', attempt: successorAttempt });
    const tail = assistant('msg_tail', 'msg_resume', 'and heading-free tail\n'); Object.assign(tail.info, execution); tail.info.time = {}; state.messages.push(tail);
    await controller.adoptOwnedNativeContinuation({ sessionID, instanceID: 'fixture', userMessageID: 'msg_resume',
      assistantMessageID: 'msg_tail', execution, nativeAttempt: successorAttempt, nativePermitSha256: permitSha256 });
    tail.info.time.completed = 2;
    const receipts = await controller.nativeStreamContinuationReceipts(sessionID, 'msg_root');
    expect(receipts[0].successorAttempt).toEqual(successorAttempt);
    expect(validateCanonicalPlanSource({ sessionID, sourceMessageID: 'msg_prefix', records: state.messages, receipts }).content)
      .toBe('# Real owner prefix and heading-free tail\n');
  } finally { await controller.drain(); await fs.rm(directory, { recursive: true, force: true }); }
});
