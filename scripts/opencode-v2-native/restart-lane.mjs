import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createV2MessageId } from '../../packages/web/server/lib/opencode/v2/admission.js';
import { assertWriterOutcome, snapshotFiles } from './assertions.mjs';
import { waitFor } from './process-lanes.mjs';

const runFile = promisify(execFile);

// The fixture owns this database. Read its actual native KV row without adding
// a product debug endpoint or replacing native background-job behavior.
export async function nativeBackgroundMarkerCount(databasePath, notificationID, environment) {
  assert.match(notificationID, /^msg_[A-Za-z0-9]+$/);
  const { stdout } = await runFile('/usr/bin/sqlite3', ['-readonly', databasePath,
    `SELECT count(*) FROM kv WHERE key='job.background/${notificationID}';`],
  { env: environment, timeout: 5_000, maxBuffer: 4096 });
  assert.match(stdout.trim(), /^(?:0|1)$/);
  return Number(stdout.trim());
}

export async function runPendingBackgroundRestart({ begin, settle, restartNative, getNativeControl, admissionOwner,
  executionHost, client, directory, sessionID, observations, databasePath, environment }) {
  const id = 'pending-background-restart', callID = `native_${id}`, runtime = executionHost.runtime;
  const scenario = { id, tool: 'shell', input: { command: "sleep 0.5; printf 'pending native shell\\n' > pending-background.txt" } };
  assert.equal((await runtime.nativeAdmissionState({ directory, sessionID })).held, false);
  await begin(scenario, { backgroundRestart: true });
  const held = await waitFor(async () => (await getNativeControl().call({ action: 'background-restart-state' })).result,
    value => value.held === true, 'Native completed notice did not reach its pre-chunk model boundary');
  const lease = await waitFor(() => runtime.leaseForCall({ directory, sessionID, callID }),
    value => value?.state === 'published' && value.nativeShellJob?.deliveredID, 'Native background lease did not publish its notification');
  await assertWriterOutcome({ runtime, directory, sessionID, callID, observations, succeeded: true });
  const binding = lease.nativeShellJob;
  assert.equal(binding.jobID, held.shellID);
  assert.equal(binding.notificationID, binding.deliveredID);
  assert.equal(binding.continuedID, undefined);
  assert.equal(binding.continuedAssistantID, undefined);
  await waitFor(async () => observations.find(row => row.phase === 'native_shell_ack_released'
    && row.sessionID === sessionID && row.jobID === binding.jobID), Boolean, 'Native background acknowledgement never released');
  assert.equal(observations.some(row => row.phase === 'native_shell_marker_present' && row.sessionID === sessionID
    && row.jobID === binding.jobID && row.notificationID === binding.notificationID), true,
  'The exact native terminal background marker was not observed before acknowledgement');
  assert.equal(await nativeBackgroundMarkerCount(databasePath, binding.notificationID, environment), 0,
    'Native background marker remained after completeBackground');
  const intent = `shell.complete:${binding.jobID}`;
  assert.equal((await runtime.nativeShellContinuations({ directory })).some(row => row.sessionID === sessionID && row.operation === intent), true);
  const messages = (await client.sessions.messages(sessionID, {}, { directory })).records;
  const notices = messages.filter(row => row.info.id === binding.deliveredID && row.info.role === 'user');
  assert.equal(notices.length, 1);
  assert.equal(messages.some(row => row.info.role === 'assistant' && row.info.parentID === binding.deliveredID), false,
    'Native continuation already produced an assistant before the crash');
  const originalTools = messages.flatMap(row => row.parts ?? []).filter(part => part.type === 'tool' && part.callID === callID);
  assert.equal(originalTools.length, 1);
  const receiptsBefore = observations.filter(row => row.phase === 'termination_verified' && row.callID === callID).length;
  const startsBefore = observations.filter(row => row.phase === 'execution_requested' && row.callID === callID).length;
  const bytes = await snapshotFiles(directory, ['pending-background.txt']);
  assert.equal(await fs.readFile(path.join(directory, 'pending-background.txt'), 'utf8'), 'pending native shell\n');
  assert.equal((await runtime.nativeAdmissionState({ directory, sessionID })).held, false);
  const controller = await restartNative({ crash: true, beforeOpen: async replacement => {
    assert.equal((await runtime.nativeAdmissionState({ directory, sessionID })).held, false);
    await replacement.call({ action: 'resume-background-restart', caseID: id, shellID: binding.jobID });
  } });
  assert.equal(controller.remainingProcessIds.length, 0);
  const call = await settle(scenario);
  assert.equal(call.state.status, 'completed');
  const consumed = await waitFor(() => runtime.leaseForCall({ directory, sessionID, callID }),
    value => Boolean(value?.nativeShellJob?.continuedAssistantID), 'Replacement did not durably acknowledge the real assistant step');
  for (const key of ['jobID', 'notificationID', 'deliveredID']) assert.equal(consumed.nativeShellJob[key], binding[key]);
  assert.equal(consumed.nativeShellJob.continuedID, binding.deliveredID);
  assert.equal(consumed.token, lease.token);
  assert.deepEqual(consumed.result, lease.result);
  const finalMessages = (await client.sessions.messages(sessionID, {}, { directory })).records;
  const final = finalMessages.filter(row => row.info.role === 'assistant' && row.info.parentID === binding.deliveredID);
  assert.equal(final.length, 1);
  assert.equal(final[0].info.id, consumed.nativeShellJob.continuedAssistantID);
  assert.equal(final[0].turnOwnership?.source, 'native-sequence');
  assert.equal(final[0].turnOwnership?.userMessageID, binding.deliveredID);
  assert.ok(Number.isFinite(final[0].info.time?.completed));
  assert.equal(finalMessages.filter(row => row.info.id === binding.deliveredID).length, 1);
  assert.equal(finalMessages.flatMap(row => row.parts ?? []).filter(part => part.type === 'tool' && part.callID === callID).length, 1);
  assert.equal((await runtime.nativeShellContinuations({ directory })).some(row => row.sessionID === sessionID && row.operation === intent), false);
  await admissionOwner.recoverShellContinuations({ directory });
  assert.deepEqual((await client.sessions.messages(sessionID, {}, { directory })).records.map(row => row.info.id), finalMessages.map(row => row.info.id),
    'Repeated same-ledger recovery duplicated native messages');
  assert.equal(observations.filter(row => row.phase === 'termination_verified' && row.callID === callID).length, receiptsBefore);
  assert.equal(observations.filter(row => row.phase === 'execution_requested' && row.callID === callID).length, startsBefore);
  assert.deepEqual(await snapshotFiles(directory, ['pending-background.txt']), bytes);
  assert.equal(await nativeBackgroundMarkerCount(databasePath, binding.notificationID, environment), 0);
  assert.equal((await runtime.nativeAdmissionState({ directory, sessionID })).held, false);
  return { id: 'pending-background-native-marker-restart', status: 'passed', jobID: binding.jobID,
    notificationID: binding.notificationID, assistantMessageID: final[0].info.id, controller,
    source: 'actual-native-KV-removal-and-same-ledger-continuation-recovery' };
}

