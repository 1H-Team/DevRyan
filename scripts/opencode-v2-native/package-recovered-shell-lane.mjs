import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSqliteDriver } from '../../packages/web/server/lib/opencode/db-maintenance-core.js';
import { createV2MessageId } from '../../packages/web/server/lib/opencode/v2/admission.js';
import { recoveredInputHash } from '../../packages/web/server/lib/opencode/runtime-host/native-recovered-input-hash.js';
import { assertWriterOutcome, backgroundShellTurn, snapshotFiles } from './assertions.mjs';
import { backgroundRestartTurn } from './background-restart-turn.mjs';
import { waitFor } from './process-lanes.mjs';

/** Genuine accepted synthetic notice held before promotion, then recovered by
 * the existing shell lease/receipt owner through two compiled replacements. */
export async function runCompiledRecoveredShell({ provider, client, managed, runtimeOwner, getController,
  directory, databasePath, executionHost, observations, onCase, onExit }) {
  assert.ok(Array.isArray(observations), 'Shell restart requires actual execution observations');
  const cache = path.join(fileURLToPath(new URL('../../', import.meta.url)), '.cache');
  for (const file of [directory, databasePath]) {
    assert.ok(typeof file === 'string' && (await fs.realpath(file)).startsWith(`${cache}${path.sep}`), 'Shell recovery fixture must remain repository-owned');
  }
  const id = 'compiled-retained-shell-notification', callID = `native_${id}`;
  const objectiveID = createV2MessageId(), filename = `retained-shell-${objectiveID}.txt`;
  assert.match(objectiveID, /^msg_[A-Za-z0-9]+$/);
  const releaseName = `retained-shell-release-${objectiveID}`;
  const content = `compiled retained shell ${objectiveID}\n`, command = `retained_wait=0; while [ ! -f "$TMPDIR/${releaseName}" ]; do retained_wait=$((retained_wait + 1)); [ "$retained_wait" -le 600 ] || exit 70; sleep 0.1; done; printf '${content.replace('\n', '\\n')}' >> ${filename}`;
  const model = { providerID: 'devryan-smoke', modelID: 'smoke-write' }, runtime = executionHost.runtime;
  const session = await client.sessions.create({ title: 'Compiled retained shell notification', agent: 'orchestrator', model }, { directory });
  await managed.admitPrimary(session.id);
  assert.equal((await snapshotFiles(directory, [filename]))[filename], null);
  const initial = backgroundShellTurn(id, { command });
  let initialRequests = 0, initialReturned = false, blocked = false, sealed;
  const owner = runtimeOwner.nativeOwner, originalRpc = owner.handleRpc;
  const gate = Promise.withResolvers();void gate.promise.catch(() => {});
  const originalExecution = executionHost.nativeExecution;
  executionHost.nativeExecution = (input, context) => {
    if (input.action === 'start' && input.sessionID === session.id && input.callID === callID) observations.push({
      phase: 'execution_requested', sessionID: input.sessionID, callID: input.callID });
    return originalExecution(input, context);
  };
  const executionCounts = () => Object.fromEntries(['execution_requested', 'termination_verified', 'published'].map(phase =>
    [phase, observations.filter(row => row.phase === phase && row.sessionID === session.id && row.callID === callID).length]));
  let controllerExits = 0, row, releasePath, releaseLease, failure, releasedAfterIdle = false;
  const exitController = async () => {
    const previous = getController(), exit = await previous.killForRecovery();
    assert.equal(previous.hasExited(), true);assert.equal(exit.receipt?.terminated, true);assert.equal(exit.receipt?.confined, true);
    controllerExits++;onExit?.(exit);
    return previous;
  };
  const inbox = async () => {
    const response = await fetch(new URL(`/api/session/${session.id}/inbox`, getController().url), {
      headers: runtimeOwner.getAuthHeaders(), signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.status, 200);
    const value = await response.json();assert.ok(Array.isArray(value.data));return value.data;
  };
  const messages = () => client.sessions.messages(session.id, {}, { directory });
  const idle = () => waitFor(() => client.sessions.status({ directory }),
    value => !value[session.id] || value[session.id].type === 'idle', 'Retained shell session remained busy');
  owner.handleRpc = async (method, input) => {
    if (method === 'native.admission.authorize' && input.operation === 'shell.continue' && input.sessionID === session.id && releasedAfterIdle) {
      const lease = await runtime.leaseForCall({ directory, sessionID: session.id, callID });
      if (lease?.state === 'published' && lease.nativeShellJob?.notificationID
        && lease.nativeShellJob.deliveredID === lease.nativeShellJob.notificationID && lease.nativeShellJob.itemHash) {
        sealed = structuredClone(lease);blocked = true;await gate.promise;
      }
    }
    return originalRpc(method, input);
  };
  try {
    await provider.setResponder(request => {
      initialRequests++;assert.ok(initialRequests <= 2, 'Completion inferred before the retained notification continuation gate');
      const response = initial.responder(request);
      if (response.items.some(item => item.type === 'textDelta' && item.text === `background launched ${id}`)) initialReturned = true;
      return response;
    });
    await client.prompts.prompt(session.id, { messageID: objectiveID, agent: 'orchestrator', model, variant: 'default',
      parts: [{ type: 'text', text: initial.marker }] }, { directory, delivery: 'queue', timeoutMs: 30000 });
    releaseLease = await waitFor(() => runtime.leaseForCall({ directory, sessionID: session.id, callID }),
      value => Boolean(value?.nativeShellJob?.jobID), 'Original background shell lease did not start');
    const view = await fs.realpath(releaseLease.viewDirectory), leaseRoot = path.dirname(view);
    assert.ok(view.startsWith(`${cache}${path.sep}`));assert.equal(path.basename(view), 'worktree');
    assert.equal(path.basename(leaseRoot), releaseLease.token);assert.equal(path.basename(path.dirname(leaseRoot)), 'views');
    const scratch = await fs.realpath(path.join(leaseRoot, 'scratch'));
    assert.equal(scratch, path.join(leaseRoot, 'scratch'));assert.ok(scratch.startsWith(`${cache}${path.sep}`));
    releasePath = path.join(scratch, releaseName);
    // A steer can be consumed by the original drain without a second runner
    // admission. Let that actor settle before the actual process completes.
    await waitFor(messages, page => page.records.some(row => row.info.role === 'assistant'
      && row.info.parentID === objectiveID && row.info.time?.completed
      && row.parts.some(part => part.type === 'text' && part.text === `background launched ${id}`)), 'Original background launch did not complete');
    await idle();assert.equal(initialReturned, true);assert.equal(initialRequests, 2);
    releasedAfterIdle = true;
    await fs.writeFile(releasePath, '', { flag: 'wx', mode: 0o600 }).catch(error => { releasedAfterIdle = false;throw error; });
    await waitFor(() => blocked, Boolean, 'Sealed background notice did not reach departing continuation gate');
    const lease = await waitFor(() => runtime.leaseForCall({ directory, sessionID: session.id, callID }),
      value => value?.state === 'published' && value.nativeShellJob?.deliveredID, 'Accepted shell notice lost its committed acknowledgement');
    const binding = structuredClone(lease.nativeShellJob);
    assert.equal(initialRequests, 2);assert.equal(initialReturned, true);assert.equal(sealed.token, lease.token);
    assert.equal(binding.deliveredID, binding.notificationID);assert.equal(binding.itemDelivery, 'steer');assert.match(binding.itemHash, /^[a-f0-9]{64}$/);
    assert.equal(binding.command, command);assert.equal(binding.continuedID, undefined);assert.equal(binding.continuedAssistantID, undefined);
    const pending = await inbox();assert.equal(pending.length, 1);
    const notice = pending[0];assert.equal(notice.id, binding.notificationID);assert.equal(notice.sessionID, session.id);
    assert.equal(notice.type, 'synthetic');assert.equal(notice.delivery, binding.itemDelivery);
    assert.equal(recoveredInputHash({ type: notice.type, delivery: notice.delivery, payload: notice.payload }), binding.itemHash);
    assert.ok(notice.payload.text.includes(`<shell id="${binding.jobID}" state="completed"`));
    const before = (await messages()).records;
    assert.equal(before.some(row => row.info.id === binding.notificationID), false, 'Held notice already became a canonical user');
    assert.equal(before.filter(row => row.info.role === 'user' && row.info.id === objectiveID).length, 1);
    assert.equal(before.flatMap(row => row.parts ?? []).filter(part => part.type === 'tool' && part.callID === callID).length, 1);
    const originalAssistant = before.filter(row => row.info.role === 'assistant' && row.info.parentID === objectiveID).at(-1);
    assert.ok(originalAssistant?.info.time?.completed, 'Original background caller assistant remained unfinished');
    await idle();
    const primaryBefore = await managed.primaryRuntime.readRecord(session.id);assert.equal(primaryBefore.anchorID, objectiveID);
    const proof = await executionHost.nativeShellJobReceipt({ directory, sessionID: session.id, jobID: binding.jobID });
    assert.equal(proof.lease.token, lease.token);assert.equal(proof.receipt.terminated, true);assert.equal(proof.receipt.confined, true);assert.equal(proof.receipt.exitCode, 0);
    await assertWriterOutcome({ runtime, directory, sessionID: session.id, callID, observations, succeeded: true });
    const counts = executionCounts();assert.deepEqual(counts, { execution_requested: 1, termination_verified: 1, published: 1 });
    const receipt = structuredClone(proof.receipt), bytes = await snapshotFiles(directory, [filename]);
    assert.equal(await fs.readFile(path.join(directory, filename), 'utf8'), content);
    // Original SDK inbox events use persist:false. This exact accepted item has
    // no enqueue EventTable record; its real lease seal is the restart proof.
    const db = resolveSqliteDriver().open(databasePath, { readonly: true });
    let enqueueEvents;
    try { enqueueEvents = db.prepare(`SELECT id FROM event WHERE aggregate_id=? AND type IN ('session.inbox.enqueued.1','session.inbox.enqueued')
      AND json_extract(data,'$.inboxID')=? LIMIT 2`).all(session.id, binding.notificationID); }
    finally { db.close(); }
    assert.deepEqual(enqueueEvents, []);
    const intent = `shell.complete:${binding.jobID}`;
    assert.equal((await runtime.nativeShellContinuations({ directory })).some(row => row.sessionID === session.id && row.operation === intent), true);
    const previous = await exitController();
    gate.reject(new Error('fixture_retained_shell_controller_closed'));owner.handleRpc = originalRpc;
    const resumed = backgroundRestartTurn(id, undefined, { resumeShellID: binding.jobID });
    let continuationRequests = 0;
    await provider.setResponder(request => { continuationRequests++;return resumed.responder(request); });
    const replacement = await runtimeOwner.start();assert.notEqual(replacement.instanceID, previous.instanceID);assert.equal(runtimeOwner.isReady(), true);
    const finished = await waitFor(messages, page => page.records.some(row => row.info.role === 'assistant'
      && row.info.parentID === binding.notificationID && row.info.time?.completed
      && row.parts.some(part => part.type === 'text' && part.text === `completed ${id}`)), 'Replacement did not consume exact retained shell notice', 60000);
    await idle();assert.equal(resumed.complete().shellID, binding.jobID);assert.equal(continuationRequests, 1);assert.deepEqual(await inbox(), []);
    const notices = finished.records.filter(row => row.info.id === binding.notificationID);
    assert.equal(notices.length, 1);assert.equal(notices[0].info.role, 'user');
    const assistants = finished.records.filter(row => row.info.role === 'assistant' && row.info.parentID === binding.notificationID);
    assert.equal(assistants.length, 1);assert.equal(assistants[0].turnOwnership?.source, 'native-sequence');assert.equal(assistants[0].turnOwnership?.userMessageID, binding.notificationID);
    const consumed = await waitFor(() => runtime.leaseForCall({ directory, sessionID: session.id, callID }),
      value => Boolean(value?.nativeShellJob?.continuedAssistantID), 'Retained shell continuation lacks canonical started acknowledgement');
    for (const key of ['jobID', 'command', 'notificationID', 'deliveredID', 'itemHash', 'itemDelivery']) assert.equal(consumed.nativeShellJob[key], binding[key]);
    assert.equal(consumed.nativeShellJob.continuedID, binding.notificationID);assert.equal(consumed.nativeShellJob.continuedAssistantID, assistants[0].info.id);
    assert.equal(consumed.token, lease.token);assert.deepEqual(consumed.result, lease.result);assert.equal(consumed.state, lease.state);
    const primaryAfter = await managed.primaryRuntime.readRecord(session.id);
    assert.equal(primaryAfter.anchorID, objectiveID);assert.equal(primaryAfter.activeUserID, binding.notificationID);assert.equal(primaryAfter.instanceID, replacement.instanceID);
    for (const key of ['providerID', 'modelID', 'agent', 'variant', 'executionGeneration']) assert.equal(primaryAfter[key], primaryBefore[key]);
    const assertNoReplay = async () => {
      const page = await messages();assert.deepEqual(page.records.map(row => row.info.id), finished.records.map(row => row.info.id));
      assert.equal(page.records.flatMap(row => row.parts ?? []).filter(part => part.type === 'tool' && part.callID === callID).length, 1);
      assert.deepEqual(executionCounts(), counts, 'Shell execution or publication repeated');
      assert.deepEqual(await snapshotFiles(directory, [filename]), bytes);
      const next = await executionHost.nativeShellJobReceipt({ directory, sessionID: session.id, jobID: binding.jobID });
      assert.equal(next.lease.token, lease.token);assert.deepEqual(next.lease.result, lease.result);assert.deepEqual(next.receipt, receipt);
      assert.equal((await runtime.nativeShellContinuations({ directory })).some(row => row.sessionID === session.id && row.operation === intent), false);
      assert.deepEqual(await inbox(), []);
    };
    await assertNoReplay();
    await provider.setResponder(() => { continuationRequests++;assert.fail('Resolved shell notification inferred again after second replacement'); });
    const secondPrevious = await exitController(), second = await runtimeOwner.start();
    assert.notEqual(second.instanceID, secondPrevious.instanceID);assert.equal(runtimeOwner.isReady(), true);await idle();
    await runtimeOwner.nativeOwner.recoverShellContinuations({ directory });await assertNoReplay();
    assert.equal(continuationRequests, 1);assert.equal(initialRequests, 2);provider.check();
    row = { id, status: 'passed', sessionID: session.id, objectiveID, notificationID: binding.notificationID,
      deliveredIDBeforeRestart: binding.deliveredID, itemHash: binding.itemHash, itemDelivery: binding.itemDelivery,
      locationBeforeRestart: 'queued', type: 'synthetic', enqueueEvents: enqueueEvents.length,
      jobID: binding.jobID, assistantMessageID: assistants[0].info.id, filename,
      initialRequests, continuationRequests, executionCounts: counts, oldInstanceID: previous.instanceID, instanceID: replacement.instanceID, secondInstanceID: second.instanceID,
      controllerExits, gateRestored: owner.handleRpc === originalRpc, receiptRetained: true, fileUnchanged: true,
      releasedAfterIdle,
      source: 'actual-compiled-retained-shell-inbox-sealed-lease-and-confined-receipt-automatic-same-id-recovery' };
  } catch (error) { failure = error;throw error; }
  finally {
    gate.reject(new Error('fixture_retained_shell_cleanup'));owner.handleRpc = originalRpc;executionHost.nativeExecution = originalExecution;
    const cleanupErrors = [];
    if (!row && releasePath && !releasedAfterIdle) await fs.writeFile(releasePath, '', { flag: 'wx', mode: 0o600 }).catch(error => {
      if (error.code !== 'EEXIST') cleanupErrors.push(error);
    });
    if (!row && releaseLease?.nativeShellJob?.jobID) await waitFor(async () => {
      const lease = await runtime.leaseForCall({ directory, sessionID: session.id, callID });
      if (!['published', 'cancelled'].includes(lease?.state)) return null;
      return executionHost.nativeShellJobReceipt({ directory, sessionID: session.id, jobID: releaseLease.nativeShellJob.jobID });
    }, value => value?.receipt?.terminated === true
      && value.receipt.confined === true, 'Retained shell cleanup did not settle', 10000).catch(error => {
      cleanupErrors.push(error);
    });
    if (releasePath) await fs.rm(releasePath, { force: true }).catch(error => { cleanupErrors.push(error); });
    if (cleanupErrors.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], 'Retained shell fixture and cleanup failed');
  }
  assert.equal(owner.handleRpc, originalRpc);assert.equal(executionHost.nativeExecution, originalExecution);assert.equal(controllerExits, 2);
  row.observerRestored = true;onCase?.(row);return row;
}
