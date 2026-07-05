import { describe, expect, test } from 'bun:test';
import { createKeepAwakeController } from '../keep-awake-controller.mjs';

const createPowerSaveBlocker = () => {
  let nextId = 1;
  const started = new Set();
  const calls = [];

  return {
    api: {
      start: (type) => {
        calls.push(['start', type]);
        const id = nextId;
        nextId += 1;
        started.add(id);
        return id;
      },
      stop: (id) => {
        calls.push(['stop', id]);
        started.delete(id);
      },
      isStarted: (id) => started.has(id),
    },
    calls,
  };
};

describe('createKeepAwakeController', () => {
  test('apply(true) starts the power save blocker once', () => {
    const powerSaveBlocker = createPowerSaveBlocker();
    const controller = createKeepAwakeController({ powerSaveBlocker: powerSaveBlocker.api });

    expect(controller.apply(true)).toEqual({ enabled: true, active: true });
    expect(controller.apply(true)).toEqual({ enabled: true, active: true });

    expect(powerSaveBlocker.calls).toEqual([
      ['start', 'prevent-display-sleep'],
    ]);
  });

  test('apply(false) stops an active blocker and is idempotent', () => {
    const powerSaveBlocker = createPowerSaveBlocker();
    const controller = createKeepAwakeController({ powerSaveBlocker: powerSaveBlocker.api });

    controller.apply(true);
    expect(controller.apply(false)).toEqual({ enabled: false, active: false });
    expect(controller.apply(false)).toEqual({ enabled: false, active: false });

    expect(powerSaveBlocker.calls).toEqual([
      ['start', 'prevent-display-sleep'],
      ['stop', 1],
    ]);
  });

  test('stop releases the active blocker for app quit', () => {
    const powerSaveBlocker = createPowerSaveBlocker();
    const controller = createKeepAwakeController({ powerSaveBlocker: powerSaveBlocker.api });

    controller.apply(true);
    controller.stop();
    controller.stop();

    expect(powerSaveBlocker.calls).toEqual([
      ['start', 'prevent-display-sleep'],
      ['stop', 1],
    ]);
  });
});
