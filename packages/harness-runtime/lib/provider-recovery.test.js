import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPrimaryRecoveryController } from './provider-recovery.js';
import { classifyPrimaryTransportError, PROVIDER_RECOVERY_SUPPORTED_OPENCODE_VERSIONS, validatePrimaryRecoveryRecord } from './provider-recovery-policy.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const timeout = { name: 'UnknownError', data: { message: 'The operation timed out.' } };
const identity = { sessionID: 'ses_test', userMessageID: 'msg_user', assistantMessageID: 'msg_failed', instanceID: 'runtime-test' };

const nativeShellStep = { sessionID: identity.sessionID, userMessageID: 'msg_shell', assistantMessageID: 'msg_native', instanceID: identity.instanceID,
  execution: { providerID: 'openai', modelID: 'gpt-5.6-sol', agent: 'orchestrator', variant: 'xhigh' } };
const nativeAssistant = () => ({ info: { id: 'msg_native', sessionID: identity.sessionID, role: 'assistant', parentID: 'msg_shell',
  agent: 'orchestrator', providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'xhigh', time: {} }, parts: [],
  turnOwnership: { source: 'native-sequence', userMessageID: 'msg_shell' } });

async function fixture(overrides = {}, providerID = 'openai', agent = 'orchestrator', executionGeneration) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-recovery-'));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  let time = 10_000;
  let onWait = () => {};
  const sent = []; const incidents = []; const aborted = [];
  const state = { session: { id: identity.sessionID, directory: '/project' }, complete: true, status: 'idle', blocked: false,
    messages: [{ info: { id: 'msg_user', role: 'user' }, parts: [{ type: 'text', text: 'Original request' }] },
      { info: { id: 'msg_failed', role: 'assistant', parentID: 'msg_user', error: timeout, time: { completed: time } }, parts: [] }] };
  const controller = createPrimaryRecoveryController({ directory, mode: 'enforce', isManaged: () => true,
    now: () => time, pollMs: 1_000_000, wait: async (ms) => { time += ms; onWait(); },
    authorize: async () => true, observeTurn: async () => structuredClone(state),
    abortSession: async () => { aborted.push(true); state.status = 'idle'; },
    promptSession: async (r, body) => { sent.push(body); },
    createMessageID: () => 'msg_recovery', recordIncident: (entry) => incidents.push(entry),
    ...overrides,
  });
  await controller.initialize();
  cleanups.push(() => controller.drain());
  await controller.plugin({ action: 'hello', instanceID: identity.instanceID, policyVersion: 1, version: '1.18.25' });
  await controller.admit({ sessionID: identity.sessionID, directory: '/project', primary: true, ...(executionGeneration===undefined?{}:{executionGeneration}),
    body: { messageID: 'msg_user', agent, model: { providerID, modelID: providerID === 'anthropic' ? 'claude-opus-5' : 'gpt-5.6-sol' }, variant: 'xhigh' } });
  let requestHook;
  const fail = async () => {
    const r = await controller.readRecord(identity.sessionID);
    if (r.state === 'observing' && r.requestedAt === null) await (requestHook ??= controller.plugin({ action: 'step', ...identity }));
    return controller.observe({ type: 'session.error', properties: { sessionID: identity.sessionID, error: timeout } });
  };
  return { controller, state, sent, incidents, aborted, fail, directory, advance: (ms) => { time += ms; },
    snapshot: () => controller.getSnapshot(identity.sessionID), onWait: (callback) => { onWait = callback; } };
}

test('Stop while queued final admission awaits its write guard preserves the previous objective',async()=>{
 const f=await fixture({mode:'observe'},'openai','orchestrator',2),guard=await f.controller.captureNativePromptAdmission(identity.sessionID);
 const entered=Promise.withResolvers(),released=Promise.withResolvers();let calls=0;
 const admission=f.controller.admit({sessionID:identity.sessionID,directory:'/project',primary:true,executionGeneration:2,
  body:{messageID:'msg_queued',agent:'orchestrator',model:{providerID:'openai',modelID:'gpt-5.6-sol'},variant:'xhigh'}},async()=>{calls++;entered.resolve();await released.promise;await guard();});
 admission.catch(()=>{});await entered.promise;
 const stop=f.controller.control(identity.sessionID,'cancel');released.resolve();
 await expect(admission).rejects.toMatchObject({code:'native_queued_admission_revoked'});await stop;
 expect(calls).toBe(1);const record=await f.controller.readRecord(identity.sessionID);
 expect(record.anchorID).toBe('msg_user');expect(record.state).toBe('cancelled');
});

test('queued final admission guard fences real Stop/supersede and accepts its own admission invalidation',async()=>{
 for(const action of ['cancel','supersede']){
  const f=await fixture({mode:'observe'},'openai','orchestrator',2);
  const guard=await f.controller.captureNativePromptAdmission(identity.sessionID);
  await f.controller.control(identity.sessionID,action);
  await expect(f.controller.admit({sessionID:identity.sessionID,directory:'/project',primary:true,executionGeneration:2,
    body:{messageID:'msg_queued',agent:'orchestrator',model:{providerID:'openai',modelID:'gpt-5.6-sol'},variant:'xhigh'}},guard)).rejects.toMatchObject({code:'native_queued_admission_revoked'});
  expect((await f.controller.readRecord(identity.sessionID)).anchorID).toBe('msg_user');
 }
 const f=await fixture({mode:'observe'},'openai','orchestrator',2);
 const guard=await f.controller.captureNativePromptAdmission(identity.sessionID);
 await f.controller.admit({sessionID:identity.sessionID,directory:'/project',primary:true,executionGeneration:2,
  body:{messageID:'msg_queued',agent:'orchestrator',model:{providerID:'openai',modelID:'gpt-5.6-sol'},variant:'xhigh'}},guard);
 expect((await f.controller.readRecord(identity.sessionID)).anchorID).toBe('msg_queued');
});

describe('private receipt-backed native primary continuation', () => {
  test('status-only history does not supersede a tracked turn',async()=>{
    const f=await fixture({mode:'observe'},'openai','orchestrator',2);
    const notice={info:{id:'msg_status',sessionID:identity.sessionID,role:'user'},parts:[{type:'text',synthetic:true,text:'UI ready'}],nativeStatus:{source:'native-sequence',kind:'status-only'}};
    f.state.messages.push(notice);
    await f.fail();expect((await f.snapshot()).record.state).toBe('observing');
    expect(f.sent).toHaveLength(0);
  });

  const trusted = async (_record, observation, target) => observation.complete && target === 'msg_shell' ? { kind: 'native-shell' } : null;
  const appendShell = f => f.state.messages.push({ info: { id: 'msg_shell', sessionID: identity.sessionID, role: 'user' },
    parts: [{ type: 'text', synthetic: true, text: 'Actual owned shell result' }] });

  test('receipt arrival retains the current unfinished step until canonical next Step.Started', async () => {
    const f = await fixture({ verifyOwnedNativeContinuation: trusted });
    delete f.state.messages.at(-1).info.error; delete f.state.messages.at(-1).info.time.completed;
    await f.controller.plugin({ action: 'step', ...identity });
    const before = await f.controller.readRecord(identity.sessionID);
    appendShell(f); f.state.status = 'busy';
    await f.controller.observe({ type: 'session.status', properties: { sessionID: identity.sessionID, status: { type: 'idle' } } });
    expect(await f.controller.readRecord(identity.sessionID)).toEqual(before);
    f.state.messages.push(nativeAssistant());
    await expect(f.controller.adoptOwnedNativeContinuation(nativeShellStep)).rejects.toMatchObject({ code: 'native_continuation_fenced' });
    f.state.messages.find(message => message.info.id === identity.assistantMessageID).info.time.completed = 10_001;
    const adopted = await f.controller.adoptOwnedNativeContinuation(nativeShellStep);
    expect(adopted).toMatchObject({ anchorID: 'msg_user', activeUserID: 'msg_shell', state: 'observing', requestedAt: null, stepID: null,
      providerID: before.providerID, modelID: before.modelID, variant: before.variant, tools: before.tools,
      attemptCount: before.attemptCount, cancellationGeneration: before.cancellationGeneration });
    await f.controller.plugin({ action: 'step', ...nativeShellStep });
    expect((await f.controller.readRecord(identity.sessionID)).stepID).toBe('msg_native');
    await expect(f.controller.plugin({ action: 'step', ...identity, userMessageID: 'msg_foreign' })).rejects.toThrow('fenced');
    expect(f.sent).toEqual([]);
  });

  test('completed foreground replies allow exact owned adoption and restart replay without another revision', async () => {
    const f = await fixture({ verifyOwnedNativeContinuation: trusted });
    delete f.state.messages.at(-1).info.error;
    await f.controller.plugin({ action: 'step', ...identity });
    await f.controller.observe({ type: 'session.status', properties: { sessionID: identity.sessionID, status: { type: 'idle' } } });
    expect((await f.controller.readRecord(identity.sessionID)).state).toBe('completed');
    appendShell(f); f.state.messages.push(nativeAssistant()); f.state.status = 'busy';
    const adopted = await f.controller.adoptOwnedNativeContinuation(nativeShellStep);
    expect((await f.controller.adoptOwnedNativeContinuation(nativeShellStep)).revision).toBe(adopted.revision);
    const foreign = nativeAssistant(); foreign.info.id = 'msg_other'; f.state.messages.push(foreign);
    await expect(f.controller.adoptOwnedNativeContinuation({ ...nativeShellStep, assistantMessageID: 'msg_other' }))
      .rejects.toMatchObject({ code: 'native_continuation_fenced' });
    f.state.messages.pop();
    await f.controller.drain();
    const restarted = createPrimaryRecoveryController({ directory: f.directory, mode: 'off', isManaged: () => true, authorize: async () => true,
      observeTurn: async () => structuredClone(f.state), verifyOwnedNativeContinuation: trusted,
      abortSession: async () => {}, promptSession: async () => {} });
    await restarted.initialize(); cleanups.push(() => restarted.drain());
    await restarted.plugin({ action: 'hello', policyVersion: 1, instanceID: 'runtime-restarted', version: '1.18.25' });
    expect((await restarted.adoptOwnedNativeContinuation({ ...nativeShellStep, instanceID: 'runtime-restarted' })).revision).toBe(adopted.revision);
  });

  test.each([undefined, async () => null, async () => ({ kind: 'caller-metadata' }), async () => { throw new Error('receipt unavailable'); }])
    ('missing, malformed or unreadable receipt authority cannot adopt a synthetic user', async verifyOwnedNativeContinuation => {
      const f = await fixture({ verifyOwnedNativeContinuation });
      delete f.state.messages.at(-1).info.error;
      await f.controller.plugin({ action: 'step', ...identity });
      appendShell(f); f.state.messages.push(nativeAssistant());
      await expect(f.controller.adoptOwnedNativeContinuation(nativeShellStep)).rejects.toThrow();
      expect((await f.controller.readRecord(identity.sessionID)).activeUserID).toBeUndefined();
    });

  test('canonical completeness, exact saved selection and cancellation remain fences around trusted proof', async () => {
    const f = await fixture({ verifyOwnedNativeContinuation: trusted });
    delete f.state.messages.at(-1).info.error; await f.controller.plugin({ action: 'step', ...identity });
    appendShell(f); f.state.messages.push(nativeAssistant());
    await expect(f.controller.adoptOwnedNativeContinuation({ ...nativeShellStep, execution: { ...nativeShellStep.execution, variant: 'high' } }))
      .rejects.toMatchObject({ code: 'native_continuation_fenced' });
    f.state.complete = false;
    await expect(f.controller.adoptOwnedNativeContinuation(nativeShellStep)).rejects.toThrow();
    f.state.complete = true;
    await f.controller.control(identity.sessionID, 'stop');
    await expect(f.controller.adoptOwnedNativeContinuation(nativeShellStep)).rejects.toMatchObject({ code: 'native_continuation_fenced' });
    await expect(f.controller.plugin({ action: 'adoptOwnedNativeContinuation', ...nativeShellStep })).rejects.toThrow('fenced');
  });

  test('a cancellation during receipt verification wins without changing objective ownership', async () => {
    let entered, resolve; const started = new Promise(done => { entered = done; }); const waiting = new Promise(done => { resolve = done; });
    const f = await fixture({ verifyOwnedNativeContinuation: async () => { entered(); return waiting; } });
    delete f.state.messages.at(-1).info.error; await f.controller.plugin({ action: 'step', ...identity });
    appendShell(f); f.state.messages.push(nativeAssistant());
    const adoption = f.controller.adoptOwnedNativeContinuation(nativeShellStep);
    await started;
    const cancel = f.controller.control(identity.sessionID, 'stop');
    resolve({ kind: 'native-shell' });
    await expect(adoption).rejects.toMatchObject({ code: 'native_continuation_fenced' }); await cancel;
    expect(await f.controller.readRecord(identity.sessionID)).toMatchObject({ anchorID: 'msg_user', state: 'cancelled' });
  });

  test('private adoption keeps the existing pure native compaction path without shell authority', async () => {
    const f = await fixture(); delete f.state.messages.at(-1).info.error;
    await f.controller.plugin({ action: 'step', ...identity });
    f.state.messages.push({ info: { id: 'msg_shell', role: 'user' }, parts: [{ type: 'compaction', auto: true }] }, nativeAssistant());
    const adopted = await f.controller.adoptOwnedNativeContinuation(nativeShellStep);
    expect(adopted).toMatchObject({ anchorID: 'msg_user', activeUserID: 'msg_shell', attemptCount: 0,
      ownedNativeContinuation: { kind: 'native-compaction', sourceUserMessageID: 'msg_user' } });
    expect((await f.controller.adoptOwnedNativeContinuation(nativeShellStep)).revision).toBe(adopted.revision);
    await f.controller.plugin({ action: 'step', ...nativeShellStep });
  });

  test('trusted shell-to-compaction proof uses the last canonical user and preserves existing budgets', async () => {
    const targets = [];
    const f = await fixture({ mode: 'off', verifyOwnedNativeContinuation: async (_record, _observation, target) => {
      targets.push(target); return target === 'msg_shell' ? { kind: 'native-shell' } : null;
    } });
    delete f.state.messages.at(-1).info.error;
    await f.controller.plugin({ action: 'continuation', ...identity, userMessageID: 'msg_todo', anchorUserMessageID: 'msg_user',
      directory: '/project', kind: 'orchestrator_todo', execution: nativeShellStep.execution });
    f.state.messages.push({ info: { id: 'msg_todo', role: 'user' }, parts: [] },
      { info: { id: 'msg_todostep', role: 'assistant', parentID: 'msg_todo', time: { completed: 10_000 } }, parts: [] });
    await f.controller.plugin({ action: 'step', ...identity, userMessageID: 'msg_todo', assistantMessageID: 'msg_todostep' });
    const before = await f.controller.readRecord(identity.sessionID);
    f.state.messages.push({ info: { id: 'msg_result', role: 'user' }, parts: [{ type: 'text', synthetic: true, text: 'Shell result' }] },
      { info: { id: 'msg_shell', role: 'user' }, parts: [{ type: 'compaction' }] }, nativeAssistant());
    await f.controller.observe({ type: 'session.status', properties: { sessionID: identity.sessionID, status: { type: 'idle' } } });
    expect(targets).toContain('msg_shell');
    const result = await f.controller.adoptOwnedNativeContinuation(nativeShellStep);
    expect(result).toMatchObject({ anchorID: before.anchorID, continuationID: before.continuationID, activeUserID: 'msg_shell',
      todoContinuationCount: 1, attemptCount: before.attemptCount, cancellationGeneration: before.cancellationGeneration, tools: before.tools });
  });

  test('an unanswered trusted receipt verifier has a finite fail-closed bound', async () => {
    const f = await fixture({ verifyOwnedNativeContinuation: () => new Promise(() => {}) });
    delete f.state.messages.at(-1).info.error; await f.controller.plugin({ action: 'step', ...identity });
    appendShell(f); f.state.messages.push(nativeAssistant());
    await expect(f.controller.adoptOwnedNativeContinuation(nativeShellStep)).rejects.toMatchObject({ code: 'native_continuation_verification_unavailable' });
    expect((await f.controller.readRecord(identity.sessionID)).activeUserID).toBeUndefined();
  }, 8000);
});

