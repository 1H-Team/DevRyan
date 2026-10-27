import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { managedTaskTurn, assertWriterOutcome } from './assertions.mjs';
import { waitFor } from './process-lanes.mjs';
import { createV2MessageId } from '../../packages/web/server/lib/opencode/v2/admission.js';
import { readSessionExecutionReceipt } from '../../packages/harness-runtime/lib/session-execution.js';

const runFile = promisify(execFile);
export const intervalCorrectnessDeadlineMs = 15 * 60_000;
export const intervalCorrectnessArmTimeoutMs = 17 * 60_000;
const terminal = task => ['completed', 'failed', 'aborted', 'interrupted'].includes(task?.status);
const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
const awaitGate = async (promise, signal, timeoutMs = 60_000) => {
  const timer = new AbortController();
  try {
    await Promise.race([promise, delay(timeoutMs, undefined, { signal: AbortSignal.any([signal, timer.signal]) })
      .then(() => { throw Error('compiled_interval_correctness_timeout'); })]);
    signal.throwIfAborted();
  } finally { timer.abort(); }
};

export function validateEventReconcileInterval(value) {
  assert.ok(value === undefined || value === 750 || value === 1500, 'eventReconcileIntervalMs must be 750 or 1500');
  return value;
}

export function forwardIntervalCorrectnessHints({ mode, event, projector, managed }) {
  if (mode !== 'cancel' && mode !== 'deadline') return 0;
  let forwarded = 0;
  for (const projected of projector.project(event)) {
    managed.getManagedRuntime().processOpenCodeEvent(projected.payload, projected.directory);
    forwarded++;
  }
  return forwarded;
}

export function assertNativeDeadlineCompletion(interrupted, timeoutAt) {
  assert.ok(Number.isFinite(timeoutAt), 'Original finite deadline missing');
  assert.ok(Number.isFinite(interrupted?.completed) && interrupted.completed >= timeoutAt,
    'Native assistant completed before the original scheduler deadline');
}

/** Hold only the original interrupt response for this captured native child.
 * The public client remains immutable and receives the same untouched response. */
export function installInterruptAckBarrier({ nativeTransport, nativeOrigin, sessionID, afterAck, release, signal }) {
  assert.match(sessionID, /^ses_[A-Za-z0-9]+$/);
  const originalFetch = nativeTransport.fetch;
  nativeTransport.fetch = async (url, input) => {
    const response = await originalFetch(url, input), target = new URL(url);
    if (input?.method === 'POST' && target.origin === nativeOrigin && target.pathname === `/api/session/${sessionID}/interrupt`) {
      assert.equal(response.status, 200, 'Original native child interrupt HTTP acknowledgement failed');
      await afterAck(); await awaitGate(release, signal);
    }
    return response;
  };
  return () => { nativeTransport.fetch = originalFetch; };
}

/** Only model output is fixture data. The actual start/wait/abandon results
 * and child interruption always come from the original product owners. */
