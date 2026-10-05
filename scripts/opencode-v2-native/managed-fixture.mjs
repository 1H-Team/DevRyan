import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createWebManagedOrchestrationRuntime } from '../../packages/web/server/lib/orchestration/runtime.js';
import { createWebPrimaryRecoveryRuntime } from '../../packages/web/server/lib/harness/provider-recovery.js';
import { createHarnessTaskContextHost } from '../../packages/web/server/lib/opencode/harness-task-context.js';
import { createNativeManagedTaskOwner } from '../../packages/web/server/lib/opencode/runtime-host/managed-task-owner.js';
import { createNativePrimaryStepOwner } from '../../packages/web/server/lib/opencode/runtime-host/primary-step-owner.js';
import { createNativeShellContinuationVerifier } from '../../packages/web/server/lib/opencode/runtime-host/native-shell-continuation.js';
import { createV2MessageId } from '../../packages/web/server/lib/opencode/v2/admission.js';
import { assertWriterOutcome } from './assertions.mjs';

/** Real product owners with disposable state and an explicitly selected fixture model. */
export function createNativeManagedFixture({ client, admissionOwner, executionHost, directory, dataDirectory,
  buildOpenCodeUrl, getOpenCodeAuthHeaders, environment, observations, diagnostics, journal,
  isNativeFallbackError, dispatchNativeRecovery, eventReconcileIntervalMs, resolveProviderRequest,
  executionModel = { providerID: 'sim', modelID: 'm1', variant: 'default' } }) {
  assert.ok(typeof executionModel.providerID === 'string' && executionModel.providerID
    && typeof executionModel.modelID === 'string' && executionModel.modelID
    && typeof executionModel.variant === 'string' && executionModel.variant, 'Explicit fixture model selection required');
  const model = { providerID: executionModel.providerID, modelID: executionModel.modelID };
  let managed;
  const roots = new Set();
  const fixtureOwner = randomUUID();
  const primary = createWebPrimaryRecoveryRuntime({ openCodeClient: client, dataDirectory,
    buildOpenCodeUrl, getOpenCodeAuthHeaders, isManaged: () => true, mode: 'observe',
    isNativeFallbackError, dispatchNativeRecovery, eventReconcileIntervalMs, resolveProviderRequest,
    getManagedRuntime: () => managed, getMultiUserRuntime: () => ({ canSessionTokenHashAccess: async (owner, sessionID) => {
      if (owner !== fixtureOwner || !roots.has(sessionID)) return false;
      const session = await client.sessions.get(sessionID, { directory });
      return session.id === sessionID && session.directory === directory && !session.parentID && !session.time?.archived;
    } }),
    verifyOwnedNativeContinuation: createNativeShellContinuationVerifier({ runtime: executionHost.runtime,
      getShellJobReceipt: input => executionHost.nativeShellJobReceipt(input) }),
    executionOutcomes: input => executionHost.runtime.executionOutcomes(input),
    // Optional fixture-journal tee: the application journals the same incident.
    recordIncident: record => { diagnostics.push(record); journal?.primaryRecoveryIncident(record); },
  });
  const taskContext = createHarnessTaskContextHost({ openCodeClient: client, dataDirectory,
    buildOpenCodeUrl, getOpenCodeAuthHeaders, readPrimaryRecord: sessionID => primary.readRecord(sessionID),
    getManagedRuntime: () => managed, sanitizeText: text => text, isManaged: () => false,
  });
  managed = createWebManagedOrchestrationRuntime({ openCodeClient: client, dataDirectory,
    ...(eventReconcileIntervalMs === undefined ? {} : { eventReconcileIntervalMs }),
    buildOpenCodeUrl, getOpenCodeAuthHeaders, environment,
    registerExecutionChild: input => executionHost.nativeManagedChild(input),
    nativeTaskDispatch: (input, action) => admissionOwner.withManagedTaskDispatch(input, action),
    // The fixture uses a native model, not the Claude compatibility transport.
    resolveTaskPromptPreamble: () => null,
    resolveAgentExecution: async ({ agent, directory: requestedDirectory }) => {
      assert.equal(requestedDirectory, directory);
      const entry = (await client.catalog.agents({ directory })).find(value => value.name === agent);
      assert.ok(entry?.model?.providerID && entry.model.modelID, 'Managed fixture role has no native configured model');
      return { providerId: entry.model.providerID, modelId: entry.model.modelID, variant: entry.variant ?? null };
    },
    publishEvent: event => observations.push({ phase: 'managed_event', type: event.type, properties: event.properties }),
  });
  const step = createNativePrimaryStepOwner({ admissionOwner, openCodeClient: client, primaryRuntime: primary,
    instanceID: randomUUID(), directory });
  const task = createNativeManagedTaskOwner({ admissionOwner, taskContext, executionHost, getManagedRuntime: () => managed });
  const admitPrimary = async sessionID => {
    const session = await client.sessions.get(sessionID, { directory });
    assert.equal(session.id, sessionID); assert.equal(session.directory, directory); assert.ok(!session.parentID);
    roots.add(sessionID);
  };
  return {
    primaryRuntime: primary, taskContext, getManagedRuntime: () => managed,
    // Match the server-derived owner used by this fixture's accepted prompts.
    requestRecovery: (method, route, body) => primary.handleRequest(method, route, body, { owner: fixtureOwner }),
    admitPrimary,
    // Enrolment is fixture ownership only. The actual accepted native prompt
    // freezes the effective selection before any primary record is admitted.
    admitNativePrompt: (receipt, context) => roots.has(receipt.sessionID)
      ? primary.admitNativePrompt(receipt, { owner: fixtureOwner, ...(typeof context==='function'?{authorizeWrite:context}:context) }) : undefined,
    markNativePromptUncertain: receipt => roots.has(receipt.sessionID)
      ? primary.markNativePromptUncertain(receipt) : undefined,
    readPrimaryRecord: sessionID => primary.readRecord(sessionID),
    verifyNativeTaskDispatch: input => managed.verifyNativeTaskDispatch(input),
    handleRpc: (method, params, context) => {
      if (method === 'native.primary-step') return step(params);
      if (method === 'native.managed-task') return task(params, context);
      throw new Error(`Managed fixture RPC unavailable: ${method}`);
    },
    runAcceptance: async (nativeControl, { caseID = 'managed-child', revert = true } = {}) => {
      assert.match(caseID, /^[a-z0-9-]+$/, 'Owned managed fixture case identity required');
      assert.equal(typeof revert, 'boolean');
      // The original acceptance always includes Revert/Redo. The additional
      // removal fixture is a fresh lifecycle whose generation is untouched.
      assert.ok(revert || caseID !== 'managed-child', 'Original managed Revert acceptance cannot be skipped');
      const scenario = await nativeControl.call({ action: 'scenario-managed', caseID, agent: 'fixer' });
      const session = await client.sessions.create({ title: 'Native managed child acceptance', agent: 'orchestrator',
        model }, { directory });
      const body = { messageID: createV2MessageId(), agent: 'orchestrator', model, variant: executionModel.variant,
        parts: [{ type: 'text', text: scenario.marker }] };
      await admitPrimary(session.id);
      await client.prompts.prompt(session.id, body, { directory, origin: 'native_acceptance', delivery: 'queue', timeoutMs: 30_000 });
      const deadline = Date.now() + 120_000;
      let page;
      for (;;) {
        page = await client.sessions.messages(session.id, {}, { directory });
        const start = page.records.flatMap(message => message.parts ?? []).find(part => part.type === 'tool' && part.callID === scenario.callIDs.startID);
        assert.notEqual(start?.state?.status, 'error', `Native managed task start failed: ${start?.state?.error ?? 'unknown error'}`);
        if (page.records.some(message => message.parts?.some(part => part.type === 'text' && part.text === `completed ${caseID}`))) break;
        assert.ok(Date.now() < deadline, 'Native managed parent failed to continue after its child');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const complete = await nativeControl.call({ action: 'complete' });
      const proof = complete.result;
      const childWriterFile = proof.childWriterFile;
      assert.equal(childWriterFile, caseID === 'managed-child' ? 'managed-child.txt' : `managed-${caseID}.txt`);
      const snapshot = await managed.getSnapshot({ rootSessionId: session.id });
      assert.equal(snapshot.tasks.length, 1, 'Native completion created duplicate managed work');
      const task = snapshot.tasks[0];
      assert.equal(task.taskId, proof.taskID);
      assert.equal(task.status, 'completed');
      assert.equal(task.providerId, model.providerID); assert.equal(task.modelId, model.modelID);
      assert.ok(task.childSessionId);
      assert.equal((await client.sessions.get(task.childSessionId, { directory })).parentID, session.id);
      const beforeRevert = new Map(await Promise.all([session.id, task.childSessionId].map(async sessionID => [sessionID,
        (await client.sessions.messages(sessionID, {}, { directory })).records.map(message => message.info.id)])));
      await assertWriterOutcome({ runtime: executionHost.runtime, directory, sessionID: task.childSessionId,
        callID: proof.childWriterCallID, observations, succeeded: true });
      assert.equal(await fs.readFile(path.join(directory, childWriterFile), 'utf8'), `managed writer ${caseID}\n`);
      assert.equal(page.records.filter(message => message.info.role === 'user').length, 1,
        'Child completion added a competing parent user turn');
      assert.equal((await primary.readRecord(session.id)).anchorID, body.messageID);
      const lease = await executionHost.runtime.leaseForCall({ directory, sessionID: session.id, callID: scenario.callIDs.startID });
      assert.equal(lease?.executionKind, 'control'); assert.equal(lease.state, 'published');
      assert.equal(lease.preparation, 'none'); assert.deepEqual(lease.result.files, []);
      const completedFixture = { rootSessionID: session.id, childSessionID: task.childSessionId, taskID: task.taskId,
        childWriterCallID: proof.childWriterCallID, childWriterFile, objectiveMessageID: body.messageID };
      if (!revert) {
        for (const sessionID of [session.id, task.childSessionId]) {
          assert.equal((await client.sessions.get(sessionID, { directory })).revert, undefined);
          assert.equal((await executionHost.runtime.nativeAdmissionState({ directory, sessionID })).held, false);
        }
        observations.push({ phase: 'fresh_managed_removal_fixture', caseID, ...completedFixture });
        return { id: caseID, status: 'passed', ...completedFixture, conversationRevertRedo: null };
      }
      const reverted = await executionHost.coordinator.revert({ directory, sessionID: session.id, messageID: body.messageID, scope: 'tree' });
      assert.equal(reverted.verification?.ok, true); assert.equal(reverted.redoAvailable, true);
      assert.equal(reverted.revert?.messageID, body.messageID); assert.equal(reverted.revert.fileRestore, false);
      assert.equal(reverted.revert.snapshot, undefined);
      assert.deepEqual(new Set(reverted.reverted.sessions.map(value => value.id)), new Set([session.id, task.childSessionId]));
      await assert.rejects(fs.readFile(path.join(directory, childWriterFile)), error => error.code === 'ENOENT');
      const undoTransaction = await executionHost.runtime.transaction({ directory, transactionID: reverted.verification.transactionID });
      assert.equal(undoTransaction.state, 'committed'); assert.equal(undoTransaction.phase, 'committed');
      const restored = await executionHost.coordinator.redo({ directory, sessionID: session.id });
      assert.equal(restored.verification?.ok, true); assert.equal(restored.revert, undefined);
      assert.equal(await fs.readFile(path.join(directory, childWriterFile), 'utf8'), `managed writer ${caseID}\n`);
      const redoTransaction = await executionHost.runtime.transaction({ directory, transactionID: restored.verification.transactionID });
      assert.equal(redoTransaction.state, 'committed'); assert.equal(redoTransaction.redo, true);
      for (const sessionID of [session.id, task.childSessionId]) {
        assert.equal((await client.sessions.get(sessionID, { directory })).revert, undefined);
        assert.equal((await executionHost.runtime.nativeAdmissionState({ directory, sessionID })).held, false);
        assert.deepEqual(await executionHost.runtime.nativeContinuations({ directory, sessionID }), []);
        assert.deepEqual((await client.sessions.messages(sessionID, {}, { directory })).records.map(message => message.info.id),
          beforeRevert.get(sessionID), 'Redo changed native conversation identity or duplicated a turn');
      }
      assert.equal((await nativeControl.call({ action: 'complete' })).requestCount, complete.requestCount,
        'Redo repeated model inference for the completed managed task');
      assert.equal((await managed.getSnapshot({ rootSessionId: session.id })).tasks.length, 1, 'Redo duplicated managed work');
      return { id: 'managed-child-parent-continuation', status: 'passed', ...completedFixture,
        conversationRevertRedo: { status: 'passed', revertTransactionID: undoTransaction.id, redoTransactionID: redoTransaction.id } };
    },
    close: async () => {
      const results = await Promise.allSettled([managed.shutdown(), taskContext.drain(), primary.drain()]);
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, 'Managed native fixture cleanup failed');
    },
  };
}
