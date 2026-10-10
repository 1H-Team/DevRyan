import React, { act } from 'react';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { withDom, type HostElement } from '@/components/bots/chat/botMountedDom';
import { settingsDict } from '@/lib/i18n/messages/en.settings';
const dict: Record<string, string> = settingsDict;
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string, values: Record<string, string> = {}) => (dict[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? '') }) }));
mock.module('@/components/ui/button', () => ({ Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button onClick={props.onClick} disabled={props.disabled}>{props.children}</button> }));
let isLocal = true, refreshes = 0;
const actualDesktop = await import('@/lib/desktop');
mock.module('@/lib/desktop', () => ({ ...actualDesktop, isDesktopLocalOriginActive: () => isLocal }));
const actualQuota = await import('@/stores/useQuotaStore');
mock.module('@/stores/useQuotaStore', () => ({ ...actualQuota, quotaRefreshCoordinator: { refreshNow: async () => { refreshes++; } } }));
const opened: string[] = [];
const actualUrl = await import('@/lib/url');
mock.module('@/lib/url', () => ({ ...actualUrl, openExternalUrl: async (url: string) => { opened.push(url); return true; } }));
const { CodexUsageConnection } = await import('./CodexUsageConnection');
const originalFetch = globalThis.fetch, originalState = actualQuota.useQuotaStore.getState();
const endpoint = '/api/quota/codex/connection', url = 'https://auth.openai.com/codex/device';
type Status = { available: boolean; configured: boolean; source: 'codex-app-server'; connectionId: string | null;
  account: { email: string; planType: string } | null; login: { flowId: string; status: string; verificationUrl?: string; userCode?: string; expiresAt: number } | null };
let status: Status, calls: Array<{ path: string; method: string; body: string; csrf: string | null }>, beforeStart = async () => {};
beforeEach(() => {
  isLocal = true; refreshes = 0; opened.length = 0; calls = []; beforeStart = async () => {};
  status = { available: true, configured: false, source: 'codex-app-server', connectionId: null, account: null, login: null };
  actualQuota.useQuotaStore.setState({ results: [], trendHistory: {}, providerRefreshState: {} });
  globalThis.fetch = Object.assign(mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input), method = init?.method ?? 'GET';
    calls.push({ path, method, body: String(init?.body ?? ''), csrf: new Headers(init?.headers).get('x-devryan-csrf') });
    if (path.endsWith('/start')) { await beforeStart(); status = { ...status, login: { flowId: 'flow-a', status: 'pending', verificationUrl: url, userCode: 'SAFE-CODE', expiresAt: Date.now() + 60000 } }; }
    if (path.endsWith('/cancel')) status = { ...status, login: { flowId: 'flow-a', status: 'cancelled', expiresAt: Date.now() } };
    if (method === 'DELETE') status = { ...status, configured: false, connectionId: null, account: null, login: null };
    return Response.json(status);
  }), { preconnect: () => {} });
});
afterEach(() => { globalThis.fetch = originalFetch; actualQuota.useQuotaStore.setState(originalState, true); });
const click = async (container: HostElement, label: string) => act(async () => {
  const button = container.find(node => node.tagName === 'BUTTON' && node.textContent === label);
  expect(button).not.toBeNull(); expect(button?.getAttribute('disabled')).toBeNull(); button?.click();
});
const seedQuota = () => actualQuota.useQuotaStore.setState({ results: [{ providerId: 'codex', providerName: 'OpenAI', configured: true, ok: true,
  usage: { windows: {} }, fetchedAt: 1, source: 'chatgpt-siwc', connectionId: 'prompt-account', account: { email: 'prompt@example.test', planType: 'pro' } }] });

test('usage connects explicitly, refreshes approved identity, and disconnects without touching prompt authentication', async () => withDom(async container => {
  seedQuota(); const { createRoot } = await import('react-dom/client'), root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<CodexUsageConnection administrator principalID="admin" />));
    expect(calls.map(call => call.method)).toEqual(['GET']); expect(actualQuota.useQuotaStore.getState().results).toHaveLength(1);
    expect(container.textContent).toContain('ChatGPT sign-in continues to power your prompts.');
    await click(container, 'Connect Usage');
    expect(opened).toEqual([url]); expect(container.textContent).toContain('SAFE-CODE'); expect(refreshes).toBe(0);
    expect(calls.at(-1)).toMatchObject({ path: `${endpoint}/start`, method: 'POST', body: '{"method":"device"}', csrf: '1' });
    status = { ...status, configured: true, connectionId: 'usage-account', account: { email: 'usage@example.test', planType: 'pro' },
      login: { flowId: 'flow-a', status: 'approved', expiresAt: Date.now() } };
    await click(container, 'Refresh Usage Connection');
    expect(container.textContent).toContain('Usage source: Codex'); expect(container.textContent).toContain('usage@example.test');
    expect(actualQuota.useQuotaStore.getState().results).toEqual([]); expect(refreshes).toBe(1);
    await click(container, 'Disconnect Usage'); expect(refreshes).toBe(2);
    expect(calls.at(-1)).toMatchObject({ path: endpoint, method: 'DELETE', csrf: '1' });
    expect(calls.every(call => call.path.startsWith(endpoint))).toBe(true);
  } finally { await act(async () => root.unmount()); }
}));

