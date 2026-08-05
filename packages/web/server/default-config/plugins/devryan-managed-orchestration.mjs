import crypto from 'node:crypto';

import { tool } from '@opencode-ai/plugin';

const ACTIONS = [
  'start',
  'status',
  'wait',
  'cancel',
  'continue',
  'retry',
  'resume',
  'abandon',
];
const RESULT_ACTIONS = new Set(['continue', 'retry', 'resume', 'abandon']);
const BARRIER_CONTROL_TOOLS = new Set(['devryan_task', 'skill', 'todowrite', 'todoread']);
const AGENT_OWNERSHIP_CACHE_MAX_ENTRIES = 128;
const AGENT_OWNERSHIP_CACHE_TTL_MS = 30_000;
const AGENT_OWNERSHIP_MESSAGE_LIMIT = 20;
const DEFAULT_TIMEOUT_SECONDS = 30 * 60;
const MIN_TIMEOUT_SECONDS = DEFAULT_TIMEOUT_SECONDS;
const ORACLE_MIN_TIMEOUT_SECONDS = 60 * 60;
const MAX_TIMEOUT_SECONDS = 24 * 60 * 60;
const WAIT_TIMEOUT_MS = 25_000;
const LIVE_TASK_STATUSES = new Set(['queued', 'starting', 'running']);
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'aborted', 'interrupted']);
const PROVIDER_RECOVERY_SCAN_DELAY_MS = 500;
const PROVIDER_RECOVERY_RETRY_DELAY_MS = 1_000;
// Child idle can lead the 750ms managed observer and durable terminal commit.
// Keep this window bounded so ordinary idle events never create a polling loop.
const PROVIDER_RECOVERY_SETTLE_RETRY_COUNT = 2;
const PROVIDER_RECOVERY_MESSAGE_LIMIT = 100;
const INVOCATION_POLICY_MESSAGE_LIMIT = 100;
const PLAN_MODE_INSTRUCTION_PREFIX = 'User has requested to enter plan mode';
const PROVIDER_RECOVERY_MARKER_VERSION = 'v1';
// A wake is only observable once its message is persisted and visible to
// session.messages. Until then the marker check cannot see it, so the in-flight
// guard alone let a settle-retry scan send the same wake a second time — which
// appended a duplicate part to the same messageID and could leave the parent
// with a user message it never answered. Track sent wakes for the process too.
const PROVIDER_RECOVERY_SENT_MAX_ENTRIES = 512;
// How long a trailing marker is treated as a wake that may still be starting.
const RECOVERY_CONTINUATION_STALE_MS = 60_000;

const resolveMinimumTimeoutSeconds = (agent) => (
  typeof agent === 'string' && agent.trim().toLowerCase() === 'oracle'
    ? ORACLE_MIN_TIMEOUT_SECONDS
    : MIN_TIMEOUT_SECONDS
);

const requireText = (value, field) => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new Error(`${field} is required for this managed task action`);
  return normalized;
};

const getBridge = () => {
  const rawUrl = process.env.DEVRYAN_ORCHESTRATION_URL;
  const token = process.env.DEVRYAN_ORCHESTRATION_TOKEN;
  if (!rawUrl || !token) {
    throw new Error('DevRyan managed orchestration bridge is unavailable in this runtime');
  }
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('DevRyan managed orchestration bridge URL is invalid');
  }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/rpc') {
    throw new Error('DevRyan managed orchestration bridge must use the private IPv4 loopback host');
  }
  return { url: url.toString(), token };
};

const buildIdempotencyKey = (context, action, args, dispatchCallId = null) => {
  const fingerprint = crypto.createHash('sha256')
    .update(JSON.stringify(dispatchCallId
      ? { action, args, dispatchCallId }
      : { action, args }))
    .digest('hex');
  return `tool:${context.sessionID}:${context.messageID || 'unknown'}:${fingerprint}`;
};

const fingerprintPendingStart = (args) => crypto.createHash('sha256')
  .update(JSON.stringify(args ?? null))
  .digest('hex');

const callRpc = async (method, params, { signal } = {}) => {
  const bridge = getBridge();
  const response = await fetch(bridge.url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bridge.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ method, params }),
    signal,
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.ok !== true) {
    const message = typeof body?.error?.message === 'string' && body.error.message.trim()
      ? body.error.message.trim()
      : `Managed orchestration RPC failed (${response.status})`;
    throw new Error(message);
  }
  return body.result;
};

const isRecord = (value) => (
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
);

const unwrapResponseData = (response) => (
  response && typeof response === 'object' && 'data' in response
    ? response.data
    : response
);

const isPlanModeUserRecord = (record) => {
  if (record?.info?.role !== 'user') return false;
  const mode = typeof record.info.mode === 'string'
    ? record.info.mode.trim().toLowerCase()
    : '';
  if (mode === 'plan' || record.info.metadata?.openchamberPlanMode === true) return true;
  return Array.isArray(record.parts) && record.parts.some((part) => (
    part?.type === 'text'
    && part.synthetic === true
    && typeof part.text === 'string'
    && part.text.trim().startsWith(PLAN_MODE_INSTRUCTION_PREFIX)
  ));
};

