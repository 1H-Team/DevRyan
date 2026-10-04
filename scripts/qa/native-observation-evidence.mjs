import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { collectJournalPaths } from '../journal.mjs';

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_RECORDS = 100_000;
const MAX_PATHS = 4096;
const MAX_LINE_BYTES = 256 * 1024;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const contained = (root, value) => value === root || value.startsWith(`${root}${path.sep}`);

const canonical = async (value, root, directory) => {
  if (!path.isAbsolute(value) || !contained(root, value)) fail('qa_native_journal_path_invalid');
  const info = await lstat(value);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || await realpath(value) !== value) fail('qa_native_journal_path_invalid');
  return info;
};

// Read the existing selected journal. This does not create a writer or an
// observer sink. Open chunks can end mid-write; their incomplete tail is never
// eligible for a final grade, and is reported explicitly while polling.
export async function readQaNativeObservations({ journalDirectory, runtimeRoot, parseObservation, final = false }) {
  if (typeof parseObservation !== 'function') fail('qa_native_observation_parser_required');
  await canonical(runtimeRoot, runtimeRoot, true);
  await canonical(journalDirectory, runtimeRoot, true);
  for (const name of ['runtime', 'sessions']) {
    const directory = path.join(journalDirectory, name);
    try {
      await canonical(directory, journalDirectory, true);
      if (name === 'sessions') {
        const entries = await readdir(directory, { withFileTypes: true });
        if (entries.length > MAX_PATHS) fail('qa_native_journal_bound_exceeded');
        for (const entry of entries) await canonical(path.join(directory, entry.name), journalDirectory, true);
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  // The shared collector intentionally ignores symlinks. Refuse them here so
  // a replaced chunk cannot silently become missing native evidence.
  const directories = [journalDirectory, path.join(journalDirectory, 'runtime')];
  const sessionDirectories = await readdir(path.join(journalDirectory, 'sessions'), { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  directories.push(...sessionDirectories.map(entry => path.join(journalDirectory, 'sessions', entry.name)));
  for (const directory of directories) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    if (entries.length > MAX_PATHS) fail('qa_native_journal_bound_exceeded');
    if (entries.some(entry => entry.isSymbolicLink())) fail('qa_native_journal_path_invalid');
  }
  const paths = await collectJournalPaths(journalDirectory);
  if (paths.length > MAX_PATHS) fail('qa_native_journal_bound_exceeded');
  const observations = [], records = [], files = [];
  let bytes = 0, count = 0, complete = true;
  for (const file of paths) {
    const info = await canonical(file, journalDirectory, false);
    if (info.size > MAX_BYTES - bytes) fail('qa_native_journal_bound_exceeded');
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let snapshot;
    try {
      const opened = await handle.stat();
      if (opened.dev !== info.dev || opened.ino !== info.ino) fail('qa_native_journal_path_changed');
      snapshot = Buffer.alloc(info.size);
      let offset = 0;
      while (offset < snapshot.length) {
        const read = await handle.read(snapshot, offset, snapshot.length - offset, offset);
        if (!read.bytesRead) fail('qa_native_journal_path_changed');
        offset += read.bytesRead;
      }
    } finally { await handle.close(); }
    const source = file.endsWith('.gz') ? gunzipSync(snapshot, { maxOutputLength: MAX_BYTES - bytes }) : snapshot;
    bytes += source.length;
    if (bytes > MAX_BYTES) fail('qa_native_journal_bound_exceeded');
    let text = source.toString('utf8');
    const incomplete = text.length > 0 && !text.endsWith('\n');
    if (incomplete) {
      if (!file.endsWith('.open.ndjson') && !file.endsWith('.ndjson.open')) fail('qa_native_journal_malformed');
      complete = false;
      text = text.slice(0, text.lastIndexOf('\n') + 1);
    }
    files.push({ path: path.relative(journalDirectory, file), bytes: snapshot.length, sha256: hash(snapshot), complete: !incomplete });
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      if (++count > MAX_RECORDS || Buffer.byteLength(line) > MAX_LINE_BYTES) fail('qa_native_journal_bound_exceeded');
      let row;
      try { row = JSON.parse(line); } catch { fail('qa_native_journal_malformed'); }
      if (row?.type === 'gap') fail('qa_native_journal_gap');
      if (row?.type === 'lifecycle' && row.event === 'native_observation_gap') fail('qa_native_observation_gap');
      if (row?.type !== 'lifecycle' || row.event !== 'native_observation') continue;
      if (!Number.isFinite(row.at) || row.at < 0) fail('qa_native_observation_invalid');
      const payload = parseObservation(row.payload);
      if (!payload || row.sessionID !== payload.sessionID || row.directory !== payload.directory) fail('qa_native_observation_scope_invalid');
      observations.push(payload);
      records.push(row);
    }
  }
  if (final && !complete) fail('qa_native_journal_incomplete');
  return { observations, records, files, complete, sha256: hash(JSON.stringify(records)), bytes, scannedRecords: count };
}

export function assertQaNativeJournalStatus(status, journalDirectory) {
  if (status?.enabled !== true || status.directory !== journalDirectory || status.gapRecords !== 0
    || status.lastError || status.queuedRecords !== 0) fail('qa_native_journal_status_invalid');
}

// The caller supplies the existing authenticated diagnostics export request,
// bounded while streaming its response. Only that owner can flush the journal.
export async function flushQaNativeObservationJournal({ exportJournal, readStatus, journalDirectory }) {
  await exportJournal();
  const status = await readStatus();
  assertQaNativeJournalStatus(status, journalDirectory);
  return status;
}