describe('failure classification', () => {
  test('native rejection rechecks the original grant after the stored row read before durable writes',async()=>{
    const f=await fixture();await f.controller.plugin({action:'step',...identity});
    const before=await f.controller.readRecord(identity.sessionID);
    const rejection={...identity,callID:'call_rejected',fingerprint:'c'.repeat(64),reason:'binary_read_blocked'};
    await expect(f.controller.recordRejection(rejection,async()=>{throw Error('original_grant_revoked');})).rejects.toThrow('original_grant_revoked');
    expect(await f.controller.readRecord(identity.sessionID)).toEqual(before);
    expect(await f.controller.recordRejection(rejection,async()=>{})).toMatchObject({state:'correct-input',count:1});
  });

  test.each(['openai', 'xai'])('stops exact rejected-input cycles for %s without replaying or spending transport attempts', async (provider) => {
    const f = await fixture({}, provider);
    await f.controller.plugin({ action: 'step', ...identity });
    const reject = (callID) => f.controller.plugin({ action: 'rejected', ...identity, callID,
      fingerprint: 'a'.repeat(64), reason: 'binary_read_blocked' });
    expect(await reject('call_1')).toMatchObject({ state: 'correct-input', count: 1 });
    expect(await reject('call_1')).toMatchObject({ state: 'duplicate', count: 1 });
    expect(await reject('call_2')).toMatchObject({ state: 'corrective-replan', count: 2 });
    await f.controller.admit({ sessionID: identity.sessionID, primary: true, body: {
      parts: [{ type: 'text', synthetic: true, metadata: { compaction_continue: true }, text: 'Continue' }],
    } });
    expect(await reject('call_3')).toMatchObject({ state: 'blocked', count: 3 });
    expect((await f.snapshot()).record).toMatchObject({ state: 'needs_attention', reason: 'managed_repeated_preexecution_rejection', attemptCount: 0 });
    await expect(f.controller.plugin({ action: 'step', ...identity, assistantMessageID: 'msg_again' })).rejects.toThrow('fenced');
    expect(f.sent).toHaveLength(0); expect(f.aborted).toHaveLength(0);
  });

  test('records long useful work and deliberate failed-check evidence without semantic termination or budget refill', async () => {
    const f = await fixture();
    await f.controller.plugin({ action: 'step', ...identity });
    for (let i = 0; i < 180; i++) {
      f.advance(30_000);
      await f.controller.observeProgress({ sessionID: identity.sessionID, messageID: identity.assistantMessageID,
        kind: i % 2 ? 'required-check' : 'tool-evidence', identity: `evidence_${i}` });
    }
    await f.controller.observeProgress({ sessionID: identity.sessionID, kind: 'tool-evidence', identity: 'evidence_178' });
    const record = (await f.snapshot()).record;
    expect(record.state).toBe('observing');
    expect(record.attemptCount).toBe(0);
    expect(record.progress).toMatchObject({ policy: 'report-only', counts: { 'tool-evidence': 90, 'required-check': 90 } });
    expect(f.sent).toEqual([]);
  });

  test('does not count streaming tokens or an earlier objective as authoritative progress', async () => {
    const f = await fixture();
    await f.controller.plugin({ action: 'step', ...identity });
    for (let i = 0; i < 100; i++) f.controller.observe({ type: 'message.part.delta', properties: {
      sessionID: identity.sessionID, messageID: identity.assistantMessageID, partID: 'part_text', field: 'text', delta: 'still thinking',
    } });
    await f.controller.observeProgress({ sessionID: identity.sessionID, messageID: 'msg_old', kind: 'tool-evidence', identity: 'old' });
    expect((await f.snapshot()).record.progress).toMatchObject({ lastUsefulAt: null, counts: {} });
  });
  test('version-pins the lossy current runtime error and rejects generic wording', () => {
    expect(classifyPrimaryTransportError(timeout, '1.18.25')?.source).toBe('opencode_1.18.25_compatibility');
    expect(classifyPrimaryTransportError(timeout, '1.18.26')?.source).toBe('opencode_1.18.26_compatibility');
    expect(classifyPrimaryTransportError(timeout, '1.18.27')?.source).toBe('opencode_1.18.27_compatibility');
    expect(classifyPrimaryTransportError(timeout, '1.18.29')?.source).toBe('opencode_1.18.29_compatibility');
    expect(classifyPrimaryTransportError(timeout, '1.18.30')?.source).toBe('opencode_1.18.30_compatibility');
    expect(classifyPrimaryTransportError(timeout, '1.18.31')?.source).toBe('opencode_1.18.31_compatibility');
    expect(classifyPrimaryTransportError(timeout, '1.18.32')?.source).toBe('opencode_1.18.32_compatibility');
    expect(classifyPrimaryTransportError(timeout, '1.18.33')?.source).toBe('opencode_1.18.33_compatibility');
    expect(classifyPrimaryTransportError(timeout, '1.18.34')).toBeNull();
    expect(classifyPrimaryTransportError(timeout, undefined)).toBeNull();
    // The bundled companion is its upstream base; nothing else borrows it.
    expect(classifyPrimaryTransportError(timeout, '1.18.31-devryan.9')?.source).toBe('opencode_1.18.31_compatibility');
    expect(classifyPrimaryTransportError(timeout, '1.18.32-devryan.1')?.source).toBe('opencode_1.18.32_compatibility');
    expect(classifyPrimaryTransportError(timeout, '1.18.33-devryan.1')?.source).toBe('opencode_1.18.33_compatibility');
    for (const version of ['1.18.34-devryan.1', '1.18.31-devryan', '1.18.31-beta.1', '1.18.31-devryan.9-x', 'x1.18.31-devryan.9']) {
      expect(classifyPrimaryTransportError(timeout, version)).toBeNull();
    }
    expect(classifyPrimaryTransportError({ name: 'UnknownError', message: 'request timeout' }, '1.18.25')).toBeNull();
    expect(classifyPrimaryTransportError({ name: 'UnknownError', message: 'request timeout' }, '1.18.26')).toBeNull();
  });
  test('allow-lists only verified OpenCode versions for enforcement', async () => {
    expect([...PROVIDER_RECOVERY_SUPPORTED_OPENCODE_VERSIONS]).toEqual(['1.18.25', '1.18.26', '1.18.27', '1.18.29', '1.18.30', '1.18.31', '1.18.32', '1.18.33']);
    const f = await fixture();
    const hello = (version) => f.controller.plugin({ action: 'hello', instanceID: identity.instanceID, policyVersion: 1, version });
    expect((await hello('1.18.26')).supported).toBe(true);
    expect((await hello('1.18.27')).supported).toBe(true);
    expect((await hello('1.18.30')).supported).toBe(true);
    expect((await hello('1.18.31')).supported).toBe(true);
    expect((await hello('1.18.32')).supported).toBe(true);
    expect((await hello('1.18.33')).supported).toBe(true);
    expect((await hello('1.18.34')).supported).toBe(false);
    expect((await hello('1.18.25')).supported).toBe(true);
  });
  test.each(['AuthenticationError', 'QuotaError', 'CertificateError', 'ModelNotFoundError', 'AbortError', 'PolicyError'])(
    'excludes %s even with a transient-looking code', (name) => {
      expect(classifyPrimaryTransportError({ name, code: 'ETIMEDOUT' }, '1.18.25')).toBeNull();
    });
  test.each(['ECONNRESET', 'ETIMEDOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET'])(
    'accepts explicit transport code %s', (code) => expect(classifyPrimaryTransportError({ code }, '1.18.25')).not.toBeNull());
});

test('incident regression: all 41 completed tools survive idle-before-finalization', async () => {
  const f = await fixture();
  f.state.messages.splice(1, 0, ...Array.from({ length: 41 }, (_, i) => ({
    info: { role: 'assistant', id: `msg_prior_${i}`, parentID: 'msg_user', time: { completed: 5 } },
    parts: [{ type: 'tool', callID: `call_${i}`, tool: i === 0 ? 'write' : 'read', state: { status: 'completed', output: 'preserved' } }],
  })));
  f.state.messages.at(-1).info.time = {};
  // Settlement poll sees the same idle state until the actual message finalizes.
  let waits = 0;
  f.onWait(() => { if (++waits === 2) f.state.messages.at(-1).info.time.completed = 10_000; });
  await f.fail();
  expect(waits).toBe(2);
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0].parts[0].text).toContain('existing progress');
  expect(f.sent[0]).toMatchObject({ agent: 'orchestrator', variant: 'xhigh', model: { providerID: 'openai', modelID: 'gpt-5.6-sol' } });
  expect(f.state.messages.flatMap((m) => m.parts).filter((p) => p.type === 'tool')).toHaveLength(41);
});

test('no-work recovery resends original text and attachment references only once', async () => {
  const f = await fixture();
  f.state.messages[0].parts.push({ type: 'file', mime: 'text/plain', url: 'file:///project/input.txt', filename: 'input.txt' });
  await Promise.all([f.fail(), f.fail(), f.fail()]);
  await f.controller.reconcile();
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0].parts).toEqual(f.state.messages[0].parts);
  expect((await f.snapshot()).record.attemptCount).toBe(1);
});

test('observe mode records candidates without abort or recovery', async () => {
  const f = await fixture({ mode: 'observe' });
  await f.fail();
  expect(f.sent).toHaveLength(0); expect(f.aborted).toHaveLength(0);
  expect(f.incidents.some((i) => i.event === 'provider_recovery_candidate')).toBe(true);
});

test('initial plugin handshake and delayed idle cannot settle an unpersisted admission', async () => {
  const f = await fixture(); f.state.messages = [];
  await f.controller.plugin({ action: 'hello', instanceID: identity.instanceID, policyVersion: 1, version: '1.18.25' });
  await f.controller.observe({ type: 'session.status', properties: { sessionID: identity.sessionID, status: { type: 'idle' } } });
  expect((await f.snapshot()).record.state).toBe('observing');
  await expect(f.controller.plugin({ action: 'step', ...identity })).resolves.toMatchObject({ allowed: true });
  expect(f.sent).toHaveLength(0);
});

test('a runtime-wide handshake does not authorize recovery without this turn\'s request hook', async () => {
  const f = await fixture();
  await f.controller.observe({ type: 'session.error', properties: { sessionID: identity.sessionID, error: timeout } });
  expect(f.sent).toHaveLength(0);
  expect((await f.snapshot()).enforced).toBe(false);
});

test('ineligible failures remain actionable without authorizing recovery', async () => {
  const f = await fixture();
  f.state.messages.at(-1).info.error = { name: 'AuthenticationError', data: { message: 'Authentication failed' } };
  await f.controller.observe({ type: 'session.error', properties: { sessionID: identity.sessionID,
    error: { name: 'AuthenticationError', data: { message: 'Authentication failed' } } } });
  expect((await f.snapshot()).record).toMatchObject({ state: 'needs_attention', reason: 'failure_not_eligible' });
  expect(f.sent).toHaveLength(0);
});

test('a stale session.error cannot abort the current healthy provider step', async () => {
  const f = await fixture(); f.state.status = 'busy';
  delete f.state.messages.at(-1).info.error; f.state.messages.at(-1).info.time = {};
  await f.controller.plugin({ action: 'step', ...identity });
  await f.fail();
  expect(f.aborted).toHaveLength(0); expect(f.sent).toHaveLength(0);
  expect((await f.snapshot()).record.state).toBe('observing');
});

test('unknown failure and unsupported runtime never recover automatically', async () => {
  const f = await fixture();
  f.state.messages.at(-1).info.error = { name: 'UnknownError', message: 'Something failed' };
  await f.controller.observe({ type: 'session.status', properties: { sessionID: identity.sessionID, status: { type: 'idle' } } });
  expect(f.sent).toHaveLength(0);
  await f.controller.plugin({ action: 'hello', instanceID: identity.instanceID, policyVersion: 1, version: '1.19.0' });
  expect((await f.snapshot()).enforced).toBe(false);
});

test('semantic timeout is a suspected stall, never transient authorization', async () => {
  const f = await fixture();
  f.state.status = 'busy';
  delete f.state.messages.at(-1).info.error;
  await f.controller.plugin({ action: 'step', ...identity });
  f.advance(300_000);
  await f.controller.reconcile();
  expect(f.aborted).toHaveLength(1); expect(f.sent).toHaveLength(0);
  expect((await f.snapshot()).record.reason).toBe('provider_progress_timeout');
});

test('the automatic recovery also has a liveness deadline and cannot recover again', async () => {
  const f = await fixture(); await f.fail();
  f.state.messages.push({ info: { id: 'msg_recovery', role: 'user' }, parts: [] },
    { info: { id: 'msg_retry_step', role: 'assistant', parentID: 'msg_recovery', time: { completed: 1 } }, parts: [] });
  f.state.status = 'busy';
  await f.controller.plugin({ action: 'step', ...identity, userMessageID: 'msg_recovery', assistantMessageID: 'msg_retry_step' });
  f.advance(300_000); await f.controller.reconcile();
  expect(f.aborted).toHaveLength(1); expect(f.sent).toHaveLength(1);
  expect((await f.snapshot()).record).toMatchObject({ state: 'needs_attention', attemptCount: 1, failedID: 'msg_failed' });
});

test('Stop during dispatch cannot be overwritten by a late acknowledgement', async () => {
  let acknowledge; let entered;
  const reached = new Promise((resolve) => { entered = resolve; });
  const f = await fixture({ promptSession: async () => { entered(); await new Promise((resolve) => { acknowledge = resolve; }); } });
  const failure = f.fail(); await reached;
  await f.controller.control(identity.sessionID, 'stop'); acknowledge(); await failure;
  expect((await f.snapshot()).record).toMatchObject({ state: 'cancelled', attemptCount: 1 });
});

