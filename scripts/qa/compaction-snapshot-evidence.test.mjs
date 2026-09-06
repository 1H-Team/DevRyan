import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createQaCompactionSnapshotRecorder, createQaCompactionActionSnapshotRecorder, decodeQaCompactionSnapshots,
  QA_COMPACTION_SNAPSHOT_LIMITS } from './compaction-snapshot-evidence.mjs';
import { projectQaCompactionBoundaryBracket, projectQaCompactionSummaryExit, QA_COMPACTION_INVESTIGATION_MARKERS } from './compaction-action-evidence.mjs';

const size = value => Buffer.byteLength(JSON.stringify(value));
const cohort = QA_COMPACTION_INVESTIGATION_MARKERS.map((marker, index) => ({
  marker, taskId: `task_${index}`, childSessionId: `ses_child${index}`, callId: `call_start${index}`,
}));
const mixed = () => ({ state: 'observed',
  tasks: cohort.map((item, index) => ({ taskId: item.taskId, childSessionId: item.childSessionId, dispatchCallId: item.callId,
    status: index ? 'completed' : 'running', attempt: 1, executionKind: 'start', priorTaskId: null, recoveryLineageId: null })),
  envelopes: [{ taskId: 'task_1', envelopeId: 'envelope_1', status: 'completed', action: null, acknowledgedAt: null }],
  activeTaskIds: ['task_0'], awaitingDispositionTaskIds: ['task_1'],
});
const sample = (start, end, snapshot = mixed(), stage = 'compaction-1') => ({
  stage, at: end, requestStartedAt: start, responseCompletedAt: end, snapshot,
});
const compact = rows => {
  const recorder = createQaCompactionSnapshotRecorder();
  for (const row of rows) assert.equal(recorder.record(row), true);
  assert.equal(recorder.byteCount, size(recorder.data));
  assert.equal(recorder.gap, undefined);
  return recorder;
};
const bracket = (snapshots, nativeStartedAt, gap) => projectQaCompactionBoundaryBracket({ snapshots, cohort, nativeStartedAt, gap });
const exit = (snapshots, summaryCompletedAt, before = mixed()) => projectQaCompactionSummaryExit({
  snapshots, before, cohort, summaryCompletedAt, nativeCycle: { startedAt: summaryCompletedAt - 50, completedAt: summaryCompletedAt + 3 },
});

test('more than 500 identical reads preserve exact nearest start and summary witnesses inside the unchanged state', () => {
  const rows = Array.from({ length: 700 }, (_, i) => sample(i * 10 + 1, i * 10 + 3));
  const recorder = compact(rows);
  const decoded = decodeQaCompactionSnapshots(recorder.data);
  assert.equal(recorder.data.projections.length, 1);
  assert.equal(recorder.data.reads.length, 700);
  assert.deepEqual(decoded, rows);
  assert.deepEqual(bracket(decoded, 6500), bracket(rows, 6500));
  assert.equal(bracket(decoded, 6500).before.requestStartedAt, 6491);
  assert.equal(bracket(decoded, 6500).after.requestStartedAt, 6501);
  assert.deepEqual(exit(decoded, 6750), exit(rows, 6750));
  assert.equal(exit(decoded, 6750).sample.requestStartedAt, 6751);
  assert.ok(size(recorder.data) < size(rows) / 10);
});

test('the 500-read seven-state retained prefix compresses without repairing its original missing interval', () => {
  const rows = Array.from({ length: 500 }, (_, i) => {
    const snapshot = mixed(); snapshot.tasks[0].createdAt = Math.min(6, Math.floor(i / 72));
    return sample(1000 + i * 100, 1002 + i * 100, snapshot, 'pending-investigations:children');
  });
  assert.equal(rows.slice(1).filter((row, i) => JSON.stringify(row.snapshot) === JSON.stringify(rows[i].snapshot)).length, 493);
  const recorder = compact(rows);
  const decoded = decodeQaCompactionSnapshots(recorder.data);
  assert.equal(recorder.data.projections.length, 7);
  assert.deepEqual(decoded, rows);
  const originalGap = '500-transition evidence limit';
  assert.deepEqual(bracket(decoded, 62000, originalGap), bracket(rows, 62000, originalGap));
  assert.equal(bracket(decoded, 62000, originalGap).passed, false);
  assert.equal(bracket(decoded, 62000).passed, false, 'No after-start read can be backfilled from another source');
});

