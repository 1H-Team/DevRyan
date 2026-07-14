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
const MAX_TIMEOUT_SECONDS = 24 * 60 * 60;

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

const buildIdempotencyKey = (context, action, args) => {
  const fingerprint = crypto.createHash('sha256')
    .update(JSON.stringify({ action, args }))
    .digest('hex');
  return `tool:${context.sessionID}:${context.messageID || 'unknown'}:${fingerprint}`;
};

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

const buildScopedParams = (args, context) => ({
  taskId: requireText(args.task_id, 'task_id'),
  rootSessionId: requireText(context.sessionID, 'context.sessionID'),
  directory: requireText(context.directory, 'context.directory'),
});

const resolveConfiguredAgentExecution = async (args, context, client) => {
  if (!client?.app || typeof client.app.agents !== 'function') return null;
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
  if (!providerId || !modelId) return null;
  return {
    providerId,
    modelId,
    variant: typeof agent.variant === 'string' && agent.variant.trim() ? agent.variant.trim() : null,
  };
};

const resolveStartExecution = async (args, context, client) => {
  const providerId = typeof args.provider_id === 'string' ? args.provider_id.trim() : '';
  const modelId = typeof args.model_id === 'string' ? args.model_id.trim() : '';
  if (Boolean(providerId) !== Boolean(modelId)) {
    throw new Error('provider_id and model_id must be supplied together');
  }
  const configured = await resolveConfiguredAgentExecution(args, context, client);
  if (configured) return configured;
  if (providerId && modelId) {
    return {
      providerId,
      modelId,
      variant: typeof args.variant === 'string' && args.variant.trim() ? args.variant.trim() : null,
    };
  }
  const agentName = requireText(args.agent, 'agent');
  throw new Error(`Managed agent ${agentName} has no executable model`);
};

