import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  describeRuntimeServiceStatus,
  ensureRuntimeServiceRegistered,
  prepareAutomaticRuntimeService,
  createRuntimeOwnerAcquirer,
  acquireRuntimeServiceOwnership,
  recoverAppBoundRuntime,
  retryRuntimeServiceConnection,
  runtimeServiceRequestSignal,
  runStartupPhase,
  createDesktopHostLeaseHandler,
} from '../runtime-service-startup.mjs';
import { createRuntimeServiceRegistration } from '../runtime-service-registration.mjs';

test('Windows preserves a service preference without granting registration, connection or execution', async () => {
  const touched = () => { throw Error('Unsupported service reached a native owner'); };
  const owner = createRuntimeServiceRegistration({ platform: 'win32', fsPromises: { stat: touched }, execFile: touched });
  const registration = await owner.status();
  const status = describeRuntimeServiceStatus({ platform: 'win32', isPackaged: true, configuredMode: 'service',
    optedOut: false, registrationMode: owner.mode, registration, handshake: { ready: true }, settingsUrl: 'unreachable' });
  assert.deepEqual({ configuredMode: status.configuredMode, serviceEnabled: status.serviceEnabled,
    connected: status.connected, canEnable: status.canEnable, handshake: status.handshake, settingsUrl: status.settingsUrl },
  { configuredMode: 'service', serviceEnabled: false, connected: false, canEnable: false, handshake: null, settingsUrl: null });
  await assert.rejects(owner.register(), { code: 'runtime_service_platform_unsupported' });
  const prepared = await prepareAutomaticRuntimeService({ platform: 'win32', isPackaged: true,
    currentMode: 'app_bound', registration: { status: touched, register: touched }, setMode: touched });
  assert.equal(prepared.state, 'skipped');
  assert.equal(describeRuntimeServiceStatus({ platform: 'darwin', isPackaged: true, configuredMode: 'service',
    registration: { state: 'enabled' }, handshake: null }).serviceEnabled, true);
});

describe('opt-in background runtime startup', () => {
  test('fresh, app-bound and disabled installations never register', async () => {
    for (const currentMode of [undefined, 'app_bound', 'disabled']) {
      const forbidden = () => { throw Error('First launch must not register'); };
      const result = await prepareAutomaticRuntimeService({ currentMode, platform: 'darwin', isPackaged: true,
        registration: { status: async () => ({ ok: true, state: 'not_registered' }), register: forbidden },
        waitForStopped: forbidden });
      assert.equal(result.mode, currentMode ?? 'app_bound');
      assert.equal(describeRuntimeServiceStatus({ platform: 'darwin', isPackaged: true, configuredMode: currentMode,
        registration: { state: 'not_registered' } }).serviceEnabled, false);
    }
  });
  test('explicit service installs retain their preference and existing registration path', async () => {
    const result = await prepareAutomaticRuntimeService({ currentMode: 'service', platform: 'darwin', isPackaged: true,
      registration: { status: () => { throw Error('Handled by service registration recovery'); } } });
    assert.equal(result.mode, 'service');
  });
  test('stray registration is removed before owner absence is established, without changing stored mode', async () => {
    for (const currentMode of [undefined, 'app_bound', 'disabled']) {
      const calls = [];
      const result = await prepareAutomaticRuntimeService({ currentMode, platform: 'darwin', isPackaged: true,
        registration: { status: async () => ({ ok: true, state: 'enabled' }),
          unregister: async () => { calls.push('unregister'); return { ok: true }; },
          register: () => { throw Error('Unexpected opt-in'); } },
        waitForStopped: async () => { calls.push('stopped'); return true; } });
      assert.deepEqual(calls, ['unregister', 'stopped']);
      assert.equal(result.mode, currentMode ?? 'app_bound');
    }
  });
  test('a bundle without a service definition starts app-bound with nothing to remove', async () => {
    const forbidden = () => { throw Error('Nothing is registered'); };
    const result = await prepareAutomaticRuntimeService({ currentMode: 'app_bound', platform: 'darwin', isPackaged: true,
      registration: { status: async () => ({ ok: true, state: 'not_found' }), register: forbidden, unregister: forbidden },
      waitForStopped: forbidden });
    assert.deepEqual({ ...result }, { mode: 'app_bound', state: 'not_registered', code: null });
    await assert.rejects(prepareAutomaticRuntimeService({ currentMode: 'app_bound', platform: 'darwin', isPackaged: true,
      registration: { status: async () => ({ ok: false, state: 'not_found', code: 'smappservice_status_failed' }) } }),
    { code: 'runtime_service_registration_unavailable' });
  });
  test('live owner, failed unregister and uncertain registration all fail closed', async () => {
    for (const state of ['live', 'unregister', 'unknown']) {
      await assert.rejects(prepareAutomaticRuntimeService({ currentMode: 'app_bound', platform: 'darwin', isPackaged: true,
        registration: { status: async () => ({ ok: true, state: state === 'unknown' ? 'unknown' : 'enabled' }),
          unregister: async () => ({ ok: state !== 'unregister' }) }, waitForStopped: async () => false }),
      { code: state === 'live' ? 'runtime_service_owner_active' : state === 'unregister' ? 'runtime_service_unregister_failed' : 'runtime_service_registration_unavailable' });
    }
  });
});