test.each(['tool', 'question', 'permission', 'retry'])('excludes verified %s phase', async (phase) => {
  const f = await fixture(); f.state.status = 'busy';
  await f.controller.plugin({ action: 'step', ...identity });
  if (phase === 'tool') await f.controller.plugin({ action: 'tool_before', ...identity, callID: 'call_active', tool: 'bash' });
  else if (phase === 'retry') f.controller.observe({ type: 'session.status', properties: { sessionID: identity.sessionID, status: { type: 'retry' } } });
  else f.controller.observe({ type: `${phase}.asked`, properties: { sessionID: identity.sessionID, id: 'request' } });
  f.advance(600_000); await f.controller.reconcile();
  expect(f.aborted).toHaveLength(0);
});

test.each([
  ['completed', identity.assistantMessageID, 'call_active', 0],
  ['error', identity.assistantMessageID, 'call_active', 0],
  ['completed', 'msg_other_step', 'call_active', 1],
  ['error', 'msg_other_step', 'call_active', 1],
  ['completed', identity.assistantMessageID, 'call_other', 1],
  ['error', identity.assistantMessageID, 'call_other', 1],
  ['running', identity.assistantMessageID, 'call_active', 1],
])('terminal %s on %s/%s retains exactly %i live calls', async (status, messageID, callID, remaining) => {
  const f = await fixture({ settlementMs: 1 });
  await f.controller.plugin({ action: 'step', ...identity });
  await f.controller.plugin({ action: 'tool_before', ...identity, callID: 'call_active', tool: 'read' });
  f.controller.observe({ type: 'message.part.updated', properties: { part: { id: 'part_tool',
    sessionID: identity.sessionID, messageID, type: 'tool', callID, tool: 'read',
    state: { status, input: {}, output: '' } } } });
  await f.fail();
  expect(f.incidents.findLast(entry => entry.event === 'provider_recovery_candidate')?.executingTools).toBe(remaining);
  // Clearing a terminal call merely removes liveness; normal canonical turn,
  // outcome, settlement and recovery admission checks still run afterward.
  expect(f.sent).toHaveLength(remaining ? 0 : 1);
});

test('progress resets the clock; repeated busy and accounting events do not', async () => {
  const f = await fixture(); f.state.status = 'busy';
  await f.controller.plugin({ action: 'step', ...identity });
  f.advance(299_999);
  f.controller.observe({ type: 'message.part.delta', properties: { sessionID: identity.sessionID, messageID: identity.assistantMessageID, field: 'reasoning', delta: 'new' } });
  f.advance(299_999); await f.controller.reconcile(); expect(f.aborted).toHaveLength(0);
  f.controller.observe({ type: 'session.status', properties: { sessionID: identity.sessionID, status: { type: 'busy' } } });
  f.advance(1); await f.controller.reconcile(); expect(f.aborted).toHaveLength(1);
});

test('unresolved tool on a finalized failure prevents dispatch', async () => {
  const f = await fixture();
  f.state.messages.at(-1).parts.push({ type: 'tool', state: { status: 'error' } });
  await f.fail(); expect(f.sent).toHaveLength(0);
  expect((await f.snapshot()).record.reason).toBe('recovery_tool_outcome_unknown');
});

test('unobservable pending tool arguments are not mistaken for execution or a confirmed stall', async () => {
  const f = await fixture(); f.state.status = 'busy'; delete f.state.messages.at(-1).info.error;
  f.state.messages.at(-1).parts.push({ id: 'part_input', type: 'tool', state: { status: 'pending', input: {}, raw: '' } });
  await f.controller.plugin({ action: 'step', ...identity });
  f.advance(300_000); await f.controller.reconcile();
  expect(f.aborted).toHaveLength(0); expect(f.sent).toHaveLength(0);
  expect((await f.snapshot()).record.reason).toBe('provider_input_progress_unavailable');
  expect(f.incidents.some((i) => i.event === 'provider_progress_unobservable')).toBe(true);
});

test('canonical progress after sleep or reconnect cancels a stale cutoff', async () => {
  const f = await fixture(); f.state.status = 'busy'; delete f.state.messages.at(-1).info.error;
  await f.controller.plugin({ action: 'step', ...identity });
  f.state.messages.at(-1).parts.push({ id: 'part_reasoning', type: 'reasoning', text: 'Progress while the observer was disconnected' });
  f.advance(600_000); await f.controller.reconcile(); expect(f.aborted).toHaveLength(0);
  f.advance(300_000); await f.controller.reconcile(); expect(f.aborted).toHaveLength(1);
});

test('canonical executing tools block a cutoff even if a hook event was missed', async () => {
  const f = await fixture(); f.state.status = 'busy'; delete f.state.messages.at(-1).info.error;
  await f.controller.plugin({ action: 'step', ...identity });
  f.state.messages.at(-1).parts.push({ id: 'part_tool', type: 'tool', state: { status: 'running' } });
  f.advance(600_000); await f.controller.reconcile(); expect(f.aborted).toHaveLength(0);
});

test('already observed text deltas do not grant a second silence window at canonical recheck', async () => {
  const f = await fixture(); f.state.status = 'busy'; delete f.state.messages.at(-1).info.error;
  await f.controller.plugin({ action: 'step', ...identity });
  const part = { id: 'part_text', messageID: identity.assistantMessageID, sessionID: identity.sessionID, type: 'text', text: '' };
  f.controller.observe({ type: 'message.part.updated', properties: { part } });
  f.controller.observe({ type: 'message.part.delta', properties: { ...identity, messageID: identity.assistantMessageID, partID: part.id, field: 'text', delta: 'Hello' } });
  f.state.messages.at(-1).parts.push({ ...part, text: 'Hello' });
  f.advance(300_000); await f.controller.reconcile(); expect(f.aborted).toHaveLength(1);
});

test('native retry admission consumes no extra recovery and cannot loop', async () => {
  const f = await fixture(); await f.controller.plugin({ action: 'step', ...identity });
  await expect(f.controller.plugin({ action: 'step', ...identity })).rejects.toThrow('retry requires reconciliation');
  expect((await f.snapshot()).record.reason).toBe('native_retry_fenced');
  expect(f.sent).toHaveLength(0);
});

test('managed continuation and primary recovery share the admission boundary', async () => {
  const f = await fixture(); await f.fail();
  await expect(f.controller.plugin({ action: 'continuation', ...identity, userMessageID: 'msg_wake' })).rejects.toThrow('continuation fenced');
  expect(f.sent).toHaveLength(1);
});

