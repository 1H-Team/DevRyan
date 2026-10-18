import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';

import {
  createRuntimeServiceCoordinator,
  readRuntimeServiceDescriptor,
  terminateRuntimeServiceProcess,
  validateRuntimeServiceDescriptor,
} from '../runtime-service.mjs';
import { retireMismatchedRuntimeService, retryRuntimeServiceConnection } from '../runtime-service-startup.mjs';
import { APP_VERSION, connectionFixture, serviceDescriptor } from './runtime-service-connection-fixture.mjs';

const mainSource = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`sealed:${value}`, 'utf8'),
  decryptString: (value) => Buffer.from(value).toString('utf8').slice('sealed:'.length),
};
const baseDescriptor = {
  version: 1,
  instanceId: '11111111-1111-4111-8111-111111111111',
  pid: 4242,
  port: 57123,
  protocolVersion: 2,
  health: 'healthy',
  ownerGeneration: 3,
  desktopHost: { state: 'unavailable', leaseId: null, expiresAt: null, capabilities: [] },
  sealedBootstrapToken: Buffer.from('sealed:fixture-token').toString('base64'),
  updatedAt: '2026-10-05T00:00:00.000Z',
};

describe('runtime-service descriptor app version', () => {
  test('the service publishes its app version; pre-2.0.1 descriptors without one stay readable', async () => {
    const dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-runtime-version-'));
    directories.push(dataDirectory);
    const coordinator = await createRuntimeServiceCoordinator({
      dataDirectory, safeStorage, pid: 41, isProcessAlive: () => false, appVersion: '2.0.1',
    });
    await coordinator.acquire({ mode: 'service' });
    await coordinator.start({ port: 57123 });
    assert.equal((await readRuntimeServiceDescriptor({ dataDirectory })).appVersion, '2.0.1');

    assert.equal(validateRuntimeServiceDescriptor(baseDescriptor).appVersion, undefined);
    assert.equal(validateRuntimeServiceDescriptor({ ...baseDescriptor, appVersion: '2.0.1' }).appVersion, '2.0.1');
    for (const appVersion of [null, '', 'v2.0.1', '2.0', '2.0.1\n', 2]) {
      assert.throws(() => validateRuntimeServiceDescriptor({ ...baseDescriptor, appVersion }),
        { code: 'runtime_service_descriptor_invalid' }, String(appVersion));
    }
    await assert.rejects(createRuntimeServiceCoordinator({ dataDirectory, safeStorage, appVersion: '../2.0.1' }),
      { code: 'runtime_service_config_invalid' });
  });
});

describe('retiring a background runtime from another app version', () => {
  const harness = ({ drain, unregister = { ok: true, state: 'not_registered' }, stopped = [true], terminate = true, register } = {}) => {
    const calls = [];
    const waits = [...stopped];
    return {
      calls,
      run: () => retireMismatchedRuntimeService({
        descriptor: baseDescriptor,
        appVersion: '2.0.1',
        drain: async () => { calls.push('drain'); if (drain) throw drain; },
        unregister: async () => { calls.push('unregister'); return unregister; },
        waitForStopped: async (timeoutMs) => { calls.push(['wait', timeoutMs]); return waits.shift() ?? false; },
        terminate: async (signal) => { calls.push(['terminate', signal]); return terminate; },
        register: async () => { calls.push('register'); if (register) throw register; },
      }),
    };
  };

  test('drains, unregisters, proves the old owner stopped, then registers the current service', async () => {
    const { calls, run } = harness();
    await run();
    assert.deepEqual(calls, ['drain', 'unregister', ['wait', 15_000], 'register']);
  });

  test('a refused drain (an old service, a failed bootstrap) still unregisters and waits', async () => {
    const { calls, run } = harness({ drain: Object.assign(new Error('x'), { code: 'runtime_service_bootstrap_rejected' }) });
    await run();
    assert.deepEqual(calls, ['drain', 'unregister', ['wait', 15_000], 'register']);
  });

  test('an owner that outlives the drain is signalled TERM then KILL, each bounded', async () => {
    const { calls, run } = harness({ stopped: [false, false, true] });
    await run();
    assert.deepEqual(calls, ['drain', 'unregister', ['wait', 15_000], ['terminate', 'SIGTERM'], ['wait', 5_000],
      ['terminate', 'SIGKILL'], ['wait', 5_000], 'register']);
  });

  test('an unverifiable process is never signalled further and the failure is final', async () => {
    const { calls, run } = harness({ stopped: [false], terminate: false });
    await assert.rejects(run(), (error) => error.code === 'runtime_service_owner_active' && error.retryable === false);
    assert.deepEqual(calls, ['drain', 'unregister', ['wait', 15_000], ['terminate', 'SIGTERM']]);
  });

  test('unregister and registration failures are final, so startup falls back instead of waiting', async () => {
    const unregistered = harness({ unregister: { ok: false, state: 'enabled' } });
    await assert.rejects(unregistered.run(), (error) => error.code === 'runtime_service_unregister_failed' && error.retryable === false);
    assert.deepEqual(unregistered.calls, ['drain', 'unregister']);
    const registration = harness({ register: Object.assign(new Error('x'), { code: 'runtime_service_not_registered' }) });
    await assert.rejects(registration.run(), (error) => error.code === 'runtime_service_not_registered' && error.retryable === false);
  });

  test('the connection wait stops at once on a final failure', async () => {
    let attempts = 0;
    await assert.rejects(retryRuntimeServiceConnection({
      connect: async () => { attempts += 1; throw Object.assign(new Error('x'), { code: 'runtime_service_owner_active', retryable: false }); },
      now: () => 0,
      wait: async () => {},
    }), { code: 'runtime_service_owner_active' });
    assert.equal(attempts, 1);
  });
});

