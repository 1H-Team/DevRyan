import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { parseNativeJournalObservation } from '../../packages/shared-runtime/lib/native-observation.js';
import { findQaNativeCompactionBoundaries } from './native-compaction-evidence.mjs';

// Synthetic finite contract fixtures only; runtime witnesses are required live.
const hash = text => createHash('sha256').update(text).digest('hex');
const digest = text => ({ sha256: hash(text), bytes: Buffer.byteLength(text) });
const input = { sessionID: 'ses_root', directory: '/fixture', configurationDigest: 'a'.repeat(64), reason: 'auto', startedAt: 90 };
function fixture(reason = 'auto', text = 'summary') {
  const common = { schema: 1, controllerInstanceID: 'controller', configurationDigest: input.configurationDigest,
    sessionID: input.sessionID, directory: `<WORKTREE_${hash(input.directory).slice(0, 12)}>` };
  const inputID = reason === 'manual' ? 'msg_compaction' : null;
  const observations = [
    { ...common, stage: 'compaction-trigger', triggerID: 'trigger', reason, inputID, entered: 101,
      orderedInputDigest: 'b'.repeat(64), inputCount: 3, anchorMessageID: 'msg_anchor', checkpointMessageID: null,
      budget: { auto: true, buffer: null, keep: 2, ceiling: 800, budget: 800, estimatePrompt: { measured: 500, estimated: 310 },
        estimateContext: 810, limits: { context: 1000, input: null, output: 200 }, anchorIndex: 1, checkpointIndex: -1, stateRevision: 2, due: true } },
    { ...common, stage: 'compaction-event', triggerID: reason === 'manual' ? null : 'trigger', eventID: 'evt_started', sequence: 7,
      created: 100, event: 'started', reason: reason === 'manual' ? 'manual' : 'auto', inputID, messageID: null,
      witness: { recent: null, text: null, providerState: null, providerContext: null } },
    { ...common, stage: 'compaction-event', triggerID: 'trigger', eventID: 'evt_ended_DIFFERENT', sequence: 8, created: 110,
      event: 'ended', reason: reason === 'manual' ? 'manual' : 'auto', inputID, messageID: 'msg_compaction',
      witness: { recent: digest('[]'), text: digest(text), providerState: text ? null : digest('{"checkpoint":1}'), providerContext: null } },
    { ...common, stage: 'compaction-outcome', triggerID: 'trigger', status: 'completed', finished: 111 },
  ];
  const rows = [
    { info: { id: 'msg_compaction', sessionID: input.sessionID, role: 'user', time: { created: 80 } }, parts: [{ id: 'msg_compaction:compaction', type: 'compaction', auto: reason !== 'manual' }] },
    { info: { id: 'msg_compaction:summary', parentID: 'msg_compaction', sessionID: input.sessionID, role: 'assistant', summary: true, time: { completed: 81 } },
      parts: text ? [{ type: 'text', text }] : [] },
  ];
  return { rows, observations: observations.map(parseNativeJournalObservation) };
}

test('native raw lifecycle binds actual running message identity and estimate, not REST clamped time or Ended ID', () => {
  const { rows, observations } = fixture();
  const [boundary] = findQaNativeCompactionBoundaries(rows, { ...input, observations });
  assert.equal(boundary.boundaryMessageId, 'msg_compaction');
  assert.equal(boundary.observedAt, 110); assert.equal(boundary.projectedSummaryCompletedAt, 81);
  assert.equal(boundary.thresholdReached, true); assert.equal(boundary.usageAtTrigger, 810);
  assert.deepEqual(boundary.nativeCycle, { startedAt: 100, completedAt: 110, startedEventID: 'evt_started', endedEventID: 'evt_ended_DIFFERENT', startedSequence: 7, endedSequence: 8 });
});