test('ownership contention uses remaining budget and never abandons an in-flight acquisition', async () => {
  let now = 0, calls = 0;
  const budgets = [];
  const result = await acquireRuntimeServiceOwnership({ now: () => now, wait: async ms => { now += ms; },
    acquire: async ({ timeoutMs }) => {
      budgets.push(timeoutMs); calls++;
      if (calls === 1) { now += 5000; throw Object.assign(Error('busy'), { code: 'runtime_service_owner_busy' }); }
      now += 50000; return 'owned';
    } });
  assert.equal(result, 'owned'); assert.deepEqual(budgets, [45000, 39975]);
  for (const code of ['runtime_service_owner_exists', 'runtime_service_owner_invalid', 'EIO']) {
    let attempts = 0;
    await assert.rejects(acquireRuntimeServiceOwnership({ acquire: async () => { attempts++; throw Object.assign(Error(code), { code }); } }), { code });
    assert.equal(attempts, 1);
  }
  now = 0;
  await assert.rejects(acquireRuntimeServiceOwnership({ now: () => now, acquire: async ({ timeoutMs }) => {
    assert.equal(timeoutMs, 45000); now += timeoutMs; throw Object.assign(Error('busy'), { code: 'runtime_service_owner_busy' });
  } }), { code: 'runtime_service_owner_busy' });
  now = 0; calls = 0;
  await assert.rejects(acquireRuntimeServiceOwnership({ timeoutMs: 10, now: () => now, wait: async ms => { now += ms + 1; },
    acquire: async () => { calls++; throw Object.assign(Error('busy'), { code: 'runtime_service_owner_busy' }); },
  }), { code: 'runtime_service_owner_busy' });
  assert.equal(calls, 1, 'No new acquisition may start after the deadline');
});

describe('transactional foreground recovery', () => {
  test('explicit service recovery preserves configuration and refuses takeover while an owner lives', async () => {
    for (const stopped of [false, true]) {
      const calls = [];
      const recovery = recoverAppBoundRuntime({ configuredMode: 'service', connectionError: Error('unavailable'),
        unregister: async () => { calls.push('unregister'); return { ok: true }; },
        waitForStopped: async () => { calls.push('observe'); return stopped; },
        acquire: async () => { calls.push('acquire'); }, setMode: () => { throw Error('Service configuration must survive'); },
        release: async () => { calls.push('release'); } });
      if (stopped) await recovery;
      else await assert.rejects(recovery, { code: 'runtime_service_owner_active' });
      assert.deepEqual(calls, stopped ? ['unregister', 'observe', 'acquire'] : ['unregister', 'observe']);
    }
  });
  test('reports recovery substeps without changing ownership order', async () => {
    const phases = [], calls = [];
    await recoverAppBoundRuntime({
      connectionError: new Error('connection failed'),
      unregister: async () => { calls.push('unregister'); return { ok: true }; },
      waitForStopped: async () => { calls.push('stopped'); return true; },
      acquire: async () => { calls.push('acquired'); },
      setMode: async () => { calls.push('persisted'); },
      release: async () => { throw new Error('unexpected release'); },
      log: { info: (_message, detail) => phases.push(detail), warn: () => {} },
    });
    assert.deepEqual(calls, ['unregister', 'stopped', 'acquired', 'persisted']);
    assert.deepEqual(phases.map(row => row.phase), ['service_unregister', 'service_wait_for_owner', 'service_acquire_app_bound', 'service_persist_app_bound']);
    assert.ok(phases.every(row => row.outcome === 'completed' && row.elapsedMs >= 0));
  });

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
      const result = await prepareAutomaticRuntimeService({ currentMode: 'service', platform: 'darwin', isPackaged: true });
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

  test('a stale descriptor stops retrying only after current ownership is proved stopped', async () => {
    for (const stopped of [true, false, new Error('identity unavailable')]) {
      let attempts = 0, observations = 0, elapsed = 0;
      const result = retryRuntimeServiceConnection({
        connect: async () => {
          attempts++;
          if (attempts === 1) throw failure('runtime_service_owner_stale');
          return 'connected to the replacement';
        },
        isOwnerStopped: async () => {
          observations++;
          if (stopped instanceof Error) throw stopped;
          return stopped;
        },
        now: () => elapsed, wait: async ms => { elapsed += ms; },
      });
      if (stopped === true) {
        await assert.rejects(result, { code: 'runtime_service_owner_stale', retryable: false });
        assert.equal(attempts, 1);
        assert.equal(elapsed, 0);
      } else {
        assert.equal(await result, 'connected to the replacement');
        assert.equal(attempts, 2);
      }
      assert.equal(observations, 1);
    }
  });

  test('cold missing descriptors retain their starting budget without inspecting ownership', async () => {
    let elapsed = 0;
    const deadlines = [];
    const result = await retryRuntimeServiceConnection({
      connect: async ({ deadline }) => {
        deadlines.push(deadline);
        if (elapsed < 27_000) throw failure('ENOENT');
        return 'connected';
      },
      isOwnerStopped: () => assert.fail('Missing descriptors are expected during cold service startup'),
      now: () => elapsed, wait: async ms => { elapsed += ms; },
    });
    assert.equal(result, 'connected');
    assert.equal(deadlines[0], 20_000);
    assert.ok(deadlines.slice(1).every(deadline => deadline === 60_000));
  });

  test('HTTP aborts keep the ordinary connection budget and a sanitized timeout code', async () => {
    let elapsed = 0;
    const result = retryRuntimeServiceConnection({
      connect: async ({ deadline }) => {
        elapsed += Math.min(5_000, deadline - elapsed);
        throw new DOMException('request details', 'TimeoutError');
      },
      now: () => elapsed, wait: async ms => { elapsed += ms; },
    });
    await assert.rejects(result, { code: 'runtime_service_connection_timeout' });
    assert.equal(elapsed, 20_000);
  });
});

