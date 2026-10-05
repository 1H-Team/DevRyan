import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { createDiagnosticSanitizer } from '../../packages/harness-runtime/lib/sanitizer.js';

const fail = code => Object.assign(new Error(code), { code });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value);
const time = value => Number.isSafeInteger(value) && value > 0;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, file) => file.startsWith(root + path.sep);

// Exactly two spellings: the original `gaps --dir <root>` and the verified
// `--dir <root> gaps --verify`, which reads every chunk regardless of manifests.
const gapCommandForm = args => {
  if (!Array.isArray(args) || args[0] !== 'scripts/journal.mjs') return null;
  const form = args.length === 4 && args[1] === 'gaps' && args[2] === '--dir' ? { directory: args[3], verify: false }
    : args.length === 5 && args[1] === '--dir' && args[3] === 'gaps' && args[4] === '--verify' ? { directory: args[2], verify: true } : null;
  return form && typeof form.directory === 'string' && form.directory ? form : null;
};

/** Interpret an original command only through its recorded cwd. A relative
 * spelling is not evidence of a different journal, or of an assumed cwd. */
export async function assertQaGapCommand({ command, journalDirectory, repositoryRoot, logPath, logBytes }) {
  const form = gapCommandForm(command?.args);
  if (!record(command) || typeof command.cwd !== 'string' || !path.isAbsolute(command.cwd) || !form
    || command.code !== 0 || command.signal !== null || command.spawnError !== null
    || !Buffer.isBuffer(logBytes) || logBytes.length !== 0
    || !time(Date.parse(command.startedAt)) || !time(Date.parse(command.finishedAt))
    || Date.parse(command.finishedAt) < Date.parse(command.startedAt)) throw fail('qa_gap_command_invalid');
  const root = await realpath(repositoryRoot), cwd = await realpath(command.cwd);
  const expected = await realpath(journalDirectory);
  if (root !== path.resolve(repositoryRoot) || cwd !== path.resolve(command.cwd) || cwd !== root
    || !inside(root, expected) || expected !== path.resolve(journalDirectory)
    || await realpath(path.resolve(cwd, command.args[0])) !== path.join(root, 'scripts/journal.mjs')
    || await realpath(path.resolve(cwd, form.directory)) !== expected
    || typeof command.log !== 'string' || !path.isAbsolute(command.log)
    || await realpath(command.log) !== await realpath(logPath)
    || !inside(root, await realpath(logPath))) throw fail('qa_gap_directory_mismatch');
  return { directory: expected, cwd, code: 0, logBytes: 0, verify: form.verify };
}

/** The raw artifact and independent integrity record remain the authority.
 * Accept only the exact original sanitizer projection, never arbitrary text
 * that happens to look redacted. No raw artifact values are returned. */
export function assertQaSanitizedHash({ summary, field, bytes, pin, integrityHash }) {
  if (typeof field !== 'string' || !/^[a-zA-Z][a-zA-Z0-9]*Sha256$/.test(field)
    || !Buffer.isBuffer(bytes) || !record(pin) || !hash(pin.sha256)
    || pin.bytes !== bytes.length || digest(bytes) !== pin.sha256 || integrityHash !== pin.sha256) throw fail('qa_raw_hash_binding_invalid');
  const expected = createDiagnosticSanitizer().sanitizeExportValue({ [field]: pin.sha256 })[field];
  if (summary !== expected) throw fail('qa_hash_summary_invalid');
  return { field, sha256: pin.sha256, representation: expected === pin.sha256 ? 'exact-hash' : 'original-sanitizer-redacted' };
}

// Exact original journal.js recordLooksLikeError semantics, including gaps.
export function isQaJournalError(value) {
  if (value?.type === 'gap' || value?.level === 'error') return true;
  const eventType = value?.payload?.type;
  if (typeof eventType === 'string' && /(?:error|failed)$/.test(eventType)) return true;
  return Boolean(value?.payload?.properties?.error);
}

/** A scenario declaration is necessary but insufficient. Every disposition
 * joins original journal identities, actual Stop, canonical aborted completion,
 * idle, and a later completed turn within the original cell time bounds. */
