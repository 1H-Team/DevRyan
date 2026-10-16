import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createStandardSessionTitleRuntime } from '../../packages/web/server/lib/opencode/standard-session-title-runtime.js';
import { createV2MessageId } from '../../packages/web/server/lib/opencode/v2/admission.js';
import { waitFor } from './process-lanes.mjs';

async function preparePendingCompiledTitle({ runtimeOwner, client, provider, directory, root, getRuntimeOwner, enrollPrimary, recordDiagnostic }) {
  const requestText = 'Restore the pending compiled session title after controller replacement';
  const expectedTitle = 'Pending Compiled Session Title';
  const originalControllerID = runtimeOwner.checkpointController().instanceID;
  let helperRequests = 0, conversationRequests = 0, fixtureRefusals = 0, renameCount = 0;
  await provider.setResponder(request => {
    const messages = JSON.stringify(request.body.messages);
    assert.ok(messages.includes(requestText));
    if (messages.includes('Generate a concise title for this coding session')) {
      assert.equal(++helperRequests, 1, 'Pending title must infer only once');
      assert.ok(!request.body.tools?.length, 'Pending title helper acquired tools');
      assert.equal(request.body.reasoning_effort, undefined, 'Pending title inherited chat reasoning');
      return { items: [{ type: 'textDelta', text: expectedTitle }], reason: 'stop' };
    }
    assert.equal(++conversationRequests, 1);
    return { items: [{ type: 'textDelta', text: 'Pending title source accepted' }], reason: 'stop' };
  });
  const model = { providerID: 'devryan-smoke', modelID: 'smoke-write' };
  const session = await client.sessions.create({ title: 'Untitled Session', model }, { directory });
  await enrollPrimary(session.id);
  const messageID = createV2MessageId();
  await client.prompts.prompt(session.id, { messageID, agent: 'orchestrator', variant: 'default', model,
    parts: [{ type: 'text', text: requestText }] }, { directory, origin: 'human', timeoutMs: 30000 });
  await waitFor(() => client.sessions.messages(session.id, {}, { directory }), page => page.records.some(row =>
    row.info.role === 'assistant' && row.info.time?.completed && !row.info.error), 'Pending title source never completed');
  await waitFor(() => client.sessions.status({ directory }), rows => !rows[session.id] || rows[session.id].type === 'idle', 'Pending title source never settled');
  const outboxFilePath = path.join(root, 'pending-model-title-outbox.json');
  const readJobs = async () => JSON.parse(await fs.readFile(outboxFilePath, 'utf8')).jobs;
  const projectedSources = [];
  const titleRuntime = createStandardSessionTitleRuntime({ openCodeClient: client, outboxFilePath, watchdogEnabled: false,
    recordDiagnostic, generateHelperText: input => runtimeOwner.generateHelperText(input),
    resolveHelperSelection: input => runtimeOwner.resolveHelperSelection(input),
    verifyAcceptedTitleInput: input => runtimeOwner.verifyTitleAcceptedInput(input),
    renameGeneratedTitle: async input => {
      assert.equal(input.sourceMessageID, messageID);
      assert.equal(++fixtureRefusals, 1, 'Pending candidate preparation must stop at one pre-native rename refusal');
      throw Object.assign(Error('fixture_title_pending_restart'), { code: 'fixture_title_pending_restart' });
    }, onTitleGenerated: input => projectedSources.push(input.source), logger: { warn: () => {} } });
  let pending;
  try {
    assert.equal(await titleRuntime.schedule({ sessionID: session.id, directory, text: requestText, acceptedInputID: messageID }), true);
    const jobs = await waitFor(readJobs, jobs => jobs.length === 1 && jobs[0].state === 'pending_idle' && jobs[0].attemptCount === 1,
      'Compiled title candidate was not retained before restart');
    pending = jobs[0];
    assert.equal(pending.sessionID, session.id); assert.equal(pending.sourceMessageID, messageID);
    assert.equal(pending.sourceHash, createHash('sha256').update(requestText).digest('hex'));
    assert.equal(pending.candidateTitle, expectedTitle); assert.equal(pending.source, 'session_model');
    assert.ok(projectedSources.length > 0 && projectedSources.every(source => source === 'session_model'));
    assert.equal((await client.sessions.get(session.id, { directory })).title, 'Untitled Session');
  } finally { await titleRuntime.dispose(); }
  assert.equal(helperRequests, 1); assert.equal(fixtureRefusals, 1);
  return { async assertRestored() {
    const owner = getRuntimeOwner(), replacementControllerID = owner.checkpointController().instanceID;
    assert.notEqual(replacementControllerID, originalControllerID, 'Pending title requires a replacement controller');
    assert.deepEqual(await readJobs(), [pending], 'Restart changed the retained pending candidate or its original source');
    assert.equal((await client.sessions.get(session.id, { directory })).title, 'Untitled Session');
    const restoredRuntime = createStandardSessionTitleRuntime({ openCodeClient: client, outboxFilePath, watchdogEnabled: false,
      recordDiagnostic, generateHelperText: () => { throw Error('Pending title must not regenerate after restart'); },
      resolveHelperSelection: () => { throw Error('Pending title must retain its resolved candidate'); },
      verifyAcceptedTitleInput: input => owner.verifyTitleAcceptedInput(input),
      renameGeneratedTitle: async input => {
        assert.equal(owner.checkpointController().instanceID, replacementControllerID);
        assert.equal(input.sourceMessageID, pending.sourceMessageID); assert.equal(input.title, pending.candidateTitle);
        assert.equal(++renameCount, 1, 'Pending title must rename exactly once through fresh native admission');
        return owner.renameGeneratedTitle(input);
      }, logger: { warn: () => {} } });
    try {
      assert.equal(await restoredRuntime.schedule({ sessionID: session.id, directory }), true);
      await waitFor(() => client.sessions.get(session.id, { directory }), current => current.title === expectedTitle,
        'Replacement controller did not persist the pending model title');
    } finally { await restoredRuntime.dispose(); }
    assert.deepEqual(await readJobs(), []); assert.equal(helperRequests, 1); assert.equal(renameCount, 1);
    return { sessionID: session.id, userMessageID: messageID, sourceHash: pending.sourceHash, helperRequests,
      conversationRequests, fixtureRefusals, renameCount, pendingAttemptCount: pending.attemptCount,
      originalControllerID, replacementControllerID, outboxCleared: true,
      source: 'durable-pending-candidate-fresh-controller-native-rename-without-regeneration' };
  } };
}

