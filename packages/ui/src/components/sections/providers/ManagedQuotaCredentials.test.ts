import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const readSibling = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');
const source = readSibling('./ManagedQuotaCredentials.tsx');
const supportSource = readSibling('./managedQuotaCredentialSupport.ts');
const zenSource = readSibling('./OpenCodeZenCredentials.tsx');

describe('ManagedQuotaCredentials', () => {
  test('uses one credential contract and the existing quota refresh coordinator', () => {
    expect(source).toContain('/api/quota/credentials/');
    expect(supportSource).toContain('quotaRefreshCoordinator.refreshNow');
    expect(source).toContain('refreshQuotaAfterCredentialChange');
    expect(source).not.toContain('setInterval(');
    expect(source).not.toContain('setTimeout(');
  });

  test('never assigns safe status metadata into secret input state', () => {
    expect(source).not.toContain("'opencode-go'");
    expect(source).not.toContain('setCookie(payload');
    expect(source).not.toContain('setSessionToken(payload');
    expect(source).not.toContain('setAccessToken(payload');
    expect(source).not.toContain('setRefreshToken(payload');
  });

  test('routes OpenCode Zen to console device sign-in with no pasted secret inputs', () => {
    expect(source).toContain("providerId === 'opencode'");
    expect(source).toContain('<OpenCodeZenCredentials />');
    expect(source).not.toContain('opencode-zen-auth-cookie');
    expect(zenSource).toContain('/device/start');
    expect(zenSource).toContain('/device/poll');
    expect(zenSource).not.toContain('<Input');
    expect(zenSource).not.toContain('authCookie');
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
