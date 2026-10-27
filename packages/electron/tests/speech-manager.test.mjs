import { describe, expect, test } from 'bun:test';
import { MacosSpeechManager } from '../speech-manager.mjs';

const createManager = () => new MacosSpeechManager({
  baseDir: '/tmp/devryan-test',
  isPackaged: false,
  resourcesPath: null,
  emit: () => {},
  log: { warn: () => {} },
});

const createFakeChild = ({ markExitedOnKill = false } = {}) => {
  const writes = [];
  const ends = [];
  const kills = [];
  const fakeChild = {
    exitCode: null,
    signalCode: null,
    stdin: {
      writable: true,
      destroyed: false,
      write: (chunk) => {
        writes.push(String(chunk));
        return true;
      },
      end: () => {
        ends.push(true);
      },
    },
    kill: (signal) => {
      kills.push(signal);
      if (markExitedOnKill) {
        fakeChild.signalCode = signal;
      }
      return true;
    },
  };

  return {
    child: fakeChild,
    writes,
    ends,
    kills,
  };
};

describe('MacosSpeechManager', () => {
  test('Windows speech refuses before resolving or executing the helper', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    const manager = createManager();
    Object.defineProperty(manager, 'helperPath', { get: () => { throw Error('Unsupported speech reached its helper'); } });
    try {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      expect(await manager.getCapability()).toMatchObject({ available: false, platform: 'win32', reason: 'platform_unsupported' });
      expect(await manager.requestAuthorization()).toMatchObject({ available: false, reason: 'platform_unsupported' });
      expect(await manager.getInputDevices()).toEqual([]);
      await expect(manager.start()).rejects.toThrow('only supported on macOS');
      expect(manager.child).toBeNull();
    } finally { Object.defineProperty(process, 'platform', original); }
  });

  test('stop sends a graceful stdin stop command before falling back to signals', () => {
    const manager = createManager();
    const fake = createFakeChild();
    manager.child = fake.child;

    const result = manager.stop();

    expect(result).toEqual({ stopped: true });
    expect(fake.writes).toEqual(['stop\n']);
    expect(fake.ends).toEqual([true]);
    expect(fake.kills).toEqual([]);
  });

  test('stop falls back to SIGTERM when the helper does not exit after graceful stop', async () => {
    const manager = createManager();
    const fake = createFakeChild({ markExitedOnKill: true });
    manager.child = fake.child;

    manager.stop();
    await Bun.sleep(850);

    expect(fake.writes).toEqual(['stop\n']);
    expect(fake.kills).toEqual(['SIGTERM']);
  });
});
