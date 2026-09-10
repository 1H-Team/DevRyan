import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPrimaryRecoveryController } from './provider-recovery.js';
import { classifyPrimaryTransportError, PROVIDER_RECOVERY_SUPPORTED_OPENCODE_VERSIONS } from './provider-recovery-policy.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const timeout = { name: 'UnknownError', data: { message: 'The operation timed out.' } };
const identity = { sessionID: 'ses_test', userMessageID: 'msg_user', assistantMessageID: 'msg_failed', instanceID: 'runtime-test' };

async function fixture(overrides = {}, providerID = 'openai') {
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
  await controller.admit({ sessionID: identity.sessionID, directory: '/project', primary: true,
    body: { messageID: 'msg_user', agent: 'orchestrator', model: { providerID, modelID: providerID === 'anthropic' ? 'claude-opus-5' : 'gpt-5.6-sol' }, variant: 'xhigh' } });
  let requestHook;
  const fail = async () => {
    const r = await controller.readRecord(identity.sessionID);
    if (r.state === 'observing' && r.requestedAt === null) await (requestHook ??= controller.plugin({ action: 'step', ...identity }));
    return controller.observe({ type: 'session.error', properties: { sessionID: identity.sessionID, error: timeout } });
  };
  return { controller, state, sent, incidents, aborted, fail, directory, advance: (ms) => { time += ms; },
    snapshot: () => controller.getSnapshot(identity.sessionID), onWait: (callback) => { onWait = callback; } };
}

describe('failure classification', () => {
  test('version-pins the lossy current runtime error and rejects generic wording', () => {
    expect(classifyPrimaryTransportError(timeout, '1.18.25')?.source).toBe('opencode_1.18.25_compatibility');
    expect(classifyPrimaryTransportError(timeout, '1.18.26')?.source).toBe('opencode_1.18.26_compatibility');
    expect(classifyPrimaryTransportError(timeout, '1.18.27')?.source).toBe('opencode_1.18.27_compatibility');
    expect(classifyPrimaryTransportError(timeout, '1.18.29')?.source).toBe('opencode_1.18.29_compatibility');
    expect(classifyPrimaryTransportError(timeout, '1.18.30')?.source).toBe('opencode_1.18.30_compatibility');
    expect(classifyPrimaryTransportError(timeout, '1.18.31')).toBeNull();
    expect(classifyPrimaryTransportError(timeout, undefined)).toBeNull();
    expect(classifyPrimaryTransportError({ name: 'UnknownError', message: 'request timeout' }, '1.18.25')).toBeNull();
    expect(classifyPrimaryTransportError({ name: 'UnknownError', message: 'request timeout' }, '1.18.26')).toBeNull();
  });
  test('allow-lists only verified OpenCode versions for enforcement', async () => {
    expect([...PROVIDER_RECOVERY_SUPPORTED_OPENCODE_VERSIONS]).toEqual(['1.18.25', '1.18.26', '1.18.27', '1.18.29', '1.18.30']);
    const f = await fixture();
    const hello = (version) => f.controller.plugin({ action: 'hello', instanceID: identity.instanceID, policyVersion: 1, version });
    expect((await hello('1.18.26')).supported).toBe(true);
    expect((await hello('1.18.27')).supported).toBe(true);
    expect((await hello('1.18.30')).supported).toBe(true);
    expect((await hello('1.18.31')).supported).toBe(false);
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
  await f.fail();
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
  expect(classifyPrimaryTransportError(upstreamTimeout, '1.18.31')).toBeNull();
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