test('manual pre-scope Started joins only exact real input identity; empty native provider checkpoint is witnessed', () => {
  const { rows, observations } = fixture('manual', '');
  const [boundary] = findQaNativeCompactionBoundaries(rows, { ...input, reason: 'manual', observations });
  assert.equal(boundary.summaryKind, 'native-provider-checkpoint'); assert.equal(boundary.summaryBytes, 0);
  observations[1].inputID = 'msg_other';
  assert.deepEqual(findQaNativeCompactionBoundaries(rows, { ...input, reason: 'manual', observations }), []);
});

test('foreign scope, missing/failed/replayed events and mismatched summary digest never prove a boundary', () => {
  for (const change of [
    data => { data.observations[2].configurationDigest = 'c'.repeat(64); }, data => { data.observations[2].controllerInstanceID = 'old'; },
    data => { data.observations[2].directory = '<WORKTREE_bbbbbbbbbbbb>'; }, data => { data.observations.splice(1, 1); },
    data => { data.observations[3].status = 'failed'; }, data => { data.observations.push(data.observations[2]); },
    data => { data.observations[2].sequence = 6; }, data => { data.observations[2].messageID = 'evt_ended_DIFFERENT'; },
    data => { data.rows[1].parts[0].text = 'changed'; }, data => { data.observations[0].budget = null; },
  ]) { const data = fixture(); change(data); assert.deepEqual(findQaNativeCompactionBoundaries(data.rows, { ...input, observations: data.observations }), []); }
  const data = fixture('auto', ''); data.observations[2].witness.providerState = null;
  assert.deepEqual(findQaNativeCompactionBoundaries(data.rows, { ...input, observations: data.observations }), []);
});

test('automatic acceptance requires unchanged actual due ceiling; overflow is never an automatic witness', () => {
  for (const change of [budget => { budget.due = false; }, budget => { budget.estimatePrompt.estimated = 299; budget.estimateContext = 799; }, budget => { budget.auto = false; }]) {
    const data = fixture(); change(data.observations[0].budget);
    assert.equal(findQaNativeCompactionBoundaries(data.rows, { ...input, observations: data.observations })[0].thresholdReached, false);
  }
  const data = fixture('overflow');
  assert.deepEqual(findQaNativeCompactionBoundaries(data.rows, { ...input, observations: data.observations }), []);
  assert.equal(findQaNativeCompactionBoundaries(data.rows, { ...input, reason: 'overflow', observations: data.observations })[0].overflow, true);
  assert.deepEqual(findQaNativeCompactionBoundaries(data.rows, { ...input, observations: data.observations, previousPartIds: ['msg_compaction:compaction'] }), []);
});

test('manual/natural adapters use native evidence and never fall back to v1 lifecycle names', async () => {
  const { findManualCompactionBoundary } = await import('./compaction-scenarios.mjs');
  const { findNaturalCompactionBoundaries } = await import('./natural-compaction-scenarios.mjs');
  const { readQaNativeCompactionPolicy } = await import('./native-compaction-evidence.mjs');
  const manual = fixture('manual', '');
  assert.equal(findManualCompactionBoundary(manual.rows, [], { ...input, observations: manual.observations }).observedAt, 110);
  const auto = fixture();
  assert.equal(findNaturalCompactionBoundaries(auto.rows, { ...input, version: '2.0.20', observations: auto.observations, nativeObservationScope: input })[0].thresholdReached, true);
  assert.deepEqual(findNaturalCompactionBoundaries(auto.rows, { ...input, version: '2.0.20', observations: auto.observations }), []);
  assert.equal(readQaNativeCompactionPolicy(auto.observations, input).threshold, 800);
  for (const version of ['2.0.20', '2.0.24', '2.0.26']) assert.equal(readQaNativeCompactionPolicy(auto.observations, { ...input, version }).version, version);
  assert.throws(() => readQaNativeCompactionPolicy(auto.observations, { ...input, version: '2.0.21' }), { code: 'qa_native_compaction_evidence_unavailable' });
  assert.throws(() => readQaNativeCompactionPolicy(auto.observations, { ...input, directory: '/foreign' }), { code: 'qa_native_compaction_evidence_unavailable' });
});

