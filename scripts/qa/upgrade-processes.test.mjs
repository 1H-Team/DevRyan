import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runUpgradeCommand } from './upgrade-processes.mjs';
import { withMountedDmg } from './mounted-dmg.mjs';

test('qualification commands collect complete stdout and stop timed-out owned children', async () => {
  const { stdout } = await runUpgradeCommand(process.execPath, ['-e', "process.stdout.write('identity')"]);
  assert.equal(stdout, 'identity');
  await assert.rejects(runUpgradeCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 30 }), /timed out/);
  await assert.rejects(runUpgradeCommand(process.execPath, ['-e', 'process.exit(7)']), /exited \(7\)/);
});

for (const failed of [false, true]) test(`DMG mount detaches and releases interruption hooks (${failed ? 'failed' : 'passed'} extraction)`, async () => {
  const calls = [], before = process.listenerCount('SIGTERM');
  const execute = async (_command, args) => { calls.push(args[0]); };
  const operation = () => withMountedDmg('/installer.dmg', '/owned/mount', async () => {
    if (failed) throw new Error('extract failed');
    return 'extracted';
  }, execute);
  if (failed) await assert.rejects(operation(), /extract failed/);
  else assert.equal(await operation(), 'extracted');
  assert.deepEqual(calls, ['attach', 'detach']);
  assert.equal(process.listenerCount('SIGTERM'), before);
});
