import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFixtureJournal } from './fixture-journal.mjs';
import { gradeJournalRoot, compiledDurableJournalCase, reconcileJournalTees, COMPILED_DURABLE_JOURNAL_CASE } from './journal-evidence.mjs';

// A disposable repository holding the original CLI, so the recorded-cwd gap
// command and its journal/log identities stay inside one owned root.
const withRepository = async action => {
  const repositoryRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-journal-evidence-')));
  try {
    await fs.mkdir(path.join(repositoryRoot, 'scripts'));
    await fs.copyFile(path.resolve(import.meta.dirname, '../journal.mjs'), path.join(repositoryRoot, 'scripts/journal.mjs'));
    return await action(repositoryRoot);
  } finally { await fs.rm(repositoryRoot, { recursive: true, force: true }); }
};
const writer = (repositoryRoot, name, label = `fixture-${name}`) =>
  createFixtureJournal({ webDataDirectory: path.join(repositoryRoot, 'roots', name, 'web-data'), label });
const lifecycle = (event, sessionID = 'ses_fixture') => ({ type: 'lifecycle', event, sessionID, payload: { phase: 'fixture' } });
const grade = (repositoryRoot, journal, extra = {}) => gradeJournalRoot({ id: journal.label, journalDirectory: journal.journalDirectory,
  logPath: path.join(repositoryRoot, 'logs', `${journal.label}.gaps.log`), repositoryRoot, tees: [journal.summary()], ...extra });

test('a sealed, gap-free root whose records reconcile to its tee passes through the original verified gap CLI', () => withRepository(async repositoryRoot => {
  const journal = await writer(repositoryRoot, 'sealed');
  journal.ownerDiagnostic(lifecycle('fixture_observation'));
  journal.sessionExecution({ event: 'session_execution', sessionID: 'ses_fixture', phase: 'finish' });
  journal.ownerDiagnostic(lifecycle('fixture_observation', 'ses_other'));
  await journal.drain();
  const result = await grade(repositoryRoot, journal, { requiredEvents: ['fixture_observation'] });
  assert.equal(result.status, 'passed', JSON.stringify(result.reasons));
  assert.deepEqual(result.reasons, []);
  assert.equal(result.records, 3); assert.deepEqual(result.recordCounts, { lifecycle: 3 });
  assert.deepEqual(result.gapCommand.args, ['scripts/journal.mjs', '--dir', journal.journalDirectory, 'gaps', '--verify']);
  assert.equal(result.gapCommand.cwd, repositoryRoot); assert.equal(result.gapCommand.code, 0); assert.equal(result.gapCommand.gapRecords, 0);
  assert.deepEqual(await fs.readFile(result.gapCommand.log), Buffer.alloc(0));
  assert.deepEqual(result.tee.labels, [{ label: 'fixture-sealed', journal: 3, accepted: 3, mode: 'exact', reconciled: true }]);
}));

test('a missing root and an initialized root without chunks are unavailable, never passed', () => withRepository(async repositoryRoot => {
  const missing = await gradeJournalRoot({ id: 'missing', journalDirectory: path.join(repositoryRoot, 'roots/absent/web-data/harness/journal'),
    logPath: path.join(repositoryRoot, 'logs/missing.log'), repositoryRoot, tees: [] });
  assert.deepEqual([missing.status, missing.reasons], ['unavailable', ['journal_root_missing']]);
  const journal = await writer(repositoryRoot, 'empty');
  await journal.drain();
  assert.ok((await fs.readdir(journal.journalDirectory)).includes('README.md'), 'Metadata alone is not durable coverage');
  const empty = await grade(repositoryRoot, journal);
  assert.deepEqual([empty.status, empty.reasons], ['unavailable', ['journal_root_empty']]);
  assert.equal(empty.gapCommand, undefined, 'No empty-directory gap command is manufactured into coverage');
}));

test('an unsealed active chunk fails until the owner recovery seals it', () => withRepository(async repositoryRoot => {
  const journal = await writer(repositoryRoot, 'open');
  journal.ownerDiagnostic(lifecycle('fixture_observation'));
  await journal.flush();
  const open = await grade(repositoryRoot, journal);
  assert.equal(open.status, 'failed'); assert.deepEqual(open.reasons, ['journal_open_chunks', 'journal_tee_undrained']);
  assert.equal(open.openChunks.length, 1); assert.match(open.openChunks[0], /\.ndjson\.open$/);
  const flushed = journal.summary();
  // Recovery is the original journal initialization on the same root.
  const recovery = await createFixtureJournal({ webDataDirectory: path.dirname(path.dirname(journal.journalDirectory)), label: 'fixture-recovery' });
  await recovery.drain();
  const sealed = await grade(repositoryRoot, journal, { tees: [recovery.summary()], crashed: [flushed] });
  assert.equal(sealed.status, 'passed', JSON.stringify(sealed.reasons));
  await journal.drain();
}));

