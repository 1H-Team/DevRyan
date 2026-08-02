#!/usr/bin/env node

import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createGunzip, gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

const LEGACY_SEGMENT = /^\d+-\d+\.ndjson(?:\.open)?$/;
const CHUNK = /^\d{6}\.ndjson(?:\.gz|\.open)$/;
const NEW_BLOB = /^(?:sessions\/[^/]+|runtime)\/blobs\/[a-f0-9]{64}\.txt\.gz$/;
const LEGACY_BLOB = /^[^/]+\.blobs\/[a-f0-9]{64}\.txt$/;

const asString = (value) => typeof value === 'string' ? value.trim() : '';

export const resolveRecordSessionID = (record) => {
  const explicit = asString(record?.sessionID)
    || asString(record?.payload?.sessionID)
    || asString(record?.payload?.properties?.sessionID)
    || asString(record?.payload?.properties?.info?.sessionID);
  if (explicit) return explicit;
  const eventType = asString(record?.payload?.type);
  return eventType.startsWith('session.')
    ? asString(record?.payload?.properties?.info?.id)
    : '';
};

export const resolveJournalDirectory = ({ argv = [], env = process.env, homeDir = os.homedir() } = {}) => {
  const index = argv.indexOf('--dir');
  if (index >= 0 && argv[index + 1]) return path.resolve(argv[index + 1]);
  const dataRoot = env.OPENCHAMBER_DATA_DIR
    ? path.resolve(env.OPENCHAMBER_DATA_DIR)
    : path.join(homeDir, '.config', 'openchamber');
  return path.join(dataRoot, 'harness', 'journal');
};

const stripGlobalOptions = (argv) => {
  const output = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--dir') {
      index += 1;
      continue;
    }
    output.push(argv[index]);
  }
  return output;
};

const readJson = async (filePath) => {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
};

const directorySize = async (directory) => {
  let total = 0;
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directorySize(candidate);
    else if (entry.isFile()) total += (await fs.stat(candidate)).size;
  }
  return total;
};

const recordCount = (manifest) => Object.values(manifest?.recordCounts ?? {})
  .reduce((total, count) => total + (Number(count) || 0), 0);

export const formatBytes = (value) => {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const scaled = value / (1024 ** unit);
  return unit === 0 ? `${Math.floor(scaled)} B` : `${scaled.toFixed(1)} ${units[unit]}`;
};

export const listJournalRows = async (journalDirectory) => {
  const rows = [];
  const sessionsDirectory = path.join(journalDirectory, 'sessions');
  const sessionEntries = await fs.readdir(sessionsDirectory, { withFileTypes: true }).catch(() => []);
  for (const entry of sessionEntries) {
    if (!entry.isDirectory()) continue;
    const bucketDirectory = path.join(sessionsDirectory, entry.name);
    const manifest = await readJson(path.join(bucketDirectory, 'manifest.json'));
    rows.push({
      id: manifest?.sessionID || decodeURIComponent(entry.name),
      title: manifest?.title || '—',
      records: recordCount(manifest),
      gaps: Number(manifest?.gapCount) || 0,
      lastAt: Number(manifest?.lastAt) || 0,
      bytes: Number(manifest?.bytes) || await directorySize(bucketDirectory),
      kind: 'session',
    });
  }
  const runtimeDirectory = path.join(journalDirectory, 'runtime');
  const runtimeStat = await fs.stat(runtimeDirectory).catch(() => null);
  if (runtimeStat?.isDirectory()) {
    const manifest = await readJson(path.join(runtimeDirectory, 'manifest.json'));
    rows.push({
      id: 'runtime',
      title: 'Unattributed records',
      records: recordCount(manifest),
      gaps: Number(manifest?.gapCount) || 0,
      lastAt: Number(manifest?.lastAt) || 0,
      bytes: Number(manifest?.bytes) || await directorySize(runtimeDirectory),
      kind: 'runtime',
    });
  }
  const rootEntries = await fs.readdir(journalDirectory, { withFileTypes: true }).catch(() => []);
  const legacyNames = rootEntries
    .filter((entry) => entry.isFile() && LEGACY_SEGMENT.test(entry.name))
    .map((entry) => entry.name);
  if (legacyNames.length > 0) {
    let bytes = 0;
    let lastAt = 0;
    for (const name of legacyNames) {
      const stat = await fs.stat(path.join(journalDirectory, name));
      bytes += stat.size;
      lastAt = Math.max(lastAt, Number.parseInt(name.split('-')[0], 10) || stat.mtimeMs);
    }
    rows.push({
      id: 'legacy',
      title: `${legacyNames.length} flat segment${legacyNames.length === 1 ? '' : 's'}`,
      records: null,
      gaps: null,
      lastAt,
      bytes,
      kind: 'legacy',
    });
  }
  return rows.sort((left, right) => (right.lastAt - left.lastAt) || left.id.localeCompare(right.id));
};

