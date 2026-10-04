import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { readQaNativeObservations, flushQaNativeObservationJournal } from './native-observation-evidence.mjs';

// Synthetic journal contract fixtures only; these do not qualify a native run.
const parseObservation = row => {
  if (row?.schema !== 1 || row.stage !== 'model-prepared') throw new Error('invalid named schema');
  return row;
};
const row = { type: 'lifecycle', at: 10, event: 'native_observation', sessionID: 'ses_fixture', directory: '<WORKTREE_aaaaaaaaaaaa>',
  payload: { schema: 1, stage: 'model-prepared', requestID: 'fixture', sessionID: 'ses_fixture', directory: '<WORKTREE_aaaaaaaaaaaa>' } };
async function fixture(t) {
  const base = path.resolve('.cache/v2-validation');
  await mkdir(base, { recursive: true });
  const runtimeRoot = await mkdtemp(path.join(base, 'journal-reader-'));
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const journalDirectory = path.join(runtimeRoot, 'harness/journal');
  await mkdir(path.join(journalDirectory, 'sessions/ses_fixture'), { recursive: true });
  return { runtimeRoot, journalDirectory, parseObservation };
}
const chunk = input => path.join(input.journalDirectory, 'sessions/ses_fixture/000001.ndjson.open');

test('reads existing raw named records and gzip chunks without treating other lifecycle schemas as native', async t => {
  const input = await fixture(t);
  const ordinary = { type: 'lifecycle', at: 5, event: 'native-process-exit', payload: { futureField: true } };
  await writeFile(chunk(input), `${JSON.stringify(ordinary)}\n${JSON.stringify(row)}\n`);
  await mkdir(path.join(input.journalDirectory, 'runtime'));
  await writeFile(path.join(input.journalDirectory, 'runtime/000002.ndjson.gz'), gzipSync(`${JSON.stringify({ ...row, at: 11 })}\n`));
  const result = await readQaNativeObservations({ ...input, final: true });
  assert.deepEqual(result.records, [row, { ...row, at: 11 }]);
  assert.deepEqual(result.observations, [row.payload, row.payload]);
  assert.equal(result.complete, true);
  assert.equal(result.scannedRecords, 3);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.files.length, 2);
});

test('an open partial write remains explicit incomplete evidence and never passes a final read', async t => {
  const input = await fixture(t);
  await writeFile(chunk(input), `${JSON.stringify(row)}\n{"type":"lifecycle"`);
  const polling = await readQaNativeObservations(input);
  assert.equal(polling.complete, false);
  assert.deepEqual(polling.records, [row]);
  await assert.rejects(readQaNativeObservations({ ...input, final: true }), { code: 'qa_native_journal_incomplete' });
  await writeFile(chunk(input), `${JSON.stringify(row)}\n`);
  assert.equal((await readQaNativeObservations({ ...input, final: true })).complete, true);
});

test('gaps, malformed named schemas and oversized lines fail without missing-evidence success', async t => {
  const input = await fixture(t);
  for (const value of [{ type: 'gap', count: 1 }, { type: 'lifecycle', event: 'native_observation_gap', payload: { stage: 'accepted-user', code: 'native_observation_unavailable' } }, { ...row, payload: { schema: 1, stage: 'invented' } },
    { ...row, payload: { ...row.payload, excessive: 'x'.repeat(256 * 1024) } }]) {
    await writeFile(chunk(input), `${JSON.stringify(value)}\n`);
    await assert.rejects(readQaNativeObservations(input));
  }
  await writeFile(chunk(input), '{broken}\n');
  await assert.rejects(readQaNativeObservations(input), { code: 'qa_native_journal_malformed' });
  await assert.rejects(readQaNativeObservations({ ...input, parseObservation: undefined }), { code: 'qa_native_observation_parser_required' });
});

test('journal symlinks and roots outside the selected runtime are refused', async t => {
  const input = await fixture(t);
  const outside = path.join(input.runtimeRoot, 'outside.ndjson');
  await writeFile(outside, `${JSON.stringify(row)}\n`);
  await symlink(outside, chunk(input));
  await assert.rejects(readQaNativeObservations(input), { code: 'qa_native_journal_path_invalid' });
  await assert.rejects(readQaNativeObservations({ ...input, runtimeRoot: path.join(input.journalDirectory, 'sessions') }), { code: 'qa_native_journal_path_invalid' });
});

