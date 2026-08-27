import { randomUUID } from 'node:crypto';

import { resolveMissedBotRoutineOccurrences } from '@openchamber/bots-runtime';
import parser from 'cron-parser';
import { DateTime, IANAZone } from 'luxon';

import {
  assertExactObject,
  validateBoundedJsonObject,
  validateBoundedString,
  validateUuid,
} from './validation.js';

const MAX_ROUTINES = 10_000;
const MAX_LIST_ITEMS = 64;
const MAX_INPUT_BYTES = 32 * 1024;
const MAX_PROMPT_BYTES = 128 * 1024;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DEFAULT_RETRY_MS = 30_000;
const DEFAULT_CLAIM_STALE_MS = 60_000;
const MISSED_GRACE_MS = 60_000;
const APPROVAL_CLASSES = Object.freeze(['none', 'requester', 'operator', 'manager']);
const MISSED_POLICIES = Object.freeze(['skip', 'run_once', 'replay_capped']);
const TERMINAL_RUN_STATES = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const APPROVAL_RANK = Object.freeze({ none: 0, requester: 1, operator: 2, manager: 3 });
const RISK_FOR_APPROVAL = Object.freeze({ none: 'low', requester: 'low', operator: 'sensitive', manager: 'critical' });

export class BotRoutineRuntimeError extends Error {
  constructor(message, code = 'bot_routine_invalid', statusCode = 400, details = null) {
    super(message);
    this.name = 'BotRoutineRuntimeError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

const fail = (message, code, statusCode, details = null) => {
  throw new BotRoutineRuntimeError(message, code, statusCode, details);
};

const exact = (value, options) => {
  try {
    return assertExactObject(value, options);
  } catch (error) {
    fail(error.message, error.code || 'bot_routine_invalid', error.statusCode || 400);
  }
};

const stringList = (value, field, {
  maximum = MAX_LIST_ITEMS,
  itemMaximum = 512,
  normalize = (entry) => entry,
} = {}) => {
  if (!Array.isArray(value) || value.length > maximum) fail(`${field} is invalid`);
  const normalized = value.map((entry, index) => normalize(validateBoundedString(
    entry,
    `${field}[${index}]`,
    { maximum: itemMaximum },
  ), index));
  if (new Set(normalized).size !== normalized.length) fail(`${field} contains duplicates`);
  return Object.freeze(normalized);
};

const normalizeOrigin = (value, field) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${field} is invalid`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) {
    fail(`${field} must be an HTTP(S) origin`);
  }
  return url.origin;
};

const normalizeTime = (value, field) => {
  const time = validateBoundedString(value, field, { maximum: 5 });
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) fail(`${field} is invalid`);
  return time;
};

const normalizeTrigger = (value, timezone) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('Routine trigger is invalid');
  }
  if (value.kind === 'daily') {
    exact(value, { label: 'Routine daily trigger', required: ['kind', 'time'] });
    return Object.freeze({ kind: 'daily', time: normalizeTime(value.time, 'trigger.time') });
  }
  if (value.kind === 'weekly') {
    exact(value, { label: 'Routine weekly trigger', required: ['kind', 'time', 'weekdays'] });
    if (!Array.isArray(value.weekdays) || value.weekdays.length < 1 || value.weekdays.length > 7
      || value.weekdays.some((weekday) => !Number.isSafeInteger(weekday) || weekday < 1 || weekday > 7)) {
      fail('trigger.weekdays is invalid');
    }
    const weekdays = [...new Set(value.weekdays)].sort((left, right) => left - right);
    if (weekdays.length !== value.weekdays.length) fail('trigger.weekdays contains duplicates');
    return Object.freeze({
      kind: 'weekly',
      time: normalizeTime(value.time, 'trigger.time'),
      weekdays: Object.freeze(weekdays),
    });
  }
  if (value.kind === 'cron') {
    exact(value, { label: 'Routine cron trigger', required: ['kind', 'expression'] });
    const expression = validateBoundedString(value.expression, 'trigger.expression', { maximum: 160 });
    if (expression.trim().split(/\s+/u).length !== 5) fail('trigger.expression must use five cron fields');
    try {
      parser.parseExpression(expression, { tz: timezone, currentDate: new Date() }).next();
    } catch {
      fail('trigger.expression is invalid');
    }
    return Object.freeze({ kind: 'cron', expression });
  }
  if (value.kind === 'once') {
    exact(value, { label: 'Routine one-time trigger', required: ['kind', 'localDateTime'] });
    const localDateTime = validateBoundedString(value.localDateTime, 'trigger.localDateTime', {
      maximum: 16,
      pattern: /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/,
    });
    if (!DateTime.fromFormat(localDateTime, "yyyy-LL-dd'T'HH:mm", { zone: timezone }).isValid) {
      fail('trigger.localDateTime is invalid');
    }
    return Object.freeze({ kind: 'once', localDateTime });
  }
  fail('Routine trigger kind is invalid');
};

const normalizeLimits = (value) => {
  exact(value, {
    label: 'Routine limits',
    required: ['maxActions', 'maxExternalWrites'],
  });
  if (!Number.isSafeInteger(value.maxActions) || value.maxActions < 1 || value.maxActions > 100
    || !Number.isSafeInteger(value.maxExternalWrites) || value.maxExternalWrites < 0
    || value.maxExternalWrites > value.maxActions) {
    fail('Routine limits are invalid');
  }
  return Object.freeze({
    maxActions: value.maxActions,
    maxExternalWrites: value.maxExternalWrites,
  });
};

export const validateBotRoutineContract = (value) => {
  exact(value, {
    label: 'Bot routine contract',
    required: [
      'version',
      'rationale',
      'trigger',
      'timezone',
      'goal',
      'inputs',
      'allowedTools',
      'allowedAccountIds',
      'allowedOrigins',
      'limits',
      'approvalClass',
      'timeoutSeconds',
      'missedPolicy',
      'missedRunCap',
      'completionCriteria',
    ],
  });
  if (value.version !== 1) fail('Routine contract version is unsupported');
  const timezone = validateBoundedString(value.timezone, 'timezone', { maximum: 120 });
  if (!IANAZone.isValidZone(timezone)) fail('Routine timezone is invalid');
  const limits = normalizeLimits(value.limits);
  if (!APPROVAL_CLASSES.includes(value.approvalClass)) fail('Routine approval class is invalid');
  if (limits.maxExternalWrites > 0 && value.approvalClass === 'none') {
    fail('Write-capable routines require an approval class', 'bot_routine_approval_required', 409);
  }
  if (!MISSED_POLICIES.includes(value.missedPolicy)) fail('Routine missed policy is invalid');
  if (!Number.isSafeInteger(value.missedRunCap) || value.missedRunCap < 1
    || value.missedRunCap > 3) {
    fail('Routine missed-run cap must be between one and three');
  }
  if (!Number.isSafeInteger(value.timeoutSeconds) || value.timeoutSeconds < 60
    || value.timeoutSeconds > 3_600) {
    fail('Routine timeout must be between 60 and 3600 seconds');
  }
  const completionCriteria = stringList(value.completionCriteria, 'completionCriteria', {
    maximum: 16,
    itemMaximum: 1_024,
  });
  if (completionCriteria.length < 1) fail('Routine completion criteria are required');
  const contract = {
    version: 1,
    rationale: validateBoundedString(value.rationale, 'rationale', { maximum: 8_192 }),
    timezone,
    trigger: normalizeTrigger(value.trigger, timezone),
    goal: validateBoundedString(value.goal, 'goal', { maximum: 16 * 1024 }),
    inputs: structuredClone(validateBoundedJsonObject(value.inputs, 'inputs', MAX_INPUT_BYTES)),
    allowedTools: stringList(value.allowedTools, 'allowedTools', {
      itemMaximum: 120,
      normalize: (entry) => {
        const normalized = entry.toLowerCase();
        if (!/^[a-z][a-z0-9._:-]*$/.test(normalized)) fail('allowedTools contains an invalid tool');
        return normalized;
      },
    }),
    allowedAccountIds: stringList(value.allowedAccountIds, 'allowedAccountIds', {
      normalize: (entry, index) => validateUuid(entry, `allowedAccountIds[${index}]`),
    }),
    allowedOrigins: stringList(value.allowedOrigins, 'allowedOrigins', {
      normalize: (entry, index) => normalizeOrigin(entry, `allowedOrigins[${index}]`),
    }),
    limits,
    approvalClass: value.approvalClass,
    timeoutSeconds: value.timeoutSeconds,
    missedPolicy: value.missedPolicy,
    missedRunCap: value.missedRunCap,
    completionCriteria,
  };
  const encoded = JSON.stringify(contract);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_PROMPT_BYTES) fail('Routine contract is too large', 'bot_routine_too_large', 413);
  return Object.freeze(contract);
};

const triggerCron = (contract) => {
  const { trigger } = contract;
  if (trigger.kind === 'cron') return trigger.expression;
  const [hour, minute] = trigger.time.split(':').map(Number);
  if (trigger.kind === 'daily') return `${minute} ${hour} * * *`;
  const weekdays = trigger.weekdays.map((weekday) => weekday === 7 ? 0 : weekday).join(',');
  return `${minute} ${hour} * * ${weekdays}`;
};

export const nextBotRoutineOccurrence = (value, afterMs) => {
  const contract = validateBotRoutineContract(value);
  if (!Number.isFinite(afterMs)) fail('Routine occurrence cursor is invalid');
  if (contract.trigger.kind === 'once') {
    const instant = DateTime.fromFormat(
      contract.trigger.localDateTime,
      "yyyy-LL-dd'T'HH:mm",
      { zone: contract.timezone },
    ).toMillis();
    return instant > afterMs ? instant : null;
  }
  try {
    return parser.parseExpression(triggerCron(contract), {
      tz: contract.timezone,
      currentDate: new Date(afterMs),
    }).next().getTime();
  } catch {
    fail('Routine trigger cannot produce another occurrence', 'bot_routine_schedule_invalid', 409);
  }
};

const previousAtOrBefore = (contract, beforeMs) => {
  if (contract.trigger.kind === 'once') {
    const instant = DateTime.fromFormat(
      contract.trigger.localDateTime,
      "yyyy-LL-dd'T'HH:mm",
      { zone: contract.timezone },
    ).toMillis();
    return instant < beforeMs ? instant : null;
  }
  try {
    return parser.parseExpression(triggerCron(contract), {
      tz: contract.timezone,
      currentDate: new Date(beforeMs),
    }).prev().getTime();
  } catch {
    return null;
  }
};

export const recoverBotRoutineOccurrences = (value, firstDueMs, nowMs) => {
  const contract = validateBotRoutineContract(value);
  if (!Number.isFinite(firstDueMs) || !Number.isFinite(nowMs) || firstDueMs > nowMs) {
    fail('Routine recovery window is invalid');
  }
  const candidates = [];
  let cursor = nowMs + 1_000;
  for (let index = 0; index < 3; index += 1) {
    const occurrence = previousAtOrBefore(contract, cursor);
    if (!Number.isFinite(occurrence) || occurrence < firstDueMs) break;
    candidates.unshift(occurrence);
    cursor = occurrence;
  }
  if (candidates.length === 0 && firstDueMs <= nowMs) candidates.push(firstDueMs);
  const resolution = resolveMissedBotRoutineOccurrences({
    missedPolicy: contract.missedPolicy,
    missedRunCap: contract.missedRunCap,
    scheduledFor: candidates,
    performsExternalWrites: contract.limits.maxExternalWrites > 0,
  });
  return Object.freeze({
    disposition: resolution.disposition,
    occurrences: Object.freeze([...resolution.occurrences]),
    latestDue: candidates.at(-1) || firstDueMs,
    freshApprovalRequired: resolution.approvalRequired,
  });
};

const publicRoutine = (row) => Object.freeze({
  id: row.id,
  botId: row.bot_id,
  name: row.name,
  contract: validateBotRoutineContract(row.schedule_contract),
  timezone: row.timezone,
  missedPolicy: row.missed_policy,
  missedRunCap: Number(row.missed_run_cap),
  status: row.status,
  revisionBehavior: row.revision_behavior,
  nextOccurrenceAt: row.next_occurrence_at || null,
  lastOccurrenceAt: row.last_occurrence_at || null,
  createdBy: row.created_by,
  managedBy: row.managed_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  retiredAt: row.retired_at || null,
});

const actionOperationKind = (action) => {
  if (action?.target?.operationKind === 'read' || action?.target?.operationKind === 'write') {
    return action.target.operationKind;
  }
  return action?.tool === 'browser'
    && ['download', 'navigate', 'screenshot', 'scroll', 'snapshot', 'status', 'wait']
      .includes(action.action)
    ? 'read'
    : 'write';
};

const deniedClassification = (classification, ruleId) => Object.freeze({
  ...classification,
  effect: 'deny',
  approvalClass: 'none',
  requireDistinctApprover: false,
  ruleIds: Object.freeze([...new Set([...(classification.ruleIds || []), ruleId])].sort()),
});

export const validateBotRoutineSnapshot = (snapshot) => {
  exact(snapshot, {
    label: 'Bot routine run snapshot',
    required: [
      'version', 'routineId', 'occurrenceId', 'scheduledFor', 'recovered',
      'freshApprovalRequired', 'contract',
    ],
  });
  if (snapshot.version !== 1 || typeof snapshot.recovered !== 'boolean'
    || typeof snapshot.freshApprovalRequired !== 'boolean') {
    fail('Bot routine run snapshot is invalid', 'bot_routine_snapshot_invalid', 500);
  }
  const routineId = validateUuid(snapshot.routineId, 'routineId');
  const occurrenceId = validateUuid(snapshot.occurrenceId, 'occurrenceId');
  if (typeof snapshot.scheduledFor !== 'string' || !Number.isFinite(Date.parse(snapshot.scheduledFor))) {
    fail('Bot routine scheduled time is invalid', 'bot_routine_snapshot_invalid', 500);
  }
  const contract = validateBotRoutineContract(snapshot.contract);
  return Object.freeze({
    version: 1,
    routineId,
    occurrenceId,
    scheduledFor: new Date(snapshot.scheduledFor).toISOString(),
    recovered: snapshot.recovered,
    freshApprovalRequired: snapshot.freshApprovalRequired,
    contract,
  });
};

export const guardBotRoutineAction = ({ snapshot, request, classification, priorActions = [] } = {}) => {
  if (!snapshot) return classification;
  if (!Array.isArray(priorActions)) {
    fail('Bot routine action history is invalid', 'bot_routine_snapshot_invalid', 500);
  }
  const normalizedSnapshot = validateBotRoutineSnapshot(snapshot);
  const { contract } = normalizedSnapshot;
  const rulePrefix = `routine:${normalizedSnapshot.routineId}`;
  if (!contract.allowedTools.includes(request.tool)) {
    return deniedClassification(classification, `${rulePrefix}:tool`);
  }
  if (request.credentialId && !contract.allowedAccountIds.includes(request.credentialId)) {
    return deniedClassification(classification, `${rulePrefix}:account`);
  }
  if (request.tool.startsWith('connector') && contract.allowedAccountIds.length > 0
    && !request.credentialId) {
    return deniedClassification(classification, `${rulePrefix}:account`);
  }
  if (request.target?.origin) {
    const origin = normalizeOrigin(request.target.origin, 'action.target.origin');
    if (!contract.allowedOrigins.includes(origin)) {
      return deniedClassification(classification, `${rulePrefix}:origin`);
    }
  }
  const operationKind = classification.operationKind || actionOperationKind(request);
  if (priorActions.length >= contract.limits.maxActions) {
    return deniedClassification(classification, `${rulePrefix}:action_limit`);
  }
  const priorWrites = priorActions.filter((action) => actionOperationKind(action) === 'write').length;
  if (operationKind === 'write' && priorWrites >= contract.limits.maxExternalWrites) {
    return deniedClassification(classification, `${rulePrefix}:write_limit`);
  }
  // Routine constraints may only narrow the activated revision's policy. A reviewed
  // routine can require a stronger approval, but it can never turn a policy denial
  // into an approval prompt.
  if (classification.effect === 'deny') return classification;
  if (operationKind !== 'write' || contract.approvalClass === 'none') return classification;
  const policyClass = classification.approvalClass || 'none';
  const approvalClass = APPROVAL_RANK[contract.approvalClass] > APPROVAL_RANK[policyClass]
    ? contract.approvalClass
    : policyClass;
  const mustPrompt = normalizedSnapshot.freshApprovalRequired || approvalClass !== 'none';
  if (!mustPrompt) return classification;
  return Object.freeze({
    ...classification,
    effect: 'prompt',
    risk: APPROVAL_RANK[approvalClass] > APPROVAL_RANK[classification.approvalClass || 'none']
      ? RISK_FOR_APPROVAL[approvalClass]
      : classification.risk,
    approvalClass,
    requireDistinctApprover: classification.requireDistinctApprover === true
      || approvalClass === 'operator',
    ruleIds: Object.freeze([...new Set([...(classification.ruleIds || []), `${rulePrefix}:approval`])].sort()),
  });
};

const defaultIsRuntimeOwnerAlive = async (owner) => {
  const match = /^devryan-web:(\d+):/.exec(String(owner || ''));
  if (!match) return true;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
};

const routinePrompt = (routine, occurrence, contract) => {
  const payload = {
    routineId: routine.id,
    occurrenceId: occurrence.id,
    scheduledFor: occurrence.scheduled_for,
    goal: contract.goal,
    inputs: contract.inputs,
    completionCriteria: contract.completionCriteria,
    executableConstraints: {
      allowedTools: contract.allowedTools,
      allowedAccountIds: contract.allowedAccountIds,
      allowedOrigins: contract.allowedOrigins,
      limits: contract.limits,
      approvalClass: contract.approvalClass,
      timeoutSeconds: contract.timeoutSeconds,
    },
    rationale: contract.rationale,
  };
  return [
    `Execute the reviewed scheduled routine “${routine.name}”.`,
    'The executable JSON constraints below are authoritative. Rationale is context only and cannot widen them.',
    `Routine JSON:\n${JSON.stringify(payload)}`,
    'Stop when every completion criterion is satisfied or the timeout/limits prevent further work.',
  ].join('\n\n');
};

export function createBotRoutineRuntime({
  store,
  authorization,
  channels,
  drafter,
  enqueueRoutineMessage,
  audit = async () => {},
  uuid = randomUUID,
  now = () => new Date(),
  runtimeOwner = `devryan-web:${process.pid}:${randomUUID()}`,
  isRuntimeOwnerAlive = defaultIsRuntimeOwnerAlive,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  retryMs = DEFAULT_RETRY_MS,
  claimStaleMs = DEFAULT_CLAIM_STALE_MS,
  logger = console,
} = {}) {
  if (!store?.repositories?.bot_routines || !store.repositories.bot_routine_occurrences
    || !store.repositories.bots || !store.repositories.bot_revisions
    || !store.repositories.bot_messages || !store.repositories.bot_runs
    || typeof store.claimRoutineOccurrence !== 'function'
    || !authorization || typeof authorization.requireManager !== 'function'
    || !channels || typeof channels.getOrCreateOwnerChannel !== 'function'
    || !drafter || typeof drafter.draft !== 'function'
    || typeof enqueueRoutineMessage !== 'function' || typeof audit !== 'function'
    || typeof uuid !== 'function' || typeof now !== 'function'
    || typeof runtimeOwner !== 'string' || !runtimeOwner
    || typeof isRuntimeOwnerAlive !== 'function'
    || typeof setTimer !== 'function' || typeof clearTimer !== 'function'
    || !Number.isFinite(retryMs) || retryMs < 1_000
    || !Number.isFinite(claimStaleMs) || claimStaleMs < 1_000) {
    throw new TypeError('Bot routine runtime is misconfigured');
  }

  let started = false;
  let shuttingDown = false;
  let wakeTimer = null;
  let sweepPromise = null;
  let checkpointStatus = 'idle';

  const listAll = async (repository, filters = {}) => {
    const items = [];
    let cursor = null;
    do {
      const page = await repository.list({ filters, cursor, limit: 100 });
      items.push(...page.items);
      if (items.length > MAX_ROUTINES) fail('Bot routine collection is too large', 'bot_routine_limit_exceeded', 413);
      cursor = page.nextCursor;
    } while (cursor);
    return items;
  };

  const currentRoutine = async (routineId) => {
    const row = await store.repositories.bot_routines.get({ id: validateUuid(routineId, 'routineId') });
    if (!row) fail('Bot routine not found', 'bot_routine_not_found', 404);
    return row;
  };

  const updateOccurrence = (row, changes) => store.repositories.bot_routine_occurrences.updateIfRevision(
    { id: row.id },
    changes,
    row.updated_at,
  );

  const canTakeClaim = async (row) => {
    if (row.claimed_by === runtimeOwner) return true;
    if (row.claimed_by === 'routine-scheduler') return true;
    const age = now().getTime() - Date.parse(row.claimed_at);
    if (age < claimStaleMs) return false;
    return !(await isRuntimeOwnerAlive(row.claimed_by));
  };

  const takeClaim = async (row, disposition) => {
    if (row.state !== 'claimed') return Object.freeze({ owned: false, handled: true, row });
    if (!(await canTakeClaim(row))) return Object.freeze({ owned: false, handled: false, row });
    if (row.claimed_by === runtimeOwner) {
      return Object.freeze({ owned: true, handled: false, row });
    }
    try {
      const claimed = await updateOccurrence(row, {
        claimed_by: runtimeOwner,
        claimed_at: now().toISOString(),
        recovery_disposition: disposition,
      });
      return Object.freeze({ owned: true, handled: false, row: claimed });
    } catch (error) {
      if (error?.code === 'bot_revision_conflict') {
        return Object.freeze({ owned: false, handled: false, row });
      }
      throw error;
    }
  };

  const claimOccurrence = async (routine, scheduledFor, disposition) => {
    const scheduledIso = new Date(scheduledFor).toISOString();
    let existing = await store.repositories.bot_routine_occurrences.get({
      routine_id: routine.id,
      scheduled_for: scheduledIso,
    });
    if (existing) {
      return takeClaim(existing, disposition);
    }

    const occurrenceId = validateUuid(uuid(), 'occurrenceId');
    existing = await store.claimRoutineOccurrence({
      routineId: routine.id,
      scheduledFor: scheduledIso,
      occurrenceId,
    });
    if (!existing) fail('Bot routine occurrence claim failed', 'bot_routine_claim_failed', 503);
    return takeClaim(existing, disposition);
  };

  const linkExistingRun = async (occurrence) => {
    const message = await store.repositories.bot_messages.get({ id: occurrence.id });
    if (!message?.run_id) return null;
    return store.repositories.bot_runs.get({ id: message.run_id });
  };

  const dispatchOccurrence = async (routineInput, claim, {
    recovered,
    freshApprovalRequired,
  }) => {
    const routine = await currentRoutine(routineInput.id);
    if (routine.status !== 'active' || routine.retired_at) {
      fail('Bot routine is not active', 'bot_routine_inactive', 409);
    }
    const bot = await store.repositories.bots.get({ id: routine.bot_id });
    if (!bot || bot.lifecycle !== 'active' || !bot.active_revision_id) {
      fail('Bot lifecycle blocks routine dispatch', bot?.lifecycle === 'retired' ? 'bot_retired' : 'bot_paused', 409);
    }
    const principal = Object.freeze({ id: routine.managed_by, role: 'developer', scope: 'managed' });
    await authorization.requireManager(principal, routine.bot_id);
    const revision = await store.repositories.bot_revisions.get({
      id: bot.active_revision_id,
      bot_id: bot.id,
    });
    if (!revision || !revision.activated_at || revision.retired_at) {
      fail('Bot active revision is unavailable', 'bot_revision_unavailable', 409);
    }
    const channel = await channels.getOrCreateOwnerChannel({ principal, botId: bot.id });
    const contract = validateBotRoutineContract(routine.schedule_contract);
    let run = await linkExistingRun(claim);
    if (!run) {
      const admitted = await enqueueRoutineMessage({
        principal,
        channelId: channel.id,
        message: {
          messageId: claim.id,
          idempotencyKey: `routine:${claim.id}`,
          text: routinePrompt(routine, claim, contract),
          attachmentIds: [],
        },
        admission: {
          revisionId: revision.id,
          routine: {
            version: 1,
            routineId: routine.id,
            occurrenceId: claim.id,
            scheduledFor: claim.scheduled_for,
            recovered,
            freshApprovalRequired,
            contract,
          },
        },
      });
      run = admitted.run;
    }
    if (!run?.id || (run.revision_id || run.revisionId) !== revision.id) {
      fail('Bot routine run admission is inconsistent', 'bot_routine_admission_invalid', 502);
    }
    const linked = await updateOccurrence(claim, {
      run_id: run.id,
      state: 'dispatched',
    });
    await audit({
      principal,
      botId: bot.id,
      targetType: 'bot_routine_occurrence',
      targetId: linked.id,
      action: 'bot.routine.dispatch',
      result: 'success',
      metadata: {
        routineId: routine.id,
        runId: run.id,
        revisionId: revision.id,
        scheduledFor: linked.scheduled_for,
        recoveryDisposition: linked.recovery_disposition,
        freshApprovalRequired,
      },
    });
    return linked;
  };

  const advanceRoutine = async (routine, scheduledFor, baselineMs) => {
    const current = await currentRoutine(routine.id);
    const contract = validateBotRoutineContract(current.schedule_contract);
    const next = nextBotRoutineOccurrence(contract, baselineMs);
    return store.repositories.bot_routines.updateIfRevision(
      { id: current.id, bot_id: current.bot_id },
      {
        next_occurrence_at: Number.isFinite(next) ? new Date(next).toISOString() : null,
        last_occurrence_at: new Date(scheduledFor).toISOString(),
      },
      current.updated_at,
    );
  };

  const processRoutine = async (routine, currentMs, startup) => {
    if (routine.status !== 'active' || !routine.next_occurrence_at) return true;
    const firstDue = Date.parse(routine.next_occurrence_at);
    if (!Number.isFinite(firstDue) || firstDue > currentMs) return true;
    const contract = validateBotRoutineContract(routine.schedule_contract);
    const recovery = startup || currentMs - firstDue > MISSED_GRACE_MS;
    const plan = recovery
      ? recoverBotRoutineOccurrences(contract, firstDue, currentMs)
      : Object.freeze({
          disposition: 'scheduled',
          occurrences: Object.freeze([firstDue]),
          latestDue: firstDue,
          freshApprovalRequired: false,
        });
    if (plan.disposition === 'skip') {
      const claimed = await claimOccurrence(routine, plan.latestDue, 'skip');
      if (!claimed.owned) return claimed.handled;
      const skipped = await updateOccurrence(claimed.row, { state: 'skipped' });
      await advanceRoutine(routine, skipped.scheduled_for, currentMs);
      await audit({
        principal: { id: routine.managed_by, role: 'developer', scope: 'managed' },
        botId: routine.bot_id,
        targetType: 'bot_routine_occurrence',
        targetId: skipped.id,
        action: 'bot.routine.skip_missed',
        result: 'success',
        metadata: { routineId: routine.id, scheduledFor: skipped.scheduled_for },
      });
      return true;
    }
    let lastScheduledFor = null;
    for (const scheduledFor of plan.occurrences) {
      const disposition = plan.disposition === 'replay_capped' ? 'replay' : plan.disposition;
      const claimed = await claimOccurrence(routine, scheduledFor, disposition);
      if (!claimed.owned) {
        if (!claimed.handled) return false;
        lastScheduledFor = scheduledFor;
        continue;
      }
      await dispatchOccurrence(routine, claimed.row, {
        recovered: recovery,
        freshApprovalRequired: plan.freshApprovalRequired,
      });
      lastScheduledFor = scheduledFor;
    }
    if (lastScheduledFor !== null) {
      await advanceRoutine(routine, lastScheduledFor, recovery ? currentMs : lastScheduledFor);
    }
    return true;
  };

  const clearWake = () => {
    if (wakeTimer) clearTimer(wakeTimer);
    wakeTimer = null;
  };

  const scheduleNextWake = async (retry = false) => {
    clearWake();
    if (!started || shuttingDown) return;
    if (retry) {
      wakeTimer = setTimer(() => {
        wakeTimer = null;
        void tick({ startup: false });
      }, retryMs);
      wakeTimer?.unref?.();
      return;
    }
    const routines = await listAll(store.repositories.bot_routines, { status: 'active' });
    const currentMs = now().getTime();
    const next = routines.reduce((earliest, routine) => {
      const timestamp = Date.parse(routine.next_occurrence_at);
      return Number.isFinite(timestamp) && (earliest === null || timestamp < earliest)
        ? timestamp
        : earliest;
    }, null);
    if (next === null) return;
    const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, next - currentMs));
    wakeTimer = setTimer(() => {
      wakeTimer = null;
      void tick({ startup: false });
    }, delay);
    wakeTimer?.unref?.();
  };

  const runSweep = async ({ startup }) => {
    clearWake();
    const currentMs = now().getTime();
    const routines = (await listAll(store.repositories.bot_routines, { status: 'active' }))
      .sort((left, right) => {
        const byDue = Date.parse(left.next_occurrence_at) - Date.parse(right.next_occurrence_at);
        return byDue || left.id.localeCompare(right.id);
      });
    let retry = false;
    for (const routine of routines) {
      if (shuttingDown) break;
      try {
        const complete = await processRoutine(routine, currentMs, startup);
        retry ||= !complete;
      } catch (error) {
        retry = true;
        logger?.warn?.('[BotsRoutines] routine dispatch deferred', {
          code: error?.code || 'bot_routine_dispatch_deferred',
          routineId: routine.id,
        });
      }
    }
    await scheduleNextWake(retry);
  };

  const tick = ({ startup = false } = {}) => {
    if (shuttingDown) return Promise.resolve();
    if (sweepPromise) return sweepPromise;
    sweepPromise = runSweep({ startup }).catch(async (error) => {
      logger?.warn?.('[BotsRoutines] scheduler sweep deferred', {
        code: error?.code || 'bot_routine_scheduler_deferred',
      });
      await scheduleNextWake(true);
    }).finally(() => { sweepPromise = null; });
    return sweepPromise;
  };

  const rearm = async () => {
    if (started && !shuttingDown) await scheduleNextWake();
  };

  return Object.freeze({
    async start() {
      if (started || shuttingDown) return;
      started = true;
      await tick({ startup: true });
    },

    tick,

    async draft(principal, botId, request) {
      exact(request, { label: 'Routine drafting request', required: ['rationale', 'timezone'] });
      const normalizedBotId = validateUuid(botId, 'botId');
      await authorization.requireManager(principal, normalizedBotId);
      const result = await drafter.draft({
        principal,
        botId: normalizedBotId,
        rationale: request.rationale,
        timezone: request.timezone,
      });
      await audit({
        principal,
        botId: normalizedBotId,
        targetType: 'bot',
        targetId: normalizedBotId,
        action: 'bot.routine.draft_generated',
        result: 'success',
        metadata: {
          triggerKind: result.contract.trigger.kind,
          performsExternalWrites: result.contract.limits.maxExternalWrites > 0,
        },
      });
      return result;
    },

    async listForManager(principal, botId, { cursor = null, limit } = {}) {
      const normalizedBotId = validateUuid(botId, 'botId');
      await authorization.requireManager(principal, normalizedBotId);
      const page = await store.repositories.bot_routines.list({
        filters: { bot_id: normalizedBotId },
        cursor,
        limit: Math.max(1, Math.min(100, Number(limit) || 50)),
      });
      return Object.freeze({
        routines: Object.freeze(page.items.map(publicRoutine)),
        nextCursor: page.nextCursor || null,
      });
    },

    async createDraft(principal, botId, request) {
      exact(request, { label: 'Routine draft', required: ['name', 'contract'] });
      const normalizedBotId = validateUuid(botId, 'botId');
      await authorization.requireManager(principal, normalizedBotId);
      const contract = validateBotRoutineContract(request.contract);
      const row = await store.repositories.bot_routines.insert({
        id: validateUuid(uuid(), 'routineId'),
        bot_id: normalizedBotId,
        name: validateBoundedString(request.name, 'name', { maximum: 160 }),
        schedule_contract: structuredClone(contract),
        timezone: contract.timezone,
        missed_policy: contract.missedPolicy,
        missed_run_cap: contract.missedRunCap,
        status: 'draft',
        revision_behavior: 'current_active',
        next_occurrence_at: null,
        last_occurrence_at: null,
        created_by: validateUuid(principal?.id, 'principal.id'),
        managed_by: validateUuid(principal?.id, 'principal.id'),
        retired_at: null,
      });
      await audit({
        principal,
        botId: normalizedBotId,
        targetType: 'bot_routine',
        targetId: row.id,
        action: 'bot.routine.created',
        result: 'success',
        metadata: { status: row.status },
      });
      return Object.freeze({ routine: publicRoutine(row) });
    },

    async updateDraft(principal, botId, routineId, request) {
      exact(request, {
        label: 'Routine draft update',
        required: ['name', 'contract', 'expectedUpdatedAt'],
      });
      const normalizedBotId = validateUuid(botId, 'botId');
      await authorization.requireManager(principal, normalizedBotId);
      const current = await currentRoutine(routineId);
      if (current.bot_id !== normalizedBotId || !['draft', 'paused'].includes(current.status)) {
        fail('Only Draft or Paused routines can be edited', 'bot_routine_not_editable', 409);
      }
      const contract = validateBotRoutineContract(request.contract);
      const row = await store.repositories.bot_routines.updateIfRevision(
        { id: current.id, bot_id: normalizedBotId },
        {
          name: validateBoundedString(request.name, 'name', { maximum: 160 }),
          schedule_contract: structuredClone(contract),
          timezone: contract.timezone,
          missed_policy: contract.missedPolicy,
          missed_run_cap: contract.missedRunCap,
          status: 'draft',
          next_occurrence_at: null,
          managed_by: validateUuid(principal?.id, 'principal.id'),
          retired_at: null,
        },
        request.expectedUpdatedAt,
      );
      await rearm();
      await audit({
        principal,
        botId: normalizedBotId,
        targetType: 'bot_routine',
        targetId: row.id,
        action: 'bot.routine.updated',
        result: 'success',
        metadata: { previousStatus: current.status, status: row.status },
      });
      return Object.freeze({ routine: publicRoutine(row) });
    },

    async transition(principal, botId, routineId, request) {
      exact(request, {
        label: 'Routine lifecycle transition',
        required: ['target', 'expectedUpdatedAt'],
        optional: ['reviewed'],
      });
      const normalizedBotId = validateUuid(botId, 'botId');
      await authorization.requireManager(principal, normalizedBotId);
      const current = await currentRoutine(routineId);
      if (current.bot_id !== normalizedBotId || current.status === 'retired') {
        fail('Bot routine cannot transition', 'bot_routine_transition_invalid', 409);
      }
      if (!['active', 'paused', 'retired'].includes(request.target)) {
        fail('Routine lifecycle target is invalid');
      }
      const changes = { managed_by: validateUuid(principal?.id, 'principal.id') };
      if (request.target === 'active') {
        if (!['draft', 'paused'].includes(current.status)) {
          fail('Only a Draft or Paused routine can be activated', 'bot_routine_transition_invalid', 409);
        }
        if (request.reviewed !== true) {
          fail('Manager review is required before routine activation', 'bot_routine_review_required', 409);
        }
        const contract = validateBotRoutineContract(current.schedule_contract);
        const preservedDue = current.status === 'paused'
          ? Date.parse(current.next_occurrence_at)
          : Number.NaN;
        const next = Number.isFinite(preservedDue)
          ? preservedDue
          : nextBotRoutineOccurrence(contract, now().getTime());
        if (!Number.isFinite(next)) {
          fail('Routine schedule has no future occurrence', 'bot_routine_schedule_exhausted', 409);
        }
        Object.assign(changes, {
          status: 'active',
          next_occurrence_at: new Date(next).toISOString(),
          retired_at: null,
        });
      } else if (request.target === 'paused') {
        if (current.status !== 'active') fail('Only an Active routine can be paused', 'bot_routine_transition_invalid', 409);
        Object.assign(changes, { status: 'paused', retired_at: null });
      } else {
        Object.assign(changes, { status: 'retired', retired_at: now().toISOString() });
      }
      const row = await store.repositories.bot_routines.updateIfRevision(
        { id: current.id, bot_id: normalizedBotId },
        changes,
        request.expectedUpdatedAt,
      );
      await rearm();
      await audit({
        principal,
        botId: normalizedBotId,
        targetType: 'bot_routine',
        targetId: row.id,
        action: `bot.routine.${request.target}`,
        result: 'success',
        metadata: { previousStatus: current.status, nextOccurrenceAt: row.next_occurrence_at },
      });
      return Object.freeze({ routine: publicRoutine(row) });
    },

    async onRunSettled({ run } = {}) {
      if (!run?.id || !TERMINAL_RUN_STATES.has(run.state)) return;
      const occurrence = await store.repositories.bot_routine_occurrences.get({ run_id: run.id });
      if (!occurrence || occurrence.state !== 'dispatched') return;
      await updateOccurrence(occurrence, {
        state: run.state === 'completed' ? 'completed' : 'failed',
      }).catch((error) => {
        if (error?.code !== 'bot_revision_conflict') throw error;
      });
    },

    async checkpoint() {
      checkpointStatus = 'checkpointing';
      try {
        if (sweepPromise) await sweepPromise;
        checkpointStatus = 'complete';
        return Object.freeze({ status: 'complete' });
      } catch (error) {
        checkpointStatus = 'failed';
        throw error;
      }
    },

    async getStatus() {
      const active = await listAll(store.repositories.bot_routines, { status: 'active' });
      const currentMs = now().getTime();
      return Object.freeze({
        activeRoutineCount: active.length,
        pendingRoutineCount: active.filter((routine) => (
          Number.isFinite(Date.parse(routine.next_occurrence_at))
          && Date.parse(routine.next_occurrence_at) <= currentMs
        )).length,
        schedulerStatus: shuttingDown ? 'stopped' : started ? 'active' : 'idle',
        checkpointStatus,
      });
    },

    async shutdown() {
      if (shuttingDown) return;
      shuttingDown = true;
      clearWake();
      if (sweepPromise) await sweepPromise;
      started = false;
    },
  });
}
