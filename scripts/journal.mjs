#!/usr/bin/env node

import { createReadStream, lstatSync } from 'node:fs';
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

// Self-contained copy of packages/shared-runtime/lib/data-root.js (QA runs this
// file alone): DEVRYAN_DATA_DIR or its alias, else the pre-rename folder while it
// is still a real directory, else ~/.config/devryan.
const defaultDataRoot = (env, homeDir) => {
  const configured = env.DEVRYAN_DATA_DIR ?? env.OPENCHAMBER_DATA_DIR;
  if (typeof configured === 'string' && configured.trim()) return path.resolve(configured.trim());
  const legacy = path.join(homeDir, '.config', 'openchamber');
  try { if (lstatSync(legacy).isDirectory()) return legacy; } catch { /* Migrated or absent. */ }
  return path.join(homeDir, '.config', 'devryan');
};

export const resolveJournalDirectory = ({ argv = [], env = process.env, homeDir = os.homedir() } = {}) => {
  const index = argv.indexOf('--dir');
  if (index >= 0 && argv[index + 1]) return path.resolve(argv[index + 1]);
  return path.join(defaultDataRoot(env, homeDir), 'harness', 'journal');
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

const manifestHasVerifiedZeroGaps = (manifest) => (
  manifest !== null
  && Number.isFinite(manifest?.gapCount)
  && manifest.gapCount === 0
);

export const collectGapPaths = async (journalDirectory, { verify = false } = {}) => {
  if (verify) return collectJournalPaths(journalDirectory);

  const output = [];
  const rootEntries = await fs.readdir(journalDirectory, { withFileTypes: true }).catch(() => []);
  output.push(...rootEntries
    .filter((entry) => entry.isFile() && LEGACY_SEGMENT.test(entry.name))
    .map((entry) => path.join(journalDirectory, entry.name))
    .sort());

  const sessionsDirectory = path.join(journalDirectory, 'sessions');
  const sessionEntries = await fs.readdir(sessionsDirectory, { withFileTypes: true }).catch(() => []);
  for (const entry of sessionEntries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const bucketDirectory = path.join(sessionsDirectory, entry.name);
    const manifest = await readJson(path.join(bucketDirectory, 'manifest.json'));
    if (!manifestHasVerifiedZeroGaps(manifest)) output.push(...await chunkPaths(bucketDirectory));
  }

  const runtimeDirectory = path.join(journalDirectory, 'runtime');
  const runtimeManifest = await readJson(path.join(runtimeDirectory, 'manifest.json'));
  if (!manifestHasVerifiedZeroGaps(runtimeManifest)) {
    output.push(...await chunkPaths(runtimeDirectory));
  }
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

const gaps = async (journalDirectory, args) => {
  const unsupported = args.filter((arg) => arg !== '--verify');
  if (unsupported.length > 0) throw new Error(`Unknown gaps option: ${unsupported[0]}`);
  const verify = args.includes('--verify');
  for await (const record of readRecordsFromPaths(await collectGapPaths(journalDirectory, { verify }))) {
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

// --- summary: one root session and its child sessions -----------------------

const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const finiteNumber = (value) => Number.isFinite(value) ? value : 0;
const clip = (value, width) => {
  const text = (typeof value === 'string' ? value : JSON.stringify(value) ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`;
};

/** Median (mean of the two middle values), nearest-rank p90, max and total of a sample. */
export const sampleStats = (values) => {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return { count: 0, p50: 0, p90: 0, max: 0, total: 0 };
  const middle = Math.floor(sorted.length / 2);
  return {
    count: sorted.length,
    p50: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    p90: sorted[Math.max(0, Math.ceil(sorted.length * 0.9) - 1)],
    max: sorted[sorted.length - 1],
    total: sorted.reduce((sum, value) => sum + value, 0),
  };
};

export const parseSummaryOptions = (args) => {
  const known = new Set(['--since', '--until']);
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--json') continue;
    if (known.has(args[index]) && args[index + 1] !== undefined) { index += 1; continue; }
    throw new Error(`Unknown summary option: ${args[index]}`);
  }
  return {
    since: parseTime(optionValue(args, '--since')),
    until: parseTime(optionValue(args, '--until')),
    json: args.includes('--json'),
  };
};

const sessionBuckets = async (journalDirectory) => {
  const buckets = new Map();
  const sessionsDirectory = path.join(journalDirectory, 'sessions');
  const entries = await fs.readdir(sessionsDirectory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(sessionsDirectory, entry.name);
    const manifest = await readJson(path.join(directory, 'manifest.json'));
    const id = manifest?.sessionID || decodeURIComponent(entry.name);
    buckets.set(id, { id, directory, manifest });
  }
  return buckets;
};

const legacySegmentPaths = async (journalDirectory) => {
  const entries = await fs.readdir(journalDirectory, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && LEGACY_SEGMENT.test(entry.name))
    .map((entry) => path.join(journalDirectory, entry.name))
    .sort();
};

// Parent/title from a `session.*` event about the session itself.
const sessionRelationFromRecord = (record) => {
  const eventType = asString(record?.payload?.type);
  if (record?.type !== 'open_code_event' || !eventType.startsWith('session.')) return null;
  const info = asObject(record.payload?.properties?.info);
  const id = asString(info?.id);
  if (!id) return null;
  const parentID = asString(info.parentID) || asString(info.parentId);
  return { id, parentID: parentID || null, title: asString(info.title) || null, createdAt: finiteNumber(info.time?.created) };
};

const mergeRelation = (relations, relation) => {
  if (!relation) return;
  const existing = relations.get(relation.id) ?? { id: relation.id, parentID: null, title: null, createdAt: 0 };
  relations.set(relation.id, {
    id: relation.id,
    parentID: relation.parentID || existing.parentID,
    title: relation.title || existing.title,
    createdAt: existing.createdAt || relation.createdAt,
  });
};

const emptyTokens = () => ({
  messages: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, busyMs: 0,
});

const finishTokens = (key, tokens) => {
  const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  return { ...key, ...tokens, cost: Math.round(tokens.cost * 1e6) / 1e6, cacheHitRatio: prompt > 0 ? tokens.cacheRead / prompt : null };
};

const addTokens = (target, info) => {
  const tokens = asObject(info.tokens) ?? {};
  const cache = asObject(tokens.cache) ?? {};
  target.messages += 1;
  target.input += finiteNumber(tokens.input);
  target.output += finiteNumber(tokens.output);
  target.reasoning += finiteNumber(tokens.reasoning);
  target.cacheRead += finiteNumber(cache.read);
  target.cacheWrite += finiteNumber(cache.write);
  target.cost += finiteNumber(info.cost);
  const created = finiteNumber(info.time?.created);
  const completed = finiteNumber(info.time?.completed);
  if (created && completed >= created) target.busyMs += completed - created;
};

const modelLabel = (providerID, modelID) => {
  const model = asString(modelID);
  if (!model) return '?';
  const provider = asString(providerID);
  return provider ? `${provider}/${model}` : model;
};

const CONTROL_EVENTS = new Set([
  'permission.asked', 'permission.replied', 'question.asked', 'question.replied', 'question.rejected',
]);

/**
 * Summarize a root session and every descendant session in the journal: the
 * session tree, tokens and cache by agent and model, tool latency, execution
 * phases, errors and controls. Prompt text, control bodies and question
 * answers are never copied into the summary.
 */
export const summarizeSessionTree = async (journalDirectory, rootSessionID, { since = null, until = null } = {}) => {
  const buckets = await sessionBuckets(journalDirectory);
  const legacyPaths = await legacySegmentPaths(journalDirectory);
  const inWindow = (record) => {
    const at = finiteNumber(record?.at);
    return (since === null || at >= since) && (until === null || at <= until);
  };

  // Relations: manifests first (the writer derives parentID/title from the same
  // records); a bucket without a manifest, and legacy flat segments, are read.
  const relations = new Map();
  for (const bucket of buckets.values()) {
    if (bucket.manifest) {
      mergeRelation(relations, { id: bucket.id, parentID: asString(bucket.manifest.parentID) || null,
        title: asString(bucket.manifest.title) || null, createdAt: finiteNumber(bucket.manifest.firstAt) });
      continue;
    }
    for await (const record of readRecordsFromPaths(await chunkPaths(bucket.directory))) {
      const relation = sessionRelationFromRecord(record);
      if (relation?.id === bucket.id) mergeRelation(relations, relation);
    }
  }
  for await (const record of readRecordsFromPaths(legacyPaths)) mergeRelation(relations, sessionRelationFromRecord(record));

  // Depth-first so the printed tree reads parent → child; earliest child first.
  const childrenOf = new Map();
  for (const relation of relations.values()) {
    if (!relation.parentID) continue;
    childrenOf.set(relation.parentID, [...(childrenOf.get(relation.parentID) ?? []), relation]);
  }
  const tree = [];
  const depth = new Map();
  const stack = [{ id: rootSessionID, level: 0 }];
  while (stack.length > 0) {
    const { id, level } = stack.pop();
    if (depth.has(id)) continue;
    depth.set(id, level);
    tree.push(id);
    const children = (childrenOf.get(id) ?? [])
      .sort((left, right) => (left.createdAt - right.createdAt) || left.id.localeCompare(right.id));
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push({ id: children[index].id, level: level + 1 });
  }
  const members = new Set(tree);

  const records = [];
  for (const sessionID of tree) {
    const bucket = buckets.get(sessionID);
    if (!bucket) continue;
    for await (const record of readRecordsFromPaths(await chunkPaths(bucket.directory))) {
      if (inWindow(record)) records.push({ sessionID, record });
    }
  }
  for await (const record of readRecordsFromPaths(legacyPaths)) {
    const sessionID = resolveRecordSessionID(record);
    if (members.has(sessionID) && inWindow(record)) records.push({ sessionID, record });
  }
  if (records.length === 0 && !buckets.has(rootSessionID)) {
    throw new Error(`No journal records for session ${rootSessionID}`);
  }
  records.sort((left, right) => finiteNumber(left.record?.at) - finiteNumber(right.record?.at));

  const sessions = new Map(tree.map((id) => [id, {
    id, parentID: relations.get(id)?.parentID ?? null,
    depth: depth.get(id), title: relations.get(id)?.title ?? null,
    firstAt: 0, lastAt: 0, status: null, deleted: false, records: 0, errors: 0, aborts: 0, gaps: 0, busy: emptyTokens(),
    agents: new Map(), models: new Map(), userAgents: new Map(), userModels: new Map(),
  }]));
  const messages = new Map();
  const toolCalls = new Map();
  const phases = new Map();
  const errors = [];
  const controls = [];
  const counts = { aborts: 0, otherControls: 0, retries: 0, providerRecoveries: 0, permissionAsked: 0, permissionReplied: 0,
    questionAsked: 0, questionReplied: 0, questionRejected: 0 };
  let gaps = 0;
  let firstAt = 0;
  let lastAt = 0;
  const bump = (map, key) => { if (key) map.set(key, (map.get(key) ?? 0) + 1); };

  for (const { sessionID, record } of records) {
    const session = sessions.get(sessionID);
    const at = finiteNumber(record?.at);
    session.records += 1;
    if (at > 0) {
      firstAt = firstAt ? Math.min(firstAt, at) : at;
      lastAt = Math.max(lastAt, at);
      session.firstAt = session.firstAt ? Math.min(session.firstAt, at) : at;
      session.lastAt = Math.max(session.lastAt, at);
    }
    const payload = asObject(record?.payload) ?? {};
    if (record?.type === 'gap') {
      const count = Number.isFinite(record.count) ? record.count : 1;
      gaps += count;
      session.gaps += count;
    } else if (record?.type === 'control') {
      const action = asString(record.action) || '?';
      if (action === 'abort') { counts.aborts += 1; session.aborts += 1; } else counts.otherControls += 1;
      controls.push({ at, sessionID, kind: 'control', action, source: asString(payload.source) || null,
        detail: asString(payload.method) || null });
    } else if (record?.type === 'lifecycle' && record.event === 'session_execution' && Number.isFinite(payload.elapsedMs)) {
      const tier = asString(payload.executionTier) || asString(payload.action) || '?';
      const phase = asString(payload.phase) || '?';
      const key = `${tier} ${phase}`;
      const entry = phases.get(key) ?? { tier, phase, values: [], slow: 0 };
      entry.values.push(payload.elapsedMs);
      if (payload.slow === true) entry.slow += 1;
      phases.set(key, entry);
    } else if (record?.type === 'lifecycle' && record.event === 'provider_recovery_control') {
      counts.providerRecoveries += 1;
      controls.push({ at, sessionID, kind: 'provider_recovery', action: asString(payload.action) || '?', source: null,
        detail: modelLabel(payload.providerID, payload.modelID) });
    } else if (record?.type === 'open_code_event') {
      const eventType = asString(payload.type);
      const properties = asObject(payload.properties) ?? {};
      if (eventType === 'session.error') {
        session.errors += 1;
        errors.push({ at, sessionID, kind: 'session', detail: clip(properties.error ?? null, 300) });
      } else if (eventType === 'session.status') {
        const status = asObject(properties.status) ?? {};
        session.status = asString(status.type) || session.status;
        if (status.type === 'retry') {
          counts.retries += 1;
          const attempt = Number.isFinite(status.attempt) ? `attempt ${status.attempt}` : 'attempt ?';
          controls.push({ at, sessionID, kind: 'retry', action: attempt, source: null,
            detail: asString(status.message) ? clip(status.message, 200) : null });
        }
      } else if (eventType === 'session.idle') {
        session.status = 'idle';
      } else if (eventType === 'session.deleted') {
        session.deleted = true;
      } else if (CONTROL_EVENTS.has(eventType)) {
        const counter = {
          'permission.asked': 'permissionAsked', 'permission.replied': 'permissionReplied', 'question.asked': 'questionAsked',
          'question.replied': 'questionReplied', 'question.rejected': 'questionRejected',
        }[eventType];
        counts[counter] += 1;
        let detail = null;
        if (eventType === 'permission.asked') detail = asString(properties.permission) || asString(properties.type) || null;
        else if (eventType === 'permission.replied') detail = asString(properties.reply) || asString(properties.response) || null;
        else if (eventType === 'question.asked' && Array.isArray(properties.questions)) detail = `${properties.questions.length} question(s)`;
        controls.push({ at, sessionID, kind: eventType, action: null, source: null, detail });
      } else if (eventType === 'message.updated') {
        const info = asObject(properties.info);
        const id = asString(info?.id);
        if (id && info.role === 'assistant') messages.set(id, { sessionID, info });
        else if (id && info.role === 'user') {
          bump(session.userAgents, asString(info.agent));
          bump(session.userModels, asObject(info.model) ? modelLabel(info.model.providerID, info.model.modelID) : '');
        }
      } else if (eventType === 'message.part.updated') {
        const part = asObject(properties.part);
        if (part?.type === 'tool') {
          const callID = asString(part.callID) || asString(part.id);
          const key = `${sessionID}\u0000${callID}`;
          const previous = toolCalls.get(key);
          const terminal = (status) => status === 'completed' || status === 'error';
          if (!previous || !terminal(previous.state?.status)) {
            toolCalls.set(key, { at, sessionID, tool: asString(part.tool) || '?', state: asObject(part.state) ?? {} });
          }
        }
      }
    }
  }

  const byAgentModel = new Map();
  const byAgent = new Map();
  const byModel = new Map();
  const total = emptyTokens();
  for (const { sessionID, info } of messages.values()) {
    const agent = asString(info.agent) || asString(info.mode) || '?';
    const model = modelLabel(info.providerID, info.modelID);
    const session = sessions.get(sessionID);
    bump(session.agents, agent);
    bump(session.models, model);
    addTokens(session.busy, info);
    for (const [map, key, fields] of [
      [byAgentModel, `${agent}\u0000${model}`, { agent, model }],
      [byAgent, agent, { agent }],
      [byModel, model, { model }],
    ]) {
      const entry = map.get(key) ?? { fields, tokens: emptyTokens() };
      addTokens(entry.tokens, info);
      map.set(key, entry);
    }
    addTokens(total, info);
  }
  const tokenRows = (map) => [...map.values()]
    .map(({ fields, tokens }) => finishTokens(fields, tokens))
    .sort((left, right) => (right.input + right.cacheRead) - (left.input + left.cacheRead));

  const tools = new Map();
  for (const call of toolCalls.values()) {
    const entry = tools.get(call.tool) ?? { tool: call.tool, calls: 0, errors: 0, unfinished: 0, durations: [] };
    const status = call.state.status;
    if (status === 'completed' || status === 'error') {
      entry.calls += 1;
      const start = finiteNumber(call.state.time?.start);
      const end = finiteNumber(call.state.time?.end);
      if (start && end >= start) entry.durations.push(end - start);
      if (status === 'error') {
        entry.errors += 1;
        errors.push({ at: call.at, sessionID: call.sessionID, kind: 'tool', detail: `${call.tool}: ${clip(call.state.error ?? null, 200)}` });
      }
    } else {
      entry.unfinished += 1;
    }
    tools.set(call.tool, entry);
  }
  errors.sort((left, right) => left.at - right.at);
  controls.sort((left, right) => left.at - right.at);

  const pickTop = (map) => [...map.entries()].sort((left, right) => right[1] - left[1]).map(([key]) => key);
  return {
    rootSessionID,
    window: { since, until },
    span: { firstAt, lastAt, durationMs: lastAt && firstAt ? lastAt - firstAt : 0 },
    gaps,
    sessions: tree.map((id) => {
      const session = sessions.get(id);
      return {
        id, parentID: session.parentID, depth: session.depth, title: session.title,
        agents: session.agents.size ? pickTop(session.agents) : pickTop(session.userAgents),
        models: session.models.size ? pickTop(session.models) : pickTop(session.userModels),
        status: session.deleted ? 'deleted' : session.status, records: session.records,
        firstAt: session.firstAt, lastAt: session.lastAt,
        durationMs: session.firstAt && session.lastAt ? session.lastAt - session.firstAt : 0,
        busyMs: session.busy.busyMs,
        errors: session.errors, aborts: session.aborts, gaps: session.gaps,
      };
    }),
    tokens: {
      total: finishTokens({}, total),
      byAgentModel: tokenRows(byAgentModel),
      byAgent: tokenRows(byAgent),
      byModel: tokenRows(byModel),
    },
    tools: [...tools.values()].map(({ durations, ...entry }) => {
      const stats = sampleStats(durations);
      return { ...entry, timed: stats.count, p50Ms: stats.p50, p90Ms: stats.p90, maxMs: stats.max, totalMs: stats.total };
    }).sort((left, right) => (right.totalMs - left.totalMs) || (right.calls - left.calls) || left.tool.localeCompare(right.tool)),
    phases: [...phases.values()].map(({ values, ...entry }) => {
      const stats = sampleStats(values);
      return { ...entry, count: stats.count, p50Ms: stats.p50, p90Ms: stats.p90, maxMs: stats.max, totalMs: stats.total };
    }).sort((left, right) => (right.totalMs - left.totalMs) || `${left.tier} ${left.phase}`.localeCompare(`${right.tier} ${right.phase}`)),
    errors,
    controls,
    counts,
  };
};

const clock = (at) => at ? new Date(at).toISOString().slice(11, 19) : '--:--:--';
const duration = (ms) => {
  const total = Math.round(Math.max(0, ms) / 1000);
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s`;
  return `${Math.floor(total / 3600)}h${String(Math.floor(total / 60) % 60).padStart(2, '0')}m`;
};
const percent = (ratio) => ratio === null ? '—' : `${(ratio * 100).toFixed(1)}%`;
const limited = (rows, limit, render) => [
  ...rows.slice(0, limit).map(render),
  ...(rows.length > limit ? [`  … ${rows.length - limit} more (use --json for all)`] : []),
];

export const formatSessionSummary = (summary) => {
  const lines = [];
  const { span } = summary;
  lines.push(`root=${summary.rootSessionID} sessions=${summary.sessions.length} span=${span.firstAt ? new Date(span.firstAt).toISOString() : '—'}`
    + `..${span.lastAt ? new Date(span.lastAt).toISOString() : '—'} (${duration(span.durationMs)}) gaps=${summary.gaps}`);
  if (summary.gaps > 0) lines.push('  gap records qualify every conclusion drawn from this range');

  lines.push('', 'SESSIONS (agent, model, status, active span, assistant busy time):');
  for (const session of summary.sessions) {
    const indent = '  '.repeat(session.depth + 1);
    const marker = session.depth > 0 ? '└ ' : '';
    const flags = [
      session.errors ? `errors=${session.errors}` : '',
      session.aborts ? `aborts=${session.aborts}` : '',
      session.gaps ? `gaps=${session.gaps}` : '',
      session.records ? '' : 'no records',
    ].filter(Boolean).join(' ');
    lines.push(`${indent}${marker}${session.id} ${session.agents.join(',') || '?'} ${session.models.join(',') || '?'}`
      + ` ${session.status ?? '?'} ${clock(session.firstAt)} +${duration(session.durationMs)} busy=${duration(session.busyMs)}`
      + `${flags ? ` ${flags}` : ''}${session.title ? ` "${clip(session.title, 60)}"` : ''}`);
  }

  const tokenLine = (label, row) => `  ${truncate(label, 36)} msgs=${String(row.messages).padEnd(4)} in=${String(row.input).padEnd(8)}`
    + ` out=${String(row.output).padEnd(7)} rsn=${String(row.reasoning).padEnd(7)} cacheR=${String(row.cacheRead).padEnd(9)}`
    + ` cacheW=${String(row.cacheWrite).padEnd(8)} hit=${percent(row.cacheHitRatio).padEnd(6)} cost=$${row.cost.toFixed(4)} busy=${duration(row.busyMs)}`;
  lines.push('', 'TOKENS by agent/model (hit = cache read / (input + cache read + cache write)):');
  for (const row of summary.tokens.byAgentModel) lines.push(tokenLine(`${row.agent} ${row.model}`, row));
  lines.push('', 'TOKENS by agent:');
  for (const row of summary.tokens.byAgent) lines.push(tokenLine(row.agent, row));
  lines.push('', 'TOKENS by model:');
  for (const row of summary.tokens.byModel) lines.push(tokenLine(row.model, row));
  lines.push(tokenLine('TOTAL', summary.tokens.total));

  lines.push('', 'TOOLS (calls, p50 s, p90 s, max s, total s, errors, unfinished):');
  for (const tool of summary.tools) {
    lines.push(`  ${truncate(tool.tool, 22)} n=${String(tool.calls).padEnd(4)} p50=${(tool.p50Ms / 1000).toFixed(2).padStart(6)}`
      + ` p90=${(tool.p90Ms / 1000).toFixed(2).padStart(6)} max=${(tool.maxMs / 1000).toFixed(2).padStart(6)}`
      + ` total=${(tool.totalMs / 1000).toFixed(1).padStart(7)} err=${tool.errors}${tool.unfinished ? ` unfinished=${tool.unfinished}` : ''}`);
  }

  lines.push('', 'EXECUTION PHASES (n, p50 ms, p90 ms, max ms, total s):');
  lines.push(...limited(summary.phases, 15, (phase) => `  ${truncate(`${phase.tier} ${phase.phase}`, 40)} n=${String(phase.count).padEnd(5)}`
    + ` p50=${phase.p50Ms.toFixed(0).padStart(7)} p90=${phase.p90Ms.toFixed(0).padStart(7)} max=${phase.maxMs.toFixed(0).padStart(7)}`
    + ` total=${(phase.totalMs / 1000).toFixed(1).padStart(7)}${phase.slow ? ` slow=${phase.slow}` : ''}`));

  lines.push('', 'ERRORS:');
  lines.push(...limited(summary.errors, 40, (error) => `  ${clock(error.at)} ${error.sessionID} ${error.kind} ${error.detail}`));

  const { counts } = summary;
  lines.push('', `CONTROLS (aborts=${counts.aborts} other=${counts.otherControls} retries=${counts.retries}`
    + ` provider_recovery=${counts.providerRecoveries} permission=${counts.permissionAsked}/${counts.permissionReplied}`
    + ` question=${counts.questionAsked}/${counts.questionReplied}/${counts.questionRejected} asked/answered[/rejected]):`);
  lines.push(...limited(summary.controls, 30, (control) => `  ${clock(control.at)} ${control.sessionID} ${control.kind}`
    + `${control.action ? ` ${control.action}` : ''}${control.source ? ` source=${control.source}` : ''}${control.detail ? ` ${control.detail}` : ''}`));
  return lines.join('\n');
};

const summaryCommand = async (journalDirectory, rootSessionID, args) => {
  if (!rootSessionID || rootSessionID.startsWith('--')) throw new Error('summary requires a root sessionID');
  const options = parseSummaryOptions(args);
  const result = await summarizeSessionTree(journalDirectory, rootSessionID, options);
  process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : `${formatSessionSummary(result)}\n`);
};

const usage = `Usage:
  bun scripts/journal.mjs [--dir <journal-dir>] list
  bun scripts/journal.mjs [--dir <journal-dir>] show <sessionID|runtime> [--type <type>] [--event <event>] [--since <time>] [--until <time>] [--grep <text>] [--tail <count>]
  bun scripts/journal.mjs [--dir <journal-dir>] gaps [--verify]
  bun scripts/journal.mjs [--dir <journal-dir>] summary <rootSessionID> [--since <time>] [--until <time>] [--json]
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
    await gaps(journalDirectory, args.slice(1));
    return;
  }
  if (command === 'summary') {
    await summaryCommand(journalDirectory, args[1], args.slice(2));
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
