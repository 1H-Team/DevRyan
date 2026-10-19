import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDesktopSettings } from '../desktop-settings.mjs';
import { ElectronSshManager } from '../ssh-manager.mjs';

test('SSH settings write DevRyan fields and accept both legacy spellings', () => {
  const manager = Object.create(ElectronSshManager.prototype);
  for (const remoteField of ['remoteDevRyan', 'remoteOpenchamber', 'remote_openchamber']) {
    for (const passwordField of ['devryanPassword', 'openchamberPassword', 'openchamber_password']) {
      const instance = manager.sanitizeInstance({ id: 'fixture', sshCommand: 'ssh example.invalid',
        [remoteField]: { mode: 'external', preferredPort: 4001 },
        auth: { [passwordField]: { enabled: false, store: 'never' } } });
      assert.equal(instance.remoteDevRyan.mode, 'external');
      assert.equal(instance.remoteDevRyan.preferredPort, 4001);
      assert.deepEqual(instance.auth.devryanPassword, { enabled: false, store: 'never' });
      assert.equal(instance.remoteOpenchamber, undefined);
      assert.equal(instance.auth.openchamberPassword, undefined);
      assert.equal(manager.configuredDevRyanPassword(instance), null);
    }
  }
});

async function withFixture(run) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'devryan-ssh-settings-checkpoint-'));
  try { await run(directory); }
  finally { await fsp.rm(directory, { recursive: true, force: true }); }
}

test('all SSH settings writers share admission and drain with desktop checkpoint', async () => {
  await withFixture(async (directory) => {
    const filePath = path.join(directory, 'settings.json');
    await fsp.writeFile(filePath, JSON.stringify({ themeId: 'dark' }));
    const started = Promise.withResolvers(), release = Promise.withResolvers();
    let writes = 0;
    const owner = createDesktopSettings({
      fs, fsp: { ...fsp, rename: async (...args) => {
        if (++writes === 1) { started.resolve(); await release.promise; }
        return fsp.rename(...args);
      } }, os: { homedir: () => directory }, process: { env: {}, pid: process.pid },
      log: {}, getMainWindow: () => null, minWidth: 1, minHeight: 1, LOCAL_HOST_ID: 'local',
      resolveDataDirectory: () => directory,
    });
    const manager = new ElectronSshManager({ settingsFilePath: owner.settingsFilePath,
      mutateSettingsRoot: owner.mutateSettingsRoot });
    const instances = manager.setInstances({ instances: [{ id: 'fixture', nickname: 'Original', sshCommand: 'ssh example.invalid' }] });
    await started.promise;
    const url = manager.updateHostUrl('fixture', 'Connected', 'http://127.0.0.1:41234');
    const port = manager.persistLocalPort('fixture', 41234);
    const theme = owner.mutateSettingsRoot(root => ({ ...root, themeId: 'light' }));
    const drain = owner.holdForCheckpoint();
    let drained = false;
    void drain.then(() => { drained = true; });
    for (const action of [() => manager.setInstances({ instances: [] }),
      () => manager.updateHostUrl('fixture', 'Late', 'http://127.0.0.1:1'),
      () => manager.persistLocalPort('fixture', 1)]) {
      await assert.rejects(action(), { code: 'bundle_desktop_settings_held' });
    }
    assert.equal(drained, false);
    release.resolve();
    await Promise.all([instances, url, port, theme, drain]);
    assert.equal(drained, true);
    assert.equal(writes, 4);
    const root = JSON.parse(await fsp.readFile(filePath, 'utf8'));
    assert.equal(root.themeId, 'light');
    assert.deepEqual(root.desktopHosts, [{ id: 'fixture', label: 'Connected', url: 'http://127.0.0.1:41234' }]);
    assert.equal(root.desktopSshInstances[0].localForward.preferredLocalPort, 41234);
  });
});

test('standalone SSH writers capture one settings path per mutation', async () => {
  await withFixture(async (directory) => {
    const first = path.join(directory, 'first.json'), second = path.join(directory, 'second.json');
    for (const action of [manager => manager.setInstances({ instances: [{ id: 'fixture', sshCommand: 'ssh example.invalid' }] }),
      manager => manager.updateHostUrl('fixture', 'Connected', 'http://127.0.0.1:41234'),
      manager => manager.persistLocalPort('fixture', 41234)]) {
      await fsp.writeFile(first, JSON.stringify({ themeId: 'dark', desktopSshInstances: [{ id: 'fixture' }] }));
      await fsp.writeFile(second, JSON.stringify({ themeId: 'light' }));
      let reads = 0;
      const manager = new ElectronSshManager({ settingsFilePath: () => ++reads === 1 ? first : second });
      await action(manager);
      assert.equal(reads, 1);
      assert.equal(JSON.parse(await fsp.readFile(first, 'utf8')).themeId, 'dark');
      assert.deepEqual(JSON.parse(await fsp.readFile(second, 'utf8')), { themeId: 'light' });
    }
  });
});
