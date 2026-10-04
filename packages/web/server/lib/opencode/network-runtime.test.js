import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createLoopbackOpenCodeV2Fixture } from '../../../../../scripts/perf/loopback-opencode-v2-fixture.mjs';
import { createOpenCodeNetworkRuntime } from './network-runtime.js';
import { TARGET_OPENCODE_V2_VERSION } from './readiness-probe.js';

// The managed generation is read from the runtime selection in the data
// directory; keep every read inside a disposable one.
const originalDataDir = process.env.OPENCHAMBER_DATA_DIR;
let isolatedDataDir = null;
beforeAll(() => {
  isolatedDataDir = mkdtempSync(join(tmpdir(), 'devryan-network-runtime-'));
  process.env.OPENCHAMBER_DATA_DIR = isolatedDataDir;
});
afterAll(() => {
  if (typeof originalDataDir === 'string') process.env.OPENCHAMBER_DATA_DIR = originalDataDir;
  else delete process.env.OPENCHAMBER_DATA_DIR;
  if (isolatedDataDir) rmSync(isolatedDataDir, { recursive: true, force: true });
});

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
  resolveOpenCodeGeneration: () => ({ generation: 2, source: 'selection' }),
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

  describe('readiness by generation', () => {
    let directory;
    let v2;

    beforeAll(async () => {
      directory = mkdtempSync(join(tmpdir(), 'devryan-network-ready-'));
      v2 = await createLoopbackOpenCodeV2Fixture({ directory, heartbeatMs: 50 });
    });

    afterAll(async () => {
      await v2?.close();
      if (directory) rmSync(directory, { recursive: true, force: true });
    });

    const createGenerationRuntime = ({ generation, authHeaders = {} }) => {
      const state = { openCodePort: 4096, openCodeBaseUrl: null, openCodeVersion: 'stale' };
      const runtime = createOpenCodeNetworkRuntime({
        state,
        getOpenCodeAuthHeaders: () => authHeaders,
        ...(generation === undefined ? {} : { resolveOpenCodeGeneration: () => ({ generation, source: 'selection' }) }),
      });
      return { runtime, state };
    };

    it('refuses readiness without a managed native selection before I/O', async () => {
      const { runtime, state } = createGenerationRuntime({});
      const fetch = vi.spyOn(globalThis, 'fetch');
      try {
        await expect(runtime.waitForReady(v2.origin, 2000)).resolves.toBe(false);
        expect(state.openCodeVersion).toBe('stale');
        expect(fetch).not.toHaveBeenCalled();
      } finally { fetch.mockRestore(); }
    });

    it('waits for a gen-2 host on /devryan/ready and /api/info and records the pinned version', async () => {
      v2.setReady({ ready: false, phase: 'booting', retryAfterMs: 50 });
      const { runtime, state } = createGenerationRuntime({ generation: 2, authHeaders: v2.authHeaders });
      const ready = runtime.waitForReady(v2.origin, 5000);
      setTimeout(() => v2.setReady({ ready: true }), 150);
      await expect(ready).resolves.toBe(true);
      expect(state).toMatchObject({ openCodeVersion: TARGET_OPENCODE_V2_VERSION, openCodeGeneration: 2 });
    });

    it('never reports a generation mismatch as ready', async () => {
      const fetch = vi.spyOn(globalThis, 'fetch');
      try {
        for (const generation of [1, null]) {
          const invalid = createGenerationRuntime({ generation, authHeaders: v2.authHeaders });
          await expect(invalid.runtime.waitForReady(v2.origin, 60_000)).resolves.toBe(false);
          expect(invalid.state.openCodeVersion).toBe('stale');
        }
        expect(fetch).not.toHaveBeenCalled();
      } finally { fetch.mockRestore(); }
    });
  });
});
