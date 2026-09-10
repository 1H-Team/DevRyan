import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { withCrossProcessFileLock } from './atomic-file.js';
import { git, gitToFile, gitTokens, changeError as failure } from './session-changes-git.js';
import { openChangeStore, changeKey as hash } from './session-changes-store.js';
import { captureSnapshot, changedEntries, changeTreeEntries, equalEntry as equal,
  makeChangeTree as makeTree, safeChangePath as safePath, verifyAncestors } from './session-changes-snapshot.js';
import { exactSessionChanges, receiptInputFingerprint, receiptPatchesKey, revisionSegmentKey, revisionSegmentsKey, storeSessionChangeReceipt } from './session-changes-receipts.js';
import { classifySessionChangeTool } from './session-changes-tools.js';

const sessionKey = (id) => `sessions/${hash(id)}.json`;
const operationKey = (id) => `operations/${id}.json`;
const timelineKey = (op) => `timeline/${String(op.createdAt).padStart(16, '0')}-${op.id}.json`;
const summaryKey = (id) => `summaries/${hash(id)}.json`;
const revisionKey = (id, revision) => `revisions/${hash(id)}/${revision}.json`;
const rowsKey = (id, revision) => `rows/${hash(id)}/${revision}`;
const membersKey = (id, revision) => `members/${hash(id)}/${revision}`;
const normalizedError = (error) => ['ENOSPC', 'EDQUOT', 'EIO', 'EROFS'].includes(error?.code) ? 'storage_unavailable' : error?.code ?? 'capture_failed';
const DIFF_BYTES = 64 * 1024;
const ATTRIBUTION_VERSION = 3;

