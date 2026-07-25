import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import { stopCloudflaredProcess } from '../cloudflare-tunnel.js';

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