const resolveInvocationReadOnly = async (context, client) => {
  if (!client?.session || typeof client.session.messages !== 'function') return false;
  const rootSessionId = requireText(context.sessionID, 'context.sessionID');
  const messageId = requireText(context.messageID, 'context.messageID');
  const directory = requireText(context.directory, 'context.directory');
  let response;
  try {
    response = await client.session.messages({
      path: { id: rootSessionId },
      query: { directory, limit: INVOCATION_POLICY_MESSAGE_LIMIT },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot verify parent plan-mode policy before managed dispatch: ${message}`);
  }
  if (response?.error) {
    throw new Error('Cannot verify parent plan-mode policy before managed dispatch');
  }
  const records = unwrapResponseData(response);
  if (!Array.isArray(records)) {
    throw new Error('Cannot verify parent plan-mode policy before managed dispatch');
  }
  const assistant = records.find((record) => (
    record?.info?.role === 'assistant' && record.info.id === messageId
  ));
  const parentId = typeof assistant?.info?.parentID === 'string'
    ? assistant.info.parentID.trim()
    : '';
  if (!parentId) {
    throw new Error('Cannot verify the parent turn for managed dispatch');
  }
  const parent = records.find((record) => (
    record?.info?.role === 'user' && record.info.id === parentId
  ));
  if (!parent) {
    throw new Error('Cannot verify the parent turn for managed dispatch');
  }
  return isPlanModeUserRecord(parent);
};

const DUPLICATE_RESULT_PAYLOAD_FIELDS = [
  'failureReason',
  'recoverablePreview',
  'canonicalRefs',
];

const haveEqualResultPayloadField = (task, envelope, field) => {
  if (
    !Object.prototype.hasOwnProperty.call(task, field)
    || !Object.prototype.hasOwnProperty.call(envelope, field)
  ) {
    return false;
  }
  if (field === 'canonicalRefs') {
    return JSON.stringify(task[field]) === JSON.stringify(envelope[field]);
  }
  return Object.is(task[field], envelope[field]);
};

const compactManagedTaskToolResult = (value) => {
  if (!isRecord(value)) return value;

  let compacted = value;
  const patch = (field, nextValue) => {
    if (compacted === value) compacted = { ...value };
    compacted[field] = nextValue;
  };

  if (isRecord(value.task) && isRecord(value.resultEnvelope)) {
    const taskId = typeof value.task.taskId === 'string' ? value.task.taskId : '';
    if (taskId && taskId === value.resultEnvelope.taskId) {
      let task = value.task;
      for (const field of DUPLICATE_RESULT_PAYLOAD_FIELDS) {
        if (!haveEqualResultPayloadField(value.task, value.resultEnvelope, field)) continue;
        if (task === value.task) task = { ...value.task };
        delete task[field];
      }
      if (task !== value.task) patch('task', task);
    }
  }

  if (Array.isArray(value.tasks)) {
    const tasks = value.tasks.map(compactManagedTaskToolResult);
    if (tasks.some((task, index) => task !== value.tasks[index])) patch('tasks', tasks);
  }

  if (isRecord(value.followUpTask)) {
    const followUpTask = compactManagedTaskToolResult(value.followUpTask);
    if (followUpTask !== value.followUpTask) patch('followUpTask', followUpTask);
  }

  return compacted;
};

const buildScopedParams = (args, context) => ({
  taskId: requireText(args.task_id, 'task_id'),
  rootSessionId: requireText(context.sessionID, 'context.sessionID'),
  directory: requireText(context.directory, 'context.directory'),
});

const resolveConfiguredAgentExecution = async (args, context, client) => {
  if (!client?.app || typeof client.app.agents !== 'function') {
    return { catalogAvailable: false, execution: null };
  }
  const response = await client.app.agents({
    query: { directory: requireText(context.directory, 'context.directory') },
  });
  if (response?.error) {
    throw new Error('Failed to resolve the managed agent model');
  }
  const agents = Array.isArray(response?.data) ? response.data : [];
  const agentName = requireText(args.agent, 'agent');
  const agent = agents.find((entry) => entry?.name === agentName);
  const providerId = typeof agent?.model?.providerID === 'string'
    ? agent.model.providerID.trim()
    : '';
  const modelId = typeof agent?.model?.modelID === 'string'
    ? agent.model.modelID.trim()
    : '';
  if (!providerId || !modelId) {
    return { catalogAvailable: true, execution: null };
  }
  return {
    catalogAvailable: true,
    execution: {
      providerId,
      modelId,
      variant: typeof agent.variant === 'string' && agent.variant.trim() ? agent.variant.trim() : null,
    },
  };
};

const resolveStartExecution = async (args, context, client) => {
  const agentName = requireText(args.agent, 'agent');
  const configured = await resolveConfiguredAgentExecution(args, context, client);
  if (configured.catalogAvailable) {
    if (configured.execution) return configured.execution;
    throw new Error(`Managed agent ${agentName} has no executable model`);
  }

  const providerId = typeof args.provider_id === 'string' ? args.provider_id.trim() : '';
  const modelId = typeof args.model_id === 'string' ? args.model_id.trim() : '';
  if (Boolean(providerId) !== Boolean(modelId)) {
    throw new Error('provider_id and model_id must be supplied together');
  }
  if (providerId && modelId) {
    return {
      providerId,
      modelId,
      variant: typeof args.variant === 'string' && args.variant.trim() ? args.variant.trim() : null,
    };
  }
  throw new Error(`Managed agent ${agentName} has no executable model`);
};

const requiresManualModelRecovery = (result) => {
  const task = result?.task;
  const resultEnvelope = result?.resultEnvelope;
  return Boolean(
    isRecord(task)
    && isRecord(resultEnvelope)
    && task.childSessionId
    && task.agentRetryAvailable === false
    && (task.status === 'failed' || task.status === 'interrupted')
    && (
      task.failureKind === 'provider_usage_limit'
      || (task.mode === 'orchestrator' && Number(task.attempt) >= 2)
    )
    && resultEnvelope.resumable === true
    && resultEnvelope.action === null
  );
};

const waitForTerminalTask = async (taskId, scoped, signal, initialResult) => {
  const expectedTaskId = requireText(taskId, 'wait task_id');
  let result = initialResult;
  while (true) {
    if (result !== undefined) {
      if (!isRecord(result?.task)) {
        throw new Error('Managed task wait returned a malformed task');
      }
      const resultTaskId = requireText(result.task.taskId, 'wait result task_id');
      if (resultTaskId !== expectedTaskId) {
        throw new Error(
          `Managed task wait returned task ${resultTaskId} while waiting for ${expectedTaskId}`,
        );
      }
      const status = typeof result.task.status === 'string' ? result.task.status : '';
      if (TERMINAL_TASK_STATUSES.has(status)) return result;
      if (!LIVE_TASK_STATUSES.has(status)) {
        throw new Error(
          `Managed task wait returned an invalid task status${status ? `: ${status}` : ''}`,
        );
      }
    }

    if (signal?.aborted) throw signal.reason ?? new Error('Managed task wait aborted');
    result = await callRpc('wait', {
      ...scoped,
      taskId: expectedTaskId,
      waitTimeoutMs: WAIT_TIMEOUT_MS,
    }, { signal });
  }
};

const waitThroughManualModelRecovery = async (initialResult, scoped, signal) => {
  let result = initialResult;
  while (requiresManualModelRecovery(result)) {
    const recovery = await callRpc('wait_result_action', {
      ...scoped,
      taskId: requireText(result.task.taskId, 'recovery task_id'),
    }, { signal });
    if (
      recovery?.resultEnvelope?.action !== 'retry_in_place'
      || !isRecord(recovery.followUpTask?.task)
    ) {
      throw new Error('Manual model recovery ended without a retry-in-place follow-up');
    }

    const followUpTaskId = requireText(recovery.followUpTask.task.taskId, 'recovery task_id');
    result = await waitForTerminalTask(
      followUpTaskId,
      scoped,
      signal,
      recovery.followUpTask,
    );
  }
  return result;
};

const executeAction = async (args, context, client, dispatchCallId = null) => {
  const action = requireText(args.action, 'action');
  if (!ACTIONS.includes(action)) throw new Error(`Unsupported managed task action: ${action}`);

  if (action === 'start') {
    const agent = requireText(args.agent, 'agent');
    const minimumTimeoutSeconds = resolveMinimumTimeoutSeconds(agent);
    const timeoutSeconds = Number.isFinite(args.timeout_seconds)
      ? Math.min(MAX_TIMEOUT_SECONDS, Math.max(minimumTimeoutSeconds, Math.trunc(args.timeout_seconds)))
      : minimumTimeoutSeconds;
    const execution = await resolveStartExecution(args, context, client);
    const readOnly = await resolveInvocationReadOnly(context, client);
    const normalizedArgs = {
      action,
      label: typeof args.label === 'string' ? args.label.trim() : '',
      prompt: requireText(args.prompt, 'prompt'),
      providerId: execution.providerId,
      modelId: execution.modelId,
      agent,
      variant: execution.variant,
      timeoutSeconds,
    };
    return await callRpc('submit', {
      idempotencyKey: buildIdempotencyKey(context, action, normalizedArgs, dispatchCallId),
      rootSessionId: requireText(context.sessionID, 'context.sessionID'),
      dispatchGroupId: context.agent === 'builder'
        ? null
        : requireText(context.messageID, 'context.messageID'),
      dispatchCallId,
      parentTaskId: null,
      directory: requireText(context.directory, 'context.directory'),
      mode: context.agent === 'builder' ? 'builder' : 'orchestrator',
      readOnly,
      providerId: normalizedArgs.providerId,
      modelId: normalizedArgs.modelId,
      agent,
      variant: normalizedArgs.variant,
      label: normalizedArgs.label || `Managed ${agent} task`,
      prompt: normalizedArgs.prompt,
      timeoutAt: Date.now() + timeoutSeconds * 1_000,
    }, { signal: context.abort });
  }

  const scoped = buildScopedParams(args, context);
  if (action === 'status') {
    return await callRpc(action, scoped, { signal: context.abort });
  }
  if (action === 'wait') {
    const result = await waitForTerminalTask(scoped.taskId, scoped, context.abort);
    return await waitThroughManualModelRecovery(result, scoped, context.abort);
  }
  if (action === 'cancel') {
    return await callRpc('cancel', {
      ...scoped,
      cascade: args.cascade === true,
      ...(typeof args.reason === 'string' && args.reason.trim()
        ? { reason: args.reason.trim() }
        : {}),
    }, { signal: context.abort });
  }
  if (RESULT_ACTIONS.has(action)) {
    const normalizedOverrides = {
      providerId: typeof args.provider_id === 'string' ? args.provider_id.trim() : '',
      modelId: typeof args.model_id === 'string' ? args.model_id.trim() : '',
      agent: typeof args.agent === 'string' ? args.agent.trim() : '',
      variant: typeof args.variant === 'string' && args.variant.trim() ? args.variant.trim() : null,
      label: typeof args.label === 'string' ? args.label.trim() : '',
      prompt: typeof args.prompt === 'string' ? args.prompt.trim() : '',
    };
    const configuredResolution = normalizedOverrides.agent
      ? await resolveConfiguredAgentExecution({ agent: normalizedOverrides.agent }, context, client)
      : null;
    if (configuredResolution?.catalogAvailable && !configuredResolution.execution) {
      throw new Error(`Managed agent ${normalizedOverrides.agent} has no executable model`);
    }
    const configured = configuredResolution?.execution ?? null;
    if (configured) {
      normalizedOverrides.providerId = configured.providerId;
      normalizedOverrides.modelId = configured.modelId;
      normalizedOverrides.variant = configured.variant;
    } else if (
      Boolean(normalizedOverrides.providerId) !== Boolean(normalizedOverrides.modelId)
    ) {
      throw new Error('provider_id and model_id must be supplied together');
    }
    return await callRpc('acknowledge', {
      ...scoped,
      action,
      idempotencyKey: buildIdempotencyKey(context, action, {
        taskId: scoped.taskId,
        ...normalizedOverrides,
      }),
      ...(normalizedOverrides.providerId ? { providerId: normalizedOverrides.providerId } : {}),
      ...(normalizedOverrides.modelId ? { modelId: normalizedOverrides.modelId } : {}),
      ...(normalizedOverrides.agent ? { agent: normalizedOverrides.agent } : {}),
      ...(configured || args.variant !== undefined ? { variant: normalizedOverrides.variant } : {}),
      ...(normalizedOverrides.label ? { label: normalizedOverrides.label } : {}),
      ...(normalizedOverrides.prompt ? { prompt: normalizedOverrides.prompt } : {}),
    }, { signal: context.abort });
  }

  throw new Error(`Unsupported managed task action: ${action}`);
};

export const DevRyanManagedOrchestrationPlugin = async ({
  client,
  scheduleTimeout = globalThis.setTimeout,
} = {}) => {
  const sessionStates = new Map();
  const pendingStartsByArgs = new WeakMap();
  const agentOwnershipCache = new Map();
  const recoveryContinuationsInFlight = new Set();
  const recoveryContinuationsSent = new Set();
  let recoveryScanPromise = null;
  let recoveryScanTimer = null;
  let recoveryScanRequested = false;
  let recoverySettleRetriesRemaining = 0;

  const canResumeRecoveredParents = Boolean(
    client?.session
    && typeof client.session.messages === 'function'
    && typeof client.session.promptAsync === 'function'
    && typeof client.session.status === 'function',
  );

  const logRecovery = (event, details = {}) => {
    console.error(JSON.stringify({
      plugin: 'devryan-managed-orchestration',
      event,
      ...details,
    }));
  };

  const readSessionMessages = async (sessionId, directory) => {
    const response = await client.session.messages({
      path: { id: sessionId },
      query: {
        directory,
        limit: PROVIDER_RECOVERY_MESSAGE_LIMIT,
      },
    });
    if (response?.error) {
      throw new Error('Failed to read the parent session before provider-recovery continuation');
    }
    const records = unwrapResponseData(response);
    return Array.isArray(records) ? records : [];
  };

  const isSessionIdle = async (sessionId, directory) => {
    const response = await client.session.status({
      query: { directory },
    });
    if (response?.error) {
      throw new Error('Failed to read the parent session status before provider-recovery continuation');
    }
    const statuses = unwrapResponseData(response);
    const status = isRecord(statuses) && isRecord(statuses[sessionId])
      ? statuses[sessionId]
      : null;
    const type = typeof status?.type === 'string' ? status.type.trim().toLowerCase() : '';
    return !type || type === 'idle';
  };

  const buildRecoveryContinuationMarker = (taskId) => (
    `[devryan-provider-recovery:${PROVIDER_RECOVERY_MARKER_VERSION}:${taskId}]`
  );

  // The LAST occurrence is the one that matters. An earlier wake that was never
  // answered is itself followed by its own retry, so searching forwards would
  // see a later record and wrongly conclude the wake had been handled.
  const findRecoveryContinuationMarkerIndex = (records, marker) => {
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index];
      if (
        Array.isArray(record?.parts)
        && record.parts.some((part) => (
          part?.type === 'text'
          && typeof part.text === 'string'
          && part.text.includes(marker)
        ))
      ) {
        return index;
      }
    }
    return -1;
  };

  /**
   * Decide whether a marker already in the transcript means this wake is done.
   *
   * A marker with a later record is a wake the parent answered. A marker that is
   * still the final record is a wake that never produced a turn, which leaves the
   * parent idle forever; once it is old enough that no run is plausibly starting,
   * it is re-sent. `recoveryContinuationsSent` bounds that to one retry per
   * process, so a genuinely unanswerable wake cannot loop.
   */
  const isRecoveryContinuationSettled = (records, marker) => {
    const index = findRecoveryContinuationMarkerIndex(records, marker);
    if (index < 0) return false;
    if (index < records.length - 1) return true;
    const createdAt = records[index]?.info?.time?.created;
    if (!Number.isFinite(createdAt)) return true;
    return Date.now() - createdAt < RECOVERY_CONTINUATION_STALE_MS;
  };

  const rememberRecoveryContinuationSent = (taskId) => {
    recoveryContinuationsSent.add(taskId);
    while (recoveryContinuationsSent.size > PROVIDER_RECOVERY_SENT_MAX_ENTRIES) {
      recoveryContinuationsSent.delete(recoveryContinuationsSent.values().next().value);
    }
  };

  const resolveParentContinuationExecution = async (records, directory) => {
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const info = records[index]?.info;
      if (info?.role !== 'user') continue;
      const providerId = typeof info.model?.providerID === 'string'
        ? info.model.providerID.trim()
        : '';
      const modelId = typeof info.model?.modelID === 'string'
        ? info.model.modelID.trim()
        : '';
      if (!providerId || !modelId) continue;
      const agent = typeof info.agent === 'string' && info.agent.trim()
        ? info.agent.trim()
        : typeof info.mode === 'string' && info.mode.trim()
          ? info.mode.trim()
          : 'orchestrator';
      const variantCandidate = info.model?.variant ?? info.variant;
      return {
        agent,
        providerId,
        modelId,
        variant: typeof variantCandidate === 'string' && variantCandidate.trim()
          ? variantCandidate.trim()
          : null,
      };
    }

    const configured = await resolveConfiguredAgentExecution(
      { agent: 'orchestrator' },
      { directory },
      client,
    );
    return configured.execution
      ? { agent: 'orchestrator', ...configured.execution }
      : null;
  };

  const requestRecoveredParentContinuation = async (continuation) => {
    if (!isRecord(continuation)) return false;
    const taskId = typeof continuation.taskId === 'string' ? continuation.taskId.trim() : '';
    const rootSessionId = typeof continuation.rootSessionId === 'string'
      ? continuation.rootSessionId.trim()
      : '';
    const directory = typeof continuation.directory === 'string'
      ? continuation.directory.trim()
      : '';
    if (
      !taskId
      || !rootSessionId
      || !directory
      || recoveryContinuationsInFlight.has(taskId)
      || recoveryContinuationsSent.has(taskId)
    ) {
      return false;
    }

    recoveryContinuationsInFlight.add(taskId);
    try {
      if (!await isSessionIdle(rootSessionId, directory)) return false;

      const records = await readSessionMessages(rootSessionId, directory);
      const marker = buildRecoveryContinuationMarker(taskId);
      if (isRecoveryContinuationSettled(records, marker)) {
        rememberRecoveryContinuationSent(taskId);
        return false;
      }
      const execution = await resolveParentContinuationExecution(records, directory);
      if (!execution) {
        throw new Error('Parent model selection is unavailable for provider-recovery continuation');
      }
      if (!await isSessionIdle(rootSessionId, directory)) return false;

      // Deliberately no explicit messageID. OpenCode message IDs are ordered,
      // and it processes the turn only when the incoming user message sorts
      // after the session's latest message. A content-derived id (this used to
      // be a sha256 slice) sorts arbitrarily, so roughly whenever it landed
      // below the last assistant id the wake was written "into the past":
      // OpenCode logged `loop step=0` then `exiting loop` without ever running,
      // leaving the parent idle forever holding an unanswered message. Letting
      // OpenCode mint the id keeps it ordered; the marker plus
      // `recoveryContinuationsSent` already provide the de-duplication the
      // fixed id was there for.
      const prompt = [
        marker,
        `A DevRyan-managed sub-agent reached a terminal result that this turn never collected,`,
        `because the parent wait detached, timed out, or the child settled after recovery.`,
        `Call devryan_task with action "wait" and task_id "${taskId}" now.`,
        'Disposition that terminal result according to the managed-task rules, then continue from the first incomplete todo.',
        'Do not start a replacement delegation or repeat work already completed by the recovered child.',
      ].join(' ');
      const response = await client.session.promptAsync({
        path: { id: rootSessionId },
        query: { directory },
        body: {
          agent: execution.agent,
          model: {
            providerID: execution.providerId,
            modelID: execution.modelId,
          },
          ...(execution.variant ? { variant: execution.variant } : {}),
          parts: [{ type: 'text', text: prompt, synthetic: true }],
        },
      }, { throwOnError: false });
      if (response?.error) {
        const message = typeof response.error?.message === 'string' && response.error.message.trim()
          ? response.error.message.trim()
          : 'promptAsync returned an error';
        throw new Error(message);
      }
      rememberRecoveryContinuationSent(taskId);
      logRecovery('recovered-parent-continued', { rootSessionId, taskId });
      return true;
    } finally {
      recoveryContinuationsInFlight.delete(taskId);
    }
  };

  const scheduleRecoveryScan = ({
    delayMs = PROVIDER_RECOVERY_SCAN_DELAY_MS,
    settleRetries = 0,
  } = {}) => {
    if (!canResumeRecoveredParents) return;
    recoverySettleRetriesRemaining = Math.max(
      recoverySettleRetriesRemaining,
      settleRetries,
    );
    if (recoveryScanTimer || recoveryScanPromise) {
      recoveryScanRequested = true;
      return;
    }
    recoveryScanTimer = scheduleTimeout(() => {
      recoveryScanTimer = null;
      recoveryScanRequested = false;
      recoveryScanPromise = (async () => {
        let retryNeeded = false;
        try {
          const result = await callRpc('list_provider_recovery_continuations', {});
          const continuations = Array.isArray(result?.continuations) ? result.continuations : [];
          for (const continuation of continuations) {
            try {
              await requestRecoveredParentContinuation(continuation);
            } catch (error) {
              retryNeeded = true;
              logRecovery('recovered-parent-continuation-failed', {
                taskId: typeof continuation?.taskId === 'string' ? continuation.taskId : null,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          }
        } catch (error) {
          retryNeeded = true;
          logRecovery('provider-recovery-scan-failed', {
            message: error instanceof Error ? error.message : String(error),
          });
        } finally {
          recoveryScanPromise = null;
          const trailingScanRequested = recoveryScanRequested;
          recoveryScanRequested = false;
          const settleRetryNeeded = !retryNeeded && recoverySettleRetriesRemaining > 0;
          if (settleRetryNeeded) recoverySettleRetriesRemaining -= 1;
          if (retryNeeded || trailingScanRequested || settleRetryNeeded) {
            scheduleRecoveryScan({ delayMs: PROVIDER_RECOVERY_RETRY_DELAY_MS });
          }
        }
      })();
    }, delayMs);
    recoveryScanTimer?.unref?.();
  };

  const readInvokingAgent = async (rootSessionId, callID) => {
    if (!client?.session || typeof client.session.messages !== 'function') return null;
    let response;
    try {
      response = await client.session.messages({
        path: { id: rootSessionId },
        query: { limit: AGENT_OWNERSHIP_MESSAGE_LIMIT },
      });
    } catch {
      return null;
    }
    if (response?.error) return null;
    const records = Array.isArray(response?.data)
      ? response.data
      : Array.isArray(response)
        ? response
        : [];
    const assistantRecord = records.find((record) => (
      record?.info?.role === 'assistant'
      && Array.isArray(record.parts)
      && record.parts.some((part) => (
        part?.type === 'tool'
        && part.callID === callID
      ))
    ));
    if (!assistantRecord) return null;

    const directAgent = typeof assistantRecord.info.agent === 'string'
      ? assistantRecord.info.agent.trim().toLowerCase()
      : '';
    if (directAgent) return directAgent;
    const directMode = typeof assistantRecord.info.mode === 'string'
      ? assistantRecord.info.mode.trim().toLowerCase()
      : '';
    if (directMode === 'builder' || directMode === 'orchestrator') return directMode;

    const parentID = typeof assistantRecord.info.parentID === 'string'
      ? assistantRecord.info.parentID
      : '';
    const parent = parentID
      ? records.find((record) => record?.info?.role === 'user' && record.info.id === parentID)
      : null;
    const parentAgent = typeof parent?.info?.agent === 'string'
      ? parent.info.agent.trim().toLowerCase()
      : '';
    return parentAgent || null;
  };

  const resolveInvokingAgent = async (rootSessionId, callID) => {
    const normalizedCallID = requireText(callID, 'callID');
    const cacheKey = `${rootSessionId}\u0000${normalizedCallID}`;
    const cached = agentOwnershipCache.get(cacheKey);
    const currentTime = Date.now();
    if (cached && cached.expiresAt > currentTime) {
      agentOwnershipCache.delete(cacheKey);
      agentOwnershipCache.set(cacheKey, cached);
      return await cached.promise;
    }
    if (cached) agentOwnershipCache.delete(cacheKey);

    const promise = readInvokingAgent(rootSessionId, normalizedCallID);
    agentOwnershipCache.set(cacheKey, {
      expiresAt: currentTime + AGENT_OWNERSHIP_CACHE_TTL_MS,
      promise,
    });
    while (agentOwnershipCache.size > AGENT_OWNERSHIP_CACHE_MAX_ENTRIES) {
      const oldestKey = agentOwnershipCache.keys().next().value;
      agentOwnershipCache.delete(oldestKey);
    }
    const agent = await promise;
    if (!agent) agentOwnershipCache.delete(cacheKey);
    return agent;
  };

  const requireInvokingAgent = async (rootSessionId, callID) => {
    const agent = await resolveInvokingAgent(rootSessionId, callID);
    if (agent) return agent;
    throw new Error(
      'Parent work is blocked because DevRyan cannot establish invoking agent ownership for this tool call',
    );
  };

  const getSessionState = (rootSessionId) => {
    const key = requireText(rootSessionId, 'sessionID');
    let state = sessionStates.get(key);
    if (!state) {
      state = {
        collectedResults: new Map(),
        knownBarrier: false,
        pendingStarts: [],
      };
      sessionStates.set(key, state);
    }
    return state;
  };

  const registerPendingStart = (rootSessionId, callID, args) => {
    const state = getSessionState(rootSessionId);
    const normalizedCallID = requireText(callID, 'callID');
    let resolve;
    const entry = {
      callID: normalizedCallID,
      args: isRecord(args) ? args : null,
      fingerprint: fingerprintPendingStart(args),
      claimed: false,
      settled: false,
      promise: new Promise((resolvePromise) => { resolve = resolvePromise; }),
      settle() {
        if (entry.settled) return;
        entry.settled = true;
        const index = state.pendingStarts.indexOf(entry);
        if (index >= 0) state.pendingStarts.splice(index, 1);
        if (entry.args) pendingStartsByArgs.delete(entry.args);
        resolve();
      },
    };
    state.pendingStarts.push(entry);
    if (entry.args) pendingStartsByArgs.set(entry.args, entry);
  };

  const claimPendingStart = (rootSessionId, args) => {
    const state = getSessionState(rootSessionId);
    const exactEntry = isRecord(args) ? pendingStartsByArgs.get(args) : null;
    const entry = exactEntry && state.pendingStarts.includes(exactEntry) && !exactEntry.claimed
      ? exactEntry
      : state.pendingStarts.find((candidate) => (
        !candidate.claimed && candidate.fingerprint === fingerprintPendingStart(args)
      )) ?? state.pendingStarts.find((candidate) => !candidate.claimed);
    if (entry) entry.claimed = true;
    return entry ?? null;
  };

  const drainPendingStarts = async (state) => {
    while (state.pendingStarts.length > 0) {
      await Promise.all(state.pendingStarts.map((entry) => entry.promise));
    }
  };

  const handleEvent = ({ event } = {}) => {
    if (event?.type === 'session.idle') {
      const rootSessionId = typeof event.properties?.sessionID === 'string'
        ? event.properties.sessionID.trim()
        : '';
      const state = rootSessionId ? sessionStates.get(rootSessionId) : null;
      if (state) {
        for (const entry of [...state.pendingStarts]) entry.settle();
      }
      scheduleRecoveryScan({
        settleRetries: PROVIDER_RECOVERY_SETTLE_RETRY_COUNT,
      });
      return;
    }
    if (event?.type === 'session.error') {
      scheduleRecoveryScan({
        settleRetries: PROVIDER_RECOVERY_SETTLE_RETRY_COUNT,
      });
    }
  };

  const beforeToolExecute = async (input, output) => {
    const rootSessionId = requireText(input?.sessionID, 'sessionID');
    const toolName = requireText(input?.tool, 'tool');
    if (toolName === 'devryan_task') {
      if (output?.args?.action === 'start') {
        registerPendingStart(rootSessionId, input?.callID, output.args);
      }
      return;
    }
    if (toolName === 'task') {
      const invokingAgent = await requireInvokingAgent(rootSessionId, input?.callID);
      if (invokingAgent === 'orchestrator') {
        throw new Error('Orchestrator delegation must use devryan_task; provider-native task is disabled');
      }
      return;
    }
    if (BARRIER_CONTROL_TOOLS.has(toolName)) return;

    const state = getSessionState(rootSessionId);
    await drainPendingStarts(state);
    let invokingAgent = null;
    if (state.knownBarrier) {
      invokingAgent = await requireInvokingAgent(rootSessionId, input?.callID);
      if (invokingAgent === 'builder') return;
    }
    let barrier;
    try {
      barrier = await callRpc('barrier_status', { rootSessionId });
    } catch (error) {
      if (!state.knownBarrier) return;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Parent work cannot verify the dispatch barrier and remains blocked: ${message}`);
    }

    if (barrier?.state === 'clear') {
      state.knownBarrier = false;
      return;
    }
    if (barrier?.state === 'active' || barrier?.state === 'awaiting_acknowledgement') {
      state.knownBarrier = true;
      invokingAgent ??= await requireInvokingAgent(rootSessionId, input?.callID);
      if (invokingAgent === 'builder') return;
      const taskIds = Array.isArray(barrier.taskIds) ? barrier.taskIds.join(', ') : '';
      if (barrier.state === 'active') {
        throw new Error(
          `Parent work is blocked by active managed tasks${taskIds ? `: ${taskIds}` : ''}. `
          + 'Use devryan_task wait for each task before continuing parent work.',
        );
      }
      throw new Error(
        `Parent work is blocked by managed task results${taskIds ? `: ${taskIds}` : ''}. `
        + 'Use devryan_task wait for each result, then continue, retry, resume, or abandon it.',
      );
    }
    if (!state.knownBarrier) return;
    throw new Error('Parent work cannot verify the dispatch barrier and remains blocked');
  };

  scheduleRecoveryScan();

  return {
    event: handleEvent,
    'tool.execute.before': beforeToolExecute,
    tool: {
      devryan_task: tool({
      description: 'Start or control a DevRyan-managed sub-agent. When managed delegation is already the decided next action, start it before any standalone todo read/write whose only purpose is to restate that delegation. DevRyan does not impose a managed concurrency cap: start every independent sub-agent needed by the task without batching around an artificial slot limit. DevRyan preserves partial results after failure or abort. DevRyan keeps each wait call attached while repeating bounded polling slices internally; wait returns only a terminal result, and status is the non-blocking way to inspect queued, starting, or running state. A resumable failure with no agent retry remaining leaves a durable pending result while the user selects a recovery model; the attached wait returns the recovered same-child result, or DevRyan wakes the idle parent if an external timeout detached that wait. This is distinct from provider-native task orchestration.',
      args: {
        action: tool.schema.enum(ACTIONS).describe('Action: start, status, wait, cancel, continue, retry, resume, or abandon. A resumable failure with no agent retry remaining is handled by the user-facing Model Recovery controls while the durable result remains pending; an attached wait resumes directly, while a detached wait is recovered by an idle-parent continuation. Wait stays attached until terminal while DevRyan polls internally; use status for a non-blocking live snapshot.'),
        task_id: tool.schema.string().optional().describe('Managed dvr_task_ ID. Required for every action except start.'),
        label: tool.schema.string().optional().describe('Short task label for start or retry.'),
        prompt: tool.schema.string().optional().describe('Full delegated prompt for start, or an optional retry override.'),
        provider_id: tool.schema.string().optional().describe('Compatibility fallback provider ID when no runtime agent catalog is available. Supply together with model_id; configured agent settings are authoritative.'),
        model_id: tool.schema.string().optional().describe('Compatibility fallback model ID when no runtime agent catalog is available. Supply together with provider_id; configured agent settings are authoritative.'),
        agent: tool.schema.string().optional().describe('Agent name for start or an optional retry/resume override.'),
        variant: tool.schema.string().optional().describe('Optional compatibility fallback variant. The configured agent variant is authoritative when the runtime catalog is available.'),
        timeout_seconds: tool.schema.number().int().min(MIN_TIMEOUT_SECONDS).max(MAX_TIMEOUT_SECONDS).optional().describe('Start timeout in seconds. Defaults to 1800, with an enforced 3600 minimum for Oracle; use at least 3600 for multi-file implementation plus tests and 7200 when the child also owns builds or browser verification.'),
        cascade: tool.schema.boolean().optional().describe('For cancel only: also cancel explicit managed descendants.'),
        reason: tool.schema.string().optional().describe('Optional cancellation reason.'),
      },
      async execute(args, context) {
        const action = requireText(args.action, 'action');
        const state = getSessionState(context.sessionID);
        const pendingStart = action === 'start' ? claimPendingStart(context.sessionID, args) : null;
        const contextCallID = typeof context.callID === 'string' ? context.callID.trim() : '';
        const dispatchCallId = action === 'start'
          ? contextCallID || pendingStart?.callID || null
          : null;
        try {
          if (RESULT_ACTIONS.has(action)) {
            const taskId = requireText(args.task_id, 'task_id');
            const collected = state.collectedResults.get(taskId);
            if (!collected) {
              throw new Error(`Use devryan_task wait for ${taskId} before ${action}`);
            }
            if (collected.status === 'completed' && action !== 'continue') {
              throw new Error(`The successful result requires continue after wait: ${taskId}`);
            }
            if (requiresManualModelRecovery(collected)) {
              throw new Error('Manual model recovery requires the user-facing Model Recovery controls; leave this result unacknowledged');
            }
          }
          const result = await executeAction(
            { ...args, action },
            context,
            client,
            dispatchCallId,
          );
          if (action === 'start' && context.agent !== 'builder') state.knownBarrier = true;
          if (action === 'wait') {
            const requestedTaskId = requireText(args.task_id, 'task_id');
            const status = typeof result?.task?.status === 'string' ? result.task.status : null;
            const resultTaskId = typeof result?.task?.taskId === 'string'
              ? result.task.taskId.trim()
              : '';
            state.collectedResults.delete(requestedTaskId);
            if (TERMINAL_TASK_STATUSES.has(status)) {
              if (!resultTaskId) throw new Error('Managed task wait returned a terminal result without a task ID');
              state.collectedResults.set(resultTaskId, {
                status,
                task: result.task,
                resultEnvelope: result.resultEnvelope,
              });
            }
          }
          return JSON.stringify(compactManagedTaskToolResult(result), null, 2);
        } finally {
          pendingStart?.settle();
        }
      },
      }),
    },
  };
};

export default DevRyanManagedOrchestrationPlugin;
