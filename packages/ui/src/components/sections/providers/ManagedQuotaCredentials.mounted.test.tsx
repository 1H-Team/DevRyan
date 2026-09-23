import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { withDom } from '@/components/bots/chat/botMountedDom';
import { settingsDict } from '@/lib/i18n/messages/en.settings';
const messages: string[] = [];
const opened: string[] = [];
const dict: Record<string, string> = settingsDict;
const t = (key: string) => dict[key] ?? key;
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t }) }));
mock.module('@/components/ui', () => ({ toast: {
  success: (message: string) => messages.push(message), error: (message: string) => messages.push(message),
} }));
mock.module('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button onClick={onClick} disabled={disabled}>{children}</button>,
}));
const actualUrl = await import('@/lib/url');
mock.module('@/lib/url', () => ({ ...actualUrl, openExternalUrl: async (url: string) => { opened.push(url); return true; } }));
const { ManagedQuotaCredentials } = await import('./ManagedQuotaCredentials');
const { useQuotaStore, quotaRefreshCoordinator } = await import('@/stores/useQuotaStore');
const originalFetch = globalThis.fetch;
const WORKSPACE = 'wrk_01K46JDFR0E75SG2Q8K172KF3Y';
const FLOW = {
  flowId: 'flow-1', userCode: 'PPSQ-ZZSW', verificationUri: 'https://opencode.ai/console/device',
  verificationUriComplete: 'https://opencode.ai/console/device?user_code=PPSQ-ZZSW&client_id=devryan', expiresIn: 900, interval: 5,
};
let connected = false, legacy = false, pollResults: unknown[] = [];
let calls: string[] = [];
const timers: Array<() => void> = [];
beforeEach(() => {
  messages.length = 0; opened.length = 0; calls = []; connected = false; legacy = false; pollResults = []; timers.length = 0;
  useQuotaStore.setState({ results: [], configuredProviderIds: null, providerRefreshState: {}, error: null });
  globalThis.fetch = Object.assign(mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); calls.push(`${init?.method ?? 'GET'} ${url}${init?.body ? ` ${String(init.body)}` : ''}`);
    const status = () => (connected
      ? { configured: true, credentialKind: 'oauth', workspaceId: WORKSPACE, secretMasked: '••••••••', effectiveSource: 'managed' }
      : legacy ? { configured: false, reconnectRequired: true, effectiveSource: null } : { configured: false, effectiveSource: null });
    if (url === '/api/quota/credentials/opencode') {
      if (init?.method === 'DELETE') { connected = false; legacy = false; }
      return Response.json(status());
    }
    if (url.endsWith('/device/start')) return Response.json(FLOW);
    if (url.endsWith('/device/cancel')) return Response.json({ status: 'cancelled' });
    if (url.endsWith('/device/poll')) {
      const next = pollResults.shift() as { status: string } | undefined;
      if (next?.status === 'approved') { connected = true; return Response.json({ status: 'approved', credential: status() }); }
      return Response.json(next ?? { status: 'pending' });
    }
    if (url.endsWith('/validate')) return Response.json({ valid: true });
    if (url === '/api/quota/providers') return Response.json({ providers: connected ? ['opencode'] : [] });
    if (url.startsWith('/api/quota/opencode')) return Response.json({
      providerId: 'opencode', providerName: 'OpenCode Zen', configured: true, ok: true, fetchedAt: Date.now(),
      usage: { windows: { credits: { usedPercent: 25, valueLabel: '$5.00 used / $15.00 available' } } },
    });
    throw new Error(`Unexpected fixture request: ${url}`);
  }), { preconnect: () => {} });
});
afterEach(() => { quotaRefreshCoordinator.stop(); globalThis.fetch = originalFetch; });

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
// Poll delays are driven manually so the test never waits on the console interval.
const captureTimers = () => {
  (window as unknown as { setTimeout: (callback: () => void) => number }).setTimeout = (callback) => {
    timers.push(callback);
    return timers.length;
  };
};
const runNextPoll = async () => act(async () => {
  timers.shift()?.();
  for (let index = 0; index < 5; index += 1) await settle();
});
const button = (container: { find: (predicate: (node: { tagName: string; textContent: string | null }) => boolean) => { click: () => void } | null }, label: string) => (
  container.find((node) => node.tagName === 'BUTTON' && node.textContent === label)
);

describe('OpenCode Zen console sign-in mounted flow', () => {
  test('connects through device sign-in, refreshes usage, and shows only the workspace', async () => withDom(async (container) => {
    captureTimers();
    pollResults = [{ status: 'pending' }, { status: 'approved' }];
    const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
    try {
      await act(async () => { root.render(<ManagedQuotaCredentials providerId="opencode" />); });
      expect(container.textContent).toContain('Not connected');
      await act(async () => { button(container, 'Connect')?.click(); await settle(); });
      expect(calls).toContain('POST /api/quota/credentials/opencode/device/start');
      expect(opened).toEqual([FLOW.verificationUriComplete]);
      expect(container.textContent).toContain('PPSQ-ZZSW');
      await runNextPoll();
      expect(container.textContent).toContain('PPSQ-ZZSW');
      await runNextPoll();
      expect(calls.filter((call) => call.startsWith('POST /api/quota/credentials/opencode/device/poll {"flowId":"flow-1"}'))).toHaveLength(2);
      expect(container.textContent).not.toContain('PPSQ-ZZSW');
      expect(container.textContent).toContain('Connected');
      expect(container.textContent).toContain(WORKSPACE);
      expect(container.textContent).toContain('OpenCode Zen usage tracking connected');
      expect(calls).toContain('GET /api/quota/providers');
      expect(calls).toContain('GET /api/quota/opencode?refresh=true');
      expect(useQuotaStore.getState().results[0]?.usage?.windows.credits?.valueLabel).toBe('$5.00 used / $15.00 available');
      expect(container.find((node) => node.getAttribute('role') === 'alert')).toBeNull();
    } finally { await act(async () => root.unmount()); }
  }));

  test('asks retired dashboard credentials to reconnect and cancels an abandoned sign-in', async () => withDom(async (container) => {
    captureTimers();
    legacy = true;
    const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
    try {
      await act(async () => { root.render(<ManagedQuotaCredentials providerId="opencode" />); });
      expect(container.textContent).toContain('no longer work');
      await act(async () => { button(container, 'Reconnect')?.click(); await settle(); });
      expect(container.textContent).toContain('PPSQ-ZZSW');
      await act(async () => { button(container, 'Cancel')?.click(); await settle(); });
      expect(calls).toContain('POST /api/quota/credentials/opencode/device/cancel {"flowId":"flow-1"}');
      expect(container.textContent).not.toContain('PPSQ-ZZSW');
      await act(async () => { button(container, 'Disconnect')?.click(); await settle(); });
      expect(calls).toContain('DELETE /api/quota/credentials/opencode');
      expect(container.textContent).not.toContain('no longer work');
    } finally { await act(async () => root.unmount()); }
  }));

  test('reports a denied approval inline and stops polling', async () => withDom(async (container) => {
    captureTimers();
    pollResults = [{ status: 'denied' }];
    const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
    try {
      await act(async () => { root.render(<ManagedQuotaCredentials providerId="opencode" />); });
      await act(async () => { button(container, 'Connect')?.click(); await settle(); });
      await runNextPoll();
      expect(container.find((node) => node.getAttribute('role') === 'alert')?.textContent).toBe('Sign-in was denied in OpenCode Console.');
      expect(timers).toHaveLength(0);
      expect(connected).toBe(false);
    } finally { await act(async () => root.unmount()); }
  }));
});
