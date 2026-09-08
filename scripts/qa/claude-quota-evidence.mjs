// Content-free evidence for opt-in Claude comparisons. Importing this module
// never reads credentials, installed state, or contacts a provider.
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { createInterface } from 'node:readline';

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const tokenKeys = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];

export function projectNativeAssistant(row) {
  if (row?.type !== 'assistant' || typeof row.message?.id !== 'string'
    || typeof row.message.model !== 'string' || row.message.model === '<synthetic>') return null;
  const at = Date.parse(row.timestamp);
  const usage = row.message.usage;
  if (!Number.isFinite(at) || !usage || tokenKeys.some(key => count(usage[key]) === null)) return null;
  return {
    messageId: row.message.id,
    requestId: typeof row.requestId === 'string' ? row.requestId : null,
    sessionId: typeof row.sessionId === 'string' ? row.sessionId : null,
    at, model: row.message.model, version: row.version ?? null,
    usage: Object.fromEntries(tokenKeys.map(key => [key, usage[key]])),
    cacheCreation: {
      fiveMinuteTokens: count(usage.cache_creation?.ephemeral_5m_input_tokens),
      oneHourTokens: count(usage.cache_creation?.ephemeral_1h_input_tokens),
    },
    tools: (Array.isArray(row.message.content) ? row.message.content : [])
      .filter(block => block?.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string')
      .map(block => ({ id: block.id, name: block.name })),
  };
}

export function summarizeNativeAssistants(rows, { since = 0, until = Infinity, excludeIds = [] } = {}) {
  const excluded = new Set(excludeIds);
  const unique = new Map();
  const transcriptSessions = new Set();
  for (const row of rows) {
    if (!row || row.at < since || row.at > until || excluded.has(row.messageId)) continue;
    if (row.sessionId) transcriptSessions.add(row.sessionId);
    const previous = unique.get(row.messageId);
    // Native transcripts repeat one response across content blocks and resume
    // copies. Count the provider message once; retain all distinct tool IDs.
    const tools = new Map([...(previous?.tools ?? []), ...row.tools].map(tool => [tool.id, tool]));
    if (!previous || row.at >= previous.at) unique.set(row.messageId, { ...row, tools: [...tools.values()] });
    else previous.tools = [...tools.values()];
  }
  const requests = [...unique.values()].sort((a, b) => a.at - b.at);
  const usage = Object.fromEntries(tokenKeys.map(key => [key, requests.reduce((sum, row) => sum + row.usage[key], 0)]));
  const processedInput = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
  const models = {};
  const tools = {};
  for (const request of requests) {
    models[request.model] = (models[request.model] ?? 0) + 1;
    for (const tool of request.tools) tools[tool.name] = (tools[tool.name] ?? 0) + 1;
  }
  return {
    source: 'native-transcript', observedResponseCount: requests.length,
    // Failed attempts without an assistant usage record are not represented.
    providerAttemptCount: null,
    models, usage, processedInput,
    cacheReadRatio: processedInput ? usage.cache_read_input_tokens / processedInput : null,
    // Forked files can copy earlier provider responses under a new session ID.
    // Count observed transcript IDs before usage deduplication; this does not
    // assign a copied response to a particular SDK invocation.
    transcriptSessionCount: transcriptSessions.size,
    tools, requests,
  };
}

export async function readNativeAssistants(files) {
  const rows = [];
  const gaps = [];
  for (const file of files) {
    try {
      const size = (await fs.stat(file)).size;
      if (size > 128 * 1024 * 1024) { gaps.push({ file, reason: 'file_limit' }); continue; }
      const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
      let lineNumber = 0;
      for await (const line of lines) {
        lineNumber++;
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          const row = projectNativeAssistant(parsed);
          if (row) rows.push(row);
          else if (parsed?.type === 'assistant' && parsed.message?.usage && parsed.message.model !== '<synthetic>') {
            gaps.push({ file, line: lineNumber, reason: 'invalid_usage' });
          }
        } catch { gaps.push({ file, line: lineNumber, reason: 'parse_failure' }); }
      }
    } catch { gaps.push({ file, reason: 'read_failure' }); }
  }
  return { rows, gaps };
}

