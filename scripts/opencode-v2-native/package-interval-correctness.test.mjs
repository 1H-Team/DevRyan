import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createIntervalCorrectnessTurn, validateEventReconcileInterval, intervalCorrectnessDeadlineMs,
  intervalCorrectnessArmTimeoutMs, installInterruptAckBarrier, runCompiledIntervalCorrectness,
  forwardIntervalCorrectnessHints, assertNativeDeadlineCompletion } from './package-interval-correctness.mjs';
import { createOpenCodeClient } from '../../packages/web/server/lib/opencode/opencode-client/index.js';

const runFile = promisify(execFile);
const request = messages => ({ body: { messages, tools: [{ function: { name: 'devryan_task' } }, { function: { name: 'write' } }] } });
const tool = (id, status, taskId = 'dvr_task_fixture', extra = {}) => ({ role: 'tool', tool_call_id: id,
  content: JSON.stringify({ task: { taskId, status }, ...extra }) });
const adverseTask = status => ({ owner: 'devryan', taskId: 'dvr_task_fixture', status,
  rootSessionId: 'ses_root', childSessionId: 'ses_child', directory: process.cwd() });
const adverseEnvelope = status => ({ ...adverseTask(status), envelopeId: 'dvr_result_fixture_2',
  action: null, acknowledgedAt: null, followUpTaskId: null });

test('interval option refuses unknown values and CLI refuses before native artifact access', async () => {
  for (const value of [undefined, 750, 1500]) assert.equal(validateEventReconcileInterval(value), value);
  for (const value of [null, 0, 749, 1501, NaN, '1500']) assert.throws(() => validateEventReconcileInterval(value));
  for (const value of ['0', '0750', '1500x']) {
    await assert.rejects(runFile(process.execPath, ['scripts/verify-opencode-v2-package.mjs', '--event-reconcile-interval-ms', value],
      { cwd: process.cwd(), env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR }, timeout: 10_000, maxBuffer: 8192 }),
    error => error.code === 1 && /must be 750 or 1500/.test(error.stderr));
  }
});

test('only cancel and deadline deliver original native projections to the managed activity sink', () => {
  const directory = process.cwd();
  const client = createOpenCodeClient({ getRuntime: () => ({ generation: 2, baseUrl: 'http://127.0.0.1:12345', version: '2.0.20', epoch: 1 }) });
  const event = { id: 'evt_fixture_delta', created: 12, type: 'session.text.delta', location: { directory },
    data: { sessionID: 'ses_fixture', assistantMessageID: 'msg_000000000001fixture', ordinal: 0, delta: '.' } };
  for (const mode of ['cancel', 'deadline']) {
    const projector = client.events.createProjector(), received = [];
    const managed = { getManagedRuntime: () => ({ processOpenCodeEvent: (payload, location) => received.push({ payload, directory: location }) }) };
    for (const suppressed of [undefined, 'missed-hints']) {
      assert.equal(forwardIntervalCorrectnessHints({ mode: suppressed, event, projector, managed }), 0);
      assert.deepEqual(received, []);
    }
    assert.equal(forwardIntervalCorrectnessHints({ mode, event, projector, managed }), 3);
    const expected = client.events.createProjector().project(event).map(({ payload, directory }) => ({ payload, directory }));
    assert.deepEqual(received, expected);
    assert.equal(received.at(-1).payload.type, 'message.part.delta');
    assert.equal(received.at(-1).payload.properties.delta, '.');
    assert.equal(received.at(-1).payload.id, 'evt_fixture_delta#2');
  }
});

test('deadline evidence rejects an early native completion even after wall time passes the deadline', () => {
  const timeoutAt = Date.now() - 20_000;
  assert.ok(Date.now() >= timeoutAt);
  assert.throws(() => assertNativeDeadlineCompletion({ completed: timeoutAt - 1 }, timeoutAt), /Native assistant completed before/);
  for (const completed of [null, undefined, NaN, 'late']) {
    assert.throws(() => assertNativeDeadlineCompletion({ completed }, timeoutAt));
  }
  assert.throws(() => assertNativeDeadlineCompletion({ completed: timeoutAt }, NaN), /finite deadline/);
  assert.doesNotThrow(() => assertNativeDeadlineCompletion({ completed: timeoutAt }, timeoutAt));
  assert.doesNotThrow(() => assertNativeDeadlineCompletion({ completed: timeoutAt + 1 }, timeoutAt));
});

