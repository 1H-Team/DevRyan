import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { PAIR_PROTOCOL, parseReceiptResourceArgs, sampleFencedFootprint, projectResourceCounters, summarizeNativePairs,
  createBenchmarkLifetime, createDeadlineCDP, captureReceiptFailureState, rendererRequest,
  projectJournalBridgeTiming, projectReceiptResourceFailure } from './native-receipt-resource-benchmark.mjs';

const cache = process.cwd() + '/.cache/';
test('standalone admission requires all three explicit repository-owned artifacts and never accepts account/grant options', () => {
  const args = ['--package-evidence', cache + 'qa/package/evidence.json', '--artifact-root', cache + 'native', '--qualification-report', cache + 'v2-validation/package-proof/result.json'];
  assert.equal(parseReceiptResourceArgs(args).artifactRoot, cache + 'native');
  for (const invalid of [[], args.slice(0, 4), [...args, '--cookie', 'forbidden'], args.map(value => value === '--artifact-root' ? '--grant' : value),
    args.map(value => value === cache + 'native' ? '/outside/native' : value), args.map(value => value === cache + 'native' ? cache + '../escape' : value)])
    assert.throws(() => parseReceiptResourceArgs(invalid));
  assert.equal(PAIR_PROTOCOL.pairs, 5);
  assert.match(PAIR_PROTOCOL.fresh, /first native objective/);
  assert.match(PAIR_PROTOCOL.startupPrewarm, /prewarm remains enabled/);
  assert.match(PAIR_PROTOCOL.hostScope, /unpackaged actual web\/native harness/);
  assert.match(PAIR_PROTOCOL.hostScope, /not packaged shell execution/);
  assert.match(PAIR_PROTOCOL.variantMeaning, /no wire reasoning-effort claim/);
});

test('physical footprint requires identical live OS start identities before and after collection', async () => {
  const identity = { pid: 41, startIdentity: 'owned-start' };
  const rows = [{ ...identity, running: true }]; let calls = 0;
  const collect = async pids => { calls++; assert.deepEqual(pids, [41]); return new Map([[41, { footprint: 4096, categories: { secret: 1 } }]]); };
  const result = await sampleFencedFootprint([identity], '/owned/evidence.json', { snapshot: async () => rows, collect });
  assert.equal(result.status, 'observed'); assert.equal(result.totalFootprintBytes, 4096);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  for (const changed of [[{ ...identity, startIdentity: 'reused', running: true }], [], [{ ...identity, running: false }]]) {
    let reads = 0;
    const sample = await sampleFencedFootprint([identity], '/owned/evidence.json', { snapshot: async () => reads++ ? changed : rows, collect });
    assert.equal(sample.status, 'gap'); assert.deepEqual(sample.rows, []);
  }
  assert.equal(calls, 4);
  const oversized = Array.from({ length: 81 }, (_, index) => ({ pid: index + 1, startIdentity: 'owned' }));
  assert.equal((await sampleFencedFootprint(oversized, '/owned/evidence.json', { snapshot: async () => oversized.map(row => ({ ...row, running: true })),
    collect: () => assert.fail('A partial first-80 footprint must not qualify') })).reason, 'footprint-process-bound');
});

test('missing footprints remain unavailable; a PID already replaced before collection is not read', async () => {
  const result = await sampleFencedFootprint([{ pid: 41, startIdentity: 'old' }], '/owned/evidence.json', {
    snapshot: async () => [{ pid: 41, startIdentity: 'new', running: true }], collect: async pids => { assert.deepEqual(pids, []); return new Map(); } });
  assert.equal(result.status, 'gap'); assert.equal(result.observed, 0);
});

test('interruption drains and closes late adopted constructors without allowing later startup', async () => {
  let release, adopted, closed = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const owner = createBenchmarkLifetime(async () => { assert.equal(adopted.id, 'late'); closed++; });
  const stage = owner.stage(() => pending, value => { adopted = value; });
  const rejected = assert.rejects(stage, /Benchmark owner stopped/);
  const stopping = owner.stop(); assert.equal(owner.stop(), stopping); assert.equal(closed, 0);
  release({ id: 'late' }); await rejected; await stopping; assert.equal(closed, 1);
  await assert.rejects(owner.stage(() => assert.fail('Stopped owners cannot create a replacement')));
});

