const isPlainObject = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const trimString = (value) => (typeof value === 'string' ? value.trim() : '');
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const readTokenCount = (value) => (
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
);

const firstStringValue = (...candidates) => {
  for (const candidate of candidates) {
    if (typeof candidate === 'string') return candidate;
  }
  return '';
};

const normalizeToolCallStatus = (status) => {
  const normalized = trimString(status).toLowerCase();
  if (normalized === 'completed' || normalized === 'complete' || normalized === 'done' || normalized === 'success' || normalized === 'finished') return 'completed';
  if (normalized === 'error' || normalized === 'failed' || normalized === 'failure') return 'error';
  if (normalized === 'cancelled' || normalized === 'canceled') return 'cancelled';
  if (normalized === 'pending') return 'pending';
  return 'running';
};

const MAX_NESTED_TEXT_CHARS = 4000;
const MAX_NESTED_VALUE_STRING_CHARS = 2000;
const MAX_NESTED_VALUE_ARRAY_ITEMS = 20;
const MAX_NESTED_VALUE_OBJECT_KEYS = 24;
const MAX_NESTED_VALUE_DEPTH = 4;
const PRIVATE_CURSOR_TASK_RESULT_KEYS = new Set([
  'conversationsteps',
  'conversation_steps',
  'transcriptpath',
  'transcript_path',
]);

const clampText = (value, limit) => {
  if (typeof value !== 'string') return '';
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
};

const sanitizeNestedValue = (value, depth = 0) => {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return clampText(value, MAX_NESTED_VALUE_STRING_CHARS);
  if (depth >= MAX_NESTED_VALUE_DEPTH) return '[truncated]';
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_NESTED_VALUE_ARRAY_ITEMS)
      .map((entry) => sanitizeNestedValue(entry, depth + 1));
  }
  if (!isPlainObject(value)) return undefined;

  const result = {};
  for (const [key, entry] of Object.entries(value).slice(0, MAX_NESTED_VALUE_OBJECT_KEYS)) {
    const normalizedKey = trimString(key);
    if (!normalizedKey) continue;
    if (PRIVATE_CURSOR_TASK_RESULT_KEYS.has(normalizedKey.toLowerCase())) continue;
    const sanitized = sanitizeNestedValue(entry, depth + 1);
    if (sanitized !== undefined) result[normalizedKey] = sanitized;
  }
  return result;
};

const normalizeNestedTaskUpdate = (value) => {
  if (!isPlainObject(value)) return null;
  const type = trimString(value.type);

  if (type === 'text-delta' || type === 'thinking-delta') {
    const text = clampText(firstStringValue(value.text, value.delta), MAX_NESTED_TEXT_CHARS);
    return text ? { type, text } : null;
  }

  if (
    type === 'thinking-completed'
    || type === 'thinking_completed'
    || type === 'thinking-complete'
  ) {
    return { type: 'thinking-completed' };
  }

  if (
    type === 'tool-call-started'
    || type === 'partial-tool-call'
    || type === 'tool-call-completed'
  ) {
    const toolCall = isPlainObject(value.toolCall) ? value.toolCall : {};
    const callID = trimString(value.callId ?? value.call_id ?? toolCall.callId ?? toolCall.call_id ?? toolCall.id);
    if (!callID) return null;
    const explicitStatus = trimString(value.status ?? toolCall.result?.status);
    const status = explicitStatus
      ? normalizeToolCallStatus(explicitStatus)
      : type === 'tool-call-completed'
        ? 'completed'
        : 'running';
    return {
      type: 'tool-call',
      call_id: callID,
      name: trimString(toolCall.name ?? toolCall.type ?? value.name) || 'tool',
      status,
      ...(hasOwn(toolCall, 'args') ? { args: sanitizeNestedValue(toolCall.args) } : {}),
      ...(hasOwn(toolCall, 'result') ? { result: sanitizeNestedValue(toolCall.result) } : {}),
    };
  }

  if (type === 'step-started' || type === 'step-completed') {
    const stepID = typeof value.stepId === 'number' && Number.isFinite(value.stepId)
      ? Math.max(0, Math.floor(value.stepId))
      : null;
    if (stepID === null) return null;
    const durationMs = typeof value.stepDurationMs === 'number' && Number.isFinite(value.stepDurationMs)
      ? Math.max(0, Math.floor(value.stepDurationMs))
      : undefined;
    return {
      type,
      step_id: stepID,
      ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
    };
  }

  return null;
};

export const normalizeInteractionUpdateToSdkMessage = (input) => {
  const update = isPlainObject(input?.update) ? input.update : input;
  if (!isPlainObject(update)) return null;

  if (update.type === 'text-delta' || update.type === 'token-delta') {
    const text = firstStringValue(update.text, update.delta, update.token);
    return text
      ? {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text }],
          },
        }
      : null;
  }

  if (update.type === 'thinking-delta') {
    const text = firstStringValue(update.text, update.delta);
    return text ? { type: 'thinking', text } : null;
  }

  if (
    update.type === 'thinking-completed'
    || update.type === 'thinking_completed'
    || update.type === 'thinking-complete'
  ) {
    return { type: 'thinking_completed' };
  }

  if (
    update.type === 'tool-call-started'
    || update.type === 'partial-tool-call'
    || update.type === 'tool-call-completed'
  ) {
    const toolCall = isPlainObject(update.toolCall) ? update.toolCall : {};
    const callID = trimString(update.callId ?? update.call_id ?? toolCall.callId ?? toolCall.call_id ?? toolCall.id);
    const name = trimString(toolCall.name ?? toolCall.type ?? update.name) || 'tool';
    const explicitStatus = trimString(update.status ?? toolCall.result?.status);
    const status = explicitStatus
      ? normalizeToolCallStatus(explicitStatus)
      : update.type === 'tool-call-completed'
        ? 'completed'
        : 'running';
    return {
      type: 'tool_call',
      call_id: callID,
      name,
      status,
      ...(hasOwn(toolCall, 'args') ? { args: toolCall.args } : {}),
      ...(hasOwn(toolCall, 'result') ? { result: toolCall.result } : {}),
      ...(isPlainObject(toolCall.truncated) ? { truncated: toolCall.truncated } : {}),
    };
  }

  if (update.type === 'tool-call-delta') {
    const callID = trimString(update.callId ?? update.call_id);
    const nestedUpdate = normalizeNestedTaskUpdate(update.taskUpdate ?? update.task_update);
    if (!callID || !nestedUpdate) return null;
    return {
      type: 'task_activity',
      call_id: callID,
      model_call_id: trimString(update.modelCallId ?? update.model_call_id),
      update: nestedUpdate,
    };
  }

  if (update.type === 'summary') {
    const text = trimString(update.summary ?? update.text);
    return text ? { type: 'task', text } : null;
  }

  if (update.type === 'turn-ended') {
    const usage = isPlainObject(update.usage) ? update.usage : null;
    if (!usage) return null;
    const tokens = {
      input: readTokenCount(usage.inputTokens),
      output: readTokenCount(usage.outputTokens),
      reasoning: 0,
      cache: { read: readTokenCount(usage.cacheReadTokens), write: readTokenCount(usage.cacheWriteTokens) },
    };
    const hasUsage = tokens.input || tokens.output || tokens.cache.read || tokens.cache.write;
    return hasUsage ? { type: 'usage', tokens } : null;
  }

  return null;
};
