import crypto, { randomUUID } from 'node:crypto';

import {
  hashCanonicalBotJson,
  validateBotActionDescriptor,
} from '@openchamber/bots-runtime';

import { publicBotActionAttempt } from './approval-service.js';
import {
  safeBotBrowserAuditRemoteCode,
  validateBotBrowserAction,
} from './browser-service.js';
import { decryptBotJson, encryptBotJson } from './encryption.js';
import { guardBotRoutineAction } from './routine-runtime.js';
import { createBotFailureRecorder } from './failure-diagnostics.js';
import {
  assertExactObject,
  validateBoundedJsonObject,
  validateBoundedString,
  validateOptionalUuid,
  validateUuid,
} from './validation.js';

const DEPLOYMENT_KEY_ID = 'deployment-v1';
const ACTIVE_ACTION_RUN_STATES = new Set([
  'running',
  'waiting_approval',
  'waiting_control',
  'needs_reconciliation',
]);
const ACTION_RESULT_MAX_BYTES = 192 * 1024;
const MAX_SAFE_READ_ATTEMPTS = 3;
const RESERVED_LIMIT_FIELDS = new Set(['allowedOperations', 'decisionExpiresAt']);
const RECONCILIATION_DECISIONS = new Set(['complete', 'retry_new', 'abandon']);
const FILE_FACT_KEYS = new Set([
  'path', 'paths', 'filePath', 'filePaths', 'sourcePath', 'destinationPath',
]);

