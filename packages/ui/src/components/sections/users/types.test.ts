import { afterEach, describe, expect, test } from 'bun:test';

import { getAuthOfflineGrace, setAuthOfflineGrace } from '@/lib/authSession';
import { requestJson, UserManagementRequestError } from './types';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  setAuthOfflineGrace(false);
});

describe('User Management request errors', () => {
  test('preserves the structured offline-grace response and updates auth availability', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      error: 'Account and host management are unavailable during offline grace',
      code: 'offline_grace_restricted',
      retryable: true,
    }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;

    let failure: unknown;
    try {
      await requestJson('/api/admin/users');
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(UserManagementRequestError);
    const requestError = failure as UserManagementRequestError;
    expect(requestError.status).toBe(503);
    expect(requestError.code).toBe('offline_grace_restricted');
    expect(requestError.retryable).toBe(true);
    expect(getAuthOfflineGrace()).toBe(true);
  });

  test('does not classify unrelated service errors as offline grace', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      error: 'Database migration required',
      code: 'schema_migration_required',
    }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;

    let failure: unknown;
    try {
      await requestJson('/api/admin/users');
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(UserManagementRequestError);
    const requestError = failure as UserManagementRequestError;
    expect(requestError.status).toBe(503);
    expect(requestError.code).toBe('schema_migration_required');
    expect(requestError.retryable).toBe(false);
    expect(getAuthOfflineGrace()).toBe(false);
  });
});
