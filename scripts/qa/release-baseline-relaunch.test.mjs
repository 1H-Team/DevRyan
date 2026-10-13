import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowBaselineRelaunch } from './release-baseline-relaunch.mjs';

const trial = () => ({ receipt: { baselineRelaunches: 0 }, artifact: { version: '2.0.7', publishedTag: 'v2.0.7', dmgSha256: 'old' },
  candidate: { version: '2.0.9', dmgSha256: 'candidate' }, error: Error('boot timeout'),
  failure: { terminalCode: 'native_process_boot_timeout', afterStop: {
    locks: { owner: { state: 'valid', alive: false }, mutation: { state: 'missing' } },
    process: { trackingClosed: true, rootObserved: true, observationErrors: [], remainingProcessIds: [], exitCode: 0, exitSignal: null },
  } } });

test('only one published baseline boot timeout can receive a fresh launch', () => {
  assert.equal(allowBaselineRelaunch(trial()), true);
  for (const mutate of [
    value => { value.receipt.baselineRelaunches = 1; },
    value => { delete value.artifact.publishedTag; },
    value => { value.artifact.version = value.candidate.version; },
    value => { value.artifact.dmgSha256 = value.candidate.dmgSha256; },
    value => { value.failure.terminalCode = 'runtime_service_owner_busy'; },
    value => { value.failure.terminalCode = 'native_runtime_artifacts_unverified'; },
    value => { value.error.code = 'release_startup_cleanup_failed'; },
    value => { value.error.code = 'runtime_service_owner_busy'; },
    value => { value.error.code = 'native_runtime_artifacts_unverified'; },
    value => { value.failure.forcedCleanup = true; },
    value => { value.failure.evidenceError = 'unavailable'; },
    value => { value.failure.afterStop.process.remainingProcessIds = [123]; },
    value => { value.failure.afterStop.process.rootObserved = false; },
    value => { value.failure.afterStop.process.observationErrors = ['unknown']; },
    value => { value.failure.afterStop.process.exitCode = null; },
    value => { value.failure.afterStop.locks.mutation = { state: 'malformed' }; },
    value => { value.failure.afterStop.locks.owner.alive = true; },
    value => { value.failure.afterStop.locks = {}; },
  ]) {
    const value = trial(); mutate(value); assert.equal(allowBaselineRelaunch(value), false);
  }
});
