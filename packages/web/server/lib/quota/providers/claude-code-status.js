import { existsSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { toNumber, toTimestamp, toUsageWindow } from '../utils/index.js';

export const CLAUDE_CODE_STATUS_PATH = join(homedir(), '.cache', 'openchamber', 'claude-code-status.json');
export const CLAUDE_CODE_USAGE_UNAVAILABLE_CODE = 'claude_code_usage_pending';
export const CLAUDE_CODE_USAGE_UNAVAILABLE_MESSAGE = 'Claude Code usage data has not been emitted yet.';

const MAX_STATUS_FILE_BYTES = 64 * 1024;
const STATUS_TTL_MS = 24 * 60 * 60 * 1000;
const MONTHLY_WINDOW_SECONDS = 30 * 24 * 60 * 60;

const parsePercent = (value) => {
  const percent = toNumber(value);
  if (percent === null || percent < 0) {
    return null;
  }
  return percent;
};

const pickMonthlyLimit = (rateLimits) => {
  const candidates = [
    rateLimits?.monthly,
    rateLimits?.month,
    rateLimits?.subscription,
    rateLimits?.plan,
  ];
  return candidates.find((entry) => parsePercent(entry?.used_percentage) !== null) ?? null;
};

const getMonthlyWindowSeconds = (monthly) => {
  const candidate = toNumber(
    monthly?.window_seconds ??
    monthly?.windowSeconds ??
    monthly?.limit_window_seconds ??
    monthly?.limitWindowSeconds
  );
  return candidate && candidate > 0 ? candidate : MONTHLY_WINDOW_SECONDS;
};

const getStatusUpdatedAt = (payload, stats) => {
  const explicitTimestamp = toTimestamp(payload?.updated_at ?? payload?.updatedAt ?? payload?.timestamp);
  return explicitTimestamp ?? stats.mtimeMs;
};

export const readClaudeCodeStatusUsage = ({ statusPath = CLAUDE_CODE_STATUS_PATH, now = Date.now() } = {}) => {
  try {
    if (!existsSync(statusPath)) {
      return { ok: false, code: CLAUDE_CODE_USAGE_UNAVAILABLE_CODE, error: CLAUDE_CODE_USAGE_UNAVAILABLE_MESSAGE };
    }

    const stats = statSync(statusPath);
    if (!stats.isFile()) {
      return { ok: false, code: CLAUDE_CODE_USAGE_UNAVAILABLE_CODE, error: CLAUDE_CODE_USAGE_UNAVAILABLE_MESSAGE };
    }
    if (stats.size > MAX_STATUS_FILE_BYTES) {
      return { ok: false, error: 'Claude Code status-line usage file is too large to read safely.' };
    }

    const content = readFileSync(statusPath, 'utf8');
    const payload = JSON.parse(content);
    const updatedAt = getStatusUpdatedAt(payload, stats);
    if (!updatedAt || now - updatedAt > STATUS_TTL_MS) {
      return { ok: false, error: 'Claude Code status-line usage data is stale and cannot be used as a fresh DevRyan result.' };
    }

    const rateLimits = payload?.rate_limits;
    const fiveHour = rateLimits?.five_hour;
    const sevenDay = rateLimits?.seven_day;
    const monthly = pickMonthlyLimit(rateLimits);
    const fiveHourPercent = parsePercent(fiveHour?.used_percentage);
    const sevenDayPercent = parsePercent(sevenDay?.used_percentage);
    const monthlyPercent = parsePercent(monthly?.used_percentage);
    if (fiveHourPercent === null && sevenDayPercent === null && monthlyPercent === null) {
      return { ok: false, error: 'Claude Code status-line usage file does not contain five-hour, seven-day, or monthly rate limit percentages.' };
    }

    const windows = {};
    if (fiveHourPercent !== null) {
      windows['5h'] = toUsageWindow({
        usedPercent: fiveHourPercent,
        windowSeconds: 5 * 60 * 60,
        resetAt: toTimestamp(fiveHour?.resets_at),
      });
    }
    if (sevenDayPercent !== null) {
      windows['7d'] = toUsageWindow({
        usedPercent: sevenDayPercent,
        windowSeconds: 7 * 24 * 60 * 60,
        resetAt: toTimestamp(sevenDay?.resets_at),
      });
    }
    if (monthlyPercent !== null) {
      windows.monthly = toUsageWindow({
        usedPercent: monthlyPercent,
        windowSeconds: getMonthlyWindowSeconds(monthly),
        resetAt: toTimestamp(monthly?.resets_at),
      });
    }

    // Visible review note: monthly naming is best-effort because Claude Code status JSON has changed shape across releases; only explicit percentages are mapped.
    return { ok: true, usage: { windows }, usageUpdatedAt: updatedAt };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof SyntaxError
        ? 'Claude Code status-line usage file is not valid JSON.'
        : error instanceof Error
          ? error.message
          : 'Failed to read Claude Code status-line usage file.',
    };
  }
};
