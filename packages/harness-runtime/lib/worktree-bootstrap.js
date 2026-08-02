import crypto from 'node:crypto';
import path from 'node:path';

const WORKTREE_BOOTSTRAP_STAGES = Object.freeze([
  'prepare_remote',
  'create_worktree',
  'sync_project_metadata',
  'populate_worktree',
  'configure_upstream',
  'run_project_setup',
  'run_requested_setup',
  'complete',
]);

const TERMINAL_STATUSES = new Set([
  'ready',
  'ready_with_warnings',
  'failed',
  'needs_attention',
  'removed',
  'not_applicable',
]);

const SETUP_STAGES = new Set(['run_project_setup', 'run_requested_setup']);
const WARNING_STAGES = new Set(['sync_project_metadata', 'configure_upstream']);
const DEFAULT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_OPERATIONS = 2_000;

const asString = (value) => (
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : ''
);

const clone = (value) => JSON.parse(JSON.stringify(value));

const fingerprintValue = (value) => crypto
  .createHash('sha256')
  .update(JSON.stringify(value))
  .digest('hex');

const createError = (message, code, statusCode) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

const validateStageState = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('worktree stage state must be an object');
  }
  if (!['queued', 'running', 'completed', 'warning', 'failed', 'needs_attention', 'skipped'].includes(value.status)) {
    throw new TypeError('worktree stage status is invalid');
  }
  return value;
};

export const validateWorktreeBootstrapReceipt = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) {
    throw new TypeError('worktree bootstrap receipt version is invalid');
  }
  for (const field of ['operationId', 'idempotencyKey', 'fingerprint', 'directory']) {
    if (!asString(value[field])) throw new TypeError(`worktree bootstrap ${field} is required`);
  }
  if (![...TERMINAL_STATUSES, 'queued', 'running'].includes(value.status)) {
    throw new TypeError('worktree bootstrap status is invalid');
  }
  if (!WORKTREE_BOOTSTRAP_STAGES.includes(value.stage)) {
    throw new TypeError('worktree bootstrap stage is invalid');
  }
  const stages = value.stages && typeof value.stages === 'object' ? value.stages : {};
  for (const stage of WORKTREE_BOOTSTRAP_STAGES) {
    if (stages[stage]) validateStageState(stages[stage]);
  }
  return value;
};

