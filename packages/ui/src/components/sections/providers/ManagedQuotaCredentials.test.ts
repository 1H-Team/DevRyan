import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  fileURLToPath(new URL('./ManagedQuotaCredentials.tsx', import.meta.url)),
  'utf8',
);

describe('ManagedQuotaCredentials', () => {
  test('uses one credential contract and the existing quota refresh coordinator', () => {
    expect(source).toContain('/api/quota/credentials/');
    expect(source).toContain('quotaRefreshCoordinator.refreshNow');
    expect(source).not.toContain('setInterval(');
    expect(source).not.toContain('setTimeout(');
  });

  test('never assigns safe status metadata into secret input state', () => {
    expect(source).toContain("setWorkspaceId(typeof payload.workspaceId === 'string' ? payload.workspaceId : '')");
    expect(source).not.toContain('setAuthCookie(payload');
    expect(source).not.toContain('setCookie(payload');
    expect(source).not.toContain('setSessionToken(payload');
    expect(source).not.toContain('setAccessToken(payload');
    expect(source).not.toContain('setRefreshToken(payload');
  });

  test('keeps Cursor dashboard, OAuth, and explicit import controls distinct', () => {
    expect(source).toContain("cursorMode === 'dashboard'");
    expect(source).toContain("cursorMode === 'oauth'");
    expect(source).toContain("mutate('import')");
    expect(source).toContain('cursor-usage-session-token');
    expect(source).toContain('cursor-oauth-access-token');
    expect(source).toContain('cursor-oauth-refresh-token');
  });
});
