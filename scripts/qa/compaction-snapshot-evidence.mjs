import { Buffer } from 'node:buffer';

export const QA_COMPACTION_SNAPSHOT_LIMITS = Object.freeze({
  maxProjections: 500, maxReads: 100_000, maxStages: 256, maxBytes: 8 * 1024 * 1024,
});
const ACTION_LIMITS = Object.freeze({ maxRecords: 500, maxBytes: 256 * 1024 });
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const time = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const stageName = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const windowIsValid = (start, end) => time(start) && time(end) && end >= start;
const validProjection = value => object(value) && (value.state === 'unavailable'
  ? typeof value.reason === 'string'
  : value.state === 'observed' && ['tasks', 'envelopes', 'activeTaskIds', 'awaitingDispositionTaskIds'].every(key => Array.isArray(value[key])));
const freeze = value => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const checkedLimits = (supplied, maximum) => {
  if (!object(supplied) || Object.keys(supplied).some(key => !Object.hasOwn(maximum, key))) throw new Error('Invalid QA evidence limits');
  const limits = { ...maximum, ...supplied };
  if (Object.entries(limits).some(([key, value]) => !Number.isSafeInteger(value) || value < 1 || value > maximum[key])) {
    throw new Error('Invalid QA evidence limits');
  }
  return Object.freeze(limits);
};

// Full projections are immutable and interned, but every actual HTTP read keeps
// its exact window. Append/completion order is also the graders' stable tie order.
export function createQaCompactionSnapshotRecorder(options = {}) {
  const limits = checkedLimits(options, QA_COMPACTION_SNAPSHOT_LIMITS);
  const data = { schemaVersion: 2, limits, projections: [], stages: [], reads: [] };
  const projections = new Map();
  const stages = new Map();
  let byteCount = bytes(data);
  let gap = byteCount > limits.maxBytes ? 'managed snapshot compact byte limit' : undefined;
  let unavailableReads = 0;
  const fail = reason => { gap ??= reason; return false; };
  return {
    data,
    get gap() { return gap; },
    get byteCount() { return byteCount; },
    get unavailableReads() { return unavailableReads; },
    record({ stage, requestStartedAt, responseCompletedAt, snapshot }) {
      if (gap) return false;
      if (!stageName(stage) || !windowIsValid(requestStartedAt, responseCompletedAt) || !validProjection(snapshot)) {
        return fail('managed snapshot input is malformed');
      }
      let serialized;
      let projection;
      try { serialized = JSON.stringify(snapshot); projection = JSON.parse(serialized); }
      catch { return fail('managed snapshot projection is not JSON data'); }
      if (!validProjection(projection)) return fail('managed snapshot projection is malformed');
      const knownProjection = projections.get(serialized);
      const knownStage = stages.get(stage);
      const projectionIndex = knownProjection ?? data.projections.length;
      const stageIndex = knownStage ?? data.stages.length;
      if (knownProjection === undefined && data.projections.length >= limits.maxProjections) return fail('managed snapshot projection count limit');
      if (knownStage === undefined && data.stages.length >= limits.maxStages) return fail('managed snapshot stage count limit');
      if (data.reads.length >= limits.maxReads) return fail('managed snapshot logical read count limit');
      const read = [stageIndex, projectionIndex, requestStartedAt, responseCompletedAt];
      const addedBytes = bytes(read) + (data.reads.length ? 1 : 0)
        + (knownStage === undefined ? bytes(stage) + (data.stages.length ? 1 : 0) : 0)
        + (knownProjection === undefined ? Buffer.byteLength(serialized) + (data.projections.length ? 1 : 0) : 0);
      if (byteCount + addedBytes > limits.maxBytes) return fail('managed snapshot compact byte limit');
      if (knownStage === undefined) { stages.set(stage, stageIndex); data.stages.push(stage); }
      if (knownProjection === undefined) { projections.set(serialized, projectionIndex); data.projections.push(freeze(projection)); }
      data.reads.push(read);
      byteCount += addedBytes;
      if (projection.state === 'unavailable') unavailableReads++;
      return true;
    },
  };
}

