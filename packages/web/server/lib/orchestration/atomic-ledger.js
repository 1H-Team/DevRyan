import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  assertManagedTaskResultEnvelopeMatchesTask,
  validateManagedTaskRecord,
  validateManagedTaskResultEnvelope,
} from '@openchamber/orchestration-runtime';

const DEFAULT_MAX_LEDGER_READ_BYTES = 21 * 1024 * 1024;

const validateSnapshot = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) {
    throw new TypeError('managed orchestration ledger version is invalid');
  }
  if (!Array.isArray(value.tasks) || !Array.isArray(value.resultEnvelopes)) {
    throw new TypeError('managed orchestration ledger collections are invalid');
  }

  const tasks = new Map();
  const idempotencyKeys = new Set();
  for (const task of value.tasks) {
    validateManagedTaskRecord(task);
    if (tasks.has(task.taskId)) {
      throw new TypeError(`duplicate managed task ${task.taskId}`);
    }
    const key = `${task.rootSessionId}\u0000${task.idempotencyKey}`;
    if (idempotencyKeys.has(key)) {
      throw new TypeError(`duplicate managed idempotency key for root ${task.rootSessionId}`);
    }
    tasks.set(task.taskId, task);
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

  return value;
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
  let saveTail = Promise.resolve();
  let recoveryWarning = null;
  let quarantinedPath = null;
  let writeCount = 0;

  const quarantine = async (error) => {
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
      validateSnapshot(parsed);
      return parsed;
    } catch (error) {
      await quarantine(error);
      return null;
    }
  };

  const saveNow = async (snapshot) => {
    validateSnapshot(snapshot);
    const serialized = `${JSON.stringify(snapshot)}\n`;
    const directory = path.dirname(filePath);
    const temporaryPath = `${filePath}.${process.pid}.${randomId()}.tmp`;
    let handle = null;
    try {
      await fsApi.mkdir(directory, { recursive: true, mode: 0o700 });
      handle = await fsApi.open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fsApi.rename(temporaryPath, filePath);
      await fsApi.chmod(filePath, 0o600);
      writeCount += 1;

      try {
        const directoryHandle = await fsApi.open(directory, 'r');
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
      } catch {
        // Directory fsync is not supported on every owner platform.
      }
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await fsApi.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  };

  const save = (snapshot) => {
    const operation = saveTail.then(() => saveNow(snapshot));
    saveTail = operation.catch(() => undefined);
    return operation;
  };

  return {
    filePath,
    load,
    save,
    getDiagnostics() {
      return {
        filePath,
        quarantinedPath,
        recoveryWarning,
        writeCount,
      };
    },
  };
};
