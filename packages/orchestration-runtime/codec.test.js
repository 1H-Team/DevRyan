import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  AUTO_RESUME_ACTIVE_STATES,
  MANAGED_RESULT_PAYLOAD_FIELDS,
  decodeBase64Url,
  decodeLedgerSnapshot,
  decodeManagedTaskRecord,
  decodeResultEnvelope,
  decodeResultEnvelopePayload,
  decodeSnapshotPayload,
  decodeTaskEventPayload,
  decodeTaskEventRecord,
  encodeBase64Url,
  encodeLedgerSnapshot,
  findManagedResultPayloadMismatch,
  isAutoResumeActive,
  isManagedTaskId,
  stableStringify,
} from './index.js';

const fixture = name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const current = JSON.parse(fixture('ledger-current.json'));
const event = JSON.parse(fixture('task-event.json'));
const snapshot = JSON.parse(fixture('snapshot.json'));
const MODES = ['strict', 'lenient'];

describe('persisted records', () => {
  test('legacy defaults keep stored keys in place and append absent ones in table order', () => {
    const { dispatchGroupId: _g, readOnly: _r, waitingReason: _w, ...legacy } = current.tasks[0];
    const decoded = decodeManagedTaskRecord(legacy);
    const keys = Object.keys(decoded);
    expect(keys.slice(-3)).toEqual(['dispatchGroupId', 'readOnly', 'waitingReason']);
    expect(decoded).toMatchObject({ dispatchGroupId: null, readOnly: false, waitingReason: null });
    expect(Object.keys(decodeManagedTaskRecord(current.tasks[0]))).toEqual(Object.keys(current.tasks[0]));

    const { providerResetAt: _p, autoResume: _a, ...legacyEnvelope } = current.resultEnvelopes[0];
    expect(Object.keys(decodeResultEnvelope(legacyEnvelope)).slice(-2)).toEqual(['providerResetAt', 'autoResume']);
  });

  test('encodeLedgerSnapshot writes the pinned bytes', () => {
    expect(encodeLedgerSnapshot(current)).toBe(fixture('ledger-current.json'));
    expect(encodeLedgerSnapshot(JSON.parse(fixture('ledger-legacy.json')))).toBe(fixture('ledger-legacy.atomic-saved.json'));
  });

  test('the default errors are coded TypeErrors with the persisted-ledger messages', () => {
    const failure = value => { try { decodeLedgerSnapshot(value); } catch (error) { return error; } throw new Error('decoded'); };
    expect(failure([])).toMatchObject({ name: 'TypeError', code: 'invalid_ledger_version', message: 'managed orchestration ledger version is invalid' });
    expect(failure({ version: 1, tasks: [] })).toMatchObject({ code: 'invalid_ledger_collections' });
    expect(failure({ ...current, tasks: [current.tasks[0], current.tasks[0]] }))
      .toMatchObject({ code: 'duplicate_task', message: 'duplicate managed task dvr_task_golden1' });
    expect(failure({ ...current, tasks: [current.tasks[0], { ...current.tasks[1], idempotencyKey: current.tasks[0].idempotencyKey }] }))
      .toMatchObject({ code: 'duplicate_idempotency_key' });
    expect(failure({ ...current, resultEnvelopes: [current.resultEnvelopes[0], current.resultEnvelopes[0]] }))
      .toMatchObject({ code: 'duplicate_result_envelope' });
    expect(failure({ ...current, tasks: [current.tasks[1]] })).toMatchObject({ code: 'orphan_result_envelope' });
    expect(failure({ ...current, resultEnvelopes: [{ ...current.resultEnvelopes[0], partial: true }, current.resultEnvelopes[1]] }))
      .toMatchObject({ name: 'TypeError', message: 'result envelope partial does not match task dvr_task_golden1' });
  });

  test('optional envelopes are checked after the tasks and errors come from the caller', () => {
    const createError = (code, detail) => Object.assign(new Error(code), { detail });
    const { resultEnvelopes: _e, ...withoutEnvelopes } = current;
    expect(decodeLedgerSnapshot(withoutEnvelopes, { requireResultEnvelopes: false }).resultEnvelopes).toEqual([]);
    expect(() => decodeLedgerSnapshot({ ...current, tasks: [{}], resultEnvelopes: 'bad' }, { requireResultEnvelopes: false, createError }))
      .toThrow(TypeError);
    expect(() => decodeLedgerSnapshot({ ...current, resultEnvelopes: 'bad' }, { requireResultEnvelopes: false, createError }))
      .toThrow('invalid_result_envelopes');
    expect(() => decodeLedgerSnapshot({ ...current, tasks: [{}], resultEnvelopes: 'bad' }, { createError }))
      .toThrow('invalid_ledger_collections');
  });
});

