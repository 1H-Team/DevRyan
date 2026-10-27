import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';

import {
  createRuntimeOwnerAcquirer,
  acquireRuntimeServiceOwnership,
  retireRuntimeServiceRegistration,
  runStartupPhase,
} from '../runtime-service-startup.mjs';

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});
const markerPath = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-runtime-retire-'));
  directories.push(directory);
  return path.join(directory, 'runtime-service', 'retired.v1');
};
const exists = (file) => fs.access(file).then(() => true, () => false);

test('ownership contention uses remaining budget and never abandons an in-flight acquisition', async () => {
  let now = 0, calls = 0;
  const budgets = [];
  const result = await acquireRuntimeServiceOwnership({ now: () => now, wait: async ms => { now += ms; },
    acquire: async ({ timeoutMs }) => {
      budgets.push(timeoutMs); calls++;
      if (calls === 1) { now += 5000; throw Object.assign(Error('busy'), { code: 'runtime_service_owner_busy' }); }
      now += 50000; return 'owned';
    } });
  assert.equal(result, 'owned'); assert.deepEqual(budgets, [45000, 39975]);
  for (const code of ['runtime_service_owner_exists', 'runtime_service_owner_invalid', 'EIO']) {
    let attempts = 0;
    await assert.rejects(acquireRuntimeServiceOwnership({ acquire: async () => { attempts++; throw Object.assign(Error(code), { code }); } }), { code });
    assert.equal(attempts, 1);
  }
  now = 0;
  await assert.rejects(acquireRuntimeServiceOwnership({ now: () => now, acquire: async ({ timeoutMs }) => {
    assert.equal(timeoutMs, 45000); now += timeoutMs; throw Object.assign(Error('busy'), { code: 'runtime_service_owner_busy' });
  } }), { code: 'runtime_service_owner_busy' });
  now = 0; calls = 0;
  await assert.rejects(acquireRuntimeServiceOwnership({ timeoutMs: 10, now: () => now, wait: async ms => { now += ms + 1; },
    acquire: async () => { calls++; throw Object.assign(Error('busy'), { code: 'runtime_service_owner_busy' }); },
  }), { code: 'runtime_service_owner_busy' });
  assert.equal(calls, 1, 'No new acquisition may start after the deadline');
});

describe('runtime owner acquisition', () => {
  test('failed acquisition is never cached, retries reacquire, and concurrent attempts share a claim', async () => {
    let coordinator = null;
    let attempts = 0;
    const acquire = createRuntimeOwnerAcquirer({
      getCoordinator: () => coordinator,
      setCoordinator: (value) => { coordinator = value; },
      createCoordinator: async () => ({
        acquire: async () => {
          attempts += 1;
          if (attempts === 1) throw Object.assign(new Error('invalid'), { code: 'runtime_service_owner_invalid' });
        },
        getOwner: () => ({ mode: 'app_bound' }),
      }),
    });
    await assert.rejects(acquire('app_bound'), { code: 'runtime_service_owner_invalid' });
    assert.equal(coordinator, null);
    const results = await Promise.all([acquire('app_bound'), acquire('app_bound')]);
    assert.equal(attempts, 2);
    assert.equal(results[0], results[1]);
    await acquire('app_bound');
    assert.equal(attempts, 2);
  });

});

test('startup phase timings retain success results and original failures without payloads', async () => {
  const logs = [];
  let clock = 10;
  const log = { info: (...args) => logs.push(args), warn: (...args) => logs.push(args) };
  assert.equal(await runStartupPhase('fixture_success', async () => { clock += 12; return 'result'; }, log, () => clock), 'result');
  const error = new Error('private request details');
  await assert.rejects(runStartupPhase('fixture_failure', async () => { clock += 8; throw error; }, log, () => clock), value => value === error);
  assert.deepEqual(logs.map(([, value]) => value), [
    { phase: 'fixture_success', outcome: 'completed', elapsedMs: 12 },
    { phase: 'fixture_failure', outcome: 'failed', elapsedMs: 8, code: 'startup_phase_failed' },
  ]);
  assert.doesNotMatch(JSON.stringify(logs), /private/);
});

describe('background runtime retirement', () => {
  const retire = async ({ status, unregister = { ok: true, state: 'not_registered' }, stopped = true, platform = 'darwin',
    isPackaged = true, marker } = {}) => {
    const calls = [];
    const logs = [];
    const file = marker ?? await markerPath();
    const result = await retireRuntimeServiceRegistration({
      platform, isPackaged, markerPath: file,
      registration: () => ({
        status: async () => { calls.push('status'); if (status instanceof Error) throw status; return status; },
        unregister: async () => { calls.push('unregister'); return unregister; },
      }),
      waitForStopped: async () => { calls.push('wait'); return stopped; },
      clearSettings: async () => { calls.push('clear'); },
      log: { warn: (...args) => logs.push(args) },
    });
    return { result, calls, logs, file, marked: await exists(file) };
  };

  test('only packaged macOS apps inspect launchd', async () => {
    for (const options of [{ platform: 'linux' }, { isPackaged: false }]) {
      const { result, calls, marked } = await retire({ ...options, status: { ok: true, state: 'enabled' } });
      assert.equal(result.state, 'skipped');
      assert.deepEqual(calls, []);
      assert.equal(marked, false);
    }
  });

  test('a recorded retirement never queries the registration again', async () => {
    const marker = await markerPath();
    await fs.mkdir(path.dirname(marker), { recursive: true });
    await fs.writeFile(marker, '{}');
    const { result, calls } = await retire({ marker, status: { ok: true, state: 'enabled' } });
    assert.equal(result.state, 'retired');
    assert.deepEqual(calls, []);
  });

  for (const state of ['not_registered', 'not_found']) {
    test(`${state} records retirement and clears the old service settings without unregistering`, async () => {
      const { result, calls, marked } = await retire({ status: { ok: true, state } });
      assert.equal(result.state, 'retired');
      assert.deepEqual(calls, ['status', 'clear']);
      assert.equal(marked, true);
    });
  }

  for (const state of ['enabled', 'requires_approval']) {
    test(`${state} registration is withdrawn and its owner proved stopped before the marker`, async () => {
      const { result, calls, marked, logs } = await retire({ status: { ok: true, state } });
      assert.equal(result.state, 'retired');
      assert.deepEqual(calls, ['status', 'unregister', 'wait', 'clear']);
      assert.equal(marked, true);
      assert.equal(logs[0][1].code, 'runtime_service_retired');
    });
  }

  test('failures defer to the next launch without throwing or recording retirement', async () => {
    const cases = [
      [{ status: { ok: true, state: 'enabled' }, unregister: { ok: false } }, 'runtime_service_unregister_failed'],
      [{ status: { ok: true, state: 'enabled' }, stopped: false }, 'runtime_service_owner_active'],
      [{ status: new Error('bridge unavailable') }, 'runtime_service_retire_failed'],
      [{ status: { ok: false, state: 'unknown' } }, 'runtime_service_registration_unavailable'],
    ];
    for (const [options, code] of cases) {
      const { result, calls, marked, logs } = await retire(options);
      assert.equal(result.state, 'deferred');
      assert.equal(marked, false);
      assert.equal(calls.includes('clear'), false);
      assert.equal(logs.at(-1)[1].code, code);
    }
  });
});