export function classifyQaJournalErrors({ records, cancellation, window }) {
  if (!Array.isArray(records) || records.length > 100000 || records.some(row => !record(row))) throw fail('qa_journal_records_invalid');
  const errors = records.map((row, index) => ({ row, index })).filter(({ row }) => isQaJournalError(row));
  if (cancellation === undefined || cancellation === null) return { rawErrorCount: errors.length, expectedErrorCount: 0, unexpectedErrorCount: errors.length, expectedCancellationVerified: false, errors: errors.map(({ index }) => ({ index, classification: 'unexpected-journal-error' })) };
  const c = cancellation, s = c?.successfulTurn;
  if (!record(c) || c.kind !== 'user-stop' || !record(s) || !record(window)
    || ![c.sessionID, c.assistantID, c.userMessageID, s.sessionID, s.assistantID, s.userMessageID].every(id)
    || s.sessionID !== c.sessionID || s.userMessageID === c.userMessageID || s.assistantID === c.assistantID
    || ![window.startedAt, window.finishedAt, c.requestedAt, c.settledAt, s.completedAt].every(time)
    || !(window.startedAt <= c.requestedAt && c.requestedAt <= c.settledAt && c.settledAt < s.completedAt && s.completedAt <= window.finishedAt)) throw fail('qa_cancellation_declaration_invalid');
  const bounded = row => time(row.at) && row.at >= window.startedAt && row.at <= window.finishedAt;
  const same = row => bounded(row) && row.sessionID === c.sessionID;
  const during = row => same(row) && row.at >= c.requestedAt && row.at <= c.settledAt;
  const event = (row, type) => row.type === 'open_code_event' && row.payload?.type === type && row.payload.properties?.sessionID === c.sessionID;
  const messages = records.filter(row => same(row) && event(row, 'message.updated'));
  const info = row => row.payload.properties.info;
  const user = (messageID, after, before) => messages.some(row => info(row)?.role === 'user' && info(row).id === messageID
    && info(row).sessionID === c.sessionID && time(info(row).time?.created) && info(row).time.created >= after && info(row).time.created <= before);
  const aborted = messages.filter(row => during(row) && info(row)?.role === 'assistant' && info(row).id === c.assistantID
    && info(row).sessionID === c.sessionID && info(row).parentID === c.userMessageID
    && info(row).error?.name === 'MessageAbortedError' && time(info(row).time?.completed)
    && info(row).time.completed >= c.requestedAt && info(row).time.completed <= c.settledAt);
  const stops = records.filter(row => during(row) && row.type === 'control' && row.action === 'abort' && row.payload?.source === 'stop_button');
  const turns = records.filter(row => during(row) && row.type === 'lifecycle' && row.payload?.type === 'turn_aborted'
    && row.payload.sessionID === c.sessionID && row.payload.userMessageID === c.userMessageID && row.payload.turnID === c.userMessageID
    && row.payload.assistantMessageID === c.assistantID && row.payload.outcome === 'aborted');
  const candidates = errors.filter(({ row }) => {
    const error = row.payload?.properties?.error;
    return during(row) && row.level !== 'error' && event(row, 'session.error') && record(error) && record(error.data)
      && Object.keys(error).every(key => ['name', 'data'].includes(key))
      && Object.keys(error.data).every(key => ['reason', 'message'].includes(key))
      && error.name === 'MessageAbortedError' && error.data.reason === 'user';
  });
  if (candidates.length !== 1 || !user(c.userMessageID, window.startedAt, c.requestedAt) || !aborted.length
    || !stops.length || !turns.length) throw fail('qa_cancellation_journal_binding_invalid');
  const error = candidates[0];
  if (!stops.some(stop => turns.some(turn => stop.at <= turn.at && turn.at <= error.row.at)
      && aborted.some(row => info(row).time.completed >= stop.at && info(row).time.completed <= error.row.at))
    || !records.some(row => during(row) && row.at >= error.row.at && event(row, 'session.status') && row.payload.properties.status?.type === 'idle')
    || !user(s.userMessageID, c.settledAt + 1, s.completedAt)
    || !messages.some(row => row.at >= s.completedAt && info(row)?.role === 'assistant' && info(row).id === s.assistantID
      && info(row).sessionID === c.sessionID && info(row).parentID === s.userMessageID && !info(row).error
      && info(row).time?.completed === s.completedAt)
    || !records.some(row => same(row) && row.at >= s.completedAt && row.type === 'lifecycle' && row.payload?.type === 'turn_completed'
      && row.payload.sessionID === c.sessionID && row.payload.userMessageID === s.userMessageID && row.payload.turnID === s.userMessageID
      && row.payload.assistantMessageID === s.assistantID && row.payload.outcome === 'completed')) throw fail('qa_cancellation_journal_binding_invalid');
  return { rawErrorCount: errors.length, expectedErrorCount: 1, unexpectedErrorCount: errors.length - 1, expectedCancellationVerified: true,
    errors: errors.map(({ index }) => ({ index, classification: index === error.index ? 'scenario-user-stop' : 'unexpected-journal-error' })) };
}
