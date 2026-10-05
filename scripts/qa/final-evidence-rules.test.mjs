import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createDiagnosticSanitizer } from '../../packages/harness-runtime/lib/sanitizer.js';
import { assertQaGapCommand, assertQaSanitizedHash, classifyQaJournalErrors } from './final-evidence-rules.mjs';

const root = path.resolve(import.meta.dirname, '../..');
test('gap evidence resolves relative and absolute journal spelling only from the recorded repository cwd', async () => {
  const fixture = await fs.mkdtemp(path.join(root, '.cache/v2-validation/evidence-rules-'));
  try {
    const journalDirectory = path.join(fixture, 'journal'), logPath = path.join(fixture, 'gap.log');
    await fs.mkdir(journalDirectory); await fs.writeFile(logPath, '');
    const command = { cwd: root, args: ['scripts/journal.mjs', 'gaps', '--dir', journalDirectory], code: 0, signal: null, spawnError: null,
      log: logPath, startedAt: '2026-10-04T10:00:00Z', finishedAt: '2026-10-04T10:00:01Z' };
    const check = value => assertQaGapCommand({ command: value, journalDirectory, repositoryRoot: root, logPath, logBytes: Buffer.alloc(0) });
    assert.equal((await check(command)).directory, journalDirectory);
    assert.equal((await check({ ...command, args: [...command.args.slice(0, 3), path.relative(root, journalDirectory)] })).directory, journalDirectory);
    await assert.rejects(check({ ...command, cwd: undefined }), { code: 'qa_gap_command_invalid' });
    await assert.rejects(check({ ...command, cwd: fixture }), { code: 'qa_gap_directory_mismatch' });
    await assert.rejects(check({ ...command, args: [...command.args, '--extra'] }), { code: 'qa_gap_command_invalid' });
    const foreign = path.join(fixture, 'different'); await fs.mkdir(foreign);
    await assert.rejects(check({ ...command, args: [...command.args.slice(0, 3), foreign] }), { code: 'qa_gap_directory_mismatch' });
    await assert.rejects(check({ ...command, code: 1 }), { code: 'qa_gap_command_invalid' });
  } finally { await fs.rm(fixture, { recursive: true, force: true }); }
});

test('verified gap evidence accepts only the exact --dir <root> gaps --verify spelling from the recorded repository cwd', async () => {
  const fixture = await fs.mkdtemp(path.join(root, '.cache/v2-validation/evidence-rules-'));
  try {
    const journalDirectory = path.join(fixture, 'journal'), logPath = path.join(fixture, 'gap.log');
    await fs.mkdir(journalDirectory); await fs.writeFile(logPath, '');
    const command = { cwd: root, args: ['scripts/journal.mjs', '--dir', journalDirectory, 'gaps', '--verify'], code: 0, signal: null, spawnError: null,
      log: logPath, startedAt: '2026-10-05T10:00:00Z', finishedAt: '2026-10-05T10:00:01Z' };
    const check = value => assertQaGapCommand({ command: value, journalDirectory, repositoryRoot: root, logPath, logBytes: Buffer.alloc(0) });
    assert.deepEqual(await check(command), { directory: journalDirectory, cwd: root, code: 0, logBytes: 0, verify: true });
    const relative = ['scripts/journal.mjs', '--dir', path.relative(root, journalDirectory), 'gaps', '--verify'];
    assert.equal((await check({ ...command, args: relative })).verify, true);
    assert.equal((await check({ ...command, args: ['scripts/journal.mjs', 'gaps', '--dir', journalDirectory] })).verify, false);
    for (const args of [[...command.args, '--extra'], ['scripts/journal.mjs', 'gaps', '--dir', journalDirectory, '--verify'],
      ['scripts/journal.mjs', '--dir', journalDirectory, 'gaps', '--verified'], ['scripts/journal.mjs', '--verify', journalDirectory, 'gaps', '--dir'],
      ['scripts/journal.mjs', '--dir', '', 'gaps', '--verify']]) {
      await assert.rejects(check({ ...command, args }), { code: 'qa_gap_command_invalid' });
    }
    const foreign = path.join(fixture, 'different'); await fs.mkdir(foreign);
    await assert.rejects(check({ ...command, args: ['scripts/journal.mjs', '--dir', foreign, 'gaps', '--verify'] }), { code: 'qa_gap_directory_mismatch' });
    await assert.rejects(assertQaGapCommand({ command, journalDirectory, repositoryRoot: root, logPath, logBytes: Buffer.from('{"type":"gap"}\n') }),
      { code: 'qa_gap_command_invalid' });
  } finally { await fs.rm(fixture, { recursive: true, force: true }); }
});

test('hash summary authority remains exact pinned raw bytes and original sanitizer, including normally redacted hashes', () => {
  const bytes = Buffer.from('original noncredential artifact'), sha256 = createHash('sha256').update(bytes).digest('hex');
  const input = { field: 'seedManifestSha256', bytes, pin: { bytes: bytes.length, sha256 }, integrityHash: sha256 };
  const summary = createDiagnosticSanitizer().sanitizeExportValue({ seedManifestSha256: sha256 }).seedManifestSha256;
  assert.equal(assertQaSanitizedHash({ ...input, summary }).sha256, sha256);
  for (const change of [{ summary: '[REDACTED]' }, { summary: 'other' }, { bytes: Buffer.from('mutated') }, { integrityHash: 'a'.repeat(64) }, { pin: { sha256, bytes: 0 } }]) {
    assert.throws(() => assertQaSanitizedHash({ ...input, summary, ...change }));
  }
});

