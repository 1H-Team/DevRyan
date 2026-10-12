import React, { act } from 'react';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { withDom, type HostElement } from '@/components/bots/chat/botMountedDom';
import { settingsDict } from '@/lib/i18n/messages/en.settings';
import { getAuthPrincipal, setAuthPrincipal } from '@/lib/authSession';

const dict: Record<string, string> = settingsDict;
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string, params?: Record<string, string>) =>
  (dict[key] ?? key).replace(/\{(\w+)\}/g, (_match, name: string) => params?.[name] ?? '') }) }));
mock.module('@/components/ui/button', () => ({ Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button onClick={props.onClick} disabled={props.disabled}>{props.children}</button> }));
const { ClaudeCodeVersionSection } = await import('./ClaudeCodeVersionSection');
const originalFetch = globalThis.fetch, originalPrincipal = getAuthPrincipal();
let calls: Array<{ path: string; method: string; body: string; csrf: string | null }> = [];
let resolutionFailure = false, bundleHeld = false;
let available = false, failure = false, postFailure = false, installed: string | null = '2.1.280', latest = '2.1.281';
const button = (container: HostElement, label: string) => container.find(node => node.tagName === 'BUTTON' && node.textContent === label);
beforeEach(() => {
  calls = []; resolutionFailure = false; bundleHeld = false; available = false; failure = false; postFailure = false; installed = '2.1.280'; latest = '2.1.281';
  setAuthPrincipal({ ...originalPrincipal, role: 'admin', scope: 'local-admin' });
  globalThis.fetch = Object.assign(mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input), method = init?.method ?? 'GET';
    calls.push({ path, method, body: String(init?.body ?? ''), csrf: new Headers(init?.headers).get('x-devryan-csrf') });
    if (path.endsWith('claude-resolution') && resolutionFailure) return Response.json({}, { status: 503 });
    if (path.endsWith('claude-resolution')) return Response.json({ source: installed ? 'verified-native-bundle' : 'unavailable', version: installed });
    if (path.endsWith('claude-update-check')) return failure ? Response.json({}, { status: 503 }) : Response.json({ latestVersion: latest });
    if (method === 'POST' && postFailure) return Response.json({ code: 'bundle_stores_unsettled' }, { status: 503 });
    return Response.json({ state: method === 'POST' ? 'restart_required' : bundleHeld ? 'held' : available ? 'upgrade_available' : 'ready',
      revision: method === 'POST' ? 8 : 7, selectedManifestSha256: 'a'.repeat(64),
      availableManifestSha256: available ? 'b'.repeat(64) : 'a'.repeat(64), restartRequired: method === 'POST' });
  }), { preconnect: () => {} });
});
afterEach(() => { globalThis.fetch = originalFetch; setAuthPrincipal(originalPrincipal); });