export const createWorktreeBootstrapRuntime = (options = {}) => {
  const store = options.store;
  if (!store) throw new TypeError('worktree bootstrap store is required');
  const effects = options.effects ?? {};
  const now = typeof effects.now === 'function' ? effects.now : Date.now;
  const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  const maxOperations = options.maxOperations ?? DEFAULT_MAX_OPERATIONS;
  const operations = new Map();
  const operationByIdempotency = new Map();
  const operationByDirectory = new Map();
  const running = new Map();
  const stageRuns = new Map();
  let initialized = false;
  let beginTail = Promise.resolve();

  const indexReceipt = (receipt) => {
    operations.set(receipt.operationId, receipt);
    operationByIdempotency.set(receipt.idempotencyKey, receipt.operationId);
    const existingID = operationByDirectory.get(receipt.directory);
    const existing = existingID ? operations.get(existingID) : null;
    if (!existing || existing.updatedAt <= receipt.updatedAt) {
      operationByDirectory.set(receipt.directory, receipt.operationId);
    }
  };

  const persist = async (receipt) => {
    receipt.updatedAt = now();
    validateWorktreeBootstrapReceipt(receipt);
    await store.writeRecord(receipt.operationId, receipt);
    indexReceipt(receipt);
    options.onTransition?.(clone(receipt));
    return receipt;
  };

  const initialize = async () => {
    if (initialized) return;
    await store.initialize();
    for (const { record } of await store.listRecords()) {
      const receipt = validateWorktreeBootstrapReceipt(record);
      indexReceipt(receipt);
    }
    initialized = true;
  };

  const getReceipt = async (operationId) => {
    await initialize();
    const normalized = asString(operationId);
    const receipt = operations.get(normalized);
    if (!receipt) {
      throw createError('Worktree bootstrap operation not found', 'WORKTREE_OPERATION_NOT_FOUND', 404);
    }
    return receipt;
  };

  const getByIdempotency = async (idempotencyKey) => {
    await initialize();
    const operationId = operationByIdempotency.get(asString(idempotencyKey));
    if (!operationId) return null;
    const receipt = operations.get(operationId);
    return receipt ? clone(receipt) : null;
  };

  const beginOperationNow = async (input = {}) => {
    await initialize();
    const idempotencyKey = asString(input.idempotencyKey)
      || `worktree_${crypto.randomUUID().replaceAll('-', '')}`;
    const fingerprint = asString(input.fingerprint) || fingerprintValue(input.request ?? {});
    const existingID = operationByIdempotency.get(idempotencyKey);
    if (existingID) {
      const existing = operations.get(existingID);
      if (existing.fingerprint !== fingerprint) {
        throw createError(
          'Idempotency key was already used for a different worktree request',
          'WORKTREE_IDEMPOTENCY_CONFLICT',
          409,
        );
      }
      return { receipt: clone(existing), replay: true };
    }

    const requestedDirectory = asString(input.directory);
    if (!requestedDirectory) {
      throw createError('Worktree directory is required', 'WORKTREE_DIRECTORY_REQUIRED', 400);
    }
    const directory = path.resolve(requestedDirectory);
    const timestamp = now();
    const stages = Object.fromEntries(WORKTREE_BOOTSTRAP_STAGES.map((stage) => [
      stage,
      {
        status: 'queued',
        startedAt: null,
        finishedAt: null,
        error: null,
      },
    ]));
    const receipt = {
      version: 1,
      operationId: asString(input.operationId) || `wt_${crypto.randomUUID().replaceAll('-', '')}`,
      idempotencyKey,
      fingerprint,
      directory,
      stage: WORKTREE_BOOTSTRAP_STAGES[0],
      status: 'queued',
      stages,
      attempt: 1,
      tombstone: false,
      warnings: [],
      error: null,
      metadata: input.metadata && typeof input.metadata === 'object' ? clone(input.metadata) : {},
      result: input.result && typeof input.result === 'object' ? clone(input.result) : null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await persist(receipt);
    return { receipt: clone(receipt), replay: false };
  };

  const beginOperation = (input = {}) => {
    const operation = beginTail.catch(() => undefined).then(() => beginOperationNow(input));
    beginTail = operation.catch(() => undefined);
    return operation;
  };

  const setResult = async (operationId, result) => {
    const receipt = await getReceipt(operationId);
    receipt.result = result && typeof result === 'object' ? clone(result) : null;
    await persist(receipt);
    return clone(receipt);
  };

  const executeStageNow = async (operationId, stage, effect, stageOptions = {}) => {
    const receipt = await getReceipt(operationId);
    if (!WORKTREE_BOOTSTRAP_STAGES.includes(stage)) {
      throw createError(`Unknown worktree bootstrap stage: ${stage}`, 'WORKTREE_STAGE_INVALID', 400);
    }
    if (receipt.tombstone || receipt.status === 'removed') return clone(receipt);
    const current = receipt.stages[stage];
    if (current.status === 'completed' || current.status === 'warning' || current.status === 'skipped') {
      return clone(receipt);
    }

    receipt.stage = stage;
    receipt.status = 'running';
    current.status = 'running';
    current.startedAt = now();
    current.finishedAt = null;
    current.error = null;
    await persist(receipt);

    try {
      const resolvedEffect = typeof effect === 'function' ? effect : effects[stage];
      const output = typeof resolvedEffect === 'function'
        ? await resolvedEffect(clone(receipt))
        : undefined;
      current.status = stageOptions.skip === true ? 'skipped' : 'completed';
      current.finishedAt = now();
      current.error = null;
      receipt.error = null;
      if (output !== undefined) current.output = output;
      await persist(receipt);
      return clone(receipt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      current.finishedAt = now();
      current.error = message;
      if (stageOptions.failure === 'warning' || WARNING_STAGES.has(stage)) {
        current.status = 'warning';
        receipt.warnings.push({ stage, message, at: current.finishedAt });
        receipt.error = null;
        await persist(receipt);
        return clone(receipt);
      }
      const needsAttention = stageOptions.failure === 'needs_attention';
      current.status = needsAttention ? 'needs_attention' : 'failed';
      receipt.status = needsAttention ? 'needs_attention' : 'failed';
      receipt.error = message;
      await persist(receipt);
      throw error;
    }
  };

  const executeStage = (operationId, stage, effect, stageOptions = {}) => {
    const key = `${operationId}\u0000${stage}`;
    const existing = stageRuns.get(key);
    if (existing) return existing;
    const operation = executeStageNow(operationId, stage, effect, stageOptions)
      .finally(() => stageRuns.delete(key));
    stageRuns.set(key, operation);
    return operation;
  };

  const updateMetadata = async (operationId, patch) => {
    const receipt = await getReceipt(operationId);
    receipt.metadata = {
      ...receipt.metadata,
      ...(patch && typeof patch === 'object' ? clone(patch) : {}),
    };
    await persist(receipt);
    return clone(receipt);
  };

  const complete = async (operationId) => {
    const receipt = await getReceipt(operationId);
    receipt.stage = 'complete';
    receipt.stages.complete.status = 'completed';
    receipt.stages.complete.startedAt ??= now();
    receipt.stages.complete.finishedAt = now();
    receipt.status = receipt.warnings.length > 0 ? 'ready_with_warnings' : 'ready';
    receipt.error = null;
    await persist(receipt);
    return clone(receipt);
  };

  const runRemaining = async (operationId) => {
    const receipt = await getReceipt(operationId);
    if (receipt.tombstone || TERMINAL_STATUSES.has(receipt.status)) return clone(receipt);
    const startIndex = Math.max(0, WORKTREE_BOOTSTRAP_STAGES.indexOf(receipt.stage));
    for (let index = startIndex; index < WORKTREE_BOOTSTRAP_STAGES.length; index += 1) {
      const stage = WORKTREE_BOOTSTRAP_STAGES[index];
      const latest = await getReceipt(operationId);
      const state = latest.stages[stage];
      if (state.status === 'completed' || state.status === 'warning' || state.status === 'skipped') continue;
      if (stage === 'complete') return complete(operationId);
      const effect = effects[stage];
      if (typeof effect !== 'function') {
        await executeStage(operationId, stage, undefined, { skip: true });
        continue;
      }
      try {
        await executeStage(operationId, stage, effect, {
          failure: WARNING_STAGES.has(stage) ? 'warning' : 'failed',
        });
      } catch {
        return clone(await getReceipt(operationId));
      }
    }
    return complete(operationId);
  };

  const queue = async (operationId) => {
    await initialize();
    if (running.has(operationId)) return running.get(operationId);
    const operation = Promise.resolve()
      .then(() => runRemaining(operationId))
      .finally(() => running.delete(operationId));
    running.set(operationId, operation);
    return operation;
  };

  const reconcileOnStartup = async () => {
    await initialize();
    const resumable = [];
    for (const receipt of operations.values()) {
      if (receipt.status === 'running') {
        const state = receipt.stages[receipt.stage];
        if (SETUP_STAGES.has(receipt.stage) && state?.status === 'running') {
          state.status = 'needs_attention';
          state.finishedAt = now();
          state.error = 'Setup execution was interrupted; review it before retrying';
          receipt.status = 'needs_attention';
          receipt.error = state.error;
          await persist(receipt);
          continue;
        }
        state.status = 'queued';
        state.startedAt = null;
        state.finishedAt = null;
        state.error = null;
        receipt.status = 'queued';
        receipt.error = null;
        await persist(receipt);
      }
      if (receipt.status === 'queued') resumable.push(receipt.operationId);
    }
    for (const operationId of resumable) void queue(operationId);
    await prune();
    return resumable;
  };

  const retry = async (operationId) => {
    const receipt = await getReceipt(operationId);
    if (receipt.status !== 'failed' && receipt.status !== 'needs_attention') {
      throw createError('Only failed operations can be retried', 'WORKTREE_RETRY_INVALID', 409);
    }
    const state = receipt.stages[receipt.stage];
    state.status = 'queued';
    state.startedAt = null;
    state.finishedAt = null;
    state.error = null;
    receipt.status = 'queued';
    receipt.error = null;
    receipt.attempt += 1;
    await persist(receipt);
    void queue(operationId);
    return clone(receipt);
  };

  const fail = async (operationId, error, status = 'failed') => {
    const receipt = await getReceipt(operationId);
    if (receipt.tombstone || receipt.status === 'removed') return clone(receipt);
    const message = error instanceof Error ? error.message : String(error || 'Worktree operation failed');
    const nextStatus = status === 'needs_attention' ? 'needs_attention' : 'failed';
    const state = receipt.stages[receipt.stage];
    if (state) {
      state.status = nextStatus;
      state.startedAt ??= now();
      state.finishedAt = now();
      state.error = message;
    }
    receipt.status = nextStatus;
    receipt.error = message;
    await persist(receipt);
    return clone(receipt);
  };

  const markRemoved = async (directory) => {
    await initialize();
    const normalized = path.resolve(asString(directory));
    const operationId = operationByDirectory.get(normalized);
    if (!operationId) return null;
    const receipt = operations.get(operationId);
    receipt.tombstone = true;
    receipt.status = 'removed';
    receipt.error = null;
    await persist(receipt);
    return clone(receipt);
  };

  const getByDirectory = async (directory) => {
    await initialize();
    const normalized = path.resolve(asString(directory));
    const operationId = operationByDirectory.get(normalized);
    if (operationId) return clone(operations.get(operationId));
    const exists = typeof effects.worktreeExists === 'function'
      ? await effects.worktreeExists(normalized)
      : false;
    if (!exists) {
      throw createError('Worktree not found', 'WORKTREE_NOT_FOUND', 404);
    }
    return {
      version: 1,
      operationId: null,
      idempotencyKey: null,
      fingerprint: null,
      directory: normalized,
      stage: 'complete',
      status: 'not_applicable',
      stages: {},
      attempt: 0,
      tombstone: false,
      warnings: [],
      error: null,
      metadata: {},
      result: null,
      createdAt: null,
      updatedAt: now(),
    };
  };

  const listActive = async () => {
    await initialize();
    return [...operations.values()]
      .filter((receipt) => !TERMINAL_STATUSES.has(receipt.status))
      .sort((left, right) => left.createdAt - right.createdAt)
      .map(clone);
  };

  const prune = async () => {
    await initialize();
    const terminal = [...operations.values()]
      .filter((receipt) => TERMINAL_STATUSES.has(receipt.status))
      .sort((left, right) => right.updatedAt - left.updatedAt);
    const cutoff = now() - retentionMs;
    const remove = terminal.filter((receipt, index) => (
      index >= maxOperations || receipt.updatedAt < cutoff
    ));
    for (const receipt of remove) {
      operations.delete(receipt.operationId);
      if (operationByIdempotency.get(receipt.idempotencyKey) === receipt.operationId) {
        operationByIdempotency.delete(receipt.idempotencyKey);
      }
      if (operationByDirectory.get(receipt.directory) === receipt.operationId) {
        operationByDirectory.delete(receipt.directory);
      }
      await store.deleteRecord(receipt.operationId);
    }
    return remove.length;
  };

  const drain = async () => {
    await beginTail.catch(() => undefined);
    await Promise.allSettled([...running.values()]);
    await store.drain();
  };

  return {
    initialize,
    beginOperation,
    executeStage,
    updateMetadata,
    setResult,
    queue,
    complete,
    retry,
    fail,
    markRemoved,
    getReceipt: async (operationId) => clone(await getReceipt(operationId)),
    getByIdempotency,
    getByDirectory,
    listActive,
    reconcileOnStartup,
    prune,
    drain,
    fingerprint: fingerprintValue,
  };
};

export {
  DEFAULT_MAX_OPERATIONS,
  DEFAULT_RETENTION_MS,
  TERMINAL_STATUSES as WORKTREE_BOOTSTRAP_TERMINAL_STATUSES,
  WORKTREE_BOOTSTRAP_STAGES,
};
