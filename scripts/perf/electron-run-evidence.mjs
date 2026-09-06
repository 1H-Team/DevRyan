import { stat } from 'node:fs/promises';
import { createDiagnosticSanitizer } from '../../packages/harness-runtime/lib/sanitizer.js';
import { collectJournalPaths, listJournalRows, readRecordsFromPaths } from '../journal.mjs';

const MAX_ERRORS = 100;
const MAX_ERROR_BYTES = 256 * 1024;
const MAX_ERROR_TEXT = 4096;

export function assertPerfCleanupComplete(cleanup, workloadError) {
  if (cleanup.complete) return;
  throw new AggregateError([...(workloadError ? [workloadError] : []), ...cleanup.errors.map(message => new Error(message))],
    'Performance run cleanup failed; see run-evidence.json');
}

// Listeners are installed before Runtime/Log.enable, which can deliver buffered
// startup errors. Resource-load failures remain evidence for explicit review.
export function observePerfBrowserErrors(cdp, { runDirectory, repositoryRoot }) {
  const sanitizer = createDiagnosticSanitizer({ homeDir: process.env.HOME,
    pathMappings: [{ path: runDirectory, placeholder: '<PERF_RUN>' }, { path: repositoryRoot, placeholder: '<REPOSITORY>' }] });
  const evidence = { scope: 'owned page from CDP attachment through pre-shutdown collection',
    entries: [], seen: 0, dropped: 0, textTruncated: 0, bytes: 0,
    maximumEntries: MAX_ERRORS, maximumBytes: MAX_ERROR_BYTES, review: 'required' };
  const capture = (kind, text, timestamp, url) => {
    evidence.seen += 1;
    const full = sanitizer.sanitizeText(String(text ?? '(no error description)'));
    const message = full.slice(0, MAX_ERROR_TEXT);
    if (message.length < full.length) evidence.textTruncated += 1;
    const entry = { kind, message, timestamp: Number.isFinite(timestamp) ? timestamp : null,
      url: typeof url === 'string' ? sanitizer.sanitizeText(url).slice(0, MAX_ERROR_TEXT) : null };
    const bytes = Buffer.byteLength(JSON.stringify(entry));
    if (evidence.entries.length >= MAX_ERRORS || evidence.bytes + bytes > MAX_ERROR_BYTES) { evidence.dropped += 1; return; }
    evidence.entries.push(entry); evidence.bytes += bytes;
  };
  const removers = [
    cdp.on('Runtime.exceptionThrown', event => capture('exception',
      event.exceptionDetails?.exception?.description ?? event.exceptionDetails?.text, event.timestamp, event.exceptionDetails?.url)),
    cdp.on('Runtime.consoleAPICalled', event => {
      if (event.type === 'error') capture('console.error', (event.args ?? []).map(arg => arg.value ?? arg.description ?? '').join(' '), event.timestamp);
    }),
    cdp.on('Log.entryAdded', ({ entry }) => {
      if (entry?.level === 'error') capture(`log.${entry.source ?? 'unknown'}`, entry.text, entry.timestamp, entry.url);
    }),
  ];
  return { evidence, complete: () => { removers.forEach(remove => remove()); return evidence; } };
}

// Read the preserved, sanitized journal only after the owned host has exited and
// drained it. Bound the retained details independently of the streamed records.
export async function capturePerfJournal(journalDirectory) {
  await stat(journalDirectory);
  const rows = await listJournalRows(journalDirectory);
  const paths = await collectJournalPaths(journalDirectory);
  const result = { path: journalDirectory, available: true, complete: true, rows, chunks: paths.length,
    records: 0, gapRecords: 0, gaps: [], errorRecords: 0, errors: [], maximumRecords: 100_000 };
  let bytes = 0;
  for await (const record of readRecordsFromPaths(paths)) {
    bytes += Buffer.byteLength(JSON.stringify(record));
    if (result.records >= result.maximumRecords || bytes > 256 * 1024 * 1024) { result.complete = false; result.limitReached = true; break; }
    result.records += 1;
    if (record.type === 'gap') {
      result.gapRecords += 1;
      if (result.gaps.length < 50) result.gaps.push({ at: record.at, sessionID: record.sessionID ?? null,
        reason: record.reason, count: record.count, source: record.source });
    }
    if (record.type === 'log' && record.level === 'error') {
      result.errorRecords += 1;
      if (result.errors.length < 50) result.errors.push({ at: record.at, sessionID: record.sessionID ?? null,
        source: record.source, message: String(record.message ?? '').slice(0, MAX_ERROR_TEXT) });
    }
  }
  result.uncompressedBytesScanned = bytes;
  return result;
}