describe('wire decoders', () => {
  const unknownReason = { ...event.properties.resultEnvelope, autoResume: { ...event.properties.resultEnvelope.autoResume, reason: 'from_a_newer_host' } };
  const invalidAutoResume = { ...event.properties.resultEnvelope, autoResume: { ...event.properties.resultEnvelope.autoResume, state: 'bogus' } };

  test.each(MODES)('%s: the golden task event and snapshot decode', (mode) => {
    const decoded = decodeTaskEventPayload(event.properties, { mode });
    expect(decoded.task).toMatchObject({ taskId: 'dvr_task_golden2', failureKind: 'provider_usage_limit', waitingReason: null });
    expect(decoded.resultEnvelope.autoResume).toEqual(event.properties.resultEnvelope.autoResume);
    const parsed = decodeSnapshotPayload(snapshot, { mode });
    expect(parsed.tasks.map(task => task.taskId)).toEqual(['dvr_task_golden1', 'dvr_task_golden2']);
    expect(parsed.resultEnvelopes[1].autoResume).toEqual(snapshot.resultEnvelopes[1].autoResume);
  });

  test('lenient keeps an envelope whose autoResume carries an unknown reason; strict drops it', () => {
    expect(decodeResultEnvelopePayload(unknownReason, { mode: 'lenient' }).autoResume).toMatchObject({ state: 'scheduled', reason: null });
    expect(decodeResultEnvelopePayload(unknownReason, { mode: 'strict' })).toBeNull();
    expect(decodeTaskEventPayload({ ...event.properties, resultEnvelope: unknownReason }, { mode: 'lenient' }).resultEnvelope.autoResume.reason).toBeNull();
    expect(decodeTaskEventPayload({ ...event.properties, resultEnvelope: unknownReason }, { mode: 'strict' })).toBeNull();
  });

  test('lenient degrades an invalid autoResume to null instead of dropping the envelope', () => {
    const lenient = decodeResultEnvelopePayload(invalidAutoResume, { mode: 'lenient' });
    expect(lenient).toMatchObject({ envelopeId: invalidAutoResume.envelopeId, autoResume: null });
    expect(decodeResultEnvelopePayload(invalidAutoResume, { mode: 'strict' })).toBeNull();
    const envelopes = snapshot.resultEnvelopes.map(entry => entry.taskId === invalidAutoResume.taskId ? { ...entry, autoResume: invalidAutoResume.autoResume } : entry);
    expect(decodeSnapshotPayload({ ...snapshot, resultEnvelopes: envelopes }, { mode: 'lenient' }).resultEnvelopes[1].autoResume).toBeNull();
    expect(() => decodeSnapshotPayload({ ...snapshot, resultEnvelopes: envelopes }, { mode: 'strict' })).toThrow('invalid snapshot');
  });

  test('a persisted block with absent counters reads in its normalized form', () => {
    const { attemptCount: _a, hostFailures: _h, ...older } = event.properties.resultEnvelope.autoResume;
    for (const mode of MODES) {
      expect(decodeResultEnvelopePayload({ ...event.properties.resultEnvelope, autoResume: older }, { mode }).autoResume)
        .toMatchObject({ attemptCount: 0, hostFailures: 0 });
    }
  });

  test('waitingReason: lenient reads a malformed one as null, strict rejects the task', () => {
    const queued = { ...snapshot.tasks[0], status: 'queued', finishedAt: null, waitingReason: { kind: 'capacity', activeCount: -1, limit: 2, since: 1 } };
    expect(decodeTaskEventRecord(queued, { mode: 'lenient' }).waitingReason).toBeNull();
    expect(decodeTaskEventRecord(queued, { mode: 'strict' })).toBeNull();
    const valid = { ...queued, waitingReason: { kind: 'capacity', activeCount: 2, limit: 2, since: 1 } };
    for (const mode of MODES) expect(decodeTaskEventRecord(valid, { mode }).waitingReason).toEqual(valid.waitingReason);
    const stale = { ...snapshot.tasks[0], waitingReason: valid.waitingReason };
    expect(decodeTaskEventRecord(stale, { mode: 'lenient' }).waitingReason).toBeNull();
    expect(decodeTaskEventRecord(stale, { mode: 'strict' })).toBeNull();
  });

  test('both modes reject a broken core record, a mismatched envelope and an unknown mode', () => {
    for (const mode of MODES) {
      expect(decodeTaskEventRecord({ ...snapshot.tasks[0], taskId: 'task_1' }, { mode })).toBeNull();
      expect(decodeTaskEventPayload({ ...event.properties, directory: '/elsewhere' }, { mode })).toBeNull();
      expect(decodeTaskEventPayload({ ...event.properties, resultEnvelope: { ...event.properties.resultEnvelope, attempt: 2 } }, { mode })).toBeNull();
      expect(() => decodeSnapshotPayload({ ...snapshot, resultEnvelopes: [] }, { mode })).toThrow('invalid snapshot');
    }
    expect(() => decodeTaskEventRecord(snapshot.tasks[0], { mode: 'loose' })).toThrow('decode mode');
    expect(decodeTaskEventRecord(snapshot.tasks[0])).toEqual(decodeTaskEventRecord(snapshot.tasks[0], { mode: 'strict' }));
  });
});

