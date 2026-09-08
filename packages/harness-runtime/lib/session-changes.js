import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { withCrossProcessFileLock } from './atomic-file.js';
import { git, gitToFile, gitTokens, changeError as failure } from './session-changes-git.js';
import { openChangeStore, changeKey as hash } from './session-changes-store.js';
import { captureSnapshot, changedEntries, changeTreeEntries, equalEntry as equal,
  makeChangeTree as makeTree, safeChangePath as safePath, verifyAncestors } from './session-changes-snapshot.js';

const sessionKey = (id) => `sessions/${hash(id)}.json`;
const operationKey = (id) => `operations/${id}.json`;
const timelineKey = (op) => `timeline/${String(op.createdAt).padStart(16, '0')}-${op.id}.json`;
const summaryKey = (id) => `summaries/${hash(id)}.json`;
const revisionKey = (id, revision) => `revisions/${hash(id)}/${revision}.json`;
const rowsKey = (id, revision) => `rows/${hash(id)}/${revision}`;
const membersKey = (id, revision) => `members/${hash(id)}/${revision}`;
const normalizedError = (error) => ['ENOSPC', 'EDQUOT', 'EIO', 'EROFS'].includes(error?.code) ? 'storage_unavailable' : error?.code ?? 'capture_failed';
const DIFF_BYTES = 64 * 1024;

