import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { calibrateReceiptClock, projectReceiptSettlementDiagnostic, joinReceiptSettlement,
  summarizeReceiptSettlements, startReceiptSettlementProbe, finishReceiptSettlementProbe, closeReceiptSettlementProbe } from './receipt-ui-settlement.mjs';
import { projectQa1ProviderJournal } from '../qa/qa1-provider-qualification.mjs';
import { withExecutionObservation } from '../../packages/harness-runtime/lib/execution-admission.js';
import { createDiagnosticSanitizer } from '../../packages/harness-runtime/lib/sanitizer.js';
import { createCursorExecutionReceipts } from '../../packages/web/server/lib/opencode/cursor-execution-receipts.js';

const sessionID = 'ses_owned', objectiveID = 'msg_user';
function fixture() {
  const calibration = { offset: 10000, uncertaintyMs: 2, rendererWallOffset: 10000, hostWallOffset: 10000 };
  return { sessionID, objectiveID, cohort: { buildID: 'a'.repeat(64), artifactManifestSha256: 'b'.repeat(64), sourceDigest: 'c'.repeat(64), runnerSha256: 'd'.repeat(64), uiSha256: 'e'.repeat(64),
      workload: 'fixed', agent: 'orchestrator', providerID: 'openai', modelID: 'gpt-6-astra', variant: 'medium' },
    rows: [{ info: { id: objectiveID, role: 'user' } }, { info: { id: 'msg_assistant', parentID: objectiveID, role: 'assistant',
      providerID: 'openai', time: { completed: 12000 } }, parts: [{ type: 'tool', callID: 'call_write', tool: 'write', state: { status: 'completed' } }] }],
    journal: { complete: true, gapCount: 0, records: [
      { type: 'native', stage: 'accepted-user', sessionID, messageID: objectiveID, scopeID: 1 },
      { type: 'native', stage: 'step-link', sessionID, userMessageID: objectiveID, assistantMessageID: 'msg_assistant', scopeID: 1 },
      { type: 'receipt-boundary', at: 11000, sessionID, messageID: 'msg_assistant', callID: 'call_write', phase: 'finish', state: 'completed', elapsedMs: 50 },
    ] },
    probe: { sessionID, calibration, after: { ...calibration }, action: { outcome: 'passed', endedAt: 2100 },
      observation: { sessionID, objectiveID, assistantID: 'msg_assistant', idleStartedAt: 1900, idleAt: 2000, controlsAt: 2020 } } };
}

test('native receipt join preserves commit interval, canonical idle request interval and two-rAF clock uncertainty', () => {
  const result = joinReceiptSettlement(fixture());
  assert.equal(result.status, 'matched');
  assert.deepEqual(result.receiptWallInterval, [10949, 11001]);
  assert.deepEqual(result.idleWallInterval, [11898, 12002]);
  assert.deepEqual(result.postReceiptMs, [1097, 1153]);
  assert.equal(result.endpoint, 'render-ready-two-raf-not-compositor-presentation');
});

test('idle must be proven after the entire receipt commit interval, including clock uncertainty', () => {
  const value = fixture();
  value.probe.observation.idleStartedAt = 900;
  assert.equal(joinReceiptSettlement(value).status, 'gap', 'Overlapping receipt and idle request intervals cannot establish ordering');
  value.probe.observation.idleStartedAt = 1002;
  assert.equal(joinReceiptSettlement(value).status, 'gap', 'Clock uncertainty cannot be ignored at the interval boundary');
  value.probe.observation.idleStartedAt = 1003;
  assert.equal(joinReceiptSettlement(value).status, 'matched', 'The receipt upper bound may meet the idle lower bound');
});

test('foreign identity, incomplete journal, missing/failed receipts and wall-clock steps stay explicit gaps', () => {
  const changes = [
    value => value.journal.complete = false,
    value => value.journal.gapCount = 1,
    value => value.rows.push({ info: { id: 'msg_later', role: 'user' } }),
    value => value.rows[1].info.error = { name: 'failed' },
    value => value.journal.records[0].scopeID = 2,
    value => value.journal.records.push({ type: 'native', sessionID, stage: 'physical', scopeID: 2 }),
    value => value.journal.records.push({ ...value.journal.records[0] }),
    value => value.journal.records.pop(),
    value => value.journal.records[2].callID = 'call_foreign',
    value => value.journal.records[2].state = 'failed',
    value => value.journal.records[2].at = 14000,
    value => value.probe.observation.sessionID = 'ses_other',
    value => value.probe.observation.objectiveID = 'msg_other',
    value => value.probe.observation.assistantID = 'msg_other',
    value => value.probe.action.outcome = 'failed',
    value => value.probe.observation.controlsAt = 2200,
    value => value.probe.after.offset += 100,
    value => value.probe.after.hostWallOffset += 100,
    value => delete value.probe.calibration,
  ];
  for (const change of changes) { const value = fixture(); change(value); assert.equal(joinReceiptSettlement(value).status, 'gap', String(change)); }
});

