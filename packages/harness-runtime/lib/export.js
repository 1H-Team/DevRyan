import { Readable } from 'node:stream';

import { resolveRecordSessionID, resolveSessionRelation } from './session-id.js';

const asString = (value) => (
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : ''
);

const collectTaskSessionIDs = (parentBySession, rootSessionID) => {
  const included = new Set([rootSessionID]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [sessionID, parentID] of parentBySession) {
      if (!sessionID || !parentID || !included.has(parentID) || included.has(sessionID)) continue;
      included.add(sessionID);
      changed = true;
    }
  }
  return included;
};

const sanitizeForExport = (sanitizer, value) => {
  if (typeof value === 'string') {
    return sanitizer?.sanitizeText ? sanitizer.sanitizeText(value) : value;
  }
  return sanitizer?.sanitizeExportValue ? sanitizer.sanitizeExportValue(value) : value;
};

const serializeForExport = (sanitizer, value, spacing) => {
  const serialized = JSON.stringify(sanitizeForExport(sanitizer, value), null, spacing);
  return sanitizer?.sanitizeExportValue || !sanitizer?.sanitizeText
    ? serialized
    : sanitizer.sanitizeText(serialized);
};

const secondPass = (sanitizer, value) => serializeForExport(sanitizer, value, 2);
const secondPassRecord = (sanitizer, value) => serializeForExport(sanitizer, value, undefined);

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

const createRecordSource = async (journal) => {
  if (
    typeof journal.iterateRecords === 'function'
    && typeof journal.listSegmentPaths === 'function'
  ) {
    const segmentPaths = await journal.listSegmentPaths();
    return () => journal.iterateRecords({ segmentPaths });
  }
  const records = await journal.readRecords();
  return async function* iterateBufferedRecords() {
    yield* records;
  };
};

const streamText = (createChunks) => Readable.from(createChunks());

const safeSessionFileName = (sessionID) => encodeURIComponent(sessionID).replaceAll('.', '%2E');

const isReadableBlobPath = (value) => {
  if (/^[^/]+\.blobs\/[a-f0-9]{64}\.txt$/.test(value)) return true;
  if (!/^(?:sessions\/[^/]+|runtime)\/blobs\/[a-f0-9]{64}\.txt\.gz$/.test(value)) return false;
  if (!value.startsWith('sessions/')) return true;
  const sessionSegment = value.split('/')[1];
  return sessionSegment !== '.' && sessionSegment !== '..';
};