test('one absolute CDP deadline fences both dispatch and late completed responses', async () => {
  let now = 0, elapsed = 4, calls = 0;
  const cdp = createDeadlineCDP({ send: async (_method, _params, options) => {
    calls++; assert.equal(options.timeoutMs, 5); now = elapsed; return 'complete';
  } }, 5, { now: () => now });
  assert.equal(await cdp.send('Runtime.evaluate', {}), 'complete');
  now = 0; elapsed = 6;
  await assert.rejects(cdp.send('Runtime.evaluate', {}), /turn deadline/);
  await assert.rejects(cdp.send('Runtime.evaluate', {}), /turn deadline/); assert.equal(calls, 2);
});

test('failure-only renderer projection is separately bounded, finite and preserves missing canonical idle', async () => {
  const rows = [{ info: { role: 'user', id: 'msg_user' }, parts: [{ text: 'never-export-content' }] },
    { info: { role: 'assistant', id: 'msg_assistant', time: { completed: 123 } } }];
  const element = { isConnected: true, disabled: false, getBoundingClientRect: () => ({ height: 20 }) };
  const context = vm.createContext({ URL, AbortSignal, location: { href: 'http://127.0.0.1/?session=ses_owned' },
    window: { __qaReceiptSettlement: { input: { sessionID: 'ses_owned', directory: '/private-owned' }, job: 1,
      probe: { snapshot: () => ({ actions: [] }) } } },
    document: { visibilityState: 'visible', querySelector: selector => selector.includes('Stop Generating') ? null : element },
    fetch: async route => ({ ok: true, json: async () => route.includes('/status') ? {} : rows }) });
  const result = await captureReceiptFailureState({ send: async (_method, params, options) => {
    assert.equal(options.timeoutMs, 3000); return { result: { value: await vm.runInContext(params.expression, context) } };
  } });
  assert.equal(result.statusPresent, false); assert.equal(result.statusType, 'missing-or-unknown');
  assert.equal(result.completeAssistants, 1); assert.equal(result.actionOutcome, 'pending');
  assert.equal(result.rendered, true); assert.equal(result.sendEnabled, true);
  assert.equal(JSON.stringify(result).includes('never-export-content'), false);
  assert.equal(JSON.stringify(result).includes('/private-owned'), false);
});

test('owned API envelope retains finite HTTP refusal without response body or raw message', async () => {
  const cdp = value => ({ send: async () => ({ result: { value } }) });
  await assert.rejects(rendererRequest(cdp({ ok: false, status: 403 }), '/owned'), { code: 'native_receipt_api_refused', httpStatus: 403 });
  try { await rendererRequest(cdp({ ok: false, status: 999, error: 'never-export-content' }), '/owned'); }
  catch (error) { assert.equal(error.httpStatus, undefined); assert.equal(error.message.includes('never-export'), false); }
  assert.deepEqual(await rendererRequest(cdp({ ok: true, value: { ready: true } }), '/owned'), { ready: true });
});