const executeAction = async (args, context, client) => {
  const action = requireText(args.action, 'action');
  if (!ACTIONS.includes(action)) throw new Error(`Unsupported managed task action: ${action}`);

  if (action === 'start') {
    const timeoutSeconds = Number.isFinite(args.timeout_seconds)
      ? Math.min(MAX_TIMEOUT_SECONDS, Math.max(MIN_TIMEOUT_SECONDS, Math.trunc(args.timeout_seconds)))
      : DEFAULT_TIMEOUT_SECONDS;
    const agent = requireText(args.agent, 'agent');
    const execution = await resolveStartExecution(args, context, client);
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
      idempotencyKey: buildIdempotencyKey(context, action, normalizedArgs),
      rootSessionId: requireText(context.sessionID, 'context.sessionID'),
      dispatchGroupId: context.agent === 'builder'
        ? null
        : requireText(context.messageID, 'context.messageID'),
      parentTaskId: null,
      directory: requireText(context.directory, 'context.directory'),
      mode: context.agent === 'builder' ? 'builder' : 'orchestrator',
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
  if (action === 'status' || action === 'wait') {
    return await callRpc(action, scoped, { signal: context.abort });
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
    const configured = normalizedOverrides.agent
      ? await resolveConfiguredAgentExecution({ agent: normalizedOverrides.agent }, context, client)
      : null;
    if (configured) {
      normalizedOverrides.providerId = configured.providerId;
      normalizedOverrides.modelId = configured.modelId;
      normalizedOverrides.variant = configured.variant;
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

export const DevRyanManagedOrchestrationPlugin = async ({ client } = {}) => {
  const sessionStates = new Map();
  const agentOwnershipCache = new Map();

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
      : typeof assistantRecord.info.mode === 'string'
        ? assistantRecord.info.mode.trim().toLowerCase()
        : '';
    if (directAgent === 'builder' || directAgent === 'orchestrator') return directAgent;

    const parentID = typeof assistantRecord.info.parentID === 'string'
      ? assistantRecord.info.parentID
      : '';
    const parent = parentID
      ? records.find((record) => record?.info?.role === 'user' && record.info.id === parentID)
      : null;
    const parentAgent = typeof parent?.info?.agent === 'string'
      ? parent.info.agent.trim().toLowerCase()
      : '';
    return parentAgent === 'builder' || parentAgent === 'orchestrator'
      ? parentAgent
      : null;
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

  const registerPendingStart = (rootSessionId) => {
    const state = getSessionState(rootSessionId);
    let resolve;
    const entry = {
      claimed: false,
      promise: new Promise((resolvePromise) => { resolve = resolvePromise; }),
      settle() {
        const index = state.pendingStarts.indexOf(entry);
        if (index >= 0) state.pendingStarts.splice(index, 1);
        resolve();
      },
    };
    state.pendingStarts.push(entry);
  };

  const claimPendingStart = (rootSessionId) => {
    const entry = getSessionState(rootSessionId).pendingStarts.find((candidate) => !candidate.claimed);
    if (entry) entry.claimed = true;
    return entry ?? null;
  };

  const drainPendingStarts = async (state) => {
    while (state.pendingStarts.length > 0) {
      await Promise.all(state.pendingStarts.map((entry) => entry.promise));
    }
  };

  const beforeToolExecute = async (input, output) => {
    const rootSessionId = requireText(input?.sessionID, 'sessionID');
    const toolName = requireText(input?.tool, 'tool');
    if (toolName === 'devryan_task') {
      if (output?.args?.action === 'start') registerPendingStart(rootSessionId);
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

  return {
    'tool.execute.before': beforeToolExecute,
    tool: {
      devryan_task: tool({
      description: 'Start or control a DevRyan-managed sub-agent. When managed delegation is already the decided next action, start it before any standalone todo read/write whose only purpose is to restate that delegation. DevRyan enforces a global maximum of three concurrent managed children, queues excess work deterministically, and preserves partial results after failure or abort. This is distinct from provider-native task orchestration.',
      args: {
        action: tool.schema.enum(ACTIONS).describe('Action: start, status, wait, cancel, continue, retry, resume, or abandon.'),
        task_id: tool.schema.string().optional().describe('Managed dvr_task_ ID. Required for every action except start.'),
        label: tool.schema.string().optional().describe('Short task label for start or retry.'),
        prompt: tool.schema.string().optional().describe('Full delegated prompt for start, or an optional retry override.'),
        provider_id: tool.schema.string().optional().describe('Provider ID for start or an optional retry/resume override.'),
        model_id: tool.schema.string().optional().describe('Model ID for start or an optional retry/resume override.'),
        agent: tool.schema.string().optional().describe('Agent name for start or an optional retry/resume override.'),
        variant: tool.schema.string().optional().describe('Optional model variant.'),
        timeout_seconds: tool.schema.number().int().min(MIN_TIMEOUT_SECONDS).max(MAX_TIMEOUT_SECONDS).optional().describe('Start timeout in seconds. Defaults to 1800.'),
        cascade: tool.schema.boolean().optional().describe('For cancel only: also cancel explicit managed descendants.'),
        reason: tool.schema.string().optional().describe('Optional cancellation reason.'),
      },
      async execute(args, context) {
        const action = requireText(args.action, 'action');
        const state = getSessionState(context.sessionID);
        const pendingStart = action === 'start' ? claimPendingStart(context.sessionID) : null;
        try {
          if (RESULT_ACTIONS.has(action)) {
            const taskId = requireText(args.task_id, 'task_id');
            if (!state.collectedResults.has(taskId)) {
              throw new Error(`Use devryan_task wait for ${taskId} before ${action}`);
            }
            if (state.collectedResults.get(taskId)?.status === 'completed' && action !== 'continue') {
              throw new Error(`The successful result requires continue after wait: ${taskId}`);
            }
          }
          const result = await executeAction(args, context, client);
          if (action === 'start' && context.agent !== 'builder') state.knownBarrier = true;
          if (action === 'wait') {
            state.collectedResults.set(requireText(args.task_id, 'task_id'), {
              status: typeof result?.task?.status === 'string' ? result.task.status : null,
            });
          }
          return JSON.stringify(result, null, 2);
        } finally {
          pendingStart?.settle();
        }
      },
      }),
    },
  };
};

export default DevRyanManagedOrchestrationPlugin;