export const createDiagnosticsExport = async (options = {}) => {
  const journal = options.journal;
  if (!journal || typeof journal.readRecords !== 'function') {
    throw new TypeError('diagnostics export journal is required');
  }
  const scope = options.scope?.scope === 'task' ? options.scope : { scope: 'runtime' };
  const recordSource = await createRecordSource(journal);
  let includedSessions = null;
  let includedSessionIDs = [];
  if (scope.scope === 'task') {
    const rootSessionID = asString(scope.sessionID);
    if (!rootSessionID) throw new TypeError('sessionID is required for a task diagnostics export');
    const parentBySession = new Map();
    for await (const record of recordSource()) {
      const relation = resolveSessionRelation(record);
      if (relation) parentBySession.set(relation.sessionID, relation.parentID);
    }
    includedSessions = collectTaskSessionIDs(parentBySession, rootSessionID);
    includedSessionIDs = [...includedSessions];
  }

  const includesRecord = (record) => {
    if (scope.scope === 'runtime') return true;
    const sessionID = resolveRecordSessionID(record);
    if (sessionID) return includedSessions.has(sessionID);
    return Boolean(scope.directory && record.directory === scope.directory);
  };

  let recordCount = 0;
  let runtimeRecordCount = 0;
  const recordSessionIDs = new Set(includedSessionIDs);
  const blobPaths = new Set();
  for await (const record of recordSource()) {
    if (!includesRecord(record)) continue;
    recordCount += 1;
    const sessionID = resolveRecordSessionID(record);
    if (sessionID) recordSessionIDs.add(sessionID);
    else runtimeRecordCount += 1;
    collectBlobPaths(record, blobPaths);
  }
  includedSessionIDs = [...recordSessionIDs].sort();

  const availableManifests = typeof journal.listSessionManifests === 'function'
    ? await journal.listSessionManifests()
    : [];
  if (scope.scope === 'runtime') {
    for (const sessionManifest of availableManifests) {
      if (typeof sessionManifest?.sessionID === 'string' && sessionManifest.sessionID) {
        recordSessionIDs.add(sessionManifest.sessionID);
      }
    }
    includedSessionIDs = [...recordSessionIDs].sort();
  }
  const manifestBySession = new Map(
    availableManifests.map((manifest) => [manifest.sessionID, manifest]),
  );
  const sessionManifests = includedSessionIDs.map((sessionID) => (
    manifestBySession.get(sessionID) ?? { version: 1, sessionID, rebuilt: true }
  ));

  const receipts = (options.receipts ?? []).filter((receipt) => (
    scope.scope === 'runtime'
    || receipt.directory === scope.directory
    || includedSessionIDs.includes(receipt.metadata?.sessionID)
  ));
  const evidence = (options.evidence ?? []).filter((entry) => (
    scope.scope === 'runtime'
    || includedSessionIDs.includes(entry.sessionID)
  ));
  const createdAt = options.now?.() ?? Date.now();
  const stamp = new Date(createdAt).toISOString().replace(/[:.]/g, '-');
  const fileName = `DevRyan-diagnostics-${scope.scope}-${stamp}.zip`;
  const manifest = {
    version: 2,
    product: 'DevRyan',
    createdAt,
    scope,
    includedSessionIDs,
    recordCount,
    runtimeRecordCount,
    receiptCount: receipts.length,
    evidenceCount: evidence.length,
    warning: 'This bundle contains sanitized diagnostic data. Review it before sharing.',
  };
  const redactionReport = {
    ...(options.sanitizer?.getReport?.() ?? {}),
    exportSecondPassApplied: true,
  };
  const files = [
    { name: 'manifest.json', data: `${secondPass(options.sanitizer, manifest)}\n` },
    { name: 'redaction-report.json', data: `${secondPass(options.sanitizer, redactionReport)}\n` },
    {
      name: 'sessions/index.json',
      data: `${secondPass(options.sanitizer, { version: 1, sessions: sessionManifests })}\n`,
    },
  ];
  for (const sessionID of includedSessionIDs) {
    files.push({
      name: `sessions/${safeSessionFileName(sessionID)}.ndjson`,
      openStream: () => streamText(async function* streamSession() {
        for await (const record of recordSource()) {
          if (includesRecord(record) && resolveRecordSessionID(record) === sessionID) {
            yield `${secondPassRecord(options.sanitizer, record)}\n`;
          }
        }
      }),
    });
  }
  files.push({
    name: 'runtime.ndjson',
    openStream: () => streamText(async function* streamRuntime() {
      for await (const record of recordSource()) {
        if (includesRecord(record) && !resolveRecordSessionID(record)) {
          yield `${secondPassRecord(options.sanitizer, record)}\n`;
        }
      }
    }),
  });
  files.push(
    { name: 'worktree-receipts.json', data: `${secondPass(options.sanitizer, receipts)}\n` },
    { name: 'turn-evidence.json', data: `${secondPass(options.sanitizer, evidence)}\n` },
    {
      name: 'SHARING-WARNING.txt',
      data: 'This archive contains sanitized DevRyan diagnostics. Sanitization reduces risk but cannot identify every secret embedded in source text. Review the archive before sharing it.\n',
    },
  );
  for (const blobPath of blobPaths) {
    if (!isReadableBlobPath(blobPath)) continue;
    const zipPath = blobPath.endsWith('.gz') ? blobPath.slice(0, -3) : blobPath;
    files.push({
      name: `blobs/${zipPath}`,
      openStream: () => streamText(async function* streamBlob() {
        const data = await journal.readBlob?.(blobPath);
        if (typeof data === 'string') yield sanitizeForExport(options.sanitizer, data);
      }),
    });
  }
  return { fileName, manifest, redactionReport, files };
};

export const writeDiagnosticsZip = async (bundle, options = {}) => {
  const archive = options.createArchive?.();
  if (!archive || typeof archive.addBuffer !== 'function' || typeof archive.end !== 'function') {
    throw new TypeError('zip archive factory is required');
  }
  for (const file of bundle.files) {
    if (typeof file.data === 'string') {
      archive.addBuffer(Buffer.from(file.data, 'utf8'), file.name, { mode: 0o600 });
    } else if (typeof file.openStream === 'function' && typeof archive.addReadStream === 'function') {
      archive.addReadStream(file.openStream(), file.name, { mode: 0o600 });
    } else {
      throw new TypeError(`zip entry ${file.name} has no supported data source`);
    }
  }
  archive.end();
  return archive;
};
