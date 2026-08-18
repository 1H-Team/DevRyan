import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createGunzip, gunzipSync, gzipSync } from 'node:zlib';

import { writeFileAtomic } from './atomic-file.js';
import { createJournalTrimmer, RUNTIME_KEY } from './journal-trim.js';
import { resolveRecordSessionID, resolveSessionRelation } from './session-id.js';

const DEFAULT_MAX_QUEUE = 5_000;
const DEFAULT_SEGMENT_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_BLOB_THRESHOLD_BYTES = 256 * 1024;
const DEFAULT_MAX_OPEN_WRITERS = 6;
const MANIFEST_VERSION = 1;
const METADATA_DEBOUNCE_MS = 250;

const byteLength = (value) => Buffer.byteLength(value, 'utf8');
const isLegacyClosedSegment = (name) => /^\d+-\d+\.ndjson$/.test(name);
const isLegacyOpenSegment = (name) => /^\d+-\d+\.ndjson\.open$/.test(name);
const isChunk = (name) => /^\d{6}\.ndjson(?:\.gz|\.open)$/.test(name);
const isClosedChunk = (name) => /^\d{6}\.ndjson\.gz$/.test(name);
const chunkName = (sequence, extension) => `${String(sequence).padStart(6, '0')}.ndjson.${extension}`;

const README_CONTENT = `# DevRyan diagnostic journal

This directory contains local, sanitized runtime evidence for DevRyan. Records are
partitioned by OpenCode session so external coding agents can inspect one task without
scanning unrelated traffic. DevRyan chat history is stored elsewhere and is not part of
this journal.

## Layout

- \`index.json\`: summaries of every session manifest.
- \`sessions/<sessionID>/manifest.json\`: session identity, timing, counts, models, size,
  and trim/coalescing totals.
- \`sessions/<sessionID>/*.ndjson.gz\`: closed gzip-compressed chunks.
- \`sessions/<sessionID>/*.ndjson.open\`: the active crash-safe, plain NDJSON chunk.
- \`sessions/<sessionID>/blobs/<sha256>.txt.gz\`: large sanitized string sidecars.
- \`runtime/\`: the same structure for records without a resolvable session.
- Root \`<timestamp>-<sequence>.ndjson\` files are legacy segments. They remain readable
  until retention or an explicit clear removes them; they are never regrouped.

Streaming \`message.part.delta\` events are intentionally omitted. Repeated
\`message.part.updated\` and \`session.updated\` events are last-write-wins; a flushed
record's \`coalesced\` field reports how many source records it represents. A blob stub
looks like \`{"type":"blob","path":"sessions/<id>/blobs/<sha>.txt.gz","size":123,"sha256":"…"}\`.

## Recipes

\`\`\`bash
bun scripts/journal.mjs list
bun scripts/journal.mjs show <sessionID> --tail 100
bun scripts/journal.mjs show <sessionID> --grep <callId>
bun scripts/journal.mjs gaps
gzcat sessions/<sessionID>/*.ndjson.gz | jq -c 'select(.type == "open_code_event")'
cat sessions/<sessionID>/*.ndjson.open | jq -c .
\`\`\`

An Error Log event UUID is a locator for the separate administrative Error Log,
not a journal record ID. Resolve it there first, then correlate this journal by
session plus \`callId\`, \`toolId\`, \`messageId\`, \`taskId\`, or a bounded timestamp
window. Run \`gaps\` before concluding. If the host journal is unavailable, expired,
or has a qualifying gap, report that limitation instead of reconstructing evidence.

Run these commands from the DevRyan repository. See its \`AGENTS.md\` diagnostic-journal
section for the evidence-first debugging workflow.
`;

const mapLargeStrings = async (value, writeBlob) => {
  if (typeof value === 'string') return writeBlob(value);
  if (Array.isArray(value)) {
    const output = [];
    for (const item of value) output.push(await mapLargeStrings(item, writeBlob));
    return output;
  }
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, nested] of Object.entries(value)) {
    output[key] = await mapLargeStrings(nested, writeBlob);
  }
  return output;
};

const directorySize = async (fsApi, directory) => {
  let total = 0;
  const entries = await fsApi.readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directorySize(fsApi, candidate);
    else if (entry.isFile()) total += (await fsApi.stat(candidate)).size;
  }
  return total;
};

const sessionDirectoryName = (sessionID) => encodeURIComponent(sessionID).replaceAll('.', '%2E');

const emptyManifest = (sessionID, runtime, rebuilt = false) => ({
  version: MANIFEST_VERSION,
  sessionID: sessionID || null,
  parentID: null,
  title: null,
  directory: null,
  runtime: runtime || 'unknown',
  firstAt: 0,
  lastAt: 0,
  recordCounts: {},
  eventCounts: {},
  errorCount: 0,
  gapCount: 0,
  trimmedDeltas: 0,
  coalescedParts: 0,
  coalescedSessionUpdates: 0,
  models: [],
  chunkCount: 0,
  bytes: 0,
  rebuilt,
});

const normalizeManifest = (value, sessionID, runtime) => ({
  ...emptyManifest(sessionID, runtime),
  ...(value && typeof value === 'object' ? value : {}),
  version: MANIFEST_VERSION,
  sessionID: sessionID || null,
  recordCounts: value?.recordCounts && typeof value.recordCounts === 'object'
    ? { ...value.recordCounts }
    : {},
  eventCounts: value?.eventCounts && typeof value.eventCounts === 'object'
    ? { ...value.eventCounts }
    : {},
  models: Array.isArray(value?.models) ? [...new Set(value.models.filter(Boolean))] : [],
});

