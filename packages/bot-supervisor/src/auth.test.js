import { describe, expect, test } from 'bun:test';
import {
  SupervisorAuthError,
  createSupervisorAuthenticator,
  readBearerToken,
} from './auth.js';

const TOKEN = 'supervisor-test-token-0123456789abcdef';

describe('Bot supervisor bearer authentication', () => {
  test('accepts the one configured bearer token', () => {
    const authenticate = createSupervisorAuthenticator({ token: TOKEN });
    expect(authenticate(`Bearer ${TOKEN}`)).toBe(true);
  });

  test('rejects malformed, missing, and mismatched credentials', () => {
    const authenticate = createSupervisorAuthenticator({ token: TOKEN });
    for (const value of [undefined, `Basic ${TOKEN}`, 'Bearer wrong-token-that-is-long-enough-0000']) {
      expect(() => authenticate(value)).toThrow(SupervisorAuthError);
    }
    expect(() => readBearerToken('Bearer token with spaces')).toThrow(SupervisorAuthError);
  });

  test('refuses weak configured tokens', () => {
    expect(() => createSupervisorAuthenticator({ token: 'too-short' }))
      .toThrow('configuration is invalid');
  });
});
