import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOpenCodeNetworkRuntime } from './network-runtime.js';

const createRuntime = (stateOverrides = {}) => createOpenCodeNetworkRuntime({
  state: {
    openCodePort: 4096,
    openCodeBaseUrl: null,
    openCodeApiPrefix: '',
    openCodeApiPrefixDetected: false,
    openCodeApiDetectionTimer: null,
    ...stateOverrides,
  },
  getOpenCodeAuthHeaders: () => ({}),
});

describe('OpenCode network runtime', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('clears the probe abort timer when readiness fetch rejects', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));

    const runtime = createRuntime();
    const readyPromise = runtime.waitForReady('http://127.0.0.1:4096', 1);

    await vi.advanceTimersByTimeAsync(100);
    await expect(readyPromise).resolves.toBe(false);

    expect(vi.getTimerCount()).toBe(0);
  });

  it('types a missing managed runtime port as transient unavailability', () => {
    const runtime = createRuntime({ openCodePort: null });

    expect(() => runtime.buildOpenCodeUrl('/session')).toThrowError(expect.objectContaining({
      message: 'OpenCode port is not available',
      code: 'managed_runtime_unavailable',
      statusCode: 503,
    }));
  });
});
