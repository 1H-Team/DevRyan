import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { prepareAutomaticRuntimeService, createRuntimeOwnerAcquirer, recoverAppBoundRuntime } from '../runtime-service-startup.mjs';
import { createRuntimeServiceRegistration } from '../runtime-service-registration.mjs';

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

describe('transactional foreground recovery', () => {
  for (const connectionCode of ['runtime_service_descriptor_missing', 'smappservice_registration_failed', 'runtime_service_approval_required']) {
    test(`recovers stale service mode or post-update failure: ${connectionCode}`, async () => {
      const calls = [];
      const logs = [];
      const registration = createRuntimeServiceRegistration({
        platform: 'darwin', macosMajor: 15, isPackaged: true,
        executablePath: '/test/DevRyan.app/Contents/MacOS/DevRyan',
        dataDirectory: '/test/data', homeDirectory: '/test/home',
        fsPromises: { stat: async () => { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); } },
        nativeControl: { unregister: async () => {
          calls.push('unregister');
          return { ok: false, state: 'not_found', code: 'smappservice_unregistration_failed' };
        } },
      });
      const { result } = await run({ currentMode: 'service' });
      assert.equal(result.mode, 'service');
      await recoverAppBoundRuntime({
        connectionError: Object.assign(new Error('connection failed'), { code: connectionCode }),
        unregister: () => registration.unregister(),
        waitForStopped: async () => { calls.push('wait'); return true; },
        acquire: async () => { calls.push('acquire'); },
        setMode: async () => { calls.push('persist'); },
        release: async () => { calls.push('release'); },
        log: { warn: (_message, detail) => logs.push(detail) },
      });
      assert.deepEqual(calls, ['unregister', 'wait', 'acquire', 'persist']);
      assert.deepEqual(logs[0], {
        phase: 'app_bound_acquired', code: 'runtime_service_startup_recovered',
        registrationState: 'not_found', registrationCode: 'smappservice_unregistration_failed',
        connectionCode,
      });
    });
  }

  test('failure diagnostics retain only allowlisted states and bounded machine codes', async () => {
    const logs = [];
    const connectionError = Object.assign(new Error('original'), { code: 'private/path' });
    await assert.rejects(recoverAppBoundRuntime({
      connectionError,
      unregister: async () => ({ ok: false, state: 'private data', code: `runtime_service_${'a'.repeat(101)}` }),
      log: { warn: (_message, detail) => logs.push(detail) },
    }), (error) => error.cause === connectionError && error.code === 'runtime_service_unregister_failed');
    assert.deepEqual(logs[0], {
      phase: 'unregister', code: 'runtime_service_unregister_failed',
      registrationState: null, registrationCode: null, connectionCode: 'runtime_service_connection_failed',
    });
  });

  test('failed acquisition is never cached, retries reacquire, and concurrent attempts share a claim', async () => {
    let coordinator = null;
    let attempts = 0;
    const acquire = createRuntimeOwnerAcquirer({
      getCoordinator: () => coordinator,
      setCoordinator: (value) => { coordinator = value; },
      createCoordinator: async () => ({
        acquire: async () => {
          attempts += 1;
          if (attempts === 1) throw Object.assign(new Error('invalid'), { code: 'runtime_service_owner_invalid' });
        },
        getOwner: () => ({ mode: 'app_bound' }),
      }),
    });
    await assert.rejects(acquire('app_bound'), { code: 'runtime_service_owner_invalid' });
    assert.equal(coordinator, null);
    const results = await Promise.all([acquire('app_bound'), acquire('app_bound')]);
    assert.equal(attempts, 2);
    assert.equal(results[0], results[1]);
    await acquire('app_bound');
    assert.equal(attempts, 2);
  });

  const scenario = async (failure) => {
    const calls = [];
    const connectionError = Object.assign(new Error('connection failed'), { code: 'runtime_service_start_timeout' });
    let error;
    try {
      await recoverAppBoundRuntime({
        connectionError,
        unregister: async () => { calls.push('unregister'); return { ok: failure !== 'unregister' }; },
        waitForStopped: async () => {
          calls.push('wait');
          if (failure === 'corrupt') throw Object.assign(new Error('damaged'), { code: 'runtime_service_owner_invalid' });
          return failure !== 'active';
        },
        acquire: async () => {
          calls.push('acquire');
          if (failure === 'acquire') throw Object.assign(new Error('competing owner'), { code: 'runtime_service_owner_exists' });
        },
        setMode: async () => { calls.push('persist'); if (failure === 'persist') throw new Error('disk full'); },
        release: async () => { calls.push('release'); },
      });
    } catch (caught) { error = caught; }
    return { calls, error, connectionError };
  };

  test('fallback acquires ownership before persisting mode', async () => {
    const { calls, error } = await scenario();
    assert.equal(error, undefined);
    assert.deepEqual(calls, ['unregister', 'wait', 'acquire', 'persist']);
  });
  for (const failure of ['unregister', 'active', 'corrupt', 'acquire', 'persist']) {
    test(`${failure} failure stops fallback and retains the original connection error`, async () => {
      const { calls, error, connectionError } = await scenario(failure);
      assert.equal(error.cause, connectionError);
      assert.match(error.code, /^runtime_service_/);
      if (failure === 'persist') assert.deepEqual(calls, ['unregister', 'wait', 'acquire', 'persist', 'release']);
      else assert.equal(calls.includes('persist'), false);
      if (failure === 'unregister') assert.deepEqual(calls, ['unregister']);
      if (failure === 'active' || failure === 'corrupt') assert.deepEqual(calls, ['unregister', 'wait']);
    });
  }
});
