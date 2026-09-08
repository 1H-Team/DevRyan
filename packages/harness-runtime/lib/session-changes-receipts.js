import path from 'node:path';
import crypto from 'node:crypto';
import { changeError } from './session-changes-git.js';
import { changeKey } from './session-changes-store.js';
import { changedEntries, changeTreeEntries, equalEntry, makeChangeTree, safeChangePath } from './session-changes-snapshot.js';
import { sessionChangePatchFiles } from './session-changes-tools.js';

export const receiptPatchesKey = (id) => `receipt-patches/${id}`;
export const revisionSegmentsKey = (id, revision) => `segments/${changeKey(id)}/${revision}`;
export const revisionSegmentKey = (id, revision, file, index) =>
  `${revisionSegmentsKey(id, revision)}/${changeKey(file)}/${String(index).padStart(10, '0')}.json`;

const MODES = new Set(['100644', '100755', '120000']);
const isObjectEntry = (value) => value !== null && typeof value === 'object'
  && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.oid) && MODES.has(value.mode);

// Most history replays repeat the same bounded array of native receipts. Hash
// their fields without creating a second serialized copy of the file contents
// so unchanged receipts do not launch Git processes or rewrite private trees.
export function receiptInputFingerprint(input) {
  if (!Array.isArray(input.files)) return null;
  const digest = crypto.createHash('sha256');
  const add = (value) => {
    if (typeof value === 'string') digest.update(`s${Buffer.byteLength(value)}:`).update(value);
    else digest.update(JSON.stringify(value ?? null));
    digest.update('\0');
  };
  add(input.complete !== false);
  for (const file of input.files) {
    if (!file || typeof file !== 'object') return null;
    if (typeof file.path !== 'string' || typeof file.patch !== 'string'
      && (!Object.hasOwn(file, 'before') || !Object.hasOwn(file, 'after'))) return null;
    add(file.path); add(file.oldPath); add(file.patch); add(file.before); add(file.after);
  }
  return digest.digest('hex');
}

export function receiptPath(directory, inputDirectory, canonicalInputDirectory, file) {
  if (typeof file !== 'string' || !file || file.includes('\0')) throw changeError('unsupported_path');
  const absolute = path.isAbsolute(file) && file.startsWith(`${inputDirectory}${path.sep}`)
    ? path.resolve(canonicalInputDirectory, path.relative(inputDirectory, file)) : path.resolve(canonicalInputDirectory, file);
  const relative = path.relative(directory, absolute);
  if (!safeChangePath(relative)) throw changeError('unsupported_path');
  return relative;
}

/** Object entries are for trusted execution adapters that already stored raw
 * blobs. HTTP/tool metadata adapters supply only textual execution receipts. */
