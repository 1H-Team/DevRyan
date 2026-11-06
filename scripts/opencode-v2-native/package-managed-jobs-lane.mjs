import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { managedTaskTurn, assertWriterOutcome, snapshotFiles } from './assertions.mjs';
import { assertNativeCancellationSettled, waitFor } from './process-lanes.mjs';
import { createV2MessageId } from '../../packages/web/server/lib/opencode/v2/admission.js';
import { resolveSqliteDriver } from '../../packages/web/server/lib/opencode/sqlite-driver.js';
import { readSessionExecutionReceipt } from '../../packages/harness-runtime/lib/session-execution.js';
import { MANAGED_RECOVERY_INSTRUCTIONS } from '../../packages/orchestration-runtime/managed-recovery-instruction.js';
import { MANAGED_NATIVE_JOB_PROOF_DIRECTORY, managedNativeJobProofShard, managedNativeJobProofShardFile }
  from '../../packages/orchestration-runtime/native-job-proof-store.js';
import { createIntervalCorrectnessTurn, installManagedJobCancelAckBarrier } from './package-interval-correctness.mjs';

/** Only model output is fixture data: the managed child runs one real
 * confined shell whose background descendant writes inside its private view
 * until Stop or controller death settles it. Nothing may continue the child. */
export function createConfinedChildTurn(caseID, mode) {
  assert.ok(['cancel', 'restart'].includes(mode), 'Confined child stop mode required');
  assert.match(caseID, /^[a-z0-9-]+$/, 'Owned managed fixture case identity required');
  const marker = `[devryan-native-case:${caseID}]`, childMarker = `[devryan-native-managed-child:${caseID}]`;
  const startID = `native_${caseID}_start`, waitID = `native_${caseID}_wait`, shellID = `native_${caseID}_child_shell`;
  const files = { ready: `managed-${caseID}-ready.txt`, growth: `managed-${caseID}-growth.txt` };
  const command = `(while :; do printf x >> ${files.growth}; sleep 0.05; done) & printf '%s\\n' "$!" > ${files.ready}; wait`;
  const expected = mode === 'cancel' ? 'aborted' : 'interrupted', expectedText = `observed ${expected} ${caseID}`;
  const toolResult = (messages, id) => messages.find(message => message?.role === 'tool' && message.tool_call_id === id);
  let taskID, started = false, childRequests = 0, waitResults = 0;
  return { marker, childMarker, callIDs: { startID, waitID, shellID }, files, command, expected, expectedText,
    inspect: () => ({ taskID, childRequests, waitResults }),
    responder: request => {
      const messages = request.body?.messages;
      assert.ok(Array.isArray(messages), 'Missing managed model messages');
      if (messages.some(message => message?.role === 'user' && JSON.stringify(message.content).includes(childMarker)
        && !JSON.stringify(message.content).includes(marker))) {
        assert.equal(toolResult(messages, shellID), undefined, 'Stopped confined child continued after its shell');
        assert.ok(request.body.tools?.some(tool => tool?.function?.name === 'shell'), 'Managed child native shell missing');
        assert.equal(++childRequests, 1, 'Confined child inference replayed');
        return { items: [{ type: 'toolCall', index: 0, id: shellID, name: 'shell', input: { command, timeout: 600_000 } }], reason: 'tool-calls' };
      }
      const waited = toolResult(messages, waitID);
      if (waited) {
        const result = JSON.parse(waited.content);
        assert.equal(result.task?.taskId, taskID, 'Managed wait returned another task');
        assert.equal(result.task.status, expected, 'Parent wait returned before the confined child settled');
        assert.equal(result.resultEnvelope?.owner, 'devryan');
        for (const field of ['taskId', 'rootSessionId', 'childSessionId', 'directory', 'status']) {
          assert.equal(result.resultEnvelope[field], result.task[field], `Parent wait envelope changed ${field}`);
        }
        assert.equal(result.resultEnvelope.action, null); assert.equal(result.resultEnvelope.acknowledgedAt, null);
        if (mode === 'cancel') {
          assert.equal(result.task.stoppedRecoveryAvailable, true);
          assert.equal(result.instruction, MANAGED_RECOVERY_INSTRUCTIONS.manual);
        }
        assert.equal(++waitResults, 1, 'Parent wait result repeated');
        return { items: [{ type: 'textDelta', text: expectedText }], reason: 'stop' };
      }
      const submitted = toolResult(messages, startID);
      if (submitted) {
        assert.equal(taskID, undefined, 'Managed start result was replayed');
        taskID = JSON.parse(submitted.content).task?.taskId;
        assert.match(taskID ?? '', /^dvr_task_[A-Za-z0-9_-]+$/, 'Product managed task identity missing');
        return { items: [{ type: 'toolCall', index: 0, id: waitID, name: 'devryan_task', input: { action: 'wait', task_id: taskID } }], reason: 'tool-calls' };
      }
      assert.equal(started, false, 'Parent inference omitted its exact managed result');
      assert.ok(messages.some(message => JSON.stringify(message).includes(marker)), 'Unrelated managed model request');
      assert.ok(request.body.tools?.some(tool => tool?.function?.name === 'devryan_task'), 'Native managed task registry missing');
      started = true;
      return { items: [{ type: 'toolCall', index: 0, id: startID, name: 'devryan_task', input: { action: 'start', agent: 'fixer',
        prompt: `${childMarker} Run the held confined shell, then report.`, label: `Native ${caseID}` } }], reason: 'tool-calls' };
    } };
}

