import React, { act } from 'react';
import { afterEach, expect, mock, test } from 'bun:test';
import { withDom } from '@/components/bots/chat/botMountedDom';
import { settingsDict } from '@/lib/i18n/messages/en.settings';

const dict: Record<string, string> = settingsDict;
const t = (key: string) => dict[key] ?? key;
const Group = ({ children }: React.PropsWithChildren) => <div>{children}</div>;
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t }) }));
mock.module('@/components/ui', () => ({ toast: { success() {}, warning() {}, error() {} } }));
mock.module('@/components/ui/button', () => ({ Button: ({ children, onClick, disabled }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button onClick={onClick} disabled={disabled}>{children}</button> }));
mock.module('@/components/ui/select', () => ({ Select: Group, SelectContent: Group, SelectItem: Group, SelectTrigger: Group, SelectValue: Group }));
mock.module('@/components/ui/tooltip', () => ({ Tooltip: Group, TooltipContent: Group, TooltipTrigger: Group }));
mock.module('@/components/ui/collapsible', () => ({ Collapsible: Group, CollapsibleContent: Group, CollapsibleTrigger: Group }));
mock.module('@/lib/botsApi', () => ({ botsApi: { listBots: async () => { throw new Error('Supabase Off'); } } }));
mock.module('@/lib/persistence', () => ({ updateDesktopSettings: async () => {} }));
const actualDesktop = await import('@/lib/desktop');
mock.module('@/lib/desktop', () => ({ ...actualDesktop, requestFileAccess: async () => ({ success: false }) }));
mock.module('qrcode', () => ({ default: { toDataURL: async () => 'data:image/png;base64,fixture' } }));
const copied: string[] = [];
mock.module('@/lib/clipboard', () => ({ copyTextToClipboard: async (text: string) => { copied.push(text); return { ok: true }; } }));
const { TunnelSettings } = await import('./TunnelSettings');
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; copied.length = 0; });

for (const policy of ['owner-link', 'account-login'] as const) test(`starts Managed Remote with ${policy} and copies the usable URL`, async () => withDom(async (container) => {
  Object.assign(window, { setInterval, clearInterval });
  let active = false;
  const writes: Array<{ url: string; body: unknown }> = [];
  const url = 'https://app.example.test';
  const connectUrl = `${url}/tunnel/connect#t=fixture`;
  const status = () => ({ active, url: active ? url : null, mode: 'managed-remote', policy, runtimeReady: true, connectReady: active,
    botOnlyLinks: true, managedRemoteTunnelPresets: [{ id: 'production', name: 'Production', hostname: 'app.example.test', originPort: 3000 }],
    managedRemoteTunnelTokenPresetIds: ['production'] });
  globalThis.fetch = Object.assign(mock(async (input: string | URL | Request, init?: RequestInit) => {
    const target = String(input);
    if (init?.method === 'POST') writes.push({ url: target, body: JSON.parse(String(init.body)) });
    if (target.endsWith('/tunnel/check')) return Response.json({ available: true });
    if (target.endsWith('/tunnel/status')) return Response.json(status());
    if (target === '/api/config/settings') return Response.json({ tunnelProvider: 'cloudflare', tunnelMode: 'managed-remote' });
    if (target.endsWith('/tunnel/providers')) return Response.json({ providers: [] });
    if (target.endsWith('/tunnel/start')) {
      active = true;
      return Response.json({ ...status(), ok: true, connectUrl: policy === 'owner-link' ? connectUrl : null, bootstrapExpiresAt: Date.now() + 900_000 });
    }
    if (target.endsWith('/tunnel/links')) return Response.json({ connectUrl, expiresAt: Date.now() + 900_000 });
    throw new Error(`Unexpected fixture request: ${target}`);
  }), { preconnect: () => {} });
  const button = (label: string) => container.find((node) => node.tagName === 'BUTTON' && node.textContent === label);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  try {
    await act(async () => { root.render(<TunnelSettings />); });
    expect(container.textContent).not.toContain('Managed accounts required');
    const start = button(t('settings.openchamber.tunnel.actions.startTunnel'));
    expect(start).not.toBeNull();
    expect(start?.getAttribute('disabled')).toBeNull();
    await act(async () => { start?.click(); });
    expect(writes[0]).toMatchObject({ url: '/api/openchamber/tunnel/start', body: { mode: 'managed-remote', managedRemoteTunnelPresetId: 'production' } });
    if (policy === 'owner-link') {
      expect(container.textContent).toContain('This private link grants full access');
      await act(async () => { button(t('settings.openchamber.tunnel.actions.newConnectLink'))?.click(); });
      expect(writes.at(-1)).toEqual({ url: '/api/openchamber/tunnel/links', body: { access: 'owner' } });
    }
    await act(async () => { button(t(policy === 'owner-link' ? 'settings.common.actions.copyAll' : 'settings.openchamber.tunnel.actions.copyUrl'))?.click(); });
    expect(copied).toEqual([policy === 'owner-link' ? connectUrl : url]);
  } finally { await act(async () => root.unmount()); }
}));