test('service HTTP request signals share the retry deadline and cap individual requests', t => {
  const timeouts = [];
  t.mock.method(AbortSignal, 'timeout', ms => { timeouts.push(ms); return AbortSignal.abort(); });
  runtimeServiceRequestSignal(60_000, () => 0);
  runtimeServiceRequestSignal(60_000, () => 59_900);
  assert.deepEqual(timeouts, [5_000, 100]);
  assert.throws(() => runtimeServiceRequestSignal(60_000, () => 60_000), {
    code: 'runtime_service_connection_timeout', retryable: false,
  });
});

test('desktop broker admission returns while OpenCode startup is pending and reports failure safely', async () => {
  const logs = [];
  let rejectStartup, started = false;
  const state = { serverHandle: { resumeDeferredOpenCodeStartup: () => {
    started = true;
    return new Promise((_resolve, reject) => { rejectStartup = reject; });
  } } };
  const handler = createDesktopHostLeaseHandler({ state, log: { warn: (...args) => logs.push(args) } });
  const lease = { leaseId: 'fixture', brokerToken: 'private fixture', expiresAt: 'fixture' };
  assert.equal(handler(lease), undefined);
  assert.deepEqual(state.desktopHostBrokerLease, lease);
  assert.ok(Object.isFrozen(state.desktopHostBrokerLease));
  lease.brokerToken = 'changed';
  assert.equal(state.desktopHostBrokerLease.brokerToken, 'private fixture');
  await Promise.resolve();
  assert.equal(started, true);
  assert.equal(logs.length, 0);
  rejectStartup(Object.assign(new Error('private request details'), { code: 'runtime_service_start_failed' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(logs.length, 1);
  assert.deepEqual({ ...logs[0][1], elapsedMs: 0 }, {
    phase: 'service_opencode', outcome: 'failed', elapsedMs: 0, code: 'runtime_service_start_failed',
  });
  assert.doesNotMatch(JSON.stringify(logs), /private/);
});

test('startup phase timings retain success results and original failures without payloads', async () => {
  const logs = [];
  let clock = 10;
  const log = { info: (...args) => logs.push(args), warn: (...args) => logs.push(args) };
  assert.equal(await runStartupPhase('fixture_success', async () => { clock += 12; return 'result'; }, log, () => clock), 'result');
  const error = new Error('private request details');
  await assert.rejects(runStartupPhase('fixture_failure', async () => { clock += 8; throw error; }, log, () => clock), value => value === error);
  assert.deepEqual(logs.map(([, value]) => value), [
    { phase: 'fixture_success', outcome: 'completed', elapsedMs: 12 },
    { phase: 'fixture_failure', outcome: 'failed', elapsedMs: 8, code: 'startup_phase_failed' },
  ]);
  assert.doesNotMatch(JSON.stringify(logs), /private/);
});

test('lease refreshes admit the broker without retrying failed deferred startup', async () => {
  let starts = 0;
  const state = { serverHandle: { resumeDeferredOpenCodeStartup: async () => {
    starts++;
    throw Object.assign(new Error('fixture'), { code: 'native_startup_failed' });
  } } };
  const handler = createDesktopHostLeaseHandler({ state });
  handler({ leaseId: 'initial' });
  await new Promise(resolve => setImmediate(resolve));
  handler({ leaseId: 'refreshed' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts, 1);
  assert.equal(state.desktopHostBrokerLease.leaseId, 'refreshed');
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