export function createIntervalCorrectnessTurn(caseID, mode) {
  assert.ok(['missed-hints', 'cancel', 'deadline'].includes(mode));
  const turn = managedTaskTurn(caseID, mode === 'deadline' ? 'oracle' : 'fixer');
  const held = gate();
  let taskID, waitedEnvelope, childRequests = 0, waitResults = 0, parentReplies = 0, childAborted = false;
  const abandonID = `native_${caseID}_abandon`, expected = mode === 'cancel' ? 'aborted' : 'failed';
  return { ...turn, held: held.promise, expectedText: mode === 'missed-hints' ? `completed ${caseID}` : `observed ${expected} ${caseID}`,
    inspect: () => ({ taskID, childRequests, waitResults, parentReplies, childAborted }),
    responder: async (request, signal) => {
      if (mode === 'missed-hints') return turn.responder(request);
      const messages = request.body.messages;
      const child = messages.some(row => row.role === 'user' && JSON.stringify(row.content).includes(turn.childMarker)
        && !JSON.stringify(row.content).includes(turn.marker));
      if (child) {
        assert.equal(++childRequests, 1, 'Cancelled child was inferred again');
        held.release();
        if (mode === 'deadline') {
          // Real assistant content keeps the original no-progress observer
          // truthful. Oracle deadlines are nonrenewable; no finish or DONE is
          // produced before the original scheduler interrupts this stream.
          return { items: (async function* () {
            try {
              for (let index = 0; index < 102; index++) {
                signal.throwIfAborted();
                yield { type: 'textDelta', text: '.' };
                await delay(10_000, undefined, { signal });
              }
              throw Error('compiled_interval_deadline_did_not_interrupt');
            } finally { childAborted = signal.aborted; }
          })(), reason: 'stop' };
        }
        await new Promise((_, reject) => {
          const aborted = () => { childAborted = true; reject(signal.reason); };
          if (signal.aborted) aborted(); else signal.addEventListener('abort', aborted, { once: true });
        });
        throw Error('compiled_interval_held_child_returned');
      }
      const disposed = messages.find(row => row.role === 'tool' && row.tool_call_id === abandonID);
      if (disposed) {
        const result = JSON.parse(disposed.content);
        // Original acknowledge returns an envelope and optional follow-up, not
        // a task wrapper. Bind it to the exact terminal result already waited.
        assert.ok(waitedEnvelope, 'Parent disposition preceded its terminal wait');
        for (const field of ['owner', 'envelopeId', 'taskId', 'rootSessionId', 'childSessionId', 'directory', 'status']) {
          assert.equal(result.resultEnvelope?.[field], waitedEnvelope[field], `Parent disposition changed ${field}`);
        }
        assert.equal(result.resultEnvelope.action, 'abandon');
        assert.ok(Number.isFinite(result.resultEnvelope.acknowledgedAt), 'Parent disposition missing acknowledgement');
        assert.equal(result.resultEnvelope.followUpTaskId, null); assert.equal(result.followUpTask, null);
        assert.equal(++parentReplies, 1, 'Parent disposition response repeated');
        return { items: [{ type: 'textDelta', text: `observed ${expected} ${caseID}` }], reason: 'stop' };
      }
      const waited = messages.find(row => row.role === 'tool' && row.tool_call_id === turn.callIDs.waitID);
      if (waited) {
        const result = JSON.parse(waited.content);
        assert.equal(result.task.taskId, taskID); assert.equal(result.task.status, expected, 'Parent wait succeeded before cancellation settled');
        assert.equal(result.resultEnvelope?.owner, 'devryan');
        assert.ok(typeof result.resultEnvelope.envelopeId === 'string' && result.resultEnvelope.envelopeId);
        for (const field of ['taskId', 'rootSessionId', 'childSessionId', 'directory', 'status']) {
          assert.equal(result.resultEnvelope[field], result.task[field], `Parent wait envelope changed ${field}`);
        }
        for (const field of ['rootSessionId', 'childSessionId', 'directory']) assert.ok(typeof result.task[field] === 'string' && result.task[field]);
        assert.equal(result.resultEnvelope.action, null); assert.equal(result.resultEnvelope.acknowledgedAt, null);
        assert.equal(++waitResults, 1, 'Parent wait result repeated');
        waitedEnvelope = result.resultEnvelope;
        return { items: [{ type: 'toolCall', index: 0, id: abandonID, name: 'devryan_task',
          input: { action: 'abandon', task_id: taskID } }], reason: 'tool-calls' };
      }
      const submitted = messages.find(row => row.role === 'tool' && row.tool_call_id === turn.callIDs.startID);
      if (submitted) taskID = JSON.parse(submitted.content).task.taskId;
      const reply = turn.responder(request);
      if (mode === 'deadline' && reply.items[0]?.id === turn.callIDs.startID) {
        reply.items[0].input.timeout_seconds = 10;
      }
      return reply;
    },
  };
}

