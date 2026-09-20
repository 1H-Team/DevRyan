import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { duplicateLiveFixture, gradeDuplicateLiveReply } from './duplicate-live-fixture.mjs';
import { projectDuplicateWire } from './duplicate-wire-proxy.mjs';
import { runDuplicateLive } from './duplicate-live.mjs';

test('live preparation rejects outside and symlink-escaped homes before starting a host', async () => {
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const base = await fs.mkdtemp(path.join(repository, '.cache/qa/duplicate-live-isolation-'));
  try {
    const env = { DEVRYAN_QA_HOME: base, HOME: repository };
    const launch = { base, workspace: path.join(base, 'workspace'), source: path.join(base, 'source'), env };
    await fs.mkdir(launch.workspace); await fs.mkdir(launch.source);
    env.DEVRYAN_QA_HOME = launch.workspace;
    await fs.writeFile(path.join(base, 'launch.json'), JSON.stringify(launch));
    await assert.rejects(runDuplicateLive({ base, bootstrap: 'unused' }), /escaped its owned root/);
    await fs.symlink(repository, path.join(base, 'escaped'));
    env.HOME = path.join(base, 'escaped');
    await fs.writeFile(path.join(base, 'launch.json'), JSON.stringify(launch));
    await assert.rejects(runDuplicateLive({ base, bootstrap: 'unused' }), /escaped its owned root/);
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

test('live continuity grade rejects lost facts, mutation attempts and incomplete model turns', () => {
  const fixture = duplicateLiveFixture(0);
  const answer = { ...fixture.facts, uniqueProof: fixture.uniqueProof };
  const messages = [{ info: { id: 'msg_new', role: 'assistant', time: { completed: 2 } },
    parts: [{ type: 'text', text: JSON.stringify(answer) }] }];
  assert.equal(gradeDuplicateLiveReply(messages, [], fixture, 'completed').criticalFailures, 0);
  const missing = structuredClone(messages); missing[0].parts[0].text = JSON.stringify({ ...answer, blocker: 'unknown' });
  assert.equal(gradeDuplicateLiveReply(missing, [], fixture, 'completed').criticalFailures, 1);
  const mutation = structuredClone(messages); mutation[0].parts.push({ type: 'tool', tool: 'bash', state: { status: 'error', input: { command: 'printf completed >> mutation-count.txt' } } });
  assert.equal(gradeDuplicateLiveReply(mutation, [], fixture, 'completed').repeatedMutations, 1, 'rejected mutation attempts still fail');
  const repeat = structuredClone(messages); repeat[0].parts.push({ type: 'tool', tool: 'skill', state: { input: { name: 'qa-context-continuity' } } });
  assert.equal(gradeDuplicateLiveReply(repeat, [], fixture, 'completed').sameKeyRepeatCalls, 1);
  assert.equal(gradeDuplicateLiveReply(messages, ['msg_new'], fixture, 'completed').completed, false);
  assert.equal(gradeDuplicateLiveReply(messages, [], fixture, 'completedcompleted').criticalFailures, 1);
});

test('wire correlation uses the submitted fixture token and tool evidence, excluding asynchronous helpers', () => {
  const fixture = duplicateLiveFixture(5);
  const input = [
    { type: 'function_call', call_id: 'one', name: 'devryan_task', arguments: '{}' },
    { type: 'function_call_output', call_id: 'one', output: JSON.stringify({ task: { taskId: 'dvr_task_qa' }, resultHeader: { envelopeId: 'env_qa', criticalFailures: [fixture.body] } }) },
    { type: 'function_call', call_id: 'two', name: 'devryan_task', arguments: '{}' },
    { type: 'function_call_output', call_id: 'two', output: JSON.stringify({ observation: 'identical-managed-result', taskId: 'dvr_task_qa', envelopeId: 'env_qa', reference: { callID: 'one' } }) },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: fixture.prompt }] },
  ];
  const observation = projectDuplicateWire(JSON.stringify({ model: 'fixture', input }));
  assert.equal(observation.trialIndex, 5); assert.equal(observation.managedReferences, 1);
  assert.equal(observation.referencesResolve, true); assert.equal(observation.callPairsIntact, true);
  assert.equal(observation.factHashes.length, 1);
  assert.equal(JSON.stringify(observation).includes(fixture.facts.handoffCode), false);
  assert.equal(projectDuplicateWire(JSON.stringify({ input: [input.at(-1)] })).trialIndex, null);
  const broken = structuredClone(input); broken.splice(0, 2);
  assert.equal(projectDuplicateWire(JSON.stringify({ input: broken })).referencesResolve, false);
});