// A terminal adverse task may already be a released proof in its shard.
async function readDurableTask(dataDirectory, taskId) {
  const root = path.join(dataDirectory, 'orchestration');
  const inline = JSON.parse(await fs.readFile(path.join(root, 'ledger.json'), 'utf8')).tasks.find(task => task.taskId === taskId);
  if (inline) return inline;
  try {
    const file = path.join(root, MANAGED_NATIVE_JOB_PROOF_DIRECTORY, managedNativeJobProofShardFile(managedNativeJobProofShard(taskId)));
    return JSON.parse(await fs.readFile(file, 'utf8')).tasks.find(task => task.taskId === taskId);
  } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

const terminalTask = task => ['completed', 'failed', 'aborted', 'interrupted'].includes(task?.status);
const settleWithin = (promise, ms, label) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new assert.AssertionError({ message: label })), ms); })])
    .finally(() => clearTimeout(timer));
};
const processGone = pid => { try { process.kill(pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; } };

export function createCollectedManagedJobTurn(caseID) {
  const turn = managedTaskTurn(caseID, 'fixer'), continueID = `native_${caseID}_continue`;
  let finalReply, envelope, receipt, collected = false;
  return { ...turn,
    responder: request => {
      const messages = request.body.messages;
      const disposition = messages.find(message => message.role === 'tool' && message.tool_call_id === continueID);
      if (disposition) {
        assert.ok(envelope && finalReply && !collected, 'Managed result collection preceded its wait or repeated');
        const result = JSON.parse(disposition.content);
        assert.equal(result.committed, true, 'Managed collection did not commit');
        for (const field of ['taskId', 'envelopeId']) assert.equal(result[field], envelope[field], `Managed collection changed ${field}`);
        assert.equal(result.action, 'continue'); assert.equal(result.projectionError, undefined);
        assert.equal(Object.hasOwn(result, 'resultEnvelope'), false, 'Native v2 continue must return its committed receipt');
        receipt = result; collected = true; return finalReply;
      }
      const waited = messages.find(message => message.role === 'tool' && message.tool_call_id === turn.callIDs.waitID);
      if (waited) {
        assert.equal(finalReply, undefined, 'Managed result wait was replayed');
        finalReply = turn.responder(request);
        const result = JSON.parse(waited.content); envelope = result.resultEnvelope;
        assert.equal(envelope?.owner, 'devryan'); assert.equal(envelope.status, 'completed');
        for (const field of ['taskId', 'rootSessionId', 'childSessionId', 'directory', 'status']) {
          assert.equal(envelope[field], result.task[field], `Managed wait envelope changed ${field}`);
          assert.ok(typeof envelope[field] === 'string' && envelope[field]);
        }
        assert.equal(envelope.action, null); assert.equal(envelope.acknowledgedAt, null);
        assert.ok(!result.resultReference || result.resultReference.complete === true, 'Clean managed result requires another detail page');
        return { items: [{ type: 'toolCall', index: 0, id: continueID, name: 'devryan_task',
          input: { action: 'continue', task_id: envelope.taskId } }], reason: 'tool-calls' };
      }
      return turn.responder(request);
    },
    complete: () => { assert.equal(collected, true, 'Managed result was not collected before parent completion');
      return { ...turn.complete(), collectedEnvelope: envelope, collectionReceipt: receipt }; },
  };
}

function assertDurableCollection(ledger, proof) {
  const { collectionReceipt: receipt, collectedEnvelope: expected } = proof;
  const envelope = ledger.resultEnvelopes.find(value => value.envelopeId === receipt.envelopeId);
  assert.ok(envelope, 'Native committed receipt has no durable managed envelope');
  for (const field of ['owner', 'envelopeId', 'taskId', 'rootSessionId', 'childSessionId', 'directory', 'status']) {
    assert.equal(envelope[field], expected[field], `Durable managed collection changed ${field}`);
  }
  assert.equal(envelope.action, 'continue'); assert.equal(envelope.followUpTaskId, null);
  assert.ok(Number.isFinite(envelope.acknowledgedAt) && envelope.acknowledgedAt >= envelope.createdAt);
  assert.ok(typeof envelope.acknowledgementIdentity === 'string' && envelope.acknowledgementIdentity.length > 0);
}

async function runLostActivationReply({ client, managed, provider, directory, dataDirectory, databasePath }) {
  const caseID = 'compiled-managed-lost-activation', turn = createCollectedManagedJobTurn(caseID);
  const model = { providerID: 'devryan-smoke', modelID: 'smoke-write' }, runtime = managed.getManagedRuntime();
  const root = await client.sessions.create({ title: 'Lost native activation response', agent: 'orchestrator', model }, { directory });
  await managed.admitPrimary(root.id);
  const release = Promise.withResolvers(), transport = managed.nativeManagedJobs, activate = transport.activate;
  let lostReplies = 0, activationCalls = 0, childRequests = 0;
  transport.activate = async input => {
    if (input.rootSessionId === root.id) activationCalls++;
    const result = await activate(input);
    if (input.rootSessionId === root.id && lostReplies < 2) {
      lostReplies++; throw Object.assign(Error('Fixture lost the native activation response'), { code: 'native_process_command_timeout', status: 503 });
    }
    return result;
  };
  try {
    await provider.setResponder(async request => {
      const messages = request.body.messages;
      const child = messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes(turn.childMarker)
        && !JSON.stringify(message.content).includes(turn.marker));
      if (child && !messages.some(message => message.role === 'tool' && message.tool_call_id === turn.callIDs.writerID)) {
        childRequests++; await release.promise;
      }
      return turn.responder(request);
    });
    await client.prompts.prompt(root.id, { messageID: createV2MessageId(), agent: 'orchestrator', model, variant: 'default',
      parts: [{ type: 'text', text: turn.marker }] }, { directory, origin: 'native_acceptance', delivery: 'queue', timeoutMs: 30_000 });
    const readTask = async () => JSON.parse(await fs.readFile(path.join(dataDirectory, 'orchestration', 'ledger.json'), 'utf8')).tasks
      .find(task => task.rootSessionId === root.id);
    const uncertain = await waitFor(readTask, task => lostReplies === 2 && childRequests === 1 && task?.nativeJobSegments?.[0]?.state === 'uncertain',
      'Lost activation response did not retain its uncertain native segment');
    assert.ok(['starting', 'running'].includes(uncertain.status), 'Lost response settled an active provider task');
    const snapshot = await runtime.getSnapshot({ rootSessionId: root.id }); assert.equal(snapshot.resultEnvelopes.length, 0);
    const barrier = await runtime.handleRpc({ method: 'barrier_status', params: { rootSessionId: root.id, directory } });
    assert.equal(barrier.state, 'active'); assert.ok(barrier.taskIds.includes(uncertain.taskId));
    release.resolve();
    const parent = await waitFor(() => client.sessions.messages(root.id, {}, { directory }), page => page.records.some(row => row.info.role === 'assistant'
      && row.info.time?.completed && row.parts.some(part => part.type === 'text' && part.text === `completed ${caseID}`)),
    'Lost activation response prevented canonical managed completion', 60_000);
    const proof = turn.complete(); assert.equal(proof.taskID, uncertain.taskId); assert.equal(childRequests, 1);
    assertDurableCollection(JSON.parse(await fs.readFile(path.join(dataDirectory, 'orchestration', 'ledger.json'), 'utf8')), proof);
    assert.equal(activationCalls, 2); assert.equal(lostReplies, 2);
    const settled = await waitFor(readTask, task => task?.status === 'completed' && task.nativeJobSegments?.[0]?.completion === 'done',
      'Lost-response native receipt did not settle');
    assert.equal(settled.nativeJobSegments.length, 1); assert.equal(settled.childSessionId, uncertain.childSessionId);
    const [segment] = settled.nativeJobSegments, db = resolveSqliteDriver().open(databasePath, { readonly: true });
    try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM job WHERE id=? OR notification_id=?').get(segment.jobID, segment.notificationID).n, 0); }
    finally { db.close(); }
    assert.equal(parent.records.filter(row => row.info.role === 'user').length, 1);
    const child = await client.sessions.messages(settled.childSessionId, {}, { directory });
    assert.equal(child.records.filter(row => row.info.role === 'user').length, 1);
    const finalSnapshot = await runtime.getSnapshot({ rootSessionId: root.id });
    assert.equal(finalSnapshot.resultEnvelopes[0].action, 'continue'); assert.ok(Number.isFinite(finalSnapshot.resultEnvelopes[0].acknowledgedAt));
    return { id: 'compiled-managed-lost-activation', status: 'passed', taskID: settled.taskId,
      rootSessionID: root.id, childSessionID: settled.childSessionId, source: 'actual-native-activation-reply-loss-active-barrier-and-canonical-completion' };
  } finally { release.resolve(); transport.activate = activate; }
}

