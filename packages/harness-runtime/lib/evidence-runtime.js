const asString = (value) => (
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : ''
);

const turnKey = (sessionID, turnID) => `${sessionID}\u0000${turnID}`;

const toPublicRecord = (record) => ({
  checkpointID: record.checkpointID,
  directory: record.directory,
  sessionID: record.sessionID,
  turnID: record.turnID,
  userMessageID: record.userMessageID,
  status: record.status,
  contended: record.contended,
  gapReason: record.gapReason,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

const parseNumstat = (raw) => {
  const files = [];
  const value = String(raw || '');
  if (value.includes('\0')) {
    const fields = value.split('\0');
    for (let index = 0; index < fields.length; index += 1) {
      const header = fields[index];
      if (!header) continue;
      const match = header.match(/^(-|\d+)\t(-|\d+)\t(.*)$/s);
      if (!match) continue;
      let filePath = match[3];
      let oldPath = null;
      if (!filePath) {
        oldPath = fields[index + 1] || null;
        filePath = fields[index + 2] || '';
        index += 2;
      }
      if (!filePath) continue;
      files.push({
        path: filePath,
        ...(oldPath ? { oldPath, changeType: 'renamed' } : {}),
        additions: match[1] === '-' ? null : Number(match[1]),
        deletions: match[2] === '-' ? null : Number(match[2]),
        binary: match[1] === '-' || match[2] === '-',
      });
    }
    return files;
  }
  for (const line of value.split('\n')) {
    const match = line.match(/^(-|\d+)\t(-|\d+)\t(.+)$/);
    if (!match) continue;
    files.push({
      path: match[3],
      additions: match[1] === '-' ? null : Number(match[1]),
      deletions: match[2] === '-' ? null : Number(match[2]),
      binary: match[1] === '-' || match[2] === '-',
    });
  }
  return files;
};

export const createTurnEvidenceRuntime = (options = {}) => {
  const ledger = options.ledger;
  const git = options.git;
  if (!ledger || !git) throw new TypeError('evidence ledger and git runtime are required');
  const active = new Map();
  const turnJobs = new Map();
  const activeByDirectory = new Map();
  let accepting = true;

  const emitGap = (input, reason) => {
    options.onGap?.({
      ...input,
      reason: asString(reason) || 'capture_failed',
      at: Date.now(),
    });
  };

  const decrementDirectory = (directory) => {
    const count = activeByDirectory.get(directory) ?? 0;
    if (count <= 1) activeByDirectory.delete(directory);
    else activeByDirectory.set(directory, count - 1);
  };

  const start = async (event) => {
    const directory = asString(event.directory);
    const sessionID = asString(event.sessionID);
    const turnID = asString(event.turnID);
    if (!directory || !sessionID || !turnID) return null;
    if (!await options.isEnabled?.(directory)) return null;

    const key = turnKey(sessionID, turnID);
    const existing = active.get(key);
    if (existing) return existing;
    const directoryCount = activeByDirectory.get(directory) ?? 0;
    activeByDirectory.set(directory, directoryCount + 1);
    let record;
    try {
      const projectDirectory = asString(
        await options.resolveProjectDirectory?.(directory),
      ) || directory;
      record = await ledger.begin({
        directory,
        projectDirectory,
        sessionID,
        turnID,
        userMessageID: asString(event.userMessageID) || null,
        contended: directoryCount > 0,
      });
    } catch (error) {
      decrementDirectory(directory);
      emitGap(event, error?.code || error?.message || 'evidence_ledger_failed');
      return null;
    }
    active.set(key, record.checkpointID);
    try {
      const capture = await git.captureBefore({
        directory,
        sessionID,
        turnID,
      });
      await ledger.setBefore(record.checkpointID, capture);
    } catch (error) {
      const reason = error?.code || error?.message || 'before_capture_failed';
      await ledger.markGap(record.checkpointID, reason);
      emitGap(event, reason);
    }
    return record.checkpointID;
  };

  const finish = async (event) => {
    const directory = asString(event.directory);
    let settledDirectory = directory;
    const sessionID = asString(event.sessionID);
    const turnID = asString(event.turnID);
    if (!sessionID || !turnID) return null;
    const key = turnKey(sessionID, turnID);
    const checkpointID = active.get(key);
    if (!checkpointID) return null;
    try {
      const record = await ledger.get(checkpointID);
      if (record?.directory) settledDirectory = record.directory;
      if (!record || record.status === 'gap') return record;
      if (!record.before?.commit) {
        const reason = 'before_checkpoint_missing';
        await ledger.markGap(checkpointID, reason);
        emitGap(event, reason);
        return null;
      }
      const capture = await git.captureAfter({
        directory: record.directory,
        sessionID,
        turnID,
        beforeCommit: record.before.commit,
        beforeTree: record.before.tree,
        beforeHead: record.before.head,
      });
      return await ledger.settle(checkpointID, capture);
    } catch (error) {
      const reason = error?.code || error?.message || 'after_capture_failed';
      await ledger.markGap(checkpointID, reason).catch(() => undefined);
      emitGap(event, reason);
      return null;
    } finally {
      active.delete(key);
      if (settledDirectory) decrementDirectory(settledDirectory);
    }
  };

  const enqueue = (key, operation) => {
    const previous = turnJobs.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(operation)
      .finally(() => {
        if (turnJobs.get(key) === next) turnJobs.delete(key);
      });
    turnJobs.set(key, next);
    return next;
  };

  const processLifecycleEvent = (event) => {
    if (!event || typeof event !== 'object') return;
    const sessionID = asString(event.sessionID);
    const turnID = asString(event.turnID);
    if (!sessionID || !turnID) return;
    const key = turnKey(sessionID, turnID);
    if (event.type === 'turn_started') {
      if (!accepting) return;
      void enqueue(key, () => start(event));
    } else if (event.type === 'turn_completed' || event.type === 'turn_aborted' || event.type === 'turn_failed') {
      void enqueue(key, () => finish(event));
    }
  };

  const reconcile = async () => {
    await ledger.initialize();
    await ledger.reconcile(async (record) => {
      const state = await options.resolveSessionState?.(record).catch(() => 'unknown') ?? 'unknown';
      const key = turnKey(record.sessionID, record.turnID);
      if (state === 'busy' || state === 'running' || state === 'unknown') {
        active.set(key, record.checkpointID);
        activeByDirectory.set(
          record.directory,
          (activeByDirectory.get(record.directory) ?? 0) + 1,
        );
        return;
      }
      if (state === 'idle' && record.before?.commit) {
        try {
          const capture = await git.captureAfter({
            directory: record.directory,
            sessionID: record.sessionID,
            turnID: record.turnID,
            beforeCommit: record.before.commit,
            beforeTree: record.before.tree,
            beforeHead: record.before.head,
          });
          await ledger.settle(record.checkpointID, capture);
          return;
        } catch (error) {
          await ledger.markGap(
            record.checkpointID,
            error?.code || error?.message || 'restart_settlement_failed',
          );
          return;
        }
      }
      await ledger.markGap(
        record.checkpointID,
        record.before?.commit ? 'restart_settlement_unavailable' : 'before_checkpoint_missing',
      );
    });
    await ledger.prune();
  };

  const getDiff = async (checkpointID, file = '') => {
    const record = await ledger.get(asString(checkpointID));
    if (!record) {
      const error = new Error('Evidence checkpoint not found');
      error.code = 'EVIDENCE_CHECKPOINT_NOT_FOUND';
      error.statusCode = 404;
      throw error;
    }
    if (!record.before?.commit || !record.after?.commit) {
      const error = new Error(record.gapReason || 'Evidence checkpoint is incomplete');
      error.code = 'EVIDENCE_CHECKPOINT_INCOMPLETE';
      error.statusCode = 409;
      throw error;
    }
    const summary = await git.diffSummary({
      directory: record.directory,
      beforeCommit: record.before.commit,
      afterCommit: record.after.commit,
    });
    const files = parseNumstat(summary);
    const normalizedFile = asString(file);
    if (!normalizedFile) {
      return {
        checkpointID: record.checkpointID,
        contended: record.contended,
        files,
      };
    }
    if (!files.some((entry) => entry.path === normalizedFile)) {
      const error = new Error('File is not part of this evidence checkpoint');
      error.code = 'EVIDENCE_FILE_NOT_FOUND';
      error.statusCode = 404;
      throw error;
    }
    const fileEntry = files.find((entry) => entry.path === normalizedFile);
    const metadata = await git.fileMetadata({
      directory: record.directory,
      beforeCommit: record.before.commit,
      afterCommit: record.after.commit,
      file: normalizedFile,
      beforeFile: fileEntry?.oldPath,
    });
    const largestFileSize = Math.max(
      metadata.beforeSize ?? 0,
      metadata.afterSize ?? 0,
    );
    if (fileEntry?.binary || largestFileSize > 1024 * 1024) {
      return {
        checkpointID: record.checkpointID,
        contended: record.contended,
        file: {
          ...fileEntry,
          kind: 'metadata',
          size: metadata.size,
          sha256: metadata.sha256,
        },
      };
    }
    const patch = await git.diffFile({
      directory: record.directory,
      beforeCommit: record.before.commit,
      afterCommit: record.after.commit,
      file: normalizedFile,
      beforeFile: fileEntry?.oldPath,
    });
    if (Buffer.byteLength(patch, 'utf8') > 1024 * 1024) {
      return {
        checkpointID: record.checkpointID,
        contended: record.contended,
        file: {
          ...fileEntry,
          kind: 'metadata',
          size: metadata.size,
          sha256: metadata.sha256,
        },
      };
    }
    return {
      checkpointID: record.checkpointID,
      contended: record.contended,
      file: {
        ...fileEntry,
        kind: 'patch',
        patch,
      },
    };
  };

  const beginDrain = () => {
    accepting = false;
  };

  const drain = async () => {
    accepting = false;
    await Promise.allSettled([...turnJobs.values()]);
    await ledger.drain();
  };

  return {
    initialize: reconcile,
    processLifecycleEvent,
    listBySession: (input) => ledger.listBySession(input),
    async listPublicBySession(input) {
      return (await ledger.listBySession(input)).map(toPublicRecord);
    },
    getDiff,
    clearDirectory: (directory) => ledger.clearDirectory(directory),
    clearProject: (directory) => ledger.clearProject(directory),
    deleteSession: (sessionID) => ledger.deleteSession(sessionID),
    beginDrain,
    drain,
  };
};

export {
  parseNumstat as parseEvidenceNumstat,
  toPublicRecord as toPublicEvidenceRecord,
};
