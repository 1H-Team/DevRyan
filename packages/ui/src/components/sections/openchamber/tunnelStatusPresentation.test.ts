import { describe, expect, test } from 'bun:test';

import {
  isManagedAccountLoginAvailable,
  isManagedRemoteStatusDegraded,
} from './tunnelStatusPresentation';

describe('managed remote tunnel status presentation', () => {
  const cases = [
    ['connecting', true, true],
    ['degraded', false, true],
    ['stopped', false, true],
    ['healthy', true, false],
  ] as const;

  for (const [connectorState, verified, expected] of cases) {
    test(`maps ${connectorState} connector state to degraded=${expected}`, () => {
      expect(isManagedRemoteStatusDegraded({
        active: true,
        mode: 'managed-remote',
        providerMetadata: { connectorState, publicReachabilityVerified: verified },
      })).toBe(expected);
    });
  }

  test('keeps legacy active statuses ready when lifecycle metadata is absent', () => {
    expect(isManagedRemoteStatusDegraded({
      active: true,
      mode: 'managed-remote',
      providerMetadata: null,
    })).toBe(false);
  });

  test('does not mark inactive or non-managed tunnels as degraded', () => {
    expect(isManagedRemoteStatusDegraded({
      active: false,
      mode: 'managed-remote',
      providerMetadata: { connectorState: 'degraded', publicReachabilityVerified: false },
    })).toBe(false);
    expect(isManagedRemoteStatusDegraded({
      active: true,
      mode: 'quick',
      providerMetadata: { connectorState: 'degraded', publicReachabilityVerified: false },
    })).toBe(false);
  });

  test('allows Managed Remote startup only for managed-account principals', () => {
    expect(isManagedAccountLoginAvailable('managed')).toBe(true);
    expect(isManagedAccountLoginAvailable('local-admin')).toBe(false);
    expect(isManagedAccountLoginAvailable(undefined)).toBe(false);
  });
});
