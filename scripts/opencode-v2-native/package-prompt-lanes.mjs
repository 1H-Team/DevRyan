import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveSqliteDriver } from '../../packages/web/server/lib/opencode/db-maintenance-core.js';
import { parseNativeObservation } from '../../packages/shared-runtime/lib/native-observation.js';
import { waitFor } from './process-lanes.mjs';

export const reviewedCommandConfiguration = { reviewed: { template: 'Reviewed $ARGUMENTS', agent: 'orchestrator',
  model: { providerID: 'devryan-smoke', model: 'smoke-write' } } };

/** The first compiled writer must capture the workspace bytes that predate v2. */
export async function runCompiledWorkspaceRevert({ invoke, client, executionHost, directory, sessionID, observations }) {
  const file=path.join(directory,'seed.txt'),untouched=path.join(directory,'attachment.txt');
  const before=await fs.readFile(file),unrelated=await fs.readFile(untouched),mode=(await fs.stat(file)).mode&0o777;
  const published=Buffer.concat([before,Buffer.from('compiled first v2 overwrite\r\n')]);
  const call=await invoke({id:'compiled-existing-workspace-write',tool:'write',input:{path:'seed.txt',content:published.toString('utf8')}});
  assert.deepEqual(await fs.readFile(file),published);
  const page=await client.sessions.messages(sessionID,{}, {directory});
  const messageID=page.records.find(row=>row.info.id===call.messageID)?.info.parentID;
  assert.ok(messageID,'First writer must belong to its canonical user input');
  const history=page.records.map(row=>row.info.id);
  await waitFor(()=>client.sessions.status({directory}),status=>!status[sessionID]||status[sessionID].type==='idle','First writer did not settle');
  const requests=observations.filter(row=>row.phase==='http_provider_request').length;
  const reverted=await executionHost.coordinator.revert({directory,sessionID,messageID,scope:'tree'});
  assert.equal(reverted.verification?.ok,true);assert.equal(reverted.redoAvailable,true);
  assert.equal(reverted.revert?.messageID,messageID);assert.equal(reverted.revert.fileRestore,false);assert.equal(reverted.revert.snapshot,undefined);
  assert.deepEqual(await fs.readFile(file),before,'Fresh v2 Undo must restore the exact existing workspace contents');
  assert.deepEqual(await fs.readFile(untouched),unrelated);
  assert.equal((await fs.stat(file)).mode&0o777,mode);
  const undo=await executionHost.runtime.transaction({directory,transactionID:reverted.verification.transactionID});
  assert.equal(undo.state,'committed');assert.equal(undo.phase,'committed');
  const restored=await executionHost.coordinator.redo({directory,sessionID});
  assert.equal(restored.verification?.ok,true);assert.equal(restored.revert,undefined);
  assert.deepEqual(await fs.readFile(file),published);assert.deepEqual(await fs.readFile(untouched),unrelated);
  assert.equal((await fs.stat(file)).mode&0o777,mode);
  const redo=await executionHost.runtime.transaction({directory,transactionID:restored.verification.transactionID});
  assert.equal(redo.state,'committed');assert.equal(redo.redo,true);
  assert.deepEqual((await client.sessions.messages(sessionID,{}, {directory})).records.map(row=>row.info.id),history);
  assert.equal(observations.filter(row=>row.phase==='http_provider_request').length,requests,'Revert/Redo must not repeat inference');
  assert.equal((await executionHost.runtime.nativeAdmissionState({directory,sessionID})).held,false);
  return {id:'compiled-existing-workspace-revert-redo',status:'passed',sessionID,messageID,
    beforeSha256:createHash('sha256').update(before).digest('hex'),publishedSha256:createHash('sha256').update(published).digest('hex'),
    revertTransactionID:undo.id,redoTransactionID:redo.id,source:'actual-first-compiled-writer-original-native-markers-and-ledger-restoration'};
}

