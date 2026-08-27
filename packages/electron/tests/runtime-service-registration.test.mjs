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
  test('uses the signed SMAppService helper on macOS 13+ and reports approval state', async () => {
    const calls = [];
    const fsPromises = {
      stat: async () => ({ isFile: () => true }),
      access: async () => undefined,
    };
    const registration = createRuntimeServiceRegistration({
      platform: 'darwin',
      macosMajor: 15,
      isPackaged: true,
      executablePath: '/Applications/DevRyan.app/Contents/MacOS/DevRyan',
      resourcesPath: '/Applications/DevRyan.app/Contents/Resources',
      dataDirectory: '/Users/test/.config/openchamber',
      fsPromises,
      execFile: async (file, args) => {
        calls.push([file, args]);
        return { stdout: '{"ok":true,"state":"requires_approval","code":null}\n', stderr: '' };
      },
    });
    const result = await registration.register();
    assert.equal(result.state, 'requires_approval');
    assert.deepEqual(calls, [[
      '/Applications/DevRyan.app/Contents/Resources/native/DevRyanRuntimeServiceControl',
      ['register'],
    ]]);
    assert.match(registration.settingsUrl, /LoginItems/);
  });

  test('accepts real helper success payloads that omit the optional code field', async () => {
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
      executablePath: '/Applications/DevRyan.app/Contents/MacOS/DevRyan',
      resourcesPath: '/Applications/DevRyan.app/Contents/Resources',
      dataDirectory: '/Users/test/.config/openchamber',
      fsPromises: {
        stat: async () => ({ isFile: () => true }),
        access: async () => undefined,
      },
      execFile: async (file, [command]) => {
        calls.push([file, command]);
        return { stdout: `${JSON.stringify({ ok: true, state: states[command] })}\n`, stderr: '' };
      },
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
    assert.deepEqual(calls.map(([, command]) => command), ['status', 'register', 'unregister']);
  });

  test('continues to reject malformed helper output', async () => {
    const registration = createRuntimeServiceRegistration({
      platform: 'darwin',
      macosMajor: 15,
      isPackaged: true,
      executablePath: '/Applications/DevRyan.app/Contents/MacOS/DevRyan',
      resourcesPath: '/Applications/DevRyan.app/Contents/Resources',
      dataDirectory: '/Users/test/.config/openchamber',
      fsPromises: {
        stat: async () => ({ isFile: () => true }),
        access: async () => undefined,
      },
      execFile: async () => ({ stdout: '{"ok":true,"state":"not_found","code":7}\n', stderr: '' }),
    });

    assert.deepEqual(await registration.status(), {
      ok: false,
      state: 'unavailable',
      code: 'runtime_service_control_invalid',
    });
    await assert.rejects(
      registration.register(),
      (error) => error.code === 'runtime_service_control_invalid',
    );
  });

  test('reports a missing packaged helper without collapsing the status request', async () => {
    const root = await temporaryDirectory();
    const registration = createRuntimeServiceRegistration({
      platform: 'darwin',
      macosMajor: 15,
      isPackaged: true,
      executablePath: '/Applications/DevRyan.app/Contents/MacOS/DevRyan',
      resourcesPath: root,
      dataDirectory: path.join(root, 'data'),
    });

    assert.deepEqual(await registration.status(), {
      ok: false,
      state: 'unavailable',
      code: 'runtime_service_helper_missing',
    });
    await assert.rejects(
      registration.register(),
      (error) => error.code === 'runtime_service_helper_missing'
        && !error.message.includes('RuntimeServiceRegistrationError'),
    );
  });

  test('classifies helper timeout and wrong-architecture launch failures', async () => {
    const helperFs = {
      stat: async () => ({ isFile: () => true }),
      access: async () => undefined,
    };
    const baseOptions = {
      platform: 'darwin',
      macosMajor: 15,
      isPackaged: true,
      executablePath: '/Applications/DevRyan.app/Contents/MacOS/DevRyan',
      resourcesPath: '/Applications/DevRyan.app/Contents/Resources',
      dataDirectory: '/Users/test/.config/openchamber',
      fsPromises: helperFs,
    };
    const timeoutRegistration = createRuntimeServiceRegistration({
      ...baseOptions,
      execFile: async () => { throw Object.assign(new Error('timed out'), { killed: true }); },
    });
    const wrongArchRegistration = createRuntimeServiceRegistration({
      ...baseOptions,
      execFile: async () => {
        throw Object.assign(new Error('spawn failed'), { stderr: 'Bad CPU type in executable' });
      },
    });

    await assert.rejects(
      timeoutRegistration.register(),
      (error) => error.code === 'runtime_service_control_timeout',
    );
    await assert.rejects(
      wrongArchRegistration.register(),
      (error) => error.code === 'runtime_service_helper_wrong_arch',
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
