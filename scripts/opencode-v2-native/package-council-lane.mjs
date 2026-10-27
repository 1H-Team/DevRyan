import assert from 'node:assert/strict';
import { reviewedCouncilMembers } from '../../packages/web/server/lib/opencode/runtime-host/reviewed-council-configuration.js';

// Diagnostic selections only. These do not replace or qualify personal models.
export const compiledCouncilMembers = Object.freeze([
  Object.freeze({ model: 'devryan-smoke/smoke-write', variant: 'default' }),
  Object.freeze({ model: 'devryan-smoke/gpt-5-native-smoke', variant: 'default' }),
]);
const caseID = 'compiled-ordered-council';
const prompt = '[devryan-council-local-qualification] Compare two isolated local designs.';
const memberPrompt = ['You are one councillor in a multi-model council.',
  'Answer independently and concisely. Do not ask follow-up questions.',
  'State assumptions and uncertainty when needed.', '', prompt].join('\n');
const answers = ['Local seat one independently prefers design A.', 'Local seat two independently prefers design B.'];
const text = value => typeof value === 'string' ? value : Array.isArray(value)
  ? value.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n') : '';

/** Only exact generated councillor input is answered here. The parent retains
 * the existing real tool/continuation responder and its replay assertions. */
export function createCompiledCouncilResponder(parentResponder, members) {
  assert.equal(typeof parentResponder, 'function');
  assert.equal(members.length, 2);
  assert.deepEqual(members.map(member => [member.providerId, member.modelId, member.variant]), [
    ['devryan-smoke', 'smoke-write', 'default'], ['devryan-smoke', 'gpt-5-native-smoke', 'default'],
  ]);
  const requests = members.map(() => 0);
  const callID = `native_${caseID}`;
  const waitIDs = [0, 1].map(index => `${callID}_collect_${index}`);
  const dispositionIDs = [0, 1].map(index => `${callID}_continue_${index}`);
  const calls = [waitIDs[0], dispositionIDs[0], waitIDs[1], dispositionIDs[1]];
  let phase = 0, taskIDs, envelopes, completed;
  return {
    requests,
    dispositionCallIDs: calls,
    responder: request => {
      const user = request.body?.messages?.filter(message => message.role === 'user').at(-1);
      if (!text(user?.content).includes(memberPrompt)) {
        const messages = request.body?.messages ?? [];
        const result = id => messages.find(message => message.role === 'tool' && message.tool_call_id === id);
        if (phase === 0 && result(callID)) {
          completed = parentResponder(request); // Retain the original exact result/replay check.
          const council = JSON.parse(text(result(callID).content));
          assert.equal(council.disposition, 'unacknowledged'); assert.equal(council.results.length, 2);
          taskIDs = council.results.map(row => row.taskId);
          envelopes = council.results.map(row => row.resultEnvelope);
          for (const [index, envelope] of envelopes.entries()) {
            assert.ok(envelope?.envelopeId && envelope.rootSessionId && envelope.directory);
            assert.equal(envelope.taskId, taskIDs[index]); assert.equal(envelope.action, null);
            assert.equal(envelope.status, 'completed');
            assert.equal(envelope.rootSessionId, envelopes[0].rootSessionId);
            assert.equal(envelope.directory, envelopes[0].directory);
          }
          assert.equal(new Set(taskIDs).size, 2);
          assert.ok(taskIDs.every(id => typeof id === 'string' && /^dvr_task_[A-Za-z0-9_-]+$/.test(id)));
          phase = 1;
          return { items: [{ type: 'toolCall', index: 0, id: waitIDs[0], name: 'devryan_task',
            input: { action: 'wait', task_id: taskIDs[0] } }], reason: 'tool-calls' };
        }
        if (phase >= 1 && phase <= calls.length) {
          const prior = calls[phase - 1], index = Math.floor((phase - 1) / 2);
          assert.ok(result(prior), 'Council disposition continuation lost its exact native result');
          const accepted = JSON.parse(text(result(prior).content));
          const envelope = accepted.resultEnvelope, expected = envelopes[index];
          assert.ok(envelope, 'Council managed tool did not return a successful result envelope');
          for (const field of ['envelopeId', 'taskId', 'rootSessionId', 'directory', 'status']) {
            assert.equal(envelope[field], expected[field], `Council managed result changed ${field}`);
          }
          if (phase % 2 === 1) {
            assert.equal(accepted.task?.taskId, taskIDs[index]);
            assert.equal(accepted.task.status, 'completed'); assert.equal(envelope.action, null);
          } else {
            assert.equal(envelope.action, 'continue', 'Council native acknowledgement did not commit');
            assert.ok(Number.isFinite(envelope.acknowledgedAt));
          }
          if (phase === calls.length) { phase++; return completed; }
          const next = phase++, nextIndex = Math.floor(next / 2);
          return { items: [{ type: 'toolCall', index: 0, id: calls[next], name: 'devryan_task',
            input: { action: next % 2 === 0 ? 'wait' : 'continue', task_id: taskIDs[nextIndex] } }], reason: 'tool-calls' };
        }
        return parentResponder(request);
      }
      const index = members.findIndex(member => member.modelId === request.body.model);
      assert.ok(index >= 0, 'Council used an undeclared diagnostic model');
      assert.equal(++requests[index], 1, 'Council repeated a physical member request');
      return { items: [{ type: 'textDelta', text: answers[index] }], reason: 'stop' };
    },
  };
}