function cancellationFixture() {
  const sessionID = 'ses_owned', assistantID = 'msg_aborted', userMessageID = 'msg_request';
  const event = (at, type, properties) => ({ type: 'open_code_event', at, sessionID, payload: { type, properties: { sessionID, ...properties } } });
  const message = (at, info) => event(at, 'message.updated', { info: { sessionID, ...info } });
  const lifecycle = (at, type, user, assistant, outcome) => ({ type: 'lifecycle', at, sessionID,
    payload: { type, sessionID, turnID: user, userMessageID: user, assistantMessageID: assistant, outcome } });
  const records = [
    message(1000, { id: userMessageID, role: 'user', time: { created: 1000 } }),
    { type: 'control', action: 'abort', at: 1200, sessionID, payload: { source: 'stop_button' } },
    lifecycle(1300, 'turn_aborted', userMessageID, assistantID, 'aborted'),
    message(1301, { id: assistantID, role: 'assistant', parentID: userMessageID, time: { created: 1050, completed: 1290 }, error: { name: 'MessageAbortedError', data: { message: 'Step interrupted' } } }),
    event(1302, 'session.error', { error: { name: 'MessageAbortedError', data: { reason: 'user', message: 'Aborted' } } }),
    event(1303, 'session.status', { status: { type: 'idle' } }),
    message(1500, { id: 'msg_after_user', role: 'user', time: { created: 1500 } }),
    message(1801, { id: 'msg_after_assistant', role: 'assistant', parentID: 'msg_after_user', time: { created: 1550, completed: 1800 } }),
    lifecycle(1802, 'turn_completed', 'msg_after_user', 'msg_after_assistant', 'completed'),
  ];
  return { records, window: { startedAt: 900, finishedAt: 2000 }, cancellation: { kind: 'user-stop', sessionID, assistantID, userMessageID,
    requestedAt: 1100, settledAt: 1400, successfulTurn: { sessionID, userMessageID: 'msg_after_user', assistantID: 'msg_after_assistant', completedAt: 1800 } } };
}
test('expected cancellation requires scenario declaration and original Stop, exact canonical IDs, idle and subsequent success', () => {
  const input = cancellationFixture(), result = classifyQaJournalErrors(input);
  assert.deepEqual([result.rawErrorCount, result.expectedErrorCount, result.unexpectedErrorCount], [1, 1, 0]);
  assert.equal(result.expectedCancellationVerified, true);
  assert.equal(classifyQaJournalErrors({ records: input.records }).unexpectedErrorCount, 1, 'Historical undeclared cancellation remains an error');
  for (const index of [1, 2, 3, 4, 5, 6, 7, 8]) {
    assert.throws(() => classifyQaJournalErrors({ ...input, records: input.records.filter((_, i) => i !== index) }), { code: 'qa_cancellation_journal_binding_invalid' });
  }
});
test('foreign/stale IDs, wrong abort cause, missing bounded window and incomplete subsequent turns cannot explain an error', () => {
  const input = cancellationFixture();
  for (const change of [{ sessionID: 'foreign' }, { assistantID: 'foreign' }, { userMessageID: 'foreign' }, { requestedAt: 1350 }, { settledAt: 1300 },
    { successfulTurn: { ...input.cancellation.successfulTurn, assistantID: 'foreign' } }]) {
    assert.throws(() => classifyQaJournalErrors({ ...input, cancellation: { ...input.cancellation, ...change } }));
  }
  assert.throws(() => classifyQaJournalErrors({ ...input, window: undefined }), { code: 'qa_cancellation_declaration_invalid' });
  const rows = structuredClone(input.records); rows[4].payload.properties.error.data.reason = 'provider';
  assert.throws(() => classifyQaJournalErrors({ ...input, records: rows }), { code: 'qa_cancellation_journal_binding_invalid' });
  const detailError = structuredClone(input.records); detailError[4].payload.properties.error.data.errorLogUUID = 'unknown-detail';
  assert.throws(() => classifyQaJournalErrors({ ...input, records: detailError }), { code: 'qa_cancellation_journal_binding_invalid' });
  const duplicate = [...input.records, structuredClone(input.records[4])];
  assert.throws(() => classifyQaJournalErrors({ ...input, records: duplicate }), { code: 'qa_cancellation_journal_binding_invalid' });
});
test('provider failures, gaps, level errors and other-session errors remain unexpected alongside a verified Stop', () => {
  const input = cancellationFixture();
  const additional = [{ type: 'gap', at: 1500 }, { type: 'diagnostic', level: 'error', at: 1600 },
    { type: 'open_code_event', at: 1700, sessionID: 'foreign', payload: { type: 'session.error', properties: { sessionID: 'foreign', error: { name: 'ProviderError' } } } },
    { type: 'lifecycle', at: 1750, payload: { type: 'worker_failed' } }];
  const result = classifyQaJournalErrors({ ...input, records: [...input.records, ...additional] });
  assert.deepEqual([result.rawErrorCount, result.expectedErrorCount, result.unexpectedErrorCount], [5, 1, 4]);
});
