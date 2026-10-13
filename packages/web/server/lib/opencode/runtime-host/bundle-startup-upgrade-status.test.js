import { afterEach, expect, it } from 'vitest';
import { startupUpgradeFailureOver, recordStartupBundleUpgradeFailure } from './bundle-startup-upgrade-status.js';

afterEach(() => recordStartupBundleUpgradeFailure(null));

it('reports the refused upgrade, not the old-pin rejection, when the retained runtime cannot launch either', () => {
  const oldPin = Object.assign(new Error('old pin'), { code: 'native_runtime_artifacts_unverified' });
  expect(startupUpgradeFailureOver(oldPin)).toBe(oldPin);
  recordStartupBundleUpgradeFailure('bundle_execution_unsettled');
  expect(startupUpgradeFailureOver(oldPin)).toMatchObject({ code: 'bundle_execution_unsettled', status: 503, cause: oldPin });
});

it('preserves sanitized artifact diagnostics and clears a recovered attempt', () => {
  const diagnostic = { stage: 'reviewed_asset', reason: 'reviewed_asset_mismatch', purpose: 'current', artifact: 'DevRyan-Claude-darwin-arm64' };
  recordStartupBundleUpgradeFailure('native_runtime_artifacts_unverified', { diagnostic });
  const later = new Error('launch verification');
  expect(startupUpgradeFailureOver(later)).toMatchObject({ code: 'native_runtime_artifacts_unverified', status: 503, diagnostic });
  recordStartupBundleUpgradeFailure(null);
  expect(startupUpgradeFailureOver(later)).toBe(later);
});
