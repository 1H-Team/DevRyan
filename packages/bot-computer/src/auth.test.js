import { describe, expect, test } from 'bun:test';
import { ComputerAuthError, createComputerAuthenticator } from './auth.js';

const TOKEN = 'computer-runtime-token-0123456789abcdef';

describe('computer bearer authentication', () => {
  test('accepts only the exact configured capability', () => {
    const authenticate = createComputerAuthenticator({ token: TOKEN });
    expect(authenticate(`Bearer ${TOKEN}`)).toBe(true);
    for (const header of [undefined, `Basic ${TOKEN}`, 'Bearer another-long-token-0123456789abcdef']) {
      expect(() => authenticate(header)).toThrow(ComputerAuthError);
    }
  });

  test('fails closed for weak service configuration', () => {
    expect(() => createComputerAuthenticator({ token: 'short' })).toThrow(ComputerAuthError);
  });
});
