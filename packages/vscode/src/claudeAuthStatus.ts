import { spawn } from 'child_process';

export const CLAUDE_AUTH_STATUS_TIMEOUT_MS = 10_000;
export const CLAUDE_AUTH_STATUS_OUTPUT_LIMIT = 4_000;

export type ClaudeCodeAuthDetails = {
  loggedIn: boolean;
  authMethod?: string;
  apiProvider?: string;
  subscriptionType?: string;
};

export type ClaudeCodeAuthStatusResult =
  | { ok: true; auth: ClaudeCodeAuthDetails }
  | { ok: false; code: string; error: string; auth?: ClaudeCodeAuthDetails };

const appendBoundedOutput = (current: string, chunk: unknown, limit = CLAUDE_AUTH_STATUS_OUTPUT_LIMIT) => {
  const next = `${current}${String(chunk)}`;
  return next.length > limit ? next.slice(-limit) : next;
};

const readSafeAuthDetails = (value: unknown): ClaudeCodeAuthDetails | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.loggedIn !== 'boolean') {
    return null;
  }
  return {
    loggedIn: record.loggedIn,
    ...(typeof record.authMethod === 'string' ? { authMethod: record.authMethod } : {}),
    ...(typeof record.apiProvider === 'string' ? { apiProvider: record.apiProvider } : {}),
    ...(typeof record.subscriptionType === 'string' ? { subscriptionType: record.subscriptionType } : {}),
  };
};

const parseAuthDetails = (stdout: string) => {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return readSafeAuthDetails(JSON.parse(trimmed));
  } catch {
    return null;
  }
};

export const runClaudeCodeAuthStatus = ({
  executable = process.env.CLAUDE_CODE_CLI || 'claude',
  pathValue = process.env.PATH || '',
  spawnImpl = spawn,
  timeoutMs = CLAUDE_AUTH_STATUS_TIMEOUT_MS,
  env = process.env,
}: {
  executable?: string;
  pathValue?: string;
  spawnImpl?: typeof spawn;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<ClaudeCodeAuthStatusResult> => new Promise((resolve) => {
  let settled = false;
  let stdout = '';
  let stderr = '';
  let timer: NodeJS.Timeout | null = null;

  const finish = (result: ClaudeCodeAuthStatusResult) => {
    if (settled) {
      return;
    }
    settled = true;
    if (timer) {
      clearTimeout(timer);
    }
    resolve(result);
  };

  let child;
  try {
    child = spawnImpl(executable, ['auth', 'status', '--json'], {
      env: { ...env, PATH: pathValue },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const launchError = error as NodeJS.ErrnoException;
    finish({
      ok: false,
      code: launchError.code === 'ENOENT' ? 'claude_cli_unavailable' : 'claude_auth_status_failed',
      error: launchError.code === 'ENOENT'
        ? 'Claude Code was not found on PATH.'
        : launchError.message || 'Failed to check Claude Code authentication.',
    });
    return;
  }

  timer = setTimeout(() => {
    child.kill?.('SIGTERM');
    finish({
      ok: false,
      code: 'claude_auth_status_timeout',
      error: 'Timed out while checking Claude Code authentication.',
    });
  }, timeoutMs);

  child.stdout?.on('data', (chunk) => {
    stdout = appendBoundedOutput(stdout, chunk);
  });
  child.stderr?.on('data', (chunk) => {
    stderr = appendBoundedOutput(stderr, chunk);
  });

  child.on('error', (error: NodeJS.ErrnoException) => {
    finish({
      ok: false,
      code: error.code === 'ENOENT' ? 'claude_cli_unavailable' : 'claude_auth_status_failed',
      error: error.code === 'ENOENT'
        ? 'Claude Code was not found on PATH.'
        : error.message || 'Failed to check Claude Code authentication.',
    });
  });

  child.on('close', (exitCode, signal) => {
    const auth = parseAuthDetails(stdout);
    if (exitCode === 0 && auth?.loggedIn) {
      finish({ ok: true, auth });
      return;
    }

    if (auth && !auth.loggedIn) {
      finish({
        ok: false,
        code: 'claude_not_authenticated',
        error: 'Claude Code is not signed in. Run `claude auth login` and try again.',
        auth,
      });
      return;
    }

    const detail = stderr.trim();
    finish({
      ok: false,
      code: 'claude_auth_status_failed',
      error: detail
        || (signal
          ? `Claude Code authentication check ended with signal ${signal}.`
          : `Claude Code authentication check exited with code ${exitCode}.`),
    });
  });
});