export async function runControllerCrashHold({ begin, invoke, restartNative, getNativeControl, admissionOwner,
  executionHost, client, directory, sessionID, observations }) {
  const id = 'controller-crash';
  const before = await snapshotFiles(directory, ['crash-unpublished.txt']);
  await begin({ id, tool: 'shell', input: { command: "printf 'DEVRYAN_CONTROLLER_CRASH_READY\\n'; sleep 60; printf 'must not publish\\n' > crash-unpublished.txt", timeout: 0 } });
  await waitFor(async () => observations.filter(value => value.callID === `native_${id}` && value.phase === 'execution_output')
    .map(value => value.text).join(''), text => text.includes('DEVRYAN_CONTROLLER_CRASH_READY'), 'Native crash fixture command never started');
  await admissionOwner.handleRpc('native.admission.hold', { sessionID });
  const held = await executionHost.runtime.nativeAdmissionState({ directory, sessionID });
  assert.equal(held.held, true);
  await getNativeControl().call({ action: 'cancelled' });
  const controller = await restartNative({ crash: true, afterExit: async () => {
    const settled = await executionHost.nativeExecution({ action: 'cancel-sessions', sessions: [sessionID] });
    assert.equal(settled.processesTerminated, true);
    await assertWriterOutcome({ runtime: executionHost.runtime, directory, sessionID, observations,
      callID: `native_${id}`, before, files: ['crash-unpublished.txt'], succeeded: false });
  } });
  assert.equal(controller.remainingProcessIds.length, 0, 'Crashed controller descendants survived');
  const restarted = await executionHost.runtime.nativeAdmissionState({ directory, sessionID });
  assert.equal(restarted.held, true, 'Native restart lost its durable web admission hold');
  assert.deepEqual(restarted.holds, held.holds, 'Native restart replaced the persisted hold identity');
  await assert.rejects(client.prompts.prompt(sessionID, { messageID: createV2MessageId(), parts: [{ type: 'text', text: 'must remain held' }] },
    { directory, origin: 'native_acceptance', timeoutMs: 10_000 }), error => error.code === 'native_session_held' || /native_session_held/.test(error.message));
  assert.equal((await executionHost.runtime.nativeAdmissionState({ directory, sessionID })).held, true);
  await getNativeControl().call({ action: 'release', sessionID });
  const fresh = { id: 'after-controller-restart', tool: 'write', input: { path: 'after-restart.txt', content: 'fresh after owned crash\n' } };
  const call = await invoke(fresh);
  assert.equal(call.state.status, 'completed');
  await assertWriterOutcome({ runtime: executionHost.runtime, directory, sessionID, observations, callID: `native_${fresh.id}`, succeeded: true });
  assert.equal(await fs.readFile(path.join(directory, 'after-restart.txt'), 'utf8'), 'fresh after owned crash\n');
  return { id: 'controller-crash-durable-hold-restart', status: 'passed', controller,
    source: 'controller-OS-exit-and-independent-supervisor-receipt', revisionBefore: held.revision, revisionAfter: restarted.revision };
}
