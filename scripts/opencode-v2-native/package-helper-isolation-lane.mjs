import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createV2MessageId } from '../../packages/web/server/lib/opencode/v2/admission.js';
import { waitFor } from './process-lanes.mjs';

/** The helper's real provider request remains pending while a different native
 * session completes. Only the helper is cancelled; its final ACK must settle. */
export async function runCompiledHelperIsolation({ runtimeOwner, client, provider, directory }) {
  const marker = 'Compiled unrelated conversation while helper waits';
  const helperMarker = 'Compiled helper held until unrelated conversation completes';
  let helperStarted, helperAborted, helperPending = true, helperRequests = 0, conversationRequests = 0;
  const started = new Promise(resolve => { helperStarted = resolve; });
  const aborted = new Promise(resolve => { helperAborted = resolve; });
  await provider.setResponder(async (request, signal) => {
    const text = JSON.stringify(request.body.messages);
    if (text.includes(helperMarker)) {
      helperRequests++;
      assert.equal(helperRequests, 1);
      assert.ok(!request.body.tools?.length, 'Text helper must never acquire conversation tools');
      helperStarted();
      await new Promise(resolve => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', resolve, { once: true });
      });
      helperAborted();
      throw signal.reason;
    }
    assert.ok(text.includes(marker)); conversationRequests++;
    assert.equal(conversationRequests, 1);
    assert.equal(helperPending, true, 'The independent conversation must settle before helper release');
    return { items: [{ type: 'textDelta', text: 'Independent native conversation complete' }], reason: 'stop' };
  });
  const cancellation = new AbortController();
  const operationID = randomUUID();
  // Catch immediately: cancellation can settle before the final assertions.
  const helper = runtimeOwner.generateHelperText({ operationID, directory, agent: 'devryan-commit',
    providerID: 'devryan-smoke', modelID: 'smoke-write', variant: 'default', prompt: helperMarker,
    timeoutMs: 30000, maxOutputTokens: 32, signal: cancellation.signal }).then(
      () => { throw new Error('Compiled pending helper unexpectedly completed'); }, error => error);
  try {
    await Promise.race([started, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Compiled helper did not reach the original HTTP provider')), 15000);
      started.finally(() => clearTimeout(timer));
    })]);
    const session = await client.sessions.create({ title: marker, model: { providerID: 'devryan-smoke', modelID: 'smoke-write' } }, { directory });
    await client.prompts.prompt(session.id, { messageID: createV2MessageId(), agent: 'orchestrator', variant: 'default',
      model: { providerID: 'devryan-smoke', modelID: 'smoke-write' }, parts: [{ type: 'text', text: marker }] },
    { directory, origin: 'native_acceptance', timeoutMs: 30000 });
    const messages = await waitFor(() => client.sessions.messages(session.id, {}, { directory }),
      page => page.records.some(row => row.info.role === 'assistant' && row.info.time?.completed && !row.info.error),
      'Unrelated native conversation did not settle while helper was pending');
    const assistant = messages.records.find(row => row.info.role === 'assistant');
    assert.ok(assistant.parts.some(part => part.type === 'text' && part.text.includes('Independent native conversation complete')));
    await waitFor(() => client.sessions.status({ directory }), status => !status[session.id] || status[session.id].type === 'idle',
      'Unrelated conversation remained busy');
    assert.equal(helperPending, true);
    cancellation.abort(new Error('compiled_fixture_helper_cancelled'));
    const failure = await helper;
    assert.notEqual(failure.code, 'native_helper_unsettled', 'Helper cancellation must await actual provider ACK');
    assert.equal(failure.message, 'compiled_fixture_helper_cancelled');
    await aborted; helperPending = false;
    assert.equal(runtimeOwner.isReady(), true, 'Helper cancellation stopped the independent native runtime');
    return { id: 'compiled-helper-hang-independent-native-conversation', status: 'passed', operationID,
      sessionID: session.id, assistantMessageID: assistant.info.id, helperRequests, conversationRequests,
      providerCancellationObserved: true, source: 'actual-helper-provider-pending-native-conversation-completion-and-finalizer-ACK' };
  } finally {
    cancellation.abort(new Error('compiled_fixture_helper_cleanup'));
    await helper;
    await provider.setResponder(() => { throw new Error('Unsolicited packaged model request'); });
  }
}