describe('managed objective continuation ownership', () => {
  const continuation = (overrides = {}) => ({ action: 'continuation', ...identity, userMessageID: 'msg_wake',
    anchorUserMessageID: 'msg_user', directory: '/project', kind: 'collect',
    execution: { providerID: 'openai', modelID: 'gpt-5.6-sol', agent: 'orchestrator', variant: 'xhigh' }, ...overrides });
  test.each(['never_started', 'finished', 'uncertain', 'missing', 'wrong-message'])('collection requires exact durable failed-tool evidence: %s', async (outcome) => {
    const f = await fixture();
    delete f.state.messages.at(-1).info.error;
    f.state.messages.at(-1).parts.push({ type: 'tool', callID: 'call_failed', state: { status: 'error', error: 'execution did not start' } });
    f.state.executionOutcomes = outcome === 'missing' ? [] : [{ sessionID: identity.sessionID,
      messageID: outcome === 'wrong-message' ? 'msg_other' : identity.assistantMessageID,
      callID: 'call_failed', outcome: outcome === 'wrong-message' ? 'never_started' : outcome }];
    await expect(f.controller.plugin(continuation({ kind: 'orchestrator_todo' }))).rejects.toMatchObject({ code: 'managed_continuation_fenced' });
    if (['never_started', 'finished'].includes(outcome)) {
      await expect(f.controller.plugin(continuation())).resolves.toMatchObject({ allowed: true });
    } else await expect(f.controller.plugin(continuation())).rejects.toMatchObject({ code: 'managed_continuation_fenced' });
    expect(f.sent).toEqual([]);
  });
  test('unreadable outcome evidence is retried, never persisted as a collection fence', async () => {
    const f = await fixture({ verifyRecoveredCollection: async () => null });
    delete f.state.messages.at(-1).info.error;
    f.state.messages.at(-1).parts.push({ type: 'tool', callID: 'call_failed', state: { status: 'error', error: 'execution did not start' } });
    f.state.executionOutcomes = [];
    f.state.executionOutcomesUnavailable = true;
    const collect = continuation({ collection: { taskId: 'dvr_task_busy', claimantId: 'plugin-one' } });
    await expect(f.controller.plugin(collect)).rejects.toMatchObject({ code: 'managed_collection_evidence_unavailable' });
    expect((await f.controller.readRecord(identity.sessionID)).collectionIssue ?? null).toBeNull();
    f.state.executionOutcomesUnavailable = false;
    f.state.executionOutcomes = [{ sessionID: identity.sessionID, messageID: identity.assistantMessageID, callID: 'call_failed', outcome: 'never_started' }];
    await expect(f.controller.plugin(collect)).resolves.toMatchObject({ allowed: true });
  });
  test('persistently unreadable outcome evidence surfaces the result to the user and clears on collection', async () => {
    const f = await fixture({ verifyRecoveredCollection: async () => null });
    delete f.state.messages.at(-1).info.error;
    f.state.messages.at(-1).parts.push({ type: 'tool', callID: 'call_failed', state: { status: 'error', error: 'execution did not start' } });
    f.state.executionOutcomes = [];
    f.state.executionOutcomesUnavailable = true;
    const collect = continuation({ collection: { taskId: 'dvr_task_busy', claimantId: 'plugin-one' } });
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await expect(f.controller.plugin(collect)).rejects.toMatchObject({ code: 'managed_collection_evidence_unavailable' });
      expect((await f.controller.readRecord(identity.sessionID)).collectionIssue ?? null)
        .toEqual(attempt < 5 ? null : { taskId: 'dvr_task_busy', code: 'managed_collection_unverified' });
    }
    f.state.executionOutcomesUnavailable = false;
    f.state.executionOutcomes = [{ sessionID: identity.sessionID, messageID: identity.assistantMessageID, callID: 'call_failed', outcome: 'never_started' }];
    await expect(f.controller.plugin(collect)).resolves.toMatchObject({ allowed: true });
    expect((await f.controller.readRecord(identity.sessionID)).collectionIssue).toBeNull();
  });
  test('collection observations that keep timing out also surface the result', async () => {
    let timingOut = false, f;
    f = await fixture({ verifyRecoveredCollection: async () => null, observeTurn: async () => {
      if (timingOut) throw Object.assign(new Error('timeout'), { code: 'recovery_observation_timeout' });
      return structuredClone(f.state);
    } });
    timingOut = true;
    const collect = continuation({ collection: { taskId: 'dvr_task_slow', claimantId: 'plugin-one' } });
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await expect(f.controller.plugin(collect)).rejects.toMatchObject({ code: 'recovery_observation_timeout' });
      expect((await f.controller.readRecord(identity.sessionID)).collectionIssue ?? null)
        .toEqual(attempt < 5 ? null : { taskId: 'dvr_task_slow', code: 'managed_collection_unverified' });
    }
  });
  test('a busy turn is fenced even when outcome evidence is unreadable', async () => {
    const f = await fixture({ verifyRecoveredCollection: async () => null });
    delete f.state.messages.at(-1).info.error;
    f.state.messages.at(-1).parts.push({ type: 'tool', callID: 'call_failed', state: { status: 'error', error: 'execution did not start' } });
    f.state.executionOutcomes = [];
    f.state.executionOutcomesUnavailable = true;
    f.state.status = 'busy';
    await expect(f.controller.plugin(continuation({ collection: { taskId: 'dvr_task_busy', claimantId: 'plugin-one' } })))
      .rejects.toMatchObject({ code: 'managed_continuation_fenced' });
  });
  const land = (f, id) => {
    f.state.messages.push({ info: { id, role: 'user' }, parts: [{ type: 'text', synthetic: true,
      text: '[devryan-open-todo-continuation:v1]\nContinue current work.' }] },
    { info: { id: `msg_answer${id}`, role: 'assistant', parentID: id, time: { completed: 10_000 } }, parts: [] });
  };
  const proof = { taskId: 'dvr_task_recovered', envelopeId: 'dvr_result_recovered', rootSessionId: 'ses_test',
    directory: '/project', dispatchGroupId: 'msg_dispatch', attempt: 2, createdAt: 11_000, finishedAt: 12_000 };
  const recovered = () => continuation({ collection: { taskId: proof.taskId, claimantId: 'plugin-one' } });
  const recoveredFixture = async (overrides = {}) => {
    const f = await fixture({ verifyRecoveredCollection: async () => proof, ...overrides });
    f.advance(3_000);
    f.state.messages.splice(1, 0, { info: { id: 'msg_dispatch', role: 'assistant', parentID: 'msg_user', time: { completed: 5000 } }, parts: [] });
    f.state.messages.at(-1).info.error = { name: 'APIError', data: {
      message: 'Cannot connect to API: Unable to connect. Is the computer able to access the url?' } };
    f.state.blocked = true; f.state.blockedByRequests = false; f.state.managedBarrierState = 'awaiting_acknowledgement';
    return f;
  };
  test('a fenced collection journals which fence condition held it', async () => {
    const f = await recoveredFixture({ verifyRecoveredCollection: async () => null });
    await expect(f.controller.plugin(recovered())).rejects.toMatchObject({ code: 'managed_collection_unverified' });
    const g = await recoveredFixture();
    g.state.messages.at(-1).info.error = { name: 'APIError', data: { message: 'Invalid request body' } };
    await expect(g.controller.plugin(recovered())).rejects.toMatchObject({ code: 'managed_continuation_fenced', fenceReason: 'turn_error' });
    expect(g.incidents).toContainEqual(expect.objectContaining({ event: 'managed_collection_rejected',
      code: 'managed_continuation_fenced', fenceReason: 'turn_error', taskId: proof.taskId }));
  });
  test('incident: admits only a proven completed recovery after the parent API failure', async () => {
    const f = await recoveredFixture();
    await expect(f.controller.plugin(continuation())).rejects.toMatchObject({ code: 'managed_continuation_fenced' });
    await expect(f.controller.plugin(recovered())).resolves.toMatchObject({ allowed: true, tools: {} });
    expect(await f.controller.readRecord(identity.sessionID)).toMatchObject({ attemptCount: 0, anchorID: 'msg_user',
      continuationID: 'msg_wake', collectionWake: { taskId: proof.taskId, messageID: 'msg_wake' }, collectionIssue: null });
    expect(f.sent).toEqual([]); // Admission never replays the child or dispatches itself.
    await expect(f.controller.plugin({ ...recovered(), userMessageID: 'msg_duplicate' }))
      .rejects.toMatchObject({ code: 'managed_collection_delivery_unconfirmed' });
  });
  test('collection still works when canonical failure reconciliation preceded the user recovery', async () => {
    const f = await recoveredFixture();
    await f.fail();
    expect((await f.snapshot()).record).toMatchObject({ state: 'needs_attention', reason: 'failure_not_eligible', attemptCount: 0 });
    await expect(f.controller.plugin(recovered())).resolves.toMatchObject({ allowed: true });
    await f.controller.reconcile(); // The reserved wake is not yet in OpenCode.
    expect((await f.snapshot()).record).toMatchObject({ state: 'observing', reason: null, attemptCount: 0 });
  });
  test('Stop arriving during proof verification fences collection before reservation', async () => {
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; });
    const pending = new Promise(resolve => { release = resolve; });
    const f = await recoveredFixture({ verifyRecoveredCollection: async () => { enter(); await pending; return proof; } });
    const admission = f.controller.plugin(recovered());
    await entered;
    const stopped = f.controller.control(identity.sessionID, 'cancel');
    release();
    await expect(admission).rejects.toMatchObject({ code: 'managed_continuation_fenced' });
    await stopped;
    expect((await f.controller.readRecord(identity.sessionID)).collectionWake).toBeUndefined();
    expect((await f.snapshot()).record.state).toBe('cancelled');
  });
  test.each(['missing-proof', 'wrong-root', 'wrong-task', 'old-objective', 'old-attempt', 'not-recovered',
    'question', 'permission', 'running-tool', 'busy', 'authentication', 'unknown-outcome', 'cancelled', 'superseded', 'runtime-changed'])(
    'recovered collection preserves the %s fence', async scenario => {
      const invalid = { ...proof };
      if (scenario === 'wrong-root') invalid.rootSessionId = 'ses_other';
      if (scenario === 'wrong-task') invalid.taskId = 'dvr_task_other';
      if (scenario === 'old-objective') invalid.dispatchGroupId = 'msg_old';
      if (scenario === 'old-attempt') invalid.createdAt = 9_000;
      if (scenario === 'not-recovered') invalid.attempt = 1;
      const f = await recoveredFixture({ verifyRecoveredCollection: async () => scenario === 'missing-proof' ? null : invalid });
      if (scenario === 'question' || scenario === 'permission') f.state.blockedByRequests = true;
      if (scenario === 'running-tool' || scenario === 'unknown-outcome') f.state.messages.at(-1).parts.push({ type: 'tool',
        callID: 'call_unresolved', tool: 'bash', state: { status: scenario === 'running-tool' ? 'running' : 'pending' } });
      if (scenario === 'busy') f.state.status = 'busy';
      if (scenario === 'authentication') f.state.messages.at(-1).info.error = { name: 'AuthenticationError', code: 'ETIMEDOUT' };
      if (scenario === 'cancelled') await f.controller.control(identity.sessionID, 'cancel');
      if (scenario === 'superseded') await f.controller.admit({ sessionID: identity.sessionID, directory: '/project', primary: true,
        body: { messageID: 'msg_new', agent: 'orchestrator', model: { providerID: 'openai', modelID: 'gpt-5.6-sol' } } });
      if (scenario === 'runtime-changed') await f.controller.plugin({ action: 'hello', instanceID: 'new-runtime', policyVersion: 1, version: '1.18.31' });
      await expect(f.controller.plugin(recovered())).rejects.toBeInstanceOf(Error);
      expect(f.sent).toHaveLength(0);
      expect((await f.controller.readRecord(identity.sessionID)).collectionWake).toBeUndefined();
    });
  test('a second provider failure after the accepted collection never authorizes another wake', async () => {
    const f = await recoveredFixture();
    await f.controller.plugin(recovered()); land(f, 'msg_wake');
    f.state.messages.at(-1).info.error = structuredClone(f.state.messages.find(message => message.info.id === 'msg_failed').info.error);
    await expect(f.controller.plugin({ ...recovered(), userMessageID: 'msg_again' }))
      .resolves.toMatchObject({ deliveredMessageID: 'msg_wake' });
    expect((await f.controller.readRecord(identity.sessionID)).continuationID).toBe('msg_wake');
    expect(f.sent).toHaveLength(0);
  });
  test.each([false, true])('restart reconciles persisted wake acceptance=%s without another dispatch identity', async accepted => {
    const f = await recoveredFixture();
    await f.controller.plugin(recovered());
    await expect(f.controller.plugin({ ...recovered(), userMessageID: 'msg_uncertain' }))
      .rejects.toMatchObject({ code: 'managed_collection_delivery_unconfirmed' });
    if (accepted) land(f, 'msg_wake');
    await f.controller.drain();
    const restarted = createPrimaryRecoveryController({ directory: f.directory, mode: 'enforce', isManaged: () => true,
      authorize: async () => true, observeTurn: async () => structuredClone(f.state),
      verifyRecoveredCollection: async () => proof, abortSession: async () => {}, promptSession: async () => { throw new Error('unexpected dispatch'); } });
    await restarted.initialize(); cleanups.push(() => restarted.drain());
    await restarted.plugin({ action: 'hello', instanceID: identity.instanceID, policyVersion: 1, version: '1.18.31' });
    const result = restarted.plugin({ ...recovered(), userMessageID: 'msg_afterrestart' });
    if (accepted) await expect(result).resolves.toMatchObject({ deliveredMessageID: 'msg_wake' });
    else await expect(result).rejects.toMatchObject({ code: 'managed_collection_delivery_unconfirmed' });
    expect((await restarted.readRecord(identity.sessionID)).collectionWake.messageID).toBe('msg_wake');
    if (accepted) expect((await restarted.getSnapshot(identity.sessionID)).record.collectionIssue).toBeNull();
  });

  test('reports missing pre-upgrade objective ownership without manufacturing an owner or budget', async () => {
    const f = await fixture({ mode: 'off' });
    await expect(f.controller.plugin(continuation({ sessionID: 'ses_unowned' }))).rejects.toMatchObject({ code: 'managed_objective_unavailable' });
    expect(f.incidents).toContainEqual(expect.objectContaining({ event: 'managed_objective_unavailable', sessionID: 'ses_unowned', reason: 'new_user_input_required' }));
    expect(await f.controller.readRecord('ses_unowned')).toBeNull();
  });

  test('preserves the Builder stagnation guard across restart and permits new authoritative progress', async () => {
    const f = await fixture({ mode: 'off' }, 'xai', 'builder');
    delete f.state.messages.at(-1).info.error;
    f.state.todos = [{ content: 'Finish the implementation', status: 'in_progress', priority: 'high' }];
    f.state.messages.at(-1).parts.push({ type: 'tool', tool: 'todowrite', callID: 'call_todos',
      state: { status: 'completed', input: { todos: structuredClone(f.state.todos) } } });
    const builder = (id) => continuation({ userMessageID: id, kind: 'builder_todo',
      execution: { providerID: 'xai', modelID: 'gpt-5.6-sol', agent: 'builder', variant: 'xhigh' } });
    for (let i = 0; i < 2; i++) {
      await f.controller.plugin(builder(`msg_builder${i}`));
      land(f, `msg_builder${i}`);
    }
    await expect(f.controller.plugin(builder('msg_stagnant'))).rejects.toMatchObject({ code: 'managed_builder_todo_stagnant' });
    expect((await f.controller.readRecord(identity.sessionID)).todoContinuationCount).toBe(2);
    await f.controller.drain();
    const restarted = createPrimaryRecoveryController({ directory: f.directory, mode: 'off', isManaged: () => true,
      authorize: async () => true, observeTurn: async () => structuredClone(f.state), abortSession: async () => {}, promptSession: async () => {} });
    await restarted.initialize(); cleanups.push(() => restarted.drain());
    await restarted.plugin({ action: 'hello', instanceID: identity.instanceID, policyVersion: 1, version: '1.18.30' });
    await expect(restarted.plugin(builder('msg_restart'))).rejects.toMatchObject({ code: 'managed_builder_todo_stagnant' });
    await restarted.observeProgress({ sessionID: identity.sessionID, kind: 'artifact-changed', identity: 'verified-file-change' });
    await expect(restarted.plugin(builder('msg_progress'))).resolves.toMatchObject({ allowed: true, todoContinuationCount: 3 });
    expect((await restarted.readRecord(identity.sessionID)).builderTodoGuard.stagnantCount).toBe(0);
  });

  test('varying tool output cannot refill Builder stagnation allowance', async () => {
    const f = await fixture({ mode: 'off' }, 'xai', 'builder');
    delete f.state.messages.at(-1).info.error;
    f.state.todos = [{ content: 'Finish the implementation', status: 'in_progress', priority: 'high' }];
    f.state.messages.at(-1).parts.push({ type: 'tool', tool: 'todowrite', callID: 'call_todos',
      state: { status: 'completed', input: { todos: structuredClone(f.state.todos) } } });
    const builder = id => continuation({ userMessageID: id, kind: 'builder_todo',
      execution: { providerID: 'xai', modelID: 'gpt-5.6-sol', agent: 'builder', variant: 'xhigh' } });
    for (let index = 0; index < 2; index++) {
      await f.controller.plugin(builder(`msg_noisy${index}`));
      land(f, `msg_noisy${index}`);
      await f.controller.observeProgress({ sessionID: identity.sessionID, kind: 'tool-evidence',
        identity: `same-failed-test-output-with-duration-${index + 1}ms` });
    }
    await expect(f.controller.plugin(builder('msg_noisythird'))).rejects.toMatchObject({ code: 'managed_builder_todo_stagnant' });
    const record = await f.controller.readRecord(identity.sessionID);
    expect(record.todoContinuationCount).toBe(2);
    expect(record.progress.counts['tool-evidence']).toBe(2);
  });

  test.each(['earlier-objective', 'changed-canonical-todos', 'all-complete'])('does not nudge Builder from %s TODO evidence', async scenario => {
    const f = await fixture({ mode: 'off' }, 'xai', 'builder');
    delete f.state.messages.at(-1).info.error;
    f.state.todos = [{ content: 'Old unfinished work', status: 'pending', priority: 'high' }];
    const write = { type: 'tool', tool: 'todowrite', callID: 'call_todos', state: { status: 'completed', input: { todos: structuredClone(f.state.todos) } } };
    if (scenario === 'earlier-objective') f.state.messages.unshift({ info: { role: 'assistant', id: 'msg_prior' }, parts: [write] });
    else {
      f.state.messages.at(-1).parts.push(write);
      if (scenario === 'changed-canonical-todos') f.state.todos[0].content = 'Different current task';
      else { f.state.todos[0].status = 'completed'; write.state.input.todos[0].status = 'completed'; }
    }
    await expect(f.controller.plugin(continuation({ kind: 'builder_todo',
      execution: { providerID: 'xai', modelID: 'gpt-5.6-sol', agent: 'builder', variant: 'xhigh' } }))).rejects.toMatchObject({ code: expect.stringMatching(/^managed_builder_todo/) });
    expect((await f.controller.readRecord(identity.sessionID)).todoContinuationCount).toBeUndefined();
  });

  test.each(['off', 'observe', 'enforce'])('serializes competing hooks even in %s mode', async (mode) => {
    const f = await fixture({ mode });
    delete f.state.messages.at(-1).info.error;
    const results = await Promise.allSettled([
      f.controller.plugin(continuation()), f.controller.plugin(continuation({ userMessageID: 'msg_otherwake' })),
    ]);
    expect(results.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((entry) => entry.status === 'rejected')).toHaveLength(1);
    expect((await f.controller.readRecord(identity.sessionID)).anchorID).toBe('msg_user');
    expect((await f.controller.readRecord(identity.sessionID)).attemptCount).toBe(0);
  });

  test('tracks other providers for ownership without enabling transport recovery', async () => {
    const f = await fixture({ mode: 'off' }, 'xai');
    delete f.state.messages.at(-1).info.error;
    const input = continuation({ execution: { providerID: 'xai', modelID: 'gpt-5.6-sol', agent: 'orchestrator', variant: 'xhigh' } });
    await expect(f.controller.plugin(input)).resolves.toMatchObject({ allowed: true, anchorUserMessageID: 'msg_user' });
    expect((await f.snapshot()).enforced).toBe(false);
    await f.controller.admit({ sessionID: identity.sessionID, directory: '/project', primary: true,
      body: { messageID: 'msg_newuser', agent: 'orchestrator', model: { providerID: 'xai', modelID: 'gpt-5.6-sol' } } });
    await expect(f.controller.plugin({ action: 'message', ...identity, userMessageID: 'msg_wake' })).rejects.toThrow('fenced');
  });

  test('does not spend the repair budget on result delivery and cannot refill TODO limits', async () => {
    const f = await fixture({ mode: 'off' });
    delete f.state.messages.at(-1).info.error;
    for (let i = 0; i < 8; i++) {
      const id = `msg_collect${i}`;
      await f.controller.plugin(continuation({ userMessageID: id }));
      land(f, id);
    }
    expect((await f.controller.readRecord(identity.sessionID)).todoContinuationCount).toBe(0);
    for (let i = 0; i < 3; i++) {
      const id = `msg_todo${i}`;
      await f.controller.plugin(continuation({ userMessageID: id, kind: 'orchestrator_todo' }));
      land(f, id);
    }
    await expect(f.controller.plugin(continuation({ userMessageID: 'msg_capped', kind: 'orchestrator_todo' }))).rejects.toThrow('budget exhausted');
    expect((await f.controller.readRecord(identity.sessionID)).attemptCount).toBe(0);
    await f.controller.drain();
    const restarted = createPrimaryRecoveryController({ directory: f.directory, mode: 'off', isManaged: () => true,
      authorize: async () => true, observeTurn: async () => f.state, abortSession: async () => {}, promptSession: async () => {} });
    await restarted.initialize(); cleanups.push(() => restarted.drain());
    await restarted.plugin({ action: 'hello', instanceID: identity.instanceID, policyVersion: 1, version: '1.18.30' });
    await expect(restarted.plugin(continuation({ userMessageID: 'msg_restart', kind: 'orchestrator_todo' }))).rejects.toThrow('budget exhausted');
  });

  test('requires the registered objective, model and permissions, and respects user questions', async () => {
    const f = await fixture();
    delete f.state.messages.at(-1).info.error;
    await expect(f.controller.plugin(continuation({ instanceID: 'unknown' }))).rejects.toThrow('owner mismatch');
    await expect(f.controller.plugin(continuation({ anchorUserMessageID: 'msg_synthetic' }))).rejects.toThrow('objective mismatch');
    await expect(f.controller.plugin(continuation({ execution: { providerID: 'xai', modelID: 'different', agent: 'builder' } }))).rejects.toThrow('objective mismatch');
    f.state.blocked = true;
    f.state.blockedByRequests = true;
    f.state.managedBarrierState = 'awaiting_acknowledgement';
    await expect(f.controller.plugin(continuation())).rejects.toThrow('continuation blocked');
    f.state.blockedByRequests = false;
    await expect(f.controller.plugin(continuation())).resolves.toMatchObject({ allowed: true, tools: {} });
  });

  test.each([false, true])('preserves the objective and TODO budget across two native compactions (auto=%s)', async (auto) => {
    const f = await fixture({ mode: 'off' });
    delete f.state.messages.at(-1).info.error;
    await f.controller.plugin(continuation({ userMessageID: 'msg_todo', kind: 'orchestrator_todo' }));
    land(f, 'msg_todo');
    for (let i = 0; i < 2; i++) {
      f.state.messages.push({ info: { id: `msg_compact${i}`, role: 'user' }, parts: [{ type: 'compaction', auto }] },
        { info: { id: `msg_summary${i}`, role: 'assistant', parentID: `msg_compact${i}`, summary: true }, parts: [{ type: 'text', text: 'Derived summary' }] },
        { info: { id: `msg_native${i}`, role: 'user' }, parts: [{ type: 'text', synthetic: true, metadata: { compaction_continue: true }, text: 'Continue.' }] });
      await f.controller.plugin({ action: 'step', ...identity, userMessageID: `msg_native${i}`, assistantMessageID: `msg_step${i}` });
      f.state.messages.push({ info: { id: `msg_step${i}`, role: 'assistant', parentID: `msg_native${i}`, time: { completed: 10_000 } }, parts: [] });
      const record = await f.controller.readRecord(identity.sessionID);
      expect(record).toMatchObject({ anchorID: 'msg_user', activeUserID: `msg_native${i}`, todoContinuationCount: 1, attemptCount: 0 });
    }
    await expect(f.controller.plugin(continuation({ userMessageID: 'msg_nexttodo', kind: 'orchestrator_todo' }))).resolves.toMatchObject({ todoContinuationCount: 2 });
  });

  test('native compaction cannot restore writes during guarded recovery', async () => {
    const f = await fixture();
    await f.fail();
    f.state.messages.push({ info: { id: 'msg_recovery', role: 'user' }, parts: [] },
      { info: { id: 'msg_compact', role: 'user' }, parts: [{ type: 'compaction', auto: true }] },
      { info: { id: 'msg_native', role: 'user' }, parts: [{ type: 'text', synthetic: true, metadata: { compaction_continue: true }, text: 'Continue.' }] });
    await f.controller.plugin({ action: 'step', ...identity, userMessageID: 'msg_native', assistantMessageID: 'msg_step' });
    await expect(f.controller.plugin({ action: 'tool_before', ...identity, userMessageID: 'msg_native', tool: 'write', callID: 'call_unsafe' })).rejects.toThrow('requires user action');
    expect((await f.controller.readRecord(identity.sessionID)).attemptCount).toBe(1);
  });

  test('an arbitrary synthetic message cannot take ownership or refill a budget', async () => {
    const f = await fixture({ mode: 'off' });
    delete f.state.messages.at(-1).info.error;
    f.state.messages.push({ info: { id: 'msg_foreign', role: 'user' }, parts: [{ type: 'text', synthetic: true, text: 'Continue work.' }] });
    await expect(f.controller.plugin({ action: 'step', ...identity, userMessageID: 'msg_foreign' })).rejects.toThrow('fenced');
    expect((await f.controller.readRecord(identity.sessionID)).anchorID).toBe('msg_user');
  });
});

