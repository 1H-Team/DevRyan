import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import { withDom, type HostElement } from '@/components/bots/chat/botMountedDom';
import { settingsDict } from '@/lib/i18n/messages/en.settings';

const dict: Record<string, string> = settingsDict;
const t = (key: string) => dict[key] ?? key;
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t }) }));
mock.module('@/components/ui', () => ({ toast: { success() {}, error() {} } }));
mock.module('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button onClick={onClick} disabled={disabled} aria-pressed={rest['aria-pressed']}>{children}</button>
  ),
}));
type InputProps = { id?: string; value?: string; onChange?: (event: { target: { value: string } }) => void; type?: string };
const inputs = new Map<string, InputProps>();
mock.module('@/components/ui/input', () => ({
  Input: (props: InputProps) => { if (props.id) inputs.set(props.id, props); return <input id={props.id} type={props.type} value={props.value ?? ''} readOnly />; },
}));

const { ManagedQuotaCredentials } = await import('./ManagedQuotaCredentials');
const { quotaRefreshCoordinator } = await import('@/stores/useQuotaStore');

const originalFetch = globalThis.fetch;
let calls: Array<{ method: string; url: string; body?: string }> = [];
let status: Record<string, unknown> = { configured: false };
beforeEach(() => {
  calls = []; inputs.clear(); status = { configured: false };
  globalThis.fetch = Object.assign(mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ method: init?.method ?? 'GET', url, body: init?.body as string | undefined });
    if (url.startsWith('/api/quota/providers')) return Response.json({ providers: [] });
    if (url.startsWith('/api/quota/credentials/')) return Response.json(status);
    return Response.json({});
  }), { preconnect: () => {} });
});
afterEach(() => { quotaRefreshCoordinator.stop(); globalThis.fetch = originalFetch; });

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const mountProvider = async (providerId: 'cursor-acp' | 'ollama-cloud' | 'opencode', run: (container: HostElement) => Promise<void>) => withDom(async (container) => {
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  try {
    await act(async () => { root.render(<ManagedQuotaCredentials providerId={providerId} />); });
    await act(async () => { await settle(); });
    await run(container);
  } finally { await act(async () => root.unmount()); }
});
const button = (container: HostElement, label: string) => container.find((node) => node.tagName === 'BUTTON' && node.textContent === label);
const inputIds = (container: HostElement) => {
  const ids: string[] = [];
  const walk = (node: HostElement) => { if (node.tagName === 'INPUT') ids.push(node.getAttribute('id') ?? ''); node.childNodes.forEach((child) => { if ('tagName' in child) walk(child as HostElement); }); };
  walk(container);
  return ids;
};

describe('managed quota credential controls for pasted secrets', () => {
  test('routes OpenCode Zen to console sign-in with no pasted secret inputs', async () => {
    await mountProvider('opencode', async (container) => {
      expect(inputIds(container)).toEqual([]);
      expect(container.find((node) => node.tagName === 'TEXTAREA')).toBeNull();
    });
  });

  test('keeps Cursor dashboard, OAuth, and explicit import controls distinct', async () => {
    await mountProvider('cursor-acp', async (container) => {
      expect(inputIds(container)).toEqual(['cursor-usage-session-token']);
      await act(async () => button(container, dict['settings.providers.page.auth.cursorOAuthMode'] as string)?.click());
      expect(inputIds(container)).toEqual(['cursor-oauth-access-token', 'cursor-oauth-refresh-token']);
      await act(async () => button(container, dict['settings.providers.page.auth.cursorDashboardMode'] as string)?.click());
      expect(inputIds(container)).toEqual(['cursor-usage-session-token']);

      calls.length = 0;
      await act(async () => { button(container, dict['settings.providers.page.actions.importFromCursor'] as string)?.click(); await settle(); });
      expect(calls[0]).toMatchObject({ method: 'POST', url: '/api/quota/credentials/cursor-acp/import' });
    });
  });

  test('saves only the credential fields of the active Cursor mode', async () => {
    await mountProvider('cursor-acp', async (container) => {
      await act(async () => { inputs.get('cursor-usage-session-token')?.onChange?.({ target: { value: ' dashboard-token ' } }); });
      calls.length = 0;
      await act(async () => { button(container, dict['settings.providers.page.actions.save'] as string)?.click(); await settle(); });
      expect(calls[0]).toMatchObject({ method: 'PUT', url: '/api/quota/credentials/cursor-acp', body: JSON.stringify({ sessionToken: 'dashboard-token' }) });
    });
  });

  test('never assigns safe status metadata into secret input state', async () => {
    status = {
      configured: true, credentialKind: 'dashboard', secretMasked: '••••••••', effectiveSource: 'managed',
      cookie: 'leaked-cookie', sessionToken: 'leaked-session', accessToken: 'leaked-access', refreshToken: 'leaked-refresh',
    };
    for (const providerId of ['cursor-acp', 'ollama-cloud'] as const) {
      await mountProvider(providerId, async (container) => {
        expect(container.textContent).toContain(dict['settings.providers.page.auth.managedQuotaConfigured'] as string);
        expect(inputIds(container).length).toBeGreaterThan(0);
        for (const props of inputs.values()) expect(props.value).toBe('');
      });
    }
  });
});
