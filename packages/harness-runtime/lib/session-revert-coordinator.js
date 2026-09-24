import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withCrossProcessFileLock, writeFileAtomic } from './atomic-file.js';
import { changeKey } from './session-changes-store.js';

const failure = (code, cause) => Object.assign(new Error(code, { cause }), { code, status: 409 });

/** Coordinates conversation boundaries with the mutation ledger's durable
 * commit decision. The execution owner must acknowledge every target writer's
 * termination; a status-map entry or abort-request acceptance is insufficient.
 * No project publication lock is held while waiting for a provider or command.
 */
export function createSessionRevertCoordinator({ runtime, conversation, executions, directory: storage, onDiagnostic, legacy }) {
  if (!path.isAbsolute(storage ?? '')) throw new TypeError('Absolute coordinator storage directory is required');
  const event = (tx, phase, code) => {
    const id = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value) ? value : undefined;
    try { void Promise.resolve(onDiagnostic?.({ event: 'session_revert', transactionID: tx.id, sessionID: id(tx.rootSessionID),
      messageID: id(tx.targets.find((target) => target.id === tx.rootSessionID)?.targetMessageID),
      phase, ...(code ? { code: id(code), errorID: randomUUID() } : {}) })).catch(() => {}); } catch { /* Diagnostics cannot change settlement. */ }
  };
  const verified = async (directory, sessionID, exact = false) => {
    const session = await conversation.get({ directory, sessionID });
    if (session?.id !== sessionID || typeof session.directory !== 'string') throw failure('session_directory_mismatch');
    const actual = await fs.realpath(session.directory);
    if (actual !== directory && (exact || await runtime.projectDirectory({ directory: actual })
      !== await runtime.projectDirectory({ directory }))) throw failure('session_directory_mismatch');
    return session;
  };
  const requireSupport = async (directory) => {
    const support = await conversation.capabilities({ directory });
    if (support?.legacyConversationRevert !== 1 || !await executions.isConfined({ directory })) {
      throw failure('mutation_runtime_unsupported');
    }
  };
  const restore = async (directory, tx) => {
    // Only restore conversation markers. File rollback is always operation
    // projection, never restoration of an old copy of the shared worktree.
    for (const previous of [...(tx.boundaries ?? [])].reverse()) {
      const current = await verified(directory, previous.id);
      if (current.revert && current.revert.fileRestore !== false) throw failure('mutation_runtime_unsupported');
      if (previous.revert) {
        await conversation.revert({ directory: current.directory, sessionID: previous.id,
          messageID: previous.revert.messageID, partID: previous.revert.partID, files: false });
      } else if (current.revert) await conversation.unrevert({ directory: current.directory, sessionID: previous.id });
    }
    return runtime.settleRevert({ directory, transactionID: tx.id, commit: false });
  };
  const resume = async (directory, transactionID) => withCrossProcessFileLock(
    path.join(storage, changeKey(await runtime.projectDirectory({ directory })), `${transactionID}.lock`), async () => {
      let tx = await runtime.transaction({ directory, transactionID });
      if (!tx) throw failure('revert_unavailable');
      if (tx.state === 'committed') return tx.result;
      if (tx.state === 'cancelled') throw failure('revert_cancelled');
      if (tx.state !== 'prepared' || !['prepared', 'stopped', 'conversation', 'files', 'restoring'].includes(tx.phase)) {
        throw failure('mutation_recovery_required');
      }
      const phase = async (next, extra = {}) => {
        tx = await runtime.updateTransaction({ directory, transactionID, expectedPhase: tx.phase, phase: next, ...extra });
        event(tx, next);
      };
      event(tx, tx.phase);
      if (tx.phase === 'restoring') {
        try { await restore(directory, tx); }
        catch (cause) { event(tx, 'recovery_failed', cause.code); throw failure('mutation_recovery_required', cause); }
        throw failure('revert_cancelled');
      }
      if (tx.phase === 'prepared') {
        // Durable generation fences already prevent new work and late results.
        // Do not substitute a timeout, missing status, or HTTP 200 for this ack.
        let receipt;
        try { receipt = await executions.cancelAndWait({ directory, sessions: tx.members, transactionID: tx.id }); }
        catch (cause) { event(tx, 'cancellation_failed', cause.code); throw failure('mutation_cancellation_failed', cause); }
        if (receipt?.terminated !== true || tx.members.some((id) => !receipt.sessions?.includes(id))) {
          event(tx, 'cancellation_failed'); throw failure('mutation_cancellation_failed');
        }
        for (const lease of await runtime.activeLeases({ directory, sessions: tx.members })) {
          await runtime.cancelLease({ directory, token: lease.token });
        }
        try {
          const boundaries = [];
          for (const target of tx.targets) {
            const session = await verified(directory, target.id);
            // Native snapshots cannot be converted into exact owned history.
            if (session.revert && session.revert.fileRestore !== false) throw failure('mutation_history_unavailable');
            boundaries.push({ id: target.id, revert: session.revert
              ? { messageID: session.revert.messageID, partID: session.revert.partID, fileRestore: false } : null });
          }
          await phase('stopped', { boundaries });
        } catch (cause) {
          await runtime.settleRevert({ directory, transactionID, commit: false });
          throw cause;
        }
      }
      if (tx.phase === 'stopped') await phase('conversation');
      if (tx.phase === 'conversation') {
        try {
          for (const target of [...tx.targets].reverse()) {
            const current = await verified(directory, target.id);
            if (tx.redo) {
              if (current.revert && current.revert.fileRestore !== false) throw failure('mutation_runtime_unsupported');
              await conversation.unrevert({ directory: current.directory, sessionID: target.id });
            } else {
              const session = await conversation.revert({ directory: current.directory, sessionID: target.id, messageID: target.targetMessageID, files: false });
              if (session?.revert?.messageID !== target.targetMessageID || session.revert.fileRestore !== false) {
                throw failure('mutation_runtime_unsupported');
              }
            }
          }
          await phase('files');
        } catch (cause) {
          await phase('restoring');
          try { await restore(directory, tx); }
          catch (recovery) { event(tx, 'recovery_failed', recovery.code); throw failure('mutation_recovery_required', recovery); }
          event(tx, 'cancelled', cause.code);
          throw cause;
        }
      }
      // From here the durable decision is commit. Recover forward if a file
      // write or response fails; rolling native history back would split state.
      try {
        const result = await runtime.settleRevert({ directory, transactionID, commit: true });
        event(tx, 'committed');
        return result;
      } catch (cause) {
        event(tx, 'recovery_failed', cause.code);
        throw failure('mutation_recovery_required', cause);
      }
    }, { timeoutMs: 60_000 },
  );
  // Adopted Revert for conversations the ledger never owned: they ran while the
  // companion was unavailable, so only their uncaptured change evidence exists.
  // Conversation markers use the companion's no-file rollback; files are
  // restored by compare-and-swap under the publication lock, so newer bytes
  // from anyone else become conflicts, never overwritten. One durable record
  // per root session makes the operation resumable and gives Redo its inverse.
  const legacyRecordFile = async (directory, sessionID) => path.join(storage,
    changeKey(await runtime.projectDirectory({ directory })), 'legacy', `${changeKey(sessionID)}.json`);
  const readLegacyRecord = async (file) => {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (cause) { if (cause.code === 'ENOENT') return null; throw cause; }
  };
  const saveLegacyRecord = (file, record) => writeFileAtomic(file, JSON.stringify(record), { mode: 0o600, directoryMode: 0o700 });
  const legacyMembers = async (directory, sessionID, scope) => {
    const members = [sessionID];
    if (scope !== 'session') for (let index = 0; index < members.length; index++) {
      for (const child of await conversation.children({ directory, sessionID: members[index] })) {
        if (typeof child?.id === 'string' && !members.includes(child.id)) members.push(child.id);
      }
    }
    for (const sessionID of members) {
      const state = await runtime.capturedSessionState({ directory, sessionID });
      // Mixed history (continued under the companion) is only exact from its
      // first captured prompt; the ledger path owns that part.
      if (state.captured) throw failure('mutation_history_unavailable');
      if (state.pending) throw failure('session_reverting');
    }
    return members;
  };
  const stopLegacy = async (directory, members, id) => {
    let receipt;
    try { receipt = await executions.cancelAndWait({ directory, sessions: members, transactionID: id }); }
    catch (cause) { throw failure('mutation_cancellation_failed', cause); }
    if (receipt?.terminated !== true || members.some((sessionID) => !receipt.sessions?.includes(sessionID))) {
      throw failure('mutation_cancellation_failed');
    }
  };
  const legacyFiles = async (directory, files, redo) => Promise.all(files.map(async (file) => {
    const read = async (side) => side ? { mode: side.mode, bytes: await legacy.blob({ directory, oid: side.oid }) } : null;
    const [current, previous] = await Promise.all([read(file.current), read(file.previous)]);
    return { path: file.path, expected: redo ? previous : current, target: redo ? current : previous };
  }));
  const settleLegacyFiles = async (directory, file, record) => {
    const result = await runtime.restoreForeign({ directory, files: await legacyFiles(directory, record.files, record.redo) });
    const settled = { ...record, phase: 'committed', result: { files: result.files.filter((entry) => entry.status !== 'unchanged'), conflicts: result.conflicts } };
    await saveLegacyRecord(file, settled);
    event({ id: record.id, rootSessionID: record.rootSessionID, targets: [{ id: record.rootSessionID, targetMessageID: record.messageID }] },
      record.redo ? 'legacy_redo_committed' : 'legacy_committed');
    return settled;
  };
  const legacyResponse = async (directory, record) => {
    const session = await verified(directory, record.rootSessionID);
    const verification = { ok: true, transactionID: record.id };
    const publication = record.result.conflicts.length ? { outcome: 'partial', conflicts: record.result.conflicts } : {};
    const sessions = record.members.map((id) => ({ id }));
    if (record.redo) return { ...session, session, restored: record.result.files, sessions, verification, ...publication };
    return { ...session, session, reverted: { files: record.result.files, sessions }, verification, redoAvailable: true, ...publication };
  };
  const legacyRun = async (directory, input, redo) => {
    const file = await legacyRecordFile(directory, input.sessionID);
    return withCrossProcessFileLock(`${file}.lock`, async () => {
      const previous = await readLegacyRecord(file);
      if (previous && previous.phase !== 'committed') throw failure('mutation_recovery_required');
      let record;
      if (redo) {
        const current = await verified(directory, input.sessionID);
        if (!previous || previous.redo || current.revert?.messageID !== previous.messageID) throw failure('redo_unavailable');
        record = { ...previous, id: randomUUID(), redo: true, phase: 'conversation', result: null };
      } else {
        const members = await legacyMembers(directory, input.sessionID, input.scope);
        const message = await conversation.message({ directory, sessionID: input.sessionID, messageID: input.messageID });
        const since = message?.info?.time?.created;
        if (message?.info?.id !== input.messageID || message.info.role !== 'user' || !Number.isFinite(since)) {
          throw failure('mutation_history_unavailable');
        }
        const current = await verified(directory, input.sessionID);
        if (current.revert && current.revert.fileRestore !== false) throw failure('mutation_history_unavailable');
        const files = await legacy.history({ directory, sessionIDs: members, since });
        record = { version: 1, id: randomUUID(), rootSessionID: input.sessionID, messageID: input.messageID, members, files,
          previousRevert: current.revert ? { messageID: current.revert.messageID, partID: current.revert.partID } : null,
          redo: false, phase: 'conversation', result: null };
      }
      await stopLegacy(directory, record.members, record.id);
      await saveLegacyRecord(file, record);
      try {
        if (redo) {
          const session = await conversation.unrevert({ directory, sessionID: record.rootSessionID });
          if (session?.revert) throw failure('mutation_runtime_unsupported');
        } else {
          const session = await conversation.revert({ directory, sessionID: record.rootSessionID, messageID: record.messageID, files: false });
          if (session?.revert?.messageID !== record.messageID || session.revert.fileRestore !== false) throw failure('mutation_runtime_unsupported');
        }
      } catch (cause) {
        // No file has changed yet: put the conversation marker back and forget
        // this attempt; the previous committed record (if any) stays valid.
        try {
          if (redo) await conversation.revert({ directory, sessionID: record.rootSessionID, messageID: record.messageID, files: false });
          else if (record.previousRevert) await conversation.revert({ directory, sessionID: record.rootSessionID, ...record.previousRevert, files: false });
          else await conversation.unrevert({ directory, sessionID: record.rootSessionID });
        } catch (recovery) { throw failure('mutation_recovery_required', recovery); }
        if (previous) await saveLegacyRecord(file, previous); else await fs.rm(file, { force: true });
        throw cause;
      }
      // From here the decision is commit; recovery completes the file phase.
      record = { ...record, phase: 'files' };
      await saveLegacyRecord(file, record);
      return legacyResponse(directory, await settleLegacyFiles(directory, file, record));
    }, { timeoutMs: 60_000 });
  };
  const recoverLegacy = async (directory) => {
    const folder = path.join(storage, changeKey(await runtime.projectDirectory({ directory })), 'legacy');
    let names = [];
    try { names = await fs.readdir(folder); } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
    for (const name of names.filter((entry) => entry.endsWith('.json'))) {
      const file = path.join(folder, name);
      await withCrossProcessFileLock(`${file}.lock`, async () => {
        const record = await readLegacyRecord(file);
        if (!record || record.phase === 'committed') return;
        if (record.phase === 'files') { await settleLegacyFiles(directory, file, record); return; }
        // Interrupted around the conversation marker: finish only if it landed.
        const session = await verified(directory, record.rootSessionID);
        const landed = record.redo ? !session.revert : session.revert?.messageID === record.messageID && session.revert.fileRestore === false;
        if (landed) await settleLegacyFiles(directory, file, { ...record, phase: 'files' });
        else await fs.rm(file, { force: true });
      }, { timeoutMs: 60_000 });
    }
  };
  const run = async (input, redo) => {
    const directory = await fs.realpath(input.directory);
    await requireSupport(directory);
    await verified(directory, input.sessionID, true);
    if (legacy) {
      if (redo) {
        const record = await readLegacyRecord(await legacyRecordFile(directory, input.sessionID));
        if (record?.phase === 'committed' && !record.redo) return legacyRun(directory, input, true);
      } else if (!(await runtime.capturedSessionState({ directory, sessionID: input.sessionID })).captured) {
        return legacyRun(directory, input, false);
      }
    }
    const tx = await (redo ? runtime.prepareRedo : runtime.prepareRevert)({ ...input, directory });
    const result = await resume(directory, tx.id);
    const session = await verified(directory, input.sessionID);
    const verification = { ok: true, transactionID: tx.id };
    const publication = result.outcome === 'partial' ? { outcome: 'partial', conflicts: result.conflicts ?? [] } : {};
    if (redo) return { ...session, session, restored: result.files, sessions: result.sessions.map(({ id }) => ({ id })), verification, ...publication };
    return { ...session, session, reverted: { files: result.files, sessions: result.sessions },
      verification, redoAvailable: result.redoAvailable, ...publication };
  };
  return {
    revert: (input) => run(input, false),
    redo: (input) => run(input, true),
    restoreFiles: async (input) => {
      const directory = await fs.realpath(input.directory);
      await requireSupport(directory);
      await verified(directory, input.sessionID, true);
      const tx = await runtime.prepareFileRestore({ ...input, directory });
      return resume(directory, tx.id);
    },
    recover: async (input) => {
      const directory = await fs.realpath(input.directory);
      await requireSupport(directory);
      for (const tx of await runtime.pendingTransactions({ directory })) {
        try { await resume(directory, tx.id); }
        catch (cause) { if (cause.code !== 'revert_cancelled') throw cause; }
      }
      if (legacy) await recoverLegacy(directory);
    },
  };
}