test('actual shared journal sanitizer roundtrip retains raw native compaction witness and budget', async t => {
  const { mkdir, mkdtemp, rm } = await import('node:fs/promises');
  const path = await import('node:path');
  const { createDiagnosticJournal } = await import('../../packages/harness-runtime/lib/journal.js');
  const { createDiagnosticSanitizer } = await import('../../packages/harness-runtime/lib/sanitizer.js');
  const { readQaNativeObservations } = await import('./native-observation-evidence.mjs');
  const base = path.resolve('.cache/v2-validation'); await mkdir(base, { recursive: true });
  const runtimeRoot = await mkdtemp(path.join(base, 'compaction-journal-'));
  const directory = path.join(runtimeRoot, 'project'); await mkdir(directory);
  const journalDirectory = path.join(runtimeRoot, 'harness/journal');
  const sanitizer = createDiagnosticSanitizer({ homeDir: runtimeRoot, worktreeRoots: [directory] });
  const journal = createDiagnosticJournal({ directory: journalDirectory, sanitizer, runtime: 'qa-contract' });
  t.after(() => journal.close());
  // Registered after the journal close: hooks run in order, and closing recreates files.
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const data = fixture();
  for (const payload of data.observations) journal.enqueue({ type: 'lifecycle', event: 'native_observation', at: 112,
    sessionID: input.sessionID, directory, payload: { ...payload, directory } });
  await journal.flush();
  const evidence = await readQaNativeObservations({ journalDirectory, runtimeRoot, parseObservation: parseNativeJournalObservation, final: true });
  assert.equal(evidence.observations.length, 4);
  assert.deepEqual(evidence.observations[0].budget, data.observations[0].budget);
  assert.deepEqual(evidence.observations[2].witness, data.observations[2].witness);
  const [boundary] = findQaNativeCompactionBoundaries(data.rows, { ...input, directory, observations: evidence.observations });
  assert.equal(boundary.thresholdReached, true);
  assert.equal(boundary.nativeCycle.startedSequence, 7);
  assert.equal(JSON.stringify(evidence.records).includes(directory), false);
});

test('prefill uses actual Prepared limits and frozen settings before any trigger; actual changed ceiling fails', async () => {
  const { deriveQaNativeCompactionPrefillPolicy, findNaturalCompactionBoundaries } = await import('./natural-compaction-scenarios.mjs');
  const data = fixture(), common = data.observations[0];
  const { schema, controllerInstanceID, configurationDigest, sessionID, directory } = common;
  const prepared = parseNativeJournalObservation({ schema, controllerInstanceID, configurationDigest, sessionID, directory,
    stage: 'model-prepared', requestID: 'initial_request', kind: 'primary',
    execution: { agent: 'orchestrator', providerID: 'owned', modelID: 'model', variant: 'default' }, options: {}, hookOptions: {},
    modelLimits: { context: 1000, input: null, output: 200 } });
  const source = { ...input, observations: [prepared], compaction: { auto: true, buffer: 200 }, version: '2.0.20',
    target: { version: '2.0.20', source: 'DEVRYAN_QA_OPENCODE_VERSION' } };
  const policy = deriveQaNativeCompactionPrefillPolicy(source);
  assert.equal(policy.threshold, 800); assert.equal(policy.source, 'qa-prefill-estimate-from-native-prepared-and-frozen-settings');
  assert.equal(policy.triggerEvidence.state, 'unavailable');
  assert.equal(findNaturalCompactionBoundaries(data.rows, { ...input, version: '2.0.20', observations: data.observations,
    threshold: policy.threshold, nativeObservationScope: input })[0].thresholdReached, true);
  assert.throws(() => findNaturalCompactionBoundaries(data.rows, { ...input, version: '2.0.20', observations: data.observations,
    threshold: 799, nativeObservationScope: input }), /Actual native ceiling changed/);
  for (const change of [{ directory: '/foreign' }, { configurationDigest: 'c'.repeat(64) }, { observations: [] }, { compaction: undefined }]) {
    assert.throws(() => deriveQaNativeCompactionPrefillPolicy({ ...source, ...change }));
  }
});