export function createSessionChangeRuntime(options) {
  const storage = path.resolve(options.directory);
  const tails = new Map(), active = new Map(), nativeActive = new Set();
  const diagnostic = async (event) => { try { await options.onDiagnostic?.(event); } catch { /* Optional journaling never invalidates capture. */ } };
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
    if (existing) {
      if (input.parentID && existing.parentID && existing.parentID !== input.parentID) throw failure('invalid_session_lineage', 503);
      if (!existing.parentID && input.parentID || !existing.firstUserMessageID && input.userMessageID) {
        existing.parentID = existing.parentID ?? input.parentID ?? null;
        existing.firstUserMessageID = existing.firstUserMessageID ?? input.userMessageID ?? null;
        repo.db.set(key, existing);
      }
      return existing;
    }
    const value = { id: input.sessionID, parentID: input.parentID ?? null, firstUserMessageID: input.userMessageID ?? null, issues: [] };
    repo.db.set(key, value);
    return value;
  };
  const issue = async (repo, id, code) => {
    const entry = await noteSession(repo, { sessionID: id });
    if (!entry.issues.includes(code)) { entry.issues.push(code); repo.db.set(sessionKey(id), entry); }
  };
  const notifyChanges = async (repo, sessionIDs) => {
    const notified = new Set();
    for (const sessionID of sessionIDs) {
      let id = sessionID;
      while (id && !notified.has(id)) {
        notified.add(id);
        await options.onChange?.({ directory: repo.directory, sessionID: id });
        id = (await repo.db.get(sessionKey(id)))?.parentID;
      }
    }
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
      if (active.has(op.id) || nativeActive.has(op.id)) continue;
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
      if (op.patchTree) trees.add(op.patchTree);
    }
    for await (const { value: stored } of repo.db.entries('revisions')) { trees.add(stored.before); trees.add(stored.after); }
    for await (const { value: segment } of repo.db.entries('segments')) {
      if (segment.beforeTree) trees.add(segment.beforeTree);
      if (segment.afterTree) trees.add(segment.afterTree);
      if (segment.patchTree) trees.add(segment.patchTree);
    }
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
        state: 'pending', evidence: 'snapshot', source: input.source ?? 'opencode', tool: input.tool ?? null,
        paths, ownerPID: process.pid, overlap, createdAt: Date.now() };
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
      if (op.errorCode) await diagnostic({ code: op.errorCode, phase: 'before', sessionID: op.sessionID, callID: op.callID });
    });
  };
  const finish = async (input) => {
    const directory = await resolveDirectory(input.directory);
    return serialize(directory, async () => {
      const repo = await load(directory), id = hash(`${input.sessionID}\0${input.callID}`);
      const op = await repo.db.get(operationKey(id));
      if (!op) {
        await noteSession(repo, input);
        putOperation(repo, { id, sessionID: input.sessionID, messageID: input.messageID, callID: input.callID,
          createdAt: Date.now(), state: 'unavailable', evidence: 'snapshot', errorCode: 'missing_capture' });
        await repo.db.commit(); await notifyChanges(repo, [input.sessionID]); return;
      }
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
      if (op.errorCode) await diagnostic({ code: op.errorCode, phase: 'after', sessionID: op.sessionID, callID: op.callID });
      else if (op.hasChanges) await diagnostic({ code: 'snapshot_observation', phase: 'after',
        sessionID: op.sessionID, callID: op.callID, source: op.source, evidence: 'snapshot' });
      await notifyChanges(repo, [input.sessionID]);
      // Collection failure does not turn a durably captured change into a gap.
      await maintain(repo).catch(async (error) => diagnostic({ code: normalizedError(error), phase: 'maintenance', sessionID: input.sessionID }));
    });
  };
  const recordReceipts = async (inputs, historical) => {
    if (!inputs.length) return;
    const directory = await resolveDirectory(inputs[0].directory), inputDirectory = await fs.realpath(inputs[0].directory);
    return serialize(directory, async () => {
      const repo = await load(directory);
      const changed = new Set();
      const diagnostics = [];
      for (const input of inputs) {
        if (input.directory !== inputs[0].directory
          || ![input.sessionID, input.messageID, input.callID].every((id) => typeof id === 'string' && id.length > 0 && id.length <= 512)
          || !input.files || typeof input.files[Symbol.iterator] !== 'function' && typeof input.files[Symbol.asyncIterator] !== 'function') throw failure('invalid_change_receipt', 400);
        const id = hash(`${input.sessionID}\0${input.callID}`), existing = await repo.db.get(operationKey(id));
        await noteSession(repo, input);
        if (existing?.messageID && existing.messageID !== input.messageID) {
          await issue(repo, input.sessionID, 'capture_identity_reused');
          continue;
        }
        const inputFingerprint = receiptInputFingerprint(input);
        if (inputFingerprint && existing?.evidence === 'exact' && existing.receiptInputFingerprint === inputFingerprint) continue;
        try {
          const op = await storeSessionChangeReceipt(repo, { ...input, historical, receiptInputFingerprint: inputFingerprint }, existing, inputDirectory);
          if (!op) continue;
          active.delete(id); nativeActive.delete(id); putOperation(repo, op); changed.add(input.sessionID);
          diagnostics.push({ code: 'exact_tool_receipt', phase: historical ? 'history' : 'receipt',
            sessionID: input.sessionID, callID: input.callID, source: op.source, evidence: 'exact' });
        } catch (error) {
          if (historical && ['unsupported_path', 'invalid_change_receipt'].includes(error.code) && existing?.evidence !== 'exact') {
            // One malformed historical receipt must not hide other verified
            // files. Keep a call-scoped gap that a later valid receipt can repair.
            putOperation(repo, { ...existing, id, sessionID: input.sessionID, messageID: input.messageID, callID: input.callID,
              createdAt: existing?.createdAt ?? input.createdAt ?? Date.now(), state: 'unavailable', evidence: 'snapshot',
              errorCode: 'invalid_change_receipt', source: input.source ?? 'native-tool' });
            active.delete(id); changed.add(input.sessionID);
            diagnostics.push({ code: 'invalid_change_receipt', phase: 'history', sessionID: input.sessionID, callID: input.callID });
            continue;
          }
          if (error.code !== 'receipt_conflict') throw error;
          // Conflicting content is permanent for this call, not for unrelated
          // calls or messages hidden by conversation rewind.
          putOperation(repo, { ...existing, receiptConflict: true });
          changed.add(input.sessionID);
          diagnostics.push({ code: 'receipt_conflict', phase: 'receipt', sessionID: input.sessionID, callID: input.callID });
        }
      }
      await repo.db.commit();
      for (const event of diagnostics) await diagnostic(event);
      await notifyChanges(repo, changed);
    });
  };
  const recordReceipt = (input) => recordReceipts([input], false);
  const importHistorical = (inputs) => recordReceipts(inputs, true);
  // Private provider channel. Native tasks remain operations of their real
  // session; nested call IDs are scoped by the parent tool, never UI sessions.
  const recordExecution = async (input) => {
    const directory = await resolveDirectory(input.directory);
    const callID = input.parentCallID ? `native_${hash(`${input.parentCallID}\0${input.callID}`)}` : input.callID;
    let receiptError = null;
    if (input.receipt) {
      try { await recordReceipt({ ...input, ...input.receipt, callID }); }
      catch (cause) {
        if (!['invalid_change_receipt', 'unsupported_path'].includes(cause.code)) throw cause;
        receiptError = 'invalid_change_receipt';
      }
    }
    return serialize(directory, async () => {
      const repo = await load(directory);
      await noteSession(repo, input);
      if (['run-settled', 'interrupted'].includes(input.phase)) {
        for await (const { value: op } of repo.db.entries('operations')) {
          if (!op.native || op.sessionID !== input.sessionID || input.messageID && op.messageID !== input.messageID
            || op.state !== 'pending' && !(input.phase === 'run-settled' && op.errorCode === 'capture_interrupted')) continue;
          const complete = input.phase === 'run-settled' && !input.captureFailed && !op.captureGap && op.evidence === 'task' && op.taskStarted && op.taskTerminal;
          op.state = complete ? 'complete' : 'unavailable';
          op.errorCode = complete ? null : input.phase === 'interrupted' ? 'capture_interrupted' : 'execution_receipt_unavailable';
          nativeActive.delete(op.id); putOperation(repo, op);
        }
      } else {
        const task = input.tool === 'task' && !input.parentCallID;
        if (!task && input.tool !== 'task' && classifySessionChangeTool(input.tool) === 'read-only') return;
        const id = hash(`${input.sessionID}\0${callID}`), existing = await repo.db.get(operationKey(id));
        if (existing?.messageID && existing.messageID !== input.messageID) throw failure('capture_identity_mismatch', 409);
        if (existing?.evidence === 'exact' || existing?.state === 'complete' && input.phase !== 'stream-gap') return;
        const terminal = input.phase !== 'stream-gap' && input.state !== 'running';
        // Outbox replay and older observations cannot reopen a settled call.
        if (!terminal && existing?.terminalSeen && input.phase !== 'stream-gap') return;
        const settledGap = input.phase === 'stream-gap' && existing?.state === 'complete';
        const op = { ...existing, id, sessionID: input.sessionID, messageID: input.messageID, callID,
          createdAt: existing?.createdAt ?? input.createdAt ?? Date.now(), native: true, ownerPID: process.pid,
          source: 'cursor-native', tool: input.tool, evidence: task ? 'task' : 'snapshot', hasChanges: false,
          state: settledGap ? 'unavailable' : task || !terminal ? 'pending' : 'unavailable',
          terminalSeen: existing?.terminalSeen || terminal,
          captureGap: existing?.captureGap || input.phase === 'stream-gap',
          errorCode: receiptError ?? (settledGap ? 'execution_receipt_unavailable' : task || !terminal ? null : 'execution_receipt_unavailable'),
          ...(task ? { taskStarted: existing?.taskStarted || input.state === 'running', taskTerminal: existing?.taskTerminal || input.state === 'completed' } : {}) };
        if (op.state === 'pending') nativeActive.add(id); else nativeActive.delete(id);
        putOperation(repo, op);
      }
      await repo.db.commit(); await notifyChanges(repo, [input.sessionID]);
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
    return { ...stored.summary, reconciliationState: stored.summary.reconciliationState
      ?? (stored.summary.reasons?.some((reason) => ['history_pending', 'capture_pending', 'receipts_pending'].includes(reason)) ? 'pending' : 'settled'),
      files: stored.undone ? [] : files ?? [], undone: stored.undone === true,
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
      for (const id of ids) {
        const entry = await repo.db.get(sessionKey(id));
        for (const reason of entry?.issues ?? []) {
          if (reason === 'missing_capture') {
            const history = await repo.db.get(`history/${hash(id)}/state.json`);
            // Old session-wide flags have no call identity. Clear only after a
            // complete scan accounts for every expected call in that session.
            let accounted = history?.complete === true;
            for await (const { value: message } of repo.db.entries(`history/${hash(id)}/messages`)) {
              for (const callID of message.calls) {
                const op = await repo.db.get(operationKey(hash(`${id}\0${callID}`)));
                if (!op || op.state !== 'complete') accounted = false;
              }
            }
            if (accounted) {
              entry.issues = entry.issues.filter((code) => code !== reason);
              repo.db.set(sessionKey(id), entry);
              continue;
            }
          }
          reasons.add(reason);
        }
      }
      if (!root || (firstUserMessageID && root.firstUserMessageID !== firstUserMessageID)) reasons.add('historical_capture_unavailable');
      for await (const { value: op } of repo.db.entries('operations')) observedCalls.delete(op.id);
      if (observedCalls.size) reasons.add('missing_capture');
      const fingerprint = crypto.createHash('sha256');
      const generation = await repo.db.get(`generations/${hash(rootSessionID)}.json`) ?? 0;
      fingerprint.update(JSON.stringify({ attributionVersion: ATTRIBUTION_VERSION, ids: [...ids].sort(), firstUserMessageID, generation, directory: requestedDirectory }));
      const files = new Map(), restoreReasons = new Set();
      let onlyNoops = true;
      for await (const op of operations()) {
        fingerprint.update(JSON.stringify([op.id, op.state, op.before, op.after, op.historical, op.evidence,
          op.receiptFingerprint, op.restoreVerified, op.receiptComplete, op.receiptConflict, op.createdAt, op.source, op.tool]));
        if (op.receiptConflict) reasons.add('receipt_conflict');
        if (op.state !== 'complete') {
          reasons.add(op.state === 'pending' ? 'capture_pending' : op.errorCode ?? 'capture_unavailable');
          onlyNoops = false; continue;
        }
        if (op.hasChanges) onlyNoops = false;
        if (op.evidence !== 'exact' && !op.historical) {
          if (op.hasChanges) reasons.add('unverified_tool_changes');
          continue;
        }
        if (op.receiptComplete === false) reasons.add('tool_changes_incomplete');
        if (op.hasChanges && op.restoreVerified !== true) restoreReasons.add('restore_evidence_unavailable');
        for await (const change of exactSessionChanges(repo, op)) {
          const previous = files.get(change.file);
          const segmented = Boolean(change.patchOID || previous?.reviewMode === 'segments'
            || previous && !equal(previous.after, change.before));
          files.set(change.file, { before: previous ? previous.before : change.before, after: change.after,
            reviewMode: segmented ? 'segments' : 'net', segmentCount: (previous?.segmentCount ?? 0) + 1,
            sessions: new Set([...(previous?.sessions ?? []), op.sessionID]) });
        }
      }
      for (const [file, entry] of files) {
        if (entry.reviewMode === 'net' && equal(entry.before, entry.after)) files.delete(file);
        else if (entry.reviewMode === 'segments') restoreReasons.add('segmented_changes');
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
        await repo.db.commit();
        return page(repo, rootSessionID, saved);
      }
      if (saved?.sourceFingerprint === sourceFingerprint) { await repo.db.commit(); return page(repo, rootSessionID, saved); }
      const treeSide = function* (side) { for (const [file, entry] of files) if (entry.reviewMode === 'net') yield [file, entry[side]]; };
      const before = await makeTree(repo, treeSide('before')), after = await makeTree(repo, treeSide('after'));
      const rows = new Map();
      const iterator = gitTokens(storage, ['--git-dir', repo.gitDir, 'diff', '--no-ext-diff', '--no-textconv', '--find-renames', '--numstat', '-z', before, after])[Symbol.asyncIterator]();
      try {
        for (;;) {
          const token = await iterator.next(); if (token.done) break;
          const [added, deleted, ...name] = token.value.split('\t');
          let file = name.join('\t'), oldPath = null;
          if (!file) { oldPath = (await iterator.next()).value; file = (await iterator.next()).value; }
          const entry = files.get(file);
          if (!entry) throw failure('invalid_change_record');
          rows.set(file, { path: file, oldPath, status: oldPath ? 'renamed' : !entry.before ? 'added' : !entry.after ? 'deleted' : 'modified',
            additions: added === '-' ? null : Number(added), deletions: deleted === '-' ? null : Number(deleted),
            reviewMode: 'net', segmentCount: 0,
            sessions: [...new Set([...entry.sessions, ...(oldPath ? files.get(oldPath)?.sessions ?? [] : [])])] });
        }
      } finally { await iterator.return?.(); }
      // Store bounded segment records separately, so no file row grows with
      // session length. Old revisions keep these immutable object references.
      for await (const op of operations()) {
        if (op.state !== 'complete') continue;
        for await (const change of exactSessionChanges(repo, op)) {
          const entry = files.get(change.file);
          if (entry?.reviewMode !== 'segments') continue;
          let row = rows.get(change.file);
          if (!row) {
            row = { path: change.file, oldPath: null, status: 'modified', additions: 0, deletions: 0,
              reviewMode: 'segments', segmentCount: 0, sessions: [...entry.sessions] };
            rows.set(change.file, row);
          }
          let additions = change.additions, deletions = change.deletions;
          if (!change.patchOID) {
            const stats = (await repo.run(['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--numstat', '-z',
              change.beforeTree, change.afterTree, '--', change.file])).toString().split('\t');
            additions = stats[0] === '-' ? null : Number(stats[0]);
            deletions = stats[1] === '-' ? null : Number(stats[1]);
          }
          row.additions = row.additions === null || additions === null ? null : row.additions + additions;
          row.deletions = row.deletions === null || deletions === null ? null : row.deletions + deletions;
          repo.db.set(revisionSegmentKey(rootSessionID, sourceFingerprint, change.file, row.segmentCount), {
            ...change, sessionID: op.sessionID, messageID: op.messageID, callID: op.callID,
            source: op.source ?? 'native-tool', createdAt: op.createdAt, index: row.segmentCount,
          });
          row.segmentCount++;
        }
      }
      const totalsMode = [...rows.values()].some((row) => row.reviewMode === 'segments') ? 'recorded' : 'net';
      if (reasons.size) restoreReasons.add('summary_incomplete');
      const result = { rootSessionID, directory: requestedDirectory, worktreeDirectory: directory, worktreeID: repo.key,
        attributionVersion: ATTRIBUTION_VERSION, totalsMode, restoreAvailable: !restoreReasons.size && rows.size > 0,
        restoreReasons: [...restoreReasons].sort(),
        sessionCount: ids.size, firstUserMessageID: firstUserMessageID ?? root?.firstUserMessageID ?? null,
        coverage: reasons.size ? 'partial' : 'complete', reasons: [...reasons].sort(), hasUnattributedMutations: false,
        reconciliationState: ['history_pending', 'capture_pending', 'receipts_pending'].some((reason) => reasons.has(reason)) ? 'pending' : 'settled' };
      const rowFingerprint = crypto.createHash('sha256');
      for (const row of rows.values()) rowFingerprint.update(JSON.stringify(row));
      const revision = hash(JSON.stringify({ before, after, result, generation, rows: rowFingerprint.digest('hex'),
        segments: totalsMode === 'recorded' ? sourceFingerprint : null }));
      const members = async function* () { for await (const op of operations()) yield op.id; };
      if (saved?.summary.revision === revision) {
        saved.sourceFingerprint = sourceFingerprint;
        await saveSummary(repo, rootSessionID, saved, null, members()); await repo.db.commit();
        return page(repo, rootSessionID, saved);
      }
      let additions = 0, deletions = 0;
      for (const row of rows.values()) { additions += row.additions ?? 0; deletions += row.deletions ?? 0; }
      const orderedRows = [...rows.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      const stored = { summary: { ...result, revision, fileCount: rows.size, additions, deletions }, before, after,
        segmentRevision: totalsMode === 'recorded' ? sourceFingerprint : null, sourceFingerprint, createdAt: Date.now() };
      await saveSummary(repo, rootSessionID, stored, orderedRows, members());
      // Explicit opt-in retention remains supported for embedders. The host
      // default retains all revisions until deletion.
      if (Number.isFinite(options.maxRevisions)) {
        const revisions = [];
        for await (const entry of repo.db.entries(`revisions/${hash(rootSessionID)}`)) revisions.push(entry);
        const previous = revisions.filter((entry) => entry.value.summary.revision !== revision).sort((a, b) => (a.value.createdAt ?? 0) - (b.value.createdAt ?? 0));
        while (previous.length > options.maxRevisions) {
          const old = previous.shift(); repo.db.remove(old.key);
          for (const prefix of [rowsKey(rootSessionID, old.value.summary.revision), membersKey(rootSessionID, old.value.summary.revision),
            ...(old.value.segmentRevision ? [revisionSegmentsKey(rootSessionID, old.value.segmentRevision)] : [])]) {
            for await (const { key } of repo.db.entries(prefix)) repo.db.remove(key);
          }
        }
      }
      await repo.db.commit();
      return page(repo, rootSessionID, stored);
    });
  };
  const diff = async ({ directory: requested, rootSessionID, revision, file, cursor = null, segment = null }) => {
    const directory = await resolveDirectory(requested);
    return serialize(directory, async () => {
      const repo = await load(directory), stored = await storedRevision(repo, rootSessionID, revision);
      let row;
      for await (const entry of repo.db.list(rowsKey(rootSessionID, revision))) if (entry.path === file) { row = entry; break; }
      if (!row) throw failure('summary_file_not_found', 404);
      const segmented = row.reviewMode === 'segments';
      const segmentIndex = segment === null ? 0 : Number(segment);
      if (segment !== null && !/^(0|[1-9]\d{0,9})$/.test(String(segment))
        || !Number.isSafeInteger(segmentIndex) || segmentIndex < 0
        || (segmented ? segmentIndex >= row.segmentCount : segment !== null)) throw failure('invalid_change_segment', 400);
      const selected = segmented ? await repo.db.get(revisionSegmentKey(rootSessionID, stored.segmentRevision, file, segmentIndex)) : null;
      if (segmented && !selected) throw failure('summary_detail_expired', 410);
      const key = hash(`${rootSessionID}\0${revision}\0${file}\0${segmented ? segmentIndex : 'net'}`);
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
          if (selected?.patchOID) await gitToFile(storage, ['--git-dir', repo.gitDir, 'cat-file', 'blob', selected.patchOID], temporary);
          else await gitToFile(storage, ['--git-dir', repo.gitDir, '--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv',
            selected?.beforeTree ?? stored.before, selected?.afterTree ?? stored.after, '--', ...(row.oldPath ? [row.oldPath] : []), row.path], temporary);
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
          reviewMode: segmented ? 'segments' : 'net', segmentIndex: segmented ? segmentIndex : null,
          segmentCount: segmented ? row.segmentCount : 0,
          segment: selected ? { sessionID: selected.sessionID, messageID: selected.messageID, callID: selected.callID, source: selected.source } : null,
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
      if (stored.summary.coverage !== 'complete' || stored.summary.restoreAvailable !== true
        || stored.summary.attributionVersion !== ATTRIBUTION_VERSION) throw failure('summary_incomplete');
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
          active.delete(op.id); nativeActive.delete(op.id); op.ownerSessionID = session.parentID;
          if (op.state === 'pending') { op.state = 'unavailable'; op.errorCode = 'capture_interrupted'; }
          putOperation(repo, op);
        } else if (!retainedParent && removed.has(op.sessionID)) {
          active.delete(op.id); nativeActive.delete(op.id); repo.db.remove(operationKey(op.id)); repo.db.remove(timelineKey(op)); repo.db.remove(`pending/${op.id}.json`);
          for await (const { key } of repo.db.entries(receiptPatchesKey(op.id))) repo.db.remove(key);
        }
      }
      for (const id of removed) {
        // Retain lineage and expected calls beneath a surviving parent, even
        // when the deleted intermediate session made no edits of its own.
        if (retainedParent) repo.db.set(sessionKey(id), { ...session, deleted: true });
        else repo.db.remove(sessionKey(id));
        repo.db.remove(summaryKey(id)); repo.db.remove(`generations/${hash(id)}.json`);
        for (const prefix of [`revisions/${hash(id)}`, `rows/${hash(id)}`, `members/${hash(id)}`, ...(!retainedParent ? [`history/${hash(id)}`] : []), `segments/${hash(id)}`]) {
          for await (const { key } of repo.db.entries(prefix)) repo.db.remove(key);
        }
      }
      await repo.db.commit();
      if (retainedParent) await notifyChanges(repo, [session.parentID]);
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
      for (const message of messages) {
        repo.db.set(`history/${hash(sessionID)}/messages/${hash(message.id)}.json`, message);
        for (const callID of message.calls) repo.db.set(`history/${hash(sessionID)}/calls/${hash(callID)}.json`, message.id);
        let unresolved = false;
        for (const callID of message.calls) {
          const op = await repo.db.get(operationKey(hash(`${sessionID}\0${callID}`)));
          if (!op || op.state !== 'complete' || op.receiptComplete === false || op.evidence === 'snapshot' && op.hasChanges) unresolved = true;
        }
        const unresolvedKey = `history/${hash(sessionID)}/unresolved/${hash(message.id)}.json`;
        if (unresolved) repo.db.set(unresolvedKey, message.id); else repo.db.remove(unresolvedKey);
      }
      if (state !== undefined) repo.db.set(key, state);
      if (state?.complete && state.first?.id) {
        const session = await noteSession(repo, { sessionID });
        if (session.firstUserMessageID !== state.first.id) {
          session.firstUserMessageID = state.first.id; repo.db.set(sessionKey(sessionID), session);
        }
      }
      await repo.db.commit();
      return repo.db.get(key);
    });
  };
  const findCall = async ({ directory: requested, sessionID, callID }) => {
    const directory = await resolveDirectory(requested);
    return serialize(directory, async () => {
      const repo = await load(directory);
      return (await repo.db.get(operationKey(hash(`${sessionID}\0${callID}`))))?.messageID
        ?? await repo.db.get(`history/${hash(sessionID)}/calls/${hash(callID)}.json`) ?? null;
    });
  };
  const unresolvedHistory = async ({ directory: requested, sessionID, cursor = null }) => {
    const directory = await resolveDirectory(requested);
    return serialize(directory, async () => {
      const repo = await load(directory), messages = [];
      for await (const { key, value } of repo.db.entries(`history/${hash(sessionID)}/unresolved`)) {
        if (cursor && key <= cursor) continue;
        if (messages.length === 128) return { messages, more: true };
        messages.push({ id: value, cursor: key });
      }
      return { messages, more: false };
    });
  };
  const settleHistoricalCall = async (input) => {
    const id = hash(`${input.sessionID}\0${input.callID}`);
    if (active.has(id)) await finish(input);
  };
  return { begin, finish, recordReceipt, recordExecution, importHistorical, registerSession, summarize, summaryPage, diff, restore, deleteSession, historyState, findCall, unresolvedHistory, settleHistoricalCall,
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