describe('verified stale-service termination', () => {
  const IMAGE = '/Applications/DevRyan.app/Contents/MacOS/DevRyan';
  const image = (path, pid = 4242) => `p${pid}\nftxt\nn${path}\nftxt\nn/usr/lib/dyld\n`;
  const probe = (stdout, { lsof = image(IMAGE), error = null, lsofError = null } = {}) => {
    const signals = [];
    return {
      signals,
      run: (options = {}) => terminateRuntimeServiceProcess({
        pid: 4242, uid: 501, platform: 'darwin',
        execute: (file, args, _options, callback) => {
          if (file === '/bin/ps') {
            assert.deepEqual(args, ['-p', '4242', '-o', 'uid=,command=']);
            callback(error, stdout);
            return;
          }
          assert.equal(file, '/usr/sbin/lsof');
          assert.deepEqual(args, ['-a', '-p', '4242', '-d', 'txt', '-Fn']);
          callback(lsofError, lsof);
        },
        kill: (pid, signal) => signals.push([pid, signal]),
        ...options,
      }),
    };
  };

  test('signals only this user\'s DevRyan --runtime-service at the descriptor PID', async () => {
    // SMAppService/launchd starts the BundleProgram with ProgramArguments
    // ["DevRyan", "--runtime-service"], so argv carries no path.
    const launchd = probe('  501 DevRyan --runtime-service\n');
    assert.equal(await launchd.run({ signal: 'SIGKILL' }), true);
    assert.deepEqual(launchd.signals, [[4242, 'SIGKILL']]);
    const verified = probe('  501 /Applications/DevRyan.app/Contents/MacOS/DevRyan --runtime-service\n');
    assert.equal(await verified.run(), true);
    assert.deepEqual(verified.signals, [[4242, 'SIGTERM']]);
    const spacedImage = '/Users/me/Apps/DevRyan 2.app/Contents/MacOS/DevRyan';
    assert.equal(await probe(`501 ${spacedImage} --runtime-service`, { lsof: image(spacedImage) }).run(), true);
    assert.equal(await probe('501 DevRyan --runtime-service', { lsof: image(spacedImage) }).run(), true);
    // A legacy full-path argv equal to its own image is accepted even when the path holds ' -'.
    for (const dashedImage of ['/Users/me/My -Apps/DevRyan.app/Contents/MacOS/DevRyan', '/Users/me/Apps/DevRyan - copy.app/Contents/MacOS/DevRyan']) {
      assert.equal(await probe(`501 ${dashedImage} --runtime-service`, { lsof: image(dashedImage) }).run(), true);
    }
  });

  test('signals a legacy full-path service whose bundle was moved while it ran', async () => {
    // The legacy plist launched the absolute path; moving the bundle (to the
    // Trash, or a replaced install) leaves argv on the old path.
    const moved = probe('501 /Applications/DevRyan.app/Contents/MacOS/DevRyan --runtime-service', {
      lsof: image('/Users/me/.Trash/DevRyan.app/Contents/MacOS/DevRyan'),
    });
    assert.equal(await moved.run(), true);
    assert.deepEqual(moved.signals, [[4242, 'SIGTERM']]);
  });

  for (const [name, stdout, options, lsofOptions = {}] of [
    ['another user', '0 DevRyan --runtime-service', {}],
    ['another user at the absolute path', '0 /Applications/DevRyan.app/Contents/MacOS/DevRyan --runtime-service', {}],
    ['the foreground app', '501 /Applications/DevRyan.app/Contents/MacOS/DevRyan', {}],
    ['the foreground app started by launchd', '501 DevRyan', {}],
    ['another program', '501 /usr/bin/python3 --runtime-service', {}],
    ['another program named DevRyan', '501 DevRyan --runtime-service', {}, { lsof: image('/usr/local/bin/DevRyan') }],
    ['another bundle\'s executable', '501 DevRyan --runtime-service', {}, { lsof: image('/Applications/Other.app/Contents/MacOS/DevRyanHelper') }],
    ['a relative image', '501 DevRyan --runtime-service', {}, { lsof: image('DevRyan.app/Contents/MacOS/DevRyan') }],
    ['an argv path that is not a DevRyan image', '501 /Applications/Old.app/Contents/MacOS/Helper --runtime-service', {}],
    ['a relative argv path', '501 Applications/DevRyan.app/Contents/MacOS/DevRyan --runtime-service', {}],
    ['a moved bundle\'s argv over a foreign image', '501 /Applications/DevRyan.app/Contents/MacOS/DevRyan --runtime-service', {}, { lsof: image('/usr/local/bin/DevRyan') }],
    ['a moved bundle of another user', '0 /Applications/DevRyan.app/Contents/MacOS/DevRyan --runtime-service', {}, { lsof: image('/Users/me/.Trash/DevRyan.app/Contents/MacOS/DevRyan') }],
    ['a moved bundle at another PID', '501 /Applications/DevRyan.app/Contents/MacOS/DevRyan --runtime-service', {}, { lsof: image('/Users/me/.Trash/DevRyan.app/Contents/MacOS/DevRyan', 4243) }],
    ['a full-path service with extra arguments', '501 /Applications/DevRyan.app/Contents/MacOS/DevRyan --runtime-service --type=renderer', {}],
    ['a full-path foreground app', '501 /Applications/DevRyan.app/Contents/MacOS/DevRyan --inspect --runtime-service', {}],
    ['an image probe for another PID', '501 DevRyan --runtime-service', {}, { lsof: image(IMAGE, 4243) }],
    ['an image probe without a text entry', '501 DevRyan --runtime-service', {}, { lsof: 'p4242\n' }],
    ['an unavailable image probe', '501 DevRyan --runtime-service', {}, { lsof: '', lsofError: new Error('lsof failed') }],
    ['a shell wrapping the command', '501 /bin/sh -c /Applications/DevRyan.app/Contents/MacOS/DevRyan --runtime-service', {}],
    ['a shell wrapping a moved bundle', '501 /bin/sh -c /Applications/DevRyan.app/Contents/MacOS/DevRyan --runtime-service', {}, { lsof: image('/Users/me/.Trash/DevRyan.app/Contents/MacOS/DevRyan') }],
    ['a reused PID with extra arguments', '501 DevRyan --runtime-service --type=renderer', {}],
    ['a missing process', '', {}],
    ['a non-macOS host', '501 DevRyan --runtime-service', { platform: 'linux' }],
    ['an unsupported signal', '501 DevRyan --runtime-service', { signal: 'SIGHUP' }],
  ]) {
    test(`leaves ${name} alone`, async () => {
      const check = probe(stdout, lsofOptions);
      assert.equal(await check.run(options), false);
      assert.deepEqual(check.signals, []);
    });
  }

  test('an unavailable probe is not permission to signal', async () => {
    const check = probe('', { error: new Error('ps failed') });
    assert.equal(await check.run(), false);
    assert.deepEqual(check.signals, []);
  });
});

