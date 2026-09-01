import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const OUTBOX_VERSION = 1;
const MAX_OUTBOX_BYTES = 2 * 1024 * 1024;
const VALID_SOURCES = new Set(['free_zen', 'session_model', 'local_fallback']);
const VALID_STATES = new Set(['pending_idle', 'persisting']);

const trimString = (value) => (typeof value === 'string' ? value.trim() : '');
const finiteTimestamp = (value, fallback) => (
  Number.isFinite(value) && value >= 0 ? Number(value) : fallback
);

const cloneJob = (job) => ({ ...job });

const normalizeJob = (value, now) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const key = trimString(value.key);
  const sessionID = trimString(value.sessionID);
  const directory = trimString(value.directory);
  const sourceHash = trimString(value.sourceHash).toLowerCase();
  const candidateTitle = trimString(value.candidateTitle);
  const source = trimString(value.source);
  const state = trimString(value.state);
  if (!key || key.length > 2_048 || !sessionID || sessionID.length > 256) return null;
  if (!/^[a-f0-9]{64}$/.test(sourceHash)) return null;
  if (!candidateTitle || candidateTitle.length > 80) return null;
  if (!VALID_SOURCES.has(source) || !VALID_STATES.has(state)) return null;

  const createdAt = finiteTimestamp(value.createdAt, now);
  return {
    key,
    sessionID,
    directory,
    sourceHash,
    candidateTitle,
    source,
    state,
    attemptCount: Number.isSafeInteger(value.attemptCount) && value.attemptCount >= 0
      ? value.attemptCount
      : 0,
    nextAttemptAt: finiteTimestamp(value.nextAttemptAt, 0),
    createdAt,
    updatedAt: finiteTimestamp(value.updatedAt, createdAt),
    idleConfirmedAt: finiteTimestamp(value.idleConfirmedAt, 0),
    inactiveObservationCount: Number.isSafeInteger(value.inactiveObservationCount)
      && value.inactiveObservationCount >= 0
      ? value.inactiveObservationCount
      : 0,
    lastInactiveObservedAt: finiteTimestamp(value.lastInactiveObservedAt, 0),
    providerID: trimString(value.providerID),
    modelID: trimString(value.modelID),
  };
};

export const createMemorySessionTitleOutbox = ({ initialJobs = [], now = () => Date.now() } = {}) => {
  const jobs = new Map();
  for (const value of initialJobs) {
    const job = normalizeJob(value, now());
    if (job) jobs.set(job.key, job);
  }

  return {
    async list() {
      return [...jobs.values()].map(cloneJob);
    },
    async upsert(value) {
      const job = normalizeJob(value, now());
      if (!job) throw new Error('Invalid session title outbox job');
      jobs.set(job.key, job);
      return cloneJob(job);
    },
    async remove(key) {
      return jobs.delete(trimString(key));
    },
    async dispose() {},
  };
};

export const createFileSessionTitleOutbox = ({
  filePath,
  fsApi = fs,
  now = () => Date.now(),
  logger = console,
  onCorrupt = null,
} = {}) => {
  const configuredFilePath = trimString(filePath);
  if (!configuredFilePath) throw new Error('Session title outbox file path is required');
  const resolvedFilePath = path.resolve(configuredFilePath);
  let loaded = false;
  let loading = null;
  let saveChain = Promise.resolve();
  const jobs = new Map();

  const quarantine = async (error) => {
    const destination = `${resolvedFilePath}.corrupt-${now()}`;
    try {
      await fsApi.rename(resolvedFilePath, destination);
    } catch {
      // A missing/unmovable file is still recoverable: start from an empty
      // outbox and let authoritative placeholder recovery rebuild it.
    }
    logger.warn?.('[SessionTitle] Quarantined an invalid title outbox:', error instanceof Error ? error.message : error);
    try {
      await onCorrupt?.({ error, destination });
    } catch {
    }
  };

  const ensureLoaded = async () => {
    if (loaded) return;
    if (loading) return loading;
    loading = (async () => {
      try {
        const stat = await fsApi.stat(resolvedFilePath);
        if (stat.size > MAX_OUTBOX_BYTES) throw new Error('Session title outbox exceeds its size limit');
        const raw = await fsApi.readFile(resolvedFilePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed?.version !== OUTBOX_VERSION || !Array.isArray(parsed.jobs)) {
          throw new Error('Session title outbox has an unsupported schema');
        }
        for (const value of parsed.jobs) {
          const job = normalizeJob(value, now());
          if (!job || jobs.has(job.key)) throw new Error('Session title outbox contains an invalid job');
          jobs.set(job.key, job);
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') await quarantine(error);
      } finally {
        loaded = true;
        loading = null;
      }
    })();
    return loading;
  };

  const writeSnapshot = async (snapshot) => {
    const directory = path.dirname(resolvedFilePath);
    await fsApi.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${resolvedFilePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    let handle = null;
    try {
      handle = await fsApi.open(temporaryPath, 'w', 0o600);
      await handle.writeFile(`${JSON.stringify({ version: OUTBOX_VERSION, jobs: snapshot }, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fsApi.rename(temporaryPath, resolvedFilePath);
      try {
        const directoryHandle = await fsApi.open(directory, 'r');
        await directoryHandle.sync();
        await directoryHandle.close();
      } catch {
      }
    } finally {
      await handle?.close().catch(() => {});
      await fsApi.rm(temporaryPath, { force: true }).catch(() => {});
    }
  };

  const persist = () => {
    const snapshot = [...jobs.values()]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map(cloneJob);
    saveChain = saveChain
      .catch(() => {})
      .then(() => writeSnapshot(snapshot));
    return saveChain;
  };

  return {
    filePath: resolvedFilePath,
    async list() {
      await ensureLoaded();
      return [...jobs.values()].map(cloneJob);
    },
    async upsert(value) {
      await ensureLoaded();
      const job = normalizeJob(value, now());
      if (!job) throw new Error('Invalid session title outbox job');
      jobs.set(job.key, job);
      await persist();
      return cloneJob(job);
    },
    async remove(key) {
      await ensureLoaded();
      const removed = jobs.delete(trimString(key));
      if (removed) await persist();
      return removed;
    },
    async dispose() {
      await ensureLoaded();
      await saveChain.catch(() => {});
    },
  };
};
