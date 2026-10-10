import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCodexUsageConnection } from './codex-usage-connection.js';
import { codexUsageError } from './codex-usage-rpc.js';

const scratch = path.resolve(import.meta.dirname, '../../../../..', '.cache', 'tests', 'codex-usage');
const fixtures = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    if (fixture.unconfirmedTermination) {
      await fixture.owner.close().catch(error => expect(error.code).toBe('CODEX_TERMINATION_UNCONFIRMED'));
    } else await fixture.owner.close();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});
const fixture = (overrides = {}) => {
  fs.mkdirSync(scratch, { recursive: true });
  const directory = fs.mkdtempSync(path.join(scratch, 'fixture-'));
  const processes = [];
  const accounts = [{ type: 'chatgpt', email: 'first@example.test', planType: 'plus' }];
  const limits = { rateLimits: { limitId: 'codex', primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1_800_000_000 },
    secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1_800_010_000 } }, rateLimitResetCredits: { availableCount: 2, credits: null } };
  const createRpc = vi.fn(async options => {
    const index = processes.length;
    const rpc = { options, closed: false,
      request: vi.fn(async (method) => {
        if (method === 'account/login/start') return { loginId: `login-${index}`, verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'TEST-CODE', authUrl: 'https://auth.openai.com/oauth/authorize' };
        if (method === 'account/read') return { account: accounts.at(-1) };
        if (method === 'account/rateLimits/read') return limits;
        return {};
      }),
      close: vi.fn(async () => { rpc.closed = true; }),
    };
    processes.push(rpc); return rpc;
  });
  const owner = createCodexUsageConnection({ dataDirectory: directory, resolveExecutable: () => '/fixture/codex',
    pathValue: () => '/fixture/bin', createRpc, ...overrides });
  const result = { owner, directory, processes, accounts, createRpc };
  fixtures.push(result); return result;
};
const approve = async (fixture, process = fixture.processes.at(-1)) => {
  const start = process.request.mock.results.find((_value, index) => process.request.mock.calls[index][0] === 'account/login/start');
  const result = await start.value;
  await process.options.onNotification({ loginId: result.loginId, success: true });
};