test('final reads use the existing export owner then require exact selected journal health', async () => {
  const calls = [];
  const directory = '/fixture/harness/journal';
  const status = { enabled: true, directory, gapRecords: 0, lastError: null, queuedRecords: 0 };
  const input = { journalDirectory: directory, exportJournal: async () => calls.push('export'),
    readStatus: async () => { calls.push('status'); return status; } };
  assert.equal(await flushQaNativeObservationJournal(input), status);
  assert.deepEqual(calls, ['export', 'status']);
  for (const change of [{ directory: '/foreign' }, { gapRecords: 1 }, { queuedRecords: 1 }, { lastError: 'write failed' }, { enabled: false }]) {
    await assert.rejects(flushQaNativeObservationJournal({ ...input, readStatus: async () => ({ ...status, ...change }) }),
      { code: 'qa_native_journal_status_invalid' });
  }
  await assert.rejects(flushQaNativeObservationJournal({ ...input, exportJournal: async () => { throw new Error('export incomplete'); } }), /export incomplete/);
});

test('real existing journal sanitizer and export preserve finite native linkage through disk', async t => {
  const { createDiagnosticJournal } = await import('../../packages/harness-runtime/lib/journal.js');
  const { createDiagnosticSanitizer } = await import('../../packages/harness-runtime/lib/sanitizer.js');
  const { parseNativeJournalObservation } = await import('../../packages/shared-runtime/lib/native-observation.js');
  const { gradeQaNativeReasoningControls } = await import('./reasoning-controls-evidence.mjs');
  const { createHash } = await import('node:crypto');
  const input = await fixture(t), directory = path.join(input.runtimeRoot, 'project');
  await mkdir(directory);
  const sanitizer = createDiagnosticSanitizer({ homeDir: input.runtimeRoot, worktreeRoots: [directory] });
  const journal = createDiagnosticJournal({ directory: input.journalDirectory, sanitizer, runtime: 'qa-contract' });
  t.after(() => journal.close());
  const scope = { schema: 1, controllerInstanceID: 'controller_fixture', configurationDigest: 'a'.repeat(64), sessionID: 'ses_fixture', directory };
  const execution = { agent: 'orchestrator', providerID: 'openai', modelID: 'fixture-model', variant: 'high' };
  const attempt = { traceID: 'trace_fixture', spanID: 'span_fixture' };
  const payloads = [
    { ...scope, stage: 'accepted-user', messageID: 'msg_user', fingerprint: 'b'.repeat(64), intent: { source: 'prompt', variantPresent: true, variant: 'high' }, execution },
    { ...scope, stage: 'model-prepared', requestID: 'request_fixture', kind: 'primary', execution,
      options: { reasoning: { effort: 'high' } }, hookOptions: { reasoning: { effort: 'high' } }, modelLimits: { context: 100, input: null, output: 20 } },
    { ...scope, stage: 'physical', requestID: 'request_fixture', kind: 'primary', transport: 'ws', wireOptions: { reasoning: { effort: 'high' } }, ordinal: 1, attempt },
    { ...scope, stage: 'step-link', eventID: 'event_fixture', sequence: 12, created: 14, assistantMessageID: 'msg_assistant', userMessageID: 'msg_user', execution, attempt },
  ];
  for (const [index, payload] of payloads.entries()) journal.enqueue({ type: 'lifecycle', event: 'native_observation', at: 10 + index,
    sessionID: scope.sessionID, directory, payload });
  await journal.flush();
  const result = await readQaNativeObservations({ ...input, parseObservation: parseNativeJournalObservation, final: true });
  assert.equal(result.records.length, 4);
  const witness = `<WORKTREE_${createHash('sha256').update(directory).digest('hex').slice(0, 12)}>`;
  assert.equal(result.observations[0].directory, witness);
  assert.equal(result.records[0].directory, witness);
  assert.equal(JSON.stringify(result.records).includes(directory), false);
  const exported = sanitizer.sanitizeExportValue(result.records);
  assert.deepEqual(exported[1].payload.options, { reasoning: { effort: 'high' } });
  assert.equal(gradeQaNativeReasoningControls({ observations: result.observations, userMessageIDs: ['msg_user'], sessionID: scope.sessionID,
    directory, configurationDigest: scope.configurationDigest, ...execution, advertisedVariant: { reasoning: { effort: 'high' } } }).passed, true);
  assert.equal(gradeQaNativeReasoningControls({ observations: result.observations, userMessageIDs: ['msg_user'], sessionID: scope.sessionID,
    directory: '/foreign', configurationDigest: scope.configurationDigest, ...execution, advertisedVariant: { reasoning: { effort: 'high' } } }).passed, false);
  for (const change of [{ sessionID: 'ses_foreign' }, { directory: '<WORKTREE_bbbbbbbbbbbb>' }]) {
    await writeFile(chunk(input), `${JSON.stringify({ ...result.records[0], ...change })}\n`);
    await assert.rejects(readQaNativeObservations({ ...input, parseObservation: parseNativeJournalObservation, final: true }), { code: 'qa_native_observation_scope_invalid' });
  }
});