test('nearest unavailable observations and first consumed summary exits cannot be skipped', () => {
  const unavailable = { state: 'unavailable', reason: 'snapshot request failed' };
  for (const rows of [
    [sample(80, 90), sample(96, 99, unavailable), sample(110, 120)],
    [sample(80, 90), sample(101, 102, unavailable), sample(110, 120)],
  ]) {
    const recorder = compact(rows);
    assert.equal(recorder.unavailableReads, 1);
    assert.deepEqual(bracket(decodeQaCompactionSnapshots(recorder.data), 100), bracket(rows, 100));
    assert.equal(bracket(decodeQaCompactionSnapshots(recorder.data), 100).passed, false);
  }
  const consumed = mixed(); consumed.envelopes[0].action = 'continue'; consumed.envelopes[0].acknowledgedAt = 101;
  for (const first of [unavailable, consumed]) {
    const rows = [sample(101, 109, first), sample(110, 120)];
    const decoded = decodeQaCompactionSnapshots(compact(rows).data);
    assert.deepEqual(exit(decoded, 100), exit(rows, 100));
    assert.equal(exit(decoded, 100).passed, false);
  }
});

test('straddling and exactly touching reads retain the strict before/after rules', () => {
  const rows = [sample(70, 80), sample(90, 100), sample(95, 105), sample(100, 106), sample(107, 110)];
  const decoded = decodeQaCompactionSnapshots(compact(rows).data);
  assert.deepEqual(bracket(decoded, 100), bracket(rows, 100));
  assert.equal(bracket(decoded, 100).before.responseCompletedAt, 80);
  assert.equal(bracket(decoded, 100).after.requestStartedAt, 107);
  assert.equal(exit(decoded, 100).sample.requestStartedAt, 107);
});

test('out-of-order completions and equal timestamps preserve original completion-order tie selection', () => {
  const unavailable = { state: 'unavailable', reason: 'nearer failed read' };
  const rows = [sample(80, 90), sample(105, 110, unavailable), sample(101, 130), sample(101, 140, unavailable)];
  const decoded = decodeQaCompactionSnapshots(compact(rows).data);
  assert.deepEqual(decoded.map(row => row.requestStartedAt), [80, 105, 101, 101]);
  assert.deepEqual(bracket(decoded, 100), bracket(rows, 100));
  assert.equal(bracket(decoded, 100).after.responseCompletedAt, 130);
  const equalCompletion = [sample(70, 90, unavailable), sample(80, 90), sample(110, 120)];
  assert.deepEqual(bracket(decodeQaCompactionSnapshots(compact(equalCompletion).data), 100), bracket(equalCompletion, 100));
  assert.equal(bracket(equalCompletion, 100).passed, false);
});

test('interned snapshots are immutable and cannot be rewritten by later caller mutations', () => {
  const input = mixed(); const recorder = compact([sample(1, 2, input)]);
  input.tasks[0].status = 'completed';
  assert.equal(decodeQaCompactionSnapshots(recorder.data)[0].snapshot.tasks[0].status, 'running');
  assert.throws(() => { recorder.data.projections[0].tasks[0].status = 'completed'; });
  assert.throws(() => { recorder.data.projections[0].envelopes.push({}); });
});

