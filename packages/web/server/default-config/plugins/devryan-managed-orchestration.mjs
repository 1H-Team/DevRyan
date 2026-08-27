import crypto from 'node:crypto';

import { tool } from '@opencode-ai/plugin';

const ACTIONS = [
  'start',
  'status',
  'wait',
  'read_result',
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
const MIN_TIMEOUT_SECONDS = 15 * 60;
const DESIGNER_MIN_TIMEOUT_SECONDS = 60 * 60;
const FIXER_MIN_TIMEOUT_SECONDS = 60 * 60;
const ORACLE_MIN_TIMEOUT_SECONDS = 15 * 60;
const MAX_TIMEOUT_SECONDS = 24 * 60 * 60;
const WAIT_TIMEOUT_MS = 25_000;
const RESULT_PAGE_MAX_BYTES = 8 * 1024;
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
const MANAGED_READ_ONLY_AGENT_UNSUPPORTED = 'MANAGED_READ_ONLY_AGENT_UNSUPPORTED';
const MANAGED_READ_ONLY_AGENT_UNSUPPORTED_MESSAGE = 'Designer is implementation-only and cannot be dispatched from Plan Mode. Orchestrator owns design planning and may use Explorer for read-only discovery.';
const MANAGED_READ_ONLY_PROVIDER_UNSUPPORTED = 'MANAGED_READ_ONLY_PROVIDER_UNSUPPORTED';
const MANAGED_READ_ONLY_PROVIDER_UNSUPPORTED_MESSAGE = 'Plan-mode managed tasks cannot use Cursor because its SDK does not expose enforceable per-prompt write restrictions. Configure the parent Orchestrator or Plan agent with a non-Cursor model.';
const DEVRYAN_TOOL_INPUT_INVALID = 'DEVRYAN_TOOL_INPUT_INVALID';
const TASK_NOT_FOUND = 'task_not_found';
const PROVIDER_RECOVERY_MARKER_VERSION = 'v1';
// A wake is only observable once its message is persisted and visible to
// session.messages. Until then the marker check cannot see it, so the in-flight
// guard alone let a settle-retry scan send the same wake a second time — which
// appended a duplicate part to the same messageID and could leave the parent
// with a user message it never answered. Track sent wakes for the process too.
const PROVIDER_RECOVERY_SENT_MAX_ENTRIES = 512;
// How long a trailing marker is treated as a wake that may still be starting.
const RECOVERY_CONTINUATION_STALE_MS = 60_000;

const resolveMinimumTimeoutSeconds = (agent) => {
  const normalizedAgent = typeof agent === 'string' ? agent.trim().toLowerCase() : '';
  if (normalizedAgent === 'designer') return DESIGNER_MIN_TIMEOUT_SECONDS;
  if (normalizedAgent === 'fixer') return FIXER_MIN_TIMEOUT_SECONDS;
  if (normalizedAgent === 'oracle') return ORACLE_MIN_TIMEOUT_SECONDS;
  return DEFAULT_TIMEOUT_SECONDS;
};

const requireText = (value, field) => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new Error(`${field} is required for this managed task action`);
  return normalized;
};

const createToolInputInvalidError = (message, details) => {
  const error = new Error(`${DEVRYAN_TOOL_INPUT_INVALID}: ${message}`);
  error.code = DEVRYAN_TOOL_INPUT_INVALID;
  error.details = details;
  return error;
};

const resolveModelResultMode = () => (
  process.env.DEVRYAN_MANAGED_RESULT_MODE === 'eager' ? 'eager' : 'reference'
);

const withModelResultMode = (params, resultMode) => (
  resultMode === 'reference' ? { ...params, resultMode: 'reference' } : params
);

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

/**
 * The raw submit envelope reports `"status": "starting"` and nothing else. On
 * 2026-08-21 an orchestrator read three successive successful dispatches as
 * having failed — its own reasoning said "the prior turn queued Explorer
 * discovery", then "the Explorer discovery I queued earlier wasn't actually
 * dispatched" — and re-issued the same task twice, running three identical
 * subagents. The envelope needs to state, in words, that the work is already
 * underway and how to collect it.
 */
const annotateDispatchResult = (result, dispatchCallId) => {
  if (!isRecord(result) || !isRecord(result.task)) return result;
  const { task } = result;
  const alreadyRunning = task.dispatchCallId && dispatchCallId && task.dispatchCallId !== dispatchCallId;
  const label = typeof task.label === 'string' && task.label ? task.label : task.agent;

  const dispatched = alreadyRunning
    ? `ALREADY RUNNING. This exact task was already dispatched earlier in this session and is still running as task ${task.taskId} ("${label}"). A second subagent was NOT started.`
    : `DISPATCHED. Task ${task.taskId} ("${label}", agent "${task.agent}") is now running${task.childSessionId ? ` in child session ${task.childSessionId}` : ''}.`;

  return {
    ...result,
    dispatched: true,
    instructions: [
      dispatched,
      'Do NOT dispatch this task again — the work is underway and re-dispatching duplicates it.',
      `Call devryan_task with action "wait" and taskId "${task.taskId}" to block until it finishes and collect its result.`,
    ].join(' '),
  };
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
    const error = new Error(message);
    if (typeof body?.error?.code === 'string' && body.error.code.trim()) {
      error.code = body.error.code.trim();
    }
    error.statusCode = response.status;
    throw error;
  }
  return body.result;
};

const isRecord = (value) => (
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
);

const isTaskNotFoundError = (error) => error?.code === TASK_NOT_FOUND;

const resultReferenceTextEncoder = new TextEncoder();
const resultReferenceByteLength = (value) => resultReferenceTextEncoder.encode(value).byteLength;