/** Real configured executor and real compaction inference over the built-in HTTP provider. */
export async function runCompiledPromptLanes({ provider, client, directory, databasePath, diagnostics, onCase, admitPrimary }) {
  assert.equal(typeof admitPrimary, 'function', 'Compiled command requires its primary admission owner');
  const model = { providerID: 'devryan-smoke', modelID: 'smoke-write' };
  const session = await client.sessions.create({ title: 'Compiled command and manual compaction', agent: 'orchestrator', model }, { directory });
  // Every compiled command requires the same ownership enrolment as ordinary
  // roots. The real accepted command freezes its canonical selection.
  await admitPrimary(session.id);
  let commandRequests = 0;
  await provider.setResponder(request => {
    commandRequests++;
    assert.ok(request.body.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('Reviewed owned command')),
      'Configured command did not supply its exact prepared template');
    assert.equal(commandRequests, 1, 'Configured command duplicated inference');
    return { items: [{ type: 'textDelta', text: 'compiled reviewed command completed' }], reason: 'stop' };
  });
  await client.prompts.command(session.id, { command: 'reviewed', arguments: 'owned command' }, { directory, timeoutMs: 30000 });
  const messages = await waitFor(() => client.sessions.messages(session.id, {}, { directory }), page => page.records.some(row =>
    row.info.role === 'assistant' && row.info.time?.completed && row.parts?.some(part => part.type === 'text' && part.text === 'compiled reviewed command completed')),
  'Compiled configured command did not finish');
  const users = messages.records.filter(row => row.info.role === 'user'); assert.equal(users.length, 1);
  assert.equal(users[0].parts.filter(part => part.type === 'text').map(part => part.text).join('\n'), 'Reviewed owned command');
  assert.equal(commandRequests, 1);
  const commandCase = { id: 'compiled-reviewed-command', status: 'passed', sessionID: session.id, userMessageID: users[0].info.id,
    source: 'actual-configured-native-executor-and-http-model' };
  onCase?.(commandCase);
  let compactRequests = 0;
  const summary = '## Objective\n- compiled exact manual summary';
  await provider.setResponder(request => {
    compactRequests++; assert.equal(compactRequests, 1, 'Manual compaction duplicated inference');
    assert.ok(request.body.messages.length > 0, 'Compaction omitted its actual conversation');
    return { items: [{ type: 'textDelta', text: summary }], reason: 'stop' };
  });
  const db = resolveSqliteDriver().open(databasePath, { readonly: true });
  try {
    const existing = new Set(db.prepare("SELECT id FROM session_message WHERE session_id=? AND type='compaction'").all(session.id).map(row => row.id));
    await client.prompts.compact(session.id, {}, { directory, timeoutMs: 30000 });
    const rows = await waitFor(() => db.prepare("SELECT id,data FROM session_message WHERE session_id=? AND type='compaction'").all(session.id)
      .filter(row => !existing.has(row.id)).map(row => ({ id: row.id, ...JSON.parse(row.data) })),
    values => values.some(row => row.status === 'completed'), 'Compiled manual compaction did not commit its native summary', 60000);
    assert.equal(rows.length, 1); assert.equal(rows[0].summary, summary); assert.equal(compactRequests, 1);
    const compactCase = { id: 'compiled-manual-compaction', status: 'passed', sessionID: session.id, compactionID: rows[0].id,
      source: 'actual-native-compaction-row-and-http-summary' };
    onCase?.(compactCase);
    const records = await waitFor(() => diagnostics.filter(row => row.event === 'native_observation' && row.sessionID === session.id)
      .map(row => parseNativeObservation(row.payload)), values => values.some(row => row.stage === 'compaction-outcome' && row.status === 'completed'),
    'Compiled native observation did not finish');
    assert.equal(diagnostics.some(row => row.event === 'native_observation_gap' && row.sessionID === session.id), false);
    const accepted = records.find(row => row.stage === 'accepted-user' && row.messageID === users[0].info.id);
    assert.ok(accepted); assert.equal(accepted.intent.source, 'command-definition'); assert.equal(accepted.directory, directory);
    const step = records.find(row => row.stage === 'step-link' && row.userMessageID === accepted.messageID);
    assert.ok(step?.attempt); assert.equal(step.execution.agent, 'orchestrator'); assert.equal(step.execution.providerID, model.providerID);
    assert.equal(step.execution.modelID, model.modelID);
    const physical = records.find(row => row.stage === 'physical' && row.kind === 'primary'
      && row.attempt?.traceID === step.attempt.traceID && row.attempt?.spanID === step.attempt.spanID);
    assert.ok(physical); assert.equal(physical.transport, 'http'); assert.notEqual(physical.wireOptions, null);
    const prepared = records.find(row => row.stage === 'model-prepared' && row.requestID === physical.requestID);
    assert.ok(prepared); assert.deepEqual({ ...prepared.execution, variant: prepared.execution.variant ?? 'default' },
      { ...step.execution, variant: step.execution.variant ?? 'default' });
    const trigger = records.find(row => row.stage === 'compaction-trigger' && row.reason === 'manual');
    assert.ok(trigger?.budget); assert.equal(trigger.inputID, rows[0].id);
    assert.equal(trigger.budget.estimateContext, trigger.budget.estimatePrompt.measured + trigger.budget.estimatePrompt.estimated);
    assert.ok(trigger.inputCount > 0); assert.ok(trigger.budget.limits.input > 0);
    const started = records.find(row => row.stage === 'compaction-event' && row.event === 'started' && row.inputID === trigger.inputID);
    const ended = records.find(row => row.stage === 'compaction-event' && row.event === 'ended' && row.triggerID === trigger.triggerID);
    assert.ok(started); assert.deepEqual(ended?.witness.text, { bytes: Buffer.byteLength(summary), sha256: createHash('sha256').update(summary).digest('hex') });
    assert.equal(ended.messageID, rows[0].id);
    assert.ok(ended.sequence > started.sequence); assert.ok(ended.created >= started.created);
    assert.ok(records.some(row => row.stage === 'compaction-outcome' && row.triggerID === trigger.triggerID && row.status === 'completed'));
    assert.equal(new Set(records.map(row => row.controllerInstanceID)).size, 1);
    assert.equal(new Set(records.map(row => row.configurationDigest)).size, 1);
    const observationCase = { id: 'compiled-native-observation', status: 'passed', sessionID: session.id,
      source: 'compiled-native-span-budget-and-committed-events-private-fixture-capture',
      requestID: prepared.requestID, triggerID: trigger.triggerID, compactionID: ended.messageID, records: records.length };
    onCase?.(observationCase); return [commandCase, compactCase, observationCase];
  } finally { db.close(); }
}
