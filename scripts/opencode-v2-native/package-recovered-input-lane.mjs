import assert from 'node:assert/strict';
import { createV2MessageId } from '../../packages/web/server/lib/opencode/v2/admission.js';
import { waitFor } from './process-lanes.mjs';
import { runCompiledRecoveredShell } from './package-recovered-shell-lane.mjs';

/** Real accepted inputs and compiled controller replacement; no native rows are
 * manufactured. Only the departing runner and actual response ACKs are held. */
export async function runCompiledRecoveredInputs({ provider, client, managed, runtimeOwner, nativeTransport, getController, directory, databasePath, executionHost, observations, reviewedSetup = false, onCase, onExit }) {
  const model = { providerID: 'devryan-smoke', modelID: 'smoke-write' };
  const cases = [], exits = [];
  const recordCase = row => { cases.push(row); onCase?.(row); };
  const recordExit = exit => { exits.push(exit); onExit?.(exit); };
  let requests = 0, expectedText;
  await provider.setResponder(request => {
    requests++;
    assert.ok(expectedText, 'Recovered input ran without explicit permission');
    assert.equal(request.body.messages.some(message => message.role === 'user'
      && JSON.stringify(message.content).includes(expectedText)), true);
    return { items: [{ type: 'textDelta', text: `completed ${expectedText}` }], reason: 'stop' };
  });
  const route = (sessionID, action = '') => `/api/session/${sessionID}/recovery${action}?directory=${encodeURIComponent(directory)}`;
  const request = (method, sessionID, action = '', body) => managed.requestRecovery(method, route(sessionID, action), body);
  const snapshot = async sessionID => {
    const result = await request('GET', sessionID);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  };
  const messages = sessionID => client.sessions.messages(sessionID, {}, { directory });
  const inbox = async sessionID => {
    const response = await fetch(new URL(`/api/session/${sessionID}/inbox`, getController().url), {
      headers: runtimeOwner.getAuthHeaders(), signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.ok(Array.isArray(value.data));
    return value.data;
  };
  const restart = async () => {
    const previous = getController(), exit = await previous.killForRecovery();
    assert.equal(exit.receipt?.terminated, true); assert.equal(exit.receipt?.confined, true);
    recordExit(exit);
    const replacement = await runtimeOwner.start();
    assert.notEqual(replacement.instanceID, previous.instanceID);
    assert.equal(runtimeOwner.isReady(), true);
    return replacement;
  };
  const pin = (state, messageID) => {
    const input = state.recoveredInput?.inputs.find(row => row.messageID === messageID);
    assert.ok(input, `Missing recovered input ${messageID}`);
    assert.match(input.payloadHash, /^[a-f0-9]{64}$/);
    assert.equal(input.location, 'queued');
    return { input, body: { revision: state.recoveredInput.revision, messageID, payloadHash: input.payloadHash } };
  };
  const prompt = (text, messageID = createV2MessageId()) => ({ messageID, agent: 'orchestrator', model,
    variant: 'default', parts: [{ type: 'text', text }] });
  const queueAndReplace = async (texts, { loseAck = false } = {}) => {
    const session = await client.sessions.create({ title: 'Compiled retained input recovery', agent: 'orchestrator', model }, { directory });
    await managed.admitPrimary(session.id);
    const owner = runtimeOwner.nativeOwner, originalRpc = owner.handleRpc, originalFetch = nativeTransport.fetch;
    const gate = Promise.withResolvers(); void gate.promise.catch(() => {});
    let blocked = false;
    const bodies = texts.map(text => prompt(text));
    owner.handleRpc = async (method, input) => {
      if (method === 'native.admission.authorize' && input.operation === 'runner.drain' && input.sessionID === session.id) {
        blocked = true; await gate.promise;
      }
      return originalRpc(method, input);
    };
    nativeTransport.fetch = async (url, input) => {
      const response = await originalFetch(url, input);
      if (loseAck && input?.method === 'POST' && new URL(url).pathname === `/api/session/${session.id}/prompt`
        && bodies.some(body => body.messageID === JSON.parse(input.body).id)) {
        assert.equal(response.ok, true); await response.arrayBuffer();
        throw Object.assign(new Error('fixture_accepted_input_ack_lost'), { code: 'fixture_accepted_input_ack_lost' });
      }
      return response;
    };
    try {
      for (const body of bodies) {
        const dispatch = client.prompts.prompt(session.id, body, { directory, delivery: 'queue' });
        if (loseAck) await assert.rejects(dispatch, /fixture_accepted_input_ack_lost/);
        else await dispatch;
      }
      await waitFor(() => blocked, Boolean, 'Accepted input runner did not reach held admission');
      assert.deepEqual((await inbox(session.id)).map(row => row.id), bodies.map(body => body.messageID));
      assert.equal((await messages(session.id)).records.some(row => row.info.role === 'user'), false);
      if (loseAck) {
        const uncertain = await managed.primaryRuntime.readRecord(session.id);
        assert.equal(uncertain.state, 'needs_attention'); assert.equal(uncertain.reason, 'prompt_dispatch_uncertain');
      }
      const previous = getController(), exit = await previous.killForRecovery();
      assert.equal(exit.receipt?.terminated, true); assert.equal(exit.receipt?.confined, true); recordExit(exit);
      gate.reject(new Error('fixture_retained_input_controller_closed'));
      owner.handleRpc = originalRpc; nativeTransport.fetch = originalFetch;
      const replacement = await runtimeOwner.start();
      assert.notEqual(replacement.instanceID, previous.instanceID); assert.equal(runtimeOwner.isReady(), true);
      return { sessionID: session.id, bodies, oldInstanceID: previous.instanceID, instanceID: replacement.instanceID };
    } finally {
      gate.reject(new Error('fixture_retained_input_cleanup'));
      owner.handleRpc = originalRpc; nativeTransport.fetch = originalFetch;
    }
  };
  const finish = async (sessionID, body, text) => {
    const before = requests;
    expectedText = text;
    const response = await request('POST', sessionID, '/resume-input', body);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const page = await waitFor(() => messages(sessionID), value => value.records.some(row => row.info.role === 'assistant'
      && row.info.parentID === body.messageID && row.info.time?.completed
      && row.parts.some(part => part.type === 'text' && part.text === `completed ${text}`)), 'Explicit same-ID input did not finish');
    await waitFor(() => client.sessions.status({ directory }), value => !value[sessionID] || value[sessionID].type === 'idle', 'Recovered input remained busy');
    assert.equal(requests, before + 1); assert.deepEqual(await inbox(sessionID), []);
    assert.equal(page.records.filter(row => row.info.role === 'user' && row.info.id === body.messageID).length, 1);
    assert.equal(page.records.filter(row => row.info.role === 'assistant' && row.info.parentID === body.messageID).length, 1);
    expectedText = undefined;
  };

  const firstText = 'retained initial prompt with lost acknowledgement';
  const first = await queueAndReplace([firstText], { loseAck: true });
  assert.equal(requests, 0);
  const before = await managed.primaryRuntime.readRecord(first.sessionID);
  const state = await snapshot(first.sessionID), selected = pin(state, first.bodies[0].messageID);
  assert.equal(state.recoveredInput.state, 'paused'); assert.equal(selected.input.canResume, true); assert.equal(selected.input.canDiscard, true);
  const details = await managed.requestRecovery('GET', `${route(first.sessionID, '/input')}&${new URLSearchParams(selected.body)}`);
  assert.equal(details.status, 200); assert.equal(details.body.messageID, selected.body.messageID);
  assert.ok(details.body.text.includes(firstText)); assert.deepEqual(details.body.files, []);
  const changed = await request('POST', first.sessionID, '/resume-input', { ...selected.body, payloadHash: '0'.repeat(64) });
  assert.equal(changed.status, 409);
  await assert.rejects(client.prompts.prompt(first.sessionID, prompt('Must stay blocked'), { directory, delivery: 'queue' }));
  const after = await managed.primaryRuntime.readRecord(first.sessionID);
  assert.equal(after.anchorID, before.anchorID); assert.equal(after.revision, before.revision);
  assert.deepEqual((await inbox(first.sessionID)).map(row => row.id), [selected.body.messageID]); assert.equal(requests, 0);
  await finish(first.sessionID, selected.body, firstText);
  await restart();
  assert.equal(requests, 1); assert.deepEqual(await inbox(first.sessionID), []);
  assert.equal((await messages(first.sessionID)).records.filter(row => row.info.role === 'user').length, 1);
  const repeated = await request('POST', first.sessionID, '/resume-input', selected.body);
  assert.equal(repeated.status, 409); assert.equal(requests, 1);
  recordCase({ id: 'compiled-retained-initial-input', status: 'passed', sessionID: first.sessionID,
    oldInstanceID: first.oldInstanceID, instanceID: first.instanceID,
    messageID: selected.body.messageID, payloadHash: selected.body.payloadHash,
    source: 'accepted-native-input-lost-ack-startup-fence-lazy-details-and-explicit-same-id-resume' });

  const second = await queueAndReplace(['older retained input', 'latest retained input']);
  assert.equal(requests, 1);
  const multiple = await snapshot(second.sessionID), older = pin(multiple, second.bodies[0].messageID), latest = pin(multiple, second.bodies[1].messageID);
  assert.equal(older.input.canResume, false); assert.equal(older.input.canDiscard, true); assert.equal(latest.input.canResume, false);
  const refused = await request('POST', second.sessionID, '/resume-input', latest.body); assert.equal(refused.status, 409);
  const discarded = await request('POST', second.sessionID, '/discard-input', older.body);
  assert.equal(discarded.status, 200, `Older recovered input discard: ${JSON.stringify(discarded.body)}`);
  assert.deepEqual((await inbox(second.sessionID)).map(row => row.id), [latest.body.messageID]); assert.equal(requests, 1);
  const remaining = pin(await snapshot(second.sessionID), latest.body.messageID); assert.equal(remaining.input.canResume, true);
  await finish(second.sessionID, remaining.body, 'latest retained input');
  assert.equal((await messages(second.sessionID)).records.some(row => row.info.id === older.body.messageID), false);
  recordCase({ id: 'compiled-retained-multiple-inputs', status: 'passed', sessionID: second.sessionID,
    discardedMessageID: older.body.messageID, resumedMessageID: latest.body.messageID,
    source: 'real-multiple-accepted-native-inputs-older-exact-discard-and-single-current-owner-resume' });

  const third = await queueAndReplace(['discard acknowledgement loss']);
  const pending = pin(await snapshot(third.sessionID), third.bodies[0].messageID);
  const child = getController(), originalCall = child.call;
  let cancelled = false;
  child.call = async (...args) => {
    const result = await originalCall(...args);
    if (args[0].action === 'cancel-recovered-input-owned' && args[0].messageID === pending.body.messageID) {
      cancelled = true; throw Object.assign(new Error('fixture_input_cancel_ack_lost'), { code: 'fixture_input_cancel_ack_lost' });
    }
    return result;
  };
  try {
    const response = await request('POST', third.sessionID, '/discard-input', pending.body);
    assert.equal(response.status, 503); assert.equal(cancelled, true);
  } finally { child.call = originalCall; }
  assert.deepEqual(await inbox(third.sessionID), []); assert.equal(requests, 2);
  await restart();
  const settled = await snapshot(third.sessionID);
  assert.equal(settled.recoveredInput?.inputs.some(row => row.messageID === pending.body.messageID) ?? false, false);
  assert.deepEqual(await inbox(third.sessionID), []);
  assert.equal((await messages(third.sessionID)).records.some(row => row.info.id === pending.body.messageID), false);
  assert.equal(requests, 2); provider.check();
  expectedText = 'ordinary prompt after recovered discard';
  const fresh = prompt(expectedText);
  await client.prompts.prompt(third.sessionID, fresh, { directory, delivery: 'queue' });
  const freshPage = await waitFor(() => messages(third.sessionID), value => value.records.some(row => row.info.role === 'assistant'
    && row.info.parentID === fresh.messageID && row.info.time?.completed), 'Settled discard kept fresh admission fenced');
  assert.equal(freshPage.records.filter(row => row.info.role === 'user').length, 1);
  assert.equal(requests, 3); expectedText = undefined;
  await waitFor(() => client.sessions.status({ directory }), value => !value[third.sessionID] || value[third.sessionID].type === 'idle', 'Fresh input remained busy');
  recordCase({ id: 'compiled-retained-input-discard-lost-ack', status: 'passed', sessionID: third.sessionID,
    messageID: pending.body.messageID, freshMessageID: fresh.messageID,
    source: 'real-native-cancel-event-lost-ack-durable-owner-intent-controller-replacement-and-fresh-admission' });
  // The first rate limit must precede any Step on its replacement controller.
  if (reviewedSetup) await restart();
  if (reviewedSetup) for (const action of ['resume', 'discard']) {
    const session = await client.sessions.create({ title: 'Compiled retained fallback input', agent: 'orchestrator', model }, { directory });
    await managed.admitPrimary(session.id);
    const body = prompt(`retained fallback input after real rate limit: ${action}`);
    const owner = runtimeOwner.nativeOwner, originalRpc = owner.handleRpc;
    const gate = Promise.withResolvers(); void gate.promise.catch(() => {});
    let blocked = false, fallbackRequests = 0, allowFallback = false;
    owner.handleRpc = async (method, input) => {
      if (method === 'native.admission.authorize' && input.operation === 'runner.drain' && input.sessionID === session.id
        && (await managed.primaryRuntime.readRecord(session.id))?.recoveryID) { blocked = true; await gate.promise; }
      return originalRpc(method, input);
    };
    await provider.setResponder(request => {
      fallbackRequests++;
      if (request.body.model === model.modelID) {
        assert.equal(fallbackRequests, 1, 'Original failed model was retried');
        return { rateLimited: true };
      }
      assert.equal(allowFallback, true, 'Retained fallback ran before explicit resume');
      assert.equal(request.body.model, 'gpt-5-native-smoke'); assert.equal(fallbackRequests, 2);
      assert.ok(request.body.tools.length > 0);
      assert.ok(request.body.tools.every(tool => ['read', 'glob', 'grep'].includes(tool.function.name)), 'Fallback gained write/control tools');
      return { items: [{ type: 'textDelta', text: 'retained fallback complete' }], reason: 'stop' };
    });
    try {
      await client.prompts.prompt(session.id, body, { directory, delivery: 'queue' });
      const failed = await waitFor(() => messages(session.id), value => value.records.some(row => row.info.role === 'assistant'
        && row.info.parentID === body.messageID && row.info.time?.completed && row.info.error), 'Original native 429 did not settle');
      const failedAssistant = failed.records.find(row => row.info.role === 'assistant' && row.info.parentID === body.messageID && row.info.error);
      const initial = await managed.primaryRuntime.readRecord(session.id);
      assert.equal(initial.nativeFallback?.execution.modelID, 'gpt-5-native-smoke');
      assert.equal(initial.nativeFallback.stepID, failedAssistant.info.id); assert.equal(initial.attemptCount, 0);
      const status = await waitFor(() => client.sessions.status({ directory }), value => !value[session.id] || value[session.id].type === 'idle', 'Failed native model remained busy');
      // Production SSE provides this hint. The fixture uses the actual idle
      // read; the owner still rereads canonical failure/settlement/authorization.
      await managed.primaryRuntime.observe({ type: 'session.status', properties: { sessionID: session.id, status: status[session.id] ?? { type: 'idle' } } });
      await waitFor(() => blocked, Boolean, 'Fallback input did not reach held runner');
      const reserved = await managed.primaryRuntime.readRecord(session.id);
      assert.ok(reserved.recoveryID); assert.equal(reserved.attemptCount, 1);
      assert.equal(reserved.recoveryExecution.modelID, 'gpt-5-native-smoke');
      assert.equal(reserved.recoveryPrompt.tools['*'], false);
      assert.deepEqual((await inbox(session.id)).map(row => row.id), [reserved.recoveryID]);
      assert.equal(fallbackRequests, 1);
      const previous = getController(), exit = await previous.killForRecovery();
      assert.equal(exit.receipt?.terminated, true); assert.equal(exit.receipt?.confined, true); recordExit(exit);
      gate.reject(new Error('fixture_retained_fallback_controller_closed')); owner.handleRpc = originalRpc;
      const replacement = await runtimeOwner.start(); assert.notEqual(replacement.instanceID, previous.instanceID);
      const current = pin(await snapshot(session.id), reserved.recoveryID);
      assert.equal(current.input.canResume, true); assert.equal(fallbackRequests, 1);
      if (action === 'discard') {
        const discarded = await request('POST', session.id, '/discard-input', current.body);
        assert.equal(discarded.status, 200, JSON.stringify(discarded.body));
        const retained = await managed.primaryRuntime.readRecord(session.id);
        assert.equal(retained.anchorID, body.messageID); assert.equal(retained.recoveryID, reserved.recoveryID); assert.equal(retained.attemptCount, 1);
        assert.deepEqual(retained.recoveryExecution, reserved.recoveryExecution); assert.deepEqual(retained.allowedReadTools, reserved.allowedReadTools);
        assert.equal(retained.guardedIDs.includes(reserved.recoveryID), true);
        await restart(); assert.equal(fallbackRequests, 1); assert.deepEqual(await inbox(session.id), []);
        const freshText = 'ordinary prompt after discarded fallback';
        await provider.setResponder(request => {
          fallbackRequests++; assert.equal(fallbackRequests, 2); assert.equal(request.body.model, model.modelID);
          assert.ok(JSON.stringify(request.body.messages.findLast(message => message.role === 'user').content).includes(freshText));
          return { items: [{ type: 'textDelta', text: 'discarded fallback remains discarded' }], reason: 'stop' };
        });
        const fresh = prompt(freshText);
        await client.prompts.prompt(session.id, fresh, { directory, delivery: 'queue' });
        await waitFor(() => messages(session.id), value => value.records.some(row => row.info.parentID === fresh.messageID
          && row.info.role === 'assistant' && row.info.time?.completed), 'Discarded fallback blocked fresh ordinary prompt');
        await waitFor(() => client.sessions.status({ directory }), value => !value[session.id] || value[session.id].type === 'idle', 'Post-discard ordinary prompt remained busy');
        assert.equal((await managed.primaryRuntime.readRecord(session.id)).guardedIDs.includes(reserved.recoveryID), true);
        await restart(); assert.equal(fallbackRequests, 2); provider.check();
        const page = await messages(session.id);
        assert.equal(page.records.some(row => row.info.id === reserved.recoveryID), false);
        assert.equal(page.records.filter(row => row.info.id === fresh.messageID).length, 1);
        recordCase({ id: 'compiled-retained-fallback-discard-and-new-prompt', status: 'passed', sessionID: session.id,
          anchorID: body.messageID, discardedRecoveryID: reserved.recoveryID, freshMessageID: fresh.messageID,
          source: 'actual-readonly-fallback-discard-preserved-history-new-admission-and-repeated-controller-replacement' });
        continue;
      }
      allowFallback = true;
      const resumed = await request('POST', session.id, '/resume-input', current.body); assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
      const page = await waitFor(() => messages(session.id), value => value.records.some(row => row.info.role === 'assistant'
        && row.info.parentID === reserved.recoveryID && row.info.time?.completed
        && row.parts.some(part => part.type === 'text' && part.text === 'retained fallback complete')), 'Explicit fallback did not finish');
      assert.equal(page.records.filter(row => row.info.id === reserved.recoveryID && row.info.role === 'user').length, 1);
      assert.equal(page.records.filter(row => row.info.parentID === reserved.recoveryID && row.info.role === 'assistant').length, 1);
      const final = await managed.primaryRuntime.readRecord(session.id);
      assert.equal(final.anchorID, body.messageID); assert.equal(final.recoveryID, reserved.recoveryID); assert.equal(final.attemptCount, 1);
      assert.deepEqual(final.recoveryExecution, reserved.recoveryExecution); assert.deepEqual(final.allowedReadTools, reserved.allowedReadTools);
      assert.equal(fallbackRequests, 2); assert.deepEqual(await inbox(session.id), []);
      await waitFor(() => client.sessions.status({ directory }), value => !value[session.id] || value[session.id].type === 'idle', 'Resumed fallback remained busy');
      allowFallback = false;
      await restart(); assert.equal(fallbackRequests, 2); provider.check();
      recordCase({ id: 'compiled-retained-fallback-input', status: 'passed', sessionID: session.id, anchorID: body.messageID,
        failedAssistantID: failedAssistant.info.id, recoveryID: reserved.recoveryID, attemptCount: 1,
        execution: final.recoveryExecution, allowedReadTools: final.allowedReadTools,
        source: 'actual-http-429-original-slim-retry-owned-readonly-fallback-queue-replacement-and-explicit-same-id-resume' });
    } finally { gate.reject(new Error('fixture_retained_fallback_cleanup')); owner.handleRpc = originalRpc; }
  }
  await runCompiledRecoveredShell({ provider, client, managed, runtimeOwner, getController, directory, databasePath, executionHost, observations,
    onCase: recordCase, onExit: recordExit });
  return { cases, exits };
}