test('Cursor joins actual receipt writes plus final native save and ignores outer no-op receipt summaries', () => {
  const value = fixture(); value.rows[1].info.providerID = 'cursor-acp';
  value.journal.records.splice(2, 1,
    { type: 'receipt-boundary', at: 10990, sessionID, messageID: 'msg_assistant', phase: 'cursor_receipts', state: 'completed', receipts: 2, elapsedMs: 12 },
    { type: 'receipt-boundary', at: 11000, sessionID, messageID: 'msg_assistant', phase: 'native_save', state: 'completed', elapsedMs: 8 },
    { type: 'receipt-boundary', at: 11900, sessionID, messageID: 'msg_assistant', phase: 'cursor_receipts', state: 'completed', elapsedMs: 0 });
  assert.deepEqual(joinReceiptSettlement(value).receiptWallInterval, [10999, 11001]);
  value.journal.records = value.journal.records.filter(row => !row.receipts);
  assert.equal(joinReceiptSettlement(value).reason, 'cursor-durable-boundary');
});

test('last required boundary covers every canonical mutation, never an unrelated session or read-only call', () => {
  const value = fixture(); value.rows[1].parts.push({ type: 'tool', tool: 'read', callID: 'call_read', state: { status: 'completed' } });
  value.journal.records.push({ type: 'receipt-boundary', at: 13000, sessionID: 'ses_other', messageID: 'msg_assistant', callID: 'call_write', phase: 'finish', state: 'completed', elapsedMs: 0 });
  assert.equal(joinReceiptSettlement(value).status, 'matched');
  value.rows[1].parts.push({ type: 'tool', tool: 'edit', callID: 'call_edit', state: { status: 'completed' } });
  assert.equal(joinReceiptSettlement(value).reason, 'native-durable-boundary');
  value.journal.records.push({ type: 'receipt-boundary', at: 11100, sessionID, messageID: 'msg_assistant', callID: 'call_edit', phase: 'direct_finish', state: 'completed', elapsedMs: 20 });
  assert.deepEqual(joinReceiptSettlement(value).receiptWallInterval, [11079, 11101]);
});

