import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createCodexUsageRpc } from './codex-usage-rpc.js';

const childFixture = (handle = () => ({}), { exitOnKill = true } = {}) => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const messages = [];
  child.stdin = new Writable({ write(chunk, _encoding, done) {
    const message = JSON.parse(chunk.toString()); messages.push(message);
    if (message.id) queueMicrotask(() => {
      const result = handle(message);
      if (result !== undefined) child.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
    });
    done();
  } });
  child.kill = vi.fn(() => { if (exitOnKill) queueMicrotask(() => child.emit('exit', 0)); return true; });
  return { child, messages };
};

describe('usage-only Codex RPC', () => {
  it('uses an isolated minimal environment, handshake and a fixed RPC allowlist', async () => {
    const { child, messages } = childFixture();
    const spawnImpl = vi.fn(() => child);
    const rpc = await createCodexUsageRpc({ executable: '/fixture/codex', home: '/fixture/private', pathValue: '/fixture/bin', spawnImpl });
    await rpc.request('account/rateLimits/read');
    await expect(rpc.request('turn/start', { input: 'never' })).rejects.toMatchObject({ code: 'CODEX_CONNECTION_FAILED' });
    const [command, args, options] = spawnImpl.mock.calls[0];
    expect(command).toBe('/fixture/codex');
    expect(args).toEqual(['-c', 'cli_auth_credentials_store="file"', '-c', 'mcp_servers={}', 'app-server']);
    expect(options.cwd).toBe('/fixture/private');
    expect(options.env.CODEX_HOME).toBe('/fixture/private');
    expect(options.env.OPENAI_API_KEY).toBeUndefined();
    expect(options.env.CODEX_API_KEY).toBeUndefined();
    expect(options.env.CHATGPT_ACCESS_TOKEN).toBeUndefined();
    expect(messages.map(m => m.method)).toEqual(['initialize', 'initialized', 'account/rateLimits/read']);
    await rpc.close(); expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('sanitizes provider failures and rejects server tool requests', async () => {
    const { child } = childFixture(message => message.method === 'initialize' ? {} : undefined);
    const rpc = await createCodexUsageRpc({ executable: '/fixture/codex', home: '/fixture/private', pathValue: '', spawnImpl: () => child });
    const request = rpc.request('account/read');
    child.stdout.write(`${JSON.stringify({ id: 99, method: 'item/tool/call', params: { secret: 'private-provider-value' } })}\n`);
    await expect(request).rejects.toMatchObject({ code: 'CODEX_CONNECTION_FAILED' });
    await rpc.close();
  });

  it('bounds initialization and waits for TERM then KILL before closing', async () => {
    vi.useFakeTimers();
    try {
      const { child } = childFixture(() => undefined, { exitOnKill: false });
      const creating = createCodexUsageRpc({ executable: '/fixture/codex', home: '/fixture/private', pathValue: '', spawnImpl: () => child, timeoutMs: 20 });
      const failure = expect(creating).rejects.toMatchObject({ code: 'CODEX_CONNECTION_TIMEOUT' });
      await vi.advanceTimersByTimeAsync(1020);
      expect(child.kill.mock.calls.map(call => call[0])).toEqual(['SIGTERM', 'SIGKILL']);
      child.emit('exit', null, 'SIGKILL'); await failure;
    } finally { vi.useRealTimers(); }
  });

  it('settles close only after an observed process exit, including after SIGKILL', async () => {
    vi.useFakeTimers();
    try {
      const { child } = childFixture(() => ({}), { exitOnKill: false });
      const rpc = await createCodexUsageRpc({ executable: '/fixture/codex', home: '/fixture/private', pathValue: '', spawnImpl: () => child });
      const closing = rpc.close();
      let settled = false; void closing.then(() => { settled = true; });
      expect(rpc.close()).toBe(closing);
      await vi.advanceTimersByTimeAsync(1000);
      expect(child.kill.mock.calls.map(call => call[0])).toEqual(['SIGTERM', 'SIGKILL']);
      expect(settled).toBe(false);
      child.emit('close', null, 'SIGKILL'); await closing;
      expect(settled).toBe(true);
      await vi.advanceTimersByTimeAsync(2000);
      expect(child.kill).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it('rejects bounded close when termination is unconfirmed and never treats a kill error as exit', async () => {
    vi.useFakeTimers();
    try {
      const { child } = childFixture(() => ({}), { exitOnKill: false }); child.pid = 123;
      const rpc = await createCodexUsageRpc({ executable: '/fixture/codex', home: '/fixture/private', pathValue: '', spawnImpl: () => child });
      const closing = rpc.close();
      const rejection = expect(closing).rejects.toMatchObject({ code: 'CODEX_TERMINATION_UNCONFIRMED' });
      child.emit('error', new Error('private-signal-failure'));
      await vi.advanceTimersByTimeAsync(2000); await rejection;
      expect(rpc.close()).toBe(closing);
    } finally { vi.useRealTimers(); }
  });
});