const modelNamesFromRecord = (record) => {
  const properties = record?.payload?.properties;
  const info = properties?.info;
  const candidates = [
    [info?.providerID ?? info?.providerId, info?.modelID ?? info?.modelId],
    [properties?.providerID ?? properties?.providerId, properties?.modelID ?? properties?.modelId],
    [record?.payload?.providerID ?? record?.payload?.providerId, record?.payload?.modelID ?? record?.payload?.modelId],
  ];
  const output = [];
  for (const [provider, model] of candidates) {
    if (typeof model !== 'string' || !model) continue;
    output.push(typeof provider === 'string' && provider ? `${provider}/${model}` : model);
  }
  return output;
};

const recordLooksLikeError = (record) => {
  if (record?.type === 'gap' || record?.level === 'error') return true;
  const eventType = record?.payload?.type;
  if (typeof eventType === 'string' && /(?:error|failed)$/.test(eventType)) return true;
  return Boolean(record?.payload?.properties?.error);
};

const collectBlobPaths = (value, output = new Set()) => {
  if (Array.isArray(value)) {
    for (const entry of value) collectBlobPaths(entry, output);
    return output;
  }
  if (!value || typeof value !== 'object') return output;
  if (value.type === 'blob' && typeof value.path === 'string') output.add(value.path);
  for (const nested of Object.values(value)) collectBlobPaths(nested, output);
  return output;
};

const updateManifestFromRecord = (manifest, record) => {
  const at = Number.isFinite(record?.at) ? record.at : 0;
  if (at > 0) {
    manifest.firstAt = manifest.firstAt > 0 ? Math.min(manifest.firstAt, at) : at;
    manifest.lastAt = Math.max(manifest.lastAt, at);
  }
  if (record?.runtime) manifest.runtime = record.runtime;
  if (record?.directory) manifest.directory = record.directory;
  const type = typeof record?.type === 'string' ? record.type : 'unknown';
  manifest.recordCounts[type] = (manifest.recordCounts[type] ?? 0) + 1;
  const eventType = typeof record?.payload?.type === 'string' ? record.payload.type : '';
  if (eventType) manifest.eventCounts[eventType] = (manifest.eventCounts[eventType] ?? 0) + 1;
  if (type === 'gap') manifest.gapCount += Number.isFinite(record?.count) ? record.count : 1;
  if (recordLooksLikeError(record)) manifest.errorCount += 1;

  const relation = resolveSessionRelation(record);
  if (relation?.parentID) manifest.parentID = relation.parentID;
  const info = record?.payload?.properties?.info;
  if (typeof info?.parentID === 'string') manifest.parentID = info.parentID || null;
  if (typeof info?.parentId === 'string') manifest.parentID = info.parentId || null;
  if (typeof info?.title === 'string' && info.title) manifest.title = info.title;
  if (typeof info?.directory === 'string' && info.directory) manifest.directory = info.directory;
  for (const model of modelNamesFromRecord(record)) {
    if (!manifest.models.includes(model)) manifest.models.push(model);
  }
};

