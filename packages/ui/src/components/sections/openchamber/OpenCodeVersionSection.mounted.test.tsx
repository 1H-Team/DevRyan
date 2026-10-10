import React, { act } from 'react';
import { afterEach, expect, mock, test } from 'bun:test';
import { withDom, type HostElement } from '@/components/bots/chat/botMountedDom';
import { settingsDict } from '@/lib/i18n/messages/en.settings';

const dict: Record<string, string> = settingsDict;
const t = (key: string, params?: Record<string, string>) =>
  (dict[key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) => params?.[name] ?? match);
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t }) }));
// The disabled prop is mirrored to data-disabled so React does not swallow
// clicks: that lets the tests drive the re-entry (second click) abort path.
mock.module('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button type="button" onClick={onClick} data-disabled={disabled ? 'true' : undefined}>{children}</button>,
}));
const { OpenCodeVersionSection } = await import('./OpenCodeVersionSection');

const UPDATE_URL = '/api/config/opencode-update-check';
const RESOLUTION_URL = '/api/config/opencode-resolution';
const CHECK = t('settings.openchamber.about.opencode.actions.checkUpdates');
const CHECKING = t('settings.openchamber.about.opencode.actions.checkingUpdates');
const UP_TO_DATE = (version: string) => t('settings.openchamber.about.opencode.upstream.upToDate', { version });
const FAILED = t('settings.openchamber.about.opencode.upstream.failed');
const expectRemovedCopy = (container: HostElement) => {
  expect(container.textContent).not.toContain(t('settings.openchamber.about.opencode.bundledUpdates'));
  expect(container.textContent).not.toContain('Latest upstream OpenCode release. DevRyan qualifies runtime updates before bundling them.');
};

type Deferred = { url: string; signal: AbortSignal | null; resolve: (response: Response) => void; reject: (error: unknown) => void };
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const installFetch = (resolution: () => Response) => {
  const updateRequests: Deferred[] = [];
  const calls: string[] = [];
  globalThis.fetch = Object.assign(mock((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url === RESOLUTION_URL) return Promise.resolve(resolution());
    if (url === UPDATE_URL) {
      // Settled only by the test, so a late result after abort can be delivered.
      return new Promise<Response>((resolve, reject) => {
        updateRequests.push({ url, signal: init?.signal ?? null, resolve, reject });
      });
    }
    return Promise.reject(new Error(`Unexpected fixture request: ${url}`));
  }), { preconnect: () => {} });
  return { updateRequests, calls };
};

const bundled = (version: string) => () => Response.json({ source: 'verified-native-bundle', targetVersion: version, detectedVersion: version });
const findButton = (container: HostElement, label: string) =>
  container.find((node) => node.tagName === 'BUTTON' && node.textContent === label);
const liveRegion = (container: HostElement) =>
  container.find((node) => node.getAttribute('role') === 'status' && node.getAttribute('aria-live') === 'polite');

const mount = async (container: HostElement, element: React.ReactElement) => {
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  await act(async () => { root.render(element); });
  return root;
};

for (const compact of [true, false]) test(`offers Check for Updates without fetching upstream on mount (compact=${compact})`, async () => withDom(async (container) => {
  const { calls } = installFetch(bundled('2.0.24'));
  const root = await mount(container, <OpenCodeVersionSection compact={compact} />);
  try {
    expect(findButton(container, CHECK)).not.toBeNull();
    expect(findButton(container, t('settings.openchamber.about.opencode.actions.retry'))).not.toBeNull();
    expect(container.textContent).toContain('2.0.24');
    expectRemovedCopy(container);
    expect(calls).toEqual([RESOLUTION_URL]);
    expect(liveRegion(container)?.textContent).toBe('');
  } finally { await act(async () => root.unmount()); }
}));

for (const compact of [true, false]) test(`shows progress, then an available upstream update (compact=${compact})`, async () => withDom(async (container) => {
  const { updateRequests } = installFetch(bundled('2.0.24'));
  const root = await mount(container, <OpenCodeVersionSection compact={compact} />);
  try {
    await act(async () => { findButton(container, CHECK)?.click(); });
    const progress = findButton(container, CHECKING);
    expect(progress).not.toBeNull();
    expect(progress?.getAttribute('data-disabled')).toBe('true');
    expect(updateRequests).toHaveLength(1);
    await act(async () => { updateRequests[0].resolve(Response.json({ latestVersion: '2.0.26' })); });
    expect(findButton(container, CHECK)?.getAttribute('data-disabled')).toBeNull();
    expect(liveRegion(container)?.textContent).toContain(t('settings.openchamber.about.opencode.upstream.updateAvailable', { version: '2.0.26' }));
    expectRemovedCopy(container);
  } finally { await act(async () => root.unmount()); }
}));