test('logical-read, projection and stage limits fail atomically and stay sticky', () => {
  for (const [options, first, second, expected] of [
    [{ maxReads: 1 }, sample(1, 2), sample(3, 4), /logical read/],
    [{ maxProjections: 1 }, sample(1, 2), sample(3, 4, { state: 'unavailable', reason: 'failed' }), /projection count/],
    [{ maxStages: 1 }, sample(1, 2), sample(3, 4, mixed(), 'second-stage'), /stage count/],
  ]) {
    const recorder = createQaCompactionSnapshotRecorder(options);
    assert.equal(recorder.record(first), true);
    const before = JSON.stringify(recorder.data);
    assert.equal(recorder.record(second), false);
    assert.match(recorder.gap, expected);
    assert.equal(JSON.stringify(recorder.data), before);
    const gap = recorder.gap;
    assert.equal(recorder.record(sample(10, 11)), false);
    assert.equal(recorder.gap, gap);
    assert.equal(recorder.byteCount, size(recorder.data));
  }
});

test('incremental UTF-8 accounting enforces exact compact byte boundaries and oversized projections', () => {
  const input = sample(1, 2, { state: 'unavailable', reason: 'ملاحظة 🌿' }, 'مرحلة');
  // The configured bound is itself serialized; converge after its digit count changes.
  let exactBytes = 2000;
  for (let i = 0; i < 3; i++) {
    const probe = createQaCompactionSnapshotRecorder({ maxBytes: exactBytes });
    assert.equal(probe.record(input), true);
    exactBytes = probe.byteCount;
  }
  const exact = createQaCompactionSnapshotRecorder({ maxBytes: exactBytes });
  assert.equal(exact.record(input), true);
  assert.equal(exact.byteCount, size(exact.data));
  const short = createQaCompactionSnapshotRecorder({ maxBytes: exactBytes - 1 });
  assert.equal(short.record(input), false); assert.match(short.gap, /byte limit/);
  assert.equal(short.data.reads.length, 0); assert.equal(short.data.projections.length, 0);
  const oversized = createQaCompactionSnapshotRecorder({ maxBytes: 400 });
  assert.equal(oversized.record(sample(1, 2, { state: 'unavailable', reason: 'x'.repeat(1000) })), false);
  assert.match(oversized.gap, /byte limit/);
});

test('legacy decode preserves rows and malformed schema, indices, timings and over-limit logs are rejected', () => {
  const legacy = [sample(1, 2)]; assert.equal(decodeQaCompactionSnapshots(legacy), legacy);
  const valid = compact(legacy).data;
  for (const mutate of [
    value => { value.schemaVersion = 1; }, value => { value.extra = true; },
    value => { value.limits.maxReads = 100001; }, value => { delete value.limits.maxBytes; },
    value => { value.projections = {}; }, value => { value.projections[0] = { state: 'observed' }; },
    value => { value.projections.push(value.projections[0]); }, value => { value.stages[0] = ''; },
    value => { value.stages.push(value.stages[0]); }, value => { value.reads[0].push(1); },
    value => { value.reads[0].pop(); }, value => { value.reads[0][0] = -1; },
    value => { value.reads[0][0] = 0.5; }, value => { value.reads[0][0] = 1; },
    value => { value.reads[0][1] = 1; }, value => { value.reads[0][1] = '0'; },
    value => { value.reads[0][2] = NaN; }, value => { value.reads[0][2] = -1; },
    value => { value.reads[0][3] = Infinity; }, value => { value.reads[0][2] = 3; },
    value => { value.limits.maxBytes = 200; },
    value => { value.limits.maxReads = 1; value.reads.push(value.reads[0]); },
    value => { value.limits.maxStages = 1; value.stages.push('extra-stage'); },
  ]) {
    const changed = structuredClone(valid); mutate(changed);
    assert.throws(() => decodeQaCompactionSnapshots(changed), /Invalid QA managed snapshot evidence/);
  }
  for (const value of [null, {}, [{ ...sample(1, 2), at: 3 }]]) assert.throws(() => decodeQaCompactionSnapshots(value));
});