// Independent native rows prove an actual cancelled turn, released runner and
// interrupted idle. No history-derived status or fabricated clock is used.
async function readInterruptedChild({ databasePath, environment, sessionID }) {
  assert.match(sessionID, /^ses_[A-Za-z0-9]+$/);
  const query = `WITH a AS (SELECT id,seq,data FROM session_message WHERE session_id='${sessionID}'
    AND type='assistant' ORDER BY seq DESC LIMIT 1), i AS (SELECT id,seq,data FROM session_message
    WHERE session_id='${sessionID}' AND type='idle' AND seq>(SELECT seq FROM a) ORDER BY seq LIMIT 1)
    SELECT json_object('assistantID',a.id,'assistantSequence',a.seq,'completed',json_extract(a.data,'$.time.completed'),
    'error',json_extract(a.data,'$.error.type'),'idleID',i.id,'idleSequence',i.seq,'outcome',json_extract(i.data,'$.outcome'),
    'sessionOutcome',s.idle_outcome,'suspended',s.time_suspended,'resumeAttempts',s.resume_attempts)
    FROM session_v2 s LEFT JOIN a LEFT JOIN i WHERE s.id='${sessionID}';`;
  const { stdout } = await runFile('/usr/bin/sqlite3', ['-readonly', databasePath, query], { env: environment, timeout: 5000, maxBuffer: 4096 });
  const state = stdout.trim() ? JSON.parse(stdout) : null;
  assert.ok(state?.assistantID && state.idleID && state.idleSequence > state.assistantSequence);
  assert.ok(Number.isFinite(state.completed)); assert.equal(state.error, 'aborted');
  assert.equal(state.outcome, 'interrupted'); assert.equal(state.sessionOutcome, 'interrupted');
  assert.equal(state.suspended, null); assert.equal(state.resumeAttempts, 0);
  return state;
}

/** Three actual compiled cases at one explicitly captured interval. This is
 * correctness qualification, never resource or latency measurement. */
