import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { collectJournalPaths, readRecordsFromPaths } from '../journal.mjs';
import { assertQaGapCommand } from '../qa/final-evidence-rules.mjs';

export const COMPILED_DURABLE_JOURNAL_CASE = 'compiled-durable-journal-roots';
export const COMPILED_JOURNAL_ROOTS = 3;
const defaultRepositoryRoot = path.resolve(import.meta.dirname, '../..');
const LOG_LIMIT = 4 * 1024 * 1024;

/** The original CLI, recorded exactly as assertQaGapCommand later reads it. */
export async function runVerifiedGapCommand({ repositoryRoot, journalDirectory, logPath, timeoutMs = 120_000 }) {
  const args = ['scripts/journal.mjs', '--dir', journalDirectory, 'gaps', '--verify'];
  const startedAt = new Date().toISOString(), chunks = [];
  let bytes = 0, spawnError = null;
  const exit = await new Promise(resolve => {
    const child = spawn(process.execPath, args, { cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const collect = chunk => { bytes += chunk.length; if (bytes <= LOG_LIMIT) chunks.push(chunk); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('error', error => { spawnError = error.code ?? 'spawn_failed'; });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  const output = Buffer.concat(chunks);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.writeFile(logPath, output);
  return { command: { cwd: repositoryRoot, executable: process.execPath, args, code: exit.code, signal: exit.signal, spawnError,
    log: logPath, startedAt, finishedAt: new Date().toISOString() }, output, truncated: bytes > LOG_LIMIT };
}

const representedCount = record => Number.isSafeInteger(record?.coalesced) && record.coalesced > 0 ? record.coalesced : 1;

/** Each writer has a distinct runtime label. Sealed writers (`tees`, and
 * `inherited` copies of another root) must match exactly. A writer killed
 * after `flush` (`crashed`) is a lower bound: what it flushed must survive. */
export function reconcileJournalTees({ labelCounts, tees = [], inherited = [], crashed = [] }) {
  const reasons = new Set(), expected = new Map(), writers = [];
  const add = (summary, mode) => {
    if (!summary || typeof summary !== 'object' || typeof summary.label !== 'string' || !summary.accepted
      || typeof summary.accepted !== 'object') { reasons.add('journal_tee_invalid'); return; }
    writers.push({ label: summary.label, mode, rejectedBeforeDrain: summary.rejectedBeforeDrain, drained: summary.drained });
    if (summary.rejectedBeforeDrain !== 0) reasons.add('journal_tee_rejected');
    if (mode !== 'crashed' && summary.drained !== true) reasons.add('journal_tee_undrained');
    for (const [label, count] of Object.entries(summary.accepted)) {
      if (!Number.isSafeInteger(count) || count < 0) { reasons.add('journal_tee_invalid'); continue; }
      if (expected.has(label)) reasons.add('journal_tee_label_duplicate');
      expected.set(label, { count, exact: mode !== 'crashed' });
    }
  };
  for (const summary of tees) add(summary, 'sealed');
  for (const summary of inherited) add(summary, 'inherited');
  for (const summary of crashed) add(summary, 'crashed');
  if (!writers.length) reasons.add('journal_tee_missing');
  const labels = [];
  for (const label of new Set([...expected.keys(), ...Object.keys(labelCounts)])) {
    const found = labelCounts[label] ?? 0, want = expected.get(label);
    const reconciled = want !== undefined && (want.exact ? found === want.count : found >= want.count);
    if (!reconciled) reasons.add('journal_tee_unreconciled');
    labels.push({ label, journal: found, accepted: want?.count ?? null, mode: want ? (want.exact ? 'exact' : 'lower-bound') : 'unknown', reconciled });
  }
  return { reasons: [...reasons], writers, labels: labels.sort((left, right) => left.label.localeCompare(right.label)) };
}

/** Missing or empty roots are unavailable, never passed. A present root
 * passes only with sealed chunks, enough required records, an empty verified
 * gap run through the original CLI, and every record reconciled to a tee. */
export async function gradeJournalRoot({ id, journalDirectory, logPath, repositoryRoot = defaultRepositoryRoot,
  tees = [], inherited = [], crashed = [], minimumRecords = 1, requiredTypes = ['lifecycle'], requiredEvents = [] }) {
  const base = { id, journalDirectory };
  const stat = await fs.stat(journalDirectory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!stat?.isDirectory()) return { ...base, status: 'unavailable', reasons: ['journal_root_missing'] };
  const paths = await collectJournalPaths(journalDirectory);
  if (!paths.length) return { ...base, status: 'unavailable', reasons: ['journal_root_empty'] };
  const reasons = new Set();
  const openChunks = paths.filter(file => file.endsWith('.open')).map(file => path.relative(journalDirectory, file));
  if (openChunks.length) reasons.add('journal_open_chunks');
  const recordCounts = {}, eventCounts = {}, labelCounts = {};
  let records = 0;
  for await (const row of readRecordsFromPaths(paths)) {
    records += 1;
    const type = typeof row?.type === 'string' ? row.type : 'unknown';
    recordCounts[type] = (recordCounts[type] ?? 0) + 1;
    if (typeof row?.event === 'string') eventCounts[row.event] = (eventCounts[row.event] ?? 0) + 1;
    const label = typeof row?.runtime === 'string' ? row.runtime : '(unlabeled)';
    labelCounts[label] = (labelCounts[label] ?? 0) + representedCount(row);
  }
  if (records < minimumRecords) reasons.add('journal_records_below_minimum');
  const missingTypes = requiredTypes.filter(type => !recordCounts[type]);
  const missingEvents = requiredEvents.filter(event => !eventCounts[event]);
  if (missingTypes.length) reasons.add('journal_record_type_missing');
  if (missingEvents.length) reasons.add('journal_record_event_missing');
  const gaps = await runVerifiedGapCommand({ repositoryRoot, journalDirectory, logPath });
  const gapRecords = gaps.output.toString('utf8').split('\n').filter(Boolean);
  const gapReasons = {};
  for (const line of gapRecords) {
    let reason = 'unparsed';
    try { reason = String(JSON.parse(line)?.reason ?? 'unknown'); } catch { /* counted as unparsed */ }
    gapReasons[reason] = (gapReasons[reason] ?? 0) + 1;
  }
  if (gaps.command.code !== 0 || gaps.command.signal !== null || gaps.command.spawnError !== null) reasons.add('journal_gap_command_failed');
  else if (gapRecords.length || gaps.truncated) reasons.add('journal_gaps_present');
  else {
    try {
      await assertQaGapCommand({ command: gaps.command, journalDirectory, repositoryRoot, logPath, logBytes: await fs.readFile(logPath) });
    } catch (error) { reasons.add(typeof error?.code === 'string' ? error.code : 'journal_gap_command_invalid'); }
  }
  const tee = reconcileJournalTees({ labelCounts, tees, inherited, crashed });
  for (const reason of tee.reasons) reasons.add(reason);
  // Sealed and crashed writers wrote this root; inherited ones wrote the clone source.
  if ([...tees, ...crashed].some(summary => summary?.journalDirectory !== journalDirectory)) reasons.add('journal_tee_root_mismatch');
  return { ...base, status: reasons.size ? 'failed' : 'passed', reasons: [...reasons], chunks: paths.length, openChunks,
    records, recordCounts, eventCounts, minimumRecords, missingTypes, missingEvents,
    gapCommand: { ...gaps.command, gapRecords: gapRecords.length, gapReasons }, tee };
}

/** One case over every descriptor-owned compiled root; it passes only at 3/3. */
export function compiledDurableJournalCase(roots, required = COMPILED_JOURNAL_ROOTS) {
  const passed = roots.filter(root => root?.status === 'passed').length;
  const unavailable = roots.filter(root => root?.status === 'unavailable').length;
  return { id: COMPILED_DURABLE_JOURNAL_CASE, status: roots.length === required && passed === required ? 'passed' : 'failed',
    required, checked: roots.length, passed, unavailable, roots,
    source: 'production-web-harness-journal-on-descriptor-web-data-verified-gaps-and-tee-reconciliation' };
}
