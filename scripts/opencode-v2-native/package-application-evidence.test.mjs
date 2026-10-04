import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { openApplicationStopStream } from './package-application-stop-stream.mjs';
import { finishApplicationLifecycleEvidence } from './package-application-evidence.mjs';

const temporaryRoot = path.resolve('.cache/v2-validation/tmp');
await fs.mkdir(temporaryRoot, { recursive: true });

const options = (directory, profile) => ({ directory, profile, mode: 'upgrade', completed: false, results: [],
  exits: [{ mode: 'upgrade', pid: 321, code: null, signal: 'SIGTERM', private: 'must-not-persist' }],
  processEvidence: [{ mode: 'upgrade', pid: 321, start: 'Sun Oct  4 05:13:33 2026', private: 'must-not-persist' }], issues: [] });

test('failed upgrade persists after-close observations and actual exits without replacing the primary assertion', async () => {
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'application-evidence-'));
  const primary = Object.assign(new Error('canonical assistant did not settle'), { code: 'ERR_ASSERTION' });
  const profile = { env: { secret: 'must-not-persist' }, evidence: { providerRequests: [] }, close: async () => {
    profile.evidence.providerRequests.push({ requestID: 'http_2', model: 'smoke-write', startedAt: 42,
      completedAt: 43, requestSha256: 'a'.repeat(64), reason: 'stop', error: 'must-not-persist', body: 'must-not-persist' });
    throw new Error('must-not-persist');
  } };
  try {
    await assert.rejects(async () => {
      try { throw primary; }
      finally { await finishApplicationLifecycleEvidence({ ...options(directory, profile), primaryFailure: primary }); }
    }, error => error === primary && error.code === 'ERR_ASSERTION');
    const text = await fs.readFile(path.join(directory, 'application-lifecycle-evidence.json'), 'utf8');
    const evidence = JSON.parse(text);
    assert.equal(evidence.status, 'failed'); assert.equal(evidence.cleanup.profileClose, 'failed');
    assert.deepEqual(primary.applicationEvidenceIssues, ['profile-close-failed']);
    assert.deepEqual(evidence.exits, [{ mode: 'upgrade', pid: 321, code: null, signal: 'SIGTERM' }]);
    assert.deepEqual(evidence.providerRequests, [{ requestID: 'http_2', model: 'smoke-write', startedAt: 42,
      completedAt: 43, requestSha256: 'a'.repeat(64), reason: 'stop', errorPresent: true }]);
    assert.match(evidence.providerObservationScope, /not downstream cancellation or native Stop settlement/);
    assert.equal(text.includes('must-not-persist'), false);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('evidence write failure annotates an existing failure and remains nonzero after a successful lifecycle', async () => {
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'application-evidence-write-'));
  const profile = { evidence: { providerRequests: [] }, close: async () => {} };
  try {
    await fs.mkdir(path.join(directory, 'application-lifecycle-evidence.json'));
    const primary = new Error('original assertion');
    await finishApplicationLifecycleEvidence({ ...options(directory, profile), primaryFailure: primary });
    assert.deepEqual(primary.applicationEvidenceIssues, ['lifecycle-evidence-write-failed']);
    await assert.rejects(finishApplicationLifecycleEvidence({ ...options(directory, profile), completed: true }),
      error => error.code === 'EISDIR' && error.applicationEvidenceIssues.includes('lifecycle-evidence-write-failed'));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('provider inventory is bounded and unknown payload fields are not serialized', async () => {
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'application-evidence-bound-'));
  const profile = { close: async () => {}, evidence: { providerRequests: Array.from({ length: 65 }, () => ({
    requestID: 'must-not-persist', model: 'must-not-persist', startedAt: Infinity, completedAt: 'must-not-persist',
    requestSha256: 'must-not-persist', reason: 'must-not-persist', aborted: 'must-not-persist', error: 'must-not-persist',
  })) } };
  try {
    await finishApplicationLifecycleEvidence(options(directory, profile));
    const text = await fs.readFile(path.join(directory, 'application-lifecycle-evidence.json'), 'utf8');
    const evidence = JSON.parse(text);
    assert.equal(evidence.providerRequestCount, 65); assert.equal(evidence.providerRequestsTruncated, true);
    assert.equal(evidence.providerRequests.length, 64); assert.equal(text.includes('must-not-persist'), false);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

// Execute the actual driver control flow with disposable HTTP/server substitutes.
// This tests fixture ordering and evidence retention, not native Stop settlement.
async function runDriver({ mode = 'upgrade', cleanupFails = false, settleStop = false, rollbackFails = false,
  parts = [{ type: 'text', text: '1. Synthetic cancellation case.\n' }], oldText = false,
  parentID, completed = false, stream = 'valid' } = {}) {
  let source = await fs.readFile(new URL('./package-application-lifecycle-driver.mjs', import.meta.url), 'utf8');
  source = source.replace(/^import .*;\n/gm, '')
    .replace("await import('../../packages/web/server/lib/opencode/runtime-host/runtime-bundle-binding.js')", 'runtimeBinding')
    .replace("await import('../../packages/web/server/index.js')", 'webServer');
  const output = [], phases = [], crashMessages=[], rollbackMode=mode==='rollback'||mode==='rollback-crash', sessionID = mode === 'upgrade' ? 'ses_owned' : 'ses_candidate', assistantID = 'msg_active';
  const oldHistory = { ses_old: ['msg_old_user', 'msg_old_assistant'] };
  let accepted = 0, activeUserID, abortCalls = 0, stopCalls = 0, disconnected = false, restarted = false, completedAt;
  const fakeProcess = { pid: 321, stdin: (async function* () { yield JSON.stringify({ mode, directory: '/owned',
    ...(rollbackMode ? { sessionIDs: ['ses_old'], history: oldHistory } : {}) }); })(), stderr: {}, stdout: { write: value => output.push(value) },
    once: (event, callback) => { assert.equal(event, 'message'); queueMicrotask(() => callback({ type: 'application-owner-session',
      owner: rollbackMode ? { name: 'fixture', value: 'must-not-persist' } : null })); },
    send: (value, callback) => {if(value.type==='application-rollback-crash-ready'){crashMessages.push(value);phases.push('crash-ready');}callback?.();}, disconnect: () => { disconnected = true; } };
  const server = { getPort: () => 12345, isReady: () => true, issueLocalOwnerSession: () => ({ name: 'fixture', value: 'must-not-persist' }),
    restartOpenCode: async () => { restarted = true; phases.push('restart'); },
    stop: async () => { stopCalls++; if (cleanupFails) throw new Error('must-not-persist'); } };
  let streamController, streamClosed = false, streamOpened = false, readyBeforeSubmit = false, abortSawEmptyText = false;
  const encoder = new TextEncoder();
  const emit = (type, properties, eventDirectory = '/owned') => streamController?.enqueue(encoder.encode(
    `data: ${JSON.stringify({ directory: eventDirectory, payload: { type, properties } })}\n\n`));
  const canonicalParts = parts.map((part, index) => ({ ...part, id: `prt_active_${index}`, text: '' }));
  const fetch = async (url, init) => {
    const route = new URL(url).pathname;
    let value;
    if (route === '/api/global/event') {
      streamOpened = true;
      assert.equal(init.headers.origin, 'http://127.0.0.1:12345');
      assert.equal(init.headers.cookie, 'fixture=must-not-persist');
      assert.equal(init.headers['x-devryan-subscription-ready'], '1');
      assert.equal(init.headers['last-event-id'], undefined);
      const body = new ReadableStream({ start(controller) {
        streamController = controller;
        if (stream !== 'no-ready') controller.enqueue(encoder.encode('event: devryan.subscription-ready\r\ndata: {"type":"ready","scope":"global"}\r\n\r\n'));
        init.signal.addEventListener('abort', () => { if (!streamClosed) { streamClosed = true; controller.close(); } }, { once: true });
      }, cancel() { streamClosed = true; } });
      return { ok: true, body };
    }
    if (route === '/api/session') value = { id: sessionID };
    else if (route.endsWith('/prompt_async')) {
      accepted++; activeUserID = JSON.parse(init.body).messageID; value = null;
      phases.push(accepted === 1 ? 'normal-submit' : 'stop-submit');
      if (accepted === 2) {
        readyBeforeSubmit = streamOpened;
        for (const [index, part] of parts.entries()) {
          const partID = `prt_active_${index}`;
          const eventSession = stream === 'wrong-session' ? 'ses_unrelated' : sessionID;
          const eventMessage = stream === 'wrong-assistant' ? 'msg_unrelated' : assistantID;
          if (stream !== 'orphan-delta') emit('message.part.updated', { sessionID: eventSession,
            part: { ...part, id: partID, sessionID: eventSession, messageID: eventMessage, text: '', time: stream === 'ended-part' ? { end: 1 } : {} } });
          if (stream === 'completed-message') emit('message.updated', { info: { id: eventMessage, sessionID: eventSession, time: { completed: 1 } } });
          const fields = { sessionID: eventSession, messageID: eventMessage, partID: stream === 'wrong-part' ? 'prt_unrelated' : partID,
            field: stream === 'wrong-field' ? 'reasoning' : 'text' };
          // Real stream chunks can precede any durable REST text, including a split prefix.
          emit('message.part.delta', { ...fields, delta: part.text.slice(0, 10) }, stream === 'wrong-directory' ? '/unrelated' : '/owned');
          emit('message.part.delta', { ...fields, delta: part.text.slice(10) }, stream === 'wrong-directory' ? '/unrelated' : '/owned');
          if (stream === 'removed-part') emit('message.part.removed', { sessionID, messageID: assistantID, partID });
        }
        if (stream === 'gap') streamController?.enqueue(encoder.encode('event: devryan.replay-gap\ndata: {"replayGap":{}}\n\n'));
        if (stream === 'eof' && streamController) { streamClosed = true; streamController.close(); }
        await new Promise(resolve => setImmediate(resolve));
      }
    } else if (route.endsWith('/abort')) {
      abortSawEmptyText = canonicalParts.every(part => part.text === '');
      abortCalls++; phases.push('abort'); value = true; if (settleStop) completedAt = Date.now();
    } else if (route === '/api/session/status') value = { [sessionID]: { type: abortCalls && settleStop ? 'idle' : 'busy' } };
    else if (route === '/api/session/ses_old/message') value = oldHistory.ses_old.map(id => ({ info: { id } }));
    else if (route.endsWith('/message')) {
      value = [{ info: { id: 'msg_user_1', role: 'user' } }, { info: { id: 'msg_baseline', role: 'assistant', time: { completed: 1 } },
        parts: oldText ? [{ type: 'text', text: '1. Synthetic cancellation case.\n' }] : [] },
      ...(accepted > 1 ? [{ info: { id: activeUserID, role: 'user' } }, { info: { id: assistantID, role: 'assistant', parentID: parentID ?? activeUserID,
        time: completed || (abortCalls && settleStop) ? { completed: completedAt ?? 1 } : {},
        ...(abortCalls && settleStop ? { error: { name: 'MessageAbortedError' } } : {}) }, parts: canonicalParts }] : [])];
    } else if (route === '/api/runtime/bundle') { phases.push('bundle-read'); value = { state: 'upgrade_available', revision: 9 }; }
    else if (route === '/api/runtime/bundle/rollback' || route === '/api/runtime/bundle/upgrade') {
      assert.deepEqual(JSON.parse(init.body), { expectedRevision: 9 });
      const transition = route.endsWith('/rollback') ? 'rollback' : 'upgrade'; phases.push(transition);
      if (rollbackFails) return { ok: false, status: 500 };
      value = { transition, restartRequired: true, reconciliationRequired: false, bundleID: transition === 'rollback' ? 'bundle_A' : 'bundle_B' };
    } else assert.fail('Unexpected driver request');
    return { ok: true, status: 200, json: async () => value };
  };
  const waitFor = async (read, predicate, message, timeout) => {
    const value = await read(); assert.ok(predicate(value), message);
    if (message === 'Production application conversation did not settle' || message === 'Candidate-only work did not settle') phases.push('normal-settled');
    if (message === 'Production Stop never observed its exact native streaming assistant') {
      assert.ok(timeout > 0 && timeout <= 30000, 'Ready and stream barrier share the original 30s deadline'); phases.push('stream-observed');
    }
    return value;
  };
  const readBundleConversationRows = () => {
    assert.ok(abortCalls && settleStop); phases.push('native-settled');
    return { messages: [{ id: assistantID, session_id: sessionID, seq: 4, data: { time: { completed: completedAt }, error: { type: 'aborted' } } },
      { id: 'msg_idle', session_id: sessionID, seq: 5, type: 'idle', data: { outcome: 'interrupted' } }] };
  };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction('assert', 'Console', 'fs', 'path', 'waitFor', 'readBundleConversationRows', 'createV2MessageId',
    'readManagedOpenCodeRegistry', 'openApplicationStopStream', 'process', 'fetch', 'globalThis', 'runtimeBinding', 'webServer', source)(
    assert, class {}, fs, path, waitFor, readBundleConversationRows,
    () => `msg_user_${accepted + 1}`, () => [{ ownerPid: 321, childPid: restarted ? 987 : 654 }],
    options => openApplicationStopStream({ ...options, fetchImpl: fetch, ...(stream === 'no-ready' ? { deadline: Date.now() + 20 } : {}) }), fakeProcess, fetch, {},
    { selectedRuntimeBundle: { admission: 'open', descriptor: { bundleID: mode === 'upgrade' ? 'bundle_A' : 'bundle_B',
      launch: { global: { state: '/owned' }, artifactManifestSha256: (mode === 'upgrade' ? 'a' : 'b').repeat(64) } } } },
    { startWebUiServer: async () => server });
  assert.equal(output.length, 1); assert.equal(disconnected, true); assert.equal(stopCalls, 1);
  assert.equal(output[0].includes('must-not-persist'), false);
  if (streamOpened) assert.equal(streamClosed, true, 'Every driver exit must close its owned stream');
  return { readyBeforeSubmit, abortSawEmptyText, result: JSON.parse(output[0]), phases, sessionID, assistantID, accepted, abortCalls, exitCode: fakeProcess.exitCode, oldHistory,crashMessages };
}

test('rollback crash driver publishes only settled B history before the real route and fails if the crash barrier is missed',async()=>{
 const {result,phases,crashMessages,oldHistory}=await runDriver({mode:'rollback-crash',settleStop:true});
 assert.equal(crashMessages.length,1);const evidence=crashMessages[0];assert.equal(evidence.revision,9);assert.equal(evidence.bundleID,'bundle_B');
 assert.equal(evidence.result.ownerSessionReused,true);assert.deepEqual(evidence.result.history,oldHistory);assert.equal(evidence.result.stopProof.nativeIdleOutcome,'interrupted');
 assert.ok(phases.indexOf('native-settled')<phases.indexOf('crash-ready'));assert.ok(phases.indexOf('crash-ready')<phases.indexOf('rollback'));
 assert.equal(result.status,'failed');assert.equal(result.error.message,'Original rollback completed before its required pending-intent crash');
 assert.equal(JSON.stringify(evidence).includes('must-not-persist'),false);
});

for (const mode of ['upgrade', 'rollback']) for (const cleanupFails of [false, true]) {
  test(`${mode} preserves exact partial streaming Stop witness when settlement fails and cleanup ${cleanupFails ? 'fails' : 'succeeds'}`, async () => {
    const { result, sessionID, assistantID, accepted, abortCalls, exitCode, phases } = await runDriver({ mode, cleanupFails });
    assert.equal(result.status, 'failed'); assert.equal(result.error.code, 'ERR_ASSERTION');
    assert.equal(result.error.message, 'Production Stop did not settle its exact canonical assistant');
    assert.equal(result.stopProof.sessionID, sessionID); assert.equal(result.stopProof.userID, 'msg_user_2');
    assert.equal(result.stopProof.assistantID, assistantID); assert.equal(result.stopProof.abortAcknowledgement, true);
    assert.equal(result.stopProof.scope, mode === 'upgrade' ? 'old-A-streaming-Stop' : 'candidate-B-streaming-Stop');
    assert.equal(result.stopProof.bundleID, mode === 'upgrade' ? 'bundle_A' : 'bundle_B');
    assert.equal(result.stopProof.manifestSha256, (mode === 'upgrade' ? 'a' : 'b').repeat(64));
    assert.ok(result.stopProof.streamedTextBytes > 0);
    assert.ok(result.stopProof.streamObservedAt >= result.stopProof.submittedAt && result.stopProof.stopRequestedAt >= result.stopProof.streamObservedAt);
    assert.equal(Object.hasOwn(result.stopProof, 'nativeCompletedAt'), false);
    assert.deepEqual(result.cleanup, cleanupFails ? { serverStop: 'failed' } : undefined);
    assert.equal(exitCode, 1); assert.equal(accepted, 2); assert.equal(abortCalls, 1);
    assert.equal(phases.includes('rollback'), false); assert.equal(phases.includes('upgrade'), false);
  });
}

for (const [name, options] of [
  ['empty text', { parts: [] }], ['unrelated text', { parts: [{ type: 'text', text: 'Unrelated response' }] }],
  ['synthetic text', { parts: [{ type: 'text', text: '1. Synthetic cancellation case.\n', synthetic: true }] }],
  ['old assistant text', { parts: [], oldText: true }], ['wrong parent', { parentID: 'msg_other_user' }], ['completed assistant', { completed: true }],
]) test(`Stop barrier rejects ${name} before issuing abort`, async () => {
  const { result, abortCalls, phases } = await runDriver(options);
  assert.equal(result.status, 'failed'); assert.equal(result.error.message, 'Production Stop never observed its exact native streaming assistant');
  assert.equal(abortCalls, 0); assert.equal(phases.includes('stream-observed'), false);
  assert.equal(Object.hasOwn(result.stopProof, 'stopRequestedAt'), false);
});

test('A retains streamed Stop, restart, revision-bound upgrade and the full canonical history', async () => {
  const { result, phases, exitCode, sessionID, readyBeforeSubmit, abortSawEmptyText } = await runDriver({ settleStop: true });
  assert.equal(result.status, 'passed', result.error?.message);
  assert.equal(readyBeforeSubmit, true); assert.equal(abortSawEmptyText, true); assert.equal(exitCode, undefined); assert.equal(result.ownerSessionReused, false);
  assert.deepEqual(phases, ['normal-submit', 'normal-settled', 'stop-submit', 'stream-observed', 'abort', 'native-settled', 'restart', 'bundle-read', 'upgrade']);
  assert.deepEqual(result.history, { [sessionID]: ['msg_user_1', 'msg_baseline', 'msg_user_2', 'msg_active'] });
  assert.equal(result.stopProof.nativeError, 'aborted'); assert.equal(result.stopProof.nativeIdleOutcome, 'interrupted');
});

test('B finishes its normal turn and the same canonical Stop before rollback, retaining candidate history separately', async () => {
  const { result, phases, exitCode, oldHistory, readyBeforeSubmit, abortSawEmptyText } = await runDriver({ mode: 'rollback', settleStop: true });
  assert.equal(result.status, 'passed', result.error?.message);
  assert.equal(readyBeforeSubmit, true); assert.equal(abortSawEmptyText, true); assert.equal(exitCode, undefined); assert.equal(result.ownerSessionReused, true);
  assert.deepEqual(phases, ['normal-submit', 'normal-settled', 'stop-submit', 'stream-observed', 'abort', 'native-settled', 'bundle-read', 'rollback']);
  assert.deepEqual(result.history, oldHistory); assert.deepEqual(result.sessionIDs, ['ses_old']);
  assert.deepEqual(result.candidateStopHistory, ['msg_user_1', 'msg_baseline', 'msg_user_2', 'msg_active']);
  assert.equal(result.candidateSessionID, 'ses_candidate');
  assert.equal(result.stopProof.nativeError, 'aborted'); assert.equal(result.stopProof.nativeIdleOutcome, 'interrupted');
});

for (const failure of ['rollback', 'cleanup']) test(`B retains its stopped candidate history if subsequent ${failure} fails`, async () => {
  const { result, exitCode } = await runDriver({ mode: 'rollback', settleStop: true,
    rollbackFails: failure === 'rollback', cleanupFails: failure === 'cleanup' });
  assert.equal(result.status, 'failed'); assert.equal(exitCode, 1);
  assert.deepEqual(result.candidateStopHistory, ['msg_user_1', 'msg_baseline', 'msg_user_2', 'msg_active']);
  assert.equal(result.stopProof.nativeError, 'aborted'); assert.equal(result.stopProof.nativeIdleOutcome, 'interrupted');
  assert.equal(result.error.code, failure === 'rollback' ? 'ERR_ASSERTION' : 'application_server_stop_failed');
});

test('A and B provider proofs require exact counts, selected identities and physical start before streamed Stop', async () => {
  const source = await fs.readFile(new URL('./package-application-lifecycle.mjs', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('    const qualifyStopProvider='), source.indexOf('    const a=readRuntimeBundleBinding'));
  for (const count of [2, 4]) {
    const scope = count === 2 ? 'old-A-streaming-Stop' : 'candidate-B-streaming-Stop';
    const descriptor = { bundleID: `bundle_${count}`, launch: { artifactManifestSha256: 'a'.repeat(64) } };
    const baseline = { requests: Array.from({ length: count }, (_, index) => ({ requestID: `http_${index + 1}`, model: 'smoke-write',
      startedAt: 150, requestSha256: 'b'.repeat(64) })), proof: { scope, bundleID: descriptor.bundleID,
      manifestSha256: descriptor.launch.artifactManifestSha256, sessionID:'ses_owned',assistantID:'msg_active', submittedAt: 100, streamObservedAt: 200, stopRequestedAt: 300, streamedTextBytes: 30,
      streamEvent:{source:'production-global-event-text-delta',sessionID:'ses_owned',messageID:'msg_active',partID:'prt_active',readyAt:90,observedAt:200,deltaBytes:30,deltaCount:2} } };
    const check = ({ requests, proof }) => {
      const qualify = new Function('assert', 'profile', body + '\nreturn qualifyStopProvider;')(assert, { evidence: { providerRequests: requests } });
      qualify(proof, descriptor, count, scope); return proof;
    };
    assert.deepEqual(check(structuredClone(baseline)).providerRequest,
      { requestID: `http_${count}`, startedAt: 150, requestSha256: 'b'.repeat(64) });
    for (const alter of [
      value => value.requests.push(value.requests[0]), value => { value.requests.at(-1).requestID = 'http_63'; },
      value => { value.requests[0].requestID = `http_${count}`; }, value => { value.requests.at(-1).startedAt = 99; },
      value => { value.requests.at(-1).startedAt = 301; }, value => { value.proof.streamObservedAt = 149; },
      value => { value.proof.bundleID = 'other'; }, value => { value.proof.manifestSha256 = 'c'.repeat(64); },
      value => { value.requests.at(-1).requestSha256 = 'invalid'; },
      value => { value.proof.streamEvent.source='rest'; },value => { value.proof.streamEvent.sessionID='ses_other'; },
      value => { value.proof.streamEvent.messageID='msg_other'; },value => { value.proof.streamEvent.readyAt=101; },
      value => { value.proof.streamEvent.observedAt=199; },value => { value.proof.streamEvent.deltaBytes=0; },
      value => { value.proof.streamEvent.deltaCount=0; },
    ]) { const changed = structuredClone(baseline); alter(changed); assert.throws(() => check(changed), { code: 'ERR_ASSERTION' }); }
  }
});

for (const stream of ['wrong-session', 'wrong-assistant', 'wrong-part', 'wrong-field', 'wrong-directory', 'orphan-delta', 'ended-part', 'completed-message', 'removed-part']) {
  test(`Stop refuses ${stream} despite an otherwise active canonical assistant`, async () => {
    const { result, abortCalls } = await runDriver({ stream, settleStop: true });
    assert.equal(result.status, 'failed'); assert.equal(abortCalls, 0);
    assert.equal(result.error.message, 'Production Stop never observed its exact native streaming assistant');
    assert.equal(Object.hasOwn(result.stopProof, 'stopRequestedAt'), false);
  });
}
for (const [stream, code] of [['eof', 'application_stop_stream_ended'], ['gap', 'application_stop_stream_gap'], ['no-ready', 'application_stop_stream_ended']]) {
  test(`Stop refuses ${stream} and closes the stream without aborting a turn`, async () => {
    const { result, abortCalls, accepted, exitCode } = await runDriver({ stream, settleStop: true });
    assert.equal(result.status, 'failed'); assert.equal(result.error.code, code); assert.equal(exitCode, 1);
    assert.equal(abortCalls, 0); assert.equal(accepted, stream === 'no-ready' ? 1 : 2);
    assert.equal(Object.hasOwn(result.stopProof, 'stopRequestedAt'), false);
  });
}

test('Stop evidence excludes provider text and payloads while retaining measured delta bytes', async () => {
  const { result, abortCalls } = await runDriver({ settleStop: true,
    parts: [{ type: 'text', text: '1. Synthetic cancellation case.\n must-not-persist' }] });
  assert.equal(result.status, 'passed'); assert.equal(abortCalls, 1);
  assert.equal(result.stopProof.streamEvent.deltaBytes, Buffer.byteLength('1. Synthetic cancellation case.\n must-not-persist'));
});
