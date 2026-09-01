import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { prepareAutomaticRuntimeService } from '../runtime-service-startup.mjs';

const run = async ({ currentMode = 'app_bound', status, register } = {}) => {
  const modes = [];
  const result = await prepareAutomaticRuntimeService({
    currentMode,
    platform: 'darwin',
    isPackaged: true,
    registration: {
      status: async () => status,
      register: register || (async () => ({ ok: true, state: 'enabled', code: null })),
    },
    setMode: async (mode) => modes.push(mode),
  });
  return { result, modes };
};

describe('automatic background runtime startup', () => {
  test('registers a first launch and selects service ownership', async () => {
    const options = [];
    const { result, modes } = await run({
      status: { ok: true, state: 'not_registered', code: null },
      register: async (value) => {
        options.push(value);
        return { ok: true, state: 'enabled', code: null };
      },
    });
    assert.equal(result.mode, 'service');
    assert.deepEqual(modes, ['service']);
    assert.deepEqual(options, [{ allowLegacy: true }]);
  });

  test('keeps app-bound Bots available while approval is required', async () => {
    const { result, modes } = await run({
      status: { ok: true, state: 'requires_approval', code: null },
    });
    assert.equal(result.mode, 'app_bound');
    assert.equal(result.state, 'requires_approval');
    assert.deepEqual(modes, []);
  });

  test('persists automatic fallback so an unavailable service is not awaited again', async () => {
    const { result, modes } = await run({
      currentMode: 'automatic',
      status: { ok: false, state: 'unavailable', code: 'runtime_service_bridge_unavailable' },
    });
    assert.equal(result.mode, 'app_bound');
    assert.equal(result.state, 'unavailable');
    assert.deepEqual(modes, ['app_bound']);
  });

  test('keeps app-bound Bots available on safe registration failure', async () => {
    const { result, modes } = await run({
      status: { ok: true, state: 'not_registered', code: null },
      register: async () => {
        throw Object.assign(new Error('denied'), { code: 'smappservice_registration_failed' });
      },
    });
    assert.equal(result.mode, 'app_bound');
    assert.equal(result.code, 'smappservice_registration_failed');
    assert.deepEqual(modes, []);
  });

  test('restores app-bound mode when automatic private-agent fallback fails', async () => {
    const { result, modes } = await run({
      currentMode: 'automatic',
      status: { ok: true, state: 'not_registered', code: null },
      register: async () => {
        throw Object.assign(new Error('launchctl failed'), {
          code: 'runtime_service_registration_failed',
        });
      },
    });

    assert.equal(result.mode, 'app_bound');
    assert.equal(result.state, 'registration_failed');
    assert.equal(result.code, 'runtime_service_registration_failed');
    assert.deepEqual(modes, ['app_bound']);
  });

  test('honors an explicit disabled mode without inspecting registration', async () => {
    let inspected = false;
    const result = await prepareAutomaticRuntimeService({
      currentMode: 'disabled',
      platform: 'darwin',
      isPackaged: true,
      registration: { status: async () => { inspected = true; } },
      setMode: async () => undefined,
    });
    assert.equal(result.mode, 'disabled');
    assert.equal(inspected, false);
  });
});
