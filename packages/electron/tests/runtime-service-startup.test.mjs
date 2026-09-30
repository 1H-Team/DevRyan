import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  ensureRuntimeServiceRegistered,
  prepareAutomaticRuntimeService,
  createRuntimeOwnerAcquirer,
  recoverAppBoundRuntime,
  retryRuntimeServiceConnection,
} from '../runtime-service-startup.mjs';
import { createRuntimeServiceRegistration } from '../runtime-service-registration.mjs';

const run = async ({ currentMode = 'app_bound', optedOut = false, status, register } = {}) => {
  const modes = [];
  const result = await prepareAutomaticRuntimeService({
    currentMode,
    optedOut,
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

  test('never registers the service after the user switched it off', async () => {
    let registered = false;
    const { result, modes } = await run({
      optedOut: true,
      status: { ok: true, state: 'not_registered', code: null },
      register: async () => {
        registered = true;
        return { ok: true, state: 'enabled', code: null };
      },
    });
    assert.equal(result.mode, 'app_bound');
    assert.equal(result.state, 'skipped');
    assert.equal(registered, false);
    assert.deepEqual(modes, []);
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
  for (const connectionCode of ['runtime_service_descriptor_missing', 'smappservice_registration_failed', 'runtime_service_approval_required',
    'runtime_service_owner_stale', 'desktop_host_registration_failed']) {
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

describe('background runtime connection wait', () => {
  const failure = (code) => Object.assign(new Error(code), { code });
  const retry = (connect) => {
    const clock = { now: 0, attempts: 0 };
    const result = retryRuntimeServiceConnection({
      connect: async () => {
        clock.attempts += 1;
        return connect(clock.now);
      },
      now: () => clock.now,
      wait: async (ms) => { clock.now += ms; },
    });
    return { clock, result };
  };

  test('keeps waiting past the ordinary bound while a cold service start publishes no live owner', async () => {
    // Observed cold launchd boots reached 20-27 s before the service listened.
    const { clock, result } = await retry((elapsed) => {
      if (elapsed < 10_000) throw failure('ENOENT');
      if (elapsed < 24_000) throw failure('runtime_service_owner_stale');
      if (elapsed < 27_000) throw failure('runtime_service_unavailable');
      return 'http://127.0.0.1:57123';
    });
    assert.equal(await result, 'http://127.0.0.1:57123');
    assert.ok(clock.now >= 27_000);
  });

  test('gives up on a service that never starts at the starting bound', async () => {
    const { clock, result } = retry(() => { throw failure('runtime_service_owner_stale'); });
    await assert.rejects(result, { code: 'runtime_service_owner_stale' });
    assert.ok(clock.now >= 60_000 && clock.now < 61_000);
  });

  test('keeps the ordinary bound for a definitive rejection', async () => {
    const { clock, result } = retry(() => { throw failure('desktop_host_registration_failed'); });
    await assert.rejects(result, { code: 'desktop_host_registration_failed' });
    assert.ok(clock.now >= 20_000 && clock.now < 21_000);
  });

  test('a late-starting service that rejects the connection falls back without further waiting', async () => {
    const { clock, result } = retry((elapsed) => {
      if (elapsed < 25_000) throw failure('runtime_service_owner_stale');
      throw failure('runtime_service_bootstrap_rejected');
    });
    await assert.rejects(result, { code: 'runtime_service_bootstrap_rejected' });
    assert.ok(clock.now >= 25_000 && clock.now < 25_500);
  });
});

describe('service mode without a registration', () => {
  const registration = (status, register) => {
    const calls = [];
    return { calls, status: async () => { calls.push('status'); if (status instanceof Error) throw status; return status; },
      register: async (options) => { calls.push(['register', options]); if (register instanceof Error) throw register; return register; } };
  };

  test('an enabled registration is left alone and the connection is awaited as before', async () => {
    const service = registration({ ok: true, state: 'enabled', code: null });
    assert.deepEqual(await ensureRuntimeServiceRegistered({ registration: service }), { state: 'enabled', registered: false });
    assert.deepEqual(service.calls, ['status']);
  });

  test('a missing registration is registered before waiting', async () => {
    const service = registration({ ok: true, state: 'not_registered', code: null }, { ok: true, state: 'enabled', code: null });
    const warnings = [];
    assert.deepEqual(await ensureRuntimeServiceRegistered({ registration: service, log: { warn: (...args) => warnings.push(args) } }),
      { state: 'enabled', registered: true });
    assert.deepEqual(service.calls, ['status', ['register', { allowLegacy: true }]]);
    assert.equal(warnings.length, 1);
  });

  for (const [name, status, register] of [
    ['registration needs approval', { ok: true, state: 'not_registered' }, { ok: true, state: 'requires_approval', code: null }],
    ['registration fails', { ok: true, state: 'not_registered' }, Object.assign(new Error('denied'), { code: 'smappservice_register_failed' })],
    ['approval is pending', { ok: true, state: 'requires_approval' }, undefined],
    ['the service is not in the bundle', { ok: false, state: 'not_found' }, undefined],
    ['the service is unavailable', { ok: false, state: 'unavailable' }, undefined],
  ]) {
    test(`fails at once when ${name}, so startup falls back without waiting`, async () => {
      await assert.rejects(ensureRuntimeServiceRegistered({ registration: registration(status, register) }),
        (error) => error.code === 'runtime_service_not_registered');
    });
  }

  for (const [name, status] of [
    ['the state is unknown', { ok: true, state: 'unknown' }],
    ['a legacy agent is required', { ok: true, state: 'legacy_required' }],
    ['the status cannot be read', new Error('status unavailable')],
  ]) {
    test(`keeps the ordinary wait when ${name}`, async () => {
      const result = await ensureRuntimeServiceRegistered({ registration: registration(status) });
      assert.equal(result.registered, false);
      assert.notEqual(result.state, 'enabled');
    });
  }
});