test.each(['openai', 'anthropic'])('rollback keeps accepted recovery read-only after restart (%s)', async (providerID) => {
  const f = await fixture({ isAnthropicConformant: () => true }, providerID); await f.fail(); await f.controller.drain();
  f.state.messages.push({ info: { id: 'msg_recovery', role: 'user' }, parts: [] },
    { info: { id: 'msg_recovered', role: 'assistant', parentID: 'msg_recovery', time: {} }, parts: [] });
  const restarted = createPrimaryRecoveryController({ directory: f.directory, mode: 'off', isManaged: () => true,
    observeTurn: async () => f.state, authorize: async () => true, abortSession: async () => {},
    promptSession: async () => { throw new Error('No second POST allowed'); } });
  await restarted.initialize(); cleanups.push(() => restarted.drain());
  await restarted.plugin({ action: 'hello', policyVersion: 1, instanceID: 'runtime-next', version: '1.18.25' });
  await restarted.reconcile();
  expect((await restarted.getSnapshot(identity.sessionID)).record.state).toBe('recovering');
  await expect(restarted.plugin({ action: 'tool_before', ...identity, instanceID: 'runtime-next', userMessageID: 'msg_recovery', tool: 'bash', callID: 'blocked' }))
    .rejects.toThrow('requires user action');
  expect((await restarted.getSnapshot(identity.sessionID)).record.attemptCount).toBe(1);
});

test.each(['openai', 'anthropic'])('read-only guard blocks mutation, browser, delegation, and unknown MCP (%s)', async (providerID) => {
  for (const tool of ['bash', 'write', 'edit', 'browser', 'devryan_task', 'mcp_unknown']) {
    const f = await fixture({ isAnthropicConformant: () => true }, providerID); await f.fail();
    await expect(f.controller.plugin({ action: 'tool_before', ...identity, userMessageID: 'msg_recovery', callID: 'call', tool }))
      .rejects.toThrow('recovery requires user action');
    expect((await f.snapshot()).record.attemptCount).toBe(1);
  }
});

test.each(['openai', 'anthropic'])('Stop fences stale events and plugin requests (%s)', async (providerID) => {
  const f = await fixture({ isAnthropicConformant: () => true }, providerID);
  await f.controller.control(identity.sessionID, 'stop'); await f.fail();
  await expect(f.controller.plugin({ action: 'step', ...identity })).rejects.toThrow('fenced');
  expect((await f.snapshot()).record.state).toBe('cancelled'); expect(f.sent).toHaveLength(0);
});

test.each(['openai', 'anthropic'])('ambiguous POST is never retried, including after restart (%s)', async (providerID) => {
  let posts = 0;
  const f = await fixture({ isAnthropicConformant: () => true, promptSession: async () => { posts++; throw new Error('ack lost'); } }, providerID);
  await f.fail(); await f.controller.reconcile(); await f.controller.drain();
  const restarted = createPrimaryRecoveryController({ directory: f.directory, mode: 'enforce', isManaged: () => true,
    observeTurn: async () => f.state, authorize: async () => true, promptSession: async () => { posts++; } });
  await restarted.initialize(); cleanups.push(() => restarted.drain());
  await restarted.plugin({ action: 'hello', policyVersion: 1, instanceID: 'runtime-next', version: '1.18.25' });
  await restarted.reconcile();
  expect(posts).toBe(1);
  expect((await restarted.getSnapshot(identity.sessionID)).record.attemptCount).toBe(1);
});

test('one fenced controller owns a data directory', async () => {
  const f = await fixture();
  const other = createPrimaryRecoveryController({ directory: f.directory, mode: 'enforce', isManaged: () => true });
  await other.initialize(); cleanups.push(() => other.drain());
  await expect(other.plugin({ action: 'hello', policyVersion: 1, instanceID: 'other', version: '1.18.25' })).rejects.toThrow('owner unavailable');
});

test('failed observation and revoked authorization fail closed', async () => {
  const f = await fixture({ authorize: async () => false });
  await f.fail(); expect(f.sent).toHaveLength(0);
  expect((await f.snapshot()).record.reason).toBe('recovery_authorization_unavailable');
  const g = await fixture({ observeTurn: async () => { throw new Error('offline'); } });
  await g.fail(); expect(g.sent).toHaveLength(0);
  expect((await g.snapshot()).record.reason).toBe('recovery_observation_unavailable');
});

test('explicit provider change supersedes an undispatched OpenAI recovery', async () => {
  const f = await fixture();
  await f.controller.admit({ sessionID: identity.sessionID, directory: '/project', primary: true,
    body: { messageID: 'msg_newuser', agent: 'orchestrator', model: { providerID: 'anthropic', modelID: 'other' } } });
  await expect(f.fail()).rejects.toThrow('fenced');
  await f.controller.observe({ type: 'session.error', properties: { sessionID: identity.sessionID, error: timeout } });
  expect(f.sent).toHaveLength(0);
  expect((await f.snapshot()).enforced).toBe(false);
});

test('corrupt persisted tool permissions cannot weaken the guard after restart', async () => {
  const f = await fixture(); await f.fail(); await f.controller.drain();
  const filename = (await fs.readdir(f.directory)).find((name) => name.endsWith('.json'));
  const recordPath = path.join(f.directory, filename);
  const envelope = JSON.parse(await fs.readFile(recordPath, 'utf8'));
  envelope.record.allowedReadTools = ['bash'];
  await fs.writeFile(recordPath, JSON.stringify(envelope));
  const restarted = createPrimaryRecoveryController({ directory: f.directory, isManaged: () => true });
  await restarted.initialize(); cleanups.push(() => restarted.drain());
  await expect(restarted.plugin({ action: 'hello', instanceID: 'new', version: '1.18.25', policyVersion: 1 })).rejects.toThrow('storage unavailable');
});

const upstreamTimeout = { name: 'UnknownError', data: { message: '{"type":"upstream_timeout","message":"Upstream stalled: no data for 208771ms"}' } };

async function claudeFixture(overrides = {}) {
  const f = await fixture({ isAnthropicConformant: () => true, ...overrides }, 'anthropic');
  f.state.messages.at(-1).info.error = upstreamTimeout;
  await f.controller.plugin({ action: 'step', ...identity });
  f.finalize = () => f.controller.observe({ type: 'message.updated', properties: { info: structuredClone(f.state.messages.at(-1).info), sessionID: identity.sessionID } });
  return f;
}

test('Claude exact envelope requires a verified runtime and excludes ambiguous errors', () => {
  expect(classifyPrimaryTransportError(upstreamTimeout, '1.18.29')).toEqual({ kind: 'chunk_timeout', source: 'upstream_timeout_envelope' });
  for (const message of ['upstream_timeout', '{"type":"upstream_timeout"}', '{"type":"upstream_timeout","message":"request timeout"}', '{"type":"upstream_timeout","message":"Upstream stalled: no data for 208771ms"', '{"type":"upstream_timeout","message":"Upstream stalled: no data for 208771ms auth failed"}']) {
    expect(classifyPrimaryTransportError({ name: 'UnknownError', data: { message } }, '1.18.29')).toBeNull();
  }
  expect(classifyPrimaryTransportError(upstreamTimeout, '1.18.31')).toEqual({ kind: 'chunk_timeout', source: 'upstream_timeout_envelope' });
  expect(classifyPrimaryTransportError(upstreamTimeout, '1.18.32')).toEqual({ kind: 'chunk_timeout', source: 'upstream_timeout_envelope' });
  expect(classifyPrimaryTransportError(upstreamTimeout, '1.18.33')).toEqual({ kind: 'chunk_timeout', source: 'upstream_timeout_envelope' });
  expect(classifyPrimaryTransportError(upstreamTimeout, '1.18.34')).toBeNull();
  expect(classifyPrimaryTransportError({ ...upstreamTimeout, statusCode: 401 }, '1.18.29')).toBeNull();
});

test('Claude message-only terminal error recovers once with the original selection and tool guards', async () => {
  const f = await claudeFixture();
  await Promise.all([f.finalize(), f.finalize()]);
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]).toMatchObject({ model: { providerID: 'anthropic', modelID: 'claude-opus-5' }, variant: 'xhigh', tools: { '*': false, read: true } });
  await expect(f.controller.plugin({ action: 'tool_before', ...identity, userMessageID: 'msg_recovery', tool: 'edit', callID: 'edit_call' })).rejects.toThrow('requires user action');
  expect((await f.snapshot()).record.state).toBe('needs_attention');
});

test.each(['pending', 'error', 'running'])('Claude never replays an edit with %s outcome', async (status) => {
  const f = await claudeFixture();
  f.state.messages.at(-1).parts.push({ type: 'tool', tool: 'edit', callID: 'incident_edit', state: { status } });
  await f.finalize();
  expect(f.sent).toHaveLength(0);
  expect((await f.snapshot()).record.reason).toBe('recovery_tool_outcome_unknown');
});

test('Claude conformance cannot be bypassed by enforce mode', async () => {
  const f = await claudeFixture({ anthropicMode: 'enforce', isAnthropicConformant: undefined });
  await f.finalize();
  expect(f.sent).toHaveLength(0);
  expect(await f.snapshot()).toMatchObject({ mode: 'enforce', supported: false, enforced: false });
});

test.each([
  [undefined, undefined, 'enforce', 1], ['observe', undefined, 'observe', 0],
  ['enforce', 'off', 'off', 0], ['off', 'enforce', 'enforce', 1],
])('Claude mode precedence global=%s provider=%s', async (mode, anthropicMode, expectedMode, attempts) => {
  const f = await claudeFixture({ mode, anthropicMode });
  await f.finalize();
  expect((await f.snapshot()).mode).toBe(expectedMode);
  expect(f.sent).toHaveLength(attempts);
});

test('Claude ignores a stale assistant finalization and respects Stop', async () => {
  const f = await claudeFixture();
  await f.controller.observe({ type: 'message.updated', properties: { sessionID: identity.sessionID,
    info: { ...f.state.messages.at(-1).info, id: 'msg_stale', parentID: 'msg_old' } } });
  expect(f.sent).toHaveLength(0);
  await f.controller.control(identity.sessionID, 'stop');
  await f.finalize();
  expect(f.sent).toHaveLength(0);
});


test('terminal message arriving during an idle observation is not lost', async () => {
  let release;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  let first = true;
  let f;
  f = await claudeFixture({ observeTurn: async () => {
    if (!first) return structuredClone(f.state);
    first = false;
    const old = structuredClone(f.state);
    delete old.messages.at(-1).info.error;
    delete old.messages.at(-1).info.time.completed;
    entered();
    await new Promise((resolve) => { release = resolve; });
    return old;
  } });
  const idle = f.controller.observe({ type: 'session.status', properties: { sessionID: identity.sessionID, status: { type: 'idle' } } });
  await started;
  const final = f.finalize();
  release();
  await Promise.all([idle, final]);
  expect(f.sent).toHaveLength(1);
});

test('Claude repeated timeout consumes no second attempt', async () => {
  const f = await claudeFixture();
  await f.finalize();
  f.state.messages.push({ info: { role: 'user', id: 'msg_recovery' }, parts: [] },
    { info: { role: 'assistant', id: 'msg_retry', parentID: 'msg_recovery', time: { completed: 10001 }, error: upstreamTimeout }, parts: [] });
  await f.controller.plugin({ action: 'step', ...identity, userMessageID: 'msg_recovery', assistantMessageID: 'msg_retry' });
  await f.finalize();
  expect(f.sent).toHaveLength(1);
  expect((await f.snapshot()).record).toMatchObject({ state: 'needs_attention', reason: 'recovery_failed', attemptCount: 1 });
});

test.each(['question', 'permission', 'barrier', 'intent'])('Claude %s blocks automatic dispatch', async (blocker) => {
  const f = await claudeFixture();
  if (blocker === 'intent') await f.controller.control(identity.sessionID, 'intent');
  else if (blocker === 'barrier') f.state.blocked = true;
  else f.controller.observe({ type: `${blocker}.asked`, properties: { sessionID: identity.sessionID, id: 'pending_request' } });
  await f.finalize();
  expect(f.sent).toHaveLength(0);
});


