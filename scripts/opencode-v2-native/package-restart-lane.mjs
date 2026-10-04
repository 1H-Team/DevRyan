import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveSqliteDriver } from '../../packages/web/server/lib/opencode/db-maintenance-core.js';
import { createV2MessageId } from '../../packages/web/server/lib/opencode/v2/admission.js';
import { assertWriterOutcome, snapshotFiles } from './assertions.mjs';
import { waitFor } from './process-lanes.mjs';

const userText = message => typeof message.content === 'string' ? message.content : Array.isArray(message.content)
  ? message.content.filter(part => part.type === 'text').map(part => part.text).join('\n') : '';

/** Holds only model transport before the first continuation chunk; native execution remains real. */
export function createTrackedRestartDriver(id) {
  const callID = `native_${id}`, marker = `[devryan-native-case:${id}]`;
  let issued = false, returned = false, held = false, resumed = false, completed = false, shellID;
  return { callID, marker, state: () => ({ issued, returned, held, resumed, completed, shellID }),
    resume: () => { assert.ok(held && !completed); resumed = true; },
    responder: request => {
      const messages = request.body.messages;
      const result = messages.find(message => message.role === 'tool' && message.tool_call_id === callID);
      if (result && !returned) {
        assert.equal(issued, true); const match = String(result.content).match(/shell ID: ([^)]+)/);
        assert.ok(match, 'Native background tool omitted its actual job identity'); shellID = match[1]; returned = true;
      }
      const notice = shellID && messages.some(message => message.role === 'user'
        && userText(message).includes(`<shell id="${shellID}" state="completed"`));
      if (notice) {
        assert.ok(issued && returned && !completed, 'Unknown or duplicate completion inference');
        held = true;
        if (!resumed) return new Promise(() => {});
        completed = true;
        return { items: [{ type: 'textDelta', text: `completed ${id}` }], reason: 'stop' };
      }
      if (returned) return { items: [{ type: 'textDelta', text: `background launched ${id}` }], reason: 'stop' };
      assert.equal(issued, false); assert.ok(messages.some(message => JSON.stringify(message).includes(marker)));
      assert.ok(request.body.tools.some(tool => tool.function.name === 'shell'));
      issued = true;
      return { items: [{ type: 'toolCall', index: 0, id: callID, name: 'shell', input: {
        command: "sleep 2; printf 'tracked compiled background\\n' > tracked-compiled-background.txt", background: true } }], reason: 'tool-calls' };
    } };
}

