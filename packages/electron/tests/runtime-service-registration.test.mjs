import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';

import { createRuntimeServiceRegistration } from '../runtime-service-registration.mjs';

const directories = [];

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
  test('uses the in-process SMAppService bridge on macOS 13+ and reports approval state', async () => {
    const calls = [];
    const registration = createRuntimeServiceRegistration({
      platform: 'darwin',
      macosMajor: 15,
      isPackaged: true,
      executablePath: '/Applications/DevRyan.app/Contents/MacOS/DevRyan',
      resourcesPath: '/Applications/DevRyan.app/Contents/Resources',
      dataDirectory: '/Users/test/.config/openchamber',
      nativeControl: {
        status: async () => {
          calls.push('status');
          return { ok: true, state: 'not_registered', code: null };
        },
        register: async () => {
          calls.push('register');
          return { ok: true, state: 'requires_approval', code: null };
        },
      },
    });
    const result = await registration.register();
    assert.equal(result.state, 'requires_approval');
    assert.deepEqual(calls, ['status', 'register']);
    assert.match(registration.settingsUrl, /LoginItems/);
  });

  test('accepts native bridge success payloads that omit the optional code field', async () => {
    const root = await temporaryDirectory();
    const calls = [];
    const states = {
      status: 'not_found',
      register: 'requires_approval',
      unregister: 'not_registered',
    };
    const registration = createRuntimeServiceRegistration({
      platform: 'darwin',
      macosMajor: 15,
      isPackaged: true,
      executablePath: path.join(root, 'DevRyan.app', 'Contents', 'MacOS', 'DevRyan'),
      resourcesPath: path.join(root, 'DevRyan.app', 'Contents', 'Resources'),
      dataDirectory: path.join(root, 'data'),
      nativeControl: Object.fromEntries(['status', 'register', 'unregister'].map((command) => [
        command,
        async () => {
          calls.push(command);
          return { ok: true, state: states[command] };
        },
      ])),
    });

    assert.deepEqual(await registration.status(), { ok: true, state: 'not_found', code: null });
    assert.deepEqual(await registration.register(), {
      ok: true,
      state: 'requires_approval',
      code: null,
    });
    assert.deepEqual(await registration.unregister(), {
      ok: true,
      state: 'not_registered',
      code: null,
    });
    assert.deepEqual(calls, ['status', 'status', 'register', 'unregister']);
  });

  test('falls back to the private LaunchAgent when SMAppService cannot find a bundled definition', async () => {
    const root = await temporaryDirectory();
    const resourcesPath = path.join(root, 'DevRyan.app', 'Contents', 'Resources');
    const bundledPlistPath = path.join(
      root,
      'DevRyan.app',
      'Contents',
      'Library',
      'LaunchAgents',
      'dev.openchamber.desktop.runtime-service.plist',
    );
    await fs.mkdir(path.dirname(bundledPlistPath), { recursive: true });
    await fs.writeFile(bundledPlistPath, 'bundled');
    const calls = [];
    const registration = createRuntimeServiceRegistration({
      platform: 'darwin',
      macosMajor: 15,
      isPackaged: true,
      executablePath: path.join(root, 'DevRyan.app', 'Contents', 'MacOS', 'DevRyan'),
      resourcesPath,
      dataDirectory: path.join(root, 'data'),
      homeDirectory: root,
      uid: 501,
      execFile: async (file, args) => {
        calls.push([file, args]);
        return { stdout: '', stderr: '' };
      },
      nativeControl: {
        status: async () => ({ ok: true, state: 'not_found', code: null }),
        register: async () => {
          throw new Error('SMAppService registration must not be attempted');
        },
      },
    });

    assert.deepEqual(await registration.status(), {
      ok: true,
      state: 'not_registered',
      code: null,
    });
    assert.equal(registration.mode, 'legacy');
    assert.equal(registration.settingsUrl, null);
    const result = await registration.register({ allowLegacy: true });
    assert.equal(result.state, 'enabled');
    assert.equal((await fs.stat(registration.legacyPath)).mode & 0o777, 0o600);
    assert.deepEqual(calls[0].slice(0, 1), ['/bin/launchctl']);
  });

  test('falls back when SMAppService becomes not_found during registration', async () => {
    const root = await temporaryDirectory();
    const resourcesPath = path.join(root, 'DevRyan.app', 'Contents', 'Resources');
    const bundledPlistPath = path.join(
      root,
      'DevRyan.app',
      'Contents',
      'Library',
      'LaunchAgents',
      'dev.openchamber.desktop.runtime-service.plist',
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
      uid: 501,
      execFile: async () => ({ stdout: '', stderr: '' }),
      nativeControl: {
        status: async () => ({ ok: true, state: 'not_registered', code: null }),
        register: async () => ({
          ok: false,
          state: 'not_found',
          code: 'smappservice_registration_failed',
        }),
      },
    });

    assert.equal((await registration.register({ allowLegacy: true })).state, 'enabled');
    assert.equal(registration.mode, 'legacy');
    assert.equal((await fs.stat(registration.legacyPath)).mode & 0o777, 0o600);
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
    const registration = createRuntimeServiceRegistration({
      platform: 'darwin',
      macosMajor: 15,
      isPackaged: true,
      executablePath: path.join(root, 'DevRyan.app', 'Contents', 'MacOS', 'DevRyan'),
      resourcesPath: path.join(root, 'DevRyan.app', 'Contents', 'Resources'),
      dataDirectory: path.join(root, 'data'),
      homeDirectory: root,
      uid: 501,
      execFile: async () => ({ stdout: '', stderr: '' }),
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
    await registration.unregister();
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
        register: async () => ({ ok: true, state: 'not_found', code: 7 }),
      },
    });

    assert.deepEqual(await registration.status(), {
      ok: false,
      state: 'unavailable',
      code: 'runtime_service_native_bridge_invalid',
    });
    await assert.rejects(
      registration.register(),
      (error) => error.code === 'runtime_service_native_bridge_invalid',
    );
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
      registration.register(),
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
        register: async () => {
          throw Object.assign(new Error('failed'), { code: 'runtime_service_native_bridge_failed' });
        },
      },
    });

    await assert.rejects(
      loadFailureRegistration.register(),
      (error) => error.code === 'runtime_service_native_bridge_load_failed',
    );
    await assert.rejects(
      callFailureRegistration.register(),
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
    await assert.rejects(
      registration.register(),
      (error) => error.code === 'runtime_service_packaged_build_required',
    );
  });

  test('requires explicit consent for older-macOS LaunchAgent registration', async () => {
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
    await assert.rejects(
      registration.register(),
      (error) => error.code === 'runtime_service_legacy_consent_required',
    );
    const result = await registration.register({ allowLegacy: true });
    assert.equal(result.state, 'enabled');
    const contents = await fs.readFile(registration.legacyPath, 'utf8');
    assert.match(contents, /--runtime-service/);
    assert.match(contents, /DevRyan/);
    assert.equal((await fs.stat(registration.legacyPath)).mode & 0o777, 0o600);
    assert.deepEqual(calls[0].slice(0, 1), ['/bin/launchctl']);
    await registration.unregister();
    await assert.rejects(fs.stat(registration.legacyPath), (error) => error.code === 'ENOENT');
  });
});