test('a failed observation of the previous turn cannot poison newly admitted input', async () => {
  let entered; let release;
  const started = new Promise((resolve) => { entered = resolve; });
  const f = await claudeFixture({ observeTurn: async () => {
    entered(); await new Promise((resolve) => { release = resolve; }); throw new Error('old observation failed');
  } });
  const old = f.finalize();
  await started;
  await f.controller.admit({ sessionID: identity.sessionID, directory: '/project', primary: true,
    body: { messageID: 'msg_new', agent: 'orchestrator', model: { providerID: 'anthropic', modelID: 'claude-opus-5' } } });
  release(); await old;
  expect((await f.snapshot()).record).toMatchObject({ anchorID: 'msg_new', state: 'observing', reason: null, attemptCount: 0 });
  expect(f.incidents.find((event) => event.event === 'provider_recovery_observation_failed')?.messageID).toBe('msg_user');
  expect(f.sent).toHaveLength(0);
});


test('a queued watchdog from an old turn cannot stop a fresh provider step', async () => {
  let entered; let release; let first = true; let f;
  const started = new Promise((resolve) => { entered = resolve; });
  f = await claudeFixture({ observeTurn: async () => {
    const observation = structuredClone(f.state);
    if (first) { first = false; entered(); await new Promise((resolve) => { release = resolve; }); }
    return observation;
  } });
  const old = f.finalize(); await started;
  f.advance(300001);
  const watchdog = f.controller.reconcile();
  await f.controller.admit({ sessionID: identity.sessionID, directory: '/project', primary: true,
    body: { messageID: 'msg_new', agent: 'orchestrator', model: { providerID: 'anthropic', modelID: 'claude-opus-5' } } });
  f.state.messages = [{ info: { id: 'msg_new', role: 'user' }, parts: [{ type: 'text', text: 'New input' }] },
    { info: { id: 'msg_newassistant', role: 'assistant', parentID: 'msg_new', time: {} }, parts: [] }];
  f.state.status = 'busy';
  await f.controller.plugin({ action: 'step', ...identity, userMessageID: 'msg_new', assistantMessageID: 'msg_newassistant' });
  release(); await Promise.all([old, watchdog]);
  expect(f.aborted).toHaveLength(0); expect(f.sent).toHaveLength(0);
  expect((await f.snapshot()).record).toMatchObject({ anchorID: 'msg_new', state: 'observing', reason: null });
});

test('unsupported provider failure is projected for reconnect without enabling replay', async () => {
  const f = await fixture({ mode: 'observe' }, 'xai');
  await f.fail();
  const snapshot = await f.snapshot();
  expect(snapshot.supported).toBe(false);
  expect(snapshot.enforced).toBe(false);
  expect(snapshot.record.failureObserved).toBe(true);
  expect(f.sent).toHaveLength(0);
  await f.controller.admit({ sessionID: identity.sessionID, directory: '/project', primary: true,
    body: { messageID: 'msg_new', agent: 'orchestrator', model: { providerID: 'xai', modelID: 'grok-4.6' } } });
  expect((await f.snapshot()).record.failureObserved).toBe(false);
});

test('a replaced runtime sweeps stored objectives once, retires only deleted sessions, and summarizes', async () => {
  let observations = 0;
  let failure = null;
  // Observe mode: an unobservable record is never escalated and used to stay
  // 'observing' forever, re-swept on every start.
  const f = await fixture({ mode: 'observe', observeTurn: async () => {
    observations += 1;
    if (failure) throw Object.assign(new Error('unavailable'), { code: 'recovery_observation_unavailable', upstreamStatus: failure,
      ...(failure === 404 ? { sessionMissing: true } : {}) });
    return { session: { id: identity.sessionID, directory: '/project' }, complete: true, status: 'busy', blocked: false, messages: [] };
  } });
  await f.controller.plugin({ action: 'step', ...identity });
  f.advance(1_000);
  const hello = (instanceID) => f.controller.plugin({ action: 'hello', instanceID, policyVersion: 1, version: '1.18.25' });
  // A busy runtime at startup is transient: the objective survives.
  failure = 503;
  await hello('runtime-busy');
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect((await f.snapshot()).record.state).toBe('observing');
  failure = 404;
  f.advance(1_000);
  await hello('runtime-next');
  await new Promise((resolve) => setTimeout(resolve, 50));
  const retired = (await f.snapshot()).record;
  expect(retired).toMatchObject({ state: 'superseded', reason: 'recovery_runtime_replaced' });
  const summaries = f.incidents.filter((entry) => entry.event === 'provider_recovery_sweep_summary');
  expect(summaries).toHaveLength(2);
  expect(summaries[0]).toMatchObject({ failed: 1, retired: 0 });
  expect(summaries[1]).toMatchObject({ failed: 1, retired: 1 });
  expect(f.incidents.some((entry) => entry.event === 'provider_recovery_observation_failed')).toBe(false);
  const seen = observations;
  await hello('runtime-next');
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(observations).toBe(seen);
});

describe('polling a record this runtime cannot act on', () => {
  const observed = (overrides = {}) => {
    const reads = { count: 0 };
    return { reads, options: { observeTurn: async () => { reads.count += 1; throw Object.assign(new Error('recovery observation timeout'), { code: 'recovery_observation_timeout' }); }, ...overrides } };
  };
  const stalledStep = async (f) => {
    f.state.status = 'busy'; delete f.state.messages.at(-1).info.error;
    await f.controller.plugin({ action: 'step', ...identity });
    f.advance(600_000);
  };

  test('an observe-only record is never read for a progress cutoff', async () => {
    const { reads, options } = observed({ mode: 'observe' });
    const f = await fixture(options);
    await stalledStep(f);
    for (let i = 0; i < 5; i++) { f.advance(1_000); await f.controller.reconcile(); }
    expect(reads.count).toBe(0);
    expect(f.incidents.filter((entry) => entry.event === 'provider_recovery_observation_failed')).toHaveLength(0);
    expect(f.aborted).toHaveLength(0);
  });

  test('a runtime outside the allow-list is never read for a progress cutoff', async () => {
    const { reads, options } = observed();
    const f = await fixture(options);
    await f.controller.plugin({ action: 'hello', instanceID: identity.instanceID, policyVersion: 1, version: '1.18.99' });
    await stalledStep(f);
    for (let i = 0; i < 5; i++) { f.advance(1_000); await f.controller.reconcile(); }
    expect(reads.count).toBe(0);
  });

  test('the kill switch restores a read on every poll', async () => {
    const { reads, options } = observed({ mode: 'observe', advisory: false });
    const f = await fixture(options);
    await stalledStep(f);
    for (let i = 0; i < 3; i++) { f.advance(1_000); await f.controller.reconcile(); }
    expect(reads.count).toBe(3);
  });

  test('a failed observation does not disable recovery until the next restart', async () => {
    let failing = true;
    const f = await fixture({ observeTurn: async () => { if (failing) throw Object.assign(new Error('timeout'), { code: 'recovery_observation_timeout' }); return structuredClone(f.state); },
      authorize: async () => { throw new Error('ownership store unavailable'); } });
    await f.fail();
    failing = false;
    // The plugin still answers: storage was never the problem.
    await expect(f.controller.plugin({ action: 'scope', ...identity })).resolves.toMatchObject({ tracked: true });
  });

  test('an unfinished recovery is polled with a backoff while it does not change', async () => {
    const holder = { reads: 0, fixture: null };
    const f = holder.fixture = await fixture({ observeTurn: async () => { holder.reads += 1; return structuredClone(holder.fixture.state); } });
    await f.fail();
    expect((await f.snapshot()).record.state).toBe('recovering');
    // The recovery turn was accepted and is still running.
    f.state.messages.push({ info: { id: 'msg_recovery', role: 'user' }, parts: [{ type: 'text', text: 'Continue' }] });
    f.state.status = 'busy';
    const before = holder.reads;
    for (let second = 0; second < 12; second++) { f.advance(1_000); await f.controller.reconcile(); }
    // Due at once, then 5 s later; the third read is due 10 s after that.
    expect(holder.reads - before).toBe(2);
    expect((await f.snapshot()).record.state).toBe('recovering');

    // Its events still settle it at once.
    f.state.messages.push({ info: { id: 'msg_recovered', role: 'assistant', parentID: 'msg_recovery', time: { completed: 1 } }, parts: [{ type: 'text', text: 'Done' }] });
    f.state.status = 'idle';
    await f.controller.observe({ type: 'session.status', properties: { sessionID: identity.sessionID, status: { type: 'idle' } } });
    expect((await f.snapshot()).record.state).toBe('completed');
  });
});

test('native frozen provider default survives automatic read-only recovery dispatch', async () => {
  const f = await fixture();
  await f.controller.admit({ sessionID: identity.sessionID, directory: '/project', primary: true, executionGeneration: 2,
    body: { messageID: 'msg_default', agent: 'orchestrator', model: { providerID: 'openai', modelID: 'gpt-5.6-sol' }, variant: 'default' } });
  f.state.messages[0].info.id = 'msg_default';
  f.state.messages[1].info.parentID = 'msg_default';
  await f.controller.plugin({ action: 'step', ...identity, userMessageID: 'msg_default',
    execution: { providerID: 'openai', modelID: 'gpt-5.6-sol', agent: 'orchestrator', variant: 'default' } });
  await f.fail();
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0].variant).toBe('default');
  expect(await f.controller.readRecord(identity.sessionID)).toMatchObject({ variant: 'default', executionGeneration: 2 });
});


describe('durable native TODO continuation dispatch', () => {
  const scope = {sessionID:identity.sessionID,directory:'/project',messageID:'msg_todo',instanceID:identity.instanceID};
  const input = {...identity,directory:'/project',anchorUserMessageID:'msg_user',userMessageID:scope.messageID,kind:'orchestrator_todo',
    execution:{providerID:'openai',modelID:'gpt-5.6-sol',agent:'orchestrator',variant:'xhigh'}};
  const prompt = {messageID:scope.messageID,agent:'orchestrator',model:{providerID:'openai',modelID:'gpt-5.6-sol'},variant:'xhigh',
    tools:{},objectiveID:'msg_user',parts:[{type:'text',synthetic:true,text:'[devryan-open-todo-continuation:v1] Continue the open task.'}]};
  const native = async overrides => {
    const f=await fixture(overrides,'openai','orchestrator',2);
    await f.controller.plugin({action:'hello',instanceID:identity.instanceID,policyVersion:1,version:'2.0.20',transport:'native-v2'});
    f.state.messages[0].info.sessionID=identity.sessionID;
    Object.assign(f.state.messages[1].info,{sessionID:identity.sessionID,error:undefined,agent:'orchestrator',providerID:'openai',modelID:'gpt-5.6-sol',variant:'xhigh'});
    f.state.messages[1].turnOwnership={source:'native-sequence',userMessageID:'msg_user'};
    await f.controller.plugin({action:'step',...identity});
    const actual={...prompt,tools:(await f.controller.readRecord(identity.sessionID)).tools};
    return {...f,prompt:actual,reserve:()=>f.controller.reserveNativeContinuation(input,actual)};
  };
  test('retains the same durable ID and budget through lost delivery ACK, then clears only on the actual step',async()=>{
    const f=await native(); await f.reserve();
    const first=await f.controller.captureNativeContinuationDispatch(scope);
    await first.recheck();
    expect(await f.controller.pendingNativeContinuations({directory:'/project'})).toEqual([{sessionID:identity.sessionID,directory:'/project',messageID:'msg_todo'}]);
    await expect(f.reserve()).rejects.toMatchObject({code:'native_primary_continuation_invalid'});
    expect((await f.controller.captureNativeContinuationDispatch(scope)).prompt).toEqual(first.prompt);
    expect((await f.controller.readRecord(identity.sessionID)).todoContinuationCount).toBe(1);
    f.state.messages.push({info:{id:'msg_todo',sessionID:identity.sessionID,role:'user'},parts:f.prompt.parts},
      {info:{id:'msg_next',sessionID:identity.sessionID,role:'assistant',parentID:'msg_todo',time:{}},parts:[],
        turnOwnership:{source:'native-sequence',userMessageID:'msg_todo'}});
    await f.controller.plugin({action:'step',...identity,userMessageID:'msg_todo',assistantMessageID:'msg_next'});
    expect((await f.controller.readRecord(identity.sessionID)).nativeContinuation).toBeUndefined();
    await first.recheck();
    expect(await f.controller.pendingNativeContinuations({directory:'/project'})).toEqual([]);
  });
  test('refuses forged scope, replaced selection, missing native ownership, and old controller closures',async()=>{
    const f=await native(); await f.reserve();
    await expect(f.controller.captureNativeContinuationDispatch({...scope,messageID:'msg_forged'})).rejects.toMatchObject({code:'native_primary_continuation_invalid'});
    f.state.messages[1].turnOwnership.source='display';
    await expect(f.controller.captureNativeContinuationDispatch(scope)).rejects.toMatchObject({code:'native_primary_continuation_fenced'});
    f.state.messages[1].turnOwnership.source='native-sequence';
    const captured=await f.controller.captureNativeContinuationDispatch(scope);
    await f.controller.plugin({action:'hello',instanceID:'replacement',policyVersion:1,version:'2.0.20',transport:'native-v2'});
    await expect(captured.recheck()).rejects.toMatchObject({code:'native_primary_continuation_fenced'});
    await expect(f.controller.captureNativeContinuationDispatch({...scope,instanceID:'replacement'})).resolves.toMatchObject({prompt:f.prompt});
    await f.controller.admit({sessionID:identity.sessionID,directory:'/project',primary:true,executionGeneration:2,
      body:{messageID:'msg_new',agent:'orchestrator',model:{providerID:'openai',modelID:'different'},variant:'xhigh'}});
    await expect(captured.recheck()).rejects.toMatchObject({code:'native_primary_continuation_fenced'});
  });
  test('recovers the persisted reservation through a new owner without minting another message',async()=>{
    const f=await native();await f.reserve();const before=await f.controller.readRecord(identity.sessionID);
    await f.controller.drain();
    const replacement=createPrimaryRecoveryController({directory:f.directory,mode:'enforce',isManaged:()=>true,pollMs:1_000_000,
      authorize:async()=>true,observeTurn:async()=>structuredClone(f.state),abortSession:async()=>{},promptSession:async()=>{throw Error('unowned replay');}});
    await replacement.initialize();cleanups.push(()=>replacement.drain());
    await replacement.plugin({action:'hello',instanceID:'replacement',policyVersion:1,version:'2.0.20',transport:'native-v2'});
    const captured=await replacement.captureNativeContinuationDispatch({...scope,instanceID:'replacement'});
    expect(captured.prompt).toEqual(before.nativeContinuation.prompt);
    expect((await replacement.readRecord(identity.sessionID)).todoContinuationCount).toBe(1);
    await captured.recheck();
  });
  test('does not accept a payload-native marker or a changed source at the durable reservation boundary',async()=>{
    const f=await native();
    await expect(f.controller.plugin({...input,action:'continuation',nativePrompt:f.prompt})).rejects.toMatchObject({code:'managed_continuation_fenced',fenceReason:'runtime_unsupported'});
    f.state.messages[1].turnOwnership.source='display';
    await expect(f.reserve()).rejects.toMatchObject({code:'managed_continuation_fenced',fenceReason:'native_source_changed'});
    expect((await f.controller.readRecord(identity.sessionID)).nativeContinuation).toBeUndefined();
    expect((await f.controller.readRecord(identity.sessionID)).todoContinuationCount??0).toBe(0);
  });
  test('rechecks original authorization after awaited canonical observation without spending a second reservation',async()=>{
    let allowed=true, revokeOnRead=false;
    const f=await native({authorize:async()=>allowed,observeTurn:async()=>{if(revokeOnRead)allowed=false;return structuredClone(f.state);}});
    await f.reserve(); const captured=await f.controller.captureNativeContinuationDispatch(scope);
    revokeOnRead=true;
    await expect(captured.recheck()).rejects.toMatchObject({code:'native_primary_continuation_fenced'});
    expect((await f.controller.readRecord(identity.sessionID)).nativeContinuation.messageID).toBe('msg_todo');
    expect((await f.controller.readRecord(identity.sessionID)).todoContinuationCount).toBe(1);
  });
});

