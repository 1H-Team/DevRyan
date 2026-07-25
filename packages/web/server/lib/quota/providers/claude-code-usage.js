import { spawn } from 'child_process';
import { toUsageWindow } from '../utils/index.js';

export const CLAUDE_CODE_USAGE_FAILED_CODE = 'claude_code_usage_failed';

const DEFAULT_TIMEOUT_MS = 15000;
const OUTPUT_LIMIT_BYTES = 64 * 1024;
const FIVE_HOUR_WINDOW_SECONDS = 5 * 60 * 60;
const SEVEN_DAY_WINDOW_SECONDS = 7 * 24 * 60 * 60;

const appendBoundedOutput = (current, chunk) => {
  const next = `${current}${String(chunk)}`;
  if (Buffer.byteLength(next, 'utf8') > OUTPUT_LIMIT_BYTES) {
    return null;
  }
  return next;
};

const parseResetAt = (value, now = Date.now()) => {
  const normalized = value
    .replace(/\s+\([^)]*\)\s*$/, '')
    .replace(/\bat\b/i, '')
    .trim();
  const withYear = /\b\d{4}\b/.test(normalized)
    ? normalized
    : `${normalized} ${new Date(now).getFullYear()}`;
  const timestamp = new Date(withYear).getTime();
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  if (timestamp < now - 24 * 60 * 60 * 1000 && !/\b\d{4}\b/.test(normalized)) {
    return new Date(`${normalized} ${new Date(now).getFullYear() + 1}`).getTime();
  }
  return timestamp;
};

export const parseClaudeCodeUsageOutput = (rawOutput, now = Date.now()) => {
  try {
    const payload = JSON.parse(rawOutput);
    if (!payload || payload.is_error === true || typeof payload.result !== 'string') {
      return { ok: false, code: CLAUDE_CODE_USAGE_FAILED_CODE, error: 'Claude Code returned unexpected usage output.' };
    }

    const windows = {};
    const currentSession = payload.result.match(
      /Current session:\s*([\d.]+)% used\s*·\s*resets\s+([^\r\n]+)/i,
    );
    const currentWeek = payload.result.match(
      /Current week \(all models\):\s*([\d.]+)% used\s*·\s*resets\s+([^\r\n]+)/i,
    );
    if (currentSession) {
      windows['5h'] = toUsageWindow({
        usedPercent: Number(currentSession[1]),
        windowSeconds: FIVE_HOUR_WINDOW_SECONDS,
        resetAt: parseResetAt(currentSession[2], now),
      });
    }
    if (currentWeek) {
      windows['7d'] = toUsageWindow({
        usedPercent: Number(currentWeek[1]),
        windowSeconds: SEVEN_DAY_WINDOW_SECONDS,
        resetAt: parseResetAt(currentWeek[2], now),
      });
    }

    const modelPattern = /Current week \((?!all models\))([^):]+)\):\s*([\d.]+)% used\s*·\s*resets\s+([^\r\n]+)/gi;
    for (const match of payload.result.matchAll(modelPattern)) {
      const model = match[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (!model) continue;
      windows[`7d-${model}`] = toUsageWindow({
        usedPercent: Number(match[2]),
        windowSeconds: SEVEN_DAY_WINDOW_SECONDS,
        resetAt: parseResetAt(match[3], now),
      });
    }

    if (!windows['5h'] && !windows['7d']) {
      return { ok: false, code: CLAUDE_CODE_USAGE_FAILED_CODE, error: 'Claude Code usage output did not contain subscription limits.' };
    }

    return { ok: true, usage: { windows }, usageUpdatedAt: now };
  } catch {
    return { ok: false, code: CLAUDE_CODE_USAGE_FAILED_CODE, error: 'Claude Code returned malformed usage output.' };
  }
};

export const fetchClaudeCodeUsage = ({
  command = process.env.CLAUDE_CODE_CLI || 'claude',
  args = ['/usage', '--output-format', 'json', '--no-session-persistence', '--max-turns', '1'],
  timeoutMs = DEFAULT_TIMEOUT_MS,
  spawnImpl = spawn,
  env = process.env,
  now = Date.now,
} = {}) => new Promise((resolve) => {
  let settled = false;
  let stdout = '';
  let stderr = '';

  const finish = (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(result);
  };

  const child = spawnImpl(command, ['-p', ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const timer = setTimeout(() => {
    child.kill?.('SIGTERM');
    finish({
      ok: false,
      code: CLAUDE_CODE_USAGE_FAILED_CODE,
      error: 'Timed out while reading Claude Code usage.',
    });
  }, timeoutMs);

  child.stdout?.on?.('data', (chunk) => {
    stdout = appendBoundedOutput(stdout, chunk);
    if (stdout === null) {
      child.kill?.('SIGTERM');
      finish({
        ok: false,
        code: CLAUDE_CODE_USAGE_FAILED_CODE,
        error: 'Claude Code usage output exceeded the safe response limit.',
      });
    }
  });
  child.stderr?.on?.('data', (chunk) => {
    stderr = appendBoundedOutput(stderr, chunk);
    if (stderr === null) {
      child.kill?.('SIGTERM');
      finish({
        ok: false,
        code: CLAUDE_CODE_USAGE_FAILED_CODE,
        error: 'Claude Code usage error output exceeded the safe response limit.',
      });
    }
  });
  child.on?.('error', (error) => {
    finish({
      ok: false,
      code: CLAUDE_CODE_USAGE_FAILED_CODE,
      error: error?.code === 'ENOENT'
        ? 'Claude Code was not found on PATH.'
        : error instanceof Error
          ? error.message
          : 'Failed to read Claude Code usage.',
    });
  });
  child.on?.('close', (code) => {
    if (code === 0) {
      finish(parseClaudeCodeUsageOutput(stdout, now()));
      return;
    }
    finish({
      ok: false,
      code: CLAUDE_CODE_USAGE_FAILED_CODE,
      error: stderr.trim() || stdout.trim() || `Claude Code exited with code ${code}.`,
    });
  });
});
