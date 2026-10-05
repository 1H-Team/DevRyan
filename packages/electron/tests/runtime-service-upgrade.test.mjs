import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';

import { createRuntimeServiceRegistration } from '../runtime-service-registration.mjs';
import { reregisterRuntimeServiceAfterUpgrade } from '../runtime-service-startup.mjs';

const mainSource = await fs.readFile(new URL('../main.mjs', import.meta.url), 'utf8');
const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

// A real legacy LaunchAgent registration over a private HOME; launchctl is a
// recorded fake, so no real launchd job is touched.
const fixture = async ({ previousExecutable, currentExecutable }) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-service-upgrade-'));
  directories.push(root);
  const launchctl = [];
  const create = (executablePath) => createRuntimeServiceRegistration({
    platform: 'darwin', macosMajor: 12, isPackaged: true, executablePath,
    resourcesPath: path.join(path.dirname(path.dirname(executablePath)), 'Resources'),
    dataDirectory: path.join(root, 'data'), homeDirectory: root, uid: 501,
    execFile: async (file, args) => { launchctl.push([file, ...args]); return { stdout: '', stderr: '' }; },
  });
  await create(previousExecutable).register({ allowLegacy: true });
  launchctl.length = 0;
  return { root, launchctl, registration: create(currentExecutable) };
};

describe('background runtime registration after a manual upgrade', () => {
  test('a registration made by another app version is replaced when its service is stopped', async () => {
    const previousExecutable = '/Volumes/DevRyan 2.0.1/DevRyan.app/Contents/MacOS/DevRyan';
    const currentExecutable = '/Applications/DevRyan.app/Contents/MacOS/DevRyan';
    const { launchctl, registration } = await fixture({ previousExecutable, currentExecutable });
    assert.match(await fs.readFile(registration.legacyPath, 'utf8'), /Volumes\/DevRyan 2\.0\.1/);
    const recorded = [];
    const warnings = [];
    const result = await reregisterRuntimeServiceAfterUpgrade({
      registeredAppVersion: '2.0.1', appVersion: '2.0.2', registration,
      isOwnerStopped: async () => true,
      recordRegisteredAppVersion: async (version) => recorded.push(version),
      log: { warn: (...args) => warnings.push(args) },
    });
    assert.deepEqual(result, { state: 'reregistered' });
    const plist = await fs.readFile(registration.legacyPath, 'utf8');
    assert.match(plist, /<string>\/Applications\/DevRyan\.app\/Contents\/MacOS\/DevRyan<\/string>/);
    assert.doesNotMatch(plist, /Volumes/);
    assert.deepEqual(launchctl.map(([, command]) => command), ['bootout', 'bootstrap']);
    assert.deepEqual(recorded, ['2.0.2']);
    assert.equal(warnings[0][1].code, 'runtime_service_reregistered_after_upgrade');
  });

  test('registrations from before version recording are replaced once', async () => {
    const executable = '/Applications/DevRyan.app/Contents/MacOS/DevRyan';
    const { launchctl, registration } = await fixture({ previousExecutable: executable, currentExecutable: executable });
    const recorded = [];
    const result = await reregisterRuntimeServiceAfterUpgrade({
      registeredAppVersion: undefined, appVersion: '2.0.2', registration,
      isOwnerStopped: async () => true, recordRegisteredAppVersion: async (version) => recorded.push(version),
    });
    assert.equal(result.state, 'reregistered');
    assert.deepEqual(launchctl.map(([, command]) => command), ['bootout', 'bootstrap']);
    assert.deepEqual(recorded, ['2.0.2']);
  });

  test('the current version, a live service and a missing registration are left to the existing paths', async () => {
    const executable = '/Applications/DevRyan.app/Contents/MacOS/DevRyan';
    const { launchctl, registration } = await fixture({ previousExecutable: executable, currentExecutable: executable });
    const never = async () => { throw new Error('must not record'); };
    assert.deepEqual(await reregisterRuntimeServiceAfterUpgrade({
      registeredAppVersion: '2.0.2', appVersion: '2.0.2', registration,
      isOwnerStopped: async () => true, recordRegisteredAppVersion: never,
    }), { state: 'current' });
    // A live service of another version is drained by the connection's retirement, never booted out here.
    for (const isOwnerStopped of [async () => false, async () => { throw new Error('owner unverified'); }]) {
      assert.deepEqual(await reregisterRuntimeServiceAfterUpgrade({
        registeredAppVersion: '2.0.1', appVersion: '2.0.2', registration, isOwnerStopped, recordRegisteredAppVersion: never,
      }), { state: 'deferred' });
    }
    assert.deepEqual(launchctl, []);
    await registration.unregister();
    launchctl.length = 0;
    assert.deepEqual(await reregisterRuntimeServiceAfterUpgrade({
      registeredAppVersion: '2.0.1', appVersion: '2.0.2', registration,
      isOwnerStopped: async () => true, recordRegisteredAppVersion: never,
    }), { state: 'not_registered' });
    assert.deepEqual(launchctl, []);
  });

  test('a replacement that cannot be unregistered or approved fails so startup falls back', async () => {
    const enabled = { ok: true, state: 'enabled', code: null };
    const base = { registeredAppVersion: '2.0.1', appVersion: '2.0.2', isOwnerStopped: async () => true,
      recordRegisteredAppVersion: async () => { throw new Error('must not record'); } };
    await assert.rejects(reregisterRuntimeServiceAfterUpgrade({ ...base, registration: {
      status: async () => enabled, unregister: async () => ({ ok: false, state: 'enabled', code: null }), register: async () => enabled,
    } }), (error) => error.code === 'runtime_service_unregister_failed');
    await assert.rejects(reregisterRuntimeServiceAfterUpgrade({ ...base, registration: {
      status: async () => enabled, unregister: async () => ({ ok: true, state: 'not_registered', code: null }),
      register: async () => ({ ok: true, state: 'requires_approval', code: null }),
    } }), (error) => error.code === 'runtime_service_approval_required');
  });

  test('service-mode startup replaces a stale registration before the registration check and connection wait', () => {
    const start = mainSource.indexOf('const prepareForegroundRuntime = async () => {');
    const body = mainSource.slice(start, mainSource.indexOf('\n};\n', start));
    const resume = body.indexOf('await resumeBackgroundRuntimeAfterAppUpdate();');
    const replace = body.indexOf('await reregisterBackgroundRuntimeAfterManualUpgrade();');
    const ensure = body.indexOf('await ensureRuntimeServiceRegistered(');
    assert.ok(resume > 0 && replace > resume && ensure > replace);
    // A successful connection proves the registration starts this version.
    const connect = mainSource.slice(mainSource.indexOf('const connectToRuntimeService = async'),
      mainSource.indexOf('const macosMajorVersion = () =>'));
    assert.match(connect, /recordRuntimeServiceAppVersion\(\)/);
  });
});