describe('private Codex usage connection', () => {
  it('normalizes unknown account fields to null and preserves valid account values across reload', async () => {
    const f = fixture();
    f.accounts.push({ type: 'chatgpt', email: '', planType: '   ' });
    const pending = await f.owner.start();
    expect(pending.login.userCode).toBe('TEST-CODE');
    await approve(f);
    expect(f.owner.status().account).toEqual({ email: null, planType: null });
    expect((await f.owner.fetchQuota()).account).toEqual({ email: null, planType: null });
    const reloaded = createCodexUsageConnection({ dataDirectory: f.directory, resolveExecutable: () => '/fixture/codex', createRpc: f.createRpc });
    expect(reloaded.status().account).toEqual({ email: null, planType: null }); await reloaded.close();
    f.accounts.push({ type: 'chatgpt', email: 'valid@example.test', planType: 'plus' });
    await f.owner.start(); await approve(f);
    expect(f.owner.status().account).toEqual({ email: 'valid@example.test', planType: 'plus' });
  });
  it('is inert without an explicit data directory and cleanly reports missing CLI', async () => {
    const resolve = vi.fn(); const rpc = vi.fn();
    const owner = createCodexUsageConnection({ resolveExecutable: resolve, createRpc: rpc });
    expect(owner.status()).toMatchObject({ available: false, configured: false });
    expect(await owner.start()).toMatchObject({ available: false, configured: false, errorCode: 'CODEX_CLI_UNAVAILABLE' });
    expect(resolve).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled(); await owner.close();
    const f = fixture({ resolveExecutable: () => null });
    expect(await f.owner.start()).toMatchObject({ available: false, configured: false, errorCode: 'CODEX_CLI_UNAVAILABLE' });
    expect(f.createRpc).not.toHaveBeenCalled();
  });

  it('connects separately, refreshes weekly/reset-bank data and coalesces read operations', async () => {
    const f = fixture();
    const pending = await f.owner.start();
    expect(pending).toMatchObject({ configured: false, login: { status: 'pending', userCode: 'TEST-CODE' } });
    await approve(f);
    expect(f.processes[0].closed).toBe(true);
    const status = f.owner.status();
    expect(status).toMatchObject({ configured: true, account: { email: 'first@example.test' }, login: { status: 'approved' } });
    const [a, b] = await Promise.all([f.owner.fetchQuota(), f.owner.fetchQuota()]);
    expect(a).toBe(b); expect(f.processes).toHaveLength(2); expect(f.processes[1].closed).toBe(true);
    expect(a).toMatchObject({ ok: true, source: 'codex-app-server', connectionId: status.connectionId,
      usage: { windows: { weekly: { usedPercent: 40 } }, resetCredits: { availableCount: 2, detailsAvailable: false } } });
    const methods = f.processes.flatMap(p => p.request.mock.calls.map(c => c[0]));
    expect(methods).not.toContain('turn/start'); expect(methods).not.toContain('account/rateLimitResetCredit/consume');
    expect(f.processes[0].options.home).toContain(path.join('quota', 'codex-usage'));
    expect(fs.statSync(f.processes[0].options.home).mode & 0o777).toBe(0o700);
    const reloaded = createCodexUsageConnection({ dataDirectory: f.directory, resolveExecutable: () => '/fixture/codex', createRpc: f.createRpc });
    expect(reloaded.status().connectionId).toBe(status.connectionId); await reloaded.close();
  });

  it('keeps the previous account on cancelled reconnect and swaps scope only after approval', async () => {
    const f = fixture(); await f.owner.start(); await approve(f);
    const original = f.owner.status();
    const pending = await f.owner.start('browser');
    expect(pending.account).toEqual(original.account);
    await f.owner.cancel(pending.login.flowId);
    expect(f.owner.status().connectionId).toBe(original.connectionId);
    expect(fs.existsSync(f.processes[1].options.home)).toBe(false);
    await f.owner.start(); f.accounts.push({ type: 'chatgpt', email: 'second@example.test', planType: 'pro' }); await approve(f);
    expect(f.owner.status().connectionId).not.toBe(original.connectionId);
    expect(f.owner.status().account.email).toBe('second@example.test');
    expect(fs.existsSync(f.processes[0].options.home)).toBe(false);
    await f.owner.disconnect(); expect(f.owner.status().configured).toBe(false);
    expect(f.processes.at(-1).request).toHaveBeenCalledWith('account/logout');
  });

  it('does not expire an approved profile when the deadline callback was queued during completion', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture({ loginTimeoutMs: 30 }); await f.owner.start();
      const rpc = f.processes[0]; const originalRequest = rpc.request.getMockImplementation();
      let release;
      rpc.request.mockImplementation(method => method === 'account/read'
        ? new Promise(resolve => { release = () => resolve({ account: f.accounts.at(-1) }); }) : originalRequest(method));
      const completing = approve(f);
      for (let i = 0; i < 12 && !release; i++) await Promise.resolve();
      expect(release).toBeTypeOf('function');
      await vi.advanceTimersByTimeAsync(30);
      release(); await completing;
      const result = await f.owner.fetchQuota();
      expect(f.owner.status()).toMatchObject({ configured: true, login: { status: 'approved' } });
      expect(result.ok).toBe(true);
      expect(fs.existsSync(rpc.options.home)).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('keeps committed approval when removing the obsolete profile fails and ignores an older close callback', async () => {
    const f = fixture(); await f.owner.start(); await approve(f);
    const oldRpc = f.processes[0];
    await f.owner.start();
    oldRpc.options.onClose();
    f.accounts.push({ type: 'chatgpt', email: 'new@example.test', planType: 'pro' });
    const newRpc = f.processes[1];
    const originalRemove = fs.rmSync;
    const remove = vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
      if (target === oldRpc.options.home) throw Object.assign(new Error('fixture cleanup failure'), { code: 'EACCES' });
      return originalRemove(target, options);
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await approve(f, newRpc);
      expect(f.owner.status()).toMatchObject({ configured: true, login: { status: 'approved' }, account: { email: 'new@example.test' } });
      expect(fs.existsSync(newRpc.options.home)).toBe(true);
      expect(fs.existsSync(oldRpc.options.home)).toBe(true);
      expect(warning).toHaveBeenCalledWith('[quota] Obsolete usage profile cleanup failed');
      expect((await f.owner.fetchQuota()).ok).toBe(true);
      const reloaded = createCodexUsageConnection({ dataDirectory: f.directory, resolveExecutable: () => '/fixture/codex', createRpc: f.createRpc });
      expect(reloaded.status().connectionId).toBe(f.owner.status().connectionId); await reloaded.close();
    } finally { remove.mockRestore(); warning.mockRestore(); }
  });

  it('expires bounded login, preserves account identity on failed reads and closes pending startup', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture({ loginTimeoutMs: 30 }); await f.owner.start();
      await vi.advanceTimersByTimeAsync(30);
      expect(f.owner.status().login.status).toBe('expired'); expect(f.processes[0].closed).toBe(true);
    } finally { vi.useRealTimers(); }
    let release;
    const rpc = { request: vi.fn(), close: vi.fn(async () => {}) };
    const f = fixture({ createRpc: () => new Promise(resolve => { release = () => resolve(rpc); }) });
    const pending = f.owner.start(); await Promise.resolve(); await Promise.resolve();
    const closing = f.owner.close(); release(); await pending; await closing;
    expect(rpc.close).toHaveBeenCalled(); expect(rpc.request).not.toHaveBeenCalled();
    expect(f.owner.close()).toBe(closing);
  });

  it('returns the current account after a quota read fails and serializes disconnect behind the read', async () => {
    const f = fixture(); await f.owner.start(); await approve(f);
    const originalCreate = f.createRpc.getMockImplementation();
    let release;
    f.createRpc.mockImplementation(async options => {
      const rpc = await originalCreate(options);
      rpc.request.mockImplementation(async method => {
        if (method === 'account/read') return { account: { type: 'chatgpt', email: 'changed@example.test', planType: 'pro' } };
        if (method === 'account/rateLimits/read') return new Promise((_resolve, reject) => { release = () => reject(new Error('private-provider-value')); });
        return {};
      });
      return rpc;
    });
    const read = f.owner.fetchQuota();
    for (let i = 0; i < 12 && !release; i++) await Promise.resolve();
    const disconnect = f.owner.disconnect();
    expect(f.owner.status().configured).toBe(true); release();
    const result = await read;
    expect(result).toMatchObject({ ok: false, account: { email: 'changed@example.test' }, errorCode: 'CODEX_CONNECTION_FAILED' });
    expect(JSON.stringify(result)).not.toContain('private-provider-value');
    await disconnect; expect(f.owner.status().configured).toBe(false);
    expect(f.processes.every(p => p.closed)).toBe(true);
  });

  it('retains the private profile and refuses further lifecycle operations when shutdown is unconfirmed', async () => {
    const f = fixture(); f.unconfirmedTermination = true;
    await f.owner.start(); await approve(f);
    const home = f.processes[0].options.home;
    const originalCreate = f.createRpc.getMockImplementation();
    f.createRpc.mockImplementation(async options => {
      const rpc = await originalCreate(options);
      rpc.close.mockRejectedValue(codexUsageError('CODEX_TERMINATION_UNCONFIRMED'));
      return rpc;
    });
    expect(await f.owner.fetchQuota()).toMatchObject({ ok: false, errorCode: 'CODEX_TERMINATION_UNCONFIRMED' });
    expect(f.owner.status()).toMatchObject({ configured: true, errorCode: 'CODEX_TERMINATION_UNCONFIRMED' });
    const calls = f.createRpc.mock.calls.length;
    await expect(f.owner.start()).rejects.toMatchObject({ code: 'CODEX_TERMINATION_UNCONFIRMED' });
    await expect(f.owner.disconnect()).rejects.toMatchObject({ code: 'CODEX_TERMINATION_UNCONFIRMED' });
    expect(await f.owner.fetchQuota()).toMatchObject({ ok: false, errorCode: 'CODEX_TERMINATION_UNCONFIRMED' });
    expect(f.createRpc).toHaveBeenCalledTimes(calls);
    expect(fs.existsSync(home)).toBe(true);
    await expect(f.owner.close()).rejects.toMatchObject({ code: 'CODEX_TERMINATION_UNCONFIRMED' });
    expect(fs.existsSync(home)).toBe(true);
  });

  it('also fences an unconfirmed process that fails before RPC acquisition', async () => {
    const f = fixture({ createRpc: vi.fn(async () => { throw codexUsageError('CODEX_TERMINATION_UNCONFIRMED'); }) });
    f.unconfirmedTermination = true;
    expect(await f.owner.start()).toMatchObject({ configured: false, login: { status: 'failed' }, errorCode: 'CODEX_TERMINATION_UNCONFIRMED' });
    await expect(f.owner.start()).rejects.toMatchObject({ code: 'CODEX_TERMINATION_UNCONFIRMED' });
    await expect(f.owner.disconnect()).rejects.toMatchObject({ code: 'CODEX_TERMINATION_UNCONFIRMED' });
    const retained = fs.readdirSync(path.join(f.directory, 'quota', 'codex-usage'));
    expect(retained).toHaveLength(1);
  });
});
