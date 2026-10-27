import React, { act } from 'react';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { withDom, type HostElement } from '@/test/mountedDom';
import { settingsDict } from '@/lib/i18n/messages/en.settings';
import { getAuthPrincipal, setAuthPrincipal } from '@/lib/authSession';

const dict: Record<string, string> = settingsDict;
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string, params?: Record<string, string>) =>
  (dict[key] ?? key).replace(/\{(\w+)\}/g, (_match, name: string) => params?.[name] ?? '') }) }));
mock.module('@/components/ui/button', () => ({ Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button onClick={props.onClick} disabled={props.disabled}>{props.children}</button> }));
const { ClaudeCodeVersionSection } = await import('./ClaudeCodeVersionSection');
const originalFetch = globalThis.fetch, originalPrincipal = getAuthPrincipal();
let calls: Array<{ path: string; method: string; body: string; csrf: string | null }> = [];
let resolutionFailure = false, failure = false, postFailure = false;
let installed: string | null = '2.1.302', latest = '2.1.303';
let status = { supported: true, phase: 'idle', revision: 7, busy: false, held: false, restartRequired: false, rollbackAvailable: true };
const button = (container: HostElement, label: string) => container.find(node => node.tagName === 'BUTTON' && node.textContent === label);
beforeEach(() => {
  calls = []; resolutionFailure = false; failure = false; postFailure = false; installed = '2.1.302'; latest = '2.1.303';
  status = { supported: true, phase: 'idle', revision: 7, busy: false, held: false, restartRequired: false, rollbackAvailable: true };
  setAuthPrincipal({ ...originalPrincipal, role: 'admin', scope: 'local-admin' });
  globalThis.fetch = Object.assign(mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input), method = init?.method ?? 'GET';
    calls.push({ path, method, body: String(init?.body ?? ''), csrf: new Headers(init?.headers).get('x-devryan-csrf') });
    if (path.endsWith('claude-resolution')) return resolutionFailure ? Response.json({}, { status: 503 })
      : Response.json({ source: installed ? 'verified-managed-installation' : 'unavailable', version: installed });
    if (path.endsWith('claude-update-check')) return failure ? Response.json({}, { status: 503 }) : Response.json({ latestVersion: latest });
    if (method === 'POST') {
      if (postFailure) return Response.json({ code: 'bundle_selection_revision_conflict' }, { status: 409 });
      status = { ...status, phase: 'downloading', busy: true };
    }
    if (path.startsWith('/api/config/claude-update')) return Response.json(status);
    return Response.json({ state: 'ready', revision: 7, selectedManifestSha256: 'a'.repeat(64), restartRequired: false });
  }), { preconnect: () => {} });
});
afterEach(() => { globalThis.fetch = originalFetch; setAuthPrincipal(originalPrincipal); });