test('a journal gap is reported from the verified CLI and fails the root', () => withRepository(async repositoryRoot => {
  const journal = await writer(repositoryRoot, 'gap');
  journal.ownerDiagnostic(lifecycle('fixture_observation'));
  // The original sanitizer refuses this type; the journal records a gap instead.
  journal.ownerDiagnostic({ type: 'unsupported_fixture_type', sessionID: 'ses_fixture' });
  await journal.drain();
  const result = await grade(repositoryRoot, journal);
  assert.equal(result.status, 'failed'); assert.deepEqual(result.reasons, ['journal_gaps_present']);
  assert.equal(result.gapCommand.gapRecords, 1); assert.deepEqual(result.gapCommand.gapReasons, { sanitization_failed: 1 });
  assert.equal(result.recordCounts.gap, 1);
}));

test('tee mismatches, unknown writers, rejected or undrained tees and missing types fail reconciliation', () => withRepository(async repositoryRoot => {
  const journal = await writer(repositoryRoot, 'tee');
  journal.ownerDiagnostic(lifecycle('fixture_observation'));
  journal.ownerDiagnostic(lifecycle('fixture_observation'));
  await journal.drain();
  const summary = journal.summary();
  const overCounted = await grade(repositoryRoot, journal, { tees: [{ ...summary, accepted: { [summary.label]: 3 } }] });
  assert.deepEqual([overCounted.status, overCounted.reasons], ['failed', ['journal_tee_unreconciled']]);
  const unknown = await grade(repositoryRoot, journal, { tees: [{ ...summary, label: 'fixture-other', accepted: { 'fixture-other': 2 } }] });
  assert.deepEqual(unknown.reasons, ['journal_tee_unreconciled']);
  assert.deepEqual(unknown.tee.labels.map(row => [row.label, row.mode, row.reconciled]),
    [['fixture-other', 'exact', false], ['fixture-tee', 'unknown', false]]);
  assert.deepEqual((await grade(repositoryRoot, journal, { tees: [] })).reasons, ['journal_tee_missing', 'journal_tee_unreconciled']);
  assert.deepEqual((await grade(repositoryRoot, journal, { tees: [{ ...summary, rejectedBeforeDrain: 1 }] })).reasons, ['journal_tee_rejected']);
  assert.deepEqual((await grade(repositoryRoot, journal, { tees: [{ ...summary, drained: false }] })).reasons, ['journal_tee_undrained']);
  assert.deepEqual((await grade(repositoryRoot, journal, { requiredTypes: ['lifecycle', 'control'], minimumRecords: 3 })).reasons,
    ['journal_records_below_minimum', 'journal_record_type_missing']);
  assert.deepEqual((await grade(repositoryRoot, journal, { requiredEvents: ['session_execution'] })).missingEvents, ['session_execution']);
}));

test('an inherited clone copy must match its source writer exactly while a crashed writer is a flushed lower bound', () => {
  const sealed = { label: 'fixture-main', accepted: { 'fixture-main': 4 }, rejectedBeforeDrain: 0, rejectedAfterDrain: 2, drained: true };
  const copied = { label: 'fixture-seed', accepted: { 'fixture-seed': 2 }, rejectedBeforeDrain: 0, rejectedAfterDrain: 0, drained: true };
  const crashed = { label: 'fixture-pd', accepted: { 'fixture-pd': 5 }, rejectedBeforeDrain: 0, rejectedAfterDrain: 0, drained: false };
  const reconcile = labelCounts => reconcileJournalTees({ labelCounts, tees: [sealed], inherited: [copied], crashed: [crashed] }).reasons;
  assert.deepEqual(reconcile({ 'fixture-main': 4, 'fixture-seed': 2, 'fixture-pd': 7 }), []);
  assert.deepEqual(reconcile({ 'fixture-main': 4, 'fixture-seed': 1, 'fixture-pd': 7 }), ['journal_tee_unreconciled']);
  assert.deepEqual(reconcile({ 'fixture-main': 4, 'fixture-seed': 2, 'fixture-pd': 4 }), ['journal_tee_unreconciled']);
  assert.deepEqual(reconcileJournalTees({ labelCounts: { 'fixture-seed': 2 }, tees: [{ ...copied }], inherited: [copied] }).reasons, ['journal_tee_label_duplicate']);
  assert.deepEqual(reconcileJournalTees({ labelCounts: {}, tees: [{ label: 'fixture-x' }] }).reasons, ['journal_tee_invalid', 'journal_tee_missing']);
});

test('the compiled durable journal case passes only when all three descriptor roots pass', () => {
  const passed = { status: 'passed' }, unavailable = { status: 'unavailable' };
  const all = compiledDurableJournalCase([passed, passed, passed]);
  assert.deepEqual([all.id, all.status, all.passed, all.required], [COMPILED_DURABLE_JOURNAL_CASE, 'passed', 3, 3]);
  const two = compiledDurableJournalCase([passed, passed, unavailable]);
  assert.deepEqual([two.status, two.passed, two.unavailable], ['failed', 2, 1]);
  assert.equal(compiledDurableJournalCase([passed, passed]).status, 'failed');
  assert.equal(compiledDurableJournalCase([passed, passed, passed, passed]).status, 'failed');
  assert.equal(compiledDurableJournalCase([unavailable, unavailable, unavailable]).status, 'failed');
});