export async function storeSessionChangeReceipt(repo, input, existing, canonicalInputDirectory) {
  const beforeFiles = new Map(), afterFiles = new Map(), seen = new Set(), patches = [];
  const observations = { before: new Map(), after: new Map() };
  if (existing?.state === 'complete' && existing.evidence !== 'exact' && !existing.historical) {
    for (const side of ['before', 'after']) if (existing[side]) {
      for await (const [file, entry] of changeTreeEntries(repo, existing[side])) observations[side].set(file, entry);
    }
  }
  let explicitModes = true, matchesObservation = existing?.state === 'complete' && existing.evidence !== 'exact' && !existing.historical, count = 0;
  const content = async (value) => {
    if (value === null) return null;
    if (typeof value === 'string') {
      explicitModes = false;
      return { oid: (await repo.run(['hash-object', '-w', '--stdin', '--no-filters'], { input: value })).toString().trim(), mode: '100644' };
    }
    if (!isObjectEntry(value) || (await repo.run(['cat-file', '-t', value.oid])).toString().trim() !== 'blob') throw changeError('invalid_change_receipt', 400);
    return { oid: value.oid, mode: value.mode };
  };
  const resolve = (file) => receiptPath(repo.directory, input.directory, canonicalInputDirectory, file);
  for await (const file of input.files) {
    count++;
    const relative = resolve(file.path), oldPath = file.oldPath ? resolve(file.oldPath) : relative;
    if (seen.has(relative) || (oldPath !== relative && seen.has(oldPath))) throw changeError('invalid_change_receipt', 400);
    seen.add(relative); seen.add(oldPath);
    if (typeof file.patch === 'string') {
      const parsed = sessionChangePatchFiles(file.patch, file.path);
      if (parsed.length !== 1 || resolve(parsed[0].path) !== relative
        || (parsed[0].oldPath && resolve(parsed[0].oldPath) !== oldPath)) throw changeError('invalid_change_receipt', 400);
      const patchOID = (await repo.run(['hash-object', '-w', '--stdin', '--no-filters'], { input: file.patch })).toString().trim();
      const parsedOldPath = parsed[0].oldPath ? resolve(parsed[0].oldPath) : null;
      patches.push({ file: relative, oldPath: parsedOldPath, patchOID, additions: parsed[0].additions,
        deletions: parsed[0].deletions, status: parsed[0].status });
      explicitModes = false; matchesObservation = false;
      continue;
    }
    const before = await content(file.before), after = await content(file.after);
    if (!equalEntry(observations.before.get(oldPath), before) || !equalEntry(observations.after.get(relative), after)) matchesObservation = false;
    if (before) beforeFiles.set(oldPath, before);
    if (after) afterFiles.set(relative, after);
  }
  if (!count) throw changeError('invalid_change_receipt', 400);
  const before = await makeChangeTree(repo, beforeFiles), after = await makeChangeTree(repo, afterFiles);
  const patchTree = patches.length ? await makeChangeTree(repo, patches.map((entry) => [`${changeKey(entry.file)}.patch`, { oid: entry.patchOID, mode: '100644' }])) : null;
  const complete = input.complete !== false;
  const receiptFingerprint = changeKey(JSON.stringify({ before, after, patches, complete }));
  if (existing?.evidence === 'exact') {
    if (existing.receiptFingerprint === receiptFingerprint) return null;
    // Repeated terminal delivery may enrich metadata, but cannot change the
    // already recorded edit for the same canonical call.
    throw changeError('receipt_conflict', 409);
  }
  const id = changeKey(`${input.sessionID}\0${input.callID}`);
  for await (const { key } of repo.db.entries(receiptPatchesKey(id))) repo.db.remove(key);
  for (const entry of patches) repo.db.set(`${receiptPatchesKey(id)}/${changeKey(entry.file)}.json`, entry);
  return { ...existing, id, sessionID: input.sessionID, messageID: input.messageID, callID: input.callID,
    createdAt: existing?.createdAt ?? input.createdAt ?? Date.now(), state: 'complete', before, after, patchTree,
    hasChanges: before !== after || patches.some((entry) => entry.additions || entry.deletions || entry.status === 'renamed'),
    evidence: 'exact', source: input.source ?? 'native-tool', tool: input.tool ?? null, receiptComplete: complete,
    receiptFingerprint, receiptInputFingerprint: input.receiptInputFingerprint ?? null,
    restoreVerified: complete && !patches.length && (explicitModes || matchesObservation),
    historical: input.historical === true, paths: null, errorCode: null };
}

export async function* exactSessionChanges(repo, op) {
  // Historical v1/v2 native receipts were already file-scoped, even when their
  // capture window overlapped. Snapshot-only records never acquire authority.
  if (op.evidence !== 'exact' && !op.historical) return;
  for await (const change of changedEntries(repo, op.before, op.after)) yield { ...change, beforeTree: op.before, afterTree: op.after };
  for await (const { value } of repo.db.entries(receiptPatchesKey(op.id))) yield { ...value, patchTree: op.patchTree };
}
