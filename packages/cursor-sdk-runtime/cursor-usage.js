// SDK run totals are cumulative. Never add them to per-turn onDelta/stream
// counts or use them as the current context-window occupancy.
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = (value) => typeof value === 'string' && value.length <= 200 && !/[\r\n]/.test(value)
  ? value.trim() : '';
const count = (value) => Number.isSafeInteger(value) && value >= 0;

export const normalizeCursorUsage = (value) => {
  if (!isRecord(value)) return null;
  const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
  if (!fields.every((key) => count(value[key]))) return null;
  const totalTokens = fields.reduce((sum, key) => sum + value[key], 0);
  if (!count(totalTokens)) return null;
  return {
    ...Object.fromEntries(fields.map((key) => [key, value[key]])),
    totalTokens,
    ...(count(value.reasoningTokens) && value.reasoningTokens <= value.outputTokens
      ? { reasoningTokens: value.reasoningTokens } : {}),
  };
};

const normalizeModel = (model) => {
  if (!isRecord(model) || !identifier(model.id)) return null;
  return {
    id: identifier(model.id),
    ...(Array.isArray(model.params) ? { params: model.params.slice(0, 32)
      .filter((param) => isRecord(param) && identifier(param.id) && identifier(param.value))
      .map((param) => ({ id: identifier(param.id), value: identifier(param.value) })) } : {}),
  };
};

export const cursorRunUsageObservation = (run, result = null) => {
  const tokens = normalizeCursorUsage(result?.usage) || normalizeCursorUsage(run?.usage);
  const status = result?.status || run?.status;
  return {
    schemaVersion: 1,
    scope: 'run',
    source: normalizeCursorUsage(result?.usage) ? 'sdk-run-result' : 'sdk-run-snapshot',
    availability: tokens ? 'reported' : 'unavailable',
    agentID: identifier(run?.agentId),
    runID: identifier(result?.id) || identifier(run?.id),
    requestID: identifier(result?.requestId) || identifier(run?.requestId),
    status: ['running', 'finished', 'error', 'cancelled'].includes(status) ? status : 'unknown',
    model: normalizeModel(result?.model || run?.model),
    tokens,
  };
};

// Worker payloads cross a process boundary. Project only the fields we own;
// never persist arbitrary SDK results, prompts, headers, or tool output here.
export const normalizeCursorUsageObservation = (value) => {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.scope !== 'run'
    || !['sdk-run-result', 'sdk-run-snapshot'].includes(value.source)) return null;
  const observation = cursorRunUsageObservation({
    agentId: value.agentID, id: value.runID, requestId: value.requestID,
    status: value.status, model: value.model, usage: value.tokens,
  });
  return { ...observation, source: value.source };
};

// A worker's final-result channel can overtake older queued stream snapshots.
// Preserve terminal/known consumption while draining that tail, including when
// wait() failed and only the last native snapshot is available.
export const mergeCursorUsageObservation = (previous, value) => {
  let next = normalizeCursorUsageObservation(value);
  if (!next) return previous;
  if (!previous) return next;
  if (next.source !== 'sdk-run-result') {
    if (previous.source === 'sdk-run-result') return previous;
    if (previous.tokens && (!next.tokens || next.tokens.totalTokens < previous.tokens.totalTokens)) {
      next = { ...next, tokens: previous.tokens, availability: previous.availability };
    }
    if (['finished', 'error', 'cancelled'].includes(previous.status) && next.status !== previous.status) {
      next = { ...next, status: previous.status };
    }
  }
  return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
};
