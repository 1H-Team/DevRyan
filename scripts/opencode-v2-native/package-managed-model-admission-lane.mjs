import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { managedTaskTurn } from './assertions.mjs';
import { waitFor } from './process-lanes.mjs';
import { createV2MessageId } from '../../packages/web/server/lib/opencode/v2/admission.js';
import { collectJournalPaths, readRecordsFromPaths } from '../journal.mjs';

export function configureManagedModelAdmission(configuration, variant) {
  assert.ok(['low', 'medium'].includes(variant));
  configuration.providers['devryan-smoke'].models['smoke-write'].name = 'Synthetic Explorer Model';
  configuration.providers['devryan-smoke'].models['smoke-write'].variants = ['low', 'high', 'max']
    .map(id => ({ id, settings: { reasoningEffort: id } }));
  configuration.agents.explorer = { mode: 'subagent', model: 'devryan-smoke/smoke-write', variant };
}

export function createInvalidManagedModelTurn(caseID) {
  const callID = `native_${caseID}_invalid`, marker = `[devryan-model-admission:${caseID}]`;
  let issued = false, observedError;
  return { marker, callID, responder(request) {
    assert.ok(Array.isArray(request.body.messages));
    const result = request.body.messages.find(row => row.role === 'tool' && row.tool_call_id === callID);
    if (result) {
      assert.ok(issued && !observedError, 'Invalid Explorer admission was replayed');
      const content = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
      assert.match(content, /explorer cannot start: medium is unsupported/);
      assert.match(content, /Choose low, high, max or Provider default in Agents settings/);
      observedError = content;
      return { items: [{ type: 'textDelta', text: `refused ${caseID}` }], reason: 'stop' };
    }
    assert.equal(issued, false, 'Invalid admission caused child inference or redispatch');
    assert.ok(request.body.messages.some(row => JSON.stringify(row).includes(marker)));
    assert.ok(request.body.tools?.some(tool => tool?.function?.name === 'devryan_task'));
    issued = true;
    return { items: [{ type: 'toolCall', index: 0, id: callID, name: 'devryan_task',
      input: { action: 'start', agent: 'explorer', prompt: 'Inspect the disposable fixture.', label: 'Invalid Explorer model' } }], reason: 'tool-calls' };
  }, complete() { assert.ok(issued && observedError); return { observedError }; } };
}

/** Only inference responses are synthetic. The compiled tool, admission,
 * scheduler, child session and actual parent-visible error remain product-owned. */