const truncate = (value, width) => value.length <= width
  ? value.padEnd(width)
  : `${value.slice(0, Math.max(1, width - 1))}…`;

export const formatJournalRows = (rows) => {
  const columns = [
    ['SESSION', 24],
    ['TITLE', 30],
    ['RECORDS', 9],
    ['GAPS', 6],
    ['LAST', 20],
    ['SIZE', 10],
  ];
  const header = columns.map(([label, width]) => truncate(label, width)).join('  ').trimEnd();
  const body = rows.map((row) => [
    truncate(String(row.id), 24),
    truncate(String(row.title), 30),
    truncate(row.records === null ? '—' : String(row.records), 9),
    truncate(row.gaps === null ? '—' : String(row.gaps), 6),
    truncate(row.lastAt ? new Date(row.lastAt).toISOString() : '—', 20),
    truncate(formatBytes(row.bytes), 10),
  ].join('  ').trimEnd());
  return [header, ...body].join('\n');
};

const chunkPaths = async (directory) => {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && CHUNK.test(entry.name))
    .map((entry) => path.join(directory, entry.name))
    .sort();
};

export const collectJournalPaths = async (journalDirectory) => {
  const output = [];
  const rootEntries = await fs.readdir(journalDirectory, { withFileTypes: true }).catch(() => []);
  for (const entry of rootEntries) {
    if (entry.isFile() && LEGACY_SEGMENT.test(entry.name)) output.push(path.join(journalDirectory, entry.name));
  }
  const sessionEntries = await fs.readdir(path.join(journalDirectory, 'sessions'), { withFileTypes: true }).catch(() => []);
  for (const entry of sessionEntries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isDirectory()) output.push(...await chunkPaths(path.join(journalDirectory, 'sessions', entry.name)));
  }
  output.push(...await chunkPaths(path.join(journalDirectory, 'runtime')));
  return output;
};

export const readRecordsFromPaths = async function* (paths) {
  for (const filePath of paths) {
    const rawInput = createReadStream(filePath);
    const input = filePath.endsWith('.gz') ? rawInput.pipe(createGunzip()) : rawInput;
    if (!filePath.endsWith('.gz')) input.setEncoding('utf8');
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        try {
          yield JSON.parse(line);
        } catch {
          yield {
            type: 'gap',
            at: 0,
            runtime: 'unknown',
            reason: 'segment_parse_failed',
            count: 1,
            source: path.relative(process.cwd(), filePath),
          };
        }
      }
    } finally {
      lines.close();
      rawInput.destroy();
      if (input !== rawInput) input.destroy();
    }
  }
};