for (const compact of [true, false]) test(`Claude About row checks explicitly and offers DevRyan delivery (${compact})`, async () => withDom(async container => {
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  const checkApp = mock(async () => {});
  try {
    await act(async () => root.render(<ClaudeCodeVersionSection compact={compact} onCheckAppUpdates={checkApp} />));
    expect(container.textContent).toContain('Claude Code CLI'); expect(container.textContent).toContain('2.1.280');
    expect(calls.some(call => call.path.endsWith('claude-update-check'))).toBe(false);
    await act(async () => button(container, 'Check for Updates')?.click());
    expect(container.textContent).toContain('2.1.281 is available upstream');
    expect(calls.filter(call => call.path === '/api/runtime/bundle')).toHaveLength(2);
    expect(calls.every(call => call.method === 'GET')).toBe(true);
    await act(async () => button(container, 'Check DevRyan Updates')?.click()); expect(checkApp).toHaveBeenCalledTimes(1);
  } finally { await act(async () => root.unmount()); }
}));
test('available verified update uses the existing revision, CSRF and restart flow', async () => withDom(async container => {
  available = true;
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ClaudeCodeVersionSection onCheckAppUpdates={async () => {}} />));
    await act(async () => button(container, 'Apply bundled runtime update')?.click());
    expect(calls.find(call => call.method === 'POST')).toEqual({ path: '/api/runtime/bundle/upgrade', method: 'POST', body: '{"expectedRevision":7}', csrf: '1' });
    expect(container.textContent).toContain('Reload');
  } finally { await act(async () => root.unmount()); }
}));
test('unavailable version and failed checks do not imply up to date', async () => withDom(async container => {
  installed = null; failure = true;
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ClaudeCodeVersionSection onCheckAppUpdates={async () => {}} />));
    expect(container.textContent).toContain('version is unavailable');
    await act(async () => button(container, 'Check for Updates')?.click());
    expect(container.textContent).toContain('Could not check for updates'); expect(container.textContent).not.toContain('Up to date');
  } finally { await act(async () => root.unmount()); }
}));
test('non-administrators can check metadata but cannot apply host updates', async () => withDom(async container => {
  available = true; setAuthPrincipal({ ...originalPrincipal, role: 'developer', scope: 'managed' });
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ClaudeCodeVersionSection onCheckAppUpdates={async () => {}} />));
    await act(async () => button(container, 'Check for Updates')?.click());
    expect(button(container, 'Apply bundled runtime update')).toBeNull(); expect(button(container, 'Check DevRyan Updates')).toBeNull();
    expect(calls.some(call => call.path.startsWith('/api/runtime/bundle'))).toBe(false);
  } finally { await act(async () => root.unmount()); }
}));
test('failed activation withdraws mutation until recovery is read', async () => withDom(async container => {
  available = true; postFailure = true;
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ClaudeCodeVersionSection onCheckAppUpdates={async () => {}} />));
    await act(async () => button(container, 'Apply bundled runtime update')?.click());
    expect(button(container, 'Apply bundled runtime update')).toBeNull();
    expect(container.textContent).toContain(dict['settings.providers.runtimeUpdate.failed']); expect(button(container, 'Refresh')).not.toBeNull();
  } finally { await act(async () => root.unmount()); }
}));
test('same release is up to date without offering app updates', async () => withDom(async container => {
  latest = '2.1.280';
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ClaudeCodeVersionSection onCheckAppUpdates={async () => {}} />));
    await act(async () => button(container, 'Check for Updates')?.click());
    expect(container.textContent).toContain('Up to date with the latest Claude Code'); expect(button(container, 'Check DevRyan Updates')).toBeNull();
  } finally { await act(async () => root.unmount()); }
}));
test('unmount aborts an in-flight upstream check and ignores its late response', async () => withDom(async container => {
  const fallback = globalThis.fetch;
  let pending: { signal: AbortSignal | null; resolve: (response: Response) => void } | undefined;
  globalThis.fetch = Object.assign(mock((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('claude-update-check')) return new Promise<Response>(resolve => { pending = { signal: init?.signal ?? null, resolve }; });
    return fallback(input, init);
  }), { preconnect: () => {} });
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  await act(async () => root.render(<ClaudeCodeVersionSection onCheckAppUpdates={async () => {}} />));
  await act(async () => button(container, 'Check for Updates')?.click());
  expect(pending).toBeDefined();
  await act(async () => root.unmount());
  expect(pending?.signal?.aborted).toBe(true);
  await act(async () => pending?.resolve(Response.json({ latestVersion: '2.1.281' })));
  expect(container.textContent).toBe('');
}));
test('changing principal during an update clears the old busy state and removes administrator actions', async () => withDom(async container => {
  available = true;
  const fallback = globalThis.fetch;
  let pending: { signal: AbortSignal | null; resolve: (response: Response) => void } | undefined;
  globalThis.fetch = Object.assign(mock((input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') return new Promise<Response>(resolve => { pending = { signal: init.signal ?? null, resolve }; });
    return fallback(input, init);
  }), { preconnect: () => {} });
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ClaudeCodeVersionSection onCheckAppUpdates={async () => {}} />));
    await act(async () => button(container, 'Apply bundled runtime update')?.click());
    expect(button(container, 'Check for Updates')?.getAttribute('disabled')).not.toBeNull();
    await act(async () => setAuthPrincipal({ ...originalPrincipal, role: 'developer', scope: 'managed' }));
    expect(pending?.signal?.aborted).toBe(true);
    expect(button(container, 'Apply bundled runtime update')).toBeNull();
    expect(button(container, 'Check for Updates')?.getAttribute('disabled')).toBeNull();
    await act(async () => pending?.resolve(Response.json({ state: 'restart_required' })));
    expect(container.textContent).not.toContain('Reload');
  } finally { await act(async () => root.unmount()); }
}));

test('a paused host keeps the known version and recovery controls when its version lookup fails', async () => withDom(async container => {
  available = true; postFailure = true;
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ClaudeCodeVersionSection onCheckAppUpdates={async () => {}} />));
    await act(async () => button(container, 'Apply bundled runtime update')?.click());
    resolutionFailure = true; bundleHeld = true;
    await act(async () => button(container, 'Check for Updates')?.click());
    expect(container.textContent).toContain('2.1.280');
    expect(container.textContent).toContain(dict['settings.providers.runtimeUpdate.heldTitle']);
    expect(button(container, 'Apply bundled runtime update')).toBeNull();
    expect(button(container, 'Refresh')).not.toBeNull();
  } finally { await act(async () => root.unmount()); }
}));
