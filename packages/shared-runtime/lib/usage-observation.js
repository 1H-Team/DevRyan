// Content-free accounting. Context occupancy and subscription quotas deliberately
// do not use this contract. Null means unobserved, including missing zero fields.
export const USAGE_TOKEN_FIELDS = Object.freeze([
  'totalInput', 'uncachedInput', 'cacheRead', 'cacheWrite', 'cacheWrite5m',
  'cacheWrite1h', 'cacheWrite30m', 'output', 'reasoning', 'totalOutput',
]);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const label = value => typeof value === 'string' && /^[a-zA-Z0-9_.:/-]{1,200}$/.test(value)
  && !/^(?:sk-[a-zA-Z0-9_-]{16,}|xai-[a-zA-Z0-9_-]{32,}|gh[opusr]_|github_pat_|eyJ)/.test(value) ? value : null;
const choice = (value, values, fallback = null) => values.includes(value) ? value : fallback;
const sum = (...values) => values.every(value => value !== null) ? count(values.reduce((a, b) => a + b, 0)) : null;
const subtract = (a, ...values) => { const total = sum(...values); return a !== null && total !== null ? count(a - total) : null; };

export function normalizeUsageTokens(raw = {}, semantics = {}) {
  raw = raw && typeof raw === 'object' ? raw : {};
  semantics = semantics && typeof semantics === 'object' ? semantics : {};
  const input = count(raw.input), cacheRead = count(raw.cacheRead), cacheWrite = count(raw.cacheWrite);
  const output = count(raw.output), reasoning = count(raw.reasoning);
  const inclusive = semantics.input === 'inclusive';
  const exclusive = semantics.input === 'uncached';
  return {
    totalInput: inclusive ? input : exclusive ? sum(input, cacheRead, cacheWrite) : null,
    uncachedInput: exclusive ? input : inclusive ? subtract(input, cacheRead, cacheWrite) : null,
    cacheRead, cacheWrite,
    cacheWrite5m: count(raw.cacheWrite5m), cacheWrite1h: count(raw.cacheWrite1h), cacheWrite30m: count(raw.cacheWrite30m),
    output: semantics.output === 'exclusive' ? output : semantics.output === 'inclusive' ? subtract(output, reasoning) : null,
    reasoning,
    totalOutput: semantics.output === 'inclusive' ? output : semantics.output === 'exclusive' ? sum(output, reasoning) : null,
  };
}

// A closed projection, also used at the journal boundary. Never carry provider
// blobs, prompts, arbitrary metadata, reasoning content or credentials forward.
export function projectUsageObservation(value) {
  if (value?.version !== 1 || !['provider_request', 'runtime_step', 'message_aggregate'].includes(value.source)
    || !label(value.observationID)) return null;
  const result = { version: 1, source: value.source };
  for (const key of ['observationID', 'rootTaskID', 'rootSessionID', 'sessionID', 'messageID', 'parentMessageID', 'stepID',
    'attemptID', 'responseID', 'counterScopeID', 'provider', 'route', 'runtimeVersion', 'requestedModel', 'responseModel']) result[key] = label(value[key]);
  result.purpose = choice(value.purpose, ['main', 'title', 'compaction', 'commit', 'pr', 'other_helper', 'unknown'], 'unknown');
  result.auth = choice(value.auth, ['api_key', 'oauth', 'unknown'], 'unknown');
  result.transport = choice(value.transport, ['responses', 'chat_completions', 'messages', 'native', 'unknown'], 'unknown');
  result.status = choice(value.status, ['dispatched', 'complete', 'failed', 'aborted', 'unknown'], 'unknown');
  result.use = choice(value.use, ['first', 'warm', 'unknown'], 'unknown');
  result.counterMode = choice(value.counterMode, ['delta', 'cumulative'], 'delta');
  result.cumulativeFromZero = value.cumulativeFromZero === true;
  result.sequence = count(value.sequence);
  result.observedAt = amount(value.observedAt);
  result.tokens = Object.fromEntries(USAGE_TOKEN_FIELDS.map(key => [key, count(value.tokens?.[key])]));
  result.semantics = {
    input: choice(value.semantics?.input, ['inclusive', 'uncached', 'unknown'], 'unknown'),
    output: choice(value.semantics?.output, ['inclusive', 'exclusive', 'unknown'], 'unknown'),
  };
  result.cost = {
    amount: amount(value.cost?.amount), currency: value.cost?.currency === 'USD' ? 'USD' : null,
    provenance: choice(value.cost?.provenance, ['provider_billed', 'runtime_reported', 'api_price_equivalent', 'unknown'], 'unknown'),
  };
  result.timing = Object.fromEntries(['dispatch', 'firstToken', 'completion', 'previousCompletion'].map(key => [key, {
    at: amount(value.timing?.[key]?.at),
    origin: choice(value.timing?.[key]?.origin, ['client_wire', 'runtime', 'native', 'unknown'], 'unknown'),
  }]));
  return result;
}

export function normalizeUsageObservation({ raw, semantics, ...metadata }) {
  return projectUsageObservation({ ...metadata, version: 1, semantics, tokens: normalizeUsageTokens(raw, semantics) });
}

