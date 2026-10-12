import { afterEach, expect, it } from 'vitest';
import { assertStartupBundleUpgradeSucceeded, recordStartupBundleUpgradeFailure } from './bundle-startup-upgrade-status.js';

afterEach(() => recordStartupBundleUpgradeFailure(null));

it('refuses composition with the original failed upgrade instead of verifying an old current pin', () => {
  recordStartupBundleUpgradeFailure('bundle_execution_unsettled');
  let composed = false;
  expect(() => {
    assertStartupBundleUpgradeSucceeded();
    composed = true;
    throw Object.assign(new Error('old pin'), { code: 'native_runtime_artifacts_unverified' });
  }).toThrow('bundle_execution_unsettled');
  expect(composed).toBe(false);
});

it('preserves sanitized artifact diagnostics and clears a recovered attempt', () => {
  const diagnostic = { stage: 'reviewed_asset', reason: 'reviewed_asset_mismatch', purpose: 'current', artifact: 'DevRyan-Claude-darwin-arm64' };
  recordStartupBundleUpgradeFailure('native_runtime_artifacts_unverified', { diagnostic });
  try { assertStartupBundleUpgradeSucceeded(); throw new Error('expected refusal'); }
  catch (error) { expect(error).toMatchObject({ code: 'native_runtime_artifacts_unverified', status: 503, diagnostic }); }
  recordStartupBundleUpgradeFailure(null);
  expect(() => assertStartupBundleUpgradeSucceeded()).not.toThrow();
});