describe('constructor-owned native fallback shares the primary recovery budget',()=>{
 const execution={providerID:'openai',modelID:'gpt-5.6-sol',agent:'orchestrator',variant:'xhigh'};
 const fallback={providerID:'saved',modelID:'fallback',agent:'orchestrator',variant:'high'};
 const request={...identity,currentExecution:execution};
 const eligible=error=>error?.statusCode===429;
 const choice=async()=>({tried:['openai/gpt-5.6-sol'],exhaustion:0,execution:fallback});
 const native=async overrides=>{const f=await fixture({isNativeFallbackError:eligible,getToolPolicy:async()=>({toolIDs:['read','glob','grep','shell'],allowedReadTools:['read','glob','grep']}),...overrides},'openai','orchestrator',2);
  f.state.messages.at(-1).info.error={statusCode:429};await f.controller.plugin({action:'hello',policyVersion:1,instanceID:identity.instanceID,version:'2.0.20'});
  await f.controller.plugin({action:'step',...identity,execution});return f;};
 test('freezes original selection, settles failure, dispatches exact fallback once and accepts only its recovery step',async()=>{
  const f=await native();const before=await f.controller.readRecord(identity.sessionID);
  const reserved=await f.controller.reserveNativeFallback(request,{authorize:async()=>{},choose:choice});expect(reserved.reserved).toBe(true);expect(f.sent).toHaveLength(0);
  await f.controller.observe({type:'session.error',properties:{sessionID:identity.sessionID}});
  const record=await f.controller.readRecord(identity.sessionID);expect(record).toMatchObject({...execution,anchorID:before.anchorID,owner:before.owner,tools:before.tools,attemptCount:1,recoveryExecution:fallback});
  expect(f.sent).toEqual([{messageID:'msg_recovery',model:{providerID:'saved',modelID:'fallback'},agent:'orchestrator',variant:'high',parts:[{type:'text',text:'Original request'}],tools:{read:true,glob:true,grep:true,shell:false,'*':false}}]);
  await expect(f.controller.reserveNativeFallback(request,{authorize:async()=>{},choose:choice})).rejects.toMatchObject({code:'native_fallback_fenced'});
  await f.controller.plugin({action:'step',...identity,userMessageID:'msg_recovery',assistantMessageID:'msg_fallback',execution:fallback});
  await expect(f.controller.plugin({action:'step',...identity,userMessageID:'msg_recovery',assistantMessageID:'msg_fallback',execution})).rejects.toMatchObject({code:'recovery_execution_changed'});
 });
 test('polls during the owned pre-accept dispatch coalesce without classifying uncertainty before ACK',async()=>{
  const entered=Promise.withResolvers(),gate=Promise.withResolvers();let queries=0;
  const f=await native({promptSession:async()=>{entered.resolve();await gate.promise;},isNativeRecoveryDispatchPending:async()=>{queries++;return true;}});
  await f.controller.reserveNativeFallback(request,{authorize:async()=>{},choose:choice});
  const dispatch=f.controller.observe({type:'session.error',properties:{sessionID:identity.sessionID}});await entered.promise;
  const poll=f.controller.observe({type:'session.status',properties:{sessionID:identity.sessionID,status:{type:'idle'}}});
  expect((await f.controller.readRecord(identity.sessionID)).state).toBe('recovery_reserved');expect(queries).toBe(0);
  gate.resolve();await Promise.all([dispatch,poll]);expect(queries).toBe(1);expect((await f.controller.readRecord(identity.sessionID)).state).toBe('recovering');
 });
 test('native dispatch ACK before canonical promotion defers uncertainty only for its current live proof',async()=>{
  let valid=true;const calls=[];const f=await native({isNativeRecoveryDispatchPending:async(record,liveDispatch)=>{calls.push({liveDispatch:Boolean(liveDispatch),id:record.recoveryID});return Boolean(liveDispatch)&&valid;}});
  await f.controller.reserveNativeFallback(request,{authorize:async()=>{},choose:choice});await f.controller.observe({type:'session.error',properties:{sessionID:identity.sessionID}});
  await f.controller.observe({type:'session.status',properties:{sessionID:identity.sessionID,status:{type:'idle'}}});
  expect(calls.at(-1)).toEqual({liveDispatch:true,id:'msg_recovery'});expect((await f.controller.readRecord(identity.sessionID)).state).toBe('recovering');expect(f.sent).toHaveLength(1);
  valid=false;await f.controller.observe({type:'session.status',properties:{sessionID:identity.sessionID,status:{type:'idle'}}});
  expect(await f.controller.readRecord(identity.sessionID)).toMatchObject({state:'needs_attention',reason:'recovery_dispatch_uncertain'});expect(f.sent).toHaveLength(1);
 });
 test('a replaced hello clears live dispatch status proof and Stop cannot be reopened by a pending observation',async()=>{
  const f=await native({isNativeRecoveryDispatchPending:async(_record,liveDispatch)=>Boolean(liveDispatch)});
  await f.controller.reserveNativeFallback(request,{authorize:async()=>{},choose:choice});await f.controller.observe({type:'session.error',properties:{sessionID:identity.sessionID}});
  await f.controller.plugin({action:'hello',policyVersion:1,instanceID:'replacement',version:'2.0.20'});
  await f.controller.observe({type:'session.status',properties:{sessionID:identity.sessionID,status:{type:'idle'}}});
  expect(await f.controller.readRecord(identity.sessionID)).toMatchObject({state:'needs_attention',reason:'recovery_dispatch_uncertain'});
  await f.controller.control(identity.sessionID,'stop');await f.controller.observe({type:'session.status',properties:{sessionID:identity.sessionID,status:{type:'idle'}}});
  expect((await f.controller.readRecord(identity.sessionID)).state).toBe('cancelled');expect(f.sent).toHaveLength(1);
 });
 test('waits for true failed-step settlement and Stop fences outstanding selector before persistence',async()=>{
  let enter,release;const started=new Promise(resolve=>enter=resolve),gate=new Promise(resolve=>release=resolve);
  const f=await native();f.state.status='busy';delete f.state.messages.at(-1).info.time.completed;
  const pending=f.controller.reserveNativeFallback(request,{authorize:async()=>{},choose:async()=>{enter();await gate;return choice();}});await started;
  const stopped=f.controller.control(identity.sessionID,'stop');release();await expect(pending).rejects.toMatchObject({code:'native_fallback_fenced'});await stopped;
  expect(await f.controller.readRecord(identity.sessionID)).toMatchObject({state:'cancelled',attemptCount:0});expect(f.sent).toHaveLength(0);
 });
 test('refuses changed current step, rejected grant, exhausted chain and unclassified canonical failure',async()=>{
  const f=await native();await expect(f.controller.reserveNativeFallback({...request,assistantMessageID:'msg_foreign'},{authorize:async()=>{},choose:choice})).rejects.toMatchObject({code:'native_fallback_fenced'});
  await expect(f.controller.reserveNativeFallback(request,{authorize:async()=>{throw new Error('revoked');},choose:choice})).rejects.toThrow('revoked');expect((await f.controller.readRecord(identity.sessionID)).nativeFallback).toBeUndefined();
  const exhausted=await f.controller.reserveNativeFallback(request,{authorize:async()=>{},choose:async()=>({tried:['saved/fallback'],exhaustion:2})});expect(exhausted).toMatchObject({reserved:false,record:{state:'needs_attention',reason:'native_fallback_exhausted',attemptCount:0}});expect(f.sent).toHaveLength(0);
  const other=await native();await other.controller.reserveNativeFallback(request,{authorize:async()=>{},choose:choice});other.state.messages.at(-1).info.error={message:'invalid request shape'};await other.controller.observe({type:'session.error',properties:{sessionID:identity.sessionID}});expect(other.sent).toHaveLength(0);
 });
 test('canonical step replacement before reconciliation cannot consume a reserved choice',async()=>{
  const f=await native();await f.controller.reserveNativeFallback(request,{authorize:async()=>{},choose:choice});f.state.messages.push({info:{id:'msg_newstep',role:'assistant',parentID:'msg_user',error:{statusCode:429},time:{completed:10001}},parts:[]});await f.controller.observe({type:'session.error',properties:{sessionID:identity.sessionID}});expect(f.sent).toHaveLength(0);expect((await f.controller.readRecord(identity.sessionID)).attemptCount).toBe(0);
 });
});

describe('startup recovered input owner CAS',()=>{
 test('dedicated same-ID adoption retains original tools and fails stale owner/revision without dispatch',async()=>{
  const f=await fixture({mode:'observe'},'openai','orchestrator',2),r=await f.controller.readRecord(identity.sessionID);
  const input={sessionID:identity.sessionID,messageID:r.anchorID,payloadHash:'a'.repeat(64),recordRevision:r.revision,cancellationGeneration:r.cancellationGeneration,
    previousOwner:r.owner,owner:'fresh-principal',instanceID:identity.instanceID,enqueuedSeq:1,delivery:'queue'};
  await expect(f.controller.adoptRecoveredInput({...input,recordRevision:r.revision-1},async()=>{})).rejects.toMatchObject({code:'recovery_revision_conflict'});
  await expect(f.controller.adoptRecoveredInput({...input,previousOwner:'foreign'},async()=>{})).rejects.toMatchObject({code:'recovery_revision_conflict'});
  const adopted=await f.controller.adoptRecoveredInput(input,async()=>{});expect(adopted).toMatchObject({anchorID:r.anchorID,owner:'fresh-principal',tools:r.tools,attemptCount:0,recoveredInput:{inputID:r.anchorID,payloadHash:input.payloadHash,phase:'adopted'}});expect(f.sent).toHaveLength(0);
 });
 test('fallback discard evidence survives a later ordinary admission retaining guarded references',async()=>{
  const f=await fixture({},'openai','orchestrator',2);await f.fail();const r=await f.controller.readRecord(identity.sessionID);expect(r.recoveryID).toBe('msg_recovery');
  const scope={sessionID:identity.sessionID,messageID:r.recoveryID,payloadHash:'a'.repeat(64),enqueuedSeq:10,type:'user',delivery:'queue',recordRevision:r.revision,cancellationGeneration:r.cancellationGeneration,previousOwner:r.owner};
  const requested=await f.controller.requestRecoveredInputDiscard(scope,async()=>{});expect(requested.recoveredInputDispositions[0].phase).toBe('requested');
  const retry=await f.controller.requestRecoveredInputDiscard({...scope,recordRevision:requested.revision},async()=>{});expect(retry.revision).toBe(requested.revision);
  await f.controller.settleRecoveredInputDiscard({...scope,eventID:'evt_exactCancel',eventSeq:11},async()=>{});
  await f.controller.admit({sessionID:identity.sessionID,directory:'/project',primary:true,executionGeneration:2,body:{messageID:'msg_newPrimary',agent:r.agent,model:{providerID:r.providerID,modelID:r.modelID},variant:r.variant}});
  const next=await f.controller.readRecord(identity.sessionID);expect(next.anchorID).toBe('msg_newPrimary');expect(next.guardedIDs).toContain(r.recoveryID);expect(next.recoveredInputDispositions).toEqual([{inputID:r.recoveryID,payloadHash:scope.payloadHash,enqueuedSeq:10,type:'user',delivery:'queue',phase:'cancelled',eventID:'evt_exactCancel',eventSeq:11}]);
 });
});

