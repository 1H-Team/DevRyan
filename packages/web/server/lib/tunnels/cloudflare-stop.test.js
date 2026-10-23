import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { spawnCloudflared, stopCloudflaredProcess } from '../cloudflare-tunnel.js';

class FakeCloudflaredProcess extends EventEmitter {
  constructor({ exitOnSignal = null } = {}) {
    super();
    this.exitCode = null;
    this.signalCode = null;
    this.pid = 1234;
    this.exitOnSignal = exitOnSignal;
    this.signals = [];
  }

  kill(signal) {
    this.signals.push(signal);
    if (signal === this.exitOnSignal) {
      queueMicrotask(() => {
        this.signalCode = signal;
        this.emit('exit', null, signal);
      });
    }
    return true;
  }
}

describe('cloudflared process shutdown', () => {
  it('waits for exit and escalates from SIGINT to SIGTERM when needed', async () => {
    const child = new FakeCloudflaredProcess({ exitOnSignal: 'SIGTERM' });

    const result = await stopCloudflaredProcess(child, {
      interruptGraceMs: 5,
      terminateGraceMs: 5,
      killGraceMs: 5,
    });

    expect(child.signals).toEqual(['SIGINT', 'SIGTERM']);
    expect(result).toEqual({
      stopped: true,
      signal: 'SIGTERM',
      escalated: true,
    });
  });

  it('does not signal an already exited process', async () => {
    const child = new FakeCloudflaredProcess();
    child.exitCode = 0;

    await expect(stopCloudflaredProcess(child)).resolves.toEqual({
      stopped: true,
      signal: null,
      escalated: false,
    });
    expect(child.signals).toEqual([]);
  });

  it('rejects when cloudflared remains alive after every signal', async () => {
    const child = new FakeCloudflaredProcess();

    await expect(stopCloudflaredProcess(child, {
      interruptGraceMs: 1,
      terminateGraceMs: 1,
      killGraceMs: 1,
    })).rejects.toThrow('Cloudflared did not exit');
    expect(child.signals).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL']);
  });
});

describe('cloudflared launch', () => {
  const launch = (platform, watchdog = { pid: 99, dispose: vi.fn() }) => {
    const child = new FakeCloudflaredProcess();
    const spawnImpl = vi.fn(() => child);
    const startWatchdog = vi.fn(() => watchdog);
    const result = spawnCloudflared(['tunnel', 'run', '--token-file', '/tmp/token'], {}, '/opt/bin/cloudflared',
      { platform, spawnImpl, startWatchdog });
    return { child, result, spawnImpl, startWatchdog, watchdog };
  };

  it('runs cloudflared in its own group with a parent-death watchdog that is disposed on exit', () => {
    const { child, result, spawnImpl, startWatchdog, watchdog } = launch('darwin');
    expect(result).toBe(child);
    expect(spawnImpl).toHaveBeenCalledWith('/opt/bin/cloudflared', ['tunnel', 'run', '--token-file', '/tmp/token'],
      expect.objectContaining({ detached: true, killSignal: 'SIGINT' }));
    expect(startWatchdog).toHaveBeenCalledExactlyOnceWith({ childPid: 1234, platform: 'darwin', code: 'cloudflared_watchdog_unavailable',
      argv: ['/opt/bin/cloudflared', 'tunnel', 'run', '--token-file', '/tmp/token'] });
    expect(watchdog.dispose).not.toHaveBeenCalled();
    child.emit('exit', 0, null);
    expect(watchdog.dispose).toHaveBeenCalledOnce();
  });

  it('keeps the Windows launch attached without a watchdog', () => {
    const { spawnImpl, startWatchdog } = launch('win32');
    expect(spawnImpl.mock.calls[0][2].detached).toBe(false);
    expect(startWatchdog).not.toHaveBeenCalled();
  });

  it('warns once when the watchdog cannot start and still returns the tunnel process', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { child, result } = launch('linux', { pid: null, error: { code: 'cloudflared_watchdog_unavailable', cause: 'EAGAIN' }, dispose: vi.fn() });
      expect(result).toBe(child);
      expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('watchdog unavailable (EAGAIN)'));
    } finally { warn.mockRestore(); }
  });
});
