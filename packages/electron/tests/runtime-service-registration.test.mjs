import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { createRuntimeServiceRegistration as createRegistration } from '../runtime-service-registration.mjs';

const directories = [];
let fixtureHome;
const createRuntimeServiceRegistration = (options) => createRegistration({ homeDirectory: fixtureHome, ...options });
beforeEach(async () => { fixtureHome = await temporaryDirectory(); });

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

const temporaryDirectory = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-launch-agent-'));
  directories.push(directory);
  return directory;
};

describe('background runtime registration', () => {
  test('withdraws a registered 2.0 SMAppService through its legacy lookup', async () => {
    const root = await temporaryDirectory();
    let previousEnabled = true;
    const calls = [];
    const registration = createRuntimeServiceRegistration({ platform: 'darwin', macosMajor: 15, isPackaged: true,
      executablePath: path.join(root, 'DevRyan.app/Contents/MacOS/DevRyan'), dataDirectory: path.join(root, 'data'),
      homeDirectory: root, nativeControl: {
        statusLegacy: async () => { calls.push('statusLegacy'); return { ok: true, state: previousEnabled ? 'enabled' : 'not_registered' }; },
        unregisterLegacy: async () => { calls.push('unregisterLegacy'); previousEnabled = false; return { ok: true, state: 'not_registered' }; },
        unregister: async () => { calls.push('unregister'); return { ok: true, state: 'not_registered' }; },
        status: async () => { calls.push('status'); return { ok: true, state: 'not_registered' }; },
      } });
    assert.equal((await registration.status()).state, 'enabled');
    assert.equal(registration.mode, 'legacy-smappservice');
    assert.equal((await registration.unregister()).state, 'not_registered');
    assert.deepEqual(calls, ['statusLegacy', 'unregisterLegacy', 'unregister']);
  });
  for (const state of ['not_found', 'not_registered', 'enabled', 'requires_approval', 'unknown', 'unavailable']) {
    test(`unregister is idempotent only for absent registrations: ${state}`, async () => {
      const root = await temporaryDirectory();
      let calls = 0;
      const registration = createRuntimeServiceRegistration({
        platform: 'darwin', macosMajor: 15, isPackaged: true,
        executablePath: path.join(root, 'DevRyan.app/Contents/MacOS/DevRyan'),
        dataDirectory: path.join(root, 'data'), homeDirectory: root,
        nativeControl: {
          unregister: async () => {
            calls += 1;
            return { ok: false, state, code: 'smappservice_unregistration_failed' };
          },
        },
      });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        assert.deepEqual(await registration.unregister(), {
          ok: state === 'not_found' || state === 'not_registered',
          state, code: 'smappservice_unregistration_failed',
        });
      }
      assert.equal(calls, 2);
    });
  }

  test('unregister rejects malformed absent-state responses before normalization', async () => {
    const root = await temporaryDirectory();
    const registration = createRuntimeServiceRegistration({
      platform: 'darwin', macosMajor: 15, isPackaged: true,
      executablePath: path.join(root, 'DevRyan.app/Contents/MacOS/DevRyan'),
      dataDirectory: path.join(root, 'data'), homeDirectory: root,
      nativeControl: { unregister: async () => ({ state: 'not_found', ok: 'false' }) },
    });
    await assert.rejects(registration.unregister(), { code: 'runtime_service_native_bridge_invalid' });
  });

  test('accepts native bridge success payloads that omit the optional code field', async () => {
    const root = await temporaryDirectory();
    const calls = [];
    const states = {
      status: 'not_found',
      unregister: 'not_registered',
    };
    const registration = createRuntimeServiceRegistration({
      platform: 'darwin',
      macosMajor: 15,
      isPackaged: true,
      executablePath: path.join(root, 'DevRyan.app', 'Contents', 'MacOS', 'DevRyan'),
      resourcesPath: path.join(root, 'DevRyan.app', 'Contents', 'Resources'),
      dataDirectory: path.join(root, 'data'),
      nativeControl: Object.fromEntries(['status', 'unregister'].map((command) => [
        command,
        async () => {
          calls.push(command);
          return { ok: true, state: states[command] };
        },
      ])),
    });

    assert.deepEqual(await registration.status(), { ok: true, state: 'not_found', code: null });
    assert.deepEqual(await registration.unregister(), {
      ok: true,
      state: 'not_registered',
      code: null,
    });
    assert.deepEqual(calls, ['status', 'unregister']);
  });

  test('reads the private LaunchAgent when SMAppService cannot find a bundled definition', async () => {
    const root = await temporaryDirectory();
    const resourcesPath = path.join(root, 'DevRyan.app', 'Contents', 'Resources');
    const bundledPlistPath = path.join(
      root,
      'DevRyan.app',
      'Contents',
      'Library',
      'LaunchAgents',
      'dev.devryan.desktop.runtime-service.plist',
    );
    await fs.mkdir(path.dirname(bundledPlistPath), { recursive: true });
    await fs.writeFile(bundledPlistPath, 'bundled');
    const registration = createRuntimeServiceRegistration({
      platform: 'darwin',
      macosMajor: 15,
      isPackaged: true,
      executablePath: path.join(root, 'DevRyan.app', 'Contents', 'MacOS', 'DevRyan'),
      resourcesPath,
      dataDirectory: path.join(root, 'data'),
      homeDirectory: root,
      nativeControl: {
        status: async () => ({ ok: true, state: 'not_found', code: null }),
      },
    });

    assert.deepEqual(await registration.status(), {
      ok: true,
      state: 'not_registered',
      code: null,
    });
    assert.equal(registration.mode, 'legacy');
    assert.equal(registration.settingsUrl, null);
  });

  test('preserves not_found when the bundled LaunchAgent is genuinely missing', async () => {
    const root = await temporaryDirectory();
    const registration = createRuntimeServiceRegistration({
      platform: 'darwin',
      macosMajor: 15,
      isPackaged: true,
      executablePath: path.join(root, 'DevRyan.app', 'Contents', 'MacOS', 'DevRyan'),
      resourcesPath: path.join(root, 'DevRyan.app', 'Contents', 'Resources'),
      dataDirectory: path.join(root, 'data'),
      homeDirectory: root,
      nativeControl: {
        status: async () => ({ ok: true, state: 'not_found', code: null }),
      },
    });

    assert.deepEqual(await registration.status(), { ok: true, state: 'not_found', code: null });
    assert.equal(registration.mode, 'smappservice');
    assert.match(registration.settingsUrl, /LoginItems/);
  });

  test('prefers an existing managed LaunchAgent over SMAppService after an upgrade', async () => {
    const root = await temporaryDirectory();
    const legacyPath = path.join(
      root,
      'Library',
      'LaunchAgents',
      'dev.openchamber.desktop.runtime-service.legacy.plist',
    );
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(legacyPath, 'legacy', { mode: 0o600 });
    let nativeStatusCalls = 0;
    const launchctlCalls = [];
    const registration = createRuntimeServiceRegistration({
      platform: 'darwin',
      macosMajor: 15,
      isPackaged: true,
      executablePath: path.join(root, 'DevRyan.app', 'Contents', 'MacOS', 'DevRyan'),
      resourcesPath: path.join(root, 'DevRyan.app', 'Contents', 'Resources'),
      dataDirectory: path.join(root, 'data'),
      homeDirectory: root,
      uid: 501,
      execFile: async (_file, args) => { launchctlCalls.push(args); return { stdout: '', stderr: '' }; },
      nativeControl: {
        status: async () => {
          nativeStatusCalls += 1;
          return { ok: true, state: 'enabled', code: null };
        },
      },
    });

    assert.deepEqual(await registration.status(), { ok: true, state: 'enabled', code: null });
    assert.equal(registration.mode, 'legacy');
    assert.equal(nativeStatusCalls, 0);
    assert.deepEqual(launchctlCalls, []);
    await registration.unregister();
    assert.deepEqual(launchctlCalls, [['bootout', 'gui/501', legacyPath]]);
    await assert.rejects(fs.stat(legacyPath), (error) => error.code === 'ENOENT');
  });

  test('continues to reject malformed native bridge output', async () => {
    const registration = createRuntimeServiceRegistration({
      platform: 'darwin',
      macosMajor: 15,
      isPackaged: true,
      executablePath: '/Applications/DevRyan.app/Contents/MacOS/DevRyan',
      resourcesPath: '/Applications/DevRyan.app/Contents/Resources',
      dataDirectory: '/Users/test/.config/openchamber',
      nativeControl: {
        status: async () => ({ ok: true, state: 'not_found', code: 7 }),
      },
    });

    assert.deepEqual(await registration.status(), {
      ok: false,
      state: 'unavailable',
      code: 'runtime_service_native_bridge_invalid',
    });
  });

  test('reports a missing packaged native bridge without collapsing the status request', async () => {
    const root = await temporaryDirectory();
    const registration = createRuntimeServiceRegistration({
      platform: 'darwin',
      macosMajor: 15,
      isPackaged: true,
      executablePath: '/Applications/DevRyan.app/Contents/MacOS/DevRyan',
      dataDirectory: path.join(root, 'data'),
    });

    assert.deepEqual(await registration.status(), {
      ok: false,
      state: 'unavailable',
      code: 'runtime_service_native_bridge_missing',
    });
    await assert.rejects(
      registration.unregister(),
      (error) => error.code === 'runtime_service_native_bridge_missing'
        && !error.message.includes('RuntimeServiceRegistrationError'),
    );
  });

  test('classifies native bridge load and call failures', async () => {
    const baseOptions = {
      platform: 'darwin',
      macosMajor: 15,
      isPackaged: true,
      executablePath: '/Applications/DevRyan.app/Contents/MacOS/DevRyan',
      resourcesPath: '/Applications/DevRyan.app/Contents/Resources',
      dataDirectory: '/Users/test/.config/openchamber',
    };
    const loadFailureRegistration = createRuntimeServiceRegistration({
      ...baseOptions,
      nativeControlErrorCode: 'runtime_service_native_bridge_load_failed',
    });
    const callFailureRegistration = createRuntimeServiceRegistration({
      ...baseOptions,
      nativeControl: {
        unregister: async () => {
          throw Object.assign(new Error('failed'), { code: 'runtime_service_native_bridge_failed' });
        },
      },
    });

    await assert.rejects(
      loadFailureRegistration.unregister(),
      (error) => error.code === 'runtime_service_native_bridge_load_failed',
    );
    await assert.rejects(
      callFailureRegistration.unregister(),
      (error) => error.code === 'runtime_service_native_bridge_failed',
    );
  });

  test('fences signed service registration in source-development mode', async () => {
    const registration = createRuntimeServiceRegistration({
      platform: 'darwin',
      macosMajor: 15,
      isPackaged: true,
      executablePath: '/Applications/DevRyan.app/Contents/MacOS/DevRyan',
      resourcesPath: '/Applications/DevRyan.app/Contents/Resources',
      dataDirectory: '/Users/test/.config/openchamber',
      developmentMode: true,
    });

    assert.equal(registration.mode, 'unavailable');
    assert.equal((await registration.status()).code, 'runtime_service_packaged_build_required');
    assert.deepEqual(await registration.unregister(), { ok: true, state: 'not_registered', code: null });
  });

  test('withdraws an older-macOS LaunchAgent registration', async () => {
    const root = await temporaryDirectory();
    const calls = [];
    const registration = createRuntimeServiceRegistration({
      platform: 'darwin',
      macosMajor: 12,
      isPackaged: true,
      executablePath: '/Applications/DevRyan.app/Contents/MacOS/DevRyan',
      resourcesPath: '/Applications/DevRyan.app/Contents/Resources',
      dataDirectory: path.join(root, 'data'),
      homeDirectory: root,
      uid: 501,
      execFile: async (file, args) => {
        calls.push([file, args]);
        return { stdout: '', stderr: '' };
      },
    });
    assert.deepEqual(await registration.status(), { ok: true, state: 'not_registered', code: null });
    await fs.mkdir(path.dirname(registration.legacyPath), { recursive: true });
    await fs.writeFile(registration.legacyPath, 'legacy', { mode: 0o600 });
    assert.deepEqual(await registration.status(), { ok: true, state: 'enabled', code: null });
    assert.deepEqual(await registration.unregister(), { ok: true, state: 'not_registered', code: null });
    assert.deepEqual(calls, [['/bin/launchctl', ['bootout', 'gui/501', registration.legacyPath]]]);
    await assert.rejects(fs.stat(registration.legacyPath), (error) => error.code === 'ENOENT');
  });
});
