import crypto from 'node:crypto';
import nodeFs from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  assertManagedTaskResultEnvelopeMatchesTask,
  validateManagedTaskRecord,
  validateManagedTaskResultEnvelope,
} from '@openchamber/orchestration-runtime';
import { writeFileAtomic } from '@openchamber/harness-runtime';

const DEFAULT_MAX_LEDGER_READ_BYTES = 21 * 1024 * 1024;
const DEFAULT_OWNER_HEARTBEAT_MS = 10_000;
const DEFAULT_OWNER_STALE_MS = 45_000;
const MAX_OWNER_RECORD_BYTES = 4 * 1024;

const createOwnershipError = (code, message) => Object.assign(new Error(message), {
  code,
  statusCode: 409,
});

const isValidOwnerRecord = (value) => (
  Boolean(value)
  && typeof value === 'object'
  && !Array.isArray(value)
  && value.version === 1
  && typeof value.token === 'string'
  && value.token.length >= 16
  && Number.isSafeInteger(value.pid)
  && value.pid > 0
  && Number.isSafeInteger(value.acquiredAt)
  && value.acquiredAt >= 0
);

const defaultIsProcessAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'EPERM') return true;
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
};

const validateSnapshot = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) {
    throw new TypeError('managed orchestration ledger version is invalid');
  }
  if (!Array.isArray(value.tasks) || !Array.isArray(value.resultEnvelopes)) {
    throw new TypeError('managed orchestration ledger collections are invalid');
  }

  const tasks = new Map();
  const normalizedTasks = [];
  const idempotencyKeys = new Set();
  for (const candidate of value.tasks) {
    const task = {
      ...candidate,
      dispatchGroupId: candidate?.dispatchGroupId ?? null,
      dispatchCallId: candidate?.dispatchCallId ?? null,
      readOnly: candidate?.readOnly ?? false,
    };
    validateManagedTaskRecord(task);
    if (tasks.has(task.taskId)) {
      throw new TypeError(`duplicate managed task ${task.taskId}`);
    }
    const key = `${task.rootSessionId}\u0000${task.idempotencyKey}`;
    if (idempotencyKeys.has(key)) {
      throw new TypeError(`duplicate managed idempotency key for root ${task.rootSessionId}`);
    }
    tasks.set(task.taskId, task);
    normalizedTasks.push(task);
    idempotencyKeys.add(key);
  }

  const envelopes = new Set();
  for (const envelope of value.resultEnvelopes) {
    validateManagedTaskResultEnvelope(envelope);
    if (envelopes.has(envelope.taskId)) {
      throw new TypeError(`duplicate managed result envelope for task ${envelope.taskId}`);
    }
    const task = tasks.get(envelope.taskId);
    if (!task) {
      throw new TypeError(`managed result envelope has no task ${envelope.taskId}`);
    }
    assertManagedTaskResultEnvelopeMatchesTask(task, envelope);
    envelopes.add(envelope.taskId);
  }

  return { ...value, tasks: normalizedTasks };
};

