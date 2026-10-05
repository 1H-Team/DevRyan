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
    ['an argv path that is not the image', '501 /Applications/Old.app/Contents/MacOS/DevRyan --runtime-service', {}],
    ['an image probe for another PID', '501 DevRyan --runtime-service', {}, { lsof: image(IMAGE, 4243) }],
    ['an image probe without a text entry', '501 DevRyan --runtime-service', {}, { lsof: 'p4242\n' }],
    ['an unavailable image probe', '501 DevRyan --runtime-service', {}, { lsof: '', lsofError: new Error('lsof failed') }],
    ['a shell wrapping the command', '501 /bin/sh -c /Applications/DevRyan.app/Contents/MacOS/DevRyan --runtime-service', {}],
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
  const start = mainSource.indexOf('let runtimeServiceReconnectPromise = null;');
  const end = mainSource.indexOf('const macosMajorVersion = () => {');
  assert.ok(start > 0 && end > start);
  const createConnect = new AsyncFunction('deps', `
    const { readRuntimeServiceDescriptor, isRuntimeServiceProtocolSupported, assertRuntimeServiceDescriptorOwner,
      dataRootDirectory, buildLocalUrl, waitForHealth, APP_VERSION, retireStaleRuntimeService,
      bootstrapRuntimeServiceSession, startDesktopHostBroker, registerDesktopHostLease, stopDesktopHostBroker,
      state, log, BrowserWindow, setInterval, clearInterval } = deps;
    ${mainSource.slice(start, end)}
    return connectToRuntimeService;
  `);
  const fixture = async (appVersion) => {
    const calls = [];
    const state = {};
    const descriptor = appVersion === undefined ? baseDescriptor : { ...baseDescriptor, appVersion };
    const connect = await createConnect({
      readRuntimeServiceDescriptor: async () => descriptor,
      isRuntimeServiceProtocolSupported: () => true,
      assertRuntimeServiceDescriptorOwner: async () => { calls.push('owner'); },
      dataRootDirectory: () => '/data',
      buildLocalUrl: (port) => `http://127.0.0.1:${port}/`,
      waitForHealth: async () => { calls.push('health'); return true; },
      APP_VERSION: '2.0.1',
      retireStaleRuntimeService: async (value, url) => { calls.push(['retire', value.appVersion ?? null, url]); },
      bootstrapRuntimeServiceSession: async () => { calls.push('bootstrap'); },
      startDesktopHostBroker: async () => { calls.push('broker'); return {}; },
      registerDesktopHostLease: async () => ({
        instanceId: descriptor.instanceId, ownerGeneration: descriptor.ownerGeneration, protocolVersion: descriptor.protocolVersion,
      }),
      stopDesktopHostBroker: async () => {},
      state,
      log: { warn: () => {} },
      BrowserWindow: { getAllWindows: () => [] },
      setInterval: () => ({ unref: () => {} }),
      clearInterval: () => {},
    });
    return { calls, state, connect };
  };

  for (const [name, appVersion] of [['no app version (1.x, 2.0.0)', undefined], ['another app version', '2.0.2']]) {
    test(`a live service with ${name} is retired and never attached`, async () => {
      const { calls, state, connect } = await fixture(appVersion);
      await assert.rejects(connect(), (error) => error.code === 'runtime_service_unavailable' && error.retryable !== false);
      assert.deepEqual(calls, ['owner', ['retire', appVersion ?? null, 'http://127.0.0.1:57123']]);
      assert.equal(state.runtimeServiceClient, undefined);
      assert.equal(state.sidecarUrl, undefined);
      // Retired once: a second mismatched owner ends the wait instead of looping.
      await assert.rejects(connect(), (error) => error.code === 'runtime_service_version_mismatch' && error.retryable === false);
      assert.equal(calls.filter((call) => Array.isArray(call)).length, 1);
    });
  }

  test('a reconnect never retires or attaches a mismatched service', async () => {
    const { calls, state, connect } = await fixture('2.0.0');
    await assert.rejects(connect({ reconnecting: true }), { code: 'runtime_service_version_mismatch' });
    assert.deepEqual(calls, ['owner']);
    assert.equal(state.runtimeServiceClient, undefined);
  });

  test('a service of this app version is attached', async () => {
    const { calls, state, connect } = await fixture('2.0.1');
    assert.equal(await connect(), 'http://127.0.0.1:57123');
    assert.deepEqual(calls, ['owner', 'health', 'owner', 'bootstrap', 'broker']);
    assert.equal(state.runtimeServiceClient, true);
  });

  test('retirement drains through prepare-update and registers through the startup registration check', () => {
    const body = mainSource.slice(mainSource.indexOf('const retireStaleRuntimeService = '), start);
    assert.match(body, /\/api\/runtime-service\/prepare-update/);
    assert.match(body, /terminate: \(signal\) => terminateRuntimeServiceProcess\(\{ pid: descriptor\.pid, signal \}\)/);
    assert.match(body, /register: \(\) => ensureRuntimeServiceRegistered\(/);
    assert.match(mainSource, /createRuntimeServiceCoordinator\(\{\s+dataDirectory: dataRootDirectory\(\), safeStorage, appVersion: APP_VERSION,/);
  });
});

describe('DMG fallback update', () => {
  const caseStart = mainSource.indexOf("case 'desktop_download_and_install_update':");
  const blockStart = mainSource.indexOf('if (!state.pendingUpdate.electronUpdate) {', caseStart);
  const blockEnd = mainSource.indexOf("emitToAllWindows('openchamber:update-progress'", blockStart);
  assert.ok(caseStart > 0 && blockStart > caseStart && blockEnd > blockStart);
  const run = new AsyncFunction('deps', `
    const { state, resolveUpdateDownloadFallback, GITHUB_REPOSITORY_URL, prepareBackgroundRuntimeForAppUpdate, shell, log } = deps;
    ${mainSource.slice(blockStart, blockEnd)}
    return 'updater';
  `);
  const fallback = (drainError, drained = true) => {
    const calls = [];
    return {
      calls,
      result: run({
        state: { pendingUpdate: { version: '2.0.2', metadata: {}, electronUpdate: null } },
        resolveUpdateDownloadFallback: () => ({ url: 'https://github.com/1H-Team/DevRyan/releases/download/v2.0.2/DevRyan-2.0.2-arm64.dmg', kind: 'installer' }),
        GITHUB_REPOSITORY_URL: 'https://github.com/1H-Team/DevRyan',
        prepareBackgroundRuntimeForAppUpdate: async () => { calls.push('drain'); if (drainError) throw drainError; return drained; },
        shell: { openExternal: async () => { calls.push('open'); } },
        log: { info: () => {}, warn: () => {} },
      }),
    };
  };

  test('drains the background runtime before opening the installer', async () => {
    const { calls, result } = fallback();
    assert.deepEqual(await result, { openedExternally: true, kind: 'installer', backgroundRuntimeStopped: true });
    assert.deepEqual(calls, ['drain', 'open']);
  });

  test('an app-bound runtime has nothing to drain and is not reported stopped', async () => {
    const { calls, result } = fallback(null, false);
    assert.deepEqual(await result, { openedExternally: true, kind: 'installer', backgroundRuntimeStopped: false });
    assert.deepEqual(calls, ['drain', 'open']);
  });

  test('the drain reports whether it stopped a background runtime', () => {
    const body = mainSource.slice(mainSource.indexOf('const prepareBackgroundRuntimeForAppUpdate = async () => {'),
      mainSource.indexOf('const resumeBackgroundRuntimeAfterAppUpdate = '));
    assert.match(body, /if \(!state\.runtimeServiceClient\) return false;/);
    assert.match(body, /\n  return true;\n\};\n/);
  });

  test('a failed drain opens nothing and tells the user how to retry', async () => {
    const { calls, result } = fallback(Object.assign(new Error('x'), { code: 'runtime_service_update_owner_active' }));
    await assert.rejects(result, (error) => error.code === 'runtime_service_update_owner_active'
      && /could not stop its background runtime/.test(error.message));
    assert.deepEqual(calls, ['drain']);
  });
});