export function projectQuota(payload, { now = Date.now(), maximumAgeMs = 90_000 } = {}) {
  const fetchedAt = payload?.sources?.oauth?.fetchedAt;
  if (!Number.isFinite(fetchedAt) || fetchedAt > now + 5000 || now - fetchedAt > maximumAgeMs) {
    throw new Error('Authoritative Claude quota is missing or stale');
  }
  const windows = {};
  for (const bucket of payload.buckets ?? []) {
    if (typeof bucket.type !== 'string' || !/^(five_hour|seven_day(?:_[a-z0-9_]+)?)$/.test(bucket.type)) continue;
    const inactive = bucket.utilization === 0 && bucket.resetsAt === null;
    if (!Number.isFinite(bucket.utilization) || bucket.utilization < 0 || (!inactive && !Number.isFinite(bucket.resetsAt))) continue;
    windows[bucket.type] = {
      usedPercent: Number((bucket.utilization * 100).toFixed(6)),
      resetsAt: bucket.resetsAt,
      observedAt: bucket.observedAt ?? fetchedAt,
      isUsingOverage: bucket.isUsingOverage === true,
      ...(inactive ? { inactive: true } : {}),
    };
  }
  if (!windows.five_hour || !windows.seven_day) throw new Error('Claude quota has no primary windows');
  return { observedAt: now, fetchedAt, windows, extraUsageEnabled: payload.extraUsage?.isEnabled ?? null };
}

export function compareQuota(before, after, { completedAt, reportingDelayMs = 0 } = {}) {
  const deltas = {};
  const invalid = [];
  for (const [key, start] of Object.entries(before.windows)) {
    const end = after.windows[key];
    // Meridian reconstructs some CLI reset timestamps against Date.now();
    // repeated observations of one reset can differ by about a second.
    const inactiveStart = start.inactive === true && start.usedPercent === 0 && start.resetsAt === null;
    const inactiveEnd = end?.inactive === true && end.usedPercent === 0 && end.resetsAt === null;
    const activation = inactiveStart && end && !inactiveEnd && Number.isFinite(end.resetsAt) && end.resetsAt > after.fetchedAt;
    const sameWindow = inactiveStart ? inactiveEnd : end && !inactiveEnd && Math.abs(start.resetsAt - end.resetsAt) <= 5000;
    if (!end || (!sameWindow && !activation) || end.usedPercent < start.usedPercent) {
      invalid.push(key);
      continue;
    }
    deltas[key] = Number((end.usedPercent - start.usedPercent).toFixed(6));
  }
  if (Number.isFinite(completedAt) && after.fetchedAt <= completedAt + reportingDelayMs) invalid.push('after_work_completion');
  return { valid: invalid.length === 0 && after.fetchedAt > before.fetchedAt, deltas, invalid };
}

export function checkQuotaAdmission(start, current, { limitPoints = 20, reservePoints = 2, carriedConsumedPoints = 0,
  activatedFiveHourReset, minimumWindowRemainingMs = 0, now = Date.now() } = {}) {
  if (!Number.isFinite(limitPoints) || limitPoints <= 0 || limitPoints > 40
    || !Number.isFinite(reservePoints) || reservePoints < 0 || reservePoints >= limitPoints
    || !Number.isFinite(carriedConsumedPoints) || carriedConsumedPoints < 0
    || !Number.isFinite(minimumWindowRemainingMs) || minimumWindowRemainingMs < 0) {
    throw new Error('Invalid Claude quota study budget');
  }
  if (now - current.fetchedAt > 90_000) return { allowed: false, reason: 'stale_quota' };
  if (activatedFiveHourReset !== undefined && !Number.isFinite(activatedFiveHourReset)) throw new Error('Invalid quota window activation');
  if (start.windows.five_hour.inactive === true) {
    if (activatedFiveHourReset === undefined && current.windows.five_hour.inactive !== true) {
      return { allowed: false, reason: 'quota_window_activation_required' };
    }
    if (activatedFiveHourReset !== undefined && (current.windows.five_hour.inactive === true
      || Math.abs(current.windows.five_hour.resetsAt - activatedFiveHourReset) > 5000)) {
      return { allowed: false, reason: 'quota_window_changed' };
    }
  }
  const comparison = compareQuota(start, current);
  if (comparison.invalid.includes('five_hour')) return { allowed: false, reason: 'quota_window_changed' };
  if (Object.values(current.windows).some(window => window.isUsingOverage || window.usedPercent >= 100)) {
    return { allowed: false, reason: 'quota_exhausted_or_overage' };
  }
  if (Object.values(current.windows).some(window => Number.isFinite(window.resetsAt)
    && window.resetsAt - now <= minimumWindowRemainingMs)) return { allowed: false, reason: 'quota_window_ending' };
  const consumedPoints = carriedConsumedPoints + comparison.deltas.five_hour;
  return {
    allowed: Number.isFinite(consumedPoints) && consumedPoints < limitPoints - reservePoints,
    reason: consumedPoints < limitPoints - reservePoints ? null : 'study_budget', consumedPoints,
  };
}