const optionValue = (args, name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const parseTime = (value) => {
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return parsed;
  throw new Error(`Invalid time value: ${value}`);
};

export const parseShowFilters = (args) => {
  const tailValue = optionValue(args, '--tail');
  const tail = tailValue === undefined ? null : Number.parseInt(tailValue, 10);
  if (tail !== null && (!Number.isFinite(tail) || tail < 0)) throw new Error('--tail must be a non-negative integer');
  return {
    type: optionValue(args, '--type') || null,
    event: optionValue(args, '--event') || null,
    since: parseTime(optionValue(args, '--since')),
    until: parseTime(optionValue(args, '--until')),
    grep: optionValue(args, '--grep') || null,
    tail,
  };
};

export const recordMatches = (record, filters) => {
  if (filters.type && record?.type !== filters.type) return false;
  if (filters.event && record?.payload?.type !== filters.event) return false;
  if (filters.since !== null && (!Number.isFinite(record?.at) || record.at < filters.since)) return false;
  if (filters.until !== null && (!Number.isFinite(record?.at) || record.at > filters.until)) return false;
  if (filters.grep && !JSON.stringify(record).toLowerCase().includes(filters.grep.toLowerCase())) return false;
  return true;
};

const show = async (journalDirectory, sessionID, args) => {
  if (!sessionID) throw new Error('show requires a sessionID (or "runtime")');
  const filters = parseShowFilters(args);
  let paths;
  if (sessionID === 'runtime') {
    paths = await chunkPaths(path.join(journalDirectory, 'runtime'));
  } else {
    paths = [];
    const sessionEntries = await fs.readdir(path.join(journalDirectory, 'sessions'), { withFileTypes: true }).catch(() => []);
    for (const entry of sessionEntries) {
      if (!entry.isDirectory()) continue;
      const manifest = await readJson(path.join(journalDirectory, 'sessions', entry.name, 'manifest.json'));
      if ((manifest?.sessionID || decodeURIComponent(entry.name)) === sessionID) {
        paths.push(...await chunkPaths(path.join(journalDirectory, 'sessions', entry.name)));
        break;
      }
    }
  }
  const rootEntries = await fs.readdir(journalDirectory, { withFileTypes: true }).catch(() => []);
  paths.push(...rootEntries
    .filter((entry) => entry.isFile() && LEGACY_SEGMENT.test(entry.name))
    .map((entry) => path.join(journalDirectory, entry.name))
    .sort());
  const records = [];
  for await (const record of readRecordsFromPaths(paths)) {
    const matchesSession = sessionID === 'runtime'
      ? !resolveRecordSessionID(record)
      : resolveRecordSessionID(record) === sessionID;
    if (matchesSession && recordMatches(record, filters)) records.push(record);
  }
  records.sort((left, right) => (Number(left?.at) || 0) - (Number(right?.at) || 0));
  const selected = filters.tail === null
    ? records
    : (filters.tail === 0 ? [] : records.slice(-filters.tail));
  for (const record of selected) process.stdout.write(`${JSON.stringify(record)}\n`);
};

const gaps = async (journalDirectory) => {
  for await (const record of readRecordsFromPaths(await collectJournalPaths(journalDirectory))) {
    if (record?.type === 'gap') process.stdout.write(`${JSON.stringify(record)}\n`);
  }
};

const blob = async (journalDirectory, relativePath) => {
  const normalized = String(relativePath || '').replace(/\\/g, '/');
  if (!NEW_BLOB.test(normalized) && !LEGACY_BLOB.test(normalized)) {
    throw new Error('Invalid diagnostic blob path');
  }
  if (normalized.startsWith('sessions/')) {
    const sessionSegment = normalized.split('/')[1];
    if (sessionSegment === '.' || sessionSegment === '..') {
      throw new Error('Invalid diagnostic blob path');
    }
  }
  const absolute = path.resolve(journalDirectory, normalized);
  const relative = path.relative(journalDirectory, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Diagnostic blob path escapes the journal');
  }
  const data = await fs.readFile(absolute);
  process.stdout.write(normalized.endsWith('.gz') ? gunzipSync(data) : data);
};

const usage = `Usage:
  bun scripts/journal.mjs [--dir <journal-dir>] list
  bun scripts/journal.mjs [--dir <journal-dir>] show <sessionID|runtime> [--type <type>] [--event <event>] [--since <time>] [--until <time>] [--grep <text>] [--tail <count>]
  bun scripts/journal.mjs [--dir <journal-dir>] gaps
  bun scripts/journal.mjs [--dir <journal-dir>] blob <relative-path>
  bun scripts/journal.mjs [--dir <journal-dir>] path
`;

export const main = async (argv = process.argv.slice(2)) => {
  const journalDirectory = resolveJournalDirectory({ argv });
  const args = stripGlobalOptions(argv);
  const command = args[0];
  if (command === 'path') {
    process.stdout.write(`${journalDirectory}\n`);
    return;
  }
  if (command === 'list') {
    const rows = await listJournalRows(journalDirectory);
    process.stdout.write(`${formatJournalRows(rows)}\n`);
    return;
  }
  if (command === 'show') {
    await show(journalDirectory, args[1], args.slice(2));
    return;
  }
  if (command === 'gaps') {
    await gaps(journalDirectory);
    return;
  }
  if (command === 'blob') {
    await blob(journalDirectory, args[1]);
    return;
  }
  process.stdout.write(usage);
  if (command) process.exitCode = 1;
};

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    process.stderr.write(`journal: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
