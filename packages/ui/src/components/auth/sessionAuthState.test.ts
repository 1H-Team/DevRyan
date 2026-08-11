import { describe, expect, test } from 'bun:test';

import {
  buildPrincipalTransitionPath,
  classifySessionResponse,
  localResetSucceeded,
  orderAgentTestIdentities,
} from './sessionAuthState';

describe('session authentication state', () => {
  test('distinguishes authentication, dependency, schema, and server responses', () => {
    expect(classifySessionResponse(200, true, {})).toEqual({ state: 'authenticated' });
    expect(classifySessionResponse(401, false, {})).toEqual({ state: 'locked' });
    expect(classifySessionResponse(429, false, { retryAfter: 120 })).toEqual({
      state: 'rate-limited',
      retryAfter: 120,
    });
    expect(classifySessionResponse(503, false, { code: 'identity_unavailable' })).toEqual({
      state: 'identity-unavailable',
    });
    expect(classifySessionResponse(503, false, { code: 'managed_account_auth_required' })).toEqual({
      state: 'managed-account-required',
    });
    expect(classifySessionResponse(503, false, { code: 'schema_migration_required' })).toEqual({
      state: 'schema-migration-required',
    });
    expect(classifySessionResponse(500, false, {})).toEqual({ state: 'server-error' });
  });

  test('orders the least-privileged agent identity first and rejects ambiguous roles', () => {
    expect(orderAgentTestIdentities([
      { role: 'admin', label: 'Test Administrator' },
      { role: 'developer', label: 'Test Developer' },
    ])).toEqual([
      { role: 'developer', label: 'Test Developer' },
      { role: 'admin', label: 'Test Administrator' },
    ]);
    expect(orderAgentTestIdentities([
      { role: 'developer', label: 'First Developer' },
      { role: 'developer', label: 'Second Developer' },
      { role: 'admin', label: 'Test Administrator' },
    ])).toEqual([{ role: 'admin', label: 'Test Administrator' }]);
  });

  test('accepts a partial reset only when the server confirms local cleanup', () => {
    expect(localResetSucceeded(true, {})).toBe(true);
    expect(localResetSucceeded(false, {
      localSessionCleared: true,
      remoteRevoked: false,
    })).toBe(true);
    expect(localResetSucceeded(false, { localSessionCleared: false })).toBe(false);
  });

  test('clears previous-principal app routes while preserving host query state', () => {
    expect(buildPrincipalTransitionPath(
      'https://devryan.example/?settings=home&session=old&tab=diff&file=secret.ts&utm_source=test#section',
    )).toBe('/?utm_source=test#section');
    expect(buildPrincipalTransitionPath('https://devryan.example/')).toBe('/');
  });
});