describe('primitives', () => {
  test('base64url round-trips UTF-8 with an explicit pad flag', () => {
    const text = 'a✓😀';
    expect(encodeBase64Url(text, { pad: false })).toBe('YeKck_CfmIA');
    expect(encodeBase64Url(text, { pad: true })).toBe('YeKck_CfmIA=');
    for (const pad of [true, false]) expect(decodeBase64Url('YeKck_CfmIA', { pad })).toBe(text);
    expect(() => decodeBase64Url('YeKck_CfmIA=', { pad: true })).toThrow(TypeError);
    expect(() => decodeBase64Url('A', { pad: false })).toThrow(TypeError);
    expect(() => decodeBase64Url('_w', { pad: true })).toThrow(TypeError);
  });

  test('stableStringify sorts object keys at every depth and keeps array order', () => {
    expect(stableStringify({ b: [{ z: 1, a: 2 }], a: { d: 1, c: null } })).toBe('{"a":{"c":null,"d":1},"b":[{"a":2,"z":1}]}');
  });

  test('payload-field equality reports the first mismatch, canonicalRefs last', () => {
    const [task] = current.tasks, [envelope] = current.resultEnvelopes;
    expect(MANAGED_RESULT_PAYLOAD_FIELDS.every(field => Object.hasOwn(envelope, field))).toBe(true);
    expect(findManagedResultPayloadMismatch(task, envelope)).toBeNull();
    expect(findManagedResultPayloadMismatch(task, { ...envelope, status: 'failed', canonicalRefs: [] })).toBe('status');
    expect(findManagedResultPayloadMismatch(task, { ...envelope, canonicalRefs: [] })).toBe('canonicalRefs');
    const { attempt: _a, ...missing } = envelope;
    expect(findManagedResultPayloadMismatch({ ...task, attempt: undefined }, missing)).toBeNull();
    expect(findManagedResultPayloadMismatch({ ...task, attempt: undefined }, missing, { requireOwnFields: true })).toBe('attempt');
  });

  test('task ids and active auto-resume states', () => {
    expect(isManagedTaskId('dvr_task_ab-C_9')).toBe(true);
    expect(isManagedTaskId('dvr_task_')).toBe(false);
    expect(isManagedTaskId('dvr_task_a b')).toBe(false);
    expect(isManagedTaskId(null)).toBe(false);
    for (const state of AUTO_RESUME_ACTIVE_STATES) expect(isAutoResumeActive({ autoResume: { enabled: true, state } })).toBe(true);
    expect(isAutoResumeActive({ autoResume: { enabled: true, state: 'exhausted' } })).toBe(false);
  });
});

test('wire codec preserves explicit stopped recovery policy and native dispatch readiness', () => {
  const task = decodeTaskEventRecord({ ...event.properties.task, terminationIntent: 'user_stopped',
    manualRecoveryRequired: false, userStoppedRecoveryAvailable: true });
  expect(task).toMatchObject({ terminationIntent: 'user_stopped', manualRecoveryRequired: false, userStoppedRecoveryAvailable: true });
  expect(decodeTaskEventRecord({ ...event.properties.task, userStoppedRecoveryAvailable: 'true' })).toBeNull();
  expect(decodeSnapshotPayload({ ...snapshot, bridgeReady: false, dispatchReady: true }).dispatchReady).toBe(true);
  expect(() => decodeSnapshotPayload({ ...snapshot, dispatchReady: 'true' })).toThrow();
});
