import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeCodexAppServerQuota } from '@openchamber/shared-runtime';
import { buildResult } from './utils/formatters.js';
import { createCodexUsageRpc, codexUsageError } from './codex-usage-rpc.js';

const safeText = (value) => typeof value === 'string' && value.length <= 320 && !/[\x00-\x1f]/.test(value) ? value : null;
const optionalAccountText = (value) => {
  const text = safeText(value);
  return text?.trim() ? text : null;
};
const accountIdentity = (value) => value?.type === 'chatgpt'
  ? { email: optionalAccountText(value.email), planType: optionalAccountText(value.planType) } : null;
const signInUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['auth.openai.com', 'chatgpt.com', 'auth0.openai.com'].includes(url.hostname)
      && !url.username && !url.password ? url.href : null;
  } catch { return null; }
};

export const resolveInstalledCodex = (pathValue = process.env.PATH ?? '') => {
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    if (!path.isAbsolute(directory)) continue;
    const target = path.join(directory, process.platform === 'win32' ? 'codex.exe' : 'codex');
    try { if (fs.statSync(target).isFile()) { fs.accessSync(target, fs.constants.X_OK); return target; } } catch { /* next PATH entry */ }
  }
  return null;
};

/** Optional usage auth owned by DevRyan. Never reads or imports the user's Codex profile. */
export function createCodexUsageConnection({ dataDirectory, pathValue = () => process.env.PATH ?? '',
  resolveExecutable = resolveInstalledCodex, createRpc = createCodexUsageRpc, now = Date.now,
  loginTimeoutMs = 10 * 60_000 } = {}) {
  const enabled = typeof dataDirectory === 'string' && path.isAbsolute(dataDirectory);
  const root = enabled ? path.join(dataDirectory, 'quota', 'codex-usage') : null;
  const manifest = enabled ? path.join(root, 'connection.json') : null;
  let active = null;
  let login = null;
  let loginRpc = null;
  let operationRpc = null;
  let deadline = null;
  let closed = false;
  let queue = Promise.resolve();
  let refresh = null;
  let closePromise = null;
  let lifecycleError = null;

  const observeFailure = (error) => {
    if (error?.code !== 'CODEX_TERMINATION_UNCONFIRMED') return;
    lifecycleError = codexUsageError('CODEX_TERMINATION_UNCONFIRMED');
    clearTimeout(deadline); deadline = null;
    if (login?.status === 'pending') {
      login.status = 'failed';
      delete login.authUrl; delete login.verificationUrl; delete login.userCode;
    }
  };
  const closeRpc = async (rpc) => {
    try { await rpc?.close(); } catch (error) { observeFailure(error); throw error; }
  };

  const serial = (operation) => {
    const next = queue.then(() => {
      if (lifecycleError) throw lifecycleError;
      if (closed) throw codexUsageError();
      return operation();
    });
    queue = next.catch(() => {});
    return next;
  };
  const privateDirectory = (directory) => {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(directory).isSymbolicLink() || !fs.statSync(directory).isDirectory()) throw codexUsageError();
    fs.chmodSync(directory, 0o700);
  };
  const profilePath = (id) => path.join(root, id);
  // Only our safe manifest is read. Codex exclusively owns auth.json and token refresh.
  try {
    if (!enabled) throw codexUsageError('CODEX_CLI_UNAVAILABLE');
    const stat = fs.lstatSync(manifest);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4096) {
      const saved = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      if (/^[0-9a-f-]{36}$/.test(saved.connectionId) && saved.account && typeof saved.account === 'object') {
        active = { connectionId: saved.connectionId,
          account: { email: optionalAccountText(saved.account.email), planType: optionalAccountText(saved.account.planType) } };
      }
    }
  } catch { /* absent or invalid manifest means disconnected */ }
  const executable = () => enabled ? resolveExecutable(pathValue()) : null;
  const status = (error = lifecycleError) => ({
    available: Boolean(executable()), configured: active !== null, source: 'codex-app-server',
    connectionId: active?.connectionId ?? null, account: active?.account ?? null,
    login: login ? { flowId: login.flowId, status: login.status, expiresAt: login.expiresAt,
      ...(login.verificationUrl ? { verificationUrl: login.verificationUrl } : {}),
      ...(login.userCode ? { userCode: login.userCode } : {}), ...(login.authUrl ? { authUrl: login.authUrl } : {}) } : null,
    ...(error ? { errorCode: error.code ?? 'CODEX_CONNECTION_FAILED', error: codexUsageError(error.code).message } : {}),
  });
  const persist = (value) => {
    privateDirectory(root);
    const temporary = `${manifest}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, manifest);
    } finally { fs.rmSync(temporary, { force: true }); }
  };
  const connectRpc = async (id, options = {}) => {
    const command = executable();
    if (!command) throw codexUsageError('CODEX_CLI_UNAVAILABLE');
    privateDirectory(root);
    const home = profilePath(id); privateDirectory(home);
    try {
      const rpc = await createRpc({ executable: command, home, pathValue: pathValue(), ...options });
      if (closed || lifecycleError) { await closeRpc(rpc); throw lifecycleError ?? codexUsageError(); }
      return rpc;
    } catch (error) { observeFailure(error); throw error; }
  };
  const finishLogin = async (state, attempt = login) => {
    if (!attempt || login !== attempt) return;
    clearTimeout(deadline); deadline = null;
    attempt.status = state;
    delete attempt.authUrl; delete attempt.verificationUrl; delete attempt.userCode;
    await closeRpc(loginRpc); loginRpc = null;
    if (enabled && !lifecycleError && state !== 'approved' && attempt.profileId !== active?.connectionId) {
      fs.rmSync(profilePath(attempt.profileId), { recursive: true, force: true });
    }
  };
  const completeLogin = (params) => serial(async () => {
    if (!loginRpc || !login || login.status !== 'pending' || params?.loginId !== login.loginId) return;
    const attempt = login;
    if (params.success !== true) { await finishLogin('failed'); return; }
    let previous;
    try {
      const read = await loginRpc.request('account/read', { refreshToken: true });
      const account = accountIdentity(read?.account);
      if (!account) throw codexUsageError();
      previous = active;
      const next = { connectionId: attempt.profileId, account };
      persist(next); active = next; await finishLogin('approved');
    } catch { await finishLogin('failed', attempt); return; }
    // Approval is committed. An obsolete profile cleanup failure cannot roll it
    // back or delete the newly selected credential profile.
    if (previous) {
      try { fs.rmSync(profilePath(previous.connectionId), { recursive: true, force: true }); }
      catch { console.warn('[quota] Obsolete usage profile cleanup failed'); }
    }
  }).catch(() => {});

  const start = (method = 'device') => serial(async () => {
    if (!['device', 'browser'].includes(method)) throw codexUsageError('CODEX_INVALID_REQUEST');
    if (login?.status === 'pending') throw codexUsageError('CODEX_CONNECTION_BUSY');
    const profileId = crypto.randomUUID();
    login = { flowId: crypto.randomUUID(), profileId, status: 'pending', expiresAt: now() + loginTimeoutMs };
    const attempt = login;
    const finishPending = (state) => serial(() => {
      if (login === attempt && attempt.status === 'pending') return finishLogin(state, attempt);
    }).catch(() => {});
    try {
      loginRpc = await connectRpc(profileId, { onNotification: completeLogin,
        onClose: () => { if (login === attempt && attempt.status === 'pending') void finishPending('failed'); } });
      const result = await loginRpc.request('account/login/start', { type: method === 'device' ? 'chatgptDeviceCode' : 'chatgpt' });
      const url = signInUrl(method === 'device' ? result?.verificationUrl : result?.authUrl);
      const loginId = safeText(result?.loginId);
      const userCode = safeText(result?.userCode);
      if (!url || !loginId || (method === 'device' && !userCode)) throw codexUsageError();
      Object.assign(login, { loginId, ...(method === 'device' ? { verificationUrl: url, userCode } : { authUrl: url }) });
      deadline = setTimeout(() => { void finishPending('expired'); }, loginTimeoutMs);
      deadline.unref?.();
      return status();
    } catch (error) { await finishLogin('failed'); return status(error); }
  });
  const cancel = (flowId) => serial(async () => {
    if (login?.status === 'pending' && login.flowId === flowId) {
      try { await loginRpc?.request('account/login/cancel', { loginId: login.loginId }); } catch { /* close is authoritative locally */ }
      await finishLogin('cancelled');
    }
    return status();
  });
  const disconnect = () => serial(async () => {
    if (!enabled) return status();
    if (login?.status === 'pending') await finishLogin('cancelled');
    if (active) {
      // Local removal remains available when CLI is absent or logout fails.
      try { operationRpc = await connectRpc(active.connectionId); await operationRpc.request('account/logout'); }
      catch (error) { observeFailure(error); if (lifecycleError) throw lifecycleError; }
      finally { await closeRpc(operationRpc); operationRpc = null; }
      fs.rmSync(profilePath(active.connectionId), { recursive: true, force: true });
    }
    fs.rmSync(manifest, { force: true }); active = null; login = null;
    return status();
  });
  const fetchQuota = () => {
    if (refresh) return refresh;
    refresh = serial(async () => {
      const identity = () => ({ source: 'codex-app-server', connectionId: active?.connectionId ?? null, account: active?.account ?? null });
      try {
        if (!active) throw codexUsageError('CODEX_SIGN_IN_REQUIRED');
        if (login?.status === 'pending') throw codexUsageError('CODEX_CONNECTION_BUSY');
        operationRpc = await connectRpc(active.connectionId);
        const read = await operationRpc.request('account/read', { refreshToken: true });
        const account = accountIdentity(read?.account);
        if (!account) throw codexUsageError('CODEX_SIGN_IN_REQUIRED');
        if (account.email !== active.account.email || account.planType !== active.account.planType) {
          active = { ...active, account }; persist(active);
        }
        const payload = await operationRpc.request('account/rateLimits/read');
        return { ...normalizeCodexAppServerQuota(payload, { now: now() }), ...identity(), account };
      } catch (error) {
        return { ...buildResult({ providerId: 'codex', providerName: 'ChatGPT', ok: false, configured: Boolean(active),
          errorCode: error.code ?? 'CODEX_CONNECTION_FAILED', error: codexUsageError(error.code).message }), ...identity() };
      } finally { await closeRpc(operationRpc); operationRpc = null; }
    }).catch(error => ({
      ...buildResult({ providerId: 'codex', providerName: 'ChatGPT', ok: false, configured: Boolean(active),
        errorCode: error.code ?? 'CODEX_CONNECTION_FAILED', error: codexUsageError(error.code).message }),
      source: 'codex-app-server', connectionId: active?.connectionId ?? null, account: active?.account ?? null,
    })).finally(() => { refresh = null; });
    return refresh;
  };
  const close = () => {
    if (closePromise) return closePromise;
    closed = true; clearTimeout(deadline); deadline = null;
    closePromise = (async () => {
      await Promise.all([closeRpc(loginRpc), closeRpc(operationRpc)]);
      await queue;
      if (lifecycleError) throw lifecycleError;
      if (!lifecycleError && login?.status === 'pending') {
        login.status = 'cancelled'; if (enabled) fs.rmSync(profilePath(login.profileId), { recursive: true, force: true });
      }
      loginRpc = null; operationRpc = null;
    })();
    return closePromise;
  };
  return { status, start, cancel, disconnect, fetchQuota, close, isConfigured: () => active !== null };
}