export function runtimeUsageObservation(record) {
  if (record?.type !== 'open_code_event') return null;
  const event = record.payload, info = event?.properties?.info, part = event?.properties?.part;
  const step = event?.type === 'message.part.updated' && part?.type === 'step-finish';
  const message = event?.type === 'message.updated' && info?.role === 'assistant' && amount(info.time?.completed) !== null;
  const entry = step ? part : message ? info : null;
  if (!entry || !label(entry.id)) return null;
  const sessionID = record.sessionID ?? entry.sessionID;
  const tokens = entry.tokens ?? {};
  return normalizeUsageObservation({
    observationID: entry.id, source: step ? 'runtime_step' : 'message_aggregate', sessionID,
    messageID: step ? entry.messageID : entry.id, parentMessageID: step ? null : entry.parentID, stepID: step ? entry.id : null,
    provider: entry.providerID, requestedModel: entry.modelID, runtimeVersion: record.runtimeVersion,
    // OpenCode's modelID is a selection, not an attested provider response.
    purpose: entry.summary === true || entry.agent === 'compaction' ? 'compaction'
      : ({ 'devryan-title': 'title', 'devryan-commit': 'commit', 'devryan-pr': 'pr' }[entry.agent]
        ?? (['build', 'builder', 'plan', 'planner', 'orchestrator', 'ask', 'general'].includes(entry.agent) ? 'main' : 'unknown')),
    status: entry.error ? 'failed' : 'complete', observedAt: record.at,
    semantics: { input: 'uncached', output: 'exclusive' },
    raw: { input: tokens.input, output: tokens.output, reasoning: tokens.reasoning,
      cacheRead: tokens.cache?.read, cacheWrite: tokens.cache?.write },
    cost: { amount: entry.cost, currency: 'USD', provenance: 'runtime_reported' },
    timing: { completion: { at: entry.time?.completed ?? entry.time?.end, origin: 'runtime' } },
  });
}

// Native transcript message usage is a provider response snapshot; native CLI
// cumulative cost/result summaries are deliberately not attached to it.
export function nativeClaudeUsageObservation(message, context = {}) {
  if (!label(message?.id) || !label(message?.model) || message.model === '<synthetic>') return null;
  const usage = message.usage ?? {};
  return normalizeUsageObservation({ ...context, source: 'provider_request', observationID: message.id,
    responseID: message.id, responseModel: message.model, provider: 'anthropic', transport: 'native',
    semantics: { input: 'uncached', output: 'inclusive' },
    raw: { input: usage.input_tokens, cacheRead: usage.cache_read_input_tokens, cacheWrite: usage.cache_creation_input_tokens,
      cacheWrite5m: usage.cache_creation?.ephemeral_5m_input_tokens, cacheWrite1h: usage.cache_creation?.ephemeral_1h_input_tokens,
      output: usage.output_tokens, reasoning: usage.output_tokens_details?.thinking_tokens } });
}

export function nativeCodexUsageObservation(usage, context = {}) {
  const cumulative = context.counterMode === 'cumulative';
  const tokens = cumulative ? usage?.total : usage?.last;
  if (!tokens) return null;
  return normalizeUsageObservation({ ...context, source: 'runtime_step', provider: 'openai', transport: 'native', responseModel: null,
    semantics: { input: 'inclusive', output: context.outputSemantics ?? 'unknown' },
    raw: { input: tokens.inputTokens, cacheRead: tokens.cachedInputTokens,
      // Older native versions deserialize missing writes as zero. A zero needs
      // separate capability evidence; a positive count is an observation.
      cacheWrite: context.cacheWritesReported === true || tokens.cacheWriteInputTokens > 0 ? tokens.cacheWriteInputTokens : undefined,
      output: tokens.outputTokens, reasoning: tokens.reasoningOutputTokens } });
}

// Prices must be supplied with their model/route qualification by the caller.
// No hard-coded price, inferred write lifetime, or subscription conversion.
export function estimateApiEquivalent(tokens, prices) {
  if (!prices || prices.currency !== 'USD') return null;
  let usd = 0;
  for (const [field, rate] of [['uncachedInput', 'input'], ['cacheRead', 'cacheRead']]) {
    if (count(tokens?.[field]) === null || (tokens[field] > 0 && amount(prices[rate]) === null)) return null;
    usd += tokens[field] * (prices[rate] ?? 0) / 1_000_000;
  }
  if (count(tokens.output) !== null && count(tokens.reasoning) !== null) {
    for (const key of ['output', 'reasoning']) {
      if (tokens[key] > 0 && amount(prices[key]) === null) return null;
      usd += tokens[key] * (prices[key] ?? 0) / 1_000_000;
    }
  } else if (count(tokens.totalOutput) !== null && amount(prices.output) !== null && prices.output === prices.reasoning) {
    usd += tokens.totalOutput * prices.output / 1_000_000;
  } else return null;
  if (count(tokens?.cacheWrite) === null) return null;
  if (tokens.cacheWrite > 0) {
    if (amount(prices.cacheWrite) !== null) usd += tokens.cacheWrite * prices.cacheWrite / 1_000_000;
    else {
      const lifetimes = ['cacheWrite5m', 'cacheWrite1h', 'cacheWrite30m'];
      if (sum(...lifetimes.map(key => count(tokens[key]) ?? 0)) !== tokens.cacheWrite) return null;
      for (const key of lifetimes) {
        if (tokens[key] > 0 && amount(prices[key]) === null) return null;
        usd += (tokens[key] ?? 0) * (prices[key] ?? 0) / 1_000_000;
      }
    }
  }
  return { amount: usd, currency: 'USD', provenance: 'api_price_equivalent' };
}