export async function runCompiledManagedModelAdmission({ variant, client, managed, provider, directory, diagnostics, journal }) {
  const caseID = `admission-${randomUUID()}`, valid = variant === 'low';
  const turn = valid ? managedTaskTurn(caseID, 'explorer') : createInvalidManagedModelTurn(caseID);
  await provider.setResponder(turn.responder);
  const model = { providerID: 'devryan-smoke', modelID: 'smoke-write' };
  const root = await client.sessions.create({ title: `Explorer ${variant} admission`, agent: 'orchestrator', model }, { directory });
  await managed.admitPrimary(root.id);
  const messageID = createV2MessageId();
  await client.prompts.prompt(root.id, { messageID, agent: 'orchestrator', model, variant: 'default',
    parts: [{ type: 'text', text: turn.marker }] }, { directory, origin: 'native_acceptance', delivery: 'queue', timeoutMs: 30_000 });
  const expected = `${valid ? 'completed' : 'refused'} ${caseID}`;
  const parent = await waitFor(() => client.sessions.messages(root.id, {}, { directory }), value => value.records.some(row =>
    row.info.role === 'assistant' && row.info.time?.completed && row.parts.some(part => part.type === 'text' && part.text === expected)),
  'Compiled Explorer admission did not settle its actual parent response', 60_000);
  const proof = turn.complete();
  const snapshot = await managed.getManagedRuntime().getSnapshot({ rootSessionId: root.id });
  assert.equal(snapshot.available, true); assert.equal(snapshot.recoveryWarning, null);
  const children = await client.sessions.list({ directory, parentID: root.id });
  assert.equal(snapshot.tasks.length, valid ? 1 : 0, 'Unexpected durable managed tasks');
  assert.equal(children.length, valid ? 1 : 0, 'Unexpected actual native child sessions');
  if (valid) {
    const task = snapshot.tasks[0];
    assert.equal(task.taskId, proof.taskID); assert.equal(task.status, 'completed');
    assert.deepEqual([task.agent, task.variant, task.providerId, task.modelId], ['explorer', 'low', 'devryan-smoke', 'smoke-write']);
    assert.equal(children[0].id, task.childSessionId); assert.equal(children[0].parentID, root.id);
    const child = await client.sessions.messages(task.childSessionId, {}, { directory });
    assert.ok(child.records.some(row => row.info.role === 'assistant' && row.info.time?.completed
      && row.parts.some(part => part.type === 'text' && part.text === `managed child completed ${caseID}`)));
    return { id: 'compiled-explorer-valid-low', status: 'passed', rootSessionID: root.id, childSessionID: task.childSessionId,
      taskID: task.taskId, variant: task.variant, childCount: children.length };
  }
  await journal.flush();
  const failure = diagnostics.find(row => row.phase === 'managed_model_validation_failed' && row.rootSessionId === root.id);
  assert.equal(failure?.reason, 'variant_missing'); assert.equal(failure.agent, 'explorer');
  assert.equal(failure.variant, 'medium'); assert.equal(failure.callId, turn.callID); assert.ok(failure.messageId);
  assert.deepEqual(failure.supportedVariants, ['low', 'high', 'max']);
  const persisted = [];
  for await (const row of readRecordsFromPaths(await collectJournalPaths(journal.journalDirectory))) {
    if (row.sessionID === root.id && row.event === 'managed_model_validation_failed') persisted.push(row);
  }
  assert.equal(persisted.length, 1, 'Exact model refusal must be present in the durable journal');
  assert.equal(persisted[0].payload.reason, 'variant_missing');
  assert.equal(persisted[0].payload.callId, turn.callID);
  const calls = parent.records.flatMap(row => row.parts).filter(part => part.type === 'tool' && part.callID === turn.callID);
  assert.equal(calls.length, 1); assert.equal(calls[0].state.status, 'error');
  return { id: 'compiled-explorer-invalid-medium', status: 'passed', rootSessionID: root.id, childCount: children.length,
    reason: failure.reason, callID: failure.callId, messageID: failure.messageId, persistedDiagnostic: true, toolError: proof.observedError };
}

async function main() {
  const { values } = parseArgs({ options: { 'artifact-root': { type: 'string' }, 'keep-artifacts': { type: 'boolean' } } });
  assert.ok(values['artifact-root'] && path.isAbsolute(values['artifact-root']), '--artifact-root must be absolute');
  const { runNativePackageAcceptance } = await import('../verify-opencode-v2-package.mjs');
  const results = [];
  for (const variant of ['low', 'medium']) {
    const result = await runNativePackageAcceptance({ artifactRoot: values['artifact-root'], managedModelAdmission: variant });
    results.push({ variant, status: result.status, cases: result.cases, error: result.error, cleanupFailures: result.cleanupFailures });
    if (result.status !== 'model-admission-passed') break;
  }
  process.stdout.write(JSON.stringify({ status: results.length === 2 && results.every(row => row.status === 'model-admission-passed')
    ? 'passed' : 'failed', results }, null, 2) + '\n');
  if (results.length !== 2 || results.some(row => row.status !== 'model-admission-passed')) process.exitCode = 1;
}

// Finish module evaluation before loading the verifier that imports this lane.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  setImmediate(() => main().catch(error => { console.error(error); process.exitCode = 1; }));
}
