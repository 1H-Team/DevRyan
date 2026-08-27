import crypto, { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  assertExactObject,
  validateBoundedJsonObject,
  validateBoundedString,
  validateUuid,
} from './validation.js';

export const BOT_PURGE_JOB_VERSION = 1;
export const BOT_PURGE_RESOURCE_IDS = Object.freeze([
  'capability_bindings',
  'objects',
  'credentials',
  'browser_profiles',
  'workspaces',
  'indexes',
  'channels',
  'shared_memory',
  'private_memory',
]);

const FULL_PURGE_RESOURCES = new Set(BOT_PURGE_RESOURCE_IDS);
const INTERNAL_STEP_IDS = new Set(['runtime_containers', 'supabase_rows', 'audit_retention']);
const STEP_STATES = new Set(['pending', 'running', 'completed', 'failed', 'skipped']);
const JOB_STATES = new Set(['pending', 'running', 'partial', 'completed']);
const MAX_JOB_BYTES = 2 * 1024 * 1024;
const RESOURCE_SET = new Set(BOT_PURGE_RESOURCE_IDS);

export class BotPurgeRuntimeError extends Error {
  constructor(message, code = 'bot_purge_invalid', statusCode = 400, details = null) {
    super(message);
    this.name = 'BotPurgeRuntimeError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

const fail = (message, code, statusCode, details) => {
  throw new BotPurgeRuntimeError(message, code, statusCode, details);
};

const exact = (value, shape) => {
  try {
    assertExactObject(value, shape);
  } catch (error) {
    fail(error.message);
  }
};

const sanitizeFailure = (error) => ({
  code: typeof error?.code === 'string'
    ? error.code.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 120)
    : 'bot_purge_step_failed',
  detail: typeof error?.message === 'string'
    ? error.message.replace(/[\r\n\0]/g, ' ').replace(/(?:\/[A-Za-z0-9._ -]+){2,}/g, '<LOCAL_PATH>').slice(0, 500)
    : 'Purge step failed',
});

const normalizeResourceIds = (value, {
  allowEmpty = false,
  enforceDependencies = true,
} = {}) => {
  if (!Array.isArray(value) || (!allowEmpty && value.length < 1)
    || value.length > BOT_PURGE_RESOURCE_IDS.length) {
    fail('Purge resource selection is invalid');
  }
  const normalized = [...new Set(value.map((entry) => (
    validateBoundedString(entry, 'resourceId', { maximum: 120 })
  )))];
  if (normalized.length !== value.length || normalized.some((entry) => !RESOURCE_SET.has(entry))) {
    fail('Purge resource selection is invalid');
  }
  if (enforceDependencies && normalized.includes('channels') && !normalized.includes('objects')) {
    fail('Channel purge must include encrypted objects', 'bot_purge_dependency_required', 409);
  }
  if (enforceDependencies && normalized.includes('objects')
    && !normalized.includes('capability_bindings')) {
    fail('Encrypted object purge must include Bot capability bindings', 'bot_purge_dependency_required', 409);
  }
  return Object.freeze(BOT_PURGE_RESOURCE_IDS.filter((entry) => normalized.includes(entry)));
};

const timestamp = (now) => {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail('Purge clock is invalid', 'bot_purge_clock_invalid', 500);
  }
  return value.toISOString();
};

const publicStep = (step) => Object.freeze({
  id: step.id,
  status: step.status,
  attempts: step.attempts,
  detail: step.detail,
  code: step.code,
  completedAt: step.completedAt,
});

const publicJob = (job) => Object.freeze({
  id: job.id,
  botId: job.botId,
  botName: job.botName,
  state: job.state,
  complete: job.state === 'completed',
  retryable: job.state === 'partial',
  botDeleted: [...FULL_PURGE_RESOURCES].every((id) => job.selectedResourceIds.includes(id))
    && job.steps.supabase_rows?.status === 'completed',
  selectedResourceIds: Object.freeze([...job.selectedResourceIds]),
  steps: Object.freeze(Object.values(job.steps).map(publicStep)),
  createdAt: job.createdAt,
  updatedAt: job.updatedAt,
  completedAt: job.completedAt,
});