export function createSessionChangeRuntime(options) {
  const storage = path.resolve(options.directory);
  const tails = new Map(), active = new Map();
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
  const putOperation = (repo, op) => {
    const value = { ...op }; delete value.changes;
    repo.db.set(operationKey(op.id), value);
    repo.db.set(timelineKey(op), value);
    const pendingKey = `pending/${op.id}.json`;
    if (op.state === 'pending') repo.db.set(pendingKey, value); else repo.db.remove(pendingKey);
  };
  const noteSession = async (repo, input) => {
    const key = sessionKey(input.sessionID);
    const existing = await repo.db.get(key);
    if (existing) return existing;
    const value = { id: input.sessionID, parentID: input.parentID ?? null, firstUserMessageID: input.userMessageID ?? null, issues: [] };
    repo.db.set(key, value);
    return value;
  };
  const issue = async (repo, id, code) => {
    const entry = await noteSession(repo, { sessionID: id });
    if (!entry.issues.includes(code)) { entry.issues.push(code); repo.db.set(sessionKey(id), entry); }
  };
  const saveSummary = async (repo, id, stored, files, members) => {
    const revision = stored.summary.revision;
    if (files) await repo.db.setList(rowsKey(id, revision), files);
    if (members) await repo.db.setList(membersKey(id, revision), members);
    repo.db.set(summaryKey(id), stored);
    repo.db.set(revisionKey(id, revision), stored);
  };
  const migrate = async (repo) => {
    const legacyPath = path.join(storage, 'records', `${repo.key}.json`);
    let legacy;
    try {
      // V1 guarded its records to 16 MiB. Read this one-time, bounded input only;
      // the original remains intact until the new atomic state is verified.
      if ((await fs.stat(legacyPath)).size > 16 * 1024 * 1024) throw failure('invalid_change_record', 503);
      legacy = JSON.parse(await fs.readFile(legacyPath, 'utf8')).record;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (legacy) {
      if (legacy.version !== 1 || legacy.directory !== repo.directory || !Array.isArray(legacy.operations) || !Array.isArray(legacy.sessions)) throw failure('invalid_change_record');
      for (const entry of legacy.sessions) repo.db.set(sessionKey(entry.id), { ...entry, issues: [] });
      const emptyTree = await makeTree(repo, []);
      for (const op of legacy.operations) {
        if (op.state === 'complete' && Array.isArray(op.changes)) {
          op.before = op.changes.length ? await makeTree(repo, op.changes.map((entry) => [entry.file, entry.before])) : emptyTree;
          op.after = op.changes.length ? await makeTree(repo, op.changes.map((entry) => [entry.file, entry.after])) : emptyTree;
        }
        const related = (legacy.issues ?? []).filter((entry) => entry.sessionID === op.sessionID);
        putOperation(repo, { ...op, hasChanges: Boolean(op.changes?.length),
          errorCode: op.state === 'unavailable' ? related.find((entry) => ['capture_limit', 'storage_limit', 'capture_timeout'].includes(entry.code))?.code ?? 'capture_unavailable' : null });
      }
      for (const entry of legacy.issues ?? []) {
        // Move capture failures onto the failed calls so exact receipt repair
        // can resolve them individually, without clearing unrelated gaps.
        if (['capture_limit', 'storage_limit', 'capture_unavailable'].includes(entry.code)
          && legacy.operations.some((op) => op.sessionID === entry.sessionID && op.state === 'unavailable')) continue;
        await issue(repo, entry.sessionID, entry.code);
      }
      for (const [id, current] of Object.entries(legacy.summaries ?? {})) {
        for (const stored of [...(legacy.revisions?.[id] ?? []), current]) {
          const { files, ...summary } = stored.summary;
          const value = { ...stored, summary: { ...summary, fileCount: files.length } }; delete value.operationIDs;
          await saveSummary(repo, id, value, files, stored.operationIDs ?? []);
        }
      }
      for (const [id, generation] of Object.entries(legacy.generations ?? {})) repo.db.set(`generations/${hash(id)}.json`, generation);
    }
    repo.db.set('meta.json', { version: 2, directory: repo.directory, completedSinceMaintenance: 0, migrated: Boolean(legacy) });
    await repo.db.commit();
    // Reopen from the committed tree; a failed verification leaves V1 intact.
    const verified = await openChangeStore(storage, repo.gitDir);
    if ((await verified.get('meta.json'))?.version !== 2) throw failure('change_migration_failed', 503);
    if (legacy) {
      let operations = 0;
      for await (const entry of verified.entries('operations')) { void entry; operations++; }
      if (operations !== legacy.operations.length) throw failure('change_migration_failed', 503);
    }
  };
  const load = async (directory) => {
    const key = hash(directory), gitDir = path.join(storage, key, 'git');
    try { await fs.access(path.join(gitDir, 'HEAD')); } catch {
      await fs.mkdir(gitDir, { recursive: true, mode: 0o700 }); await git(storage, ['init', '--bare', gitDir]);
    }
    const repo = { key, directory, storage, gitDir, run: (args, extra) => git(storage, ['--git-dir', gitDir, ...args], extra),
      db: await openChangeStore(storage, gitDir) };
    if (!repo.db.exists) await migrate(repo);
    for await (const { value: op } of repo.db.entries('pending')) {
      if (active.has(op.id)) continue;
      let alive = false;
      if (op.ownerPID && op.ownerPID !== process.pid) {
        try { process.kill(op.ownerPID, 0); alive = true; } catch (error) { alive = error.code === 'EPERM'; }
      }
      if (!alive) { op.state = 'unavailable'; op.errorCode = 'capture_interrupted'; putOperation(repo, op); }
    }
    await repo.db.commit();
    return repo;
  };
  const collect = async (repo) => {
    // A worktree lock covers capture, restore and collection. Metadata refs
    // commit before obsolete content refs are dropped. Cache invalidation must
    // precede pruning, including if collection is interrupted.
    const trees = new Set();
    for await (const { value: op } of repo.db.entries('operations')) {
      if (op.before) trees.add(op.before); if (op.after) trees.add(op.after);
    }
    for await (const { value: stored } of repo.db.entries('revisions')) { trees.add(stored.before); trees.add(stored.after); }
    await fs.rm(path.join(storage, repo.key, 'stat-cache'), { recursive: true, force: true });
    await fs.rm(path.join(storage, repo.key, 'stat-cache.json'), { force: true });
    for await (const row of gitTokens(storage, ['--git-dir', repo.gitDir, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/devryan/trees/'], { delimiter: 10 })) {
      const [ref, tree] = row.split(' ');
      if (ref && !trees.has(tree)) await repo.run(['update-ref', '-d', ref]);
    }
    await repo.run(['gc', '--prune=now'], { timeoutMs: 120_000 });
    await fs.rm(path.join(storage, repo.key, 'diffs'), { recursive: true, force: true });
  };
  const maintain = async (repo) => {
    const meta = await repo.db.get('meta.json');
    meta.completedSinceMaintenance = (meta.completedSinceMaintenance ?? 0) + 1;
    repo.db.set('meta.json', meta); await repo.db.commit();
    if (meta.completedSinceMaintenance < (options.maintenanceEvery ?? 128)) return;
    await collect(repo);
    meta.completedSinceMaintenance = 0; repo.db.set('meta.json', meta); await repo.db.commit();
  };
  const checkExplicitQuota = async () => {
    if (!Number.isFinite(options.maxBytes)) return;
    let bytes = 0;
    const scan = async (directory) => {
      for await (const entry of await fs.opendir(directory)) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await scan(file);
        else bytes += (await fs.stat(file).catch((error) => { if (error.code === 'ENOENT') return { size: 0 }; throw error; })).size;
        if (bytes > options.maxBytes) throw failure('storage_limit');
      }
    };
    await scan(storage);
  };
  const begin = async (input) => {
    const deadline = input.captureDeadline ?? Date.now() + 30_000;
    const directory = await resolveDirectory(input.directory);
    return serialize(directory, async () => {
      const repo = await load(directory);
      await noteSession(repo, input);
      const id = hash(`${input.sessionID}\0${input.callID}`), existing = await repo.db.get(operationKey(id));
      if (existing) {
        if (existing.messageID !== input.messageID) { await issue(repo, input.sessionID, 'capture_identity_reused'); await repo.db.commit(); }
        return;
      }
      const inputDirectory = await fs.realpath(input.directory);
      const paths = Array.isArray(input.paths) && input.paths.length ? [...new Set(input.paths.map((file) => {
        const absolute = path.isAbsolute(file) && file.startsWith(`${input.directory}${path.sep}`)
          ? path.resolve(inputDirectory, path.relative(input.directory, file)) : path.resolve(inputDirectory, file);
        const relative = path.relative(directory, absolute);
        if (!safePath(relative)) throw failure('unsupported_path');
        return relative;
      }))] : null;
      let overlap = false;
      for await (const { value: previous } of repo.db.entries('pending')) {
        if (!paths || !previous.paths || paths.some((file) => previous.paths.includes(file))) {
          previous.overlap = true; putOperation(repo, previous); overlap = true;
        }
      }
      const op = { id, sessionID: input.sessionID, messageID: input.messageID, callID: input.callID,
        state: 'pending', paths, ownerPID: process.pid, overlap, createdAt: Date.now() };
      active.set(id, directory);
      try {
        // Optional explicit quotas remain for embedders and fault fixtures;
        // production has no cumulative byte/count admission ceiling.
        if (Number.isFinite(options.maxOperations)) {
          let count = 0; for await (const entry of repo.db.entries('operations')) { void entry; count++; }
          if (count >= options.maxOperations) throw failure('storage_limit');
        }
        op.before = await captureSnapshot(repo, { paths, deadline, maxCaptureBytes: options.maxCaptureBytes });
        await checkExplicitQuota();
      } catch (error) { op.state = 'unavailable'; op.errorCode = normalizedError(error); active.delete(id); }
      putOperation(repo, op);
      await repo.db.commit();
      if (op.errorCode) await options.onDiagnostic?.({ code: op.errorCode, phase: 'before', sessionID: op.sessionID, callID: op.callID });
    });
  };
  const finish = async (input) => {
    const directory = await resolveDirectory(input.directory);
    return serialize(directory, async () => {
      const repo = await load(directory), id = hash(`${input.sessionID}\0${input.callID}`);
      const op = await repo.db.get(operationKey(id));
      if (!op) { await noteSession(repo, input); await issue(repo, input.sessionID, 'missing_capture'); await repo.db.commit(); return; }
      if (input.messageID && input.messageID !== op.messageID) throw failure('capture_identity_mismatch');
      if (op.state !== 'pending') return;
      try {
        const after = await captureSnapshot(repo, { paths: op.paths, maxCaptureBytes: options.maxCaptureBytes, deadline: input.captureDeadline ?? Date.now() + 30_000 });
        await checkExplicitQuota();
        const side = async function* (name) { for await (const change of changedEntries(repo, op.before, after, op.paths)) yield [change.file, change[name]]; };
        const before = await makeTree(repo, side('before'));
        const changedAfter = await makeTree(repo, side('after'));
        op.before = before; op.after = changedAfter; op.hasChanges = before !== changedAfter; op.state = 'complete';
      } catch (error) { op.state = 'unavailable'; op.errorCode = normalizedError(error); }
      active.delete(id); putOperation(repo, op); await repo.db.commit();
      if (op.errorCode) await options.onDiagnostic?.({ code: op.errorCode, phase: 'after', sessionID: op.sessionID, callID: op.callID });
      await options.onChange?.({ directory, sessionID: input.sessionID });
      // Collection failure does not turn a durably captured change into a gap.
      await maintain(repo).catch(async (error) => options.onDiagnostic?.({ code: normalizedError(error), phase: 'maintenance', sessionID: input.sessionID }));
    });
  };
  const importHistorical = async (inputs) => {
    if (!inputs.length) return;
    const directory = await resolveDirectory(inputs[0].directory), inputDirectory = await fs.realpath(inputs[0].directory);
    return serialize(directory, async () => {
      const repo = await load(directory);
      for (const input of inputs) {
        const id = hash(`${input.sessionID}\0${input.callID}`), existing = await repo.db.get(operationKey(id));
        if (existing && (existing.state !== 'unavailable' || existing.messageID !== input.messageID)) continue;
        if (input.directory !== inputs[0].directory || !Array.isArray(input.files) || !input.files.length) continue;
        const changes = [];
        for (const file of input.files) {
          const candidate = path.isAbsolute(file.path) && file.path.startsWith(`${input.directory}${path.sep}`)
            ? path.resolve(inputDirectory, path.relative(input.directory, file.path)) : path.resolve(inputDirectory, file.path);
          const relative = path.relative(directory, candidate);
          if (!safePath(relative) || ![file.before, file.after].every((content) => content === null || typeof content === 'string')) break;
          changes.push({ file: relative, before: file.before, after: file.after });
        }
        if (changes.length !== input.files.length) continue;
        await noteSession(repo, input);
        for (const change of changes) for (const side of ['before', 'after']) {
          if (change[side] === null) continue;
          const oid = (await repo.run(['hash-object', '-w', '--stdin', '--no-filters'], { input: change[side] })).toString().trim();
          change[side] = { oid, mode: '100644' };
        }
        const before = await makeTree(repo, changes.map((change) => [change.file, change.before]));
        const after = await makeTree(repo, changes.map((change) => [change.file, change.after]));
        putOperation(repo, { id, sessionID: input.sessionID, messageID: input.messageID, callID: input.callID,
          createdAt: existing?.createdAt ?? input.createdAt, state: 'complete', before, after, hasChanges: before !== after,
          historical: true, overlap: existing?.overlap ?? false, ownerSessionID: existing?.ownerSessionID });
      }
      await repo.db.commit();
    });
  };
  const storedRevision = async (repo, id, revision) => {
    if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) throw failure('invalid_change_revision', 400);
    const stored = await repo.db.get(revisionKey(id, revision));
    if (!stored) throw failure('summary_detail_expired', 410);
    return stored;
  };
  const page = async (repo, id, stored, cursor = null) => {
    const revision = stored.summary.revision;
    let index = 0;
    if (cursor !== null) {
      const match = typeof cursor === 'string' && cursor.match(/^([a-f0-9]{64}):(\d{1,10})$/);
      if (!match || match[1] !== revision) throw failure('invalid_change_cursor', 400);
      index = Number(match[2]);
    }
    const files = await repo.db.get(`${rowsKey(id, revision)}/${String(index).padStart(10, '0')}.json`);
    if (!files && index !== 0) throw failure('invalid_change_cursor', 400);
    const next = await repo.db.get(`${rowsKey(id, revision)}/${String(index + 1).padStart(10, '0')}.json`);
    return { ...stored.summary, files: stored.undone ? [] : files ?? [], undone: stored.undone === true,
      pageIndex: index, previousCursor: index > 1 ? `${revision}:${index - 1}` : null,
      nextCursor: !stored.undone && next ? `${revision}:${index + 1}` : null };
  };
  const summaryPage = async ({ directory: requested, rootSessionID, revision, cursor = null }) => {
    const directory = await resolveDirectory(requested);
    return serialize(directory, async () => { const repo = await load(directory); return page(repo, rootSessionID, await storedRevision(repo, rootSessionID, revision), cursor); });
  };
  const summarize = async ({ directory: requestedDirectory, rootSessionID, sessions = [], firstUserMessageID = null, coverageReasons = [], expectedCalls = [], hiddenMessages = [], reverts = [] }) => {
    const directory = await resolveDirectory(requestedDirectory);
    return serialize(directory, async () => {
      const repo = await load(directory), saved = await repo.db.get(summaryKey(rootSessionID));
      const ids = new Set([rootSessionID, ...sessions.map((entry) => entry.id)]);
      let expanded = true;
      while (expanded) {
        expanded = false;
        for await (const { value: entry } of repo.db.entries('sessions')) {
          if (ids.has(entry.parentID) && !ids.has(entry.id)) { ids.add(entry.id); expanded = true; }
        }
        for await (const { value: op } of repo.db.entries('operations')) {
          if (ids.has(op.ownerSessionID) && !ids.has(op.sessionID)) { ids.add(op.sessionID); expanded = true; }
        }
      }
      const hidden = new Set(hiddenMessages.map((entry) => `${entry.sessionID}\0${entry.messageID}`));
      const observedCalls = new Set(expectedCalls.map((call) => hash(`${call.sessionID}\0${call.callID}`)));
      for (const id of ids) {
        const revertID = reverts.find((entry) => entry.sessionID === id)?.messageID;
        const boundary = revertID ? await repo.db.get(`history/${hash(id)}/messages/${hash(revertID)}.json`) : null;
        if (revertID && !boundary) throw failure('revert_boundary_unavailable', 503);
        for await (const { value: message } of repo.db.entries(`history/${hash(id)}/messages`)) {
          for (const callID of message.calls) observedCalls.add(hash(`${id}\0${callID}`));
          if (boundary && message.createdAt >= boundary.createdAt) hidden.add(`${id}\0${message.id}`);
        }
      }
      const operations = async function* () {
        for await (const { value: op } of repo.db.entries('timeline')) {
          if (ids.has(op.sessionID) && !op.undone && !hidden.has(`${op.sessionID}\0${op.messageID}`)) yield op;
        }
      };
      const root = await repo.db.get(sessionKey(rootSessionID));
      const reasons = new Set(coverageReasons);
      for (const id of ids) for (const reason of (await repo.db.get(sessionKey(id)))?.issues ?? []) reasons.add(reason);
      if (!root || (firstUserMessageID && root.firstUserMessageID !== firstUserMessageID)) reasons.add('historical_capture_unavailable');
      for await (const { value: op } of repo.db.entries('operations')) observedCalls.delete(op.id);
      if (observedCalls.size) reasons.add('missing_capture');
      const fingerprint = crypto.createHash('sha256');
      const generation = await repo.db.get(`generations/${hash(rootSessionID)}.json`) ?? 0;
      fingerprint.update(JSON.stringify({ ids: [...ids].sort(), firstUserMessageID, generation, directory: requestedDirectory }));
      const files = new Map(), excluded = new Set();
      let onlyNoops = true;
      for await (const op of operations()) {
        fingerprint.update(JSON.stringify([op.id, op.state, op.overlap, op.before, op.after, op.historical]));
        if (op.state !== 'complete') {
          reasons.add(op.state === 'pending' ? 'capture_pending' : op.errorCode ?? 'capture_unavailable');
          onlyNoops = false; continue;
        }
        if (op.historical) reasons.add('historical_restore_unavailable');
        if (op.hasChanges) onlyNoops = false;
        if (op.overlap && op.hasChanges) reasons.add('overlapping_operations');

      }
      fingerprint.update(JSON.stringify([...reasons].sort()));
      const sourceFingerprint = fingerprint.digest('hex');
      if (saved?.undone && !reasons.size && onlyNoops) {
        // No-op calls after Undo join the same operation set for Redo.
        const members = [];
        for await (const op of operations()) { op.undone = true; putOperation(repo, op); members.push(op.id); }
        if (members.length) {
          const original = (await openChangeStore(storage, repo.gitDir)).list(membersKey(rootSessionID, saved.summary.revision));
          await repo.db.setList(membersKey(rootSessionID, saved.summary.revision), (async function* () { yield* original; yield* members; })());
          await repo.db.commit();
        }
        return page(repo, rootSessionID, saved);
      }
      if (saved?.sourceFingerprint === sourceFingerprint) return page(repo, rootSessionID, saved);
      for await (const op of operations()) {
        if (op.state !== 'complete') continue;
        for await (const change of changedEntries(repo, op.before, op.after, op.paths)) {
          if (op.overlap) { excluded.add(change.file); continue; }
          const previous = files.get(change.file);
          if (previous && !equal(previous.after, change.before)) { excluded.add(change.file); reasons.add('interleaved_file_changes'); continue; }
          files.set(change.file, { before: previous ? previous.before : change.before, after: change.after,
            sessions: [...new Set([...(previous?.sessions ?? []), op.sessionID])] });
        }
      }
      for (const file of excluded) files.delete(file);
      for (const [file, entry] of files) if (equal(entry.before, entry.after)) files.delete(file);
      const before = await makeTree(repo, (function* () { for (const [file, entry] of files) yield [file, entry.before]; })());
      const after = await makeTree(repo, (function* () { for (const [file, entry] of files) yield [file, entry.after]; })());
      const result = { rootSessionID, directory: requestedDirectory, worktreeDirectory: directory, worktreeID: repo.key,
        sessionCount: ids.size, firstUserMessageID: firstUserMessageID ?? root?.firstUserMessageID ?? null,
        coverage: reasons.size ? 'partial' : 'complete', reasons: [...reasons].sort(), hasUnattributedMutations: false };
      const revision = hash(JSON.stringify({ before, after, result, generation }));
      const members = async function* () { for await (const op of operations()) yield op.id; };
      if (saved?.summary.revision === revision) {
        saved.sourceFingerprint = sourceFingerprint;
        await saveSummary(repo, rootSessionID, saved, null, members()); await repo.db.commit();
        return page(repo, rootSessionID, saved);
      }
      let fileCount = 0, additions = 0, deletions = 0;
      const rows = async function* () {
        const iterator = gitTokens(storage, ['--git-dir', repo.gitDir, 'diff', '--no-ext-diff', '--no-textconv', '--find-renames', '--numstat', '-z', before, after])[Symbol.asyncIterator]();
        try {
          for (;;) {
            const token = await iterator.next(); if (token.done) break;
            const [added, deleted, ...name] = token.value.split('\t');
            let file = name.join('\t'), oldPath = null;
            if (!file) { oldPath = (await iterator.next()).value; file = (await iterator.next()).value; }
            const entry = files.get(file);
            if (!entry) throw failure('invalid_change_record');
            fileCount++; additions += added === '-' ? 0 : Number(added); deletions += deleted === '-' ? 0 : Number(deleted);
            yield { path: file, oldPath, status: oldPath ? 'renamed' : !entry.before ? 'added' : !entry.after ? 'deleted' : 'modified',
              additions: added === '-' ? null : Number(added), deletions: deleted === '-' ? null : Number(deleted),
              sessions: [...new Set([...entry.sessions, ...(oldPath ? files.get(oldPath)?.sessions ?? [] : [])])] };
          }
        } finally { await iterator.return?.(); }
      };
      await repo.db.setList(rowsKey(rootSessionID, revision), rows());
      const stored = { summary: { ...result, revision, fileCount, additions, deletions }, before, after, sourceFingerprint, createdAt: Date.now() };
      await saveSummary(repo, rootSessionID, stored, null, members());
      // Explicit opt-in retention remains supported for embedders. The host
      // default retains all revisions until deletion.
      if (Number.isFinite(options.maxRevisions)) {
        const revisions = [];
        for await (const entry of repo.db.entries(`revisions/${hash(rootSessionID)}`)) revisions.push(entry);
        const previous = revisions.filter((entry) => entry.value.summary.revision !== revision).sort((a, b) => (a.value.createdAt ?? 0) - (b.value.createdAt ?? 0));
        while (previous.length > options.maxRevisions) {
          const old = previous.shift(); repo.db.remove(old.key);
          for (const prefix of [rowsKey(rootSessionID, old.value.summary.revision), membersKey(rootSessionID, old.value.summary.revision)]) {
            for await (const { key } of repo.db.entries(prefix)) repo.db.remove(key);
          }
        }
      }
      await repo.db.commit();
      return page(repo, rootSessionID, stored);
    });
  };
  const diff = async ({ directory: requested, rootSessionID, revision, file, cursor = null }) => {
    const directory = await resolveDirectory(requested);
    return serialize(directory, async () => {
      const repo = await load(directory), stored = await storedRevision(repo, rootSessionID, revision);
      let row;
      for await (const entry of repo.db.list(rowsKey(rootSessionID, revision))) if (entry.path === file) { row = entry; break; }
      if (!row) throw failure('summary_file_not_found', 404);
      const key = hash(`${rootSessionID}\0${revision}\0${file}`);
      let offset = 0;
      if (cursor !== null) {
        const match = typeof cursor === 'string' && cursor.match(/^([a-f0-9]{64}):(\d{1,16})$/);
        if (!match || match[1] !== key || !Number.isSafeInteger(Number(match[2]))) throw failure('invalid_change_cursor', 400);
        offset = Number(match[2]);
        if (offset % DIFF_BYTES !== 0) throw failure('invalid_change_cursor', 400);
      }
      const directoryPath = path.join(storage, repo.key, 'diffs'), patchPath = path.join(directoryPath, `${key}.patch`);
      await fs.mkdir(directoryPath, { recursive: true, mode: 0o700 });
      try { await fs.access(patchPath); } catch {
        const temporary = `${patchPath}.${crypto.randomUUID()}`;
        try {
          await gitToFile(storage, ['--git-dir', repo.gitDir, '--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv',
            stored.before, stored.after, '--', ...(row.oldPath ? [row.oldPath] : []), row.path], temporary);
          await fs.rename(temporary, patchPath);
        } finally { await fs.rm(temporary, { force: true }); }
      }
      const handle = await fs.open(patchPath, 'r');
      try {
        const { size } = await handle.stat();
        if (offset > size) throw failure('invalid_change_cursor', 400);
        const buffer = Buffer.alloc(DIFF_BYTES + 4), { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        let start = 0, length = Math.min(DIFF_BYTES, bytesRead);
        // Nominal pages are fixed byte ranges; shift both boundaries forward
        // past UTF-8 continuation bytes so forward/back navigation is exact.
        while (start < bytesRead && (buffer[start] & 0xc0) === 0x80) start++;
        while (length < bytesRead && (buffer[length] & 0xc0) === 0x80) length++;
        return { rootSessionID, revision, path: file, patch: buffer.subarray(start, length).toString(), totalBytes: size,
          pageIndex: offset / DIFF_BYTES, previousCursor: offset > DIFF_BYTES ? `${key}:${offset - DIFF_BYTES}` : null,
          nextCursor: offset + length < size ? `${key}:${offset + DIFF_BYTES}` : null };
      } finally { await handle.close(); }
    });
  };
  const registerSession = async (input) => {
    const directory = await resolveDirectory(input.directory);
    return serialize(directory, async () => { const repo = await load(directory); await noteSession(repo, input); await repo.db.commit(); });
  };
  const restore = async ({ directory: requested, rootSessionID, revision, redo = false }) => {
    const directory = await resolveDirectory(requested);
    return serialize(directory, async () => {
      const repo = await load(directory), stored = await repo.db.get(summaryKey(rootSessionID));
      if (!stored || stored.summary.revision !== revision) throw failure('summary_revision_changed');
      if (stored.summary.coverage !== 'complete') throw failure('summary_incomplete');
      for await (const entry of repo.db.entries('pending')) { void entry; throw failure('directory_busy'); }
      const from = new Map(), to = new Map();
      for await (const entry of changeTreeEntries(repo, redo ? stored.before : stored.after)) from.set(...entry);
      for await (const entry of changeTreeEntries(repo, redo ? stored.after : stored.before)) to.set(...entry);
      const paths = new Set([...from.keys(), ...to.keys()]);
      const inspect = async (file) => {
        await verifyAncestors(directory, file);
        const target = path.join(directory, file);
        const stat = await fs.lstat(target).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
        if (!stat) return null;
        if (!stat.isFile() && !stat.isSymbolicLink()) throw failure('working_tree_changed');
        const oid = (await repo.run(stat.isSymbolicLink() ? ['hash-object', '--stdin', '--no-filters']
          : ['hash-object', '--no-filters', '--', target], stat.isSymbolicLink() ? { input: await fs.readlink(target) } : {})).toString().trim();
        return { oid, mode: stat.isSymbolicLink() ? '120000' : stat.mode & 0o111 ? '100755' : '100644' };
      };
      for (const file of paths) if (!equal(await inspect(file), from.get(file))) throw failure('working_tree_changed');
      const write = async (file, entry) => {
        const target = path.join(directory, file);
        await verifyAncestors(directory, file);
        if (!entry) { await fs.rm(target, { force: true }); return; }
        await fs.mkdir(path.dirname(target), { recursive: true });
        const temp = `${target}.devryan-${crypto.randomUUID()}`;
        try {
          if (entry.mode === '120000') await fs.symlink((await repo.run(['cat-file', 'blob', entry.oid])).toString(), temp);
          else {
            await gitToFile(storage, ['--git-dir', repo.gitDir, 'cat-file', 'blob', entry.oid], temp,
              { mode: entry.mode === '100755' ? 0o755 : 0o644 });
            const handle = await fs.open(temp, 'r'); try { await handle.sync(); } finally { await handle.close(); }
          }
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
        const generation = (await repo.db.get(`generations/${hash(rootSessionID)}.json`) ?? 0) + 1;
        repo.db.set(`generations/${hash(rootSessionID)}.json`, generation);
        for await (const id of repo.db.list(membersKey(rootSessionID, revision))) {
          const op = await repo.db.get(operationKey(id));
          if (!op) throw failure('invalid_change_record');
          op.undone = !redo; putOperation(repo, op);
        }
        const next = { ...stored, undone: !redo, createdAt: Date.now(),
          summary: { ...stored.summary, revision: hash(`${revision}\0${redo}\0${generation}`) } };
        await saveSummary(repo, rootSessionID, next, repo.db.list(rowsKey(rootSessionID, revision)), repo.db.list(membersKey(rootSessionID, revision)));
        await repo.db.commit();
      } catch (error) {
        let failed = false;
        for (const file of written.reverse()) {
          try {
            const current = await inspect(file);
            if (equal(current, from.get(file))) continue;
            if (!equal(current, to.get(file))) throw failure('working_tree_changed');
            await write(file, from.get(file));
            if (!equal(await inspect(file), from.get(file))) throw failure('rollback_failed');
          } catch { failed = true; }
        }
        if (failed) throw failure('rollback_failed', 500);
        throw error;
      }
      return { undone: !redo };
    });
  };
  const repositories = async function* () {
    let entries;
    try { entries = await fs.opendir(storage); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for await (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
      const db = await openChangeStore(storage, path.join(storage, entry.name, 'git'));
      const meta = await db.get('meta.json');
      if (meta?.directory) yield meta.directory;
      else {
        const legacyPath = path.join(storage, 'records', `${entry.name}.json`);
        const legacy = JSON.parse(await fs.readFile(legacyPath, 'utf8'));
        if (legacy.record?.directory) yield legacy.record.directory;
      }
    }
  };
  const deleteSession = async (sessionID) => {
    for await (const directory of repositories()) await serialize(directory, async () => {
      const repo = await load(directory), session = await repo.db.get(sessionKey(sessionID));
      let owned = Boolean(session);
      if (!owned) for await (const { value: op } of repo.db.entries('operations')) if (op.sessionID === sessionID || op.ownerSessionID === sessionID) { owned = true; break; }
      if (!owned) return;
      const retainedParent = session?.parentID && await repo.db.get(sessionKey(session.parentID));
      const removed = new Set([sessionID]);
      if (!retainedParent) {
        let expanded = true;
        while (expanded) {
          expanded = false;
          for await (const { value: entry } of repo.db.entries('sessions')) if (removed.has(entry.parentID) && !removed.has(entry.id)) { removed.add(entry.id); expanded = true; }
          for await (const { value: op } of repo.db.entries('operations')) if (removed.has(op.ownerSessionID) && !removed.has(op.sessionID)) { removed.add(op.sessionID); expanded = true; }
        }
      }
      for await (const { value: op } of repo.db.entries('operations')) {
        if (retainedParent && (op.sessionID === sessionID || op.ownerSessionID === sessionID)) {
          active.delete(op.id); op.ownerSessionID = session.parentID;
          if (op.state === 'pending') { op.state = 'unavailable'; op.errorCode = 'capture_interrupted'; }
          putOperation(repo, op);
        } else if (!retainedParent && removed.has(op.sessionID)) {
          active.delete(op.id); repo.db.remove(operationKey(op.id)); repo.db.remove(timelineKey(op)); repo.db.remove(`pending/${op.id}.json`);
        }
      }
      for (const id of removed) {
        repo.db.remove(sessionKey(id)); repo.db.remove(summaryKey(id)); repo.db.remove(`generations/${hash(id)}.json`);
        for (const prefix of [`revisions/${hash(id)}`, `rows/${hash(id)}`, `members/${hash(id)}`, `history/${hash(id)}`]) {
          for await (const { key } of repo.db.entries(prefix)) repo.db.remove(key);
        }
      }
      await repo.db.commit();
      let remaining = false;
      for await (const entry of repo.db.entries('sessions')) { void entry; remaining = true; break; }
      if (!remaining) for await (const entry of repo.db.entries('operations')) { void entry; remaining = true; break; }
      if (!remaining) {
        await fs.rm(path.join(storage, repo.key), { recursive: true, force: true });
        await fs.rm(path.join(storage, 'records', `${repo.key}.json`), { force: true });
      } else await collect(repo);
    });
  };
  // Host history reconciliation checkpoints contain identifiers and timestamps,
  // never message bodies. Pages of exact receipts are imported separately.
  const historyState = async ({ directory: requested, sessionID, state, messages = [] }) => {
    const directory = await resolveDirectory(requested);
    return serialize(directory, async () => {
      const repo = await load(directory), key = `history/${hash(sessionID)}/state.json`;
      for (const message of messages) repo.db.set(`history/${hash(sessionID)}/messages/${hash(message.id)}.json`, message);
      if (state !== undefined) repo.db.set(key, state);
      await repo.db.commit();
      return repo.db.get(key);
    });
  };
  return { begin, finish, importHistorical, registerSession, summarize, summaryPage, diff, restore, deleteSession, historyState,
    async drain() { await Promise.all([...tails.values()]); },
    async observe(event, directory) {
      const part = event?.properties?.part;
      if (part?.type === 'tool' && ['completed', 'error'].includes(part.state?.status)) {
        const id = hash(`${part.sessionID}\0${part.callID}`), capturedDirectory = active.get(id);
        if (capturedDirectory) await finish({ directory: capturedDirectory, sessionID: part.sessionID, callID: part.callID });
      }
      if (event?.type === 'session.deleted') await deleteSession(event.properties.info.id);
      void directory;
    },
  };
}
