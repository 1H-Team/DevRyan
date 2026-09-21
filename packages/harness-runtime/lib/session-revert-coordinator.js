import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withCrossProcessFileLock } from './atomic-file.js';
import { changeKey } from './session-changes-store.js';

const failure = (code, cause) => Object.assign(new Error(code, { cause }), { code, status: 409 });

/** Coordinates conversation boundaries with the mutation ledger's durable
 * commit decision. The execution owner must acknowledge every target writer's
 * termination; a status-map entry or abort-request acceptance is insufficient.
 * No project publication lock is held while waiting for a provider or command.
 */
export function createSessionRevertCoordinator({ runtime, conversation, executions, directory: storage, onDiagnostic }) {
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
  const run = async (input, redo) => {
    const directory = await fs.realpath(input.directory);
    await requireSupport(directory);
    await verified(directory, input.sessionID, true);
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
    },
  };
}