test('cancel retains the existing usage connection and never publishes a new account', async () => withDom(async container => {
  status = { ...status, configured: true, connectionId: 'usage-old', account: { email: 'old@example.test', planType: 'pro' } };
  const { createRoot } = await import('react-dom/client'), root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<CodexUsageConnection administrator principalID="admin" />));
    await click(container, 'Reconnect Usage'); await click(container, 'Cancel Usage Sign-In');
    expect(calls.at(-1)).toMatchObject({ path: `${endpoint}/cancel`, body: '{"flowId":"flow-a"}', csrf: '1' });
    expect(container.textContent).toContain('old@example.test'); expect(container.textContent).not.toContain('SAFE-CODE'); expect(refreshes).toBe(0);
  } finally { await act(async () => root.unmount()); }
}));

test('status changes invalidate the prior email even when the connection id stays the same', async () => withDom(async container => {
  status = { ...status, configured: true, connectionId: 'same-connection', account: { email: 'old@example.test', planType: 'pro' } };
  actualQuota.useQuotaStore.setState({ results: [{ providerId: 'codex', providerName: 'Codex', configured: true, ok: true,
    usage: { windows: {} }, fetchedAt: 1, source: status.source, connectionId: status.connectionId, account: status.account }] });
  const { createRoot } = await import('react-dom/client'), root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<CodexUsageConnection administrator principalID="admin" />));
    expect(actualQuota.useQuotaStore.getState().results).toHaveLength(1); expect(refreshes).toBe(0);
    status = { ...status, account: { email: 'new@example.test', planType: 'pro' } };
    await click(container, 'Refresh Usage Connection');
    expect(actualQuota.useQuotaStore.getState().results).toEqual([]); expect(refreshes).toBe(1);
    expect(container.textContent).toContain('new@example.test'); expect(container.textContent).not.toContain('old@example.test');
  } finally { await act(async () => root.unmount()); }
}));

test('pending consent polls status and publishes approved usage without prompting', async () => withDom(async container => {
  seedQuota(); const { createRoot } = await import('react-dom/client'), root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<CodexUsageConnection administrator principalID="admin" />));
    await click(container, 'Connect Usage');
    status = { ...status, configured: true, connectionId: 'polled-account', account: { email: 'polled@example.test', planType: 'pro' },
      login: { flowId: 'flow-a', status: 'approved', expiresAt: Date.now() } };
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 2100)); });
    expect(container.textContent).toContain('polled@example.test'); expect(refreshes).toBe(1);
    expect(actualQuota.useQuotaStore.getState().results).toEqual([]);
    expect(calls.filter(call => call.method === 'GET')).toHaveLength(2);
    expect(calls.every(call => call.path.startsWith(endpoint))).toBe(true);
  } finally { await act(async () => root.unmount()); }
}));

test('replacement principal ignores late sign-in and non-admin views never access connection state', async () => withDom(async container => {
  let release: (() => void) | undefined; beforeStart = () => new Promise<void>(resolve => { release = resolve; });
  const { createRoot } = await import('react-dom/client'), root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<CodexUsageConnection administrator principalID="admin" />));
    await click(container, 'Connect Usage');
    await act(async () => root.render(<CodexUsageConnection administrator={false} principalID="other" />));
    await act(async () => { release?.(); }); expect(container.textContent).toBe(''); expect(opened).toEqual([]); expect(refreshes).toBe(0);
    expect(calls).toHaveLength(2);
  } finally { await act(async () => root.unmount()); }
}));

test('untrusted sign-in URLs stay closed and remote controls never call the local connection', async () => withDom(async container => {
  globalThis.fetch = Object.assign(mock(async () => Response.json({ ...status, login: { flowId: 'bad', status: 'pending', verificationUrl: 'https://foreign.invalid/login', expiresAt: Date.now() } })), { preconnect: () => {} });
  const { createRoot } = await import('react-dom/client'), root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<CodexUsageConnection administrator principalID="admin" />));
    expect(container.textContent).toContain('could not be verified'); expect(opened).toEqual([]);
    isLocal = false;
    await act(async () => root.render(<CodexUsageConnection administrator principalID="other" />));
    expect(container.textContent).toContain('local administrator app'); expect(calls).toHaveLength(0);
  } finally { await act(async () => root.unmount()); }
}));