const readJson = async (fsApi, filePath) => {
  try {
    return JSON.parse(await fsApi.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
};

export const createDiagnosticJournal = (options = {}) => {
  const directory = path.resolve(options.directory);
  const sessionsDirectory = path.join(directory, 'sessions');
  const runtimeDirectory = path.join(directory, 'runtime');
  const fsApi = options.fs ?? fs;
  const sanitizer = options.sanitizer;
  if (!sanitizer || typeof sanitizer.sanitizeRecord !== 'function') {
    throw new TypeError('diagnostic journal sanitizer is required');
  }
  const now = options.now ?? Date.now;
  const maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE;
  const maxSegmentBytes = options.maxSegmentBytes ?? DEFAULT_SEGMENT_BYTES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const blobThresholdBytes = options.blobThresholdBytes ?? DEFAULT_BLOB_THRESHOLD_BYTES;
  const maxOpenWriters = options.maxOpenWriters ?? DEFAULT_MAX_OPEN_WRITERS;
  const openReadStream = options.createReadStream ?? createReadStream;
  const trim = options.trim !== false;
  const queue = [];
  const afterClearQueue = [];
  const buckets = new Map();
  const appliedTrimStats = new Map();
  let initialized = false;
  let initializePromise = null;
  let closed = false;
  let writerPromise = null;
  let droppedPending = 0;
  let writtenRecords = 0;
  let gapRecords = 0;
  let lastError = null;
  let sweepTimer = null;
  let metadataTimer = null;
  let metadataWritePromise = Promise.resolve();
  let accessSequence = 0;
  let clearing = false;
  let clearPromise = null;
  let droppedAfterClear = 0;

  const iteratePath = async function* (segmentPath, parseFailures = true) {
    const rawInput = openReadStream(segmentPath);
    const input = segmentPath.endsWith('.gz') ? rawInput.pipe(createGunzip()) : rawInput;
    if (!segmentPath.endsWith('.gz')) input.setEncoding?.('utf8');
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        try {
          yield JSON.parse(line);
        } catch {
          if (parseFailures) {
            yield {
              type: 'gap',
              at: now(),
              runtime: options.runtime ?? 'unknown',
              reason: 'segment_parse_failed',
              count: 1,
            };
          }
        }
      }
    } finally {
      lines.close();
      rawInput.destroy?.();
      if (input !== rawInput) input.destroy?.();
    }
  };

  const bucketKey = (sessionID) => sessionID ? `session:${sessionID}` : RUNTIME_KEY;

  const bucketDirectory = (sessionID) => sessionID
    ? path.join(sessionsDirectory, sessionDirectoryName(sessionID))
    : runtimeDirectory;

  const refreshBucketStorageStats = async (bucket) => {
    const entries = await fsApi.readdir(bucket.directory, { withFileTypes: true }).catch(() => []);
    bucket.manifest.chunkCount = entries.filter((entry) => entry.isFile() && isChunk(entry.name)).length;
    let bytes = 0;
    for (const entry of entries) {
      if (entry.name === 'manifest.json') continue;
      const candidate = path.join(bucket.directory, entry.name);
      if (entry.isDirectory()) bytes += await directorySize(fsApi, candidate);
      else if (entry.isFile()) bytes += (await fsApi.stat(candidate)).size;
    }
    bucket.manifest.bytes = bytes;
  };

  const rebuildManifest = async (bucket) => {
    const manifest = emptyManifest(bucket.sessionID, options.runtime ?? 'unknown', true);
    const entries = await fsApi.readdir(bucket.directory).catch(() => []);
    const chunks = entries.filter(isChunk).sort();
    for (const name of chunks) {
      for await (const record of iteratePath(path.join(bucket.directory, name), false)) {
        updateManifestFromRecord(manifest, record);
      }
    }
    bucket.manifest = manifest;
    await refreshBucketStorageStats(bucket);
    bucket.dirty = true;
  };

  const loadBucket = async (sessionID, explicitDirectory = bucketDirectory(sessionID)) => {
    const key = bucketKey(sessionID);
    const existing = buckets.get(key);
    if (existing) return existing;
    await fsApi.mkdir(explicitDirectory, { recursive: true, mode: 0o700 });
    const manifestPath = path.join(explicitDirectory, 'manifest.json');
    const loaded = await readJson(fsApi, manifestPath);
    const bucket = {
      key,
      sessionID: sessionID || '',
      directory: explicitDirectory,
      manifestPath,
      manifest: normalizeManifest(loaded, sessionID, options.runtime ?? 'unknown'),
      dirty: false,
      sequence: 1,
      handle: null,
      openPath: null,
      openBytes: 0,
      lastUsed: 0,
    };
    buckets.set(key, bucket);
    const entries = await fsApi.readdir(explicitDirectory).catch(() => []);
    for (const name of entries) {
      const match = name.match(/^(\d{6})\.ndjson(?:\.gz|\.open)$/);
      if (match) bucket.sequence = Math.max(bucket.sequence, Number(match[1]) + 1);
    }
    if (!loaded && entries.some(isChunk)) {
      await rebuildManifest(bucket);
    } else if (!loaded) {
      bucket.dirty = true;
    } else {
      await refreshBucketStorageStats(bucket);
      bucket.dirty = true;
    }
    return bucket;
  };

  const ensureBucket = (sessionID) => loadBucket(sessionID || '');

  const writeIfChanged = async (filePath, content) => {
    const previous = await fsApi.readFile(filePath, 'utf8').catch(() => '');
    if (previous === content) return false;
    await writeFileAtomic(filePath, content, { fs: fsApi, now });
    return true;
  };

  const syncTrimStats = async () => {
    if (!trim) return;
    const nextStats = trimmer.stats();
    for (const [key, stats] of Object.entries(nextStats)) {
      const sessionID = key === RUNTIME_KEY ? '' : key;
      const bucket = await ensureBucket(sessionID);
      const previous = appliedTrimStats.get(key) ?? {
        trimmedDeltas: 0,
        coalescedParts: 0,
        coalescedSessionUpdates: 0,
      };
      for (const field of ['trimmedDeltas', 'coalescedParts', 'coalescedSessionUpdates']) {
        const delta = Math.max(0, (stats[field] ?? 0) - (previous[field] ?? 0));
        if (delta > 0) {
          bucket.manifest[field] = (bucket.manifest[field] ?? 0) + delta;
          const at = now();
          bucket.manifest.firstAt = bucket.manifest.firstAt > 0
            ? Math.min(bucket.manifest.firstAt, at)
            : at;
          bucket.manifest.lastAt = Math.max(bucket.manifest.lastAt, at);
          bucket.dirty = true;
        }
      }
      appliedTrimStats.set(key, { ...stats });
    }
  };

  const indexContent = () => {
    const sessions = [...buckets.values()]
      .filter((bucket) => bucket.sessionID)
      .map((bucket) => ({ ...bucket.manifest }))
      .sort((left, right) => (right.lastAt - left.lastAt) || left.sessionID.localeCompare(right.sessionID));
    const runtime = buckets.get(RUNTIME_KEY)?.manifest ?? null;
    return `${JSON.stringify({ version: 1, sessions, runtime }, null, 2)}\n`;
  };

  const flushMetadata = () => {
    const operation = metadataWritePromise.then(async () => {
      if (metadataTimer) clearTimeout(metadataTimer);
      metadataTimer = null;
      await syncTrimStats();
      for (const bucket of buckets.values()) {
        if (!bucket.dirty) continue;
        await writeFileAtomic(bucket.manifestPath, `${JSON.stringify(bucket.manifest, null, 2)}\n`, {
          fs: fsApi,
          now,
        });
        bucket.dirty = false;
      }
      await writeIfChanged(path.join(directory, 'README.md'), README_CONTENT);
      await writeIfChanged(path.join(directory, 'index.json'), indexContent());
    });
    metadataWritePromise = operation.catch(() => undefined);
    return operation;
  };

  const scheduleMetadata = () => {
    if (metadataTimer) return;
    metadataTimer = setTimeout(() => {
      metadataTimer = null;
      void flushMetadata().catch((error) => {
        lastError = error instanceof Error ? error.message : String(error);
      });
    }, options.metadataDebounceMs ?? METADATA_DEBOUNCE_MS);
    metadataTimer.unref?.();
  };

  const gzipOpenFile = async (source) => {
    const raw = await fsApi.readFile(source).catch(() => null);
    if (!raw) return null;
    const lastNewline = raw.lastIndexOf(0x0a);
    if (lastNewline < 0) {
      await fsApi.rm(source, { force: true });
      return null;
    }
    const complete = raw.subarray(0, lastNewline + 1);
    const destination = source.replace(/\.ndjson\.open$/, '.ndjson.gz');
    await writeFileAtomic(destination, gzipSync(complete), { fs: fsApi, now });
    await fsApi.rm(source, { force: true });
    return destination;
  };

  const recoverLegacyOpenSegments = async () => {
    const entries = await fsApi.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !isLegacyOpenSegment(entry.name)) continue;
      const source = path.join(directory, entry.name);
      const raw = await fsApi.readFile(source);
      const lastNewline = raw.lastIndexOf(0x0a);
      if (lastNewline < 0) {
        await fsApi.rm(source, { force: true });
        continue;
      }
      if (lastNewline + 1 < raw.length) await fsApi.truncate(source, lastNewline + 1);
      await fsApi.rename(source, source.slice(0, -'.open'.length));
    }
  };

  const recoverBucket = async (sessionID, bucketPath) => {
    const entries = await fsApi.readdir(bucketPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isFile() && /^\d{6}\.ndjson\.open$/.test(entry.name)) {
        await gzipOpenFile(path.join(bucketPath, entry.name));
      }
    }
    await loadBucket(sessionID, bucketPath);
  };

  const closeHandle = async (bucket) => {
    if (!bucket.handle) return;
    await bucket.handle.sync();
    await bucket.handle.close();
    bucket.handle = null;
  };

  const evictHandleIfNeeded = async (exceptKey) => {
    const open = [...buckets.values()].filter((bucket) => bucket.handle);
    if (open.length < maxOpenWriters) return;
    const candidate = open
      .filter((bucket) => bucket.key !== exceptKey)
      .sort((left, right) => left.lastUsed - right.lastUsed)[0];
    if (candidate) await closeHandle(candidate);
  };

  const openBucket = async (bucket) => {
    bucket.lastUsed = ++accessSequence;
    if (bucket.handle) return;
    await evictHandleIfNeeded(bucket.key);
    if (!bucket.openPath) {
      bucket.openPath = path.join(bucket.directory, chunkName(bucket.sequence++, 'open'));
      bucket.openBytes = 0;
      bucket.manifest.chunkCount += 1;
      bucket.dirty = true;
    }
    bucket.handle = await fsApi.open(bucket.openPath, 'a', 0o600);
    bucket.openBytes = (await bucket.handle.stat()).size;
  };

  const rotateBucket = async (bucket) => {
    if (!bucket.openPath) return;
    await closeHandle(bucket);
    const oldBytes = bucket.openBytes;
    const destination = await gzipOpenFile(bucket.openPath);
    bucket.openPath = null;
    bucket.openBytes = 0;
    if (destination) {
      const compressedBytes = (await fsApi.stat(destination)).size;
      bucket.manifest.bytes += compressedBytes - oldBytes;
    } else {
      bucket.manifest.chunkCount = Math.max(0, bucket.manifest.chunkCount - 1);
      bucket.manifest.bytes = Math.max(0, bucket.manifest.bytes - oldBytes);
    }
    bucket.dirty = true;
    await flushMetadata();
  };

  const writeBlob = async (bucket, value) => {
    if (byteLength(value) <= blobThresholdBytes) return value;
    const digest = crypto.createHash('sha256').update(value).digest('hex');
    const blobDirectory = path.join(bucket.directory, 'blobs');
    const blobPath = path.join(blobDirectory, `${digest}.txt.gz`);
    await fsApi.mkdir(blobDirectory, { recursive: true, mode: 0o700 });
    let created = false;
    await fsApi.writeFile(blobPath, gzipSync(Buffer.from(value, 'utf8')), {
      mode: 0o600,
      flag: 'wx',
    }).then(() => {
      created = true;
    }).catch((error) => {
      if (error?.code !== 'EEXIST') throw error;
    });
    if (created) {
      bucket.manifest.bytes += (await fsApi.stat(blobPath)).size;
      bucket.dirty = true;
    }
    const prefix = bucket.sessionID
      ? `sessions/${sessionDirectoryName(bucket.sessionID)}`
      : 'runtime';
    return {
      type: 'blob',
      path: `${prefix}/blobs/${digest}.txt.gz`,
      size: byteLength(value),
      sha256: digest,
    };
  };

  const writeSanitized = async (record) => {
    const resolvedSessionID = resolveRecordSessionID(record);
    const hasTopLevelSessionID = typeof record?.sessionID === 'string' && record.sessionID.trim();
    const candidate = resolvedSessionID && !hasTopLevelSessionID
      ? { ...record, sessionID: resolvedSessionID }
      : record;
    const bucket = await ensureBucket(resolvedSessionID);
    let sanitized;
    try {
      sanitized = sanitizer.sanitizeRecord(candidate);
    } catch {
      sanitizer.recordFailure?.();
      sanitized = sanitizer.sanitizeRecord({
        type: 'gap',
        at: now(),
        runtime: options.runtime ?? 'unknown',
        directory: candidate?.directory,
        sessionID: resolvedSessionID || undefined,
        reason: 'sanitization_failed',
        count: 1,
      });
      gapRecords += 1;
    }

    const estimatedSize = byteLength(JSON.stringify(sanitized)) + 1;
    if (bucket.openBytes > 0 && bucket.openBytes + estimatedSize > maxSegmentBytes) {
      await rotateBucket(bucket);
    }
    await openBucket(bucket);
    const withBlobs = await mapLargeStrings(sanitized, (value) => writeBlob(bucket, value));
    const line = `${JSON.stringify(withBlobs)}\n`;
    const size = byteLength(line);
    await bucket.handle.write(line, undefined, 'utf8');
    bucket.openBytes += size;
    bucket.manifest.bytes += size;
    updateManifestFromRecord(bucket.manifest, withBlobs);
    bucket.dirty = true;
    writtenRecords += 1;
    scheduleMetadata();
  };

  const drainQueue = async () => {
    await initialize();
    while (queue.length > 0 && !clearing) {
      const next = queue.shift();
      try {
        await writeSanitized(next);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
  };

  const scheduleWriter = () => {
    if (writerPromise || clearing || closed) return;
    writerPromise = Promise.resolve()
      .then(drainQueue)
      .finally(() => {
        writerPromise = null;
        if (queue.length > 0 && !clearing && !closed) scheduleWriter();
      });
  };

  const queueReadyRecords = (records) => {
    let accepted = true;
    for (const record of records) {
      if (queue.length >= maxQueue) {
        droppedPending += 1;
        accepted = false;
        continue;
      }
      if (droppedPending > 0) {
        queue.push({
          type: 'gap',
          at: now(),
          runtime: options.runtime ?? 'unknown',
          reason: 'queue_overflow',
          count: droppedPending,
        });
        gapRecords += 1;
        droppedPending = 0;
      }
      if (queue.length >= maxQueue) {
        droppedPending += 1;
        accepted = false;
        continue;
      }
      queue.push(record);
    }
    scheduleWriter();
    return accepted;
  };

  const trimmer = createJournalTrimmer({
    now,
    debounceMs: options.trimDebounceMs,
    maxEntries: options.trimMaxEntries,
    maxBytes: options.trimMaxBytes,
    onFlush: queueReadyRecords,
  });

  const chunkPathsForBucket = async (bucket) => {
    const entries = await fsApi.readdir(bucket.directory).catch(() => []);
    return entries.filter(isChunk).sort().map((name) => path.join(bucket.directory, name));
  };

  const pruneNow = async () => {
    await fsApi.mkdir(directory, { recursive: true, mode: 0o700 });
    const cutoff = now() - maxAgeMs;
    let total = await directorySize(fsApi, directory);

    const rootEntries = await fsApi.readdir(directory, { withFileTypes: true }).catch(() => []);
    const legacy = [];
    for (const entry of rootEntries) {
      if (!entry.isFile() || !isLegacyClosedSegment(entry.name)) continue;
      const filePath = path.join(directory, entry.name);
      const blobPath = path.join(directory, entry.name.replace(/\.ndjson$/, '.blobs'));
      const stat = await fsApi.stat(filePath);
      const createdAt = Number.parseInt(entry.name.split('-')[0], 10);
      legacy.push({
        path: filePath,
        blobPath,
        size: stat.size + await directorySize(fsApi, blobPath),
        lastAt: Number.isFinite(createdAt) ? createdAt : stat.mtimeMs,
      });
    }
    legacy.sort((left, right) => left.lastAt - right.lastAt);
    for (const item of legacy) {
      if (item.lastAt >= cutoff && total <= maxBytes) continue;
      await fsApi.rm(item.path, { force: true });
      await fsApi.rm(item.blobPath, { recursive: true, force: true });
      total -= item.size;
    }

    const sessionBuckets = [...buckets.values()]
      .filter((bucket) => bucket.sessionID)
      .sort((left, right) => left.manifest.lastAt - right.manifest.lastAt);
    for (const bucket of sessionBuckets) {
      if (bucket.handle) continue;
      if (bucket.manifest.lastAt >= cutoff && total <= maxBytes) continue;
      const size = await directorySize(fsApi, bucket.directory);
      await fsApi.rm(bucket.directory, { recursive: true, force: true });
      buckets.delete(bucket.key);
      total -= size;
    }

    const runtimeBucket = buckets.get(RUNTIME_KEY);
    if (runtimeBucket) {
      const entries = await fsApi.readdir(runtimeBucket.directory, { withFileTypes: true }).catch(() => []);
      const chunks = [];
      for (const entry of entries) {
        if (!entry.isFile() || !isClosedChunk(entry.name)) continue;
        const filePath = path.join(runtimeBucket.directory, entry.name);
        const stat = await fsApi.stat(filePath);
        let lastAt = 0;
        for await (const record of iteratePath(filePath, false)) {
          if (Number.isFinite(record?.at)) lastAt = Math.max(lastAt, record.at);
        }
        chunks.push({ path: filePath, size: stat.size, lastAt: lastAt || stat.mtimeMs });
      }
      chunks.sort((left, right) => left.lastAt - right.lastAt);
      for (const chunk of chunks) {
        if (chunk.lastAt >= cutoff && total <= maxBytes) continue;
        await fsApi.rm(chunk.path, { force: true });
        total -= chunk.size;
      }
      const preservedTrimStats = {
        trimmedDeltas: runtimeBucket.manifest.trimmedDeltas,
        coalescedParts: runtimeBucket.manifest.coalescedParts,
        coalescedSessionUpdates: runtimeBucket.manifest.coalescedSessionUpdates,
      };
      const wasRebuilt = runtimeBucket.manifest.rebuilt;
      const referencedBlobs = new Set();
      const remainingChunks = await chunkPathsForBucket(runtimeBucket);
      for (const chunkPath of remainingChunks) {
        for await (const record of iteratePath(chunkPath, false)) collectBlobPaths(record, referencedBlobs);
      }
      const blobsDirectory = path.join(runtimeBucket.directory, 'blobs');
      const blobsBefore = await directorySize(fsApi, blobsDirectory);
      const blobEntries = await fsApi.readdir(blobsDirectory, { withFileTypes: true }).catch(() => []);
      for (const entry of blobEntries) {
        if (!entry.isFile() || !/^[a-f0-9]{64}\.txt\.gz$/.test(entry.name)) continue;
        if (referencedBlobs.has(`runtime/blobs/${entry.name}`)) continue;
        await fsApi.rm(path.join(blobsDirectory, entry.name), { force: true });
      }
      total -= Math.max(0, blobsBefore - await directorySize(fsApi, blobsDirectory));
      await rebuildManifest(runtimeBucket);
      runtimeBucket.manifest.rebuilt = wasRebuilt;
      Object.assign(runtimeBucket.manifest, preservedTrimStats);
      runtimeBucket.dirty = true;
    }
    await flushMetadata();
  };

  const initializeNow = async () => {
    if (initialized) return;
    await fsApi.mkdir(directory, { recursive: true, mode: 0o700 });
    await fsApi.mkdir(sessionsDirectory, { recursive: true, mode: 0o700 });
    await recoverLegacyOpenSegments();
    const sessionEntries = await fsApi.readdir(sessionsDirectory, { withFileTypes: true }).catch(() => []);
    for (const entry of sessionEntries) {
      if (!entry.isDirectory()) continue;
      const bucketPath = path.join(sessionsDirectory, entry.name);
      const loaded = await readJson(fsApi, path.join(bucketPath, 'manifest.json'));
      let sessionID = typeof loaded?.sessionID === 'string' ? loaded.sessionID : '';
      if (!sessionID) {
        try {
          sessionID = decodeURIComponent(entry.name);
        } catch {
          sessionID = entry.name;
        }
      }
      await recoverBucket(sessionID, bucketPath);
    }
    const runtimeEntries = await fsApi.readdir(runtimeDirectory).catch(() => null);
    if (runtimeEntries) await recoverBucket('', runtimeDirectory);
    await pruneNow();
    await flushMetadata();
    sweepTimer = setInterval(() => {
      void prune().catch((error) => {
        lastError = error instanceof Error ? error.message : String(error);
      });
    }, 60 * 60 * 1000);
    sweepTimer.unref?.();
    initialized = true;
  };

  const initialize = () => {
    if (initialized) return Promise.resolve();
    initializePromise ??= initializeNow().finally(() => {
      if (!initialized) initializePromise = null;
    });
    return initializePromise;
  };

  const enqueue = (record) => {
    if (closed) return false;
    if (clearing) {
      if (afterClearQueue.length >= maxQueue) {
        droppedAfterClear += 1;
        return false;
      }
      afterClearQueue.push(record);
      return true;
    }
    const ready = trim ? trimmer.admit(record) : [record];
    return queueReadyRecords(ready);
  };

  const flushInternal = async ({ rotate: shouldRotate = false } = {}) => {
    await initialize();
    if (trim) queueReadyRecords(trimmer.flushAll());
    while (writerPromise || queue.length > 0) {
      if (!writerPromise && queue.length > 0) scheduleWriter();
      await writerPromise;
    }
    if (droppedPending > 0) {
      const dropped = droppedPending;
      droppedPending = 0;
      queueReadyRecords([{
        type: 'gap',
        at: now(),
        runtime: options.runtime ?? 'unknown',
        reason: 'queue_overflow',
        count: dropped,
      }]);
      gapRecords += 1;
      await writerPromise;
    }
    if (shouldRotate) {
      for (const bucket of buckets.values()) await rotateBucket(bucket);
    } else {
      for (const bucket of buckets.values()) await bucket.handle?.sync();
    }
    await flushMetadata();
  };

  const flush = async (flushOptions = {}) => {
    if (clearPromise) await clearPromise;
    await flushInternal(flushOptions);
  };

  const listSegmentPaths = async () => {
    await flushInternal();
    const output = [];
    const rootEntries = await fsApi.readdir(directory, { withFileTypes: true });
    for (const entry of rootEntries) {
      if (entry.isFile() && (isLegacyClosedSegment(entry.name) || isLegacyOpenSegment(entry.name))) {
        output.push(path.join(directory, entry.name));
      }
    }
    for (const bucket of [...buckets.values()].sort((left, right) => left.key.localeCompare(right.key))) {
      const entries = await fsApi.readdir(bucket.directory).catch(() => []);
      for (const name of entries.filter(isChunk).sort()) output.push(path.join(bucket.directory, name));
    }
    return output;
  };

  const iterateRecords = async function* (iterateOptions = {}) {
    const segmentPaths = Array.isArray(iterateOptions.segmentPaths)
      ? iterateOptions.segmentPaths
      : await listSegmentPaths();
    for (const segmentPath of segmentPaths) yield* iteratePath(segmentPath);
  };

  const readRecords = async () => {
    const records = [];
    for await (const record of iterateRecords()) records.push(record);
    return records;
  };

  const readBlob = async (relativePath) => {
    const normalized = String(relativePath || '').replace(/\\/g, '/');
    const isNew = /^(?:sessions\/[^/]+|runtime)\/blobs\/[a-f0-9]{64}\.txt\.gz$/.test(normalized);
    const isLegacy = /^[^/]+\.blobs\/[a-f0-9]{64}\.txt$/.test(normalized);
    if (!isNew && !isLegacy) throw new Error('Diagnostic blob path is invalid');
    if (isNew && normalized.startsWith('sessions/')) {
      const sessionSegment = normalized.split('/')[1];
      if (sessionSegment === '.' || sessionSegment === '..') {
        throw new Error('Diagnostic blob path is invalid');
      }
    }
    const absolute = path.resolve(directory, normalized);
    const relative = path.relative(directory, absolute);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Diagnostic blob path escapes the journal');
    }
    const data = await fsApi.readFile(absolute);
    return isNew ? gunzipSync(data).toString('utf8') : data.toString('utf8');
  };

  const materializeBlobReferences = async (value) => {
    if (Array.isArray(value)) {
      const output = [];
      for (const entry of value) output.push(await materializeBlobReferences(entry));
      return output;
    }
    if (!value || typeof value !== 'object') return value;
    if (value.type === 'blob' && typeof value.path === 'string') {
      return readBlob(value.path);
    }
    const output = {};
    for (const [key, nested] of Object.entries(value)) {
      output[key] = await materializeBlobReferences(nested);
    }
    return output;
  };

  const listSessionManifests = async () => {
    await flushInternal();
    return [...buckets.values()]
      .filter((bucket) => bucket.sessionID)
      .map((bucket) => ({ ...bucket.manifest }))
      .sort((left, right) => (right.lastAt - left.lastAt) || left.sessionID.localeCompare(right.sessionID));
  };

  const getStatus = async () => {
    await initialize();
    const segmentPaths = await listSegmentPaths();
    const sessionEntries = await fsApi.readdir(sessionsDirectory, { withFileTypes: true }).catch(() => []);
    return {
      enabled: true,
      directory,
      diskBytes: await directorySize(fsApi, directory),
      maxBytes,
      segmentCount: segmentPaths.length,
      sessionCount: sessionEntries.filter((entry) => entry.isDirectory()).length,
      queuedRecords: queue.length,
      writtenRecords,
      gapRecords,
      lastError,
    };
  };

  async function prune() {
    await initialize();
    await flushInternal();
    await pruneNow();
  }

  const removeOwnedJournalData = async () => {
    await fsApi.rm(sessionsDirectory, { recursive: true, force: true });
    await fsApi.rm(runtimeDirectory, { recursive: true, force: true });
    const entries = await fsApi.readdir(directory, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries.map(async (entry) => {
      const legacySegment = entry.isFile()
        && (isLegacyClosedSegment(entry.name) || isLegacyOpenSegment(entry.name));
      const legacyBlobs = entry.isDirectory() && /^\d+-\d+\.blobs$/.test(entry.name);
      if (!legacySegment && !legacyBlobs) return;
      await fsApi.rm(path.join(directory, entry.name), {
        recursive: legacyBlobs,
        force: true,
      });
    }));
  };

  const resetJournalState = () => {
    buckets.clear();
    appliedTrimStats.clear();
    trimmer.reset();
    queue.length = 0;
    droppedPending = 0;
    writtenRecords = 0;
    gapRecords = 0;
    lastError = null;
  };

  const recoverCurrentBuckets = async () => {
    await fsApi.mkdir(sessionsDirectory, { recursive: true, mode: 0o700 });
    const sessionEntries = await fsApi.readdir(sessionsDirectory, { withFileTypes: true }).catch(() => []);
    for (const entry of sessionEntries) {
      if (!entry.isDirectory()) continue;
      const bucketPath = path.join(sessionsDirectory, entry.name);
      const loaded = await readJson(fsApi, path.join(bucketPath, 'manifest.json'));
      let sessionID = typeof loaded?.sessionID === 'string' ? loaded.sessionID : '';
      if (!sessionID) {
        try {
          sessionID = decodeURIComponent(entry.name);
        } catch {
          sessionID = entry.name;
        }
      }
      await recoverBucket(sessionID, bucketPath);
    }
    const runtimeEntries = await fsApi.readdir(runtimeDirectory).catch(() => null);
    if (runtimeEntries) await recoverBucket('', runtimeDirectory);
  };

  const stageRecordsBefore = async (since) => {
    const stagingDirectory = await fsApi.mkdtemp(path.join(
      path.dirname(directory),
      `.${path.basename(directory)}-clear-`,
    ));
    const stagedJournal = createDiagnosticJournal({
      directory: stagingDirectory,
      sanitizer,
      runtime: options.runtime,
      now,
      fs: fsApi,
      createReadStream: openReadStream,
      maxQueue,
      maxSegmentBytes,
      maxBytes: Number.MAX_SAFE_INTEGER,
      maxAgeMs: Number.MAX_SAFE_INTEGER,
      blobThresholdBytes,
      maxOpenWriters,
      trim: false,
      metadataDebounceMs: options.metadataDebounceMs,
    });
    let retainedRecords = 0;
    let retainedGaps = 0;
    const batchSize = Math.max(1, Math.min(250, Math.floor(maxQueue / 2)));
    try {
      for await (const record of iterateRecords()) {
        if (Number.isFinite(record?.at) && record.at >= since) continue;
        const materialized = await materializeBlobReferences(record);
        if (!stagedJournal.enqueue(materialized)) {
          throw new Error('Diagnostic journal staging queue overflowed');
        }
        retainedRecords += 1;
        if (record?.type === 'gap') retainedGaps += 1;
        if (retainedRecords % batchSize === 0) await stagedJournal.flush();
      }
      await stagedJournal.close();
      return { stagingDirectory, retainedRecords, retainedGaps };
    } catch (error) {
      await stagedJournal.close().catch(() => undefined);
      await fsApi.rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  };

  const replaceWithStagedJournal = async (stagingDirectory) => {
    const backupDirectory = `${directory}.clear-backup-${crypto.randomUUID()}`;
    await fsApi.rename(directory, backupDirectory);
    try {
      await fsApi.rename(stagingDirectory, directory);
    } catch (error) {
      await fsApi.rename(backupDirectory, directory).catch(() => undefined);
      throw error;
    }
    return backupDirectory;
  };

  const clear = (clearOptions = {}) => {
    if (clearPromise) return clearPromise;
    const hasSince = clearOptions?.since !== undefined;
    const since = hasSince ? Number(clearOptions.since) : null;
    if (hasSince && (!Number.isFinite(since) || since < 0)) {
      return Promise.reject(new TypeError('diagnostic clear since timestamp must be a non-negative number'));
    }
    clearing = true;
    clearPromise = (async () => {
      await initialize();
      if (metadataTimer) clearTimeout(metadataTimer);
      metadataTimer = null;
      await metadataWritePromise;
      if (trim) queueReadyRecords(trimmer.flushAll());
      if (writerPromise) await writerPromise;
      while (queue.length > 0) {
        const next = queue.shift();
        try {
          await writeSanitized(next);
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
      }
      if (metadataTimer) clearTimeout(metadataTimer);
      metadataTimer = null;
      await metadataWritePromise;
      for (const bucket of buckets.values()) await closeHandle(bucket);

      if (since !== null) {
        const staged = await stageRecordsBefore(since);
        const backupDirectory = await replaceWithStagedJournal(staged.stagingDirectory);
        resetJournalState();
        writtenRecords = staged.retainedRecords;
        gapRecords = staged.retainedGaps;
        await recoverCurrentBuckets();
        await flushMetadata();
        await fsApi.rm(backupDirectory, { recursive: true, force: true }).catch((error) => {
          lastError = error instanceof Error ? error.message : String(error);
        });
        return getStatus();
      }

      await removeOwnedJournalData();
      await fsApi.mkdir(sessionsDirectory, { recursive: true, mode: 0o700 });
      resetJournalState();
      await writeIfChanged(path.join(directory, 'README.md'), README_CONTENT);
      await writeIfChanged(
        path.join(directory, 'index.json'),
        `${JSON.stringify({ version: 1, sessions: [], runtime: null }, null, 2)}\n`,
      );
      return {
        enabled: true,
        directory,
        diskBytes: await directorySize(fsApi, directory),
        maxBytes,
        segmentCount: 0,
        sessionCount: 0,
        queuedRecords: 0,
        writtenRecords: 0,
        gapRecords: 0,
        lastError: null,
      };
    })().finally(() => {
      clearing = false;
      clearPromise = null;
      const pending = afterClearQueue.splice(0);
      if (droppedAfterClear > 0) {
        pending.unshift({
          type: 'gap',
          at: now(),
          runtime: options.runtime ?? 'unknown',
          reason: 'queue_overflow',
          count: droppedAfterClear,
        });
        gapRecords += 1;
        droppedAfterClear = 0;
      }
      for (const record of pending) enqueue(record);
    });
    return clearPromise;
  };

  const close = async () => {
    if (closed) return;
    if (clearPromise) await clearPromise;
    await flushInternal({ rotate: true });
    closed = true;
    if (sweepTimer) clearInterval(sweepTimer);
    if (metadataTimer) clearTimeout(metadataTimer);
    sweepTimer = null;
    metadataTimer = null;
  };

  return {
    initialize,
    enqueue,
    flush,
    close,
    drain: flush,
    prune,
    listSegmentPaths,
    iterateRecords,
    readRecords,
    readBlob,
    listSessionManifests,
    getStatus,
    clear,
  };
};

export {
  DEFAULT_BLOB_THRESHOLD_BYTES,
  DEFAULT_MAX_AGE_MS,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_OPEN_WRITERS,
  DEFAULT_MAX_QUEUE,
  DEFAULT_SEGMENT_BYTES,
  README_CONTENT,
};