const validateResultReference = (value, {
  taskId,
  envelopeId = null,
  totalBytes = null,
  previouslyReturnedBytes = 0,
} = {}) => {
  if (
    !isRecord(value)
    || value.taskId !== taskId
    || typeof value.envelopeId !== 'string'
    || !value.envelopeId.trim()
    || (envelopeId && value.envelopeId !== envelopeId)
    || !Number.isSafeInteger(value.totalBytes)
    || value.totalBytes <= RESULT_PAGE_MAX_BYTES
    || (totalBytes !== null && value.totalBytes !== totalBytes)
    || typeof value.text !== 'string'
    || resultReferenceByteLength(value.text) > RESULT_PAGE_MAX_BYTES
    || !Number.isSafeInteger(value.returnedBytes)
    || value.returnedBytes <= previouslyReturnedBytes
    || value.returnedBytes > value.totalBytes
    || value.returnedBytes !== previouslyReturnedBytes + resultReferenceByteLength(value.text)
    || typeof value.complete !== 'boolean'
    || (value.complete && value.returnedBytes !== value.totalBytes)
    || (!value.complete && value.returnedBytes >= value.totalBytes)
    || (value.nextCursor !== null && (typeof value.nextCursor !== 'string' || !value.nextCursor))
    || value.complete !== (value.nextCursor === null)
  ) {
    throw createToolInputInvalidError(
      `Managed result page for ${taskId} is malformed`,
      { taskId, state: 'invalid_result_page' },
    );
  }
  return value;
};

const createStaleTaskReferenceResult = (taskId) => ({
  state: 'stale_task_reference',
  taskId,
  dispositionRequired: false,
  instruction: 'The referenced terminal task is no longer retained and the authoritative managed-task barrier is clear. Continue from the last confirmed parent state without restarting, redispatching, or dispositioning this task again.',
});

const createAlreadyDispositionedResult = (result, barrier) => ({
  ...result,
  state: 'already_dispositioned',
  dispositionRequired: false,
  barrier,
  instruction: barrier.state === 'clear'
    ? 'This terminal task was already dispositioned and the authoritative managed-task barrier is clear. Continue from the current parent state without waiting for or dispositioning this task again.'
    : `This terminal task was already dispositioned. The authoritative managed-task barrier is ${barrier.state} for: ${barrier.taskIds.join(', ')}. Handle those current task IDs instead of repeating this disposition.`,
});

const unwrapResponseData = (response) => (
  response && typeof response === 'object' && 'data' in response
    ? response.data
    : response
);

const responseStatusCode = (responseOrError) => {
  const candidates = [
    responseOrError?.response?.status,
    responseOrError?.statusCode,
    responseOrError?.status,
    responseOrError?.error?.statusCode,
    responseOrError?.error?.status,
  ];
  return candidates.find((candidate) => Number.isInteger(candidate)) ?? null;
};