async function runAdverseManagedJob({ mode, client, managed, provider, runtimeOwner, executionHost,
  replaceController, directory, dataDirectory, databasePath }) {
  const caseID = `compiled-managed-subagent-${mode}`, turn = createIntervalCorrectnessTurn(caseID, 'cancel');
  const model = { providerID: 'devryan-smoke', modelID: 'smoke-write' }, runtime = managed.getManagedRuntime();
  await provider.setResponder(turn.responder);
  const root = await client.sessions.create({ title: `Compiled managed job ${mode}`, agent: 'orchestrator', model }, { directory });
  await managed.admitPrimary(root.id);
  const messageID = createV2MessageId();
  await client.prompts.prompt(root.id, { messageID, agent: 'orchestrator', model, variant: 'default',
    parts: [{ type: 'text', text: turn.marker }] }, { directory, origin: 'native_acceptance', delivery: 'queue', timeoutMs: 30_000 });
  await waitFor(() => turn.inspect(), state => state.childRequests === 1, 'Compiled adverse native child did not reach its held provider');
  const before = await waitFor(async () => (await runtime.getSnapshot({ rootSessionId: root.id })).tasks[0],
    task => task?.status === 'running' && task.childSessionId, 'Compiled adverse native task did not run');
  await waitFor(() => client.sessions.messages(root.id, {}, { directory }), page => page.records.flatMap(row => row.parts ?? [])
    .some(part => part.type === 'tool' && part.callID === turn.callIDs.waitID), 'Compiled adverse parent never entered its actual managed wait');
  const readTask = async () => JSON.parse(await fs.readFile(path.join(dataDirectory, 'orchestration', 'ledger.json'), 'utf8')).tasks
    .find(task => task.taskId === before.taskId);
  const original = await readTask(); assert.equal(original.executionBackend, 'native-job');
  assert.equal(original.nativeJobSegments.length, 1); const [segment] = original.nativeJobSegments;
  const db = resolveSqliteDriver().open(databasePath, { readonly: true });
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM job WHERE id=? AND notification_id=?').get(segment.jobID, segment.notificationID).n, 1);
    if (mode === 'cancel') {
      await runtime.handleRpc({ method: 'cancel', params: { taskId: before.taskId, rootSessionId: root.id, directory,
        reason: 'Compiled native managed job cancellation' } });
    } else {
      const { previous, exit, replacement } = await replaceController();
      assert.equal(exit.receipt?.terminated, true); assert.equal(exit.receipt?.confined, true);
      assert.notEqual(replacement.instanceID, previous.instanceID);
      assert.equal(runtimeOwner.isReady(), true);
    }
    const expected = mode === 'cancel' ? 'aborted' : 'interrupted';
    const settled = await waitFor(readTask, task => task?.status === expected && task.nativeJobSegments?.[0]?.completion === 'done',
      'Native adverse result or its durable completion receipt did not settle', 20_000);
    assert.equal(settled.childSessionId, before.childSessionId); assert.equal(settled.nativeJobSegments.length, 1);
    for (const field of ['jobID', 'notificationID', 'messageID']) assert.equal(settled.nativeJobSegments[0][field], segment[field]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM job WHERE id=? OR notification_id=?').get(segment.jobID, segment.notificationID).n, 0);
    assert.equal(turn.inspect().childRequests, 1, 'Adverse recovery replayed the original child provider turn');
    assert.equal(turn.inspect().childAborted, true, 'Native cancellation did not physically abort the held provider request');
    const child = await client.sessions.messages(before.childSessionId, {}, { directory });
    assert.equal(child.records.filter(row => row.info.role === 'user').length, 1, 'Adverse recovery duplicated accepted child input');
    assert.equal(child.records.filter(row => row.info.role === 'user')[0].info.id, segment.messageID);
    const snapshot = await runtime.getSnapshot({ rootSessionId: root.id }); assert.equal(snapshot.tasks.length, 1);
    assert.equal(snapshot.resultEnvelopes[0].status, expected); assert.equal(snapshot.resultEnvelopes[0].childSessionId, before.childSessionId);
    if (mode === 'cancel') await waitFor(() => client.sessions.messages(root.id, {}, { directory }), page => page.records.some(row => row.info.role === 'assistant'
      && row.info.time?.completed && row.parts.some(part => part.type === 'text' && part.text === turn.expectedText)),
    'Cancelled managed result did not reach the actual parent wait', 30_000);
    const parent = await client.sessions.messages(root.id, {}, { directory });
    if (mode === 'cancel') {
      const retained = await runtime.getSnapshot({ rootSessionId: root.id });
      assert.equal(retained.resultEnvelopes[0].action, null); assert.equal(retained.resultEnvelopes[0].acknowledgedAt, null);
      assert.equal(parent.records.flatMap(row => row.parts ?? []).some(part => part.type === 'tool'
        && part.callID === `native_${caseID}_abandon`), false, 'Stopped result was acknowledged by the parent');
    }
    assert.equal(parent.records.filter(row => row.info.role === 'user').length, 1);
    assert.equal(parent.records.some(row => row.info.id === segment.notificationID), false);
    assert.deepEqual(await executionHost.runtime.activeLeases({ directory, sessions: [root.id, before.childSessionId] }), []);
    return { id: `compiled-managed-subagent-${mode}`, status: 'passed', rootSessionID: root.id,
      childSessionID: before.childSessionId, taskID: before.taskId, jobID: segment.jobID,
      source: mode === 'cancel' ? 'actual-native-job-cancel-provider-abort-and-parent-wait' : 'actual-controller-death-durable-interruption-without-provider-replay' };
  } finally { db.close(); }
}

