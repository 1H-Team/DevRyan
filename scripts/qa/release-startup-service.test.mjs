import assert from 'node:assert/strict';
import { test } from 'node:test';
import { invokeReleaseServiceHandoff, runReleaseCleanup, cleanupReleaseService } from './release-startup-service.mjs';

test('service action is issued once without awaiting the disappearing page promise', async () => {
  const calls = [];
  const launch = { check() {}, navigation: { handoff: name => calls.push(name) }, cdp: {
    on: () => () => {}, send: async (method, params) => { calls.push({ method, params }); return {}; },
  } };
  assert.equal(await invokeReleaseServiceHandoff(launch, 'enable', { allowLegacy: true }, async () => 'owner-confirmed'), 'owner-confirmed');
  const actions = calls.filter(row => row.method === 'Runtime.evaluate');
  assert.equal(actions.length, 1); assert.equal(actions[0].params.awaitPromise, false);
  assert.match(actions[0].params.expression, /desktop_runtime_service_enable/);
  assert.ok(calls.includes('service-enable'));
});

test('command failures, connection failures and cleanup failures are never erased by a successful poll', async () => {
  for (const kind of ['command', 'connection', 'exception']) {
    let binding, actions = 0;
    const launch = { check() {}, navigation: { handoff() {} }, cdp: {
      on: (_method, callback) => { binding = callback; return () => {}; },
      send: async method => {
        if (method === 'Runtime.addBinding') return {};
        actions++;
        if (kind === 'command') binding({ name: 'releaseServicedisable', payload: '{"ok":false,"error":{"code":"runtime_service_owner_active"}}' });
        if (kind === 'connection') throw Error('CDP connection closed');
        return kind === 'exception' ? { exceptionDetails: {} } : {};
      },
    } };
    await assert.rejects(invokeReleaseServiceHandoff(launch, 'disable', {}, async () => true),
      kind === 'command' ? { code: 'runtime_service_owner_active' } : undefined);
    assert.equal(actions, 1);
  }
  await assert.rejects(runReleaseCleanup(async () => { throw Error('forced bootout required'); }), { code: 'release_startup_cleanup_failed' });
});

test('cleanup verifies owned-label bootout and owner exit, restores environment, and rejects every forced sample', async () => {
  for (const kind of ['normal', 'command', 'registration', 'live-owner', 'bootout', 'restore']) {
    const calls = [];
    let forced = false;
    const cleanup = cleanupReleaseService({
      disable: async () => { calls.push('disable'); if (kind === 'command') throw Error('command failed'); },
      isRegistered: async () => { calls.push('status'); return !forced && ['registration', 'live-owner', 'bootout'].includes(kind); },
      bootout: async () => { calls.push('bootout'); if (kind === 'bootout') throw Error('bootout failed'); },
      waitForStopped: async () => { calls.push('owner'); return kind !== 'live-owner'; },
      restore: async () => { calls.push('restore'); if (kind === 'restore') throw Error('restore failed'); },
      onForced: () => { forced = true; calls.push('forced'); },
    });
    if (kind === 'normal') await cleanup;
    else await assert.rejects(cleanup, { code: 'release_startup_cleanup_failed' });
    assert.equal(calls.at(-1), 'restore');
    assert.equal(forced, !['normal', 'restore'].includes(kind));
    if (['command', 'registration'].includes(kind)) assert.deepEqual(calls.slice(-4), ['bootout', 'owner', 'status', 'restore']);
  }
});