test('malformed recorder input and unsupported limits fail explicitly', () => {
  for (const input of [sample(-1, 2), sample(2, 1), sample(1, Infinity), sample(1, 2, {}), sample(1, 2, mixed(), '')]) {
    const recorder = createQaCompactionSnapshotRecorder();
    assert.equal(recorder.record(input), false); assert.match(recorder.gap, /malformed/);
    assert.equal(recorder.data.reads.length, 0);
  }
  for (const limits of [{ maxReads: 0 }, { maxReads: 100001 }, { unknown: 1 }, { maxStages: NaN }]) {
    assert.throws(() => createQaCompactionSnapshotRecorder(limits));
  }
});

test('a 120-minute 100ms/500ms observation budget and 108 natural stage labels remain bounded', () => {
  const recorder = createQaCompactionSnapshotRecorder();
  const durationMs = 120 * 60 * 1000;
  const scheduled = [];
  for (const interval of [100, 500]) for (let at = 0; at < durationMs; at += interval) scheduled.push(at);
  scheduled.sort((a, b) => a - b);
  const snapshot = mixed(); const start = 1788610000000;
  scheduled.forEach((at, i) => assert.equal(recorder.record(sample(start + at, start + at + 2, snapshot, `natural-stage-${i % 108}`)), true));
  assert.equal(recorder.data.reads.length, 86400);
  assert.equal(recorder.data.projections.length, 1);
  assert.equal(recorder.data.stages.length, 108);
  assert.equal(recorder.gap, undefined);
  assert.equal(recorder.byteCount, size(recorder.data));
  assert.ok(recorder.byteCount < QA_COMPACTION_SNAPSHOT_LIMITS.maxBytes);
  const decoded = decodeQaCompactionSnapshots(recorder.data);
  assert.equal(decoded.length, scheduled.length);
  assert.deepEqual(decoded.at(-1), sample(start + scheduled.at(-1), start + scheduled.at(-1) + 2, snapshot, `natural-stage-${(scheduled.length - 1) % 108}`));
});

test('unchanged action audit counts coalesce with their extent while stage/count changes remain explicit', () => {
  const recorder = createQaCompactionActionSnapshotRecorder();
  for (let at = 0; at < 2000; at++) assert.equal(recorder.record({ stage: 'children', at, callCounts: { starts: 2, dispositions: 0 } }), true);
  assert.deepEqual(recorder.data, [{ stage: 'children', at: 0, lastAt: 1999, observations: 2000, callCounts: { starts: 2, dispositions: 0 } }]);
  recorder.record({ stage: 'before-boundary', at: 2000, callCounts: { starts: 2, dispositions: 0 } });
  recorder.record({ stage: 'before-boundary', at: 2001, callCounts: { starts: 2, dispositions: 1 } });
  assert.equal(recorder.data.length, 3); assert.equal(recorder.gap, undefined);
  assert.equal(recorder.byteCount, size(recorder.data));
});

test('action audit count and byte overflows remain explicit without changing earlier checkpoints', () => {
  const count = createQaCompactionActionSnapshotRecorder({ maxRecords: 1 });
  count.record({ stage: 'one', at: 1, callCounts: { starts: 1 } });
  const original = JSON.stringify(count.data);
  assert.equal(count.record({ stage: 'two', at: 2, callCounts: { starts: 1 } }), false);
  assert.match(count.gap, /count limit/); assert.equal(JSON.stringify(count.data), original);
  assert.equal(count.record({ stage: 'one', at: 3, callCounts: { starts: 1 } }), false);
  const probe = createQaCompactionActionSnapshotRecorder();
  probe.record({ stage: 'one', at: 1, callCounts: { starts: 1 } });
  const bounded = createQaCompactionActionSnapshotRecorder({ maxBytes: probe.byteCount });
  assert.equal(bounded.record({ stage: 'one', at: 1, callCounts: { starts: 1 } }), true);
  assert.equal(bounded.record({ stage: 'one', at: 1000, callCounts: { starts: 1 } }), false);
  assert.match(bounded.gap, /byte limit/); assert.equal(bounded.byteCount, size(bounded.data));
});
