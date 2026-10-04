import React, { act } from 'react';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { withDom } from '@/components/bots/chat/botMountedDom';
import { settingsDict } from '@/lib/i18n/messages/en.settings';
import { getAuthPrincipal, setAuthPrincipal } from '@/lib/authSession';
const dict: Record<string, string> = settingsDict;
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => dict[key] ?? key }) }));
mock.module('@/components/ui/button', () => ({ Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button onClick={props.onClick} disabled={props.disabled}>{props.children}</button> }));
const { BundledRuntimeUpdate } = await import('./BundledRuntimeUpdate');
const originalFetch = globalThis.fetch, originalPrincipal = getAuthPrincipal();
let calls: Array<{ path: string; method: string; body: string; csrf: string | null }> = [], available = true;
beforeEach(() => {
  calls = []; available = true; setAuthPrincipal({ ...originalPrincipal, role: 'admin', scope: 'local-admin' });
  globalThis.fetch = Object.assign(mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'; calls.push({ path: String(input), method, body: String(init?.body ?? ''), csrf: new Headers(init?.headers).get('x-devryan-csrf') });
    return Response.json({ state: method === 'POST' ? 'restart_required' : available ? 'upgrade_available' : 'ready', revision: method === 'POST' ? 8 : 7,
      selectedManifestSha256: 'a'.repeat(64), availableManifestSha256: available ? 'b'.repeat(64) : 'a'.repeat(64), restartRequired: method === 'POST' });
  }), { preconnect: () => {} });
});
afterEach(() => { globalThis.fetch = originalFetch; setAuthPrincipal(originalPrincipal); });
test('inspects without applying; explicit administrator action sends revision CAS and CSRF', async () => withDom(async container => {
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<BundledRuntimeUpdate />)); expect(calls).toHaveLength(1); expect(calls[0].method).toBe('GET');
    await act(async () => container.find(node => node.tagName === 'BUTTON' && node.textContent === 'Apply bundled runtime update')?.click());
    expect(calls[1]).toEqual({ path: '/api/runtime/bundle/upgrade', method: 'POST', body: '{"expectedRevision":7}', csrf: '1' });
    expect(container.textContent).toContain('Reload'); expect(calls).toHaveLength(2);
  } finally { await act(async () => root.unmount()); }
}));
test('no update or non-administrator never authorizes a transition', async () => withDom(async container => {
  available = false; const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<BundledRuntimeUpdate />)); expect(container.textContent).toBe('');
    await act(async () => setAuthPrincipal({ ...originalPrincipal, role: 'developer', scope: 'managed' }));
    expect(container.textContent).toBe(''); expect(calls).toHaveLength(1);
  } finally { await act(async () => root.unmount()); }
}));