/** Actual compiled helper inference and native rename; the caller supplies the
 * existing supervised restart before this case can qualify. */
export async function runCompiledModelTitle({ runtimeOwner, client, provider, directory, root, getRuntimeOwner, enrollPrimary, recordDiagnostic }) {
  assert.equal(typeof enrollPrimary, 'function', 'Title source requires constructor-owned fixture root enrollment');
  const requestText = 'Inspect durable compiled helper title restoration';
  const expectedTitle = 'Durable Compiled Helper Title';
  let helperRequests = 0, conversationRequests = 0, renameCount = 0;
  const projectedSources = [];
  await provider.setResponder(request => {
    const messages = JSON.stringify(request.body.messages);
    assert.ok(messages.includes(requestText));
    if (messages.includes('Generate a concise title for this coding session')) {
      helperRequests++;
      assert.equal(helperRequests, 1, 'Model title must use exactly one provider request');
      assert.ok(!request.body.tools?.length, 'Title helper acquired tools');
      assert.equal(request.body.reasoning_effort, undefined, 'Configured helper inherited chat reasoning');
      return { items: [{ type: 'textDelta', text: expectedTitle }], reason: 'stop' };
    }
    conversationRequests++;
    assert.equal(conversationRequests, 1);
    return { items: [{ type: 'textDelta', text: 'Compiled title source accepted' }], reason: 'stop' };
  });
  const model = { providerID: 'devryan-smoke', modelID: 'smoke-write' };
  const session = await client.sessions.create({ title: 'Untitled Session', model }, { directory });
  await enrollPrimary(session.id);
  const messageID = createV2MessageId();
  await client.prompts.prompt(session.id, { messageID, agent: 'orchestrator', variant: 'default', model,
    parts: [{ type: 'text', text: requestText }] }, { directory, origin: 'human', timeoutMs: 30000 });
  await waitFor(() => client.sessions.messages(session.id, {}, { directory }), page => page.records.some(row =>
    row.info.role === 'assistant' && row.info.time?.completed && !row.info.error), 'Title source never completed');
  await waitFor(() => client.sessions.status({ directory }), rows => !rows[session.id] || rows[session.id].type === 'idle', 'Title source never settled');
  const outboxFilePath = path.join(root, 'model-title-outbox.json');
  const titleRuntime = createStandardSessionTitleRuntime({ openCodeClient: client, outboxFilePath,
    recordDiagnostic,
    generateHelperText: input => runtimeOwner.generateHelperText(input),
    resolveHelperSelection: input => runtimeOwner.resolveHelperSelection(input),
    verifyAcceptedTitleInput: input => runtimeOwner.verifyTitleAcceptedInput(input),
    renameGeneratedTitle: async input => {
      renameCount++;
      try { return await runtimeOwner.renameGeneratedTitle(input); }
      catch (error) {
        const codes = ['native_helper_title_conflict', 'native_helper_title_scope_invalid', 'native_helper_failed',
          'native_helper_input_invalid', 'native_title_scope_invalid', 'native_session_access_revoked',
          'native_helper_scope_revoked', 'native_runtime_not_ready', 'native_helper_unsettled', 'native_helper_expired',
          'native_helper_unavailable', 'native_helper_duplicate', 'native_helper_operation_pending',
          'native_helper_controller_exited', 'native_helper_deadline_expired', 'native_permit_invalid', 'native_permit_revoked',
          'unauthorized', 'forbidden', 'method_not_allowed'];
        const nativeCode = typeof error?.code === 'string' && /^native_[a-z0-9_]{1,112}$/.test(error.code) ? error.code : undefined;
        recordDiagnostic?.({ type: 'lifecycle', event: 'compiled_title_rename_refused', sessionID: input.sessionID,
          directory: input.directory, payload: { code: nativeCode ?? (codes.includes(error?.code) ? error.code : 'request_failure'),
            errorName: ['Error', 'TypeError', 'ReferenceError', 'RangeError'].includes(error?.name) ? error.name : 'other',
            frame: typeof error?.stack === 'string' ? error.stack.split('\n').slice(1).find(line => /native-helper-owner\.js:\d+|native-admission-owner\.js:\d+|native-runtime-owner\.js:\d+/.test(line))?.trim() : undefined,
            candidateLength: input.title.length, expectedLength: input.expectedTitle.length } });
        throw error;
      }
    },
    onTitleGenerated: input => { projectedSources.push(input.source); }, logger: { warn: () => {} } });
  try {
    assert.equal(await titleRuntime.schedule({ sessionID: session.id, directory, text: requestText, acceptedInputID: messageID }), true);
    assert.ok(projectedSources.length > 0 && projectedSources.every(source => source === 'session_model'), 'A derived-only title cannot qualify shipping');
    await waitFor(() => client.sessions.get(session.id, { directory }), current => current.title === expectedTitle,
      'Compiled helper title did not persist to the original native session');
  } finally { await titleRuntime.dispose(); }
  assert.equal(helperRequests, 1); assert.equal(renameCount, 1);
  assert.ok(projectedSources.length > 0 && projectedSources.every(source => source === 'session_model'),
    'A derived-only title cannot qualify shipping');
  const pendingTitle = await preparePendingCompiledTitle({ runtimeOwner, client, provider, directory, root, getRuntimeOwner, enrollPrimary, recordDiagnostic });
  await provider.setResponder(() => { throw new Error('Unsolicited title inference after persistence'); });
  return { async assertRestored() {
    const current = await client.sessions.get(session.id, { directory });
    assert.equal(current.title, expectedTitle, 'Supervised restart lost the persisted model title');
    const restoredRuntime = createStandardSessionTitleRuntime({ openCodeClient: client, outboxFilePath,
      generateHelperText: input => getRuntimeOwner().generateHelperText(input),
      resolveHelperSelection: input => getRuntimeOwner().resolveHelperSelection(input),
      verifyAcceptedTitleInput: input => getRuntimeOwner().verifyTitleAcceptedInput(input),
      renameGeneratedTitle: async input => { renameCount++; return getRuntimeOwner().renameGeneratedTitle(input); }, logger: { warn: () => {} } });
    try { await restoredRuntime.schedule({ sessionID: session.id, directory }); }
    finally { await restoredRuntime.dispose(); }
    assert.equal((await client.sessions.get(session.id, { directory })).title, expectedTitle);
    assert.equal(helperRequests, 1); assert.equal(renameCount, 1);
    return { id: 'compiled-model-title-persist-once-restart-restore', status: 'passed', sessionID: session.id,
      userMessageID: messageID, helperRequests, conversationRequests, renameCount, titleLength: expectedTitle.length,
      pendingRestoration: await pendingTitle.assertRestored(),
      source: 'actual-compiled-no-tools-model-title-native-rename-and-supervised-restart-restore' };
  } };
}
