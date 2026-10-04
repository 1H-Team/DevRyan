import assert from 'node:assert/strict';
import { createV2MessageId } from '../../packages/web/server/lib/opencode/v2/admission.js';
import { waitFor } from './process-lanes.mjs';

/** Lose the real queued continuation ACK, then recover through a new compiled
 * controller. Only the old runner admission is held; no native rows are edited. */
export async function runCompiledTodoReplacement({ provider, client, managed, runtimeOwner, controller, directory }) {
  const model = { providerID: 'devryan-smoke', modelID: 'smoke-write' };
  const session = await client.sessions.create({ title: 'Compiled TODO continuation recovery', agent: 'orchestrator', model }, { directory });
  await managed.admitPrimary(session.id);
  let phase = 'initial', issued = false, completed = false, requests = 0, blocked = false;
  const responder = request => {
    requests++;
    const messages = request.body.messages, callID = `compiled_todo_${phase}`;
    assert.equal(messages.some(message => JSON.stringify(message).includes('[devryan-open-todo-continuation:v1]')), phase === 'recovered');
    assert.equal(completed, false, 'Duplicate compiled TODO inference');
    if (messages.some(message => message.role === 'tool' && message.tool_call_id === callID)) {
      assert.equal(issued, true); completed = true;
      return { items: [{ type: 'textDelta', text: `compiled TODO ${phase} complete` }], reason: 'stop' };
    }
    assert.equal(issued, false); issued = true;
    assert.ok(request.body.tools.some(tool => tool.function.name === 'todowrite'));
    return { items: [{ type: 'toolCall', index: 0, id: callID, name: 'todowrite', input: { todos: [{
      id: 'compiled-todo', content: 'Verify compiled continuation recovery', priority: 'high',
      status: phase === 'initial' ? 'pending' : 'completed',
    }] } }], reason: 'tool-calls' };
  };
  await provider.setResponder(responder);
  const objectiveID = createV2MessageId();
  await client.prompts.prompt(session.id, { messageID: objectiveID, agent: 'orchestrator', model, variant: 'default',
    parts: [{ type: 'text', text: 'Run the compiled TODO continuity check.' }] }, { directory, delivery: 'queue' });
  const readMessages = () => client.sessions.messages(session.id, {}, { directory });
  const completedPhase = name => page => page.records.some(row => row.info.role === 'assistant' && row.info.time?.completed
    && row.parts?.some(part => part.type === 'text' && part.text === `compiled TODO ${name} complete`));
  await waitFor(readMessages, completedPhase('initial'), 'Compiled TODO initial turn did not settle');
  await waitFor(() => client.sessions.status({ directory }), rows => !rows[session.id] || rows[session.id].type === 'idle', 'Compiled TODO remained busy');
  assert.equal((await client.sessions.todo(session.id, { directory }))[0]?.status, 'pending');
  const initial = await managed.primaryRuntime.readRecord(session.id);
  assert.equal(initial.anchorID, objectiveID);
  assert.equal(requests, 2);

  const owner = runtimeOwner.nativeOwner, originalRpc = owner.handleRpc, originalDispatch = owner.withPrimaryContinuationDispatch;
  const gate = Promise.withResolvers();
  // The rejection belongs to the pending RPC even if teardown wins the race.
  void gate.promise.catch(() => {});
  owner.handleRpc = async (method, input) => {
    if (method === 'native.admission.authorize' && input.operation === 'runner.drain' && input.sessionID === session.id) {
      blocked = true; await gate.promise;
    }
    return originalRpc(method, input);
  };
  owner.withPrimaryContinuationDispatch = async (scope, action) => {
    const result = await originalDispatch(scope, action);
    if (scope.sessionID === session.id) throw Object.assign(new Error('fixture_compiled_todo_ack_lost'), { code: 'fixture_compiled_todo_ack_lost' });
    return result;
  };
  try {
    await assert.rejects(runtimeOwner.continueSessionTodos({ sessionID: session.id, directory }), /fixture_compiled_todo_ack_lost/);
    await waitFor(() => blocked, Boolean, 'Compiled TODO runner did not reach the held admission');
    const reserved = await managed.primaryRuntime.readRecord(session.id), continuationID = reserved.nativeContinuation?.messageID;
    assert.ok(continuationID); assert.equal(reserved.todoContinuationCount, 1);
    assert.equal((await readMessages()).records.some(row => row.info.role === 'assistant' && row.info.parentID === continuationID), false);
    const inboxResponse = await fetch(new URL(`/api/session/${session.id}/inbox`, controller.url), {
      headers: runtimeOwner.getAuthHeaders(), signal: AbortSignal.timeout(10000),
    });
    assert.equal(inboxResponse.status, 200);
    const inbox = await inboxResponse.json();
    assert.ok(Array.isArray(inbox.data));
    assert.equal(inbox.data.length, 1);
    const queued = inbox.data[0];
    assert.equal(queued.id, continuationID); assert.equal(queued.sessionID, session.id);
    assert.equal(queued.type, 'user'); assert.equal(queued.delivery, 'queue');
    assert.ok(queued.payload.text.includes('[devryan-open-todo-continuation:v1]'));
    const exit = await controller.killForRecovery();
    assert.equal(controller.hasExited(), true);
    assert.equal(exit.receipt?.terminated, true); assert.equal(exit.receipt?.confined, true);
    gate.reject(new Error('fixture_old_todo_controller_closed'));
    owner.handleRpc = originalRpc; owner.withPrimaryContinuationDispatch = originalDispatch;
    phase = 'recovered'; issued = false; completed = false;
    const replacement = await runtimeOwner.start();
    assert.notEqual(replacement.instanceID, controller.instanceID);
    const page = await waitFor(readMessages, completedPhase('recovered'), 'Compiled TODO startup recovery did not finish');
    const final = await managed.primaryRuntime.readRecord(session.id);
    assert.equal(final.continuationID, continuationID); assert.equal(final.nativeContinuation, undefined);
    assert.equal(final.todoContinuationCount, 1); assert.equal(final.anchorID, objectiveID);
    assert.equal(final.instanceID, replacement.instanceID);
    for (const key of ['providerID', 'modelID', 'agent', 'variant', 'executionGeneration']) assert.equal(final[key], initial[key]);
    assert.equal(page.records.filter(row => row.info.id === continuationID && row.info.role === 'user').length, 1);
    const assistants = page.records.filter(row => row.info.role === 'assistant' && row.info.parentID === continuationID && row.info.time?.completed);
    assert.equal(assistants.length, 2); assert.equal(new Set(assistants.map(row => row.info.id)).size, 2);
    const tools = page.records.flatMap(row => row.parts ?? []).filter(part => part.type === 'tool');
    for (const [name, rev, status] of [['initial', 1, 'pending'], ['recovered', 2, 'completed']]) {
      const calls = tools.filter(part => part.callID === `compiled_todo_${name}`);
      assert.equal(calls.length, 1); assert.equal(calls[0].state.status, 'completed');
      const result = JSON.parse(calls[0].state.output);
      assert.equal(result.sessionID, session.id); assert.equal(result.rev, rev); assert.equal(result.items[0].status, status);
    }
    assert.equal((await client.sessions.todo(session.id, { directory }))[0]?.status, 'completed');
    assert.equal(requests, 4);
    await waitFor(() => client.sessions.status({ directory }), rows => !rows[session.id] || rows[session.id].type === 'idle', 'Recovered TODO remained busy');
    assert.deepEqual(await runtimeOwner.continueSessionTodos({ sessionID: session.id, directory }), { continued: false, reason: 'todos_complete' });
    assert.equal(requests, 4);
    return { id: 'compiled-todo-lost-ack-replacement', status: 'passed', sessionID: session.id, objectiveID, continuationID,
      oldInstanceID: controller.instanceID, instanceID: replacement.instanceID, todoRevision: 2, continuationCount: 1,
      source: 'actual-compiled-todo-tools-native-queued-inbox-lost-ack-and-production-startup-recovery', controllerExit: exit };
  } finally {
    gate.reject(new Error('fixture_compiled_todo_cleanup'));
    owner.handleRpc = originalRpc; owner.withPrimaryContinuationDispatch = originalDispatch;
  }
}
