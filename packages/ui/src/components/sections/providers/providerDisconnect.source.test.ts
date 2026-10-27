import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'bun:test';

import { disconnectProvider } from './providerConnectionState';

const readSource = (fileName: string): string => readFileSync(
  fileURLToPath(new URL(fileName, import.meta.url)),
  'utf8',
);

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe('provider disconnect requests', () => {
  test('includes the shared-host CSRF proof in the shared disconnect request', async () => {
    const seen: Array<{ url: string; method: string | undefined; headers: Record<string, string> }> = [];
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), method: init?.method, headers: { ...(init?.headers as Record<string, string>) } });
      return new Response(JSON.stringify({ success: true, removed: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }, { preconnect: () => {} });

    await disconnectProvider('anthropic', '/work/project');

    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe('DELETE');
    expect(seen[0]?.url).toBe('/api/provider/anthropic/auth?scope=all&directory=%2Fwork%2Fproject');
    expect(seen[0]?.headers['X-DevRyan-CSRF']).toBe('1');
  });

  // Candidate lint rule: callers must go through disconnectProvider, not hand-roll the DELETE.
  for (const fileName of ['./ProvidersPage.tsx', './ProvidersSidebar.tsx']) {
    test(`uses the shared disconnect request in ${fileName}`, () => {
      const source = readSource(fileName);
      expect(source).toContain('disconnectProvider(providerId, currentDirectory)');
    });
  }
});
