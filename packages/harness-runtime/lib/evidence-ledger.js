import crypto from 'node:crypto';

const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_TURNS_PER_REPOSITORY = 200;

const asString = (value) => (
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : ''
);

export const validateEvidenceRecord = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) {
    throw new TypeError('evidence record version is invalid');
  }
  for (const field of ['checkpointID', 'directory', 'sessionID', 'turnID']) {
    if (!asString(value[field])) throw new TypeError(`evidence ${field} is required`);
  }
  if (!['capturing_before', 'capturing_after', 'complete', 'gap'].includes(value.status)) {
    throw new TypeError('evidence status is invalid');
  }
  return value;
};

export const createEvidenceLedger = (options = {}) => {
  const store = options.store;
  if (!store) throw new TypeError('evidence record store is required');
  const now = options.now ?? Date.now;
  const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  const maxTurns = options.maxTurnsPerRepository ?? DEFAULT_MAX_TURNS_PER_REPOSITORY;
  const records = new Map();
  let initialized = false;

  const persist = async (record) => {
    record.updatedAt = now();
    validateEvidenceRecord(record);
    await store.writeRecord(record.checkpointID, record);
    records.set(record.checkpointID, record);
    options.onTransition?.(structuredClone(record));
    return record;
  };

  const initialize = async () => {
    if (initialized) return;
    await store.initialize();
    for (const { record } of await store.listRecords()) {
      const validated = validateEvidenceRecord(record);
      records.set(validated.checkpointID, validated);
    }
    initialized = true;
  };

  const begin = async (input = {}) => {
    await initialize();
    const checkpointID = asString(input.checkpointID)
      || `ev_${crypto.randomUUID().replaceAll('-', '')}`;
    const timestamp = now();
    const record = {
      version: 1,
      checkpointID,
      directory: asString(input.directory),
      projectDirectory: asString(input.projectDirectory) || asString(input.directory),
      sessionID: asString(input.sessionID),
      turnID: asString(input.turnID),
      userMessageID: asString(input.userMessageID) || null,
      status: 'capturing_before',
      before: null,
      after: null,
      contended: input.contended === true,
      gapReason: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await persist(record);
    return structuredClone(record);
  };

  const setBefore = async (checkpointID, capture) => {
    await initialize();
    const record = records.get(checkpointID);
    if (!record) throw new Error('Evidence checkpoint not found');
    record.before = structuredClone(capture);
    record.contended ||= capture?.contended === true;
    record.status = 'capturing_after';
    await persist(record);
    return structuredClone(record);
  };

  const settle = async (checkpointID, capture) => {
    await initialize();
    const record = records.get(checkpointID);
    if (!record) throw new Error('Evidence checkpoint not found');
    record.after = structuredClone(capture);
    record.contended ||= capture?.contended === true;
    record.status = 'complete';
    record.gapReason = null;
    await persist(record);
    await prune();
    return structuredClone(record);
  };

  const markGap = async (checkpointID, reason) => {
    await initialize();
    const record = records.get(checkpointID);
    if (!record) throw new Error('Evidence checkpoint not found');
    record.status = 'gap';
    record.gapReason = asString(reason) || 'capture_failed';
    await persist(record);
    return structuredClone(record);
  };

  const get = async (checkpointID) => {
    await initialize();
    const record = records.get(asString(checkpointID));
    return record ? structuredClone(record) : null;
  };

  const listBySession = async ({ sessionID, directory, userMessageID } = {}) => {
    await initialize();
    return [...records.values()]
      .filter((record) => (
        (!sessionID || record.sessionID === sessionID)
        && (!directory || record.directory === directory)
        && (!userMessageID || record.userMessageID === userMessageID)
      ))
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((record) => structuredClone(record));
  };

  const deleteRecord = async (record) => {
    for (const capture of [record.before, record.after]) {
      if (!capture?.ref || typeof options.deleteRef !== 'function') continue;
      await options.deleteRef({
        directory: record.directory,
        ref: capture.ref,
      }).catch(() => undefined);
    }
    records.delete(record.checkpointID);
    await store.deleteRecord(record.checkpointID);
  };

  const prune = async () => {
    await initialize();
    const cutoff = now() - retentionMs;
    const byDirectory = new Map();
    for (const record of records.values()) {
      const repository = record.projectDirectory || record.directory;
      const list = byDirectory.get(repository) ?? [];
      list.push(record);
      byDirectory.set(repository, list);
    }
    let removed = 0;
    for (const list of byDirectory.values()) {
      list.sort((left, right) => right.createdAt - left.createdAt);
      for (let index = 0; index < list.length; index += 1) {
        const record = list[index];
        if (record.createdAt >= cutoff && index < maxTurns) continue;
        await deleteRecord(record);
        removed += 1;
      }
    }
    return removed;
  };

  const clearDirectory = async (directory) => {
    await initialize();
    const targets = [...records.values()].filter((record) => record.directory === directory);
    for (const record of targets) await deleteRecord(record);
    return targets.length;
  };

  const clearProject = async (projectDirectory) => {
    await initialize();
    const targets = [...records.values()].filter((record) => (
      (record.projectDirectory || record.directory) === projectDirectory
    ));
    for (const record of targets) await deleteRecord(record);
    return targets.length;
  };

  const deleteSession = async (sessionID) => {
    await initialize();
    const targets = [...records.values()].filter((record) => record.sessionID === sessionID);
    for (const record of targets) await deleteRecord(record);
    return targets.length;
  };

  const reconcile = async (reconciler) => {
    await initialize();
    for (const record of [...records.values()]) {
      if (record.status !== 'capturing_before' && record.status !== 'capturing_after') continue;
      await reconciler(structuredClone(record));
    }
  };

  return {
    initialize,
    begin,
    setBefore,
    settle,
    markGap,
    get,
    listBySession,
    clearDirectory,
    clearProject,
    deleteSession,
    reconcile,
    prune,
    drain: () => store.drain(),
  };
};

export {
  DEFAULT_MAX_TURNS_PER_REPOSITORY,
  DEFAULT_RETENTION_MS as DEFAULT_EVIDENCE_RETENTION_MS,
};