/** A managed native-job child holds a real confined shell and its live
 * descendant. Each stop must end both under a verified supervisor receipt and
 * publish nothing, and the native completion is recorded only after native
 * drainage and the native acknowledgement, which sees the terminal task with
 * its completion still pending.
 * - `cancel` (task Stop) holds the exact native `cancelTask` receipt: the child
 *   is interrupted and idle while the task stays non-terminal and unacknowledged.
 *   The native interrupt leaves the shell running by design; the settled
 *   attempt's durable run cleanup stops it after the terminal commit
 *   (`stoppedBy: 'task_settled'`).
 * - `restart` (controller death) settles the process before the replacement
 *   starts, so termination precedes the interruption and the acknowledgement. */
async function runConfinedChildStop({ mode, client, managed, provider, runtimeOwner, executionHost, replaceController,
  directory, dataDirectory, databasePath, environment, observations }) {
  const caseID = `compiled-managed-confined-${mode}`, turn = createConfinedChildTurn(caseID, mode), files = Object.values(turn.files);
  const model = { providerID: 'devryan-smoke', modelID: 'smoke-write' }, runtime = managed.getManagedRuntime(), harness = executionHost.runtime;
  await provider.setResponder(turn.responder);
  const root = await client.sessions.create({ title: `Compiled managed confined ${mode}`, agent: 'orchestrator', model }, { directory });
  await managed.admitPrimary(root.id);
  const before = await snapshotFiles(directory, files);
  assert.deepEqual(Object.values(before), [null, null], 'Confined child fixture files already exist in the project');
  await client.prompts.prompt(root.id, { messageID: createV2MessageId(), agent: 'orchestrator', model, variant: 'default',
    parts: [{ type: 'text', text: turn.marker }] }, { directory, origin: 'native_acceptance', delivery: 'queue', timeoutMs: 30_000 });
  const task = await waitFor(async () => (await runtime.getSnapshot({ rootSessionId: root.id })).tasks[0],
    value => value?.status === 'running' && value.childSessionId, 'Confined managed task did not run');
  const scope = { directory, sessionID: task.childSessionId, callID: turn.callIDs.shellID };
  const lease = await waitFor(() => harness.leaseForCall(scope), value => value?.executionKind === 'process' && value.state === 'ready'
    && typeof value.viewDirectory === 'string', 'Managed child confined shell never claimed its process lease', 60_000);
  const readyFile = path.join(await fs.realpath(lease.viewDirectory), turn.files.ready);
  const pid = Number(await waitFor(() => fs.readFile(readyFile, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; }),
    text => /^\d+\n$/.test(text), 'Confined child descendant never reported ready', 60_000));
  assert.ok(Number.isSafeInteger(pid) && pid > 1 && !processGone(pid), 'Confined child descendant was not alive before Stop');
  await waitFor(() => client.sessions.messages(root.id, {}, { directory }), page => page.records.flatMap(row => row.parts ?? [])
    .some(part => part.type === 'tool' && part.callID === turn.callIDs.waitID), 'Confined parent never entered its actual managed wait');
  const readTask = () => readDurableTask(dataDirectory, task.taskId);
  const original = await readTask();
  assert.equal(original.executionBackend, 'native-job'); assert.equal(original.nativeJobSegments.length, 1);
  const [segment] = original.nativeJobSegments;
  assert.equal(observations.some(row => row.callID === scope.callID && row.phase === 'termination_verified'), false,
    'Confined child terminated before Stop');
  const db = resolveSqliteDriver().open(databasePath, { readonly: true });
  // The supervisor's own receipt, the cancelled lease with no publication, the
  // real descendant gone and the project unchanged.
  const assertStopped = async () => {
    // The host reports the outcome only after cancelling the lease, recording
    // its empty change receipt and removing its view.
    await waitFor(async () => observations.some(row => row.callID === scope.callID && row.phase === 'discarded'), Boolean,
      'Confined child process run never settled', 30_000);
    const stopped = await harness.leaseForCall(scope);
    assert.equal(stopped?.token, lease.token); assert.equal(stopped.state, 'cancelled', 'Confined child lease did not settle cancelled');
    const receipt = await readSessionExecutionReceipt(stopped);
    assert.deepEqual([receipt.terminated, receipt.confined, receipt.cancelled], [true, true, true], 'Confined child receipt is not a verified cancellation');
    await assertWriterOutcome({ runtime: harness, directory, sessionID: scope.sessionID, callID: scope.callID, observations, before, files, succeeded: false });
    await waitFor(() => processGone(pid), Boolean, 'Confined child descendant survived verified termination', 5_000);
    return { receipt, stoppedBy: stopped.stoppedBy ?? null };
  };
  const ackEvidence = [], transport = managed.nativeManagedJobs, acknowledge = transport.acknowledge;
  transport.acknowledge = async input => {
    if (input.taskId === task.taskId) {
      const current = await readTask();
      ackEvidence.push({ status: current?.status, completion: current?.nativeJobSegments?.[0]?.completion,
        drained: observations.some(row => row.callID === scope.callID && row.phase === 'termination_verified') });
    }
    return acknowledge(input);
  };
  let stopped, restoreBarrier, nativeState;
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM job WHERE id=? AND notification_id=?').get(segment.jobID, segment.notificationID).n, 1);
    if (mode === 'cancel') {
      const abort = new AbortController(), acknowledged = Promise.withResolvers(), release = Promise.withResolvers();
      void acknowledged.promise.catch(() => {});
      let ackCalls = 0;
      restoreBarrier = installManagedJobCancelAckBarrier({ nativeManagedJobs: transport, taskID: task.taskId, sessionID: task.childSessionId,
        release: release.promise, signal: abort.signal, afterAck: async () => {
          try {
            assert.equal(++ackCalls, 1, 'Native cancelTask receipt repeated');
            // Native drainage: interrupted assistant and tool, interrupted idle, runner claim released.
            nativeState = await assertNativeCancellationSettled({ databasePath, environment, sessionID: scope.sessionID, callID: scope.callID, observations });
            const held = await readTask();
            assert.equal(terminalTask(held), false, 'Managed task settled before its native cancellation receipt was released');
            assert.notEqual(held.nativeJobSegments[0].completion, 'done', 'Native completion recorded before cancellation was acknowledged');
            assert.equal(ackEvidence.length, 0, 'Native job acknowledged before its cancellation receipt was released');
            assert.equal(turn.inspect().waitResults, 0, 'Parent wait resumed before the native cancellation receipt');
            acknowledged.resolve();
          } catch (error) { acknowledged.reject(error); throw error; }
        } });
      let cancelling;
      try {
        cancelling = runtime.handleRpc({ method: 'cancel', params: { taskId: task.taskId, rootSessionId: root.id, directory,
          reason: 'Compiled confined managed child Stop' } });
        cancelling.catch(error => { abort.abort(error); acknowledged.reject(error); });
        await settleWithin(acknowledged.promise, 60_000, 'Native cancelTask receipt never arrived for the confined child');
      } finally { release.resolve(); }
      await cancelling;
      stopped = await assertStopped();
      assert.equal(stopped.stoppedBy, 'task_settled', 'Confined child run was not stopped by its settled attempt');
      const cleaned = await waitFor(async () => observations.find(row => row.phase === 'task_run_cleanup' && row.taskID === task.taskId
        && row.state === 'done'), Boolean, 'Settled attempt run cleanup was not recorded', 10_000);
      assert.equal(cleaned.stopped, 1, 'Settled attempt run cleanup did not stop exactly the confined run');
    } else {
      const { previous, exit, replacement } = await replaceController();
      assert.equal(exit.receipt?.terminated, true); assert.equal(exit.receipt?.confined, true);
      assert.notEqual(replacement.instanceID, previous.instanceID); assert.equal(runtimeOwner.isReady(), true);
      stopped = await assertStopped();
    }
    const settled = await waitFor(readTask, value => value?.status === turn.expected && value.nativeJobSegments?.[0]?.completion === 'done',
      'Confined child terminal result or its durable completion receipt did not settle', 20_000);
    assert.equal(settled.childSessionId, task.childSessionId); assert.equal(settled.nativeJobSegments.length, 1);
    for (const field of ['jobID', 'notificationID', 'messageID']) assert.equal(settled.nativeJobSegments[0][field], segment[field]);
    // Completion is recorded only after drainage and the native acknowledgement.
    assert.ok(ackEvidence.length >= 1, 'Native job completion was never acknowledged');
    assert.deepEqual([ackEvidence.at(-1).status, ackEvidence.at(-1).completion], [turn.expected, 'pending'],
      'Native acknowledgement preceded the terminal task or followed its own completion record');
    const at = predicate => observations.findIndex(predicate);
    const terminatedAt = at(row => row.callID === scope.callID && row.phase === 'termination_verified');
    const terminalAt = at(row => row.phase === 'managed_event' && row.properties?.task?.taskId === task.taskId && terminalTask(row.properties.task));
    const ackAt = at(row => row.phase === 'compiled_native_job_ack' && row.taskID === task.taskId && row.outcome === 'succeeded');
    assert.ok(terminatedAt >= 0 && terminalAt >= 0 && ackAt > terminalAt, 'Native acknowledgement preceded the terminal publication');
    if (mode === 'restart') assert.ok(terminalAt > terminatedAt && ackEvidence.at(-1).drained,
      'Controller death published the interruption before the confined process was terminated');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM job WHERE id=? OR notification_id=?').get(segment.jobID, segment.notificationID).n, 0);
    assert.equal(turn.inspect().childRequests, 1, 'Stopped confined child replayed its provider turn');
    const child = await client.sessions.messages(task.childSessionId, {}, { directory });
    assert.equal(child.records.filter(row => row.info.role === 'user').length, 1, 'Stopped confined child duplicated accepted input');
    assert.equal(child.records.filter(row => row.info.role === 'user')[0].info.id, segment.messageID);
    if (mode === 'cancel') {
      await waitFor(() => client.sessions.messages(root.id, {}, { directory }), page => page.records.some(row => row.info.role === 'assistant'
        && row.info.time?.completed && row.parts.some(part => part.type === 'text' && part.text === turn.expectedText)),
      'Stopped confined result did not reach the actual parent wait', 30_000);
      const retained = await runtime.getSnapshot({ rootSessionId: root.id });
      assert.equal(retained.resultEnvelopes[0].action, null); assert.equal(retained.resultEnvelopes[0].acknowledgedAt, null);
    }
    const parent = await client.sessions.messages(root.id, {}, { directory });
    assert.equal(parent.records.filter(row => row.info.role === 'user').length, 1);
    assert.equal(parent.records.some(row => row.info.id === segment.notificationID), false);
    assert.deepEqual(await snapshotFiles(directory, files), before, 'Stopped confined child published project changes');
    assert.deepEqual(await harness.activeLeases({ directory, sessions: [root.id, task.childSessionId] }), []);
    return { id: caseID, status: 'passed', rootSessionID: root.id, childSessionID: task.childSessionId, taskID: task.taskId,
      jobID: segment.jobID, leaseToken: lease.token, descendantPID: pid, stoppedBy: stopped.stoppedBy,
      receipt: { terminated: stopped.receipt.terminated, confined: stopped.receipt.confined, cancelled: stopped.receipt.cancelled,
        exitCode: stopped.receipt.exitCode }, ...(nativeState ? { nativeIdleOutcome: nativeState.idleOutcome } : {}),
      source: mode === 'cancel' ? 'actual-native-job-stop-native-drain-before-ack-then-settled-attempt-run-cleanup'
        : 'actual-controller-death-confined-process-receipt-before-interruption-and-completion' };
  } finally { restoreBarrier?.(); transport.acknowledge = acknowledge; db.close(); }
}