export async function runTrackedCompiledReplacement({ provider, client, managed, executionHost, runtimeOwner,
  controller, directory, databasePath, observations, invoke }) {
  const id = 'tracked-compiled-pending-replacement', driver = createTrackedRestartDriver(id), runtime = executionHost.runtime;
  const model = { providerID: 'devryan-smoke', modelID: 'smoke-write' };
  const session = await client.sessions.create({ title: 'Tracked compiled pending background', agent: 'orchestrator', model }, { directory });
  await managed.admitPrimary(session.id);
  const db = resolveSqliteDriver().open(databasePath, { readonly: true });
  const markers = new Map(); let dbClosed = false;
  const sample = () => {
    for (const row of db.prepare("SELECT key,value FROM kv WHERE substr(key,1,15)='job.background/'").all()) {
      const value = JSON.parse(row.value);
      if (value.recovery?.sessionID === session.id) markers.set(row.key, { jobID: value.id,
        notificationID: value.notificationID, status: value.status });
    }
  };
  const sampler = setInterval(sample, 5);
  try {
    await provider.setResponder(driver.responder);
    const objectiveID = createV2MessageId();
    await client.prompts.prompt(session.id, { messageID: objectiveID, agent: 'orchestrator', model, variant: 'default',
      parts: [{ type: 'text', text: driver.marker }] }, { directory, origin: 'native_acceptance', delivery: 'queue', timeoutMs: 30_000 });
    await waitFor(driver.state, state => state.held, 'Tracked compiled completion did not reach its pre-chunk HTTP boundary');
    const lease = await waitFor(() => runtime.leaseForCall({ directory, sessionID: session.id, callID: driver.callID }),
      value => value?.state === 'published' && value.nativeShellJob?.deliveredID, 'Tracked compiled lease has no canonical delivered notice');
    await assertWriterOutcome({ runtime, directory, sessionID: session.id, callID: driver.callID, observations, succeeded: true });
    const binding = lease.nativeShellJob, markerKey = `job.background/${binding.notificationID}`;
    assert.equal(binding.jobID, driver.state().shellID); assert.equal(binding.deliveredID, binding.notificationID);
    assert.equal(binding.continuedID, undefined); assert.equal(binding.continuedAssistantID, undefined);
    const observed = markers.get(markerKey); assert.ok(observed, 'Exact original native KV marker was never observed');
    assert.equal(observed.jobID, binding.jobID); assert.equal(observed.notificationID, binding.notificationID);
    await waitFor(() => db.prepare('SELECT COUNT(*) AS n FROM kv WHERE key=?').get(markerKey).n,
      value => value === 0, 'Native completeBackground retained its original marker');
    const intent = `shell.complete:${binding.jobID}`;
    assert.equal((await runtime.nativeShellContinuations({ directory })).some(row => row.sessionID === session.id && row.operation === intent), true);
    const before = (await client.sessions.messages(session.id, {}, { directory })).records;
    assert.equal(before.filter(row => row.info.id === binding.deliveredID).length, 1);
    assert.equal(before.some(row => row.info.role === 'assistant' && row.info.parentID === binding.deliveredID), false);
    assert.equal((await runtime.nativeAdmissionState({ directory, sessionID: session.id })).held, false);
    const primaryBefore = await managed.readPrimaryRecord(session.id);
    assert.equal(primaryBefore.anchorID, objectiveID); assert.equal(primaryBefore.instanceID, controller.instanceID);
    const bytes = await snapshotFiles(directory, ['tracked-compiled-background.txt']);
    const receiptCount = observations.filter(row => row.phase === 'termination_verified' && row.callID === driver.callID).length;
    const exit = await controller.killForRecovery();
    assert.equal(controller.hasExited(), true); assert.equal(exit.receipt?.terminated, true); assert.equal(exit.receipt?.confined, true);
    clearInterval(sampler); db.close(); dbClosed = true;
    driver.resume(); await provider.setResponder(driver.responder);
    const replacement = await runtimeOwner.start();
    assert.notEqual(replacement.instanceID, controller.instanceID);
    assert.equal((await runtime.nativeAdmissionState({ directory, sessionID: session.id })).held, false);
    const messages = await waitFor(() => client.sessions.messages(session.id, {}, { directory }), page => page.records.some(row =>
      row.info.role === 'assistant' && row.info.parentID === binding.deliveredID && row.info.time?.completed
      && row.parts?.some(part => part.type === 'text' && part.text === `completed ${id}`)),
    'Tracked compiled replacement did not consume its exact existing notice', 60_000);
    const final = messages.records.filter(row => row.info.role === 'assistant' && row.info.parentID === binding.deliveredID);
    assert.equal(final.length, 1); assert.equal(final[0].turnOwnership?.source, 'native-sequence');
    assert.equal(final[0].turnOwnership?.userMessageID, binding.deliveredID);
    const primaryAfter = await managed.readPrimaryRecord(session.id);
    assert.equal(primaryAfter.anchorID, objectiveID); assert.equal(primaryAfter.activeUserID, binding.deliveredID);
    assert.equal(primaryAfter.instanceID, replacement.instanceID);
    for (const key of ['providerID', 'modelID', 'agent', 'variant', 'executionGeneration']) assert.equal(primaryAfter[key], primaryBefore[key]);
    const consumed = await runtime.leaseForCall({ directory, sessionID: session.id, callID: driver.callID });
    assert.equal(consumed.token, lease.token); assert.deepEqual(consumed.result, lease.result);
    assert.equal(consumed.nativeShellJob.continuedID, binding.deliveredID);
    assert.equal(consumed.nativeShellJob.continuedAssistantID, final[0].info.id);
    assert.equal((await runtime.nativeShellContinuations({ directory })).some(row => row.sessionID === session.id && row.operation === intent), false);
    await runtimeOwner.nativeOwner.recoverShellContinuations({ directory });
    assert.deepEqual((await client.sessions.messages(session.id, {}, { directory })).records.map(row => row.info.id), messages.records.map(row => row.info.id));
    assert.equal(messages.records.filter(row => row.info.id === binding.deliveredID).length, 1);
    assert.equal(messages.records.flatMap(row => row.parts ?? []).filter(part => part.type === 'tool' && part.callID === driver.callID).length, 1);
    assert.equal(observations.filter(row => row.phase === 'termination_verified' && row.callID === driver.callID).length, receiptCount);
    assert.deepEqual(await snapshotFiles(directory, ['tracked-compiled-background.txt']), bytes);
    await invoke({ id: 'compiled-after-replacement-write', tool: 'write', input: { path: 'compiled-after-replacement.txt', content: 'fresh compiled capacity\n' } });
    return { id, status: 'passed', sessionID: session.id, objectiveID, notificationID: binding.deliveredID,
      assistantMessageID: final[0].info.id, oldInstanceID: controller.instanceID, instanceID: replacement.instanceID,
      markerObserved: observed, controllerExit: exit, source: 'actual-tracked-primary-fresh-handshake-and-same-ledger-compiled-recovery' };
  } finally { clearInterval(sampler); if (!dbClosed) db.close(); }
}
