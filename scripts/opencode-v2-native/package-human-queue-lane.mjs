import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { managedTaskTurn, assertWriterOutcome } from './assertions.mjs';
import { waitFor } from './process-lanes.mjs';
import { createV2MessageId } from '../../packages/web/server/lib/opencode/v2/admission.js';

const text = value => typeof value === 'string' ? value : Array.isArray(value)
  ? value.filter(part => part?.type === 'text').map(part => part.text).join('\n') : '';
const awaitGate = async (gate, signal) => {
  const timer = new AbortController();
  try { await Promise.race([gate, delay(30_000, undefined, { signal: AbortSignal.any([signal, timer.signal]) })
    .then(() => { throw Error('compiled_queue_fixture_barrier_timeout'); })]); signal.throwIfAborted(); }
  finally { timer.abort(); }
};

/** The real start tool returns, and the parent ends without emitting a wait.
 * The child provider stays held; no task, message or tool result is manufactured. */
export function createBackgroundQueueResponder({ caseID, holdChild, onChild, textOnly = false }) {
  const turn = managedTaskTurn(caseID, 'fixer');
  const queueMarker = `[devryan-human-queue:${caseID}]`, steerMarker = `[devryan-human-steer:${caseID}]`;
  let taskID, parentReplies = 0, queueReplies = 0, steerReplies = 0, childRequests = 0;
  return { marker: turn.marker, childMarker: turn.childMarker, callIDs: turn.callIDs, queueMarker, steerMarker,
    inspect: () => ({ taskID, parentReplies, queueReplies, steerReplies, childRequests }),
    responder: async (request, signal) => {
      const messages = request.body.messages, user = text(messages.filter(row => row.role === 'user').findLast(row =>
        [queueMarker, steerMarker, turn.marker, turn.childMarker].some(marker => text(row.content).includes(marker)))?.content);
      if (user.includes(queueMarker)) {
        assert.equal(++queueReplies, 1, 'Human queue was inferred more than once');
        return { items: [{ type: 'textDelta', text: `Queued input completed ${caseID}` }], reason: 'stop' };
      }
      if (user.includes(steerMarker)) {
        assert.equal(++steerReplies, 1, 'Manual steer was inferred more than once');
        return { items: [{ type: 'textDelta', text: `Manual steer completed ${caseID}` }], reason: 'stop' };
      }
      if (user.includes(turn.childMarker) && !user.includes(turn.marker)) {
        if (!messages.some(row => row.role === 'tool' && row.tool_call_id === turn.callIDs.writerID)) {
          assert.equal(++childRequests, 1, 'Managed child initial inference repeated');
          onChild(); await holdChild(signal);
          if (textOnly) return { items: [{ type: 'textDelta', text: `Managed text child completed ${caseID}` }], reason: 'stop' };
        }
        return turn.responder(request);
      }
      if (messages.some(row => row.role === 'tool' && row.tool_call_id === turn.callIDs.startID)) {
        const result = turn.responder(request); // Existing exact real start/replay check.
        assert.equal(result.items[0].id, turn.callIDs.waitID);
        const submitted = messages.find(row => row.role === 'tool' && row.tool_call_id === turn.callIDs.startID);
        taskID = JSON.parse(text(submitted.content)).task.taskId;
        assert.equal(++parentReplies, 1);
        return { items: [{ type: 'textDelta', text: `Parent launched child ${caseID}` }], reason: 'stop' };
      }
      return turn.responder(request);
    },
  };
}