test('reports up to date when the bundled runtime matches or is newer', async () => withDom(async (container) => {
  const { updateRequests } = installFetch(bundled('2.0.26'));
  const root = await mount(container, <OpenCodeVersionSection compact />);
  try {
    for (const latestVersion of ['2.0.26', '2.0.9']) {
      await act(async () => { findButton(container, CHECK)?.click(); });
      await act(async () => { updateRequests.at(-1)?.resolve(Response.json({ latestVersion })); });
      expect(liveRegion(container)?.textContent).toContain(UP_TO_DATE(latestVersion));
    }
  } finally { await act(async () => root.unmount()); }
}));

test('a failure never shows a stale success, and a retry can succeed', async () => withDom(async (container) => {
  const { updateRequests } = installFetch(bundled('2.0.26'));
  const root = await mount(container, <OpenCodeVersionSection />);
  try {
    await act(async () => { findButton(container, CHECK)?.click(); });
    await act(async () => { updateRequests[0].resolve(Response.json({ latestVersion: '2.0.26' })); });
    expect(liveRegion(container)?.textContent).toContain(UP_TO_DATE('2.0.26'));

    await act(async () => { findButton(container, CHECK)?.click(); });
    expect(liveRegion(container)?.textContent).toBe('');
    await act(async () => { updateRequests[1].resolve(Response.json({ error: 'opencode_update_check_failed' }, { status: 503 })); });
    expect(liveRegion(container)?.textContent).toBe(FAILED);

    await act(async () => { findButton(container, CHECK)?.click(); });
    await act(async () => { updateRequests[2].resolve(Response.json({ latestVersion: '2.0.26-beta.1' })); });
    expect(liveRegion(container)?.textContent).toBe(FAILED);

    await act(async () => { findButton(container, CHECK)?.click(); });
    await act(async () => { updateRequests[3].reject(new TypeError('network')); });
    expect(liveRegion(container)?.textContent).toBe(FAILED);

    await act(async () => { findButton(container, CHECK)?.click(); });
    await act(async () => { updateRequests[4].resolve(Response.json({ latestVersion: '2.1.0' })); });
    expect(liveRegion(container)?.textContent).toContain(t('settings.openchamber.about.opencode.upstream.updateAvailable', { version: '2.1.0' }));
    expect(liveRegion(container)?.textContent).not.toContain(FAILED);
  } finally { await act(async () => root.unmount()); }
}));

test('shows the latest upstream release without comparing when the bundled version is unknown', async () => withDom(async (container) => {
  const { updateRequests } = installFetch(() => Response.json({ error: 'unavailable' }, { status: 503 }));
  const root = await mount(container, <OpenCodeVersionSection />);
  try {
    await act(async () => { findButton(container, CHECK)?.click(); });
    await act(async () => { updateRequests[0].resolve(Response.json({ latestVersion: '2.0.26' })); });
    const text = liveRegion(container)?.textContent ?? '';
    expect(text).toContain(t('settings.openchamber.about.opencode.upstream.latest', { version: '2.0.26' }));
    expect(text).not.toContain('Up to date');
    expect(text).not.toContain('Update available');
  } finally { await act(async () => root.unmount()); }
}));

test('a new check aborts the obsolete request and its late result is ignored; unmount aborts', async () => withDom(async (container) => {
  const { updateRequests } = installFetch(bundled('2.0.24'));
  const root = await mount(container, <OpenCodeVersionSection />);
  let unmounted = false;
  try {
    await act(async () => { findButton(container, CHECK)?.click(); });
    await act(async () => { findButton(container, CHECKING)?.click(); });
    expect(updateRequests).toHaveLength(2);
    expect(updateRequests[0].signal?.aborted).toBe(true);
    expect(updateRequests[1].signal?.aborted).toBe(false);
    await act(async () => { updateRequests[0].resolve(Response.json({ latestVersion: '2.9.9' })); });
    expect(container.textContent).not.toContain('2.9.9');
    expect(findButton(container, CHECKING)).not.toBeNull();
    await act(async () => { updateRequests[1].resolve(Response.json({ latestVersion: '2.0.26' })); });
    expect(liveRegion(container)?.textContent).toContain('2.0.26');

    await act(async () => { findButton(container, CHECK)?.click(); });
    expect(updateRequests).toHaveLength(3);
    await act(async () => root.unmount());
    unmounted = true;
    expect(updateRequests[2].signal?.aborted).toBe(true);
    await act(async () => { updateRequests[2].resolve(Response.json({ latestVersion: '2.8.8' })); });
    expect(container.textContent).not.toContain('2.8.8');
  } finally { if (!unmounted) await act(async () => root.unmount()); }
}));