for (const compact of [true, false]) test(`About offers a direct update after an explicit check (${compact})`, async () => withDom(async container => {
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  const checkApp = mock(async () => {});
  try {
    await act(async () => root.render(<ClaudeCodeVersionSection compact={compact} onCheckAppUpdates={checkApp} />));
    expect(container.textContent).toContain('Claude Code CLI'); expect(container.textContent).toContain('2.1.302');
    expect(calls.some(call => call.path.endsWith('claude-update-check'))).toBe(false);
    await act(async () => button(container, 'Check for Updates')?.click());
    expect(container.textContent).toContain('2.1.303 is available.');
    expect(container.textContent).not.toContain('verify compatibility');
    expect(calls.every(call => call.method === 'GET')).toBe(true);
    await act(async () => button(container, 'Update')?.click());
    expect(calls.find(call => call.method === 'POST')).toEqual({ path: '/api/config/claude-update/install', method: 'POST', body: '{"expectedRevision":7}', csrf: '1' });
    expect(container.textContent).toContain('Downloading Claude Code');
    expect(checkApp).toHaveBeenCalledTimes(0);
  } finally { await act(async () => root.unmount()); }
}));
test('restore uses the same protected revision contract', async () => withDom(async container => {
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ClaudeCodeVersionSection onCheckAppUpdates={async () => {}} />));
    await act(async () => button(container, 'Restore Previous Version')?.click());
    expect(calls.find(call => call.method === 'POST')).toEqual({ path: '/api/config/claude-update/rollback', method: 'POST', body: '{"expectedRevision":7}', csrf: '1' });
  } finally { await act(async () => root.unmount()); }
}));
test('unavailable versions and failed checks do not imply up to date', async () => withDom(async container => {
  installed = null; failure = true;
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ClaudeCodeVersionSection onCheckAppUpdates={async () => {}} />));
    expect(container.textContent).toContain('version is unavailable');
    await act(async () => button(container, 'Check for Updates')?.click());
    expect(container.textContent).toContain('Could not check for updates'); expect(container.textContent).not.toContain('Up to date');
    expect(button(container, 'Update')).toBeNull();
  } finally { await act(async () => root.unmount()); }
}));
test('non-administrators can check metadata without reading or mutating update ownership', async () => withDom(async container => {
  setAuthPrincipal({ ...originalPrincipal, role: 'developer', scope: 'managed' });
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ClaudeCodeVersionSection onCheckAppUpdates={async () => {}} />));
    await act(async () => button(container, 'Check for Updates')?.click());
    expect(button(container, 'Update')).toBeNull(); expect(button(container, 'Restore Previous Version')).toBeNull();
    expect(calls.some(call => call.path === '/api/config/claude-update' || call.path.startsWith('/api/config/claude-update/'))).toBe(false);
  } finally { await act(async () => root.unmount()); }
}));
test('failed activation withdraws mutation controls until fresh status is read', async () => withDom(async container => {
  postFailure = true;
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ClaudeCodeVersionSection onCheckAppUpdates={async () => {}} />));
    await act(async () => button(container, 'Check for Updates')?.click());
    await act(async () => button(container, 'Update')?.click());
    expect(button(container, 'Update')).toBeNull(); expect(button(container, 'Restore Previous Version')).toBeNull();
    expect(container.textContent).toContain('Could not check for updates');
    status = { ...status, held: true, phase: 'failed', rollbackAvailable: false };
    await act(async () => button(container, 'Check for Updates')?.click());
    expect(button(container, 'Update')).toBeNull(); expect(container.textContent).toContain('could not be updated');
  } finally { await act(async () => root.unmount()); }
}));
test('equal release is up to date with no Update action', async () => withDom(async container => {
  latest = '2.1.302';
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ClaudeCodeVersionSection onCheckAppUpdates={async () => {}} />));
    await act(async () => button(container, 'Check for Updates')?.click());
    expect(container.textContent).toContain('Up to date with the latest Claude Code'); expect(button(container, 'Update')).toBeNull();
  } finally { await act(async () => root.unmount()); }
}));
test('unsupported platforms retain the existing app update action', async () => withDom(async container => {
  status.supported = false;
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element), checkApp = mock(async () => {});
  try {
    await act(async () => root.render(<ClaudeCodeVersionSection onCheckAppUpdates={checkApp} />));
    await act(async () => button(container, 'Check for Updates')?.click());
    expect(button(container, 'Update')).toBeNull();
    await act(async () => button(container, 'Check DevRyan Updates')?.click()); expect(checkApp).toHaveBeenCalledTimes(1);
  } finally { await act(async () => root.unmount()); }
}));
test('waiting and restart progress keep the running version until the next runtime answers', async () => withDom(async container => {
  status = { ...status, phase: 'waiting-for-idle', busy: true };
  const ticks: Array<() => void> = [], realSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((handler: () => void) => { ticks.push(handler); return ticks.length; }) as unknown as typeof setInterval;
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<ClaudeCodeVersionSection onCheckAppUpdates={async () => {}} />));
    expect(container.textContent).toContain('Waiting for active work'); expect(container.textContent).toContain('2.1.302');
    status = { ...status, phase: 'restarting', restartRequired: true };
    // Fire the component's poll tick directly instead of sleeping past its 1.5 s interval.
    await act(async () => { for (const tick of ticks) tick(); await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(container.textContent).toContain('Restarting the runtime'); expect(container.textContent).toContain('2.1.302');
  } finally { globalThis.setInterval = realSetInterval; await act(async () => root.unmount()); }
}));
