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

describe('tunnel service managed controller identity', () => {
  const createStartHarness = ({ compatible = true } = {}) => {
    const currentController = {
      provider: 'cloudflare',
      mode: 'managed-remote',
      getPublicUrl: () => 'https://app.example.com',
    };
    let activeController = currentController;
    const nextController = {
      mode: 'managed-remote',
      getPublicUrl: () => 'https://app.example.com',
    };
    const provider = {
      capabilities: {
        provider: 'cloudflare',
        modes: [{
          key: 'managed-remote',
          intent: 'persistent-public',
          requires: ['token', 'hostname', 'originPort'],
        }],
      },
      resolvePublicUrl: vi.fn((controller) => controller?.getPublicUrl?.() ?? null),
      isControllerCompatible: vi.fn(() => compatible),
      verifyPublicReachability: vi.fn(async () => true),
      checkAvailability: vi.fn(async () => ({ available: true })),
      start: vi.fn(async () => nextController),
      stop: vi.fn(async () => true),
      getMetadata: vi.fn(() => ({ originPort: 3000 })),
    };
    const service = createTunnelService({
      registry: { get: vi.fn(() => provider) },
      getController: () => activeController,
      setController: (value) => { activeController = value; },
      getActivePort: () => 57123,
      runtimeInstanceId: 'instance-id',
    });
    const request = {
      provider: 'cloudflare',
      mode: 'managed-remote',
      token: `eyJ${'x'.repeat(80)}`,
      hostname: 'app.example.com',
      originPort: 3000,
    };
    return { currentController, getActiveController: () => activeController, nextController, provider, request, service };
  };

  it('re-verifies a compatible controller before reusing it', async () => {
    const harness = createStartHarness({ compatible: true });

    const result = await harness.service.start(harness.request);

    expect(result.controllerReused).toBe(true);
    expect(harness.provider.verifyPublicReachability).toHaveBeenCalledWith(
      harness.currentController,
      expect.objectContaining({ originPort: 3000 }),
      expect.objectContaining({ activePort: 57123, runtimeInstanceId: 'instance-id' }),
    );
    expect(harness.provider.start).not.toHaveBeenCalled();
  });

  it('replaces the connector when any provider-relevant identity value changes', async () => {
    const harness = createStartHarness({ compatible: false });

    const result = await harness.service.start(harness.request);

    expect(harness.provider.stop).toHaveBeenCalledWith(harness.currentController);
    expect(harness.provider.start).toHaveBeenCalledTimes(1);
    expect(harness.getActiveController()).toBe(harness.nextController);
    expect(result.controllerReused).toBe(false);
  });

  it('clears an unexpectedly terminated controller and invokes the authentication cleanup hook', async () => {
    let activeController = null;
    let terminationListener = null;
    const controller = {
      mode: 'managed-remote',
      getPublicUrl: () => 'https://app.example.com',
      onTerminated: vi.fn((listener) => { terminationListener = listener; }),
    };
    const provider = {
      capabilities: {
        provider: 'cloudflare',
        modes: [{
          key: 'managed-remote',
          intent: 'persistent-public',
          requires: ['token', 'hostname', 'originPort'],
        }],
      },
      checkAvailability: vi.fn(async () => ({ available: true })),
      start: vi.fn(async () => controller),
      resolvePublicUrl: vi.fn(() => 'https://app.example.com'),
      getMetadata: vi.fn(() => ({ connectorState: 'healthy' })),
    };
    const onControllerTerminated = vi.fn();
    const service = createTunnelService({
      registry: { get: vi.fn(() => provider) },
      getController: () => activeController,
      setController: (value) => { activeController = value; },
      getActivePort: () => 57123,
      runtimeInstanceId: 'instance-id',
      onControllerTerminated,
    });

    await service.start({
      provider: 'cloudflare',
      mode: 'managed-remote',
      token: `eyJ${'x'.repeat(80)}`,
      hostname: 'app.example.com',
      originPort: 3000,
    });
    terminationListener();

    expect(activeController).toBeNull();
    expect(onControllerTerminated).toHaveBeenCalledWith(controller);
    expect(service.getPublicUrl()).toBeNull();
  });
});