test('resource counters bind one exact objective and distinguish committed write receipts from total commit guesses', () => {
  const journal = { records: [
    { type: 'native', stage: 'model-prepared', kind: 'primary', sessionID: 'ses_owned' },
    { type: 'native', stage: 'model-prepared', kind: 'title', sessionID: 'ses_owned' },
    { type: 'native', stage: 'physical', kind: 'primary', sessionID: 'ses_owned' },
    { type: 'native', stage: 'physical', kind: 'title', sessionID: 'ses_other' },
    { type: 'body-end', bytes: 18, sessionID: 'ses_owned' },
    { type: 'receipt-boundary', phase: 'finish', state: 'completed', sessionID: 'ses_owned' },
  ] };
  const input = { journal, sessionID: 'ses_owned', objectiveID: 'msg_owned', decodedRequestBytes: 120,
    timing: { records: [{ sessionId: 'ses_owned', userMessageId: 'msg_other', diagnostics: { bridge: { count: 999, failedCount: 0 } } },
      { sessionId: 'ses_owned', userMessageId: 'msg_owned', diagnostics: { bridge: { count: 2, failedCount: 0 }, secret: 'never export' } }] },
    publication: { termination: { terminated: true, confined: true, exitCode: 0 } } };
  const result = projectResourceCounters(input);
  assert.equal(result.preparedPrimaryRequests, 1); assert.equal(result.physicalPrimarySends, 1); assert.equal(result.providerBodyBytes, 18);
  assert.deepEqual(result.bridgeRPC, { status: 'observed', count: 2, failedCount: 0 });
  assert.equal(result.requiredPublishedWriteReceipts, 1); assert.equal(result.totalDurableCommits.status, 'gap');
  assert.equal(JSON.stringify(result).includes('never export'), false);
  assert.equal(projectResourceCounters({ ...input, objectiveID: 'missing' }).bridgeRPC.status, 'gap');
  assert.equal(projectResourceCounters({ ...input, timing: { records: [...input.timing.records, input.timing.records[1]] } }).bridgeRPC.status, 'gap');
});

const summarySelection = { sessionID: 'ses_owned', objectiveID: 'msg_user', assistantID: 'msg_final', since: 10, until: 20 };
const summaryRow = () => ({ type: 'turn-summary', at: 15, sessionID: 'ses_owned', messageID: 'msg_user',
  assistantMessageID: 'msg_final', bridge: { count: 70, failedCount: 0, secret: 'never-export' } });

test('persisted RPC summary requires one exact original objective, final assistant, window and finite counts', () => {
  const row = summaryRow();
  assert.deepEqual(projectJournalBridgeTiming([row], summarySelection).records[0].diagnostics.bridge, { count: 70, failedCount: 0 });
  assert.equal(JSON.stringify(projectJournalBridgeTiming([row], summarySelection)).includes('never-export'), false);
  for (const change of [r => r.sessionID = 'ses_foreign', r => r.messageID = 'msg_helper',
    r => r.at = 9, r => r.at = 21, r => r.at = '15', r => r.at = NaN, r => r.assistantMessageID = 'msg_foreign',
    r => r.bridge.count = NaN, r => r.bridge.failedCount = -1, r => r.bridge.failedCount = 71]) {
    const value = summaryRow(); change(value); assert.throws(() => projectJournalBridgeTiming([value], summarySelection));
  }
  const foreign = summaryRow(); foreign.assistantMessageID = 'msg_foreign';
  assert.throws(() => projectJournalBridgeTiming([row, foreign], summarySelection), /Exactly one/);
  assert.throws(() => projectJournalBridgeTiming([row, row], summarySelection), /Exactly one/);
  for (const gap of [{ type: 'gap' }, { event: 'native_observation_gap' }])
    assert.throws(() => projectJournalBridgeTiming([row, gap], summarySelection));
  assert.throws(() => projectJournalBridgeTiming([row], { ...summarySelection, since: '10' }));
});

function pairs() {
  const cohort = { buildID: 'a'.repeat(64), artifactManifestSha256: 'b'.repeat(64), sourceDigest: 'c'.repeat(64), runnerSha256: 'd'.repeat(64), uiSha256: 'e'.repeat(64),
    workload: 'fixed', agent: 'builder', providerID: 'devryan-smoke', modelID: 'smoke-write', variant: 'high' };
  return Array.from({ length: 5 }, (_, index) => {
    const runtimeIdentity = { pid: index + 101, startIdentity: `start-${index}` };
    const browserIdentity = { pid: index + 201, startIdentity: `browser-${index}` };
    return { pair: index + 1, runtimeIdentity, browserIdentity, cleanup: { complete: true }, turns: PAIR_PROTOCOL.turns.map(condition => ({ condition,
      publication: { termination: { terminated: true, confined: true, exitCode: 0 } },
      resources: { failures: [], samples: [{}], processOwnership: { controlledRuntimePid: runtimeIdentity.pid, observedProcesses: [runtimeIdentity, browserIdentity] } },
      footprint: { status: 'observed' }, counters: { bridgeRPC: { status: 'observed', count: 1, failedCount: 0 }, requiredPublishedWriteReceipts: 1 },
      settlement: { status: 'matched', cohort, sessionID: `ses_${index}_${condition}`, objectiveID: `msg_${index}_${condition}`, postReceiptMs: [100, 200] } })) };
  });
}