const validateLoadedJob = (job, expectedBotId) => {
  if (!job || typeof job !== 'object' || Array.isArray(job)
    || job.version !== BOT_PURGE_JOB_VERSION || !JOB_STATES.has(job.state)
    || validateUuid(job.botId, 'purge.botId') !== expectedBotId
    || !job.steps || typeof job.steps !== 'object' || Array.isArray(job.steps)
    || !Array.isArray(job.selectedResourceIds)) {
    fail('Purge recovery journal is invalid', 'bot_purge_journal_invalid', 500);
  }
  normalizeResourceIds(job.selectedResourceIds);
  for (const [id, step] of Object.entries(job.steps)) {
    if ((!INTERNAL_STEP_IDS.has(id) && !RESOURCE_SET.has(id))
      || !step || step.id !== id || !STEP_STATES.has(step.status)
      || !Number.isSafeInteger(step.attempts) || step.attempts < 0) {
      fail('Purge recovery journal is invalid', 'bot_purge_journal_invalid', 500);
    }
  }
  validateBoundedJsonObject(job.snapshot, 'purge.snapshot', MAX_JOB_BYTES);
  return job;
};

const atomicWriteJson = async (filePath, value, fsPromises) => {
  const directory = path.dirname(filePath);
  await fsPromises.mkdir(directory, { recursive: true, mode: 0o700 });
  await fsPromises.chmod(directory, 0o700);
  const encoded = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  if (encoded.byteLength > MAX_JOB_BYTES) {
    encoded.fill(0);
    fail('Purge recovery journal is too large', 'bot_purge_journal_invalid', 500);
  }
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await fsPromises.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(encoded);
    await handle.sync();
    await handle.close();
    handle = null;
    await fsPromises.rename(temporaryPath, filePath);
    await fsPromises.chmod(filePath, 0o600);
    const parent = await fsPromises.open(directory, 'r').catch(() => null);
    try {
      await parent?.sync().catch(() => undefined);
    } finally {
      await parent?.close().catch(() => undefined);
    }
  } finally {
    encoded.fill(0);
    await handle?.close().catch(() => undefined);
    await fsPromises.unlink(temporaryPath).catch(() => undefined);
  }
};