test('finite diagnostic projection is opt-in and never exports execution content or unrecognized keys', () => {
  const row = { type: 'lifecycle', event: 'session_execution', at: 11000, sessionID,
    payload: { sessionID, messageID: 'msg_assistant', callID: 'call_write', phase: 'finish', state: 'completed', elapsedMs: 5,
      content: 'secret', args: { text: 'secret' }, directory: '/private/path', steps: 'secret' } };
  assert.deepEqual(Object.keys(projectReceiptSettlementDiagnostic(row)).sort(), ['at', 'callID', 'elapsedMs', 'messageID', 'phase', 'sessionID', 'state', 'type']);
  assert.equal(projectReceiptSettlementDiagnostic({ ...row, payload: { ...row.payload, sessionID: 'ses_other' } }), null);
  const selection = { sessionIDs: [sessionID], directory: '/owned', since: 10000, until: 12000 };
  assert.equal(projectQa1ProviderJournal([row], selection).records.length, 0);
  const result = projectQa1ProviderJournal([row], { ...selection, receiptSettlement: true });
  assert.equal(result.records.length, 1); assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('actual execution and Cursor receipt producers survive the real sanitizer into finite timing evidence', async () => {
  const sanitizer = createDiagnosticSanitizer(), records = [];
  const onDiagnostic = payload => records.push(sanitizer.sanitizeRecord({ type: 'lifecycle', event: 'session_execution', at: Date.now(), sessionID, payload }));
  await withExecutionObservation({ sessionID, messageID: 'msg_assistant', callID: 'call_write' }, async () => {}, { phase: 'finish', onDiagnostic, minMs: 0 });
  const cursor = createCursorExecutionReceipts({ onDiagnostic, runtime: { aliasCalls: async () => {},
    executionReceipt: async () => ({ callID: 'call_write', files: [] }) }, recordReceipts: async () => {} });
  await cursor({ token: 'lease', directory: '/owned', scope: { sessionID, messageID: 'msg_assistant', callID: 'call_write' } }, { parts: [] });
  const result = projectQa1ProviderJournal(records, { sessionIDs: [sessionID], directory: '/owned', since: 0, until: Date.now(), receiptSettlement: true });
  assert.ok(result.records.some(row => row.phase === 'finish' && row.callID === 'call_write' && row.state === 'completed'));
  assert.ok(result.records.some(row => row.phase === 'cursor_receipts' && row.receipts === 1 && row.state === 'completed'));
});

test('only five distinct matched objectives with the same cohort can establish the Finalizing threshold', () => {
  const base = joinReceiptSettlement(fixture());
  const samples = Array.from({ length: 5 }, (_, index) => ({ ...base, objectiveID: `msg_${index}` }));
  assert.equal(summarizeReceiptSettlements(samples).finalizingThresholdExceeded, true);
  assert.equal(summarizeReceiptSettlements(samples.slice(1)).status, 'gap');
  assert.equal(summarizeReceiptSettlements([...samples.slice(1), samples[1]]).status, 'gap');
  assert.equal(summarizeReceiptSettlements(samples.map((row, index) => index ? row : { ...row, cohort: { workload: 'other' } })).status, 'gap');
  assert.equal(summarizeReceiptSettlements(samples.map(row => ({ ...row, postReceiptMs: [900, 1600] }))).finalizingThresholdExceeded, false,
    'Uncertainty crossing 1s does not authorize a UI change');
  assert.equal(summarizeReceiptSettlements(samples.map((row, index) => ({ ...row, postReceiptMs: index === 4 ? [3100, 3300] : [20, 30] }))).finalizingThresholdExceeded, true);
});

test('clock calibration uses the smallest transport bracket and rejects host/renderer wall clock changes', async () => {
  let tick = 0;
  const cdp = { send: async () => { tick += 2; return { result: { value: { wall: 10000 + tick, mono: tick } } }; } };
  const clock = { wall: () => 10000 + tick, monotonic: () => tick };
  const calibration = await calibrateReceiptClock(cdp, clock);
  assert.equal(calibration.offset, 9999); assert.equal(calibration.uncertaintyMs, 3);
  await assert.rejects(calibrateReceiptClock({ send: async () => ({ result: { value: { wall: 999999, mono: 2 } } }) }, clock), /wall clock/);
  let calls = 0;
  await assert.rejects(calibrateReceiptClock(cdp, { ...clock, wall: () => 10000 + tick + (calls++ ? 100 : 0) }), /Host clock stepped/);
});

test('renderer owner waits for exact new objective, canonical idle, restored controls and both frames', async () => {
  const frames = new Map(); let frameID = 0, idle = false, controls = false, accepted = false;
  const rows = fixture().rows;
  const textarea = { isConnected: true, disabled: false, getBoundingClientRect: () => ({ height: 20 }) };
  const context = vm.createContext({ performance, Date, URL, AbortSignal, setTimeout, clearTimeout,
    location: { href: `http://127.0.0.1/?session=${sessionID}` },
    PerformanceObserver: { supportedEntryTypes: [] },
    requestAnimationFrame: callback => { const key = ++frameID; frames.set(key, callback); return key; }, cancelAnimationFrame: key => frames.delete(key),
    document: { addEventListener() {}, removeEventListener() {}, querySelector: selector => {
      if (selector === 'textarea') return textarea;
      if (selector === 'button[aria-label="Send Message"]') return controls ? { isConnected: true, getBoundingClientRect: () => ({ height: 20 }) } : null;
      if (selector.startsWith('[data-message-id=')) return accepted ? { getBoundingClientRect: () => ({ height: 20 }) } : null;
      return null;
    } }, fetch: async url => ({ ok: true, json: async () => url.includes('/status') ? { [sessionID]: { type: idle ? 'idle' : 'busy' } } : accepted ? rows : [] }) });
  vm.runInContext('window=globalThis', context);
  const cdp = { send: async (_method, params) => ({ result: { value: await vm.runInContext(params.expression, context) } }) };
  const probe = await startReceiptSettlementProbe({ cdp, sessionID, directory: '/owned', previousUserIDs: [] });
  const frame = async () => { const batch = [...frames.values()]; frames.clear(); for (const callback of batch) await callback(performance.now()); await Promise.resolve(); };
  await frame(); assert.equal(vm.runInContext('window.__qaReceiptSettlement.probe.snapshot().actions.length', context), 0);
  accepted = true; idle = true;
  vm.runInContext('window.__qaReceiptSettlement.lastPoll=-Infinity', context);
  await frame();
  const firstIdle = vm.runInContext('window.__qaReceiptSettlement.idleObservation.idleAt', context);
  assert.equal(vm.runInContext('window.__qaReceiptSettlement.observation', context), null);
  controls = true;
  vm.runInContext('window.__qaReceiptSettlement.lastPoll=-Infinity', context);
  await frame();
  assert.equal(vm.runInContext('window.__qaReceiptSettlement.probe.snapshot().actions.length', context), 0);
  await frame();
  assert.equal(vm.runInContext('window.__qaReceiptSettlement.probe.snapshot().actions.length', context), 0);
  await frame();
  const result = await finishReceiptSettlementProbe({ cdp, ...probe, wait: action => action() });
  assert.equal(result.action.outcome, 'passed'); assert.equal(result.observation.objectiveID, objectiveID);
  assert.equal(result.observation.idleAt, firstIdle);
  assert.equal(vm.runInContext('Boolean(window.__qaReceiptSettlement)', context), false);
});

test('injected renderer accepts only absent own status or explicit idle in an object status inventory', async () => {
  let statuses = {}, rows = fixture().rows, rendered = true;
  const visible = { isConnected: true, disabled: false, getBoundingClientRect: () => ({ height: 20 }) };
  const context = vm.createContext({ performance, Date, URL, AbortSignal, setTimeout, clearTimeout,
    location: { href: `http://127.0.0.1/?session=${sessionID}` }, PerformanceObserver: { supportedEntryTypes: [] },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    document: { addEventListener() {}, removeEventListener() {}, querySelector: selector => {
      if (selector === 'button[aria-label="Stop Generating"]') return null;
      if (selector.startsWith('[data-message-id=') && !rendered) return null;
      return visible;
    } }, fetch: async url => ({ ok: true, json: async () => url.includes('/status') ? statuses : rows }) });
  vm.runInContext('window=globalThis', context);
  const cdp = { send: async (_method, params) => ({ result: { value: await vm.runInContext(params.expression, context) } }) };
  await startReceiptSettlementProbe({ cdp, sessionID, directory: '/owned', previousUserIDs: [] });
  const condition = () => vm.runInContext('window.__qaReceiptSettlement.lastPoll=-Infinity;window.__qaReceiptSettlement.condition()', context);
  try {
    for (const [label, status, expected] of [
      ['empty map', {}, true], ['explicit idle', { [sessionID]: { type: 'idle' } }, true],
      ['foreign only', { ses_foreign: { type: 'busy' } }, true],
      ['foreign retry', { ses_foreign: { type: 'retry', attempt: 2, message: 'retrying', next: 1234 } }, true],
      ['own valid retry', { [sessionID]: { type: 'retry', attempt: 2, message: 'retrying', next: 1234 } }, false],
      ['inherited status is not an own entry', Object.create({ [sessionID]: { type: 'busy' } }), true],
      ['error map', { error: 'unauthorized' }, false],
      ['malformed foreign entry', { ses_foreign: null }, false],
      ['unknown foreign status', { ses_foreign: { type: 'unknown' } }, false],
      ['incomplete foreign retry', { ses_foreign: { type: 'retry' } }, false],
      ['nonfinite foreign retry', { ses_foreign: { type: 'retry', attempt: 2, message: 'retrying', next: Infinity } }, false],
      ...['busy', 'retry', 'unknown'].map(type => [type, { [sessionID]: { type } }, false]),
      ...[null, undefined, [], {}, 'idle', { type: null }].map(status => ['malformed own entry', { [sessionID]: status }, false]),
    ]) {
      statuses = status;
      assert.equal(await condition(), expected, label);
      if (!expected) assert.equal(vm.runInContext('window.__qaReceiptSettlement.observation', context), null, label);
    }
    for (const status of [null, [], 'idle', 0, false]) {
      statuses = status;
      await assert.rejects(condition(), /Malformed canonical status inventory/);
    }
    statuses = {};
    rows[1].info.time.completed = undefined;
    assert.equal(await condition(), false, 'Absent status cannot replace canonical completion');
    rows = fixture().rows; rows[1].info.error = { name: 'failed' };
    assert.equal(await condition(), false, 'Absent status cannot accept a failed assistant');
    rows = fixture().rows; rendered = false;
    assert.equal(await condition(), false, 'Absent status cannot replace the rendered assistant');
  } finally { await closeReceiptSettlementProbe(cdp); }
});