describe('foreground connection to the background runtime', () => {
  const retirement = () => {
    const events = [];
    let stopped = false;
    return {
      events,
      overrides: {
        getRegistration: () => ({
          unregister: async () => { events.push('unregister'); return { ok: true, state: 'not_registered', code: null }; },
          status: async () => { events.push('status'); return { ok: true, state: 'not_registered', code: null }; },
          register: async (options) => { events.push(['register', options]); return { ok: true, state: 'enabled', code: null }; },
        }),
        waitForOwnerStopped: async (timeoutMs) => { events.push(['stopped?', timeoutMs]); return stopped; },
        terminateProcess: async (request) => { events.push(['terminate', request]); stopped = true; return true; },
      },
    };
  };

  for (const [name, appVersion] of [['no app version (1.x, 2.0.0)', undefined], ['another app version', '2.0.2']]) {
    test(`a live service with ${name} is retired and never attached`, async () => {
      const retire = retirement();
      const { calls, state, requests, brokers, connection } = connectionFixture({
        descriptors: [serviceDescriptor({ appVersion })], overrides: retire.overrides,
      });
      await assert.rejects(connection.connect(), (error) => error.code === 'runtime_service_unavailable' && error.retryable !== false);
      assert.equal(calls[0], 'owner');
      assert.equal(retire.events.filter((event) => event === 'unregister').length, 1);
      assert.equal(state.runtimeServiceClient, false);
      assert.equal(state.sidecarUrl, null);
      assert.equal(brokers.length, 0);
      assert.ok(!requests.some((request) => request.kind === 'lease'));
      // Retired once: a second mismatched owner ends the wait instead of looping.
      await assert.rejects(connection.connect(), (error) => error.code === 'runtime_service_version_mismatch' && error.retryable === false);
      assert.equal(retire.events.filter((event) => event === 'unregister').length, 1);
    });
  }

  test('a reconnect never retires or attaches a mismatched service', async () => {
    const retire = retirement();
    const { calls, state, connection } = connectionFixture({
      descriptors: [serviceDescriptor({ appVersion: '2.0.0' })], overrides: retire.overrides,
    });
    await assert.rejects(connection.connect({ reconnecting: true }), { code: 'runtime_service_version_mismatch' });
    assert.deepEqual(calls, ['owner']);
    assert.deepEqual(retire.events, []);
    assert.equal(state.runtimeServiceClient, false);
  });

  test('a service of this app version is attached', async () => {
    const { calls, state, connection } = connectionFixture({ descriptors: [serviceDescriptor({ appVersion: APP_VERSION })] });
    assert.equal(await connection.connect(), 'http://127.0.0.1:57123');
    assert.deepEqual(calls, ['owner', 'health', 'owner', ['cookie', 'http://127.0.0.1:57123'], 'broker', 'record']);
    assert.equal(state.runtimeServiceClient, true);
  });

  test('retirement drains through prepare-update, signals only the verified pid and registers through the startup registration check', async () => {
    const retire = retirement();
    const { requests, connection } = connectionFixture({
      descriptors: [serviceDescriptor({ appVersion: '2.0.2' })], overrides: retire.overrides,
    });
    await assert.rejects(connection.connect(), { code: 'runtime_service_unavailable' });
    assert.deepEqual(requests.map((request) => [request.kind, request.method]), [['bootstrap', 'POST'], ['prepare-update', 'POST']]);
    assert.equal(requests[1].url, 'http://127.0.0.1:57123/api/runtime-service/prepare-update');
    assert.deepEqual(retire.events, [
      'unregister', ['stopped?', 15_000], ['terminate', { pid: 4242, signal: 'SIGTERM' }], ['stopped?', 5_000],
      'status', ['register', { allowLegacy: true }],
    ]);
  });

  test('the runtime coordinator publishes this app version', () => {
    assert.match(mainSource, /createRuntimeServiceCoordinator\(\{\s+dataDirectory: dataRootDirectory\(\), safeStorage, appVersion: APP_VERSION,/);
  });
});

describe('verified installer update drain', () => {
  const start = mainSource.indexOf('const cleanupUpdateOwners = async () => {');
  const end = mainSource.indexOf('const rollbackCandidateUpdate =', start);
  assert.ok(start > 0 && end > start);
  const run = new AsyncFunction('deps', `
    const { localServerStartPromise, prepareBackgroundRuntimeForAppUpdate, speechManager, killSidecar, sshManager, stopDesktopHostBroker } = deps;
    ${mainSource.slice(start, end)}
    return cleanupUpdateOwners();
  `);
  test('waits for startup ownership and background drain before settling all remaining owned resources', async () => {
    const calls = [];
    await run({ localServerStartPromise: Promise.resolve().then(() => calls.push('startup-settled')),
      prepareBackgroundRuntimeForAppUpdate: async () => calls.push('background-drained'),
      speechManager: { shutdown: () => calls.push('speech') },
      killSidecar: async options => { assert.deepEqual(options, { strict: true });calls.push('native-owner'); },
      sshManager: { shutdownAll: async () => calls.push('ssh') },stopDesktopHostBroker: async () => calls.push('broker'),
    });
    assert.deepEqual(calls, ['startup-settled', 'background-drained', 'speech', 'native-owner', 'ssh', 'broker']);
  });
  test('unconfirmed startup or background termination cannot acknowledge installer cleanup', async () => {
    for (const phase of ['startup', 'background']) {
      const calls = [], failure = Object.assign(new Error('Unconfirmed owner'), { code: 'runtime_service_update_owner_active' });
      await assert.rejects(run({ localServerStartPromise: phase === 'startup' ? Promise.reject(failure) : null,
        prepareBackgroundRuntimeForAppUpdate: async () => { throw failure; },
        speechManager: { shutdown: () => calls.push('speech') },killSidecar: () => calls.push('native'),
        sshManager: { shutdownAll: () => calls.push('ssh') },stopDesktopHostBroker: () => calls.push('broker'),
      }), failure);
      assert.deepEqual(calls, []);
    }
  });
  test('the drain reports whether it stopped a background runtime', () => {
    const body = mainSource.slice(mainSource.indexOf('const prepareBackgroundRuntimeForAppUpdate = async () => {'),
      mainSource.indexOf('const resumeBackgroundRuntimeAfterAppUpdate = '));
    assert.match(body, /if \(!state\.runtimeServiceClient\) return false;/);
    assert.match(body, /\n  return true;\n\};\n/);
  });
});