/** Real compiled parent/child work with narrow transport barriers only. */
export async function runCompiledHumanQueue({ provider, client, managed, runtimeOwner, controller,
  nativeTransport, directory, executionHost, observations }) {
  const abort = new AbortController(), timeout = setTimeout(() => abort.abort(Error('compiled_human_queue_timeout')), 60_000);
  const originalFetch = nativeTransport.fetch, originalCall = controller.call;
  const model = { providerID: 'devryan-smoke', modelID: 'smoke-write' };
  const results = [], pendingWork = [];
  const inbox = async sessionID => {
    const response = await fetch(new URL(`/api/session/${sessionID}/inbox`, controller.url), {
      headers: { ...runtimeOwner.getAuthHeaders(), 'x-opencode-directory': encodeURIComponent(directory) }, signal: abort.signal });
    assert.equal(response.status, 200); const value = await response.json(); assert.ok(Array.isArray(value.data)); return value.data;
  };
  const primaryIdentity = record => ({ anchorID: record?.anchorID, cancellationGeneration: record?.cancellationGeneration,
    agent: record?.agent, providerID: record?.providerID, modelID: record?.modelID, variant: record?.variant, tools: record?.tools });
  const settled = async (sessionID, expected) => {
    const page = await client.sessions.messages(sessionID, {}, { directory, signal: abort.signal });
    if (!page.records.some(row => row.info.role === 'assistant' && row.info.time?.completed
      && row.parts.some(part => part.type === 'text' && part.text === expected))) return false;
    const status = await client.sessions.status({ directory, signal: abort.signal });
    return !status[sessionID] || status[sessionID].type === 'idle';
  };
  const assertAbsent = async (sessionID, messageID, before) => {
    assert.equal((await inbox(sessionID)).some(row => row.id === messageID), false);
    assert.equal((await client.sessions.messages(sessionID, {}, { directory })).records.some(row => row.info.id === messageID), false);
    assert.deepEqual(primaryIdentity(await managed.readPrimaryRecord(sessionID)), before, 'Refused queue replaced the primary objective');
  };
  try {
    for (const manual of [false, true]) {
      const caseID = `queue-${randomUUID()}`, session = await client.sessions.create({ title: 'Compiled human queue ownership', agent: 'orchestrator', model }, { directory });
      await managed.admitPrimary(session.id);
      let releaseChild, enteredChild, releaseChildPost, enteredPost, releaseProof, enteredProof;
      const childHeld = new Promise(resolve => { releaseChild = resolve; }), childEntered = new Promise(resolve => { enteredChild = resolve; });
      const postHeld = new Promise(resolve => { releaseChildPost = resolve; }), postEntered = new Promise(resolve => { enteredPost = resolve; });
      const proofHeld = new Promise(resolve => { releaseProof = resolve; }), proofEntered = new Promise(resolve => { enteredProof = resolve; });
      const response = createBackgroundQueueResponder({ caseID, textOnly: manual, onChild: enteredChild,
        holdChild: signal => awaitGate(childHeld, AbortSignal.any([abort.signal, signal])) });
      const queueID = createV2MessageId(), body = { messageID: queueID, agent: 'orchestrator', model, variant: 'default',
        parts: [{ type: 'text', text: response.queueMarker }] };
      const options = { directory, origin: 'human', delivery: 'queue', signal: abort.signal, timeoutMs: 30_000 };
      let childID, proofMode, proofCalls = 0, queuePosts = 0;
      nativeTransport.fetch = async (url, input) => {
        const route = new URL(url).pathname;
        if (input?.method === 'POST' && /^\/api\/session\/[^/]+\/prompt$/.test(route)) {
          const request = JSON.parse(input.body);
          if (request.id === queueID) queuePosts++;
          if (!manual && request.text?.includes(response.childMarker) && !request.text.includes(response.marker)) {
            childID = route.split('/')[3]; enteredPost();
            await awaitGate(postHeld, AbortSignal.any([abort.signal, ...input.signal ? [input.signal] : []]));
          }
        }
        return originalFetch(url, input);
      };
      controller.call = async (...args) => {
        const value = await originalCall(...args);
        if (args[0]?.action === 'queued-primary-idle-owned' && args[0].sessionID === session.id && args[0].messageID === queueID) {
          proofCalls++;
          if (proofMode === 'unavailable') throw Object.assign(Error('fixture_queued_idle_ack_unavailable'), { code: 'fixture_queued_idle_ack_unavailable' });
          if (proofMode === 'race') { enteredProof(); await awaitGate(proofHeld, abort.signal); }
        }
        return value;
      };
      await provider.setResponder(response.responder);
      const initialID = createV2MessageId();
      await client.prompts.prompt(session.id, { messageID: initialID, agent: 'orchestrator', model, variant: 'default',
        parts: [{ type: 'text', text: response.marker }] }, { directory, origin: 'native_acceptance', signal: abort.signal });
      await waitFor(() => settled(session.id, `Parent launched child ${caseID}`), Boolean, 'Real parent did not complete independently of its child');
      if (!manual) await awaitGate(postEntered, abort.signal); else await awaitGate(childEntered, abort.signal);
      const primary = primaryIdentity(await managed.readPrimaryRecord(session.id));
      assert.equal(primary.anchorID, initialID, 'Original accepted parent did not reach the real primary owner');
      if (!manual) {
        const requests = provider.requests.length;
        proofMode = 'unavailable';
        await assert.rejects(client.prompts.prompt(session.id, body, options), error => error.code === 'fixture_queued_idle_ack_unavailable');
        assert.equal(queuePosts, 0); assert.equal(provider.requests.length, requests); await assertAbsent(session.id, queueID, primary);
        proofMode = 'race';
        const pending = client.prompts.prompt(session.id, body, options).then(() => null, error => error);
        pendingWork.push(pending);
        await awaitGate(proofEntered, abort.signal); releaseChildPost(); await awaitGate(childEntered, abort.signal);
        await waitFor(() => client.sessions.status({ directory }), status => status[childID]?.type === 'busy', 'Real child never became active during the queued proof await');
        const beforeRejected = provider.requests.length; releaseProof();
        assert.equal((await pending)?.code, 'native_queued_input_blocked');
        assert.equal(queuePosts, 1); assert.equal(provider.requests.length, beforeRejected); await assertAbsent(session.id, queueID, primary);
        proofMode = undefined;
        await assert.rejects(client.prompts.prompt(session.id, body, options), error => error.code === 'native_queued_input_blocked');
        assert.equal(queuePosts, 1); assert.equal(provider.requests.length, beforeRejected); await assertAbsent(session.id, queueID, primary);
        releaseChild();
        const task = await waitFor(async () => (await managed.getManagedRuntime().getSnapshot({ rootSessionId: session.id })).tasks[0],
          row => row?.status === 'completed', 'Actual managed writer child did not complete');
        assert.equal(task.taskId, response.inspect().taskID); assert.equal(task.childSessionId, childID);
        assert.equal((await client.sessions.get(childID, { directory })).parentID, session.id);
        const childHistory = await client.sessions.messages(childID, {}, { directory });
        const writerCalls = childHistory.records.flatMap(row => row.parts).filter(part => part.type === 'tool' && part.callID === response.callIDs.writerID);
        assert.equal(writerCalls.length, 1); assert.equal(writerCalls[0].state.status, 'completed');
        await assertWriterOutcome({ runtime: executionHost.runtime, directory, sessionID: childID,
          callID: response.callIDs.writerID, observations, succeeded: true });
        assert.equal(observations.filter(row => row.callID === response.callIDs.writerID && row.phase === 'published').length, 1);
        assert.equal(observations.filter(row => row.callID === response.callIDs.writerID && row.phase === 'termination_verified').length, 1);
        assert.equal(await fs.readFile(path.join(directory, `managed-${caseID}.txt`), 'utf8'), `managed writer ${caseID}\n`);
        await waitFor(() => client.sessions.status({ directory }), status => !status[childID] || status[childID].type === 'idle', 'Completed real child did not release execution');
        await client.prompts.prompt(session.id, body, options);
        await waitFor(() => settled(session.id, `Queued input completed ${caseID}`), Boolean, 'Same retained human queue ID did not complete after child settlement');
        assert.equal(queuePosts, 2); assert.equal(response.inspect().queueReplies, 1);
        await client.prompts.prompt(session.id, body, options);
        assert.equal(queuePosts, 2); assert.equal(response.inspect().queueReplies, 1);
        assert.equal((await client.sessions.messages(session.id, {}, { directory })).records.filter(row => row.info.id === queueID).length, 1);
        assert.equal((await managed.readPrimaryRecord(session.id)).anchorID, queueID);
        results.push({ id: 'compiled-human-queue-child-idle-and-await-race', status: 'passed', sessionID: session.id, childSessionID: childID,
          taskID: task.taskId, messageID: queueID, queuePosts, proofCalls, unavailableProof: 'lost-original-idle-proof-ack',
          unknownNativeIsActiveDefect: 'source-graph-only', writerCallID: response.callIDs.writerID });
      } else {
        const task = (await managed.getManagedRuntime().getSnapshot({ rootSessionId: session.id })).tasks[0]; childID = task.childSessionId;
        assert.equal(task.taskId, response.inspect().taskID);
        assert.equal((await client.sessions.get(childID, { directory })).parentID, session.id);
        await waitFor(() => client.sessions.status({ directory }), status => status[childID]?.type === 'busy', 'Real manual-steer child was not active');
        const steerID = createV2MessageId();
        await client.prompts.prompt(session.id, { ...body, messageID: steerID, parts: [{ type: 'text', text: response.steerMarker }] }, { ...options, delivery: 'steer' });
        await waitFor(() => settled(session.id, `Manual steer completed ${caseID}`), Boolean, 'Explicit manual steer did not run while real child was active');
        assert.equal(response.inspect().steerReplies, 1); assert.equal((await managed.readPrimaryRecord(session.id)).anchorID, steerID);
        releaseChild();
        const outcome = await waitFor(async () => (await managed.getManagedRuntime().getSnapshot({ rootSessionId: session.id })).tasks[0],
          row => ['completed', 'failed', 'aborted', 'interrupted'].includes(row?.status), 'Old manual-steer child ownership never settled');
        await waitFor(() => client.sessions.status({ directory }), status => !status[childID] || status[childID].type === 'idle', 'Old manual-steer child remained physically active');
        results.push({ id: 'compiled-human-explicit-steer-with-busy-child', status: 'passed', sessionID: session.id,
          childSessionID: childID, messageID: steerID, oldChildDisposition: outcome.status, textOnlyChild: true });
      }
      assert.equal((await client.sessions.messages(session.id, {}, { directory })).records.flatMap(row => row.parts)
        .some(part => part.type === 'tool' && part.callID === response.callIDs.waitID), false, 'Fixture parent unexpectedly waited for its child');
      nativeTransport.fetch = originalFetch; controller.call = originalCall;
    }
    return results;
  } finally {
    clearTimeout(timeout); abort.abort(); nativeTransport.fetch = originalFetch; controller.call = originalCall;
    await Promise.allSettled(pendingWork);
  }
}