export function createBotPurgeRuntime({
  dataDirectory,
  authorization,
  adapter,
  retireBot = null,
  audit = async () => {},
  auditRetention = null,
  isGlobalAdmin = () => false,
  now = () => new Date(),
  uuid = randomUUID,
  fsPromises = fs,
} = {}) {
  if (typeof dataDirectory !== 'string' || !path.isAbsolute(dataDirectory)
    || !authorization || typeof authorization.requireManager !== 'function'
    || !adapter || typeof adapter.prepare !== 'function'
    || typeof adapter.purgeResource !== 'function'
    || typeof adapter.purgeSupabaseRows !== 'function'
    || typeof adapter.stopRuntimeContainers !== 'function'
    || typeof audit !== 'function'
    || (retireBot !== null && typeof retireBot !== 'function')
    || typeof isGlobalAdmin !== 'function' || typeof now !== 'function'
    || typeof uuid !== 'function') {
    throw new TypeError('Bot purge runtime is misconfigured');
  }
  const jobsDirectory = path.join(dataDirectory, 'bots', 'purge');
  const mutations = new Map();
  const jobPath = (botId) => path.join(jobsDirectory, `${validateUuid(botId, 'botId')}.v1.json`);

  const serialize = (botId, operation) => {
    const previous = mutations.get(botId) || Promise.resolve();
    const next = previous.then(operation, operation);
    const tracked = next.catch(() => undefined);
    mutations.set(botId, tracked);
    return next.finally(() => {
      if (mutations.get(botId) === tracked) mutations.delete(botId);
    });
  };

  const readJob = async (botId, { recoverInterrupted = true } = {}) => {
    let parsed;
    try {
      const encoded = await fsPromises.readFile(jobPath(botId));
      if (encoded.byteLength > MAX_JOB_BYTES) fail('Purge recovery journal is too large', 'bot_purge_journal_invalid', 500);
      parsed = JSON.parse(encoded.toString('utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      if (error instanceof BotPurgeRuntimeError) throw error;
      fail('Purge recovery journal cannot be read', 'bot_purge_journal_invalid', 500);
    }
    const loaded = validateLoadedJob(parsed, validateUuid(botId, 'botId'));
    if (recoverInterrupted && (loaded.state === 'pending' || loaded.state === 'running'
      || Object.values(loaded.steps).some((step) => step.status === 'running'))) {
      for (const step of Object.values(loaded.steps)) {
        if (!['pending', 'running'].includes(step.status)) continue;
        step.status = 'failed';
        step.code = 'bot_purge_interrupted';
        step.detail = 'Interrupted before completion; explicit retry is required';
        step.completedAt = null;
      }
      loaded.state = 'partial';
      loaded.completedAt = null;
      loaded.updatedAt = timestamp(now);
      await atomicWriteJson(jobPath(loaded.botId), loaded, fsPromises);
    }
    return loaded;
  };

  const persist = async (job) => {
    job.updatedAt = timestamp(now);
    await atomicWriteJson(jobPath(job.botId), job, fsPromises);
  };

  const runStep = async (job, id, operation) => {
    const step = job.steps[id];
    if (!step || ['completed', 'skipped'].includes(step.status)) return;
    step.status = 'running';
    step.attempts += 1;
    step.code = null;
    step.detail = 'In progress';
    await persist(job);
    try {
      const result = await operation();
      step.status = 'completed';
      step.code = null;
      step.detail = validateBoundedString(
        result?.detail || 'Completed',
        `${id}.detail`,
        { maximum: 500 },
      );
      step.completedAt = timestamp(now);
    } catch (error) {
      const failure = sanitizeFailure(error);
      step.status = 'failed';
      step.code = failure.code;
      step.detail = failure.detail;
      step.completedAt = null;
    }
    await persist(job);
  };

  const execute = async (principal, job, retryIds = null) => {
    job.state = 'running';
    await persist(job);
    const eligible = retryIds ? new Set(retryIds) : new Set(job.selectedResourceIds);
    if (!retryIds || eligible.has('runtime_containers')) {
      await runStep(job, 'runtime_containers', () => adapter.stopRuntimeContainers(
        structuredClone(job.snapshot),
        [...job.selectedResourceIds],
      ));
      if (job.steps.runtime_containers?.status === 'completed') {
        if (job.steps.browser_profiles?.status === 'pending') eligible.add('browser_profiles');
        if (job.steps.workspaces?.status === 'pending') eligible.add('workspaces');
      }
    }
    for (const id of job.selectedResourceIds) {
      const step = job.steps[id];
      if (!eligible.has(id) || step.status === 'completed') continue;
      if (['browser_profiles', 'workspaces'].includes(id)
        && job.steps.runtime_containers?.status !== 'completed') continue;
      if (id === 'channels' && job.steps.objects?.status !== 'completed') continue;
      if (id === 'objects' && job.steps.capability_bindings?.status !== 'completed') continue;
      await runStep(job, id, () => adapter.purgeResource(id, structuredClone(job.snapshot)));
    }
    const selectedAll = [...FULL_PURGE_RESOURCES].every((id) => job.selectedResourceIds.includes(id));
    const resourcesComplete = job.selectedResourceIds.every((id) => job.steps[id].status === 'completed');
    if (resourcesComplete
      && (!retryIds || retryIds.includes('supabase_rows') || job.steps.supabase_rows.status !== 'completed')) {
      await runStep(job, 'supabase_rows', () => adapter.purgeSupabaseRows(
        structuredClone(job.snapshot),
        [...job.selectedResourceIds],
        { deleteBot: selectedAll },
      ));
    }
    const destructiveComplete = job.selectedResourceIds.every((id) => job.steps[id].status === 'completed')
      && job.steps.supabase_rows.status === 'completed';
    if (destructiveComplete) {
      await runStep(job, 'audit_retention', async () => {
        if (typeof auditRetention?.prune === 'function') {
          await auditRetention.prune();
        }
        return { detail: 'Security audit retained and the one-year retention barrier completed' };
      });
    }
    const complete = destructiveComplete && job.steps.audit_retention.status === 'completed';
    job.state = complete ? 'completed' : 'partial';
    job.completedAt = complete ? timestamp(now) : null;
    await persist(job);
    await audit({
      principal,
      botId: selectedAll && job.steps.supabase_rows.status === 'completed' ? null : job.botId,
      targetType: 'bot_purge_job',
      targetId: job.id,
      action: complete ? 'bot.purge.completed' : 'bot.purge.partial',
      result: complete ? 'success' : 'partial',
      metadata: {
        botReference: job.botId,
        selectedCount: job.selectedResourceIds.length,
        completedCount: Object.values(job.steps).filter((step) => step.status === 'completed').length,
        failedCount: Object.values(job.steps).filter((step) => step.status === 'failed').length,
      },
    });
    return publicJob(job);
  };

  const authorizeResume = async (principal, job) => {
    if (principal?.id === job.startedBy || isGlobalAdmin(principal)) return;
    try {
      await authorization.requireManager(principal, job.botId);
    } catch {
      fail('Bot Manager is required to resume purge', 'bot_manager_required', 403);
    }
  };

  const createJob = async (principal, prepared, selectedResourceIds) => {
    const bot = prepared.bot;
    const createdAt = timestamp(now);
    const needsRuntimeStop = selectedResourceIds.some((id) => (
      id === 'browser_profiles' || id === 'workspaces'
    ));
    const steps = Object.fromEntries([
      ...(needsRuntimeStop ? [['runtime_containers', {
        id: 'runtime_containers', status: 'pending', attempts: 0, code: null, detail: 'Pending', completedAt: null,
      }]] : []),
      ...selectedResourceIds.map((id) => [id, {
        id,
        status: 'pending',
        attempts: 0,
        code: null,
        detail: 'Pending',
        completedAt: null,
      }]),
      ['supabase_rows', {
        id: 'supabase_rows', status: 'pending', attempts: 0, code: null, detail: 'Pending', completedAt: null,
      }],
      ['audit_retention', {
        id: 'audit_retention', status: 'pending', attempts: 0, code: null, detail: 'Pending', completedAt: null,
      }],
    ]);
    const job = {
      version: BOT_PURGE_JOB_VERSION,
      id: validateUuid(uuid(), 'purgeJobId'),
      botId: bot.id,
      botName: validateBoundedString(bot.name, 'bot.name', { maximum: 120 }),
      startedBy: validateUuid(principal?.id, 'principal.id'),
      state: 'pending',
      selectedResourceIds: [...selectedResourceIds],
      snapshot: validateBoundedJsonObject(prepared.snapshot || {}, 'purge.snapshot', MAX_JOB_BYTES),
      steps,
      createdAt,
      updatedAt: createdAt,
      completedAt: null,
    };
    await persist(job);
    await audit({
      principal,
      botId: bot.id,
      targetType: 'bot_purge_job',
      targetId: job.id,
      action: 'bot.purge.started',
      result: 'success',
      metadata: { selectedCount: selectedResourceIds.length },
    });
    return job;
  };

  const validateConfirmation = (request, bot) => {
    if (request.confirm !== true || request.typedName !== bot.name) {
      fail('Exact Bot name and purge confirmation are required', 'bot_purge_confirmation_required', 409);
    }
    if (request.expectedUpdatedAt !== bot.updatedAt) {
      fail('Bot changed before purge could start', 'bot_revision_conflict', 409);
    }
  };

  return Object.freeze({
    async get(principal, botId) {
      const normalizedBotId = validateUuid(botId, 'botId');
      const job = await readJob(normalizedBotId, {
        recoverInterrupted: !mutations.has(normalizedBotId),
      });
      if (!job) return null;
      await authorizeResume(principal, job);
      return publicJob(job);
    },

    async start(principal, botId, request) {
      exact(request, {
        label: 'Bot purge request',
        required: ['typedName', 'confirm', 'expectedUpdatedAt', 'resourceIds'],
      });
      const normalizedBotId = validateUuid(botId, 'botId');
      return serialize(normalizedBotId, async () => {
        const existing = await readJob(normalizedBotId);
        if (existing && existing.state !== 'completed') {
          await authorizeResume(principal, existing);
          return publicJob(existing);
        }
        await authorization.requireManager(principal, normalizedBotId);
        const prepared = await adapter.prepare(principal, normalizedBotId);
        const bot = prepared?.bot;
        if (!bot || bot.id !== normalizedBotId
          || !['draft', 'retired'].includes(bot.lifecycle)) {
          fail('Active or Paused Bots must be Retired before purge', 'bot_purge_requires_retired', 409);
        }
        validateConfirmation(request, bot);
        const selectedResourceIds = normalizeResourceIds(request.resourceIds);
        const job = await createJob(principal, prepared, selectedResourceIds);
        return execute(principal, job);
      });
    },

    async startComplete(principal, botId, request) {
      exact(request, {
        label: 'Complete Bot deletion request',
        required: ['typedName', 'confirm', 'expectedUpdatedAt'],
      });
      const normalizedBotId = validateUuid(botId, 'botId');
      return serialize(normalizedBotId, async () => {
        const existing = await readJob(normalizedBotId);
        if (existing) {
          const existingIsFull = BOT_PURGE_RESOURCE_IDS.every((id) => (
            existing.selectedResourceIds.includes(id)
          ));
          if (request.confirm !== true || request.typedName !== existing.botName) {
            fail('Exact Bot name and purge confirmation are required', 'bot_purge_confirmation_required', 409);
          }
          if (existing.state !== 'completed') {
            await authorizeResume(principal, existing);
            const retryIds = Object.values(existing.steps)
              .filter((step) => step.status === 'failed' || step.status === 'pending')
              .map((step) => step.id);
            const resumed = await execute(principal, existing, retryIds);
            if (!resumed.complete || resumed.botDeleted) return resumed;
          } else if (existingIsFull && publicJob(existing).botDeleted) {
            await authorizeResume(principal, existing);
            return publicJob(existing);
          }
        }

        await authorization.requireManager(principal, normalizedBotId);
        let prepared = await adapter.prepare(principal, normalizedBotId);
        validateConfirmation(request, prepared.bot);
        if (prepared.bot.lifecycle === 'active' || prepared.bot.lifecycle === 'paused') {
          if (!retireBot) {
            fail('Bot retirement is unavailable', 'bot_purge_retirement_unavailable', 503);
          }
          await retireBot(principal, normalizedBotId, prepared.bot.updatedAt);
          prepared = await adapter.prepare(principal, normalizedBotId);
        }
        if (!['draft', 'retired'].includes(prepared.bot.lifecycle)) {
          fail('Bot could not be retired before purge', 'bot_purge_requires_retired', 409);
        }
        const job = await createJob(principal, prepared, BOT_PURGE_RESOURCE_IDS);
        return execute(principal, job);
      });
    },

    async retry(principal, botId, request) {
      exact(request, {
        label: 'Bot purge retry',
        required: ['resourceIds'],
      });
      const normalizedBotId = validateUuid(botId, 'botId');
      return serialize(normalizedBotId, async () => {
        const job = await readJob(normalizedBotId);
        if (!job) fail('Bot purge job was not found', 'bot_purge_not_found', 404);
        await authorizeResume(principal, job);
        if (job.state === 'completed') return publicJob(job);
        if (!Array.isArray(request.resourceIds) || request.resourceIds.length < 1
          || request.resourceIds.length > BOT_PURGE_RESOURCE_IDS.length + INTERNAL_STEP_IDS.size) {
          fail('Purge retry selection is invalid');
        }
        const requested = normalizeResourceIds(
          request.resourceIds.filter((id) => !INTERNAL_STEP_IDS.has(id)),
          { allowEmpty: true, enforceDependencies: false },
        );
        const retryIds = new Set(requested);
        if (request.resourceIds.includes('runtime_containers')) retryIds.add('runtime_containers');
        if (request.resourceIds.includes('supabase_rows')) retryIds.add('supabase_rows');
        if (request.resourceIds.includes('audit_retention')) retryIds.add('audit_retention');
        if (retryIds.size < 1 || [...retryIds].some((id) => !job.steps[id]
          || !['failed', 'pending'].includes(job.steps[id].status))) {
          fail('Purge retry must target failed or pending steps', 'bot_purge_retry_invalid', 409);
        }
        return execute(principal, job, [...retryIds]);
      });
    },
  });
}
