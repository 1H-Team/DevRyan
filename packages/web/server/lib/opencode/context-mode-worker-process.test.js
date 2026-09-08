import { EventEmitter } from 'node:events';
import { fork } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextModeWorkerProcess } from './context-mode-worker-process.js';

vi.mock('node:child_process', () => ({ fork: vi.fn() }));
let child;
beforeEach(() => {
  child = Object.assign(new EventEmitter(), {
    pid: 1234, send: vi.fn(), kill: vi.fn(), unref: vi.fn(),
    channel: {}, // Bun exposes a channel without Node's unref method.
  });
  vi.mocked(fork).mockReset().mockReturnValue(child);
});

describe('Context Mode worker processes', () => {
  it('uses private IPC and tolerates Bun channels without unref support', () => {
    const env = { PATH: '/fixture/bin' };
    const worker = new ContextModeWorkerProcess(new URL('file:///fixture/worker.js'), { env, workerData: { owner: 1 } });
    expect(fork).toHaveBeenCalledWith('/fixture/worker.js', [], expect.objectContaining({
      execPath: process.execPath, execArgv: [], serialization: 'json',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    }));
    expect(child.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'initialize', workerData: expect.objectContaining({ owner: 1 }) }), expect.any(Function));
    expect(() => worker.unref()).not.toThrow();
    expect(child.unref).toHaveBeenCalledOnce();
    expect(worker.pid).toBe(1234);
    expect(env).toEqual({ PATH: '/fixture/bin' });
  });

  it('requests process termination but waits for actual exit evidence', async () => {
    const worker = new ContextModeWorkerProcess(new URL('file:///fixture/worker.js'), { env: {}, workerData: {} });
    let exited = false;
    const stopped = worker.terminate().then(() => { exited = true; });
    await Promise.resolve();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(exited).toBe(false);
    child.emit('exit', null);
    await stopped;
    expect(exited).toBe(true);
  });

  it('stops a process whose initial IPC message cannot be sent', () => {
    child.send.mockImplementation(() => { throw new Error('fixture channel closed'); });
    expect(() => new ContextModeWorkerProcess(new URL('file:///fixture/worker.js'), { env: {}, workerData: {} })).toThrow('fixture channel closed');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(() => child.emit('error', new Error('late fixture failure'))).not.toThrow();
  });
});