export async function runCompiledIntervalCorrectness({ intervalMs, client, managed, provider, executionHost,
  directory, observations, getAuthHeaders, databasePath, environment, nativeTransport }) {
  validateEventReconcileInterval(intervalMs);
  const results = [], abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(Error('compiled_interval_correctness_timeout')), intervalCorrectnessArmTimeoutMs + 120_000);
  let streamFailure, pump, reader, activeHints, bytes = 0, events = 0;
  const records = [];
  let restoreInterruptBarrier;
  try {
    const response = await fetch(client.events.url(), { headers: await getAuthHeaders(), signal: abort.signal });
    assert.ok(response.ok && response.body, 'Compiled correctness native SSE unavailable');
    reader = response.body.getReader();
    pump = (async () => {
      let pending = ''; const decoder = new TextDecoder();
      try {
        while (!abort.signal.aborted) {
          const chunk = await reader.read(); if (chunk.done) throw Error('compiled_interval_correctness_sse_ended');
          bytes += chunk.value.byteLength; assert.ok(bytes <= 16 * 1024 * 1024);
          pending = (pending + decoder.decode(chunk.value, { stream: true })).replace(/\r\n/g, '\n');
          let end;
          while ((end = pending.indexOf('\n\n')) >= 0) {
            const block = pending.slice(0, end); pending = pending.slice(end + 2);
            const parsed = client.events.parseBlock(block); if (parsed?.kind !== 'event') continue;
            const event = parsed.envelope;
            if (parsed.directory !== directory && event.location?.directory !== directory) continue;
            assert.ok(++events <= 8000);
            records.push({ type: event.type, eventID: event.id, sessionID: event.data?.sessionID,
              callID: event.data?.id, assistantMessageID: event.data?.assistantMessageID });
            // Only the missed-hint case suppresses delivery. Adverse cases use
            // the original projector and managed activity/event subscription.
            if (activeHints) activeHints.forwarded += forwardIntervalCorrectnessHints({
              ...activeHints, event, managed });
          }
        }
      } catch (error) { if (!abort.signal.aborted) { streamFailure = error; abort.abort(error); } }
    })();
    for (const mode of ['missed-hints', 'cancel', 'deadline']) {
      const hints = { mode, projector: client.events.createProjector(), forwarded: 0 };
      activeHints = hints;
      const caseID = `correctness-${intervalMs}-${mode}-${randomUUID()}`, turn = createIntervalCorrectnessTurn(caseID, mode);
      await provider.setResponder(turn.responder);
      const model = { providerID: 'devryan-smoke', modelID: 'smoke-write' };
      const root = await client.sessions.create({ title: `Compiled interval ${mode}`, agent: 'orchestrator', model }, { directory });
      await managed.admitPrimary(root.id);
      const messageID = createV2MessageId(), runtime = managed.getManagedRuntime();
      await client.prompts.prompt(root.id, { messageID, agent: 'orchestrator', model, variant: 'default', parts: [{ type: 'text', text: turn.marker }] },
        { directory, origin: 'native_acceptance', delivery: 'queue', signal: abort.signal, timeoutMs: 30_000 });
      const snapshot = () => runtime.getSnapshot({ rootSessionId: root.id });
      let before, interrupted, ackCalls = 0;
      if (mode !== 'missed-hints') {
        await awaitGate(turn.held, abort.signal);
        before = await waitFor(async () => (await snapshot()).tasks[0], task => task?.status === 'running' && task.childSessionId,
          'Actual managed child never entered running state');
        await waitFor(async () => records, rows => rows.some(row => row.type === 'session.tool.called'
          && row.sessionID === root.id && row.callID === turn.callIDs.waitID), 'Actual parent wait never entered');
        assert.equal(before.taskId, turn.inspect().taskID);
        const child = (await client.sessions.messages(before.childSessionId, {}, { directory })).records;
        assert.equal(child.filter(row => row.info.role === 'user').length, 1);
        assert.equal(child.some(row => row.info.time?.completed), false, 'Held child became terminal before adverse action');
        assert.equal((await client.sessions.status({ directory }))[before.childSessionId]?.type, 'busy');
        assert.equal(observations.some(row => row.phase === 'managed_event' && row.properties?.task?.taskId === before.taskId
          && terminal(row.properties.task)), false, 'Task published terminal state while child remained held');
        const acknowledged = gate(), releaseAck = gate();
        restoreInterruptBarrier = installInterruptAckBarrier({ nativeTransport, nativeOrigin: new URL(client.events.url()).origin,
          sessionID: before.childSessionId, release: releaseAck.promise, signal: abort.signal, afterAck: async () => {
            assert.equal(++ackCalls, 1);
            interrupted = await readInterruptedChild({ databasePath, environment, sessionID: before.childSessionId });
            acknowledged.release();
          } });
        let cancelling;
        try {
          if (mode === 'cancel') {
            cancelling = runtime.handleRpc({ method: 'cancel', params: {
              taskId: before.taskId, rootSessionId: root.id, directory, reason: 'Compiled interval explicit cancellation' } });
            cancelling.catch(error => abort.abort(error));
          } else {
            assert.ok(Number.isFinite(before.timeoutAt) && before.timeoutAt > Date.now(), 'Original finite deadline already expired before observation');
            assert.ok(Math.abs(before.timeoutAt - before.createdAt - intervalCorrectnessDeadlineMs) < 5000,
              'Original oracle fifteen-minute minimum was not applied');
          }
          await awaitGate(acknowledged.promise, abort.signal, mode === 'deadline' ? intervalCorrectnessArmTimeoutMs : 60_000);
          const heldTask = (await snapshot()).tasks[0];
          assert.equal(terminal(heldTask), false, 'Managed task settled before actual abort ACK was released');
            assert.deepEqual([heldTask.taskId, heldTask.childSessionId, heldTask.startedAt, heldTask.dispatchCallId],
              [before.taskId, before.childSessionId, before.startedAt, before.dispatchCallId]);
          assert.equal(turn.inspect().waitResults, 0, 'Parent wait resumed before abort ACK');
          if (mode === 'deadline') {
            assert.equal(heldTask.timeoutAt, before.timeoutAt, 'Nonrenewable deadline changed');
            assert.ok(Date.now() >= before.timeoutAt, 'Cancellation preceded the actual scheduler deadline');
            assertNativeDeadlineCompletion(interrupted, before.timeoutAt);
          }
        } finally { releaseAck.release(); }
        await cancelling;
      }
      const page = await waitFor(() => client.sessions.messages(root.id, {}, { directory }), value => value.records.some(row =>
        row.info.role === 'assistant' && row.info.time?.completed && row.parts.some(part => part.type === 'text' && part.text === turn.expectedText)),
      'Actual parent failed to settle its exact managed result', 60_000);
      restoreInterruptBarrier?.(); restoreInterruptBarrier = undefined;
      const final = await snapshot(); assert.equal(final.tasks.length, 1);
      const task = final.tasks[0]; assert.equal(task.rootSessionId, root.id); assert.equal(task.directory, directory);
      assert.deepEqual([task.providerId, task.modelId, task.variant ?? 'default', task.agent],
        ['devryan-smoke', 'smoke-write', 'default', mode === 'deadline' ? 'oracle' : 'fixer']);
      assert.equal((await client.sessions.get(task.childSessionId, { directory })).parentID, root.id);
      assert.equal(page.records.filter(row => row.info.role === 'user').length, 1);
      assert.equal((await managed.readPrimaryRecord(root.id)).anchorID, messageID);
      const calls = page.records.flatMap(row => row.parts).filter(part => part.type === 'tool' && part.callID === turn.callIDs.waitID);
      assert.equal(calls.length, 1); assert.equal(calls[0].state.status, 'completed');
      let proof;
      if (mode === 'missed-hints') {
        const completed = turn.complete(); assert.equal(task.taskId, completed.taskID); assert.equal(task.status, 'completed');
        await assertWriterOutcome({ runtime: executionHost.runtime, directory, sessionID: task.childSessionId,
          callID: completed.childWriterCallID, observations, succeeded: true });
        assert.equal(await fs.readFile(path.join(directory, completed.childWriterFile), 'utf8'), `managed writer ${caseID}\n`);
        const lease = await executionHost.runtime.leaseForCall({ directory, sessionID: task.childSessionId, callID: completed.childWriterCallID });
        const receipt = await readSessionExecutionReceipt(lease); assert.equal(receipt.terminated, true); assert.equal(receipt.confined, true);
        proof = { writerCallID: completed.childWriterCallID, receiptToken: lease.token, operationID: lease.result.operationID };
      } else {
        assert.equal(task.taskId, before.taskId); assert.equal(task.status, mode === 'cancel' ? 'aborted' : 'failed');
        assert.equal(ackCalls, 1); assert.equal(turn.inspect().childRequests, 1); assert.equal(turn.inspect().childAborted, true);
        assert.equal(turn.inspect().waitResults, 1); assert.equal(turn.inspect().parentReplies, 1);
        if (mode === 'deadline') assert.equal(task.failureReason, `Managed task timed out at ${before.timeoutAt}`);
        const child = (await client.sessions.messages(task.childSessionId, {}, { directory })).records;
        assert.equal(child.filter(row => row.info.role === 'user').length, 1);
        assert.equal(child.find(row => row.info.id === interrupted.assistantID)?.info.time?.completed, interrupted.completed,
          'Final native assistant completion changed after abort acknowledgement');
        assert.equal(child.flatMap(row => row.parts).some(part => part.type === 'tool'), false, 'Held child executed a tool');
        assert.equal(observations.some(row => row.sessionID === task.childSessionId && ['execution_requested', 'published'].includes(row.phase)), false);
        assert.equal(await executionHost.runtime.leaseForCall({ directory, sessionID: task.childSessionId, callID: turn.callIDs.writerID }), null);
        proof = { abortAcknowledged: true, interrupted, timeoutAt: before.timeoutAt, processChild: false,
          limitation: 'Provider-only child; no executable child tool or process receipt exists.' };
      }
      assert.ok(observations.some(row => row.phase === 'managed_event' && row.properties?.task?.taskId === task.taskId
        && row.properties.task.status === task.status), 'Actual durable terminal task publication missing');
      if (streamFailure) throw streamFailure;
      provider.check();
      assert.equal(hints.forwarded > 0, mode !== 'missed-hints', 'Projected hint delivery did not match the active case');
      results.push({ id: `compiled-interval-${intervalMs}-${mode}`, status: 'passed', intervalMs, rootSessionID: root.id,
        childSessionID: task.childSessionId, taskID: task.taskId, anchorID: messageID, forwardedHints: hints.forwarded, proof });
      activeHints = undefined;
    }
    return results;
  } finally {
    try { restoreInterruptBarrier?.(); }
    finally {
      clearTimeout(timeout); abort.abort();
      try { await reader?.cancel().catch(() => {}); }
      finally { try { await pump; } finally { reader?.releaseLock(); } }
    }
  }
}