export class BotActionGatewayError extends Error {
  constructor(message, code = 'bot_action_invalid', statusCode = 400) {
    super(message);
    this.name = 'BotActionGatewayError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (message, code, statusCode) => {
  throw new BotActionGatewayError(message, code, statusCode);
};

const isUniqueViolation = (error) => (
  error?.code === '23505' || error?.payload?.code === '23505'
);

const isQuotaExhausted = (error) => (
  error?.code === 'bot_quota_exhausted'
  || error?.message === 'bot_quota_exhausted'
  || error?.payload?.message === 'bot_quota_exhausted'
);

export const actionArgsAssociatedData = (actionAttemptId, actionHash) => (
  `devryan:bot-action-args:${validateUuid(actionAttemptId, 'actionAttemptId')}:${actionHash}`
);

export const actionResultAssociatedData = (actionAttemptId, actionHash) => (
  `devryan:bot-action-result:${validateUuid(actionAttemptId, 'actionAttemptId')}:${actionHash}`
);

const normalizeTool = (value) => validateBoundedString(value, 'tool', {
  maximum: 120,
  pattern: /^[a-z][a-z0-9._:-]*$/,
}).toLowerCase();

const normalizeActionName = (value) => validateBoundedString(value, 'action', {
  maximum: 120,
  pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
}).toLowerCase();

const normalizeCallerLimits = (value) => {
  const limits = validateBoundedJsonObject(value ?? {}, 'limits', 16 * 1024);
  if (Object.keys(limits).some((field) => RESERVED_LIMIT_FIELDS.has(field))) {
    fail('Bot action limits contain a reserved policy field');
  }
  if (limits.maxAttempts !== undefined
    && (!Number.isSafeInteger(limits.maxAttempts)
      || limits.maxAttempts < 1 || limits.maxAttempts > MAX_SAFE_READ_ATTEMPTS)) {
    fail('Bot action maxAttempts is invalid');
  }
  return limits;
};

const normalizeGatewayRequest = (operation, payload) => {
  if (operation === 'artifact.put') {
    try {
      assertExactObject(payload, {
        label: 'Bot Shared publication',
        required: ['idempotencyKey', 'filename', 'contentType', 'contentBase64'],
      });
    } catch (error) {
      fail(error.message);
    }
    return Object.freeze({
      idempotencyKey: validateBoundedString(payload.idempotencyKey, 'idempotencyKey', {
        maximum: 512,
      }),
      tool: 'connector:shared',
      action: 'publish',
      target: Object.freeze({
        filename: validateBoundedString(payload.filename, 'filename', { maximum: 255 }),
        contentType: validateBoundedString(payload.contentType, 'contentType', { maximum: 255 }),
        goal: 'Publish this file to the current conversation Shared folder',
      }),
      args: Object.freeze({
        contentBase64: validateBoundedString(payload.contentBase64, 'contentBase64', {
          maximum: 48 * 1024,
        }),
      }),
      callerLimits: Object.freeze({ maxAttempts: 1 }),
      credentialId: null,
    });
  }
  if (operation === 'workspace.write') {
    try {
      assertExactObject(payload, {
        label: 'Bot workspace write',
        required: ['idempotencyKey', 'path', 'content'],
      });
    } catch (error) {
      fail(error.message);
    }
    const filePath = validateBoundedString(payload.path, 'path', {
      maximum: 128,
      pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
    });
    if (['.devryan', '.opencode'].includes(filePath.toLowerCase())
      || typeof payload.content !== 'string'
      || Buffer.byteLength(payload.content, 'utf8') > 48 * 1024) {
      fail('Bot workspace write is invalid');
    }
    return Object.freeze({
      idempotencyKey: validateBoundedString(payload.idempotencyKey, 'idempotencyKey', {
        maximum: 512,
      }),
      tool: 'connector:workspace',
      action: 'write',
      target: Object.freeze({ path: filePath }),
      args: Object.freeze({ content: payload.content }),
      callerLimits: Object.freeze({ maxAttempts: 1 }),
      credentialId: null,
    });
  }
  if (operation === 'computer.command') {
    try {
      assertExactObject(payload, {
        label: 'Bot computer action',
        required: ['idempotencyKey', 'command', 'args', 'target', 'limits'],
      });
    } catch (error) {
      fail(error.message);
    }
    const browser = validateBotBrowserAction({
      command: payload.command,
      args: payload.args,
      target: payload.target,
      limits: payload.limits,
    });
    return Object.freeze({
      idempotencyKey: validateBoundedString(payload.idempotencyKey, 'idempotencyKey', {
        maximum: 512,
      }),
      tool: 'browser',
      action: browser.command,
      args: browser.args,
      target: browser.target,
      callerLimits: normalizeCallerLimits(payload.limits),
      credentialId: null,
    });
  }
  if (operation !== 'action.request') {
    fail('Bot gateway operation is not implemented', 'bot_gateway_operation_unavailable', 503);
  }
  try {
    assertExactObject(payload, {
      label: 'Bot action request',
      required: ['idempotencyKey', 'tool', 'action', 'target', 'args', 'limits'],
      optional: ['credentialId'],
    });
  } catch (error) {
    fail(error.message);
  }
  return Object.freeze({
    idempotencyKey: validateBoundedString(payload.idempotencyKey, 'idempotencyKey', {
      maximum: 512,
    }),
    tool: normalizeTool(payload.tool),
    action: normalizeActionName(payload.action),
    target: validateBoundedJsonObject(payload.target, 'target', 16 * 1024),
    args: validateBoundedJsonObject(payload.args, 'args', 64 * 1024),
    callerLimits: normalizeCallerLimits(payload.limits),
    credentialId: validateOptionalUuid(payload.credentialId, 'credentialId'),
  });
};

const connectorIdForTool = (tool) => {
  const match = /^connector[:.]([a-z][a-z0-9._-]{0,119})$/.exec(tool);
  return match?.[1] || null;
};

const operationKindFromRow = (row) => {
  if (row.target?.operationKind === 'read' || row.target?.operationKind === 'write') {
    return row.target.operationKind;
  }
  return row.tool === 'browser'
    && ['download', 'navigate', 'screenshot', 'scroll', 'snapshot', 'status', 'wait']
      .includes(row.action)
    ? 'read'
    : 'write';
};

const publicReceipt = (row) => {
  const receipt = row.execution_receipt;
  if (!receipt || typeof receipt !== 'object') return null;
  return Object.freeze({
    operationKind: receipt.operationKind || null,
    nativeExactlyOnce: receipt.nativeExactlyOnce === true,
    writeGuarantee: receipt.writeGuarantee || null,
    evidenceObjectIds: Object.freeze([...(receipt.evidenceObjectIds || [])]),
    evidenceIncomplete: receipt.evidenceIncomplete === true,
    executedAt: receipt.executedAt || null,
    failureCode: receipt.failureCode || null,
  });
};

export function createBotActionGateway({
  store,
  channels,
  authorization,
  policyEngine,
  approvalService,
  browserService,
  connectorRegistry,
  evidenceService,
  eventStream,
  encryption,
  audit = async () => {},
  recordDiagnostic = () => {},
  onRunSettled = async () => {},
  now = () => new Date(),
  uuid = randomUUID,
} = {}) {
  const recordFailure = createBotFailureRecorder(recordDiagnostic);
  if (!store?.repositories?.bot_action_attempts || !store.repositories?.bot_runs
    || !store.repositories?.bots || !store.repositories?.bot_channels
    || !store.repositories?.bot_revisions || !store.repositories?.bot_messages
    || !channels || typeof channels.audienceForChannel !== 'function'
    || typeof channels.publicRun !== 'function'
    || !authorization || typeof authorization.requireOperator !== 'function'
    || typeof authorization.requireActiveMembership !== 'function'
    || !policyEngine || typeof policyEngine.classify !== 'function'
    || typeof policyEngine.bind !== 'function'
    || !approvalService || typeof approvalService.notifyPending !== 'function'
    || typeof approvalService.waitForDecision !== 'function'
    || !browserService || typeof browserService.executeAction !== 'function'
    || typeof browserService.waitForControlRelease !== 'function'
    || !connectorRegistry || typeof connectorRegistry.execute !== 'function'
    || !evidenceService || typeof evidenceService.capture !== 'function'
    || !eventStream || typeof eventStream.publish !== 'function'
    || typeof audit !== 'function' || typeof onRunSettled !== 'function'
    || typeof now !== 'function' || typeof uuid !== 'function') {
    throw new TypeError('Bot action gateway is misconfigured');
  }

  const withKey = async (operation) => {
    let supplied = null;
    let key = null;
    try {
      if (typeof encryption?.getKey !== 'function') {
        fail('Bot encryption key is unavailable', 'bot_os_encryption_unavailable', 503);
      }
      supplied = await encryption.getKey();
      key = Buffer.from(supplied || []);
      if (key.byteLength !== 32) {
        fail('Bot encryption key is unavailable', 'bot_os_encryption_unavailable', 503);
      }
      return await operation(key);
    } finally {
      key?.fill(0);
      if (Buffer.isBuffer(supplied) || supplied instanceof Uint8Array) supplied.fill(0);
    }
  };

  const loadContext = async (claims) => {
    const run = await store.repositories.bot_runs.get({ id: validateUuid(claims?.runId, 'runId') });
    if (!run || run.bot_id !== claims.botId || run.channel_id !== claims.channelId
      || run.revision_id !== claims.revisionId) {
      fail('Bot action capability does not match a durable run', 'bot_gateway_scope_denied', 403);
    }
    if (!ACTIVE_ACTION_RUN_STATES.has(run.state)) {
      fail('Bot run is not accepting actions', 'bot_action_run_inactive', 409);
    }
    const [bot, channel, revision, message] = await Promise.all([
      store.repositories.bots.get({ id: run.bot_id }),
      store.repositories.bot_channels.get({ id: run.channel_id, bot_id: run.bot_id }),
      store.repositories.bot_revisions.get({ id: run.revision_id, bot_id: run.bot_id }),
      store.repositories.bot_messages.get({
        run_id: run.id,
        channel_id: run.channel_id,
        role: 'user',
      }),
    ]);
    if (!bot || !channel || !revision || !message?.actor_user_id) {
      fail('Bot action context is unavailable', 'bot_run_context_missing', 409);
    }
    const principal = Object.freeze({
      id: message.actor_user_id,
      role: 'developer',
      scope: 'managed',
    });
    const membershipContext = await authorization.requireActiveMembership(
      principal,
      bot.id,
    );
    return Object.freeze({
      run,
      bot,
      channel,
      revision,
      principal,
      actorRole: membershipContext.membership.role,
    });
  };

  const loadCredentialScope = async (request, context) => {
    if (!request.credentialId) return null;
    const credential = await store.repositories.bot_credentials?.get?.({
      id: request.credentialId,
      bot_id: context.bot.id,
    });
    if (!credential || credential.status !== 'active' || credential.revoked_at !== null
      || (credential.credential_scope === 'team' && credential.owner_user_id !== null)
      || (credential.credential_scope === 'user'
        && credential.owner_user_id !== context.channel.owner_user_id)) {
      fail('Bot credential scope is unavailable', 'bot_credential_unavailable', 409);
    }
    return credential.credential_scope === 'team'
      ? `team:${credential.id}`
      : `user:${credential.owner_user_id}:${credential.id}`;
  };

  const normalizeConnectorAction = async (request, context) => {
    if (request.tool === 'browser') {
      const browser = validateBotBrowserAction({
        command: request.action,
        args: request.args,
        target: request.target,
        limits: request.callerLimits,
      });
      return Object.freeze({ ...request, args: browser.args, target: browser.target });
    }
    const connectorId = connectorIdForTool(request.tool);
    if (!connectorId) fail('Bot action tool is not registered', 'bot_connector_unregistered', 403);
    const validated = await connectorRegistry.validate(connectorId, {
      action: request.action,
      target: request.target,
      args: request.args,
      limits: request.callerLimits,
      botId: context.bot.id,
      revisionId: context.revision.id,
      channelOwnerUserId: context.channel.owner_user_id,
      credentialId: request.credentialId,
    });
    const validationFields = Object.keys(validated || {}).sort().join('\0');
    if (!validated || typeof validated !== 'object' || Array.isArray(validated)
      || !['args\0operationKind\0target', 'args\0credentialId\0operationKind\0target']
        .includes(validationFields)
      || !['read', 'write'].includes(validated.operationKind)) {
      fail('Bot connector validation result is invalid', 'bot_connector_contract_invalid', 500);
    }
    return Object.freeze({
      ...request,
      args: validateBoundedJsonObject(validated.args, 'connector args', 64 * 1024),
      target: {
        ...validateBoundedJsonObject(validated.target, 'connector target', 16 * 1024),
        operationKind: validated.operationKind,
      },
      credentialId: validationFields.includes('credentialId')
        ? validateOptionalUuid(validated.credentialId, 'connector credentialId')
        : request.credentialId,
    });
  };

  const actionDescriptor = ({ request, context, credentialScopeKey, limits }) => {
    const descriptor = {
      botId: context.bot.id,
      revisionId: context.revision.id,
      runId: context.run.id,
      channelId: context.channel.id,
      initiatorUserId: context.principal.id,
      tool: request.tool,
      action: request.action,
      target: structuredClone(request.target),
      credentialScopeKey,
      computerScopeKey: context.run.computer_scope_key,
      args: structuredClone(request.args),
      limits: structuredClone(limits),
    };
    validateBotActionDescriptor(descriptor);
    return descriptor;
  };

  const collectFileFacts = (request) => {
    const facts = new Set();
    const visit = (value, key = null, depth = 0) => {
      if (depth > 8 || value === null || value === undefined) return;
      if (typeof value === 'string' && FILE_FACT_KEYS.has(key)) {
        const candidate = value.normalize('NFC');
        if (candidate.startsWith('/')) facts.add(candidate);
        else if (candidate && !candidate.includes('://')) facts.add(`/workspace/${candidate}`);
        return;
      }
      if (Array.isArray(value)) {
        if (FILE_FACT_KEYS.has(key)) value.forEach((entry) => visit(entry, 'path', depth + 1));
        return;
      }
      if (typeof value !== 'object') return;
      for (const [entryKey, entryValue] of Object.entries(value)) {
        visit(entryValue, entryKey, depth + 1);
      }
    };
    visit(request.target);
    visit(request.args);
    return Object.freeze([...facts].sort());
  };

  const policyFactsFor = async (request, context) => {
    let authoritativeUrl = null;
    if (request.tool === 'browser') {
      if (request.action === 'navigate') {
        authoritativeUrl = request.args.url;
      } else if (typeof browserService.policyFacts === 'function') {
        authoritativeUrl = (await browserService.policyFacts({
          run: context.run,
          bot: context.bot,
          ownerUserId: context.channel.owner_user_id,
        })).authoritativeUrl;
      }
    }
    return Object.freeze({
      actorRole: context.actorRole,
      authoritativeUrl,
      filePaths: collectFileFacts(request),
      connectorSchemaValidated: request.tool !== 'browser',
    });
  };

  const quotaBindingFor = ({ classification, context }) => {
    const rules = classification.quotaRules || [];
    if (rules.length === 0) return Object.freeze({ version: 1, reservations: Object.freeze([]) });
    const current = now().getTime();
    if (!Number.isFinite(current)) fail('Bot quota clock is invalid', 'bot_quota_unavailable', 503);
    const reservations = rules.map((quota) => {
      const windowMs = quota.windowSeconds * 1_000;
      const windowStart = Math.floor(current / windowMs) * windowMs;
      return Object.freeze({
        reservationId: validateUuid(uuid(), 'quotaReservationId'),
        ruleId: quota.ruleId,
        scope: quota.scope,
        scopeKey: quota.scope === 'actor' ? context.principal.id : context.bot.id,
        limit: quota.limit,
        windowStart: new Date(windowStart).toISOString(),
        windowEnd: new Date(windowStart + windowMs).toISOString(),
      });
    });
    return Object.freeze({ version: 1, reservations: Object.freeze(reservations) });
  };

  const releaseQuotas = async (row, disposition = 'released') => {
    if (!row?.quota_binding?.reservations?.length) return;
    await store.releaseActionQuotas?.({
      actionAttemptId: row.id,
      disposition,
      now: now().toISOString(),
    });
  };

  const effectiveLimits = (request, classification, expiresAt) => {
    const requestedAttempts = request.callerLimits.maxAttempts;
    const maxAttempts = classification.operationKind === 'read'
      ? Math.min(MAX_SAFE_READ_ATTEMPTS, requestedAttempts ?? 2)
      : 1;
    return Object.freeze({
      ...request.callerLimits,
      maxAttempts,
      allowedOperations: Object.freeze([request.action]),
      decisionExpiresAt: expiresAt,
    });
  };

  const decisionFromRow = (row, descriptor) => Object.freeze({
    actionHash: row.action_hash,
    effect: row.policy_effect,
    risk: row.risk,
    approvalClass: row.approval_class,
    operationKind: operationKindFromRow(row),
    retainEvidence: row.retain_evidence === true,
    requireDistinctApprover: row.requires_distinct_approver === true,
    ruleIds: Object.freeze([...(row.policy_rule_ids || [])]),
    expiresAt: row.decision_expires_at,
    binding: Object.freeze({
      botId: descriptor.botId,
      revisionId: descriptor.revisionId,
      runId: descriptor.runId,
      credentialScopeKey: descriptor.credentialScopeKey,
      computerScopeKey: descriptor.computerScopeKey,
      target: structuredClone(descriptor.target),
      initiatorUserId: descriptor.initiatorUserId,
      limits: structuredClone(descriptor.limits),
      ...(row.matcher_version === 2 ? {
        matcherVersion: 2,
        policyFactsDigest: row.policy_facts_digest,
        authoritativeActorRole: row.authoritative_actor_role,
        quotaBinding: structuredClone(row.quota_binding || {}),
      } : {}),
    }),
    ...(row.matcher_version === 2 ? {
      matcherVersion: 2,
      policyFactsDigest: row.policy_facts_digest,
      authoritativeActorRole: row.authoritative_actor_role,
      quotaBinding: Object.freeze(structuredClone(row.quota_binding || {})),
    } : {}),
  });

  const encryptArgs = (key, actionId, hash, request, limits) => encryptBotJson({
    key,
    keyId: DEPLOYMENT_KEY_ID,
    value: { version: 1, args: request.args, limits },
    associatedData: actionArgsAssociatedData(actionId, hash),
  });

  const decryptArgs = (key, row) => {
    const value = decryptBotJson({
      key,
      envelope: row.encrypted_args,
      expectedKeyId: DEPLOYMENT_KEY_ID,
      associatedData: actionArgsAssociatedData(row.id, row.action_hash),
    });
    if (!value || value.version !== 1 || !value.args || !value.limits) {
      fail('Bot action argument envelope is invalid', 'bot_action_envelope_invalid', 500);
    }
    return value;
  };

  const decryptResult = (key, row) => {
    const envelope = row.execution_receipt?.resultEnvelope;
    if (!envelope) return null;
    const value = decryptBotJson({
      key,
      envelope,
      expectedKeyId: DEPLOYMENT_KEY_ID,
      associatedData: actionResultAssociatedData(row.id, row.action_hash),
    });
    return value?.version === 1 ? value.result : null;
  };

  const updateAction = async (row, changes) => store.repositories.bot_action_attempts.updateIfRevision(
    { id: row.id },
    changes,
    row.updated_at,
  );

  const updateRunState = async (runId, state, changes = {}) => {
    const run = await store.repositories.bot_runs.get({ id: runId });
    if (!run || run.state === state) return run;
    return store.repositories.bot_runs.updateIfRevision(
      { id: run.id },
      { state, ...changes },
      run.updated_at,
    );
  };

  const publishAction = async (kind, row, context, extra = {}) => eventStream.publish({
    kind,
    botId: row.bot_id,
    channelId: context.channel.id,
    audienceUserIds: await channels.audienceForChannel(context.channel.id),
    payload: { action: publicBotActionAttempt(row), ...extra },
  });

  const publishRun = async (kind, run, context) => eventStream.publish({
    kind,
    botId: run.bot_id,
    channelId: context.channel.id,
    audienceUserIds: await channels.audienceForChannel(context.channel.id),
    payload: { run: channels.publicRun(run) },
  });

  const auditAction = (actionName, result, row, context, metadata = {}) => audit({
    principal: context.principal,
    botId: row.bot_id,
    targetType: 'bot_action_attempt',
    targetId: row.id,
    action: actionName,
    result,
    metadata: {
      runId: row.run_id,
      actionHash: row.action_hash,
      revisionId: row.revision_id,
      actionType: `${row.tool}:${row.action}`,
      policyEffect: row.policy_effect,
      approvalClass: row.approval_class,
      ...metadata,
    },
  });

  const persistNewAction = async ({ actionId, request, context, descriptor, decision }) => {
    const argsDigest = hashCanonicalBotJson({ args: descriptor.args, limits: descriptor.limits });
    const encryptedArgs = await withKey((key) => encryptArgs(
      key,
      actionId,
      decision.actionHash,
      request,
      descriptor.limits,
    ));
    let row;
    try {
      row = await store.repositories.bot_action_attempts.insert({
        id: actionId,
        run_id: context.run.id,
        bot_id: context.bot.id,
        revision_id: context.revision.id,
        credential_id: request.credentialId,
        computer_scope_key: context.run.computer_scope_key,
        action_hash: decision.actionHash,
        idempotency_key: request.idempotencyKey,
        tool: request.tool,
        action: request.action,
        target: request.target,
        encrypted_args: encryptedArgs,
        args_digest: argsDigest,
        risk: decision.risk,
        approval_class: decision.approvalClass,
        policy_effect: decision.effect,
        policy_rule_ids: [...decision.ruleIds],
        decision_expires_at: decision.expiresAt,
        matcher_version: decision.matcherVersion || null,
        policy_facts_digest: decision.policyFactsDigest || null,
        authoritative_actor_role: decision.authoritativeActorRole || null,
        quota_binding: decision.quotaBinding || null,
        requires_distinct_approver: decision.requireDistinctApprover,
        retain_evidence: decision.retainEvidence,
        state: 'proposed',
        execution_receipt: null,
        unknown_outcome: false,
        reconciliation_decision: null,
        initiated_by: context.principal.id,
        started_at: null,
        finished_at: null,
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      row = await store.repositories.bot_action_attempts.get({
        run_id: context.run.id,
        idempotency_key: request.idempotencyKey,
      });
      if (!row) throw error;
      return Object.freeze({ row, created: false });
    }
    return Object.freeze({ row, created: true });
  };

  const transitionProposedAction = async (row, changes) => {
    let current = row;
    for (let attempt = 0; attempt < 3 && current?.state === 'proposed'; attempt += 1) {
      try {
        return await updateAction(current, changes);
      } catch (error) {
        if (error?.code !== 'bot_revision_conflict') throw error;
        current = await store.repositories.bot_action_attempts.get({ id: row.id });
      }
    }
    return current;
  };

  const failQuotaInitialization = async (row, failureCode, statusCode) => {
    const failed = await transitionProposedAction(row, {
      state: 'failed',
      execution_receipt: { version: 1, failureCode },
      finished_at: now().toISOString(),
    });
    if (failed?.state !== 'failed') return failed;
    fail(
      failureCode === 'bot_quota_exhausted'
        ? 'Bot action quota is exhausted for this window'
        : 'Bot action quota service is unavailable',
      failureCode,
      statusCode,
    );
  };

  const finalizeProposedAction = async (row) => {
    if (row?.state !== 'proposed') return row;
    const quotaReservations = row.quota_binding?.reservations || [];
    if (quotaReservations.length) {
      if (typeof store.reserveActionQuotas !== 'function') {
        const winner = await failQuotaInitialization(row, 'bot_quota_unavailable', 503);
        if (winner?.state !== 'proposed') return winner;
      } else {
        try {
          await store.reserveActionQuotas({
            actionAttemptId: row.id,
            revisionId: row.revision_id,
            actorUserId: row.initiated_by,
            bindings: quotaReservations,
            now: now().toISOString(),
          });
        } catch (error) {
          const winner = await store.repositories.bot_action_attempts.get({ id: row.id });
          if (winner && winner.state !== 'proposed') return winner;
          const failureCode = isQuotaExhausted(error)
            ? 'bot_quota_exhausted'
            : 'bot_quota_unavailable';
          const failed = await failQuotaInitialization(
            winner || row,
            failureCode,
            failureCode === 'bot_quota_exhausted' ? 429 : 503,
          );
          if (failed?.state !== 'proposed') return failed;
        }
      }
    }
    const nextState = row.policy_effect === 'deny'
      ? 'denied'
      : row.policy_effect === 'prompt'
        ? 'pending_approval'
        : 'approved';
    const finalized = await transitionProposedAction(row, {
      state: nextState,
      ...(nextState === 'denied' ? { finished_at: now().toISOString() } : {}),
    });
    if (!finalized || finalized.state === 'proposed') {
      fail('Bot action initialization is still in progress', 'bot_action_initializing', 409);
    }
    if (finalized.state === 'denied') await releaseQuotas(finalized);
    return finalized;
  };

  const executeBrowser = (row, context, decrypted, decision, signal) => browserService.executeAction({
    actionAttemptId: row.id,
    run: context.run,
    bot: context.bot,
    ownerUserId: context.channel.owner_user_id,
    command: row.action,
    args: decrypted.args,
    target: row.target,
    limits: decrypted.limits,
    decision,
    signal,
  });

  const executeConnector = async (row, context, decrypted, decision, signal) => {
    const connectorId = connectorIdForTool(row.tool);
    if (!connectorId) fail('Bot connector is not registered', 'bot_connector_unregistered', 403);
    await connectorRegistry.authorize(connectorId, {
      action: publicBotActionAttempt(row),
      policyDecision: decision,
      credentialId: row.credential_id,
    });
    const execution = await connectorRegistry.execute(connectorId, {
      botId: context.bot.id,
      channelId: context.channel.id,
      runId: context.run.id,
      principalId: context.principal.id,
      action: row.action,
      target: row.target,
      args: decrypted.args,
      limits: decrypted.limits,
      idempotencyKey: row.idempotency_key,
      credentialId: row.credential_id,
      signalAborted: signal?.aborted === true,
    });
    const receipt = execution?.connectorReceipt;
    return Object.freeze({
      result: receipt ? execution.result : execution,
      operationKind: decision.operationKind,
      nativeExactlyOnce: receipt ? receipt.nativeExactlyOnce === true : true,
      writeGuarantee: receipt?.writeGuarantee || 'connector_receipt',
    });
  };

  const executeApproved = async (row, context, decision, request, descriptor, signal) => {
    const resumingControlWait = row.state === 'waiting_control';
    if (!resumingControlWait && Date.parse(row.decision_expires_at) <= now().getTime()) {
      await releaseQuotas(row, 'expired').catch(() => undefined);
      row = await updateAction(row, {
        state: 'failed',
        execution_receipt: { version: 1, failureCode: 'bot_policy_expired' },
        finished_at: now().toISOString(),
      });
      fail('Bot action policy decision has expired', 'bot_policy_expired', 410);
    }
    if (!resumingControlWait && row.matcher_version === 2) {
      try {
        const liveContext = await loadContext({
          botId: row.bot_id,
          runId: row.run_id,
          channelId: context.channel.id,
          revisionId: row.revision_id,
        });
        const facts = await policyFactsFor(request, liveContext);
        let liveClassification = policyEngine.classify({
          action: descriptor,
          actionPolicy: liveContext.revision.contract?.actionPolicy || {},
          browserPolicy: liveContext.revision.contract?.browserPolicy || {},
          facts,
        });
        if (liveContext.run.context_snapshot?.routine) {
          const priorPage = await store.repositories.bot_action_attempts.list({
            filters: { run_id: liveContext.run.id },
            limit: 100,
          });
          liveClassification = guardBotRoutineAction({
            snapshot: liveContext.run.context_snapshot.routine,
            request,
            classification: liveClassification,
            priorActions: priorPage.items.filter((candidate) => candidate.id !== row.id),
          });
        }
        if (liveClassification.matcherVersion !== 2
          || liveClassification.policyFactsDigest !== row.policy_facts_digest
          || liveClassification.policyFacts.actorRole !== row.authoritative_actor_role
          || liveClassification.effect !== decision.effect
          || JSON.stringify(liveClassification.ruleIds) !== JSON.stringify(decision.ruleIds)) {
          fail(
            'Bot action policy facts changed after approval',
            'bot_approval_binding_invalidated',
            409,
          );
        }
        if (row.quota_binding?.reservations?.length) {
          if (typeof store.consumeActionQuotas !== 'function') {
            fail('Bot action quota service is unavailable', 'bot_quota_unavailable', 503);
          }
          try {
            await store.consumeActionQuotas({
              actionAttemptId: row.id,
              now: now().toISOString(),
            });
          } catch (error) {
            fail(
              'Bot action quota reservation expired or changed',
              isQuotaExhausted(error) ? 'bot_quota_exhausted' : 'bot_quota_reservation_invalid',
              isQuotaExhausted(error) ? 429 : 409,
            );
          }
        }
      } catch (error) {
        await releaseQuotas(row, error?.code === 'bot_policy_expired' ? 'expired' : 'released')
          .catch(() => undefined);
        row = await updateAction(row, {
          state: 'failed',
          execution_receipt: {
            version: 1,
            failureCode: error?.code || 'bot_approval_binding_invalidated',
          },
          finished_at: now().toISOString(),
        }).catch(() => row);
        throw error;
      }
    }
    if (resumingControlWait) {
      await browserService.waitForControlRelease({
        run: context.run,
        bot: context.bot,
        ownerUserId: context.channel.owner_user_id,
        signal,
      });
    }
    try {
      row = await updateAction(row, {
        state: 'executing',
        started_at: row.started_at || now().toISOString(),
      });
      if (resumingControlWait) {
        const resumedRun = await updateRunState(row.run_id, 'running').catch(() => undefined);
        if (resumedRun) await publishRun('run.control_resumed', resumedRun, context);
        await publishAction('action.control_resumed', row, context);
        await auditAction('bot.action.control_resumed', 'success', row, context, {
          phase: 'pre_execution_control_fence',
        });
      }
    } catch (error) {
      if (error?.code !== 'bot_revision_conflict') throw error;
      const winner = await store.repositories.bot_action_attempts.get({ id: row.id });
      if (winner?.state === 'succeeded') {
        const result = await withKey((key) => decryptResult(key, winner));
        return Object.freeze({ action: publicBotActionAttempt(winner), receipt: publicReceipt(winner), result });
      }
      if (winner?.state === 'cancelled') {
        fail('Bot action was cancelled with its run', 'bot_run_cancelled', 409);
      }
      fail('Bot action is already executing', 'bot_action_in_progress', 409);
    }
    const decrypted = await withKey((key) => decryptArgs(key, row));
    let beforeEvidence = null;
    const retainedBeforeEvidenceIds = resumingControlWait
      ? (row.execution_receipt?.evidenceObjectIds || [])
      : [];
    if (decision.retainEvidence && retainedBeforeEvidenceIds.length === 0) {
      try {
        beforeEvidence = await evidenceService.capture({
          retain: true,
          principal: context.principal,
          actionAttemptId: row.id,
          phase: 'before',
          run: context.run,
          bot: context.bot,
          channel: context.channel,
          target: row.target,
          signal,
        });
      } catch (error) {
        row = await updateAction(row, {
          state: 'failed',
          execution_receipt: { version: 1, failureCode: error?.code || 'bot_evidence_capture_failed' },
          finished_at: now().toISOString(),
        });
        throw error;
      }
    }

    let execution;
    let executionError = null;
    let controlWaitCount = 0;
    const attempts = decision.operationKind === 'read'
      ? Number(decrypted.limits.maxAttempts || 1)
      : 1;
    while (true) {
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          execution = row.tool === 'browser'
            ? await executeBrowser(row, context, decrypted, decision, signal)
            : await executeConnector(row, context, decrypted, decision, signal);
          executionError = null;
          break;
        } catch (error) {
          executionError = error;
          const retryableRead = decision.operationKind === 'read'
            && error?.transportUncertain === true && attempt < attempts;
          if (!retryableRead) break;
        }
      }
      if (executionError?.code !== 'bot_browser_control_held'
        || executionError?.preExecution !== true) break;
      controlWaitCount += 1;
      const evidenceObjectIds = [
        ...retainedBeforeEvidenceIds,
        ...(beforeEvidence ? [beforeEvidence.id] : []),
      ];
      row = await updateAction(row, {
        state: 'waiting_control',
        execution_receipt: {
          version: 1,
          operationKind: decision.operationKind,
          evidenceObjectIds,
          failureCode: null,
        },
      });
      const waitingRun = await updateRunState(row.run_id, 'waiting_control');
      await publishRun('run.waiting_control', waitingRun, context);
      await publishAction('action.waiting_control', row, context);
      await auditAction('bot.action.waiting_control', 'success', row, context, {
        phase: 'pre_execution_control_fence',
        retryable: true,
        attemptCount: controlWaitCount,
        remoteCode: executionError.remoteCode || null,
      });
      await browserService.waitForControlRelease({
        run: { ...context.run, state: 'waiting_control' },
        bot: context.bot,
        ownerUserId: context.channel.owner_user_id,
        signal,
      });
      row = await updateAction(row, { state: 'executing' });
      const resumedRun = await updateRunState(row.run_id, 'running').catch(() => undefined);
      if (resumedRun) await publishRun('run.control_resumed', resumedRun, context);
      await publishAction('action.control_resumed', row, context);
      await auditAction('bot.action.control_resumed', 'success', row, context, {
        phase: 'pre_execution_control_fence',
        attemptCount: controlWaitCount,
      });
      executionError = null;
    }

    if (executionError) {
      recordFailure({
        event: 'bot.action.failed', run: context.run, operationId: row.id,
        stage: 'action_execution', error: executionError,
      });
      if (signal?.aborted || executionError?.code === 'bot_run_cancelled') {
        const winner = await store.repositories.bot_action_attempts.get({ id: row.id });
        if (winner?.state === 'cancelled') {
          fail('Bot action was cancelled with its run', 'bot_run_cancelled', 409);
        }
      }
      const unknown = decision.operationKind === 'write'
        && executionError?.transportUncertain === true;
      row = await updateAction(row, {
        state: unknown ? 'unknown' : 'failed',
        execution_receipt: {
          version: 1,
          operationKind: decision.operationKind,
          nativeExactlyOnce: false,
          writeGuarantee: unknown ? 'unknown_on_transport_loss' : null,
          failureCode: executionError?.code || 'bot_action_execution_failed',
          evidenceObjectIds: beforeEvidence ? [beforeEvidence.id] : [],
          evidenceIncomplete: false,
          executedAt: null,
        },
        unknown_outcome: unknown,
        finished_at: now().toISOString(),
      });
      if (unknown) {
        await updateRunState(row.run_id, 'needs_reconciliation', {
          interruption_kind: row.tool === 'browser'
            ? 'browser_write_unknown'
            : 'connector_write_unknown',
          reconciliation_state: {
            version: 1,
            actionAttemptIds: [row.id],
            detectedAt: now().toISOString(),
          },
        });
        await publishAction('action.unknown', row, context);
        await auditAction('bot.action.unknown', 'unknown', row, context, {
          operationKind: decision.operationKind,
          writeGuarantee: 'unknown_on_transport_loss',
        });
        fail(
          'The external write may have completed and requires Operator reconciliation',
          'bot_action_needs_reconciliation',
          409,
        );
      }
      await publishAction('action.failed', row, context);
      await auditAction('bot.action.failed', 'failure', row, context, {
        failureCode: executionError?.code || 'bot_action_execution_failed',
        remoteCode: safeBotBrowserAuditRemoteCode(executionError?.remoteCode),
      });
      throw executionError;
    }

    const encodedResult = JSON.stringify(execution.result ?? {});
    if (Buffer.byteLength(encodedResult, 'utf8') > ACTION_RESULT_MAX_BYTES) {
      row = await updateAction(row, {
        state: 'failed',
        execution_receipt: { version: 1, failureCode: 'bot_action_result_too_large' },
        finished_at: now().toISOString(),
      });
      fail('Bot action result is too large', 'bot_action_result_too_large', 502);
    }
    let afterEvidence = null;
    let evidenceIncomplete = false;
    if (decision.retainEvidence) {
      try {
        afterEvidence = await evidenceService.capture({
          retain: true,
          principal: context.principal,
          actionAttemptId: row.id,
          phase: 'after',
          run: context.run,
          bot: context.bot,
          channel: context.channel,
          target: row.target,
          signal,
        });
      } catch {
        evidenceIncomplete = true;
      }
    }
    const executedAt = now().toISOString();
    const resultEnvelope = await withKey((key) => encryptBotJson({
      key,
      keyId: DEPLOYMENT_KEY_ID,
      value: { version: 1, result: execution.result ?? {} },
      associatedData: actionResultAssociatedData(row.id, row.action_hash),
    }));
    const evidenceObjectIds = [
      ...retainedBeforeEvidenceIds,
      beforeEvidence?.id,
      afterEvidence?.id,
    ].filter(Boolean);
    row = await updateAction(row, {
      state: 'succeeded',
      execution_receipt: {
        version: 1,
        resultEnvelope,
        operationKind: execution.operationKind,
        nativeExactlyOnce: execution.nativeExactlyOnce === true,
        writeGuarantee: execution.writeGuarantee,
        evidenceObjectIds,
        evidenceIncomplete,
        executedAt,
      },
      unknown_outcome: false,
      finished_at: executedAt,
    });
    const liveRun = await store.repositories.bot_runs.get({ id: row.run_id });
    if (liveRun?.state === 'waiting_approval') {
      await updateRunState(row.run_id, 'running').catch(() => undefined);
    }
    await publishAction('action.succeeded', row, context, { receipt: publicReceipt(row) });
    await auditAction('bot.action.succeeded', 'success', row, context, {
      operationKind: execution.operationKind,
      nativeExactlyOnce: execution.nativeExactlyOnce === true,
      writeGuarantee: execution.writeGuarantee,
      evidenceCount: evidenceObjectIds.length,
      evidenceIncomplete,
    });
    return Object.freeze({
      action: publicBotActionAttempt(row),
      receipt: publicReceipt(row),
      result: structuredClone(execution.result ?? {}),
    });
  };

  const handleAction = async ({ claims, operation, payload, signal }) => {
    let request = normalizeGatewayRequest(operation, payload);
    const context = await loadContext(claims);
    request = await normalizeConnectorAction(request, context);
    const credentialScopeKey = await loadCredentialScope(request, context);
    let existing = await store.repositories.bot_action_attempts.get({
      run_id: context.run.id,
      idempotency_key: request.idempotencyKey,
    });
    let createdAction = false;
    let descriptor;
    let decision;
    if (existing) {
      const classification = {
        operationKind: operationKindFromRow(existing),
      };
      const limits = effectiveLimits(request, classification, existing.decision_expires_at);
      descriptor = actionDescriptor({ request, context, credentialScopeKey, limits });
      const candidateHash = `sha256:${hashCanonicalBotJson(descriptor)}`;
      if (candidateHash !== existing.action_hash || existing.credential_id !== request.credentialId) {
        fail(
          'Bot action idempotency key was already used for a different action',
          'bot_action_idempotency_conflict',
          409,
        );
      }
      decision = decisionFromRow(existing, descriptor);
    } else {
      const actionId = validateUuid(uuid(), 'actionAttemptId');
      const prototype = actionDescriptor({
        request,
        context,
        credentialScopeKey,
        limits: request.callerLimits,
      });
      const policyFacts = (context.revision.contract?.actionPolicy?.matcherVersion ?? 1) === 2
        ? await policyFactsFor(request, context)
        : {};
      let classification = policyEngine.classify({
        action: prototype,
        actionPolicy: context.revision.contract?.actionPolicy || {},
        browserPolicy: context.revision.contract?.browserPolicy || {},
        facts: policyFacts,
      });
      if (context.run.context_snapshot?.routine) {
        const priorPage = await store.repositories.bot_action_attempts.list({
          filters: { run_id: context.run.id },
          limit: 100,
        });
        classification = guardBotRoutineAction({
          snapshot: context.run.context_snapshot.routine,
          request,
          classification,
          priorActions: priorPage.items,
        });
      }
      const quotaBinding = classification.matcherVersion === 2
        ? quotaBindingFor({ classification, context })
        : null;
      if (quotaBinding) classification = Object.freeze({ ...classification, quotaBinding });
      const policyExpiry = now().getTime() + classification.ttlSeconds * 1_000;
      const quotaExpiry = quotaBinding?.reservations?.length
        ? Math.min(...quotaBinding.reservations.map((reservation) => Date.parse(reservation.windowEnd)))
        : Number.POSITIVE_INFINITY;
      const expiresAt = new Date(Math.min(policyExpiry, quotaExpiry)).toISOString();
      const limits = effectiveLimits(request, classification, expiresAt);
      descriptor = actionDescriptor({ request, context, credentialScopeKey, limits });
      decision = policyEngine.bind(classification, descriptor);
      const persisted = await persistNewAction({
        actionId,
        request,
        context,
        descriptor,
        decision,
      });
      existing = persisted.row;
      createdAction = persisted.created;
      if (!persisted.created) {
        const persistedLimits = effectiveLimits(
          request,
          { operationKind: operationKindFromRow(existing) },
          existing.decision_expires_at,
        );
        descriptor = actionDescriptor({
          request,
          context,
          credentialScopeKey,
          limits: persistedLimits,
        });
        const candidateHash = `sha256:${hashCanonicalBotJson(descriptor)}`;
        if (candidateHash !== existing.action_hash
          || existing.credential_id !== request.credentialId) {
          fail(
            'Bot action idempotency key was already used for a different action',
            'bot_action_idempotency_conflict',
            409,
          );
        }
        decision = decisionFromRow(existing, descriptor);
      }
    }

    if (existing.state === 'proposed') {
      existing = await finalizeProposedAction(existing);
    }
    if (createdAction) {
      await publishAction('action.proposed', existing, context);
      await auditAction('bot.action.proposed', decision.effect === 'deny' ? 'denied' : 'success', existing, context, {
        operationKind: decision.operationKind,
        decisionExpiresAt: decision.expiresAt,
      });
    }

    if (existing.state === 'denied' || decision.effect === 'deny') {
      fail('Bot action policy denied this operation', 'bot_action_denied', 403);
    }
    if (existing.state === 'pending_approval') {
      await updateRunState(existing.run_id, 'waiting_approval').catch(() => undefined);
      await approvalService.notifyPending(existing);
      existing = await approvalService.waitForDecision(existing.id, { signal });
      if (existing?.state === 'denied') {
        fail('Bot action approval was denied', 'bot_action_denied', 403);
      }
      if (existing?.state !== 'approved') {
        fail('Bot action approval is required', 'bot_approval_required', 409);
      }
      decision = decisionFromRow(existing, descriptor);
    }
    if (existing.state === 'unknown') {
      fail('Bot action requires Operator reconciliation', 'bot_action_needs_reconciliation', 409);
    }
    if (existing.state === 'executing') {
      fail('Bot action is already executing', 'bot_action_in_progress', 409);
    }
    if (existing.state === 'waiting_control') {
      return executeApproved(existing, context, decision, request, descriptor, signal);
    }
    if (existing.state === 'succeeded') {
      const result = await withKey((key) => decryptResult(key, existing));
      return Object.freeze({
        action: publicBotActionAttempt(existing),
        receipt: publicReceipt(existing),
        result,
      });
    }
    if (existing.state === 'failed') {
      fail('Bot action execution failed', existing.execution_receipt?.failureCode || 'bot_action_failed', 409);
    }
    if (existing.state === 'reconciled') {
      fail('Bot action has already been reconciled', 'bot_action_reconciled', 409);
    }
    if (existing.state === 'cancelled') {
      fail('Bot action was cancelled with its run', 'bot_run_cancelled', 409);
    }
    if (existing.state !== 'approved') {
      fail('Bot action state is invalid', 'bot_action_state_invalid', 409);
    }
    return executeApproved(existing, context, decision, request, descriptor, signal);
  };

  return Object.freeze({
    handleGatewayOperation: handleAction,

    async getAction({ principal, actionAttemptId } = {}) {
      const row = await store.repositories.bot_action_attempts.get({
        id: validateUuid(actionAttemptId, 'actionAttemptId'),
      });
      if (!row) fail('Bot action was not found', 'bot_action_not_found', 404);
      const { membership } = await authorization.requireActiveMembership(principal, row.bot_id);
      if (row.initiated_by !== principal.id && !['operator', 'manager'].includes(membership.role)) {
        fail('Bot action access is forbidden', 'bot_action_forbidden', 403);
      }
      return Object.freeze({ action: publicBotActionAttempt(row), receipt: publicReceipt(row) });
    },

    async reconcile({ principal, actionAttemptId, request } = {}) {
      try {
        assertExactObject(request, {
          label: 'Bot action reconciliation',
          required: ['actionHash', 'revisionId', 'argsDigest', 'decision'],
        });
      } catch (error) {
        fail(error.message);
      }
      if (!RECONCILIATION_DECISIONS.has(request.decision)) {
        fail('Bot action reconciliation decision is invalid');
      }
      const actionHash = validateBoundedString(request.actionHash, 'actionHash', {
        maximum: 80,
        pattern: /^sha256:[0-9a-f]{64}$/,
      });
      const revisionId = validateUuid(request.revisionId, 'revisionId');
      const argsDigest = validateBoundedString(request.argsDigest, 'argsDigest', {
        maximum: 64,
        pattern: /^[0-9a-f]{64}$/,
      });
      let row = await store.repositories.bot_action_attempts.get({
        id: validateUuid(actionAttemptId, 'actionAttemptId'),
      });
      if (!row) fail('Bot action was not found', 'bot_action_not_found', 404);
      await authorization.requireOperator(principal, row.bot_id);
      if (row.state !== 'unknown' || row.unknown_outcome !== true) {
        fail('Bot action does not require reconciliation', 'bot_action_reconciliation_not_required', 409);
      }
      if (actionHash !== row.action_hash || revisionId !== row.revision_id
        || argsDigest !== row.args_digest) {
        fail('Reconciliation does not match the exact action', 'bot_action_binding_mismatch', 409);
      }
      const reconciledAt = now().toISOString();
      row = await updateAction(row, {
        state: 'reconciled',
        unknown_outcome: false,
        reconciliation_decision: request.decision,
        execution_receipt: {
          version: 1,
          operationKind: row.execution_receipt?.operationKind || 'write',
          nativeExactlyOnce: false,
          writeGuarantee: 'operator_reconciled',
          evidenceObjectIds: [...(row.execution_receipt?.evidenceObjectIds || [])],
          evidenceIncomplete: row.execution_receipt?.evidenceIncomplete === true,
          executedAt: row.execution_receipt?.executedAt || null,
          reconciledAt,
          reconciledBy: principal.id,
        },
        finished_at: row.finished_at || reconciledAt,
      });
      const retryIdempotencyKey = request.decision === 'retry_new'
        ? `retry:${row.id}:${crypto.randomBytes(12).toString('hex')}`
        : null;
      const run = await store.repositories.bot_runs.get({ id: row.run_id });
      let settledRun = run;
      if (run?.state === 'needs_reconciliation') {
        settledRun = await store.repositories.bot_runs.updateIfRevision(
          { id: run.id },
          {
            state: 'completed',
            reconciliation_state: {
              version: 1,
              decision: request.decision,
              actionAttemptId: row.id,
              reconciledBy: principal.id,
              reconciledAt,
              retryIdempotencyKey,
            },
            finished_at: run.finished_at || reconciledAt,
          },
          run.updated_at,
        );
      }
      if (settledRun?.state === 'completed') {
        await onRunSettled({ run: settledRun }).catch(() => undefined);
      }
      const context = await loadContext({
        botId: row.bot_id,
        runId: row.run_id,
        channelId: run?.channel_id,
        revisionId: row.revision_id,
      }).catch(async () => ({
        principal,
        channel: await store.repositories.bot_channels.get({ id: run?.channel_id }),
      }));
      if (context.channel) await publishAction('action.reconciled', row, context, {
        decision: request.decision,
        retryIdempotencyKey,
      });
      await audit({
        principal,
        botId: row.bot_id,
        targetType: 'bot_action_attempt',
        targetId: row.id,
        action: 'bot.action.reconciled',
        result: 'success',
        metadata: {
          runId: row.run_id,
          actionHash: row.action_hash,
          revisionId: row.revision_id,
          reconciliationDecision: request.decision,
          reconciledByUserId: principal.id,
          retryIdempotencyKey,
        },
      });
      return Object.freeze({
        action: publicBotActionAttempt(row),
        receipt: publicReceipt(row),
        retryIdempotencyKey,
        replayed: false,
      });
    },
  });
}
