import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'bun:test';

import { startVirtualDisplay, VirtualDisplayError } from './display.js';

const fakeChild = () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.killCalls = [];
  child.kill = (signal) => {
    child.killCalls.push(signal);
    child.exitCode = 0;
    queueMicrotask(() => child.emit('exit', 0, signal));
    return true;
  };
  return child;
};

describe('private Xvfb lifecycle', () => {
  test('starts a local-only 24-bit fixed display and shuts it down boundedly', async () => {
    const child = fakeChild();
    const launches = [];
    const display = await startVirtualDisplay({
      spawnImpl: (executable, args, options) => {
        launches.push({ executable, args, options });
        return child;
      },
      fsPromises: { access: async (value) => expect(value).toBe('/tmp/.X11-unix/X99') },
    });

    expect(display.status()).toEqual({ ready: true });
    expect(launches).toHaveLength(1);
    expect(launches[0].executable).toBe('/usr/bin/Xvfb');
    expect(launches[0].args).toEqual([
      ':99', '-screen', '0', '1280x720x24', '-nolisten', 'tcp', '-noreset',
    ]);
    expect(launches[0].options.shell).toBe(false);

    await display.close();
    expect(display.status()).toEqual({ ready: false });
    expect(child.killCalls).toEqual(['SIGTERM']);
  });

  test('marks the display unhealthy after an unexpected exit', async () => {
    const child = fakeChild();
    const display = await startVirtualDisplay({
      spawnImpl: () => child,
      fsPromises: { access: async () => undefined },
    });
    const terminations = [];
    display.onTerminated((code) => terminations.push(code));

    child.exitCode = 1;
    child.emit('exit', 1, null);

    expect(display.status()).toEqual({ ready: false });
    expect(terminations).toEqual(['DEVRYAN_BOT_DISPLAY_CLOSED']);
  });

  test('fails closed when the display socket never becomes ready', async () => {
    const child = fakeChild();
    await expect(startVirtualDisplay({
      spawnImpl: () => child,
      fsPromises: {
        access: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
      },
      timeoutMs: 30,
    })).rejects.toBeInstanceOf(VirtualDisplayError);
    expect(child.killCalls).toEqual(['SIGTERM']);
  });
});
