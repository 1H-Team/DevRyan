import assert from 'node:assert/strict';
import test from 'node:test';
import { restartSupabaseHost } from '../supabase-host-restart.mjs';

for (const serviceMode of [true, false]) {
  test(`Supabase restart drains and releases ownership before ${serviceMode ? 'launchd recovery' : 'app relaunch'}`, async () => {
    const calls = [];
    await restartSupabaseHost({
      handle: { stop: async (options) => { assert.deepEqual(options, { exitProcess: false }); calls.push('drain'); } },
      coordinator: { release: async () => calls.push('release') }, serviceMode,
      onStopped: () => calls.push('stopped'), relaunch: () => calls.push('relaunch'), exit: (code) => calls.push(`exit:${code}`),
    });
    assert.deepEqual(calls, ['drain', 'release', 'stopped', ...(serviceMode ? ['exit:1'] : ['relaunch', 'exit:0'])]);
  });
}
test('Supabase restart does not relaunch or force exit when draining fails', async () => {
  const calls = [];
  await assert.rejects(restartSupabaseHost({
    handle: { stop: async () => { throw new Error('fixture drain failed'); } },
    coordinator: { release: async () => calls.push('release') }, serviceMode: true,
    onStopped: () => calls.push('stopped'), relaunch: () => calls.push('relaunch'), exit: () => calls.push('exit'),
  }), /drain failed/);
  assert.deepEqual(calls, []);
});