const readSessionMessage = async (client, { sessionId, messageId, directory }) => {
  if (!client?.session || typeof client.session.message !== 'function') {
    return { available: false, record: null };
  }
  let response;
  try {
    response = await client.session.message({
      path: { id: sessionId, messageID: messageId },
      query: { directory },
    });
  } catch (error) {
    if (responseStatusCode(error) === 404) return { available: true, record: null };
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot load managed-dispatch message ${messageId}: ${message}`);
  }
  if (response?.error) {
    if (responseStatusCode(response) === 404) return { available: true, record: null };
    throw new Error(`Cannot load managed-dispatch message ${messageId}`);
  }
  const record = unwrapResponseData(response);
  if (!isRecord(record) || !isRecord(record.info) || !Array.isArray(record.parts)) {
    throw new Error(`Managed-dispatch message ${messageId} is malformed`);
  }
  return { available: true, record };
};

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

const resolveMessageExecution = (assistant, parent) => {
  const assistantModel = isRecord(assistant?.info?.model) ? assistant.info.model : {};
  const parentModel = isRecord(parent?.info?.model) ? parent.info.model : {};
  const providerId = typeof assistant?.info?.providerID === 'string'
    ? assistant.info.providerID.trim()
    : (typeof assistantModel.providerID === 'string' ? assistantModel.providerID.trim() : '');
  const modelId = typeof assistant?.info?.modelID === 'string'
    ? assistant.info.modelID.trim()
    : (typeof assistantModel.modelID === 'string' ? assistantModel.modelID.trim() : '');
  if (!providerId || !modelId) return null;
  const variant = [
    assistant?.info?.variant,
    assistantModel.variant,
    parent?.info?.variant,
    parentModel.variant,
  ].find((candidate) => typeof candidate === 'string' && candidate.trim());
  return {
    providerId,
    modelId,
    variant: typeof variant === 'string' ? variant.trim() : null,
  };
};

const resolveAdjacentAssistantSibling = (records, messageId) => {
  const ordered = records
    .filter((record) => (
      (record?.info?.role === 'user' || record?.info?.role === 'assistant')
      && typeof record.info.id === 'string'
      && record.info.id.trim()
    ))
    .slice()
    .sort((left, right) => {
      const leftId = left.info.id.trim();
      const rightId = right.info.id.trim();
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    });
  if (ordered.length === 0) return null;

  const ids = ordered.map((record) => record.info.id.trim());
  if (new Set(ids).size !== ids.length || ids.some((id) => id >= messageId)) return null;

  const sibling = ordered.at(-1);
  if (sibling?.info?.role !== 'assistant') return null;
  const siblingParentId = typeof sibling.info.parentID === 'string'
    ? sibling.info.parentID.trim()
    : '';
  if (!siblingParentId) return null;

  let parentIndex = -1;
  for (let index = ordered.length - 2; index >= 0; index -= 1) {
    if (ordered[index]?.info?.role === 'user') {
      parentIndex = index;
      break;
    }
  }
  const parent = parentIndex >= 0 ? ordered[parentIndex] : null;
  if (parent && parent.info.id.trim() !== siblingParentId) return null;

  const sameTurnAssistants = parentIndex >= 0 ? ordered.slice(parentIndex + 1) : ordered;
  if (
    sameTurnAssistants.length === 0
    || sameTurnAssistants.some((record) => (
      record.info.role !== 'assistant'
      || typeof record.info.parentID !== 'string'
      || record.info.parentID.trim() !== siblingParentId
    ))
  ) {
    return null;
  }
  return { assistant: sibling, parent };
};

const resolveInvocationPolicy = async (context, client) => {
  if (
    !client?.session
    || (
      typeof client.session.message !== 'function'
      && typeof client.session.messages !== 'function'
    )
  ) {
    return { readOnly: false, parentExecution: null };
  }
  const rootSessionId = requireText(context.sessionID, 'context.sessionID');
  const messageId = requireText(context.messageID, 'context.messageID');
  const directory = requireText(context.directory, 'context.directory');
  const directAssistant = await readSessionMessage(client, {
    sessionId: rootSessionId,
    messageId,
    directory,
  });
  if (
    directAssistant.record
    && (
      directAssistant.record.info.role !== 'assistant'
      || directAssistant.record.info.id !== messageId
      || directAssistant.record.info.sessionID !== rootSessionId
    )
  ) {
    throw new Error('Cannot verify the invoking assistant for managed dispatch');
  }

  let records = [];
  let fallback = null;
  let assistant = directAssistant.record;
  if (!assistant) {
    if (typeof client.session.messages !== 'function') {
      throw new Error('Cannot verify the invoking assistant for managed dispatch');
    }
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
    records = unwrapResponseData(response);
    if (!Array.isArray(records)) {
      throw new Error('Cannot verify parent plan-mode policy before managed dispatch');
    }
    const exactAssistant = records.find((record) => (
      record?.info?.role === 'assistant' && record.info.id === messageId
    ));
    fallback = exactAssistant ? null : resolveAdjacentAssistantSibling(records, messageId);
    assistant = exactAssistant || fallback?.assistant;
  }
  const parentId = typeof assistant?.info?.parentID === 'string'
    ? assistant.info.parentID.trim()
    : '';
  if (!parentId) {
    throw new Error('Cannot verify the parent turn for managed dispatch');
  }
  const directParent = await readSessionMessage(client, {
    sessionId: rootSessionId,
    messageId: parentId,
    directory,
  });
  const parent = directParent.record
    || fallback?.parent
    || records.find((record) => record?.info?.role === 'user' && record.info.id === parentId);
  const directParentMismatch = directParent.record && (
    directParent.record.info?.role !== 'user'
    || directParent.record.info?.id !== parentId
    || directParent.record.info?.sessionID !== rootSessionId
  );
  if (
    !parent
    || parent.info?.role !== 'user'
    || parent.info?.id !== parentId
    || directParentMismatch
    || (parent.info?.sessionID && parent.info.sessionID !== rootSessionId)
  ) {
    throw new Error('Cannot verify the parent turn for managed dispatch');
  }
  return {
    readOnly: isPlanModeUserRecord(parent),
    parentExecution: resolveMessageExecution(assistant, parent),
  };
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

const readAgentCatalog = async (context, client) => {
  if (!client?.app || typeof client.app.agents !== 'function') {
    return { catalogAvailable: false, agents: [] };
  }
  const response = await client.app.agents({
    query: { directory: requireText(context.directory, 'context.directory') },
  });
  if (response?.error) {
    throw new Error('Failed to resolve the managed agent model');
  }
  return {
    catalogAvailable: true,
    agents: Array.isArray(response?.data) ? response.data : [],
  };
};

const resolveAgentExecution = (agents, agentName) => {
  const normalizedAgentName = typeof agentName === 'string' ? agentName.trim().toLowerCase() : '';
  const agent = agents.find((entry) => (
    typeof entry?.name === 'string' && entry.name.trim().toLowerCase() === normalizedAgentName
  ));
  const providerId = typeof agent?.model?.providerID === 'string'
    ? agent.model.providerID.trim()
    : '';
  const modelId = typeof agent?.model?.modelID === 'string'
    ? agent.model.modelID.trim()
    : '';
  if (!providerId || !modelId) return null;
  return {
    providerId,
    modelId,
    variant: typeof agent.variant === 'string' && agent.variant.trim() ? agent.variant.trim() : null,
  };
};

const resolveOwnedAgentExecution = async (context, agent, fallbackExecution) => {
  // Older DevRyan bridges do not expose owner-aware defaults. Admission still
  // validates the submitted execution, while current bridges advertise this
  // capability so plan-safe checks can use the account overlay up front.
  if (process.env.DEVRYAN_ORCHESTRATION_ACCOUNT_DEFAULTS !== '1') return fallbackExecution;
  const resolved = await callRpc('resolve_agent_execution', {
    rootSessionId: requireText(context.sessionID, 'context.sessionID'),
    directory: requireText(context.directory, 'context.directory'),
    agent: requireText(agent, 'agent'),
    fallbackExecution,
  }, { signal: context.abort });
  const providerId = typeof resolved?.providerId === 'string' ? resolved.providerId.trim() : '';
  const modelId = typeof resolved?.modelId === 'string' ? resolved.modelId.trim() : '';
  if (!providerId || !modelId) {
    throw new Error(`Managed agent ${agent} has no owner-resolved model`);
  }
  return {
    providerId,
    modelId,
    variant: typeof resolved.variant === 'string' && resolved.variant.trim()
      ? resolved.variant.trim()
      : null,
  };
};

const resolveConfiguredAgentExecution = async (args, context, client) => {
  const catalog = await readAgentCatalog(context, client);
  const agent = requireText(args.agent, 'agent');
  const configured = catalog.catalogAvailable
    ? resolveAgentExecution(catalog.agents, agent)
    : null;
  return {
    catalogAvailable: catalog.catalogAvailable,
    execution: configured
      ? await resolveOwnedAgentExecution(context, agent, configured)
      : null,
  };
};

// This plugin is provisioned as a standalone OpenCode asset and cannot import
// the workspace runtime package. Keep this mirror covered by contract tests;
// the runtime predicate remains the authoritative admission boundary.
const supportsManagedReadOnlyProvider = (providerId) => {
  const normalized = typeof providerId === 'string' ? providerId.trim().toLowerCase() : '';
  return Boolean(normalized) && normalized !== 'cursor-acp';
};

const supportsManagedReadOnlyAgent = (agent) => {
  const normalized = typeof agent === 'string' ? agent.trim().toLowerCase() : '';
  return Boolean(normalized) && normalized !== 'designer';
};

const createManagedReadOnlyAgentUnsupportedError = () => {
  const error = new Error(MANAGED_READ_ONLY_AGENT_UNSUPPORTED_MESSAGE);
  error.code = MANAGED_READ_ONLY_AGENT_UNSUPPORTED;
  error.statusCode = 409;
  return error;
};

const createManagedReadOnlyProviderUnsupportedError = () => {
  const error = new Error(MANAGED_READ_ONLY_PROVIDER_UNSUPPORTED_MESSAGE);
  error.code = MANAGED_READ_ONLY_PROVIDER_UNSUPPORTED;
  error.statusCode = 409;
  return error;
};

const formatExecution = (execution) => `${execution.providerId}/${execution.modelId}`;

const resolveStartExecution = async (args, context, client, invocationPolicy) => {
  const agentName = requireText(args.agent, 'agent');
  const catalog = await readAgentCatalog(context, client);
  let execution;
  if (catalog.catalogAvailable) {
    execution = resolveAgentExecution(catalog.agents, agentName);
    if (!execution) {
      throw new Error(`Managed agent ${agentName} has no executable model`);
    }
  } else {
    const providerId = typeof args.provider_id === 'string' ? args.provider_id.trim() : '';
    const modelId = typeof args.model_id === 'string' ? args.model_id.trim() : '';
    if (Boolean(providerId) !== Boolean(modelId)) {
      throw new Error('provider_id and model_id must be supplied together');
    }
    if (!providerId || !modelId) {
      throw new Error(`Managed agent ${agentName} has no executable model`);
    }
    execution = {
      providerId,
      modelId,
      variant: typeof args.variant === 'string' && args.variant.trim() ? args.variant.trim() : null,
    };
  }

  execution = await resolveOwnedAgentExecution(context, agentName, execution);

  if (!invocationPolicy.readOnly || supportsManagedReadOnlyProvider(execution.providerId)) {
    return { execution, executionNotice: null };
  }

  let fallback = null;
  let fallbackSource = null;
  if (
    invocationPolicy.parentExecution
    && supportsManagedReadOnlyProvider(invocationPolicy.parentExecution.providerId)
  ) {
    fallback = invocationPolicy.parentExecution;
    fallbackSource = 'the parent Orchestrator';
  } else if (catalog.catalogAvailable) {
    const planAgent = catalog.agents.find((entry) => (
      typeof entry?.name === 'string' && entry.name.trim().toLowerCase() === 'plan'
    ));
    const planExecution = planAgent
      ? resolveAgentExecution([planAgent], planAgent.name)
      : null;
    const ownedPlanExecution = planExecution
      ? await resolveOwnedAgentExecution(context, planAgent.name, planExecution)
      : null;
    if (ownedPlanExecution && supportsManagedReadOnlyProvider(ownedPlanExecution.providerId)) {
      fallback = ownedPlanExecution;
      fallbackSource = 'the configured Plan agent';
    }
  }

  if (!fallback || !fallbackSource) {
    throw createManagedReadOnlyProviderUnsupportedError();
  }

  return {
    execution: fallback,
    executionNotice: `Plan-safe model fallback: ${agentName} is configured for ${formatExecution(execution)}; this read-only task is running with ${formatExecution(fallback)} from ${fallbackSource}.`,
  };
};

const requiresManualModelRecovery = (result) => {
  const task = result?.task;
  const resultEnvelope = result?.resultEnvelope;
  return Boolean(
    isRecord(task)
    && isRecord(resultEnvelope)
    && task.childSessionId
    && task.agentRetryAvailable === false
    && task.failureKind !== 'provider_prompt_rejected'
    && (task.status === 'failed' || task.status === 'interrupted')
    && (
      task.failureKind === 'provider_usage_limit'
      || task.failureKind === 'model_unavailable'
      || (
        task.mode === 'orchestrator'
        && task.dispatchGrouped === true
        && Number(task.attempt) >= 2
      )
    )
    && resultEnvelope.resumable === true
    && resultEnvelope.action === null
  );
};

const waitForTerminalTask = async (taskId, scoped, signal, initialResult, resultMode) => {
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
    result = await callRpc('wait', withModelResultMode({
      ...scoped,
      taskId: expectedTaskId,
      waitTimeoutMs: WAIT_TIMEOUT_MS,
    }, resultMode), { signal });
  }
};

const exposeManualModelRecovery = (result) => (
  requiresManualModelRecovery(result)
    ? {
        ...result,
        manualRecoveryRequired: true,
        manualRecoveryInstruction: 'This task is terminal and awaiting user action. Leave its result unacknowledged, tell the user to choose a model and thinking level in Model Recovery, and do not claim that it is still running or will resume automatically.',
      }
    : result
);

const executeAction = async (args, context, client, dispatchCallId = null, resultMode = 'reference') => {
  const action = requireText(args.action, 'action');
  if (!ACTIONS.includes(action)) throw new Error(`Unsupported managed task action: ${action}`);

  if (action === 'start') {
    const agent = requireText(args.agent, 'agent');
    const minimumTimeoutSeconds = resolveMinimumTimeoutSeconds(agent);
    const timeoutSeconds = Number.isFinite(args.timeout_seconds)
      ? Math.min(MAX_TIMEOUT_SECONDS, Math.max(minimumTimeoutSeconds, Math.trunc(args.timeout_seconds)))
      : minimumTimeoutSeconds;
    const invocationPolicy = await resolveInvocationPolicy(context, client);
    if (invocationPolicy.readOnly && !supportsManagedReadOnlyAgent(agent)) {
      throw createManagedReadOnlyAgentUnsupportedError();
    }
    const { execution, executionNotice } = await resolveStartExecution(
      args,
      context,
      client,
      invocationPolicy,
    );
    const readOnly = invocationPolicy.readOnly;
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
    const result = await callRpc('submit', withModelResultMode({
      idempotencyKey: buildIdempotencyKey(context, action, normalizedArgs, dispatchCallId),
      rootSessionId: requireText(context.sessionID, 'context.sessionID'),
      dispatchGroupId: context.agent === 'builder'
        ? null
        : requireText(context.messageID, 'context.messageID'),
      dispatchCallId,
      allowDuplicate: args.allow_duplicate === true,
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
    }, resultMode), { signal: context.abort });
    const withNotice = executionNotice && isRecord(result)
      ? { ...result, executionNotice }
      : result;
    return annotateDispatchResult(withNotice, dispatchCallId);
  }

  const scoped = buildScopedParams(args, context);
  if (action === 'status') {
    return await callRpc(action, withModelResultMode(scoped, resultMode), { signal: context.abort });
  }
  if (action === 'wait') {
    const result = await waitForTerminalTask(
      scoped.taskId,
      scoped,
      context.abort,
      undefined,
      resultMode,
    );
    return exposeManualModelRecovery(result);
  }
  if (action === 'cancel') {
    return await callRpc('cancel', withModelResultMode({
      ...scoped,
      cascade: args.cascade === true,
      ...(typeof args.reason === 'string' && args.reason.trim()
        ? { reason: args.reason.trim() }
        : {}),
    }, resultMode), { signal: context.abort });
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
    return await callRpc('acknowledge', withModelResultMode({
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
      ...(Number.isFinite(args.timeout_seconds) && args.timeout_seconds > 0
        ? {
            timeoutSeconds: Math.min(
              MAX_TIMEOUT_SECONDS,
              Math.max(
                resolveMinimumTimeoutSeconds(normalizedOverrides.agent),
                Math.floor(args.timeout_seconds),
              ),
            ),
          }
        : {}),
    }, resultMode), { signal: context.abort });
  }

  throw new Error(`Unsupported managed task action: ${action}`);
};

export const DevRyanManagedOrchestrationPlugin = async ({
  client,
  scheduleTimeout = globalThis.setTimeout,
} = {}) => {
  const sessionStates = new Map();
  const modelResultMode = resolveModelResultMode();
  const pendingStartsByArgs = new WeakMap();
  const agentOwnershipCache = new Map();
  const recoveryContinuationsInFlight = new Set();
  const recoveryContinuationsSent = new Set();
  const recoveryContinuationClaimantId = `plugin:${crypto.randomUUID()}`;
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

  const readVerifiedRootState = async (rootSessionId, { missingTaskId = null } = {}) => {
    const normalizedRootSessionId = requireText(rootSessionId, 'rootSessionId');
    const snapshot = await callRpc('snapshot', { rootSessionId: normalizedRootSessionId });
    if (
      !isRecord(snapshot)
      || snapshot.available !== true
      || snapshot.bridgeReady !== true
      || !Array.isArray(snapshot.tasks)
      || !Array.isArray(snapshot.resultEnvelopes)
    ) {
      throw new Error('Managed orchestration snapshot is unavailable or malformed');
    }
    if (typeof snapshot.recoveryWarning === 'string' && snapshot.recoveryWarning.trim()) {
      throw new Error(`Managed orchestration snapshot has a recovery warning: ${snapshot.recoveryWarning.trim()}`);
    }
    if (snapshot.recoveryWarning !== null && snapshot.recoveryWarning !== undefined) {
      throw new Error('Managed orchestration snapshot has a malformed recovery warning');
    }
    if (missingTaskId) {
      const retained = [...snapshot.tasks, ...snapshot.resultEnvelopes].some((entry) => (
        isRecord(entry) && entry.taskId === missingTaskId
      ));
      if (retained) {
        throw new Error(`Managed task ${missingTaskId} is present in the root snapshot after task_not_found`);
      }
    }

    const barrier = await callRpc('barrier_status', { rootSessionId: normalizedRootSessionId });
    if (
      !isRecord(barrier)
      || !['clear', 'active', 'awaiting_acknowledgement'].includes(barrier.state)
      || !Array.isArray(barrier.taskIds)
      || barrier.taskIds.some((taskId) => typeof taskId !== 'string' || !taskId.trim())
      || (barrier.state === 'clear' && barrier.taskIds.length !== 0)
      || (barrier.state !== 'clear' && barrier.taskIds.length === 0)
    ) {
      throw new Error('Managed orchestration barrier status is malformed');
    }
    return {
      snapshot,
      barrier: {
        state: barrier.state,
        taskIds: barrier.taskIds.map((taskId) => taskId.trim()),
      },
    };
  };

  const failClosedFromTaskNotFound = (taskId, taskNotFoundError, verificationError) => {
    const detail = verificationError instanceof Error
      ? verificationError.message
      : String(verificationError);
    const error = new Error(
      `${taskNotFoundError.message}. Parent work remains blocked because stale-reference recovery could not verify the managed-task barrier: ${detail}`,
      { cause: verificationError },
    );
    error.code = taskNotFoundError.code;
    error.statusCode = taskNotFoundError.statusCode;
    error.taskId = taskId;
    return error;
  };

  const recoverMissingTaskReference = async (taskId, rootSessionId, taskNotFoundError) => {
    let rootState;
    try {
      rootState = await readVerifiedRootState(rootSessionId, { missingTaskId: taskId });
    } catch (error) {
      throw failClosedFromTaskNotFound(taskId, taskNotFoundError, error);
    }

    const state = getSessionState(rootSessionId);
    if (rootState.barrier.state !== 'clear') {
      state.knownBarrier = true;
      const label = rootState.barrier.state === 'active'
        ? 'active managed tasks'
        : 'managed task results awaiting acknowledgement';
      throw new Error(
        `Managed task ${taskId} is no longer retained, but parent work remains blocked by ${label}: ${rootState.barrier.taskIds.join(', ')}`,
      );
    }

    state.knownBarrier = false;
    state.collectedResults.delete(taskId);
    logRecovery('stale-task-reference-recovered', { rootSessionId, taskId });
    return createStaleTaskReferenceResult(taskId);
  };

  const recognizeAlreadyDispositioned = async (result, rootSessionId) => {
    const action = typeof result?.resultEnvelope?.action === 'string'
      ? result.resultEnvelope.action.trim()
      : '';
    if (!action) return null;
    const taskId = requireText(result?.task?.taskId, 'task.taskId');

    const rootState = await readVerifiedRootState(rootSessionId);
    const state = getSessionState(rootSessionId);
    state.knownBarrier = rootState.barrier.state !== 'clear';
    state.collectedResults.delete(taskId);
    logRecovery('already-dispositioned-task-recognized', {
      rootSessionId,
      taskId,
      action,
      barrierState: rootState.barrier.state,
    });
    return createAlreadyDispositionedResult(result, rootState.barrier);
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

  const isRecoveryContinuationStillCollectable = async ({
    taskId,
    rootSessionId,
    directory,
  }) => {
    let result;
    try {
      result = await callRpc('status', { taskId, rootSessionId, directory });
    } catch (error) {
      if (!isTaskNotFoundError(error)) throw error;
      await readVerifiedRootState(rootSessionId, { missingTaskId: taskId });
      rememberRecoveryContinuationSent(taskId);
      logRecovery('recovered-parent-continuation-skipped', {
        rootSessionId,
        taskId,
        reason: 'task_compacted',
      });
      return false;
    }

    if (
      !isRecord(result?.task)
      || result.task.taskId !== taskId
      || !isRecord(result.resultEnvelope)
      || result.resultEnvelope.taskId !== taskId
      || !Object.prototype.hasOwnProperty.call(result.resultEnvelope, 'action')
    ) {
      throw new Error('Managed task recovery revalidation returned a malformed task');
    }
    const status = typeof result.task.status === 'string' ? result.task.status : '';
    if (!TERMINAL_TASK_STATUSES.has(status)) {
      throw new Error('Managed task recovery revalidation returned a non-collectable task');
    }
    if (result.resultEnvelope.action !== null) {
      if (
        typeof result.resultEnvelope.action !== 'string'
        || !result.resultEnvelope.action.trim()
      ) {
        throw new Error('Managed task recovery revalidation returned a malformed action');
      }
      rememberRecoveryContinuationSent(taskId);
      logRecovery('recovered-parent-continuation-skipped', {
        rootSessionId,
        taskId,
        reason: 'already_dispositioned',
      });
      return false;
    }
    return true;
  };

  const requestRecoveredParentContinuation = async (continuation) => {
    if (!isRecord(continuation)) return false;
    // Parked Model Recovery results are never collectable. Ignore a leftover
    // `manual_recovery` payload from an older host instead of waking the parent.
    if (continuation.kind !== 'collect') return false;
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
      if (!await isRecoveryContinuationStillCollectable({
        taskId,
        rootSessionId,
        directory,
      })) {
        return false;
      }

      const claimScope = {
        taskId,
        rootSessionId,
        directory,
        claimantId: recoveryContinuationClaimantId,
      };
      const claim = await callRpc('claim_provider_recovery_continuation', claimScope);
      if (!isRecord(claim) || typeof claim.claimed !== 'boolean') {
        throw new Error('Managed task recovery continuation claim returned a malformed result');
      }
      if (!claim.claimed) {
        // The owning plugin may disappear before delivery. Keep a lease-aware
        // scan chain alive until its scheduler lease expires or its transcript
        // marker becomes visible.
        recoveryScanRequested = true;
        return false;
      }

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
      let promptDelivered = false;
      try {
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
        promptDelivered = true;
        rememberRecoveryContinuationSent(taskId);
        logRecovery('recovered-parent-continued', { rootSessionId, taskId });
        return true;
      } finally {
        if (!promptDelivered) {
          try {
            await callRpc('release_provider_recovery_continuation', claimScope);
          } catch (error) {
            logRecovery('recovered-parent-continuation-release-failed', {
              rootSessionId,
              taskId,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
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
      const taskIdList = Array.isArray(barrier.taskIds) ? barrier.taskIds : [];
      const taskIds = taskIdList.join(', ');
      // Be explicit about the ONE call that can make progress. The generic
      // "use devryan_task wait" wording left an orchestrator retrying ordinary
      // tools — on 2026-08-21 five consecutive ctx_search/bash/grep calls all
      // failed against this barrier, each burning a full turn.
      const nextCall = taskIdList.length > 0
        ? `devryan_task with action "wait" and task_id "${taskIdList[0]}"`
        : 'devryan_task with action "wait"';
      const blockedNote = `Every tool except devryan_task will keep failing until the barrier clears, so do not retry ${toolName} or try a different tool. Call ${nextCall} now.`;
      if (barrier.state === 'active') {
        throw new Error(
          `Parent work is blocked by active managed tasks${taskIds ? `: ${taskIds}` : ''}. `
          + blockedNote,
        );
      }
      throw new Error(
        `Parent work is blocked by managed task results${taskIds ? `: ${taskIds}` : ''}. `
        + `${blockedNote} Once it returns, disposition the result with continue, retry, resume, or abandon.`,
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
      description: 'Start or control a DevRyan-managed sub-agent. When managed delegation is already the decided next action, start it before any standalone todo read/write whose only purpose is to restate that delegation. DevRyan does not impose a managed concurrency cap: start every independent sub-agent needed by the task without batching around an artificial slot limit. DevRyan preserves partial results after failure or abort. DevRyan keeps each wait call attached while repeating bounded polling slices internally; wait returns only a terminal result, and status is the non-blocking way to inspect queued, starting, or running state. Large terminal previews return an initial resultReference page; call read_result with each exact nextCursor until complete before dispositioning the result. A completed result accepts only continue. Retry is only for an eligible failed result. A resumable failure with no agent retry remaining returns immediately with manualRecoveryRequired while its durable result stays pending for the user-facing Model Recovery controls, except provider prompt rejection, which requires the one agent recovery to use a reframed prompt in a fresh child. A stale_task_reference or already_dispositioned result requires no repeated wait, disposition, or replacement child; follow its authoritative barrier instruction and continue from the last confirmed parent state when clear. This is distinct from provider-native task orchestration.',
      args: {
        action: tool.schema.enum(ACTIONS).describe('Action: start, status, wait, read_result, cancel, continue, retry, resume, or abandon. Use read_result only after a terminal wait returns resultReference.nextCursor, and pass each cursor exactly once in order until complete. A completed result accepts only continue; retry is only for an eligible failed result. A resumable failure with no agent retry remaining returns manualRecoveryRequired and remains pending for the user-facing Model Recovery controls. After the user retries, an idle-parent continuation collects the recovered result. Wait stays attached only until the requested task is terminal while DevRyan polls internally; use status for a non-blocking live snapshot. stale_task_reference and already_dispositioned are no-op recovery states and must not trigger a replacement task or repeated acknowledgement.'),
        task_id: tool.schema.string().optional().describe('Managed dvr_task_ ID. Required for every action except start.'),
        result_cursor: tool.schema.string().optional().describe('Exact resultReference.nextCursor from the preceding wait or read_result page. Required only for read_result.'),
        label: tool.schema.string().optional().describe('Short task label for start or retry.'),
        prompt: tool.schema.string().optional().describe('Full delegated prompt for start, or a retry override. A provider_prompt_rejected retry requires a compact, semantically complete prompt that differs from the rejected prompt.'),
        provider_id: tool.schema.string().optional().describe('Compatibility fallback provider ID when no runtime agent catalog is available. Supply together with model_id; configured agent settings are authoritative.'),
        model_id: tool.schema.string().optional().describe('Compatibility fallback model ID when no runtime agent catalog is available. Supply together with provider_id; configured agent settings are authoritative.'),
        agent: tool.schema.string().optional().describe('Agent name for start or an optional retry/resume override.'),
        variant: tool.schema.string().optional().describe('Optional compatibility fallback variant. The configured agent variant is authoritative when the runtime catalog is available.'),
        timeout_seconds: tool.schema.number().int().min(MIN_TIMEOUT_SECONDS).max(MAX_TIMEOUT_SECONDS).optional().describe('Timeout in seconds. Defaults to 900 for Oracle, 3600 for Designer and Fixer, and 1800 for other ordinary specialists. Use 1800 for an explicitly deep Oracle review. On retry, resume, and retry_in_place it extends the window, which otherwise inherits the original task\'s.'),
        allow_duplicate: tool.schema.boolean().optional().describe('For start only: permit a second task with the same agent and effectively the same prompt while the first is still running. DevRyan otherwise collapses such a start onto the running task, because a repeated dispatch is far more often the model re-issuing work it already started than a deliberate parallel fan-out. Set this only when you genuinely want the same agent working the same prompt twice at once.'),
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
          if (action === 'read_result') {
            const taskId = requireText(args.task_id, 'task_id');
            const collected = state.collectedResults.get(taskId);
            if (!collected) {
              throw createToolInputInvalidError(
                `Call wait for managed task ${taskId} before read_result`,
                { taskId, state: 'wait_required' },
              );
            }
            if (typeof args.result_cursor !== 'string' || !args.result_cursor) {
              throw createToolInputInvalidError(
                `result_cursor is required for managed task ${taskId}`,
                { taskId, state: 'result_cursor_required' },
              );
            }
            const resultCursor = args.result_cursor;
            const paging = collected.resultPaging;
            if (!paging || paging.complete || !paging.expectedNextCursor) {
              throw createToolInputInvalidError(
                `Managed result ${taskId} has no unread pages`,
                { taskId, state: 'result_complete' },
              );
            }
            if (resultCursor !== paging.expectedNextCursor) {
              throw createToolInputInvalidError(
                `result_cursor is stale or out of order for managed task ${taskId}`,
                { taskId, state: 'result_cursor_mismatch' },
              );
            }
            const result = await callRpc('read_result', {
              taskId,
              rootSessionId: requireText(context.sessionID, 'context.sessionID'),
              directory: requireText(context.directory, 'context.directory'),
              resultCursor,
            }, { signal: context.abort });
            const reference = validateResultReference(result?.resultReference, {
              taskId,
              envelopeId: paging.envelopeId,
              totalBytes: paging.totalBytes,
              previouslyReturnedBytes: paging.returnedBytes,
            });
            collected.resultPaging = {
              envelopeId: reference.envelopeId,
              totalBytes: reference.totalBytes,
              returnedBytes: reference.returnedBytes,
              expectedNextCursor: reference.nextCursor,
              complete: reference.complete,
            };
            return JSON.stringify(compactManagedTaskToolResult(result), null, 2);
          }
          if (RESULT_ACTIONS.has(action)) {
            const taskId = requireText(args.task_id, 'task_id');
            const collected = state.collectedResults.get(taskId);
            if (!collected) {
              let current;
              try {
                current = await callRpc('status', withModelResultMode(
                  buildScopedParams(args, context),
                  modelResultMode,
                ), {
                  signal: context.abort,
                });
              } catch (error) {
                if (!isTaskNotFoundError(error)) throw error;
                const recovered = await recoverMissingTaskReference(
                  taskId,
                  context.sessionID,
                  error,
                );
                return JSON.stringify(recovered, null, 2);
              }
              const alreadyDispositioned = await recognizeAlreadyDispositioned(
                current,
                context.sessionID,
              );
              if (alreadyDispositioned) {
                return JSON.stringify(
                  compactManagedTaskToolResult(alreadyDispositioned),
                  null,
                  2,
                );
              }
              throw new Error(`Use devryan_task wait for ${taskId} before ${action}`);
            }
            if (collected.status === 'completed' && action !== 'continue') {
              throw createToolInputInvalidError(
                `Managed task ${taskId} is completed; action "${action}" is incompatible. `
                + `Required next action: {"action":"continue","task_id":"${taskId}"}`,
                {
                  taskId,
                  state: 'completed',
                  receivedAction: action,
                  requiredAction: 'continue',
                },
              );
            }
            if (requiresManualModelRecovery(collected)) {
              throw new Error('Manual model recovery requires the user-facing Model Recovery controls; leave this result unacknowledged');
            }
          }
          let result;
          try {
            result = await executeAction(
              { ...args, action },
              context,
              client,
              dispatchCallId,
              modelResultMode,
            );
          } catch (error) {
            if (
              !isTaskNotFoundError(error)
              || (!['status', 'wait'].includes(action) && !RESULT_ACTIONS.has(action))
            ) {
              throw error;
            }
            const taskId = requireText(args.task_id, 'task_id');
            const recovered = await recoverMissingTaskReference(
              taskId,
              context.sessionID,
              error,
            );
            return JSON.stringify(recovered, null, 2);
          }
          if (action === 'start' && context.agent !== 'builder') state.knownBarrier = true;
          if (RESULT_ACTIONS.has(action)) {
            state.collectedResults.delete(requireText(args.task_id, 'task_id'));
          }
          if (action === 'status' || action === 'wait') {
            const alreadyDispositioned = await recognizeAlreadyDispositioned(
              result,
              context.sessionID,
            );
            if (alreadyDispositioned) {
              return JSON.stringify(
                compactManagedTaskToolResult(alreadyDispositioned),
                null,
                2,
              );
            }
          }
          if (action === 'wait') {
            const requestedTaskId = requireText(args.task_id, 'task_id');
            const status = typeof result?.task?.status === 'string' ? result.task.status : null;
            const resultTaskId = typeof result?.task?.taskId === 'string'
              ? result.task.taskId.trim()
              : '';
            state.collectedResults.delete(requestedTaskId);
            if (TERMINAL_TASK_STATUSES.has(status)) {
              if (!resultTaskId) throw new Error('Managed task wait returned a terminal result without a task ID');
              const resultEnvelopeId = typeof result?.resultEnvelope?.envelopeId === 'string'
                ? result.resultEnvelope.envelopeId.trim()
                : '';
              let resultReference = null;
              if (result?.resultReference !== undefined) {
                if (!resultEnvelopeId) {
                  throw createToolInputInvalidError(
                    `Managed result page for ${resultTaskId} has no matching result envelope`,
                    { taskId: resultTaskId, state: 'invalid_result_page' },
                  );
                }
                resultReference = validateResultReference(result.resultReference, {
                  taskId: resultTaskId,
                  envelopeId: resultEnvelopeId,
                });
              }
              state.collectedResults.set(resultTaskId, {
                status,
                task: result.task,
                resultEnvelope: result.resultEnvelope,
                resultPaging: resultReference
                  ? {
                      envelopeId: resultReference.envelopeId,
                      totalBytes: resultReference.totalBytes,
                      returnedBytes: resultReference.returnedBytes,
                      expectedNextCursor: resultReference.nextCursor,
                      complete: resultReference.complete,
                    }
                  : {
                      envelopeId: null,
                      totalBytes: null,
                      returnedBytes: 0,
                      expectedNextCursor: null,
                      complete: true,
                    },
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
