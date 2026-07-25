import { describe, expect, it, vi } from 'vitest';

import { createTunnelService } from './index.js';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const createHarness = (stopImplementation) => {
  const controller = { provider: 'cloudflare', mode: 'managed-remote' };
  let activeController = controller;
  const provider = {
    stop: vi.fn(stopImplementation),
  };
  const service = createTunnelService({
    registry: { get: vi.fn(() => provider) },
    getController: () => activeController,
    setController: (next) => {
      activeController = next;
    },
    getActivePort: () => 3000,
  });

  return {
    controller,
    provider,
    service,
    getActiveController: () => activeController,
  };
};

describe('tunnel service shutdown', () => {
  it('keeps the controller active until the provider confirms process exit', async () => {
    const gate = deferred();
    const harness = createHarness(() => gate.promise);

    const firstStop = harness.service.stop();
    const secondStop = harness.service.stop();

    expect(secondStop).toBe(firstStop);
    expect(harness.provider.stop).toHaveBeenCalledTimes(1);
    expect(harness.getActiveController()).toBe(harness.controller);

    gate.resolve({ stopped: true });
    await firstStop;

    expect(harness.getActiveController()).toBeNull();
  });

  it('preserves the active controller when provider shutdown fails', async () => {
    const failure = new Error('cloudflared stayed alive');
    const harness = createHarness(async () => {
      throw failure;
    });

    await expect(harness.service.stop()).rejects.toBe(failure);
    expect(harness.getActiveController()).toBe(harness.controller);
  });
});
