import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { withDom } from '@/components/bots/chat/botMountedDom';
import { settingsDict } from '@/lib/i18n/messages/en.settings';
const inputs = new Map<string, React.InputHTMLAttributes<HTMLInputElement>>();
const messages: string[] = [];
const dict: Record<string, string> = settingsDict;
const t = (key: string) => dict[key] ?? key;
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t }) }));
mock.module('@/components/ui', () => ({ toast: {
  success: (message: string) => messages.push(message), error: (message: string) => messages.push(message),
} }));
mock.module('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button onClick={onClick} disabled={disabled}>{children}</button>,
}));
mock.module('@/components/ui/input', () => ({ Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => {
  if (props.id) inputs.set(props.id, props); return <input {...props} />;
} }));
const { ManagedQuotaCredentials } = await import('./ManagedQuotaCredentials');
const { useQuotaStore, quotaRefreshCoordinator } = await import('@/stores/useQuotaStore');
const originalFetch = globalThis.fetch;
let saved = false, rejectSave = false, failRefresh = false;
let calls: string[] = [];
beforeEach(() => {
  inputs.clear(); messages.length = 0; calls = []; saved = false; rejectSave = false; failRefresh = false;
  useQuotaStore.setState({ results: [], configuredProviderIds: null, providerRefreshState: {}, error: null });
  globalThis.fetch = Object.assign(mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url === '/api/quota/credentials/opencode') {
      if (init?.method === 'PUT') {
        if (rejectSave) return Response.json({ code: 'AUTHENTICATION_FAILED', error: 'Zen session expired.' }, { status: 400 });
        expect(JSON.parse(String(init.body))).toEqual({ workspaceId: 'wrk_01K46JDFR0E75SG2Q8K172KF3Y', authCookie: 'fixture-cookie' });
        saved = true;
      }
      return Response.json({ configured: saved });
    }
    if (url.endsWith('/validate')) return Response.json({ valid: true });
    if (url === '/api/quota/providers') return Response.json({ providers: saved ? ['opencode'] : [] });
    if (url.startsWith('/api/quota/opencode')) return Response.json({
      providerId: 'opencode', providerName: 'OpenCode Zen', configured: true, ok: !failRefresh, fetchedAt: Date.now(),
      error: failRefresh ? 'Zen billing request timed out. Try again.' : undefined,
      errorCode: failRefresh ? 'TIMEOUT' : undefined,
      usage: failRefresh ? null : { windows: { credits: { usedPercent: 25, valueLabel: '$5.00 used / $15.00 available' } } },
    });
    throw new Error(`Unexpected fixture request: ${url}`);
  }), { preconnect: () => {} });
});
afterEach(() => { quotaRefreshCoordinator.stop(); globalThis.fetch = originalFetch; });
const fillCredential = async () => act(async () => {
  for (const [id, value] of [['opencode-zen-workspace-id', 'wrk_01K46JDFR0E75SG2Q8K172KF3Y'], ['opencode-zen-auth-cookie', 'fixture-cookie']]) {
    inputs.get(id)?.onChange?.({ target: { value } } as React.ChangeEvent<HTMLInputElement>);
  }
});

describe('managed Zen credentials mounted flow', () => {
  test('saves, rediscovers, refreshes usage, clears secrets, and restores safe status on remount', async () => withDom(async (container) => {
    const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
    try {
      await act(async () => { root.render(<ManagedQuotaCredentials providerId="opencode" />); });
      await fillCredential();
      await act(async () => { container.find((node) => node.tagName === 'BUTTON' && node.textContent === 'Save')?.click(); });
      expect(calls).toContain('PUT /api/quota/credentials/opencode');
      expect(calls).toContain('GET /api/quota/providers');
      expect(calls).toContain('GET /api/quota/opencode?refresh=true');
      expect(useQuotaStore.getState().results[0]?.usage?.windows.credits?.valueLabel).toBe('$5.00 used / $15.00 available');
      expect(inputs.get('opencode-zen-auth-cookie')?.value).toBe('');
      expect(container.textContent).toContain('Managed quota credentials saved');
      await act(async () => { root.render(<ManagedQuotaCredentials key="remounted" providerId="opencode" />); });
      expect(inputs.get('opencode-zen-auth-cookie')?.value).toBe('');
      expect(container.find((node) => node.tagName === 'BUTTON' && node.textContent === 'Refresh Usage')?.hasAttribute('disabled')).toBe(false);
    } finally { await act(async () => root.unmount()); }
  }));
  test('shows saved credentials separately from refresh failure and recovers on refresh', async () => withDom(async (container) => {
    failRefresh = true;
    const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
    try {
      await act(async () => { root.render(<ManagedQuotaCredentials providerId="opencode" />); });
      await fillCredential();
      await act(async () => { container.find((node) => node.tagName === 'BUTTON' && node.textContent === 'Save')?.click(); });
      expect(saved).toBe(true); expect(container.textContent).toContain('Managed quota credentials saved');
      expect(container.find((node) => node.getAttribute('role') === 'alert')?.textContent).toContain('timed out');
      failRefresh = false;
      await act(async () => { container.find((node) => node.tagName === 'BUTTON' && node.textContent === 'Refresh Usage')?.click(); });
      expect(container.find((node) => node.getAttribute('role') === 'alert')).toBeNull();
      expect(useQuotaStore.getState().results[0]?.ok).toBe(true);
      expect(messages.join(' ')).not.toContain('fixture-cookie');
    } finally { await act(async () => root.unmount()); }
  }));
  test('shows rejected replacement inline and retains the existing configured state', async () => withDom(async (container) => {
    saved = true; rejectSave = true;
    const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
    try {
      await act(async () => { root.render(<ManagedQuotaCredentials providerId="opencode" />); });
      await fillCredential();
      await act(async () => { container.find((node) => node.tagName === 'BUTTON' && node.textContent === 'Save')?.click(); });
      expect(container.find((node) => node.getAttribute('role') === 'alert')?.textContent).toBe('Zen session expired.');
      expect(container.find((node) => node.tagName === 'BUTTON' && node.textContent === 'Refresh Usage')?.hasAttribute('disabled')).toBe(false);
      expect(calls).not.toContain('GET /api/quota/providers');
    } finally { await act(async () => root.unmount()); }
  }));
});
