import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRecordStore } from './record-store.js';
import { withCrossProcessFileLock, writeFileAtomic } from './atomic-file.js';

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const failure = (code, status = 409) => Object.assign(new Error(code), { code, status });
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const safePath = (value) => typeof value === 'string' && value && !path.isAbsolute(value)
  && !value.split(/[\\/]/).some((part) => part === '..' || part === '.git');

// All Git writes target a private bare repository and disposable index. Never
// use the checkout's index, refs or object database for capture or composition.
const git = (cwd, args, { env, input, limit = 32 * 1024 * 1024 } = {}) => new Promise((resolve, reject) => {
  const child = spawn('git', args, { cwd, env: { ...process.env,
    GIT_DIR: undefined, GIT_COMMON_DIR: undefined, GIT_INDEX_FILE: undefined, GIT_WORK_TREE: undefined,
    GIT_OBJECT_DIRECTORY: undefined, GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
    GIT_OPTIONAL_LOCKS: '0', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const chunks = [];
  let size = 0;
  let exceeded = false;
  const timer = setTimeout(() => { exceeded = true; child.kill('SIGKILL'); }, 30_000);
  child.stdout.on('data', (chunk) => {
    size += chunk.length;
    if (size > limit) { exceeded = true; child.kill('SIGKILL'); } else chunks.push(chunk);
  });
  child.stderr.resume();
  child.on('error', (error) => { clearTimeout(timer); reject(error); });
  child.on('close', (code) => {
    clearTimeout(timer);
    if (exceeded) reject(failure('capture_limit', 503));
    else if (code !== 0) reject(failure('capture_git_failed', 503));
    else resolve(Buffer.concat(chunks));
  });
  child.stdin.on('error', () => {});
  child.stdin.end(input);
});

const diskBytes = async (directory) => {
  // Bounded parallel metadata reads avoid one disk round trip per loose Git
  // object. Missing temporary files are normal during another scope's cleanup.
  let size = 0;
  const pending = [{ file: directory, directory: true }];
  while (pending.length) {
    const batch = pending.splice(-64);
    await Promise.all(batch.map(async (entry) => {
      if (entry.directory) {
        const entries = await fs.readdir(entry.file, { withFileTypes: true }).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
        for (const child of entries) pending.push({ file: path.join(entry.file, child.name), directory: child.isDirectory() });
      } else {
        size += await fs.stat(entry.file).then((stat) => stat.size).catch((error) => { if (error.code === 'ENOENT') return 0; throw error; });
      }
    }));
  }
  return size;
};

export function createSessionChangeRuntime(options) {
  const storage = path.resolve(options.directory);
  const maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
  const maxOperations = options.maxOperations ?? 2000;
  const maxRevisions = options.maxRevisions ?? 20;
  const maxCaptureBytes = options.maxCaptureBytes ?? 64 * 1024 * 1024;
  const store = createRecordStore({ directory: path.join(storage, 'records'), maxReadBytes: 16 * 1024 * 1024,
    validateRecord: (record) => {
      if (!object(record) || record.version !== 1 || !Array.isArray(record.operations) || !Array.isArray(record.sessions)) throw failure('invalid_change_record');
      return record;
    } });
  const tails = new Map();
  const active = new Map();
  const serialize = (key, run) => {
    const operation = (tails.get(key) ?? Promise.resolve()).catch(() => {}).then(() =>
      withCrossProcessFileLock(path.join(storage, 'locks', `${hash(key)}.lock`), run, { timeoutMs: 60_000 }));
    const settled = operation.catch(() => {}).finally(() => { if (tails.get(key) === settled) tails.delete(key); });
    tails.set(key, settled);
    return operation;
  };
  const resolveDirectory = async (directory) => {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw failure('invalid_change_directory', 400);
    return fs.realpath((await git(directory, ['rev-parse', '--show-toplevel'])).toString().trim());
  };
  const load = async (directory) => {
    const key = hash(directory);
    const record = await store.readRecord(key) ?? { version: 1, directory, operations: [], sessions: [], issues: [], summaries: {} };
    for (const op of record.operations) {
      if (op.state !== 'pending' || active.has(op.id)) continue;
      let alive = false;
      if (op.ownerPID && op.ownerPID !== process.pid) {
        try { process.kill(op.ownerPID, 0); alive = true; } catch (error) { alive = error.code === 'EPERM'; }
      }
      if (!alive) {
        op.state = 'unavailable';
        if (!record.issues.some((entry) => entry.sessionID === op.sessionID && entry.code === 'capture_interrupted')) record.issues.push({ sessionID: op.sessionID, code: 'capture_interrupted' });
      }
    }
    record.revisions ??= {};
    record.generations ??= {};
    const gitDir = path.join(storage, key, 'git');
    try { await fs.access(path.join(gitDir, 'HEAD')); } catch {
      await fs.mkdir(gitDir, { recursive: true, mode: 0o700 });
      await git(storage, ['init', '--bare', gitDir]);
    }
    return { key, record, gitDir, directory };
  };
  const run = (repo, args, extra = {}) => git(storage, ['--git-dir', repo.gitDir, ...args], extra);
  const retain = async (repo, tree) => {
    await run(repo, ['update-ref', `refs/devryan/trees/${tree}`, tree]);
    return tree;
  };
  const withIndex = async (repo, fn) => {
    const index = path.join(storage, repo.key, `${crypto.randomUUID()}.index`);
    const env = { GIT_INDEX_FILE: index, GIT_WORK_TREE: repo.directory };
    try { return await fn(env); } finally {
      await fs.rm(index, { force: true });
      await fs.rm(`${index}.lock`, { force: true });
    }
  };
  const snapshot = async (repo) => {
    const list = (await git(repo.directory, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).toString().split('\0');
    const files = [];
    const stats = new Map();
    const cachePath = path.join(storage, repo.key, 'stat-cache.json');
    let cachedSnapshot = {};
    try {
      if ((await fs.stat(cachePath)).size <= 16 * 1024 * 1024) cachedSnapshot = JSON.parse(await fs.readFile(cachePath, 'utf8'));
    } catch { /* Cache loss only requires rehashing raw bytes. */ }
    const cache = object(cachedSnapshot?.files) ? cachedSnapshot.files : {};
    const cached = (file) => cache[file]?.signature === signature(stats.get(file)) && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(cache[file]?.oid);
    const nextCache = Object.create(null);
    const signature = (stat) => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
    let bytes = 0;
    const candidates = [...new Set(list.filter(Boolean))];
    for (let offset = 0; offset < candidates.length; offset += 64) {
      const batch = candidates.slice(offset, offset + 64);
      const observed = await Promise.all(batch.map(async (file) => {
        if (!safePath(file)) throw failure('unsupported_path');
        try { return await fs.lstat(path.join(repo.directory, file), { bigint: true }); }
        catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      }));
      for (let index = 0; index < batch.length; index++) {
        const stat = observed[index];
        if (!stat) continue;
        if (!stat.isFile() && !stat.isSymbolicLink()) throw failure('unsupported_file_type');
        bytes += Number(stat.size);
        if (bytes > maxCaptureBytes || files.length >= 50_000) throw failure('capture_limit');
        files.push(batch[index]); stats.set(batch[index], stat);
      }
    }
    if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(cachedSnapshot?.tree) && files.length === Object.keys(cache).length && files.every(cached)) return cachedSnapshot.tree;
    return withCrossProcessFileLock(path.join(storage, 'quota.lock'), async () => {
      if (await diskBytes(storage) + bytes > maxBytes) throw failure('storage_limit');
      // Hash raw bytes, bypassing checkout attributes/clean filters. Otherwise
      // CRLF and custom filters make captured objects differ from the bytes
      // that restore verifies and writes. Git batches these bounded reads.
      const regular = files.filter((file) => stats.get(file).isFile() && !cached(file));
      const oids = regular.length ? (await run(repo, ['hash-object', '-w', '--no-filters', '--stdin-paths'],
        { input: regular.map((file) => JSON.stringify(path.join(repo.directory, file))).join('\n') + '\n' })).toString().trim().split('\n') : [];
      const hashes = new Map(regular.map((file, index) => [file, oids[index]]));
      const entries = [];
      for (const file of files) {
        const stat = stats.get(file);
        // hash-object follows links; store the link target itself instead.
        const oid = cached(file) ? cache[file].oid : stat.isSymbolicLink() ? (await run(repo, ['hash-object', '-w', '--no-filters', '--stdin'],
          { input: await fs.readlink(path.join(repo.directory, file)) })).toString().trim() : hashes.get(file);
        entries.push([file, { oid, mode: stat.isSymbolicLink() ? '120000' : stat.mode & 0o111n ? '100755' : '100644' }]);
        // Reuse only if no writer changed the file while its bytes were read.
        if (cached(file) || signature(await fs.lstat(path.join(repo.directory, file), { bigint: true })) === signature(stat)) nextCache[file] = { signature: signature(stat), oid };
      }
      const tree = await makeTree(repo, entries);
      await writeFileAtomic(cachePath, JSON.stringify({ tree, files: nextCache }));
      return tree;
    }, { timeoutMs: 60_000 });
  };
  const treeEntries = async (repo, tree) => {
    const entries = new Map();
    for (const row of (await run(repo, ['ls-tree', '-r', '-z', tree])).toString().split('\0').filter(Boolean)) {
      const tab = row.indexOf('\t');
      const [mode, type, oid] = row.slice(0, tab).split(' ');
      if (type !== 'blob') throw failure('unsupported_file_type');
      entries.set(row.slice(tab + 1), { mode, oid });
    }
    return entries;
  };
  const equal = (a, b) => a?.oid === b?.oid && a?.mode === b?.mode;
  const changed = async (repo, before, after) => {
    if (before === after) return [];
    const a = await treeEntries(repo, before);
    const b = await treeEntries(repo, after);
    return [...new Set([...a.keys(), ...b.keys()])].filter((file) => !equal(a.get(file), b.get(file)))
      .map((file) => ({ file, before: a.get(file) ?? null, after: b.get(file) ?? null }));
  };
  const issue = (record, sessionID, code) => {
    if (!record.issues.some((entry) => entry.sessionID === sessionID && entry.code === code)) record.issues.push({ sessionID, code });
  };
  const save = (repo) => {
    // Never write a record that the guarded reader would later quarantine.
    if (Buffer.byteLength(JSON.stringify(repo.record, null, 2)) > 15 * 1024 * 1024) throw failure('storage_limit', 503);
    return store.writeRecord(repo.key, repo.record);
  };
  const noteSession = (record, input) => {
    if (record.sessions.some((entry) => entry.id === input.sessionID)) return;
    if (record.sessions.length >= 2000) throw failure('storage_limit');
    record.sessions.push({ id: input.sessionID, parentID: input.parentID ?? null, firstUserMessageID: input.userMessageID ?? null });
  };
  const begin = async (input) => {
    const deadline = input.captureDeadline ?? Date.now() + 30_000;
    const directory = await resolveDirectory(input.directory);
    return serialize(directory, async () => {
      const repo = await load(directory);
      noteSession(repo.record, input);
      const id = hash(`${input.sessionID}\0${input.callID}`);
      const existing = repo.record.operations.find((op) => op.id === id);
      if (existing) {
        if (existing.messageID !== input.messageID) { issue(repo.record, input.sessionID, 'capture_identity_reused'); await save(repo); }
        return;
      }
      const inputDirectory = await fs.realpath(input.directory);
      const paths = Array.isArray(input.paths) && input.paths.length ? input.paths.map((file) => {
        const absolute = path.isAbsolute(file) && file.startsWith(`${input.directory}${path.sep}`)
          ? path.resolve(inputDirectory, path.relative(input.directory, file)) : path.resolve(inputDirectory, file);
        const relative = path.relative(directory, absolute);
        if (!safePath(relative)) throw failure('unsupported_path');
        return relative;
      }) : null;
      const overlaps = repo.record.operations.filter((op) => op.state === 'pending'
        && (!paths || !op.paths || paths.some((file) => op.paths.includes(file))));
      for (const previous of overlaps) previous.overlap = true;
      const op = { id, sessionID: input.sessionID, messageID: input.messageID, callID: input.callID,
        state: 'pending', paths, ownerPID: process.pid, overlap: overlaps.length > 0, createdAt: Date.now() };
      if (repo.record.operations.length >= maxOperations) { issue(repo.record, input.sessionID, 'storage_limit'); await save(repo); return; }
      repo.record.operations.push(op);
      active.set(id, directory);
      try {
        if (Date.now() >= deadline) throw failure('capture_timeout');
        op.before = await snapshot(repo);
        if (Date.now() >= deadline) throw failure('capture_timeout');
      } catch (error) { op.state = 'unavailable'; issue(repo.record, input.sessionID, error.code ?? 'capture_failed'); active.delete(id); }
      await save(repo);
    });
  };
  const finish = async (input) => {
    const directory = await resolveDirectory(input.directory);
    return serialize(directory, async () => {
      const repo = await load(directory);
      const id = hash(`${input.sessionID}\0${input.callID}`);
      const op = repo.record.operations.find((entry) => entry.id === id);
      if (!op) { noteSession(repo.record, input); issue(repo.record, input.sessionID, 'missing_capture'); await save(repo); return; }
      if (input.messageID && input.messageID !== op.messageID) throw failure('capture_identity_mismatch');
      if (op.state !== 'pending') return;
      try {
        op.after = await snapshot(repo);
        op.changes = (await changed(repo, op.before, op.after)).filter((change) => !op.paths || op.paths.includes(change.file));
        op.state = 'complete';
        if (op.overlap && op.changes.length) issue(repo.record, input.sessionID, 'overlapping_operations');
      } catch (error) { op.state = 'unavailable'; issue(repo.record, input.sessionID, error.code ?? 'capture_failed'); }
      active.delete(id);
      await save(repo);
      await options.onChange?.({ directory, sessionID: input.sessionID });
    });
  };
  const importHistorical = async (inputs) => {
    if (!inputs.length) return;
    const directory = await resolveDirectory(inputs[0].directory);
    const inputDirectory = await fs.realpath(inputs[0].directory);
    return serialize(directory, async () => {
      const repo = await load(directory);
      const known = new Set(repo.record.operations.map((op) => op.id));
      const pending = inputs.filter((input) => !known.has(hash(`${input.sessionID}\0${input.callID}`)));
      if (!pending.length) return;
      await withCrossProcessFileLock(path.join(storage, 'quota.lock'), async () => {
      let availableBytes = maxBytes - await diskBytes(storage);
      for (const input of pending) {
        const id = hash(`${input.sessionID}\0${input.callID}`);
        if (known.has(id) || input.directory !== inputs[0].directory || !Array.isArray(input.files) || !input.files.length) continue;
        const changes = [];
        let bytes = 0;
        for (const file of input.files) {
          const candidate = path.isAbsolute(file.path) && file.path.startsWith(`${input.directory}${path.sep}`)
            ? path.resolve(inputDirectory, path.relative(input.directory, file.path))
            : path.resolve(inputDirectory, file.path);
          const relative = path.relative(directory, candidate);
          if (!safePath(relative) || ![file.before, file.after].every((content) => content === null || typeof content === 'string')) break;
          bytes += Buffer.byteLength(file.before ?? '') + Buffer.byteLength(file.after ?? '');
          if (bytes > maxCaptureBytes) break;
          changes.push({ file: relative, before: file.before, after: file.after });
        }
        if (changes.length !== input.files.length) continue;
        noteSession(repo.record, input);
        if (repo.record.operations.length >= maxOperations || availableBytes < bytes + 4096) {
          issue(repo.record, input.sessionID, 'storage_limit'); continue;
        }
        availableBytes -= bytes + 4096;
        for (const change of changes) {
          for (const side of ['before', 'after']) {
            if (change[side] === null) continue;
            const oid = (await run(repo, ['hash-object', '-w', '--stdin', '--no-filters'], { input: change[side] })).toString().trim();
            change[side] = { oid, mode: '100644' };
          }
        }
        const before = await makeTree(repo, changes.map((change) => [change.file, change.before]));
        const after = await makeTree(repo, changes.map((change) => [change.file, change.after]));
        repo.record.operations.push({ id, sessionID: input.sessionID, messageID: input.messageID, callID: input.callID,
          createdAt: input.createdAt, state: 'complete', changes, before, after, historical: true });
        known.add(id);
        // Text receipts recover review content, but do not prove historical
        // modes or capture completeness needed for whole-session Undo.
        issue(repo.record, input.sessionID, 'historical_restore_unavailable');
      }
      await save(repo);
      }, { timeoutMs: 60_000 });
    });
  };
  const makeTree = (repo, files) => withIndex(repo, async (env) => {
    await run(repo, ['read-tree', '--empty'], { env });
    const input = files.filter(([, entry]) => entry).map(([file, entry]) => `${entry.mode} ${entry.oid}\t${file}\0`).join('');
    if (input) await run(repo, ['update-index', '-z', '--index-info'], { env, input });
    return retain(repo, (await run(repo, ['write-tree'], { env })).toString().trim());
  });
  const archiveSummary = (repo, rootSessionID, stored) => {
    if (!stored) return;
    const revisions = repo.record.revisions[rootSessionID] ?? [];
    if (!revisions.some((entry) => entry.summary.revision === stored.summary.revision)) revisions.push(structuredClone(stored));
    while (revisions.length > maxRevisions || Buffer.byteLength(JSON.stringify(revisions)) > 4 * 1024 * 1024) revisions.shift();
    repo.record.revisions[rootSessionID] = revisions;
  };
  const summarize = async ({ directory: requestedDirectory, rootSessionID, sessions = [], firstUserMessageID = null, coverageReasons = [], expectedCalls = [], hiddenMessages = [] }) => {
    const directory = await resolveDirectory(requestedDirectory);
    return serialize(directory, async () => {
      const repo = await load(directory);
      const savedSummary = repo.record.summaries[rootSessionID];
      const ids = new Set([rootSessionID, ...sessions.map((entry) => entry.id)]);
      // Retain verified child membership after a child is deleted upstream.
      let expanded = true;
      while (expanded) { expanded = false; for (const entry of repo.record.sessions) {
        if (ids.has(entry.parentID) && !ids.has(entry.id)) { ids.add(entry.id); expanded = true; }
      }
      for (const op of repo.record.operations) {
        if (ids.has(op.ownerSessionID) && !ids.has(op.sessionID)) { ids.add(op.sessionID); expanded = true; }
      } }
      const hidden = new Set(hiddenMessages.map((entry) => `${entry.sessionID}\0${entry.messageID}`));
      const ops = repo.record.operations.filter((entry) => ids.has(entry.sessionID) && !entry.undone && !hidden.has(`${entry.sessionID}\0${entry.messageID}`))
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
      const reasons = new Set([...coverageReasons, ...repo.record.issues.filter((entry) => ids.has(entry.sessionID)).map((entry) => entry.code)]);
      if (!repo.record.sessions.some((entry) => entry.id === rootSessionID)) reasons.add('historical_capture_unavailable');
      const firstCaptured = repo.record.sessions.find((entry) => entry.id === rootSessionID)?.firstUserMessageID;
      if (firstUserMessageID && firstCaptured !== firstUserMessageID) reasons.add('historical_capture_unavailable');
      const capturedIDs = new Set(repo.record.operations.map((op) => op.id));
      if (expectedCalls.some((call) => !capturedIDs.has(hash(`${call.sessionID}\0${call.callID}`)))) reasons.add('missing_capture');
      if (savedSummary?.undone && !reasons.size && ops.every((op) => op.state === 'complete' && !op.changes.length)) {
        if (ops.length) {
          for (const op of ops) op.undone = true;
          savedSummary.operationIDs = [...new Set([...savedSummary.operationIDs, ...ops.map((op) => op.id)])];
          await save(repo);
        }
        return { ...savedSummary.summary, undone: true, files: [] };
      }
      const sourceFingerprint = hash(JSON.stringify({ ids: [...ids].sort(),
        operations: ops.map((op) => [op.id, op.state, op.overlap]), reasons: [...reasons].sort(),
        firstUserMessageID, generation: repo.record.generations[rootSessionID] ?? 0, directory: requestedDirectory }));
      if (savedSummary?.sourceFingerprint === sourceFingerprint) return savedSummary.summary;
      const files = new Map();
      const excluded = new Set();
      for (const op of ops) {
        if (op.state !== 'complete') { reasons.add(op.state === 'pending' ? 'capture_pending' : 'capture_unavailable'); continue; }
        for (const change of op.changes) {
          if (op.overlap) { excluded.add(change.file); continue; }
          const previous = files.get(change.file);
          if (previous && !equal(previous.after, change.before)) { excluded.add(change.file); reasons.add('interleaved_file_changes'); continue; }
          files.set(change.file, { before: previous ? previous.before : change.before, after: change.after,
            sessions: [...new Set([...(previous?.sessions ?? []), op.sessionID])] });
        }
      }
      for (const file of excluded) files.delete(file);
      for (const [file, value] of files) if (equal(value.before, value.after)) files.delete(file);
      const before = await makeTree(repo, [...files].map(([file, value]) => [file, value.before]));
      const after = await makeTree(repo, [...files].map(([file, value]) => [file, value.after]));
      const rows = [];
      const tokens = (await run(repo, ['diff', '--no-ext-diff', '--no-textconv', '--find-renames', '--numstat', '-z', before, after])).toString().split('\0');
      for (let i = 0; i < tokens.length; i++) {
        if (!tokens[i]) continue;
        const [added, deleted, ...name] = tokens[i].split('\t');
        let file = name.join('\t');
        let oldPath = null;
        if (!file) { oldPath = tokens[++i]; file = tokens[++i]; }
        const entry = files.get(file);
        rows.push({ path: file, oldPath, status: oldPath ? 'renamed' : !entry.before ? 'added' : !entry.after ? 'deleted' : 'modified',
          additions: added === '-' ? null : Number(added), deletions: deleted === '-' ? null : Number(deleted),
          sessions: [...new Set([...(entry?.sessions ?? []), ...(oldPath ? files.get(oldPath)?.sessions ?? [] : [])])] });
      }
      const result = { rootSessionID, directory: requestedDirectory, worktreeDirectory: directory, worktreeID: repo.key,
        files: rows, sessionCount: ids.size, firstUserMessageID: firstUserMessageID ?? repo.record.sessions.find((entry) => entry.id === rootSessionID)?.firstUserMessageID ?? null,
        coverage: reasons.size ? 'partial' : 'complete', reasons: [...reasons].sort(), hasUnattributedMutations: false };
      const revision = hash(JSON.stringify({ before, after, result, generation: repo.record.generations[rootSessionID] ?? 0 }));
      const summary = { ...result, revision };
      if (savedSummary?.summary.revision === revision) {
        savedSummary.operationIDs = ops.map((op) => op.id);
        savedSummary.sourceFingerprint = sourceFingerprint;
        await save(repo);
        return savedSummary.summary;
      }
      archiveSummary(repo, rootSessionID, savedSummary);
      repo.record.summaries[rootSessionID] = { summary, before, after, sourceFingerprint, operationIDs: ops.map((op) => op.id) };
      await save(repo);
      return summary;
    });
  };
  const diff = async ({ directory: requested, rootSessionID, revision, file }) => {
    const directory = await resolveDirectory(requested);
    return serialize(directory, async () => {
      const repo = await load(directory);
      const current = repo.record.summaries[rootSessionID];
      const stored = current?.summary.revision === revision ? current : repo.record.revisions[rootSessionID]?.find((entry) => entry.summary.revision === revision);
      if (!stored) throw failure('summary_detail_expired', 410);
      const row = stored.summary.files.find((entry) => entry.path === file);
      if (!row) throw failure('summary_file_not_found', 404);
      const patch = await run(repo, ['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', stored.before, stored.after, '--', ...(row.oldPath ? [row.oldPath] : []), row.path]);
      return { rootSessionID, revision, path: file, patch: patch.toString() };
    });
  };
  const registerSession = async (input) => {
    const directory = await resolveDirectory(input.directory);
    return serialize(directory, async () => { const repo = await load(directory); noteSession(repo.record, input); await save(repo); });
  };
  // Card Undo is a filesystem transaction over the exact reviewed revision.
  // It deliberately does not invoke OpenCode's worktree-wide native revert.
  const restore = async ({ directory: requested, rootSessionID, revision, redo = false }) => {
    const directory = await resolveDirectory(requested);
    return serialize(directory, async () => {
      const repo = await load(directory);
      const stored = repo.record.summaries[rootSessionID];
      if (!stored || stored.summary.revision !== revision) throw failure('summary_revision_changed');
      if (stored.summary.coverage !== 'complete') throw failure('summary_incomplete');
      if (repo.record.operations.some((op) => op.state === 'pending')) throw failure('directory_busy');
      const from = await treeEntries(repo, redo ? stored.before : stored.after);
      const to = await treeEntries(repo, redo ? stored.after : stored.before);
      const paths = [...new Set([...from.keys(), ...to.keys()])];
      const inspect = async (file) => {
        // Never follow an ancestor symlink on restore.
        let parent = path.dirname(path.join(directory, file));
        while (parent !== directory) {
          const stat = await fs.lstat(parent).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
          if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw failure('unsupported_path');
          parent = path.dirname(parent);
        }
        const target = path.join(directory, file);
        const stat = await fs.lstat(target).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
        if (!stat) return null;
        if (!stat.isFile() && !stat.isSymbolicLink()) throw failure('working_tree_changed');
        if (stat.size > maxCaptureBytes) throw failure('capture_limit');
        const content = stat.isSymbolicLink() ? Buffer.from(await fs.readlink(target)) : await fs.readFile(target);
        const oid = (await run(repo, ['hash-object', '--stdin', '--no-filters'], { input: content })).toString().trim();
        return { oid, mode: stat.isSymbolicLink() ? '120000' : stat.mode & 0o111 ? '100755' : '100644' };
      };
      for (const file of paths) if (!equal(await inspect(file), from.get(file))) throw failure('working_tree_changed');
      const write = async (file, entry) => {
        const target = path.join(directory, file);
        if (!entry) { await fs.rm(target, { force: true }); return; }
        const content = await run(repo, ['cat-file', 'blob', entry.oid], { limit: maxCaptureBytes });
        await fs.mkdir(path.dirname(target), { recursive: true });
        const temp = `${target}.devryan-${crypto.randomUUID()}`;
        try {
          if (entry.mode === '120000') await fs.symlink(content.toString(), temp);
          else await fs.writeFile(temp, content, { mode: entry.mode === '100755' ? 0o755 : 0o644, flag: 'wx' });
          await fs.rename(temp, target);
        } finally { await fs.rm(temp, { force: true }); }
      };
      const written = [];
      try {
        for (const file of paths) {
          if (!equal(await inspect(file), from.get(file))) throw failure('working_tree_changed');
          written.push(file); await write(file, to.get(file));
        }
        for (const file of paths) if (!equal(await inspect(file), to.get(file))) throw failure('restore_verification_failed');
        archiveSummary(repo, rootSessionID, stored);
        repo.record.generations[rootSessionID] = (repo.record.generations[rootSessionID] ?? 0) + 1;
        for (const op of repo.record.operations) if (stored.operationIDs.includes(op.id)) op.undone = !redo;
        stored.undone = !redo;
        stored.summary = { ...stored.summary, revision: hash(`${revision}\0${redo}\0${Date.now()}`) };
        await save(repo);
      } catch (error) {
        const rollback = await Promise.allSettled(written.reverse().map(async (file) => {
          const current = await inspect(file);
          if (equal(current, from.get(file))) return;
          if (!equal(current, to.get(file))) throw failure('working_tree_changed');
          await write(file, from.get(file));
          if (!equal(await inspect(file), from.get(file))) throw failure('rollback_failed');
        }));
        if (rollback.some((entry) => entry.status === 'rejected')) throw failure('rollback_failed', 500);
        throw error;
      }
      return { undone: !redo };
    });
  };
  const deleteSession = async (sessionID) => {
    for (const { record } of await store.listRecords()) {
      if (!record.sessions.some((entry) => entry.id === sessionID) && !record.operations.some((op) => op.sessionID === sessionID || op.ownerSessionID === sessionID)) continue;
      await serialize(record.directory, async () => {
      const repo = await load(record.directory);
      for (const op of repo.record.operations) if (op.sessionID === sessionID) {
        active.delete(op.id);
        if (op.state === 'pending') { op.state = 'unavailable'; issue(repo.record, sessionID, 'capture_interrupted'); }
      }
      const parentID = repo.record.sessions.find((entry) => entry.id === sessionID)?.parentID;
      if (parentID && repo.record.sessions.some((entry) => entry.id === parentID)) {
        // A child's completed contribution belongs to its parent's historical
        // review. Remove direct child access while retaining that contribution.
        for (const op of repo.record.operations) if (op.sessionID === sessionID || op.ownerSessionID === sessionID) op.ownerSessionID = parentID;
      } else {
        const removed = new Set([sessionID]);
        let size;
        do {
          size = removed.size;
          for (const entry of repo.record.sessions) if (removed.has(entry.parentID)) removed.add(entry.id);
          for (const op of repo.record.operations) if (removed.has(op.ownerSessionID)) removed.add(op.sessionID);
        } while (removed.size !== size);
        for (const op of repo.record.operations) if (removed.has(op.sessionID)) active.delete(op.id);
        repo.record.operations = repo.record.operations.filter((op) => !removed.has(op.sessionID));
        repo.record.sessions = repo.record.sessions.filter((entry) => !removed.has(entry.id));
        repo.record.issues = repo.record.issues.filter((entry) => !removed.has(entry.sessionID));
        for (const id of removed) { delete repo.record.summaries[id]; delete repo.record.revisions[id]; delete repo.record.generations[id]; }
      }
      repo.record.sessions = repo.record.sessions.filter((entry) => entry.id !== sessionID);
      delete repo.record.summaries[sessionID];
      delete repo.record.revisions[sessionID];
      delete repo.record.generations[sessionID];
      if (!repo.record.sessions.length && !repo.record.operations.length) {
        await store.deleteRecord(repo.key);
        await fs.rm(path.join(storage, repo.key), { recursive: true, force: true });
        return;
      }
      await save(repo);
      const trees = new Set(repo.record.operations.flatMap((op) => [op.before, op.after]).filter(Boolean));
      for (const summary of [...Object.values(repo.record.summaries), ...Object.values(repo.record.revisions).flat()]) { trees.add(summary.before); trees.add(summary.after); }
      const refs = (await run(repo, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/devryan/trees/'])).toString().trim().split('\n');
      for (const row of refs) {
        const [ref, tree] = row.split(' ');
        if (ref && !trees.has(tree)) await run(repo, ['update-ref', '-d', ref]);
      }
      await fs.rm(path.join(storage, repo.key, 'stat-cache.json'), { force: true });
      await run(repo, ['gc', '--prune=now']);
      });
    }
  };
  return { begin, finish, importHistorical, registerSession, summarize, diff, restore, deleteSession,
    async drain() { await Promise.all([...tails.values()]); await store.drain(); },
    async observe(event, directory) {
      const part = event?.properties?.part;
      if (part?.type === 'tool' && ['completed', 'error'].includes(part.state?.status)) {
        const id = hash(`${part.sessionID}\0${part.callID}`);
        const capturedDirectory = active.get(id);
        if (capturedDirectory) await finish({ directory: capturedDirectory, sessionID: part.sessionID, callID: part.callID });
      }
      if (event?.type === 'session.deleted') await deleteSession(event.properties.info.id);
      void directory;
    },
  };
}
