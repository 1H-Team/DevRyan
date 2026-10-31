import { buildResult, toUsageWindow } from '../utils/index.js';

/**
 * Claude subscription usage as Claude Code itself reports it: its `/usage` answer,
 * which the native host asks for without a model turn, and the `rate_limit_event`
 * windows of each claude-agent turn. DevRyan never reads Claude Code's login or
 * calls Anthropic's usage endpoints.
 */
export const providerId = 'claude-agent';
export const providerName = 'Claude';
export const aliases = ['claude-agent'];

const FIVE_HOUR_WINDOW_SECONDS = 5 * 60 * 60;
const SEVEN_DAY_WINDOW_SECONDS = 7 * 24 * 60 * 60;
const LABELS = Object.freeze({ five_hour: '5h', seven_day: '7d', seven_day_opus: '7d-opus', seven_day_sonnet: '7d-sonnet' });

/** Maps the recorded windows to the shared usage shape; `utilization` is a 0–1 fraction. */
export const buildClaudeAgentUsage = usage => {
  const windows = {};
  for (const [key, label] of Object.entries(LABELS)) {
    const window = usage?.windows?.[key];
    if (typeof window?.utilization !== 'number') continue;
    windows[label] = toUsageWindow({
      usedPercent: Math.round(window.utilization * 1000) / 10,
      windowSeconds: key === 'five_hour' ? FIVE_HOUR_WINDOW_SECONDS : SEVEN_DAY_WINDOW_SECONDS,
      resetAt: Number.isSafeInteger(window.resetsAt) ? window.resetsAt * 1000 : null,
    });
  }
  // Model-scoped weekly limits Claude Code's `/usage` lists, such as `7d-fable`.
  for (const model of Array.isArray(usage?.models) ? usage.models : []) {
    if (typeof model?.utilization !== 'number' || typeof model.name !== 'string') continue;
    const label = `7d-${model.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
    if (label === '7d-' || windows[label]) continue;
    windows[label] = toUsageWindow({
      usedPercent: Math.round(model.utilization * 1000) / 10,
      windowSeconds: SEVEN_DAY_WINDOW_SECONDS,
      resetAt: Number.isSafeInteger(model.resetsAt) ? model.resetsAt * 1000 : null,
    });
  }
  return { windows };
};

export const isConfigured = () => false;

/** @param {{ readUsage?: () => unknown, available?: boolean }} options */
export const fetchQuota = async ({ readUsage, available = true } = {}) => {
  const usage = readUsage?.();
  const mapped = buildClaudeAgentUsage(usage);
  if (Object.keys(mapped.windows).length) {
    const rejected = Object.values(usage.windows).some(window => window?.status === 'rejected');
    return buildResult({ providerId, providerName, ok: true, configured: true, usage: mapped, usageUpdatedAt: usage.updatedAt,
      ...(rejected ? { warnings: ['Claude Code reported a subscription limit. It resets at the time shown.'] } : {}) });
  }
  return buildResult({ providerId, providerName, ok: false, configured: available, usage: null,
    error: available ? 'Claude Code has not reported usage yet. Check that it is signed in (claude auth login).' : 'Claude Code is not installed.',
    errorCode: available ? 'claude_agent_usage_pending' : 'claude_agent_missing' });
};
