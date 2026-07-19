import { spawn } from 'child_process';
import { existsSync, statSync } from 'fs';
import { CLAUDE_CODE_STATUS_PATH } from './claude-code-status.js';

export const CLAUDE_CODE_REFRESH_FAILED_CODE = 'claude_code_refresh_failed';
export const CLAUDE_CODE_SESSION_LIMIT_CODE = 'claude_code_session_limit';

const DEFAULT_REFRESH_PROMPT = 'Reply with exactly: OK';
const DEFAULT_REFRESH_TIMEOUT_MS = 45000;
const DEFAULT_STATUS_WAIT_MS = 2000;
const STATUS_POLL_INTERVAL_MS = 100;
const OUTPUT_LIMIT = 2000;

const appendBoundedOutput = (current, chunk) => {
  const next = `${current}${String(chunk)}`;
  return next.length > OUTPUT_LIMIT ? next.slice(-OUTPUT_LIMIT) : next;
};

const isSessionLimitMessage = (message) => /(?:hit|reached|exceeded)[\s\S]{0,80}(?:session|usage)[\s\S]{0,40}limit/i.test(message);

const getStatusMtimeMs = (statusPath) => {
  try {
    if (!existsSync(statusPath)) {
      return null;
    }
    const stats = statSync(statusPath);
    return stats.isFile() ? stats.mtimeMs : null;
  } catch {
    return null;
  }
};

const waitForStatusRefresh = ({ statusPath, previousMtimeMs, timeoutMs }) => new Promise((resolve) => {
  const deadline = Date.now() + timeoutMs;
  const check = () => {
    const nextMtimeMs = getStatusMtimeMs(statusPath);
    if (nextMtimeMs !== null && (previousMtimeMs === null || nextMtimeMs > previousMtimeMs)) {
      resolve(true);
      return;
    }
    if (Date.now() >= deadline) {
      resolve(false);
      return;
    }
    setTimeout(check, STATUS_POLL_INTERVAL_MS);
  };
  check();
});

export const refreshClaudeCodeStatusUsage = ({
  command = process.env.CLAUDE_CODE_CLI || 'claude',
  args = ['-p', DEFAULT_REFRESH_PROMPT, '--output-format', 'text'],
  timeoutMs = DEFAULT_REFRESH_TIMEOUT_MS,
  statusPath = CLAUDE_CODE_STATUS_PATH,
  statusWaitMs = DEFAULT_STATUS_WAIT_MS,
  spawnImpl = spawn,
  env = process.env,
} = {}) => new Promise((resolve) => {
  let settled = false;
  let stdout = '';
  let stderr = '';
  const previousMtimeMs = getStatusMtimeMs(statusPath);

  const finish = (result) => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    resolve(result);
  };

  const child = spawnImpl(command, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const timer = setTimeout(() => {
    child.kill?.('SIGTERM');
    finish({
      ok: false,
      code: CLAUDE_CODE_REFRESH_FAILED_CODE,
      error: 'Timed out while refreshing Claude Code usage.',
    });
  }, timeoutMs);

  child.stdout?.on?.('data', (chunk) => {
    stdout = appendBoundedOutput(stdout, chunk);
  });
  child.stderr?.on?.('data', (chunk) => {
    stderr = appendBoundedOutput(stderr, chunk);
  });

  child.on?.('error', (error) => {
    finish({
      ok: false,
      code: CLAUDE_CODE_REFRESH_FAILED_CODE,
      error: error?.code === 'ENOENT'
        ? 'Claude Code was not found on PATH, so DevRyan could not refresh usage automatically.'
        : error instanceof Error
          ? error.message
          : 'Failed to refresh Claude Code usage.',
    });
  });

  child.on?.('close', async (code) => {
    if (code === 0) {
      const refreshed = await waitForStatusRefresh({ statusPath, previousMtimeMs, timeoutMs: statusWaitMs });
      if (refreshed) {
        finish({ ok: true });
        return;
      }

      finish({
        ok: false,
        code: CLAUDE_CODE_REFRESH_FAILED_CODE,
        error: 'Claude Code ran successfully, but did not emit fresh usage data for DevRyan to read.',
      });
      return;
    }

    const detail = stderr.trim() || stdout.trim();
    finish({
      ok: false,
      code: isSessionLimitMessage(detail)
        ? CLAUDE_CODE_SESSION_LIMIT_CODE
        : CLAUDE_CODE_REFRESH_FAILED_CODE,
      error: detail || `Claude Code exited with code ${code}.`,
    });
  });
});
