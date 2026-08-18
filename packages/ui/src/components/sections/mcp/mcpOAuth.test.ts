import { describe, expect, test } from 'bun:test';
import {
  buildMcpOAuthRedirectUri,
  parseMcpOAuthCallbackContext,
  shouldPersistMcpOAuthRedirectUri,
} from './mcpOAuth';

const originalWindow = globalThis.window;

const encodeBase64Url = (value: string): string => (
  Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
);

const installWindow = (origin: string) => {
  Object.defineProperty(globalThis, 'window', {
    value: {
      location: { origin },
      atob: (value: string) => Buffer.from(value, 'base64').toString('binary'),
    },
    configurable: true,
  });
};

const restoreWindow = () => {
  Object.defineProperty(globalThis, 'window', {
    value: originalWindow,
    configurable: true,
  });
};

describe('MCP OAuth helpers', () => {
  test('persists the redirect URI when the stored value is empty or stale', () => {
    const fresh = 'http://127.0.0.1:57123/mcp/oauth/callback';

    expect(shouldPersistMcpOAuthRedirectUri('', fresh)).toBe(true);
    expect(shouldPersistMcpOAuthRedirectUri('  ', fresh)).toBe(true);
    expect(shouldPersistMcpOAuthRedirectUri(undefined, fresh)).toBe(true);
    expect(shouldPersistMcpOAuthRedirectUri('http://127.0.0.1:55676/mcp/oauth/callback', fresh)).toBe(true);
    expect(shouldPersistMcpOAuthRedirectUri('http://localhost:57123/mcp/oauth/callback', fresh)).toBe(true);

    expect(shouldPersistMcpOAuthRedirectUri(fresh, fresh)).toBe(false);
    expect(shouldPersistMcpOAuthRedirectUri(`  ${fresh}  `, fresh)).toBe(false);
    expect(shouldPersistMcpOAuthRedirectUri('anything', '')).toBe(false);
    expect(shouldPersistMcpOAuthRedirectUri('anything', null)).toBe(false);
  });

  test('builds a clean OAuth callback URI without correlation query params', () => {
    try {
      installWindow('http://127.0.0.1:3000');

      expect(buildMcpOAuthRedirectUri('linear', '/repo/project')).toBe(
        'http://127.0.0.1:3000/mcp/oauth/callback',
      );
    } finally {
      restoreWindow();
    }
  });

  test('resolves callback context from OAuth state payload', () => {
    try {
      installWindow('http://localhost:3000');
      const state = encodeBase64Url(JSON.stringify({ v: 1, n: 'supabase', d: '/repo/app' }));
      const params = new URLSearchParams({ state });

      expect(parseMcpOAuthCallbackContext(params)).toEqual({
        name: 'supabase',
        directory: '/repo/app',
      });
    } finally {
      restoreWindow();
    }
  });

  test('keeps parsing legacy callback query params', () => {
    const params = new URLSearchParams({
      server: 'linear',
      directory: '/repo/legacy',
    });

    expect(parseMcpOAuthCallbackContext(params)).toEqual({
      name: 'linear',
      directory: '/repo/legacy',
    });
  });
});
