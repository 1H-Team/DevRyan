import { spawn } from 'child_process';

export const CLAUDE_AUTH_STATUS_TIMEOUT_MS = 10_000;
export const CLAUDE_AUTH_STATUS_OUTPUT_LIMIT = 4_000;

const appendBoundedOutput = (current, chunk, limit = CLAUDE_AUTH_STATUS_OUTPUT_LIMIT) => {
  const next = `${current}${String(chunk)}`;
  return next.length > limit ? next.slice(-limit) : next;
};

const readSafeAuthDetails = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.loggedIn !== 'boolean') {
    return null;
  }

  return {
    loggedIn: value.loggedIn,
    ...(typeof value.authMethod === 'string' ? { authMethod: value.authMethod } : {}),
    ...(typeof value.apiProvider === 'string' ? { apiProvider: value.apiProvider } : {}),
    ...(typeof value.subscriptionType === 'string' ? { subscriptionType: value.subscriptionType } : {}),
  };
};

const parseAuthDetails = (stdout) => {
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
} = {}) => new Promise((resolve) => {
  let settled = false;
  let stdout = '';
  let stderr = '';
  let timer = null;

  const finish = (result) => {
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
    finish({
      ok: false,
      code: error?.code === 'ENOENT' ? 'claude_cli_unavailable' : 'claude_auth_status_failed',
      error: error?.code === 'ENOENT'
        ? 'Claude Code was not found on PATH.'
        : error instanceof Error
          ? error.message
          : 'Failed to check Claude Code authentication.',
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

  child.stdout?.on?.('data', (chunk) => {
    stdout = appendBoundedOutput(stdout, chunk);
  });
  child.stderr?.on?.('data', (chunk) => {
    stderr = appendBoundedOutput(stderr, chunk);
  });

  child.on?.('error', (error) => {
    finish({
      ok: false,
      code: error?.code === 'ENOENT' ? 'claude_cli_unavailable' : 'claude_auth_status_failed',
      error: error?.code === 'ENOENT'
        ? 'Claude Code was not found on PATH.'
        : error instanceof Error
          ? error.message
          : 'Failed to check Claude Code authentication.',
    });
  });

  child.on?.('close', (exitCode, signal) => {
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