/** Actual compiled tool execution; no scheduler, native message, lease or
 * envelope is created by this helper. All identities are read back from owners. */
export async function runCompiledCouncil({ invoke, runtime, client, managed, directory, runtimeOwner }) {
  const members = reviewedCouncilMembers(runtimeOwner.getConfigurationSnapshot(), { directory, preset: 'default' });
  const session = await client.sessions.create({ title: 'Compiled independent Council fixture', agent: 'orchestrator',
    model: { providerID: 'devryan-smoke', modelID: 'smoke-write' } }, { directory });
  await managed.admitPrimary(session.id);
  let response;
  const call = await invoke({ id: caseID, tool: 'council_session', direct: true, control: true, input: { prompt, preset: 'default' } }, {
    sessionID: session.id,
    transformResponder: parent => {
      response = createCompiledCouncilResponder(parent, members);
      return response.responder;
    },
  });
  assert.ok(response, 'Compiled Council responder hook was not installed');
  assert.deepEqual(response.requests, [1, 1]);
  const result = JSON.parse(call.state.output);
  assert.equal(result.preset, 'default');
  assert.equal(result.disposition, 'unacknowledged');
  assert.equal(result.results.length, 2);
  assert.deepEqual(result.results.map(row => [row.seat, row.providerId, row.modelId, row.variant]),
    members.map((member, index) => [index + 1, member.providerId, member.modelId, member.variant]));
  assert.equal(new Set(result.results.map(row => row.taskId)).size, 2);
  const envelopes = [], children = [];
  let rootSessionID;
  for (const [index, row] of result.results.entries()) {
    assert.equal(row.status, 'completed');
    assert.ok(row.response.includes(answers[index]), 'Council lost the collected independent response');
    const envelope = row.resultEnvelope;
    assert.ok(envelope?.envelopeId && envelope.taskId === row.taskId);
    assert.equal(envelope.action, null, 'Council silently dispositioned a collected result');
    assert.equal(envelope.directory, directory);
    rootSessionID ??= envelope.rootSessionId;
    assert.equal(envelope.rootSessionId, rootSessionID);
    const owned = await managed.getManagedRuntime().handleRpc({ method: 'status', params: {
      directory, rootSessionId: rootSessionID, taskId: row.taskId, resultMode: 'reference', resultContractVersion: 1,
    } });
    const task = owned.task;
    assert.equal(task.status, row.status);
    assert.equal(task.rootSessionId, rootSessionID);
    assert.equal(owned.resultEnvelope?.envelopeId, envelope.envelopeId);
    assert.equal(owned.resultEnvelope.action, 'continue', 'Actual managed result disposition was not durable');
    assert.equal(task.dispatchCallId, call.callID);
    assert.deepEqual([task.providerId, task.modelId, task.variant, task.agent],
      [members[index].providerId, members[index].modelId, members[index].variant, 'builder']);
    assert.ok(task.childSessionId);
    const child = await client.sessions.get(task.childSessionId, { directory });
    assert.equal(child.id, task.childSessionId);
    assert.equal(child.parentID, rootSessionID);
    assert.equal(child.directory, directory);
    const page = await client.sessions.messages(child.id, {}, { directory });
    assert.ok(page.records.some(message => message.info.role === 'assistant' && message.info.time?.completed
      && message.parts.some(part => part.type === 'text' && part.text.includes(answers[index]))));
    children.push(child.id); envelopes.push(envelope.envelopeId);
  }
  assert.equal(rootSessionID, session.id);
  assert.equal(new Set(children).size, 2);
  const parent = await client.sessions.messages(session.id, {}, { directory });
  for (const id of response.dispositionCallIDs) {
    const calls = parent.records.flatMap(message => message.parts).filter(part => part.type === 'tool' && part.callID === id);
    assert.equal(calls.length, 1); assert.equal(calls[0].tool, 'devryan_task');
    assert.equal(calls[0].state.status, 'completed', 'Council collection/disposition did not finish through its native tool');
  }
  const lease = await runtime.leaseForCall({ directory, sessionID: rootSessionID, callID: call.callID });
  assert.ok(lease);
  assert.equal(lease.executionKind, 'control');
  assert.equal(lease.state, 'published');
  return { id: 'compiled-council-ordered-owned-members', status: 'passed', sessionID: rootSessionID,
    taskIDs: result.results.map(row => row.taskId), childSessionIDs: children, envelopeIDs: envelopes,
    initialDisposition: result.disposition, finalDisposition: 'continue', dispositionCallIDs: response.dispositionCallIDs, selections: members, controlOperationID: lease.result?.operationID,
    source: 'actual-compiled-council-shared-scheduler-canonical-child-lineage-collected-independent-results',
    personalProviderParity: false };
}