export const createAtomicManagedOrchestrationLedger = (options = {}) => {
  const dataDirectory = path.resolve(options.dataDirectory);
  const filePath = options.filePath
    ? path.resolve(options.filePath)
    : path.join(dataDirectory, 'orchestration', 'ledger.json');
  const fsApi = options.fs ?? fs;
  const now = options.now ?? Date.now;
  const randomId = options.randomId ?? (() => crypto.randomUUID().replaceAll('-', ''));
  const logger = options.logger ?? console;
  const maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_LEDGER_READ_BYTES;
  const ownerPath = options.ownerPath
    ? path.resolve(options.ownerPath)
    : path.join(path.dirname(filePath), 'owner.lock');
  const processId = options.pid ?? process.pid;
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_OWNER_HEARTBEAT_MS;
  const ownerStaleMs = options.ownerStaleMs ?? DEFAULT_OWNER_STALE_MS;
  const processRef = options.process ?? process;
  const syncFs = options.syncFs ?? nodeFs;
  let saveTail = Promise.resolve();
  let acquirePromise = null;
  let recoveryWarning = null;
  let quarantinedPath = null;
  let writeCount = 0;
  let ownershipToken = null;
  let ownershipState = 'unowned';
  let ownerHeartbeatTimer = null;
  let lastObservedHeartbeatAt = null;
  let exitReleaseHandler = null;

  const releaseOwnerLockSync = () => {
    if (!ownershipToken) return;
    try {
      const record = JSON.parse(syncFs.readFileSync(ownerPath, 'utf8'));
      if (!isValidOwnerRecord(record) || record.token !== ownershipToken) return;
      syncFs.unlinkSync(ownerPath);
    } catch {
    }
  };

  const attachExitRelease = () => {
    if (exitReleaseHandler) return;
    exitReleaseHandler = () => {
      releaseOwnerLockSync();
    };
    processRef.on?.('exit', exitReleaseHandler);
  };

  const detachExitRelease = () => {
    if (!exitReleaseHandler) return;
    if (typeof processRef.off === 'function') {
      processRef.off('exit', exitReleaseHandler);
    } else {
      processRef.removeListener?.('exit', exitReleaseHandler);
    }
    exitReleaseHandler = null;
  };

  const readOwnerRecord = async () => {
    const stat = await fsApi.stat(ownerPath);
    if (!stat.isFile()) {
      throw new TypeError('managed orchestration owner lock is not a regular file');
    }
    if (stat.size > MAX_OWNER_RECORD_BYTES) {
      throw new RangeError('managed orchestration owner lock is oversized');
    }
    const record = JSON.parse(await fsApi.readFile(ownerPath, 'utf8'));
    if (!isValidOwnerRecord(record)) {
      throw new TypeError('managed orchestration owner lock is invalid');
    }
    return { record, stat };
  };

  const assertOwnership = async () => {
    if (!ownershipToken) {
      ownershipState = 'unowned';
      throw createOwnershipError(
        'managed_orchestration_owner_conflict',
        'Managed orchestration requires an exclusive data-directory owner',
      );
    }

    try {
      const { record, stat } = await readOwnerRecord();
      lastObservedHeartbeatAt = Math.trunc(stat.mtimeMs);
      if (record.token === ownershipToken) return;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logger.warn?.('[ManagedOrchestration] Failed to verify ledger ownership', {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    ownershipState = 'lost';
    detachExitRelease();
    throw createOwnershipError(
      'managed_orchestration_ownership_lost',
      'Managed orchestration lost exclusive ownership of its data directory',
    );
  };

  const stopHeartbeat = () => {
    if (ownerHeartbeatTimer) clearInterval(ownerHeartbeatTimer);
    ownerHeartbeatTimer = null;
  };

  const heartbeat = async () => {
    await assertOwnership();
    const heartbeatAt = now();
    const timestamp = new Date(heartbeatAt);
    await fsApi.utimes(ownerPath, timestamp, timestamp);
    lastObservedHeartbeatAt = heartbeatAt;
  };

  const startHeartbeat = () => {
    stopHeartbeat();
    if (!Number.isFinite(heartbeatIntervalMs) || heartbeatIntervalMs <= 0) return;
    ownerHeartbeatTimer = setInterval(() => {
      void heartbeat().catch((error) => {
        stopHeartbeat();
        logger.warn?.('[ManagedOrchestration] Ledger ownership heartbeat stopped', {
          code: error?.code ?? 'heartbeat_failed',
          reason: error instanceof Error ? error.message : String(error),
        });
      });
    }, heartbeatIntervalMs);
    ownerHeartbeatTimer.unref?.();
  };

  const removeExactPath = async (target) => {
    try {
      await fsApi.rm(target, { force: true });
    } catch (error) {
      logger.warn?.('[ManagedOrchestration] Failed to remove retired owner lock', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const dropOwnerLock = async () => {
    const retiredPath = `${ownerPath}.released-${now()}-${randomId()}`;
    try {
      await fsApi.rename(ownerPath, retiredPath);
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
    await removeExactPath(retiredPath);
    return true;
  };

  const inspectExistingOwner = async () => {
    let existing;
    try {
      existing = await readOwnerRecord();
    } catch (error) {
      if (error?.code === 'ENOENT') return { retry: true };
      ownershipState = 'conflict';
      throw createOwnershipError(
        'managed_orchestration_owner_conflict',
        'Managed orchestration found an unreadable owner lock; refusing unsafe recovery',
      );
    }

    const heartbeatAt = Math.trunc(existing.stat.mtimeMs);
    lastObservedHeartbeatAt = heartbeatAt;
    const heartbeatAgeMs = Math.max(0, now() - heartbeatAt);
    const alive = await isProcessAlive(existing.record.pid);
    if (alive) {
      ownershipState = 'conflict';
      throw createOwnershipError(
        'managed_orchestration_owner_conflict',
        'Managed orchestration is already owned by another DevRyan runtime using this data directory',
      );
    }

    const retiredPath = `${ownerPath}.stale-${now()}-${randomId()}`;
    try {
      await fsApi.rename(ownerPath, retiredPath);
    } catch (error) {
      if (error?.code === 'ENOENT') return { retry: true };
      throw error;
    }
    await removeExactPath(retiredPath);
    logger.warn?.('[ManagedOrchestration] Recovered a dead ledger owner lock', {
      heartbeatAgeMs,
      staleAfterMs: ownerStaleMs,
    });
    return { retry: true };
  };

  const acquireOwnershipNow = async () => {
    if (ownershipToken) {
      await assertOwnership();
      return;
    }

    await fsApi.mkdir(path.dirname(ownerPath), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const token = randomId();
      const acquiredAt = now();
      const candidatePath = `${ownerPath}.candidate-${processId}-${randomId()}`;
      await fsApi.writeFile(candidatePath, `${JSON.stringify({
        version: 1,
        token,
        pid: processId,
        acquiredAt,
      })}\n`, { flag: 'wx', mode: 0o600 });

      try {
        await fsApi.link(candidatePath, ownerPath);
        ownershipToken = token;
        ownershipState = 'owned';
        lastObservedHeartbeatAt = acquiredAt;
        startHeartbeat();
        attachExitRelease();
        return;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      } finally {
        await removeExactPath(candidatePath);
      }

      const inspection = await inspectExistingOwner();
      if (!inspection.retry) break;
    }

    ownershipState = 'conflict';
    throw createOwnershipError(
      'managed_orchestration_owner_conflict',
      'Managed orchestration could not acquire exclusive ownership of its data directory',
    );
  };

  const acquireOwnership = () => {
    if (acquirePromise) return acquirePromise;
    acquirePromise = acquireOwnershipNow().finally(() => {
      acquirePromise = null;
    });
    return acquirePromise;
  };

  const releaseOwnership = async () => {
    stopHeartbeat();
    if (!ownershipToken) {
      await saveTail;
      return false;
    }

    try {
      await assertOwnership();
    } catch {
      detachExitRelease();
      ownershipToken = null;
      await saveTail;
      return false;
    }

    let dropped = false;
    try {
      dropped = await dropOwnerLock();
    } finally {
      detachExitRelease();
      ownershipToken = null;
      ownershipState = dropped ? 'unowned' : 'lost';
    }
    await saveTail;
    return dropped;
  };

  const quarantine = async (error) => {
    await assertOwnership();
    const destination = `${filePath}.corrupt-${now()}-${randomId()}`;
    await fsApi.rename(filePath, destination);
    quarantinedPath = destination;
    recoveryWarning = `Managed orchestration ledger was quarantined: ${error instanceof Error ? error.message : String(error)}`;
    logger.warn?.('[ManagedOrchestration] Quarantined invalid ledger', {
      filePath,
      quarantinedPath: destination,
      reason: error instanceof Error ? error.message : String(error),
    });
  };

  const load = async () => {
    await saveTail;
    await assertOwnership();
    let stat;
    try {
      stat = await fsApi.stat(filePath);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }

    try {
      if (!stat.isFile()) {
        throw new TypeError('managed orchestration ledger is not a regular file');
      }
      if (stat.size > maxReadBytes) {
        throw new RangeError(`managed orchestration ledger exceeds ${maxReadBytes} bytes`);
      }
      const parsed = JSON.parse(await fsApi.readFile(filePath, 'utf8'));
      await assertOwnership();
      return validateSnapshot(parsed);
    } catch (error) {
      await quarantine(error);
      return null;
    }
  };

  const saveNow = async (snapshot) => {
    await assertOwnership();
    const validated = validateSnapshot(snapshot);
    const serialized = `${JSON.stringify(validated)}\n`;
    await writeFileAtomic(filePath, serialized, {
      fs: fsApi,
      mode: 0o600,
      directoryMode: 0o700,
      randomId,
    });
    await assertOwnership();
    writeCount += 1;
  };

  const save = (snapshot) => {
    const operation = saveTail.then(() => saveNow(snapshot));
    saveTail = operation.catch(() => undefined);
    return operation;
  };

  return {
    filePath,
    acquireOwnership,
    verifyOwnership: assertOwnership,
    releaseOwnership,
    load,
    save,
    getDiagnostics() {
      const heartbeatAgeMs = lastObservedHeartbeatAt === null
        ? null
        : Math.max(0, now() - lastObservedHeartbeatAt);
      return {
        filePath,
        quarantinedPath,
        recoveryWarning,
        writeCount,
        ownership: {
          state: ownershipState,
          heartbeatAgeMs,
          staleAfterMs: ownerStaleMs,
        },
      };
    },
  };
};
