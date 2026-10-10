import { spawn } from 'node:child_process';

const METHODS = new Set(['initialize', 'account/read', 'account/login/start', 'account/login/cancel', 'account/logout', 'account/rateLimits/read']);
export const codexUsageError = (code = 'CODEX_CONNECTION_FAILED') => Object.assign(new Error({
  CODEX_CLI_UNAVAILABLE: 'Install Codex CLI separately to enable this optional usage connection.',
  CODEX_CONNECTION_FAILED: 'The usage connection could not be read. Reconnect or update Codex CLI.',
  CODEX_CONNECTION_TIMEOUT: 'The usage connection timed out. Try again.',
  CODEX_TERMINATION_UNCONFIRMED: 'The usage helper did not stop. Restart DevRyan before reconnecting.',
  CODEX_SIGN_IN_REQUIRED: 'Connect a ChatGPT account for usage.',
  CODEX_CONNECTION_BUSY: 'Finish or cancel the pending usage sign-in first.',
  CODEX_INVALID_REQUEST: 'The usage connection request is invalid.',
}[code] ?? 'The usage connection is unavailable.'), { code });

/** Private, fixed-method JSONL transport. Provider output and stderr never reach logs or HTTP. */
export async function createCodexUsageRpc({ executable, home, pathValue, spawnImpl = spawn,
  timeoutMs = 20_000, onNotification = () => {}, onClose = () => {} }) {
  let child;
  try {
    child = spawnImpl(executable, ['-c', 'cli_auth_credentials_store="file"', '-c', 'mcp_servers={}', 'app-server'], {
      cwd: home,
      env: { PATH: pathValue, HOME: process.env.HOME, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        CODEX_HOME: home, XDG_CONFIG_HOME: home, RUST_LOG: 'off' },
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
  } catch { throw codexUsageError('CODEX_CLI_UNAVAILABLE'); }
  const pending = new Map();
  let sequence = 0;
  let closed = false;
  let buffer = '';
  let receivedBytes = 0;
  let killTimer;
  let exitDeadline;
  let exited = false;
  let resolveExit;
  let rejectExit;
  const exitPromise = new Promise((resolve, reject) => { resolveExit = resolve; rejectExit = reject; });
  // Failure can initiate shutdown before the caller reaches close(). Keep that
  // private rejection handled while still returning it to every close caller.
  void exitPromise.catch(() => {});
  const fail = (error = codexUsageError()) => {
    if (closed) return;
    closed = true;
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    pending.clear();
    child.stdin?.end();
    if (!exited) {
      try { child.kill('SIGTERM'); } catch { /* escalation still runs */ }
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        if (exited) return;
        // Sending a signal does not prove process exit. A failure to observe
        // termination must reject close, so owners retain the private profile.
        exitDeadline = setTimeout(() => rejectExit(codexUsageError('CODEX_TERMINATION_UNCONFIRMED')), 1_000);
        exitDeadline.unref?.();
      }, 1_000);
      killTimer.unref?.();
    }
    onClose();
  };
  const observeExit = () => {
    exited = true; clearTimeout(killTimer); clearTimeout(exitDeadline); resolveExit(); fail();
  };
  child.on('error', () => {
    // An error signalling an existing process is not an exit observation.
    if (!child.pid) observeExit();
    fail(codexUsageError('CODEX_CLI_UNAVAILABLE'));
  });
  child.on('exit', observeExit);
  child.on('close', observeExit);
  child.stderr?.on('data', () => {});
  child.stdin?.on('error', () => fail());
  child.stdout?.setEncoding?.('utf8');
  child.stdout?.on('data', chunk => {
    receivedBytes += Buffer.byteLength(chunk);
    buffer += chunk.toString('utf8');
    if (receivedBytes > 2 * 1024 * 1024 || Buffer.byteLength(buffer) > 256 * 1024) { fail(); return; }
    let newline;
    while (!closed && (newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { fail(); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) { fail(); return; }
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id); clearTimeout(waiter.timer);
        if (message.error || !Object.hasOwn(message, 'result')) waiter.reject(codexUsageError());
        else waiter.resolve(message.result);
      } else if (message.id === undefined && message.method === 'account/login/completed') {
        onNotification(message.params);
      } else if (message.id !== undefined && typeof message.method === 'string') {
        // No server-initiated token refresh, tools, approval, or inference requests are supported.
        fail(); return;
      }
    }
  });
  const request = (method, params) => {
    if (!METHODS.has(method) || closed) return Promise.reject(codexUsageError());
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(codexUsageError('CODEX_CONNECTION_TIMEOUT')), timeoutMs);
      timer.unref?.(); pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method, ...(params ? { params } : {}) })}\n`);
    });
  };
  try {
    await request('initialize', { clientInfo: { name: 'devryan_usage', title: 'DevRyan Usage', version: '1' }, capabilities: {} });
    if (closed) throw codexUsageError();
    child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
  } catch (error) { fail(); await exitPromise; throw error; }
  return { request, close: () => { fail(); return exitPromise; }, isClosed: () => closed };
}
