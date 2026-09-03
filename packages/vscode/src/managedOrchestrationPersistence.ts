import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  assertManagedTaskResultEnvelopeMatchesTask,
  validateManagedTaskRecord,
  validateManagedTaskResultEnvelope,
  type ManagedOrchestrationPersistence,
  type ManagedOrchestrationState,
} from '@openchamber/orchestration-runtime';

const DEFAULT_MAX_LEDGER_READ_BYTES = 21 * 1024 * 1024;

type Logger = Pick<Console, 'warn'>;

export type VsCodeManagedOrchestrationPersistence = ManagedOrchestrationPersistence & {
  filePath?: string;
  getDiagnostics?: () => {
    quarantinedPath?: string | null;
    recoveryWarning?: string | null;
    writeCount?: number;
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

const validateSnapshot = (value: unknown): ManagedOrchestrationState => {
  if (!isRecord(value) || value.version !== 1) {
    throw new TypeError('managed orchestration ledger version is invalid');
  }
  if (!Array.isArray(value.tasks) || !Array.isArray(value.resultEnvelopes)) {
    throw new TypeError('managed orchestration ledger collections are invalid');
  }

  const tasks = new Map<string, ReturnType<typeof validateManagedTaskRecord>>();
  const normalizedTasks: ReturnType<typeof validateManagedTaskRecord>[] = [];
  const idempotencyKeys = new Set<string>();
  for (const candidate of value.tasks) {
    const task = validateManagedTaskRecord({
      ...(isRecord(candidate) ? candidate : {}),
      dispatchGroupId: isRecord(candidate) && candidate.dispatchGroupId !== undefined
        ? candidate.dispatchGroupId
        : null,
      dispatchCallId: isRecord(candidate) && candidate.dispatchCallId !== undefined
        ? candidate.dispatchCallId
        : null,
      readOnly: isRecord(candidate) && candidate.readOnly !== undefined
        ? candidate.readOnly
        : false,
      recoveryLineageId: isRecord(candidate) && candidate.recoveryLineageId !== undefined
        ? candidate.recoveryLineageId
        : null,
      childPromptedAt: isRecord(candidate) && candidate.childPromptedAt !== undefined
        ? candidate.childPromptedAt
        : null,
      firstAssistantPartAt: isRecord(candidate) && candidate.firstAssistantPartAt !== undefined
        ? candidate.firstAssistantPartAt
        : null,
      waitingReason: isRecord(candidate) && candidate.waitingReason !== undefined
        ? candidate.waitingReason
        : null,
    });
    if (tasks.has(task.taskId)) throw new TypeError(`duplicate managed task ${task.taskId}`);
    const idempotencyKey = `${task.rootSessionId}\u0000${task.idempotencyKey}`;
    if (idempotencyKeys.has(idempotencyKey)) {
      throw new TypeError(`duplicate managed idempotency key for root ${task.rootSessionId}`);
    }
    tasks.set(task.taskId, task);
    normalizedTasks.push(task);
    idempotencyKeys.add(idempotencyKey);
  }

  const envelopes = new Set<string>();
  const normalizedEnvelopes: ReturnType<typeof validateManagedTaskResultEnvelope>[] = [];
  for (const candidate of value.resultEnvelopes) {
    const envelope = validateManagedTaskResultEnvelope({
      ...(isRecord(candidate) ? candidate : {}),
      providerResetAt: isRecord(candidate) && candidate.providerResetAt !== undefined
        ? candidate.providerResetAt
        : null,
      autoResume: isRecord(candidate) && candidate.autoResume !== undefined
        ? candidate.autoResume
        : null,
    });
    if (envelopes.has(envelope.taskId)) {
      throw new TypeError(`duplicate managed result envelope for task ${envelope.taskId}`);
    }
    const task = tasks.get(envelope.taskId);
    if (!task) throw new TypeError(`managed result envelope has no task ${envelope.taskId}`);
    assertManagedTaskResultEnvelopeMatchesTask(task, envelope);
    envelopes.add(envelope.taskId);
    normalizedEnvelopes.push(envelope);
  }

  return {
    ...value,
    tasks: normalizedTasks,
    resultEnvelopes: normalizedEnvelopes,
  } as unknown as ManagedOrchestrationState;
};

export const createVsCodeManagedOrchestrationLedger = (options: {
  storageDirectory: string;
  logger?: Logger;
  maxReadBytes?: number;
  now?: () => number;
  randomId?: () => string;
}): VsCodeManagedOrchestrationPersistence & { filePath: string } => {
  const storageDirectory = path.resolve(options.storageDirectory);
  const filePath = path.join(storageDirectory, 'orchestration', 'ledger.json');
  const logger = options.logger ?? console;
  const maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_LEDGER_READ_BYTES;
  const now = options.now ?? Date.now;
  const randomId = options.randomId ?? (() => crypto.randomUUID().replaceAll('-', ''));
  let saveTail = Promise.resolve();
  let recoveryWarning: string | null = null;
  let quarantinedPath: string | null = null;
  let writeCount = 0;

  const quarantine = async (error: unknown) => {
    const destination = `${filePath}.corrupt-${now()}-${randomId()}`;
    await fs.rename(filePath, destination);
    quarantinedPath = destination;
    recoveryWarning = `Managed orchestration ledger was quarantined: ${errorMessage(error)}`;
    logger.warn('[ManagedOrchestration] Quarantined invalid VS Code ledger', {
      reason: errorMessage(error),
    });
  };

  const load = async () => {
    await saveTail;
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw error;
    }

    try {
      if (!stat.isFile()) throw new TypeError('managed orchestration ledger is not a regular file');
      if (stat.size > maxReadBytes) {
        throw new RangeError(`managed orchestration ledger exceeds ${maxReadBytes} bytes`);
      }
      return validateSnapshot(JSON.parse(await fs.readFile(filePath, 'utf8')));
    } catch (error) {
      await quarantine(error);
      return null;
    }
  };

  const saveNow = async (snapshot: ManagedOrchestrationState) => {
    const validated = validateSnapshot(snapshot);
    const serialized = `${JSON.stringify(validated)}\n`;
    const directory = path.dirname(filePath);
    const temporaryPath = `${filePath}.${process.pid}.${randomId()}.tmp`;
    let handle: fs.FileHandle | null = null;
    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      handle = await fs.open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporaryPath, filePath);
      await fs.chmod(filePath, 0o600);
      writeCount += 1;
      try {
        const directoryHandle = await fs.open(directory, 'r');
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
      } catch {
        // Directory fsync is unavailable on some owner platforms.
      }
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  };

  const save = (snapshot: ManagedOrchestrationState) => {
    const operation = saveTail.then(() => saveNow(snapshot));
    saveTail = operation.catch(() => undefined);
    return operation;
  };

  return {
    filePath,
    load,
    save,
    getDiagnostics: () => ({ quarantinedPath, recoveryWarning, writeCount }),
  };
};