test('five pairs require five fresh process identities, same-host repeats and all strict receipt/resource gates', () => {
  const result = summarizeNativePairs(pairs()); assert.equal(result.status, 'measured');
  assert.equal(result.historicalImprovementClaim, false); assert.equal(result.totalDurableCommitCountQualified, false);
  for (const change of [value => value.pop(), value => value[0].cleanup.complete = false,
    value => value[0].turns[1].condition = 'fresh', value => value[0].turns[1].resources.processOwnership.controlledRuntimePid = 999,
    value => value[0].turns[1].resources.processOwnership.observedProcesses = [], value => value[0].runtimeIdentity = value[1].runtimeIdentity,
    value => value[0].browserIdentity = { ...value[0].browserIdentity, startIdentity: 'reused-browser' },
    value => { value[0].browserIdentity = value[1].browserIdentity; value[0].turns.forEach(turn => turn.resources.processOwnership.observedProcesses.push(value[1].browserIdentity)); },
    value => value[0].turns[0].publication.termination.confined = false, value => value[0].turns[0].footprint.status = 'gap',
    value => value[0].turns[0].settlement.status = 'gap', value => value[0].turns[0].resources.failures.push({ code: 'sample-unavailable' }),
    value => value[0].turns[0].counters.bridgeRPC.failedCount = 1, value => value[0].turns[0].settlement.cohort = {}]) {
    const value = pairs(); change(value); assert.equal(summarizeNativePairs(value).status, 'gap', String(change));
  }
});

test('failure projection retains exact bounded pre-submit stages and only reviewed assertion causes', () => {
  for (const condition of ['fresh', 'repeat']) for (const phase of ['cohort', 'output-reset', 'session-create', 'navigation', 'composer-ready', 'probe-start', 'sampler-start', 'prompt-send']) {
    const stage = condition + ':' + phase;
    assert.equal(projectReceiptResourceFailure(Error('never-export-content'), stage).stage, stage);
  }
  for (const [message, reason] of [['Host clock stepped during calibration', 'receipt-clock-host-step'],
    ['Renderer wall clock differs from journal host', 'receipt-clock-renderer-offset'], ['Native receipt turn deadline', 'turn-deadline']]) {
    let error; try { assert.ok(false, message); } catch (caught) { error = caught; }
    const result = projectReceiptResourceFailure(error, 'repeat:probe-start');
    assert.equal(result.reason, reason); assert.equal(result.errorName, 'AssertionError');
    assert.equal(result.code, 'native_receipt_resource_incomplete');
    assert.equal(result.stage, 'repeat:probe-start'); assert.equal('message' in result, false); assert.equal('stack' in result, false);
  }
  let error; try { assert.equal('never-export-content', 'never-export-secret'); } catch (caught) { error = caught; }
  const result = projectReceiptResourceFailure(error, 'repeat:probe-start');
  assert.equal(result.reason, 'assertion-failed'); assert.equal(JSON.stringify(result).includes('never-export'), false);
  const refusal = projectReceiptResourceFailure(Object.assign(Error('never-export-content'), { code: 'native_receipt_api_refused', httpStatus: 403 }), 'repeat:session-create');
  assert.equal(refusal.code, 'native_receipt_api_refused'); assert.equal(refusal.httpStatus, 403);
  const malformed = projectReceiptResourceFailure({ name: 'never-export-name', code: 'never-export-code', message: 'never-export-content', httpStatus: 999 }, 'never-export-stage');
  assert.deepEqual(malformed, { stage: 'unknown', errorName: 'OtherError', code: 'native_receipt_resource_incomplete', reason: 'owner-operation-failed' });
});