test('cancel responder stays held until actual transport abort and refuses nonterminal or foreign wait results', async () => {
  const turn = createIntervalCorrectnessTurn('correctness-unit-cancel', 'cancel'), signal = new AbortController();
  const user = { role: 'user', content: turn.marker };
  const start = await turn.responder(request([user]), signal.signal); assert.equal(start.items[0].input.agent, 'fixer');
  const started = tool(turn.callIDs.startID, 'running');
  const wait = await turn.responder(request([user, started]), signal.signal); assert.equal(wait.items[0].input.action, 'wait');
  const child = turn.responder(request([{ role: 'user', content: turn.childMarker }]), signal.signal);
  const stopped = assert.rejects(child, /owned fixture abort/);
  await turn.held; assert.equal(turn.inspect().childAborted, false);
  await assert.rejects(turn.responder(request([user, started, tool(turn.callIDs.waitID, 'running')]), signal.signal), /before cancellation settled/);
  await assert.rejects(turn.responder(request([user, started, tool(turn.callIDs.waitID, 'aborted', 'foreign')]), signal.signal));
  signal.abort(Error('owned fixture abort')); await stopped;
  assert.equal(turn.inspect().childAborted, true); assert.equal(turn.inspect().parentReplies, 0);
  const waited = tool(turn.callIDs.waitID, 'aborted', 'dvr_task_fixture', {
    task: adverseTask('aborted'), resultEnvelope: adverseEnvelope('aborted') });
  const abandon = await turn.responder(request([user, started, waited]), signal.signal);
  assert.equal(abandon.items[0].input.action, 'abandon');
  // Observed original native acknowledge response has no task property.
  const result = { resultEnvelope: { ...adverseEnvelope('aborted'), action: 'abandon', acknowledgedAt: 123 }, followUpTask: null };
  const disposed = { role: 'tool', tool_call_id: abandon.items[0].id, content: JSON.stringify(result) };
  assert.equal(Object.hasOwn(result, 'task'), false);
  for (const field of ['owner', 'envelopeId', 'taskId', 'rootSessionId', 'childSessionId', 'directory', 'status', 'action', 'acknowledgedAt', 'followUpTaskId']) {
    const wrong = { ...result, resultEnvelope: { ...result.resultEnvelope, [field]: null } };
    if (field === 'followUpTaskId') wrong.resultEnvelope[field] = 'dvr_task_foreign';
    await assert.rejects(turn.responder(request([user, started, { ...disposed, content: JSON.stringify(wrong) }]), signal.signal));
  }
  await assert.rejects(turn.responder(request([user, started, { ...disposed,
    content: JSON.stringify({ ...result, followUpTask: adverseTask('running') }) }]), signal.signal));
  assert.equal(turn.inspect().parentReplies, 0);
  const final = await turn.responder(request([user, started, disposed]), signal.signal);
  assert.equal(final.items[0].text, turn.expectedText);
  await assert.rejects(turn.responder(request([user, started, disposed]), signal.signal), /repeated/);
});

test('deadline responder selects nonrenewable oracle and emits real bounded content without a terminal frame', async () => {
  const turn = createIntervalCorrectnessTurn('correctness-unit-deadline', 'deadline'), signal = new AbortController();
  const user = { role: 'user', content: turn.marker };
  const start = await turn.responder(request([user]), signal.signal);
  assert.equal(start.items[0].input.agent, 'oracle'); assert.equal(start.items[0].input.timeout_seconds, 10);
  assert.equal(intervalCorrectnessDeadlineMs, 900_000); assert.equal(intervalCorrectnessArmTimeoutMs, 1_020_000);
  await turn.responder(request([user, tool(turn.callIDs.startID, 'running')]), signal.signal);
  const stream = await turn.responder(request([{ role: 'user', content: turn.childMarker }]), signal.signal);
  const iterator = stream.items[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), { value: { type: 'textDelta', text: '.' }, done: false });
  assert.equal(turn.inspect().parentReplies, 0);
  signal.abort(Error('original transport interruption'));
  await assert.rejects(iterator.next()); assert.equal(turn.inspect().childAborted, true);
  await assert.rejects(turn.responder(request([user, tool(turn.callIDs.waitID, 'completed')]), signal.signal));
});

