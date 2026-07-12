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
const DEFAULT_TIMEOUT_SECONDS = 30 * 60;
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

const callRpc = async (method, params, context) => {
  const bridge = getBridge();
  const response = await fetch(bridge.url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bridge.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ method, params }),
    signal: context.abort,
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
      ? Math.min(MAX_TIMEOUT_SECONDS, Math.max(1, Math.trunc(args.timeout_seconds)))
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
    }, context);
  }

  const scoped = buildScopedParams(args, context);
  if (action === 'status' || action === 'wait') {
    return await callRpc(action, scoped, context);
  }
  if (action === 'cancel') {
    return await callRpc('cancel', {
      ...scoped,
      cascade: args.cascade === true,
      ...(typeof args.reason === 'string' && args.reason.trim()
        ? { reason: args.reason.trim() }
        : {}),
    }, context);
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
    }, context);
  }

  throw new Error(`Unsupported managed task action: ${action}`);
};

export const DevRyanManagedOrchestrationPlugin = async ({ client } = {}) => ({
  tool: {
    devryan_task: tool({
      description: 'Start or control a DevRyan-managed sub-agent. DevRyan enforces a global maximum of three concurrent managed children, queues excess work deterministically, and preserves partial results after failure or abort. This is distinct from provider-native task orchestration.',
      args: {
        action: tool.schema.enum(ACTIONS).describe('Action: start, status, wait, cancel, continue, retry, resume, or abandon.'),
        task_id: tool.schema.string().optional().describe('Managed dvr_task_ ID. Required for every action except start.'),
        label: tool.schema.string().optional().describe('Short task label for start or retry.'),
        prompt: tool.schema.string().optional().describe('Full delegated prompt for start, or an optional retry override.'),
        provider_id: tool.schema.string().optional().describe('Provider ID for start or an optional retry/resume override.'),
        model_id: tool.schema.string().optional().describe('Model ID for start or an optional retry/resume override.'),
        agent: tool.schema.string().optional().describe('Agent name for start or an optional retry/resume override.'),
        variant: tool.schema.string().optional().describe('Optional model variant.'),
        timeout_seconds: tool.schema.number().int().min(1).max(MAX_TIMEOUT_SECONDS).optional().describe('Start timeout in seconds. Defaults to 1800.'),
        cascade: tool.schema.boolean().optional().describe('For cancel only: also cancel explicit managed descendants.'),
        reason: tool.schema.string().optional().describe('Optional cancellation reason.'),
      },
      async execute(args, context) {
        const result = await executeAction(args, context, client);
        return JSON.stringify(result, null, 2);
      },
    }),
  },
});

export default DevRyanManagedOrchestrationPlugin;