describe('native fallback before lazy canonical Step.Started',()=>{
 const execution={providerID:'openai',modelID:'gpt-5.6-sol',agent:'orchestrator',variant:'xhigh'};
 const attempt={traceID:'a'.repeat(32),spanID:'b'.repeat(16)},permitSha256='c'.repeat(64);
 const fallback={providerID:'saved',modelID:'backup',agent:'orchestrator',variant:'default'};
 const choice=async()=>({tried:['openai/gpt-5.6-sol'],exhaustion:0,execution:fallback});
 const setup=async(overrides={})=>{const f=await fixture({mode:'observe',isNativeFallbackError:error=>error?.statusCode===429,...overrides},'openai','orchestrator',2);
  f.state.messages.splice(1);f.state.status='busy';await f.controller.plugin({action:'hello',policyVersion:1,instanceID:identity.instanceID,version:'2.0.20'});return f;};
 const request=previousStepID=>({...identity,assistantMessageID:null,previousStepID,currentExecution:execution,attempt,permitSha256});
 const assistant=id=>({info:{id,sessionID:identity.sessionID,role:'assistant',parentID:identity.userMessageID,...execution,time:{}},parts:[],turnOwnership:{source:'native-sequence',userMessageID:identity.userMessageID}});
 const start=async(f,id='msg_lazy',overrides={})=>{f.state.messages.push(assistant(id));return f.controller.plugin({action:'step',...identity,assistantMessageID:id,execution,nativeAttempt:attempt,nativePermitSha256:permitSha256,...overrides});};
 const reserve=(f,previous=null,choose=choice)=>f.controller.reserveNativeFallback(request(previous),{authorize:async()=>{},choose});
 test('first lazy failure reserves without dispatch, binds real Step, and waits for real failure settlement',async()=>{
  const f=await setup();const reserved=await reserve(f);expect(reserved.record).toMatchObject({state:'observing',stepID:null,instanceID:null,attemptCount:0,nativeFallback:{stepID:null,pending:{instanceID:identity.instanceID,previousStepID:null,attempt,permitSha256,currentExecution:execution}}});
  await f.controller.observe({type:'session.error',properties:{sessionID:identity.sessionID}});expect(f.sent).toHaveLength(0);
  await start(f);let r=await f.controller.readRecord(identity.sessionID);expect(r).toMatchObject({state:'observing',stepID:'msg_lazy',nativeFallback:{stepID:'msg_lazy'},nativeStepWitness:{attempt,permitSha256}});expect(r.nativeFallback.pending).toBeUndefined();expect(f.sent).toHaveLength(0);
  f.state.messages.at(-1).info.error={statusCode:429};f.state.messages.at(-1).info.time.completed=10001;f.state.status='idle';
  await f.controller.observe({type:'session.error',properties:{sessionID:identity.sessionID}});r=await f.controller.readRecord(identity.sessionID);expect(r).toMatchObject({attemptCount:1,failedID:'msg_lazy',recoveryExecution:fallback});expect(f.sent).toHaveLength(1);
 });
 test('later lazy attempt never binds a previously completed assistant',async()=>{
  const f=await setup();await start(f,'msg_previous');f.state.messages.at(-1).info.time.completed=10001;
  await reserve(f,'msg_previous');expect((await f.controller.readRecord(identity.sessionID)).nativeFallback.stepID).toBeNull();
  await expect(f.controller.plugin({action:'step',...identity,assistantMessageID:'msg_previous',execution,nativeAttempt:attempt,nativePermitSha256:permitSha256})).rejects.toMatchObject({code:'native_fallback_fenced'});
 });
 test('later lazy attempt binds only its successor and defers unavailable attention until settled failure',async()=>{
  const f=await setup();await start(f,'msg_previous');f.state.messages.at(-1).info.time.completed=10001;
  await reserve(f,'msg_previous',async()=>({tried:['openai/gpt-5.6-sol'],exhaustion:2}));await start(f,'msg_successor');
  expect(await f.controller.readRecord(identity.sessionID)).toMatchObject({state:'observing',stepID:'msg_successor',attemptCount:0});
  f.state.messages.at(-1).info.error={statusCode:429};await f.controller.observe({type:'session.error',properties:{sessionID:identity.sessionID}});expect((await f.controller.readRecord(identity.sessionID)).state).toBe('observing');
  f.state.messages.at(-1).info.time.completed=10002;f.state.status='idle';await f.controller.observe({type:'session.error',properties:{sessionID:identity.sessionID}});
  expect(await f.controller.readRecord(identity.sessionID)).toMatchObject({state:'needs_attention',reason:'native_fallback_exhausted',attemptCount:0});expect(f.sent).toHaveLength(0);
 });
 test('pending choice refuses missing or changed attempt/permit, foreign source and changed tuple',async()=>{
  for(const change of [{nativeAttempt:undefined},{nativeAttempt:{...attempt,spanID:'d'.repeat(16)}},{nativePermitSha256:'d'.repeat(64)},{execution:{...execution,modelID:'foreign'}}]){
   const f=await setup();await reserve(f);await expect(start(f,'msg_lazy',change)).rejects.toMatchObject({code:'native_fallback_fenced'});expect((await f.controller.readRecord(identity.sessionID)).nativeFallback.stepID).toBeNull();expect(f.sent).toHaveLength(0);
  }
  const f=await setup();await expect(f.controller.reserveNativeFallback({...request(null),attempt:null},{authorize:async()=>{},choose:choice})).rejects.toMatchObject({code:'native_fallback_fenced'});
 });
 test('unfinished previous Step cannot be classified lazy and witnessed streamed choice rejects another attempt',async()=>{
  const f=await setup();await start(f,'msg_streamed');await expect(reserve(f,'msg_streamed')).rejects.toMatchObject({code:'native_fallback_fenced'});
  const bound={...request(null),assistantMessageID:'msg_streamed'};await expect(f.controller.reserveNativeFallback({...bound,permitSha256:'d'.repeat(64)},{authorize:async()=>{},choose:choice})).rejects.toMatchObject({code:'native_fallback_fenced'});
  expect((await f.controller.reserveNativeFallback(bound,{authorize:async()=>{},choose:choice})).reserved).toBe(true);expect(f.sent).toHaveLength(0);
 });
 test('later binding rechecks predecessor canonical ownership and execution',async()=>{
  for(const change of [previous=>{previous.info.modelID='foreign';},previous=>{previous.turnOwnership.source='foreign';},previous=>{previous.info.parentID='msg_foreign';}]){
   const f=await setup();await start(f,'msg_previous');f.state.messages.at(-1).info.time.completed=10001;await reserve(f,'msg_previous');change(f.state.messages.at(-1));
   await expect(start(f,'msg_successor')).rejects.toMatchObject({code:'native_fallback_fenced'});expect((await f.controller.readRecord(identity.sessionID)).nativeFallback.stepID).toBeNull();expect(f.sent).toHaveLength(0);
  }
 });
 test('unknown original provider defers unavailable attention until its genuine canonical failure',async()=>{
  const original={...execution,providerID:'devryan-smoke'};
  const f=await fixture({mode:'observe',isNativeFallbackError:error=>error?.statusCode===429},original.providerID,'orchestrator',2);f.state.messages.splice(1);f.state.status='busy';
  await f.controller.plugin({action:'hello',policyVersion:1,instanceID:identity.instanceID,version:'2.0.20'});
  await f.controller.reserveNativeFallback({...request(null),currentExecution:original},{authorize:async()=>{},choose:async()=>({tried:['devryan-smoke/gpt-5.6-sol'],exhaustion:0})});
  f.state.messages.push({...assistant('msg_lazy'),info:{...assistant('msg_lazy').info,...original}});
  await f.controller.plugin({action:'step',...identity,assistantMessageID:'msg_lazy',execution:original,nativeAttempt:attempt,nativePermitSha256:permitSha256});
  expect((await f.controller.readRecord(identity.sessionID)).state).toBe('observing');f.state.messages.at(-1).info.error={statusCode:429};f.state.messages.at(-1).info.time.completed=10001;f.state.status='idle';
  await f.controller.observe({type:'session.error',properties:{sessionID:identity.sessionID}});expect(await f.controller.readRecord(identity.sessionID)).toMatchObject({state:'needs_attention',reason:'native_fallback_unavailable',attemptCount:0});expect(f.sent).toHaveLength(0);
 });
 test('Stop during binding observation or final write authorization cannot persist the stale choice',async()=>{
  for(const phase of ['observation','write']){
   let f,paused=false,authCalls=0,enter,release;const entered=new Promise(resolve=>enter=resolve),gate=new Promise(resolve=>release=resolve);
   f=await fixture({mode:'observe',isNativeFallbackError:error=>error?.statusCode===429,
    observeTurn:async()=>{if(paused&&phase==='observation'){enter();await gate;}return structuredClone(f.state);},
    authorize:async()=>{if(paused&&phase==='write'&&++authCalls===3){enter();await gate;}return true;}},'openai','orchestrator',2);
   f.state.messages.splice(1);f.state.status='busy';await f.controller.plugin({action:'hello',policyVersion:1,instanceID:identity.instanceID,version:'2.0.20'});await reserve(f);
   paused=true;const starting=start(f);await entered;const stopping=f.controller.control(identity.sessionID,'stop');release();await expect(starting).rejects.toMatchObject({code:'native_fallback_fenced'});await stopping;
   expect(await f.controller.readRecord(identity.sessionID)).toMatchObject({state:'cancelled',stepID:null,nativeFallback:{stepID:null},attemptCount:0});expect(f.sent).toHaveLength(0);
  }
 });
 test('durable pending schema rejects missing witnesses, invalid predecessor and changed original selection',async()=>{
  const f=await setup();const {record}=await reserve(f);expect(()=>validatePrimaryRecoveryRecord(record)).not.toThrow();
  for(const mutate of [r=>{delete r.nativeFallback.pending;},r=>{r.nativeFallback.pending.permitSha256=5;},r=>{delete r.nativeFallback.pending.attempt.spanID;},r=>{r.nativeFallback.pending.previousStepID='foreign';},r=>{r.nativeFallback.pending.currentExecution.modelID='foreign';}]){
   const changed=structuredClone(record);mutate(changed);expect(()=>validatePrimaryRecoveryRecord(changed)).toThrow();
  }
 });
 test('same-instance version change during final authorization cannot bind the pending choice',async()=>{
  let paused=false,calls=0,enter,release;const entered=new Promise(resolve=>enter=resolve),gate=new Promise(resolve=>release=resolve);
  const f=await setup({authorize:async()=>{if(paused&&++calls===3){enter();await gate;}return true;}});await reserve(f);paused=true;const starting=start(f);await entered;
  await f.controller.plugin({action:'hello',policyVersion:1,instanceID:identity.instanceID,version:'1.18.25'});release();
  await expect(starting).rejects.toMatchObject({code:'native_fallback_fenced'});expect(await f.controller.readRecord(identity.sessionID)).toMatchObject({state:'observing',stepID:null,nativeFallback:{stepID:null},attemptCount:0});expect(f.sent).toHaveLength(0);
 });
 test('only fresh explicit original-input adoption retires an old pending choice; compaction cannot inherit it',async()=>{
  const compacting=await setup();await reserve(compacting);compacting.state.messages.push({info:{id:'msg_compaction',role:'user'},parts:[{type:'compaction',auto:true}]},{info:{id:'msg_native',role:'user'},parts:[{type:'text',synthetic:true,metadata:{compaction_continue:true},text:'Continue.'}]});
  await expect(compacting.controller.plugin({action:'message',...identity,userMessageID:'msg_native'})).rejects.toMatchObject({code:'provider_recovery_fenced'});expect((await compacting.controller.readRecord(identity.sessionID)).activeUserID).toBeUndefined();
  const f=await setup();await reserve(f);await expect(f.controller.adoptOwnedNativeContinuation({...identity,userMessageID:'msg_compaction',assistantMessageID:'msg_summary',execution})).rejects.toMatchObject({code:'native_continuation_fenced'});
  await f.controller.plugin({action:'hello',policyVersion:1,instanceID:'replacement',version:'2.0.20'});await f.controller.observe({type:'session.error',properties:{sessionID:identity.sessionID}});
  const r=await f.controller.readRecord(identity.sessionID);expect(r).toMatchObject({state:'needs_attention',reason:'native_fallback_dispatch_uncertain',attemptCount:0});expect(r.nativeFallback.pending).toBeDefined();expect(f.sent).toHaveLength(0);
  await f.controller.adoptRecoveredInput({sessionID:identity.sessionID,messageID:r.anchorID,payloadHash:'a'.repeat(64),enqueuedSeq:1,delivery:'queue',recordRevision:r.revision,cancellationGeneration:r.cancellationGeneration,previousOwner:r.owner,owner:'fresh-owner',instanceID:'replacement'},async()=>{});
  const adopted=await f.controller.readRecord(identity.sessionID);expect(adopted).toMatchObject({state:'observing',stepID:null,attemptCount:0,tools:r.tools,owner:'fresh-owner'});expect(adopted.nativeFallback).toBeUndefined();
  await start(f,'msg_afteradoption',{instanceID:'replacement',nativeAttempt:{traceID:'d'.repeat(32),spanID:'e'.repeat(16)},nativePermitSha256:'f'.repeat(64)});expect((await f.controller.readRecord(identity.sessionID)).stepID).toBe('msg_afteradoption');expect(f.sent).toHaveLength(0);
 });
 test('late old native hello cannot overwrite the fresh replacement handshake',async()=>{
  const f=await setup();let currentInstance=identity.instanceID,enter,release;const entered=new Promise(resolve=>enter=resolve),gate=new Promise(resolve=>release=resolve);
  const old=f.controller.plugin({action:'hello',policyVersion:1,instanceID:identity.instanceID,version:'2.0.20'},undefined,undefined,{authorize:async()=>{enter();await gate;},isCurrent:()=>currentInstance===identity.instanceID});
  await entered;currentInstance='replacement';await f.controller.plugin({action:'hello',policyVersion:1,instanceID:currentInstance,version:'2.0.20'},undefined,undefined,{authorize:async()=>{},isCurrent:()=>currentInstance==='replacement'});release();
  await expect(old).rejects.toMatchObject({code:'recovery_owner_mismatch'});
  await expect(f.controller.reserveNativeFallback({...request(null),instanceID:currentInstance},{authorize:async()=>{},choose:choice})).resolves.toMatchObject({reserved:true,record:{nativeFallback:{pending:{instanceID:currentInstance}}}});
  await start(f,'msg_fresh',{instanceID:currentInstance});expect(await f.controller.readRecord(identity.sessionID)).toMatchObject({stepID:'msg_fresh',instanceID:currentInstance,nativeFallback:{stepID:'msg_fresh'}});expect(f.sent).toHaveLength(0);
 });
 test('Stop, replacement, and new primary admission cannot inherit pending choice',async()=>{
  const stopped=await setup();await reserve(stopped);await stopped.controller.control(identity.sessionID,'stop');await expect(start(stopped)).rejects.toMatchObject({code:'provider_recovery_fenced'});
  const replaced=await setup();await reserve(replaced);await replaced.controller.plugin({action:'hello',policyVersion:1,instanceID:'replacement',version:'2.0.20'});
  // Hello starts its sweep asynchronously. Await the same reconciler before
  // testing the attention-state fence rather than its earlier pending fence.
  await replaced.controller.observe({type:'session.error',properties:{sessionID:identity.sessionID}});
  expect(await replaced.controller.readRecord(identity.sessionID)).toMatchObject({state:'needs_attention',reason:'native_fallback_dispatch_uncertain',attemptCount:0});
  await expect(start(replaced,'msg_lazy',{instanceID:'replacement'})).rejects.toMatchObject({code:'provider_recovery_fenced'});
  expect(replaced.sent).toHaveLength(0);
  const newer=await setup();await reserve(newer);await newer.controller.admit({sessionID:identity.sessionID,directory:'/project',primary:true,executionGeneration:2,body:{messageID:'msg_newuser',agent:execution.agent,model:{providerID:execution.providerID,modelID:execution.modelID},variant:execution.variant}});expect((await newer.controller.readRecord(identity.sessionID)).nativeFallback).toBeUndefined();expect(newer.sent).toHaveLength(0);
 });
});

test('a native step reports the provider request its attempt actually prepared and sent', async () => {
  const lookups = [];
  const f = await fixture({ mode: 'observe', resolveProviderRequest: (input) => {
    lookups.push(input);
    return input.attempt.spanID === 'span_1' ? { requestID: 'req_native', transport: 'ws', preparedAt: 9_000, sentAt: 9_400 } : null;
  } });
  delete f.state.messages.at(-1).info.error; delete f.state.messages.at(-1).info.time.completed;
  await f.controller.plugin({ action: 'step', ...identity, nativeAttempt: { traceID: 'trace_1', spanID: 'span_1' }, nativePermitSha256: 'a'.repeat(64) });
  expect(lookups).toEqual([{ sessionID: identity.sessionID, attempt: { traceID: 'trace_1', spanID: 'span_1' } }]);
  const prepared = f.incidents.filter((entry) => entry.event === 'provider_request_prepared');
  expect(prepared).toHaveLength(1);
  // Step.Started is observed after the first provider output; the incident
  // carries the attempt's real request identity and times, not the step's.
  expect(prepared[0]).toMatchObject({ providerRequestID: 'req_native', wireTiming: 'observed', transport: 'ws',
    requestPreparedAt: 9_000, requestSentAt: 9_400 });
});

test('a step without an observed native request keeps the explicit unavailable identity', async () => {
  const f = await fixture({ mode: 'observe', resolveProviderRequest: () => { throw new Error('observer failure'); } });
  delete f.state.messages.at(-1).info.error; delete f.state.messages.at(-1).info.time.completed;
  await f.controller.plugin({ action: 'step', ...identity, nativeAttempt: { traceID: 'trace_1', spanID: 'span_2' }, nativePermitSha256: 'a'.repeat(64) });
  const prepared = f.incidents.find((entry) => entry.event === 'provider_request_prepared');
  expect(prepared).toMatchObject({ providerRequestID: 'unavailable', wireTiming: 'unavailable', transport: 'unverified', requestPreparedAt: 10_000 });
});