test('missed-hint responder preserves the original real writer start/wait protocol', async () => {
  const turn = createIntervalCorrectnessTurn('correctness-unit-missed', 'missed-hints');
  const user = { role: 'user', content: turn.marker }, started = tool(turn.callIDs.startID, 'running');
  assert.equal((await turn.responder(request([user]))).items[0].input.action, 'start');
  assert.equal((await turn.responder(request([user, started]))).items[0].input.action, 'wait');
  assert.equal((await turn.responder(request([{ role: 'user', content: turn.childMarker }]))).items[0].name, 'write');
  await turn.responder(request([{ role: 'tool', tool_call_id: turn.callIDs.writerID, content: 'Original native writer output' }]));
  const final = await turn.responder(request([user, started, tool(turn.callIDs.waitID, 'completed')]));
  assert.equal(final.items[0].text, turn.expectedText); assert.equal(turn.complete().taskID, 'dvr_task_fixture');
});

test('actual frozen client receives original interrupt ACK only after the scoped transport barrier releases', async () => {
  const origin = 'http://127.0.0.1:12345', sessionID = 'ses_fixture';
  let release, entered;
  const released = new Promise(resolve => { release = resolve; }), acknowledged = new Promise(resolve => { entered = resolve; });
  const responses = [];
  const originalFetch = async () => {
    const response = Response.json({ interrupted: true }); responses.push(response); return response;
  };
  const nativeTransport = { fetch: originalFetch };
  const client = createOpenCodeClient({ getRuntime: () => ({ generation: 2, baseUrl: origin, version: '2.0.20', epoch: 1 }),
    fetchImpl: (...args) => nativeTransport.fetch(...args) });
  assert.equal(Object.isFrozen(client.sessions), true);
  const originalAbort = client.sessions.abort;
  let ackCalls = 0;
  const restore = installInterruptAckBarrier({ nativeTransport, nativeOrigin: origin, sessionID, release: released,
    signal: new AbortController().signal, afterAck: () => { ackCalls++; entered(); } });
  try {
    let returned = false;
    const pending = client.sessions.abort(sessionID, { directory: process.cwd() }).then(value => { returned = true; return value; });
    await acknowledged;
    assert.equal(returned, false); assert.equal(responses[0].bodyUsed, false);
    assert.equal(client.sessions.abort, originalAbort);
    // Other session, origin and method responses stay the original untouched
    // objects and cannot acquire this child's acknowledgement barrier.
    for (const [url, method] of [[`${origin}/api/session/ses_other/interrupt`, 'POST'],
      [`http://127.0.0.1:12346/api/session/${sessionID}/interrupt`, 'POST'], [`${origin}/api/session/${sessionID}/interrupt`, 'GET']]) {
      const response = await nativeTransport.fetch(url, { method });
      assert.equal(response, responses.at(-1)); assert.equal(response.bodyUsed, false);
    }
    assert.equal(ackCalls, 1); release(); assert.equal(await pending, true);
    assert.equal(responses[0].bodyUsed, true);
  } finally { release(); restore(); }
  assert.equal(nativeTransport.fetch, originalFetch); assert.equal(client.sessions.abort, originalAbort);
});

test('a failed original operation with a frozen client still cancels the SSE reader and releases its lock', { timeout: 5000 }, async t => {
  let cancelled = 0;
  const body = new ReadableStream({ cancel: () => { cancelled++; } });
  t.mock.method(globalThis, 'fetch', async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
  const nativeTransport = { fetch: async () => Response.json({ error: 'owned fixture refusal' }, { status: 500 }) };
  const originalFetch = nativeTransport.fetch;
  const client = createOpenCodeClient({ getRuntime: () => ({ generation: 2, baseUrl: 'http://127.0.0.1:12345', version: '2.0.20', epoch: 1 }),
    fetchImpl: (...args) => nativeTransport.fetch(...args) });
  const originalAbort = client.sessions.abort;
  try {
    await assert.rejects(runCompiledIntervalCorrectness({ intervalMs: 750, client, nativeTransport,
      provider: { setResponder: async () => {} }, getAuthHeaders: () => ({}), directory: process.cwd(), observations: [] }),
    error => /500/.test(error.message) && !(error instanceof TypeError));
    assert.equal(cancelled, 1); assert.equal(body.locked, false);
    assert.equal(nativeTransport.fetch, originalFetch); assert.equal(client.sessions.abort, originalAbort);
  } finally { t.mock.restoreAll(); }
});
