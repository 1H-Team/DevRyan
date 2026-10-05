import React, { act } from 'react';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { withDom } from '@/components/bots/chat/botMountedDom';
import { settingsDict } from '@/lib/i18n/messages/en.settings';
import { getAuthPrincipal, setAuthPrincipal } from '@/lib/authSession';
const dict: Record<string, string> = settingsDict;
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string, params?: Record<string, string>) =>
  (dict[key] ?? key).replace(/\{(\w+)\}/g, (_match, name: string) => params?.[name] ?? '') }) }));
mock.module('@/components/ui/button', () => ({ Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button onClick={props.onClick} disabled={props.disabled}>{props.children}</button> }));
const { BundledRuntimeUpdate } = await import('./BundledRuntimeUpdate');
const originalFetch = globalThis.fetch, originalPrincipal = getAuthPrincipal();
let calls: Array<{ path: string; method: string; body: string; csrf: string | null }> = [], available = true;
let held: Record<string, unknown> | null = null, failPost = false;
const button = (container: { find: (match: (node: { tagName: string; textContent: string }) => boolean) => unknown }, label: string) =>
  container.find(node => node.tagName === 'BUTTON' && node.textContent === label) as { click: () => void; disabled: boolean } | null;
beforeEach(() => {
  calls = []; available = true; held = null; failPost = false; setAuthPrincipal({ ...originalPrincipal, role: 'admin', scope: 'local-admin' });
  globalThis.fetch = Object.assign(mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'; calls.push({ path: String(input), method, body: String(init?.body ?? ''), csrf: new Headers(init?.headers).get('x-devryan-csrf') });
    if (method === 'POST' && failPost) return Response.json({ code: 'bundle_stores_unsettled' }, { status: 503 });
    if (method === 'GET' && held) return Response.json({ state: 'held', revision: 7, selectedManifestSha256: 'a'.repeat(64), restartRequired: false, ...held });
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

test('a checkpoint-held runtime explains the paused host and offers no transition the server refuses', async () => withDom(async container => {
  held = { reason: 'bundle_stores_unsettled', reconciliationRequired: false, rollbackAvailable: false };
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<BundledRuntimeUpdate />));
    expect(container.textContent).toContain(dict['settings.providers.runtimeUpdate.heldTitle']);
    expect(container.textContent).toContain(dict['settings.providers.runtimeUpdate.held']);
    expect(container.textContent).toContain('bundle_stores_unsettled');
    for (const label of ['Apply bundled runtime update', 'Retry rollback', 'Reload']) expect(button(container, label)).toBeNull();
    await act(async () => button(container, 'Refresh')?.click());
    expect(calls.map(call => call.method)).toEqual(['GET', 'GET']);
  } finally { await act(async () => root.unmount()); }
}));
test('a reconciliation hold offers only the server-allowed rollback with revision CAS and CSRF', async () => withDom(async container => {
  held = { reason: 'bundle_rollback_reconciliation_required', reconciliationRequired: true, rollbackAvailable: true };
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<BundledRuntimeUpdate />));
    expect(container.textContent).toContain(dict['settings.providers.runtimeUpdate.heldReconciliation']);
    expect(button(container, 'Apply bundled runtime update')).toBeNull();
    await act(async () => button(container, 'Retry rollback')?.click());
    expect(calls[1]).toEqual({ path: '/api/runtime/bundle/rollback', method: 'POST', body: '{"expectedRevision":7}', csrf: '1' });
    expect(container.textContent).toContain('Reload'); expect(button(container, 'Retry rollback')).toBeNull();
  } finally { await act(async () => root.unmount()); }
}));
test('a refused rollback withdraws the action until the state is refreshed', async () => withDom(async container => {
  held = { reason: 'bundle_rollback_reconciliation_required', reconciliationRequired: true, rollbackAvailable: true }; failPost = true;
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<BundledRuntimeUpdate />));
    await act(async () => button(container, 'Retry rollback')?.click());
    expect(container.textContent).toContain(dict['settings.providers.runtimeUpdate.failed']);
    expect(button(container, 'Retry rollback')).toBeNull();
    held = { reason: 'bundle_stores_unsettled', reconciliationRequired: true, rollbackAvailable: false };
    await act(async () => button(container, 'Refresh')?.click());
    expect(container.textContent).toContain(dict['settings.providers.runtimeUpdate.held']);
    expect(button(container, 'Retry rollback')).toBeNull(); expect(calls.map(call => call.method)).toEqual(['GET', 'POST', 'GET']);
  } finally { await act(async () => root.unmount()); }
}));