// Legacy arrays retain their original objects/order. Schema 2 expands only in
// memory for the unchanged strict graders; saved evidence stays compact.
export function decodeQaCompactionSnapshots(value) {
  const invalid = reason => { throw new Error(`Invalid QA managed snapshot evidence: ${reason}`); };
  if (Array.isArray(value)) {
    if (value.length > QA_COMPACTION_SNAPSHOT_LIMITS.maxProjections || value.some(row => !object(row)
      || !stageName(row.stage) || !windowIsValid(row.requestStartedAt, row.responseCompletedAt)
      || row.at !== row.responseCompletedAt || !validProjection(row.snapshot))) invalid('legacy rows');
    if (bytes(value) > QA_COMPACTION_SNAPSHOT_LIMITS.maxBytes) invalid('legacy byte limit');
    return value;
  }
  if (!object(value) || value.schemaVersion !== 2
    || Object.keys(value).sort().join(',') !== 'limits,projections,reads,schemaVersion,stages') invalid('schema');
  let limits;
  try {
    if (Object.keys(value.limits ?? {}).length !== Object.keys(QA_COMPACTION_SNAPSHOT_LIMITS).length) invalid('limits');
    limits = checkedLimits(value.limits, QA_COMPACTION_SNAPSHOT_LIMITS);
  } catch { invalid('limits'); }
  if (!Array.isArray(value.projections) || !Array.isArray(value.stages) || !Array.isArray(value.reads)
    || value.projections.length > limits.maxProjections || value.stages.length > limits.maxStages
    || value.reads.length > limits.maxReads) invalid('table count limit');
  if (value.stages.some(stage => !stageName(stage)) || new Set(value.stages).size !== value.stages.length) invalid('stage table');
  if (value.projections.some(projection => !validProjection(projection))) invalid('projection table');
  if (new Set(value.projections.map(projection => JSON.stringify(projection))).size !== value.projections.length) invalid('duplicate projection');
  if (value.reads.some(read => !Array.isArray(read) || read.length !== 4
    || !Number.isSafeInteger(read[0]) || read[0] < 0 || read[0] >= value.stages.length
    || !Number.isSafeInteger(read[1]) || read[1] < 0 || read[1] >= value.projections.length
    || !windowIsValid(read[2], read[3]))) invalid('read reference or timing');
  if (bytes(value) > limits.maxBytes) invalid('compact byte limit');
  return value.reads.map(([stage, projection, requestStartedAt, responseCompletedAt]) => ({
    stage: value.stages[stage], at: responseCompletedAt, requestStartedAt, responseCompletedAt,
    snapshot: value.projections[projection],
  }));
}

// These are action-count audit checkpoints, not canonical actions or temporal
// task witnesses. Repeated identical checkpoints retain their observed extent.
export function createQaCompactionActionSnapshotRecorder(options = {}) {
  const limits = checkedLimits(options, ACTION_LIMITS);
  const data = [];
  let byteCount = bytes(data);
  let gap = byteCount > limits.maxBytes ? 'action snapshot byte limit' : undefined;
  let previousCounts;
  const fail = reason => { gap ??= reason; return false; };
  return {
    data,
    get gap() { return gap; },
    get byteCount() { return byteCount; },
    record({ stage, at, callCounts }) {
      if (gap) return false;
      if (!stageName(stage) || !time(at) || !object(callCounts)
        || Object.values(callCounts).some(count => !Number.isSafeInteger(count) || count < 0)) return fail('action snapshot input is malformed');
      const serialized = JSON.stringify(callCounts);
      const previous = data.at(-1);
      if (previous?.stage === stage && previousCounts === serialized) {
        const next = { ...previous, lastAt: at, observations: previous.observations + 1 };
        const addedBytes = bytes(next) - bytes(previous);
        if (byteCount + addedBytes > limits.maxBytes) return fail('action snapshot byte limit');
        data[data.length - 1] = next;
        byteCount += addedBytes;
        return true;
      }
      if (data.length >= limits.maxRecords) return fail('action snapshot count limit');
      const row = { stage, at, lastAt: at, observations: 1, callCounts: freeze(JSON.parse(serialized)) };
      const addedBytes = bytes(row) + (data.length ? 1 : 0);
      if (byteCount + addedBytes > limits.maxBytes) return fail('action snapshot byte limit');
      data.push(row);
      previousCounts = serialized;
      byteCount += addedBytes;
      return true;
    },
  };
}