/** Actual compiled Job rows, native child execution and durable scheduler receipts. */
export async function runCompiledManagedJobs({ client, managed, provider, runtimeOwner, executionHost,
  replaceController, directory, dataDirectory, databasePath, environment, observations }) {
  assert.equal(runtimeOwner.nativeManagedJobs.available(), true, 'Selected compiled artifact lacks the managed-job contract');
  const caseID = 'compiled-managed-subagent-job', turn = createCollectedManagedJobTurn(caseID);
  const model = { providerID: 'devryan-smoke', modelID: 'smoke-write' };
  const root = await client.sessions.create({ title: 'Compiled managed subagent job', agent: 'orchestrator', model }, { directory });
  await managed.admitPrimary(root.id);
  const db = resolveSqliteDriver().open(databasePath, { readonly: true }), observed = new Map();
  const sample = () => {
    for (const row of db.prepare('SELECT id,notification_id,child_session_id,recovery,status FROM job WHERE session_id=? AND kind=?').all(root.id, 'subagent')) {
      observed.set(row.id, row);
    }
  };
  const sampler = setInterval(sample, 5);
  try {
    // Keep the real child provider request open until its durable native job is
    // independently visible; no polling interval can fabricate that evidence.
    await provider.setResponder(async request => {
      const child = request.body.messages.some(message => message.role === 'user'
        && JSON.stringify(message.content).includes(turn.childMarker) && !JSON.stringify(message.content).includes(turn.marker));
      if (child) await waitFor(() => { sample(); return observed.size; }, count => count === 1,
        'Compiled managed child ran before its durable native Job row existed', 10_000);
      return turn.responder(request);
    });
    const messageID = createV2MessageId();
    await client.prompts.prompt(root.id, { messageID, agent: 'orchestrator', model, variant: 'default',
      parts: [{ type: 'text', text: turn.marker }] }, { directory, origin: 'native_acceptance', delivery: 'queue', timeoutMs: 30_000 });
    const parent = await waitFor(() => client.sessions.messages(root.id, {}, { directory }), page => page.records.some(row => row.info.role === 'assistant'
      && row.info.time?.completed && row.parts?.some(part => part.type === 'text' && part.text === `completed ${caseID}`)),
    'Compiled managed job failed to complete its real parent tool continuation', 60_000);
    const proof = turn.complete(), snapshot = await managed.getManagedRuntime().getSnapshot({ rootSessionId: root.id });
    assertDurableCollection(JSON.parse(await fs.readFile(path.join(dataDirectory, 'orchestration', 'ledger.json'), 'utf8')), proof);
    assert.equal(snapshot.tasks.length, 1); const [task] = snapshot.tasks;
    assert.equal(task.taskId, proof.taskID); assert.equal(task.status, 'completed');
    assert.equal(snapshot.resultEnvelopes[0].action, 'continue'); assert.ok(Number.isFinite(snapshot.resultEnvelopes[0].acknowledgedAt));
    assert.equal((await client.sessions.get(task.childSessionId, { directory })).parentID, root.id);
    const durable = await waitFor(async () => {
      const ledger = JSON.parse(await fs.readFile(path.join(dataDirectory, 'orchestration', 'ledger.json'), 'utf8'));
      return ledger.tasks.find(value => value.taskId === task.taskId);
    }, value => value?.nativeJobSegments?.length === 1 && value.nativeJobSegments[0].completion === 'done',
    'Compiled managed terminal publication did not consume its exact native Job receipt', 10_000);
    assert.equal(durable.executionBackend, 'native-job');
    const [segment] = durable.nativeJobSegments, row = observed.get(segment.jobID);
    assert.ok(row, 'Original compiled managed Job row was never observed');
    assert.equal(observed.size, 1, 'A clean managed task created more than one native Job');
    assert.equal(row.notification_id, segment.notificationID); assert.equal(row.child_session_id, task.childSessionId);
    const recovery = JSON.parse(row.recovery);
    assert.deepEqual([recovery.kind, recovery.parentSessionID, recovery.childSessionID, recovery.description],
      ['subagent', root.id, task.childSessionId, task.taskId]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM job WHERE id=? OR notification_id=?').get(segment.jobID, segment.notificationID).n, 0);
    assert.equal(parent.records.filter(row => row.info.role === 'user').length, 1, 'Native Job injected another parent input');
    assert.equal(parent.records.some(row => row.info.id === segment.notificationID), false);
    assert.equal((await managed.readPrimaryRecord(root.id)).anchorID, messageID);
    await assertWriterOutcome({ runtime: executionHost.runtime, directory, sessionID: task.childSessionId,
      callID: proof.childWriterCallID, observations, succeeded: true });
    assert.equal(await fs.readFile(path.join(directory, proof.childWriterFile), 'utf8'), `managed writer ${caseID}\n`);
    const result = { id: 'compiled-managed-subagent-job', status: 'passed', rootSessionID: root.id, childSessionID: task.childSessionId,
      taskID: task.taskId, jobID: segment.jobID, notificationID: segment.notificationID,
      source: 'original-compiled-native-job-row-child-writer-parent-result-and-durable-receipt' };
    clearInterval(sampler);
    const adverse = [];
    for (const mode of ['cancel', 'restart']) adverse.push(await runAdverseManagedJob({ mode, client, managed, provider,
      runtimeOwner, executionHost, replaceController, directory, dataDirectory, databasePath }));
    adverse.push(await runLostActivationReply({ client, managed, provider, directory, dataDirectory, databasePath }));
    for (const mode of ['cancel', 'restart']) adverse.push(await runConfinedChildStop({ mode, client, managed, provider, runtimeOwner,
      executionHost, replaceController, directory, dataDirectory, databasePath, environment, observations }));
    return [result, ...adverse];
  } finally { clearInterval(sampler); db.close(); }
}
