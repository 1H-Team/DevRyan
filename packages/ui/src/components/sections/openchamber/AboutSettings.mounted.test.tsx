import React, { act } from 'react';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { create } from 'zustand';
import { withDom, type HostElement } from '@/components/bots/chat/botMountedDom';
import { settingsDict } from '@/lib/i18n/messages/en.settings';
import type { UpdateState } from '@/stores/useUpdateStore';

const dict: Record<string, string> = settingsDict;
const t = (key: string, params?: Record<string, string>) =>
  (dict[key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) => params?.[name] ?? match);
let mobile = false;
let desktop = false;
let local = true;
let nativeVersion: string | null = '2.0.5';
let nativeCalls = 0;
let updateCalls = 0;
const getVersion = async () => { nativeCalls += 1; return nativeVersion; };
const checkForUpdates = mock(async () => {
  updateCalls += 1;
  updateStore.setState({ info: null, error: 'Update check failed' });
  return null;
});
const initialState: UpdateState = {
  info: null, checking: false, available: false, error: null, downloading: false,
  downloaded: false, progress: null, runtimeType: null, lastChecked: null, nextCheckInSec: null,
};
const updateStore = create(() => ({
  ...initialState, checkForUpdates, downloadUpdate: async () => {}, restartToUpdate: async () => {},
}));
mock.module('@/stores/useUpdateStore', () => ({ useUpdateStore: updateStore }));
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t }) }));
mock.module('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: mobile }) }));
mock.module('@/lib/desktop', () => ({ isDesktopShell: () => desktop, isDesktopLocalOriginActive: () => local, isTauriShell: () => desktop }));
mock.module('@/lib/desktopNative', () => ({ getDesktopAppVersion: getVersion }));
mock.module('@/components/ui', () => ({ toast: { success: () => {} } }));
mock.module('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    <button type="button" onClick={onClick} disabled={disabled}>{children}</button>,
}));
mock.module('@/components/ui/UpdateDialog', () => ({ UpdateDialog: () => null }));
mock.module('./SupabaseConnectionSettings', () => ({ SupabaseConnectionSettings: () => null }));
mock.module('./SessionRetentionSettings', () => ({ DataStorageSettings: () => null }));
mock.module('./DesktopKeepAwakeSettings', () => ({ DesktopKeepAwakeSettings: () => null }));
mock.module('./DesktopNetworkSettings', () => ({ DesktopNetworkSettings: () => null }));
mock.module('./DesktopBotHostStatus', () => ({ DesktopBotHostStatus: () => null }));
mock.module('./OpenCodeVersionSection', () => ({ OpenCodeVersionSection: () => null }));
const { AboutSettings } = await import('./AboutSettings');
const originalFetch = globalThis.fetch;
const originalBuildVersion = Object.getOwnPropertyDescriptor(globalThis, '__APP_VERSION__');

const setBuildVersion = (value: string | undefined) =>
  Object.defineProperty(globalThis, '__APP_VERSION__', { value, configurable: true });
const installFetch = (response: () => Promise<Response>) => {
  const fetchMock = mock(response);
  globalThis.fetch = Object.assign(fetchMock, { preconnect: () => {} });
  return fetchMock;
};
beforeEach(() => {
  desktop = false; local = true; nativeVersion = '2.0.5';
  nativeCalls = 0; updateCalls = 0; updateStore.setState(initialState);
  setBuildVersion(undefined);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalBuildVersion) Object.defineProperty(globalThis, '__APP_VERSION__', originalBuildVersion);
  else Reflect.deleteProperty(globalThis, '__APP_VERSION__');
});
const mount = async (container: HostElement) => {
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  await act(async () => { root.render(<AboutSettings />); });
  return root;
};
const expectVersion = (container: HostElement, version: string) => {
  expect(container.textContent).toContain(t('settings.openchamber.about.field.currentVersion', { version }));
  expect(container.textContent).not.toContain('unknown');
};

for (const isMobile of [false, true]) {
  test(`loads the native version with an empty update store and retains it after a failed check (mobile=${isMobile})`, async () => withDom(async (container) => {
    mobile = isMobile; desktop = true;
    const fetchMock = installFetch(async () => { throw new Error('Unexpected server lookup'); });
    const root = await mount(container);
    try {
      expectVersion(container, '2.0.5');
      expect(nativeCalls).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(0);
      expect(updateCalls).toBe(0);
      const label = t(isMobile ? 'settings.openchamber.about.actions.checkUpdates' : 'settings.openchamber.about.actions.checkForUpdates');
      await act(async () => { container.find(node => node.tagName === 'BUTTON' && node.textContent === label)?.click(); });
      expect(updateCalls).toBe(1);
      expect(container.textContent).toContain('Update check failed');
      expectVersion(container, '2.0.5');
    } finally { await act(async () => root.unmount()); }
  }));

  for (const remoteDesktop of [false, true]) test(`loads the host version (mobile=${isMobile}, remoteDesktop=${remoteDesktop})`, async () => withDom(async (container) => {
    mobile = isMobile; desktop = remoteDesktop; local = false;
    const fetchMock = installFetch(async () => Response.json({ openchamberVersion: '2.0.6' }));
    const root = await mount(container);
    try {
      expectVersion(container, '2.0.6');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(nativeCalls).toBe(0);
    } finally { await act(async () => root.unmount()); }
  }));

  for (const failure of ['http', 'network', 'invalid', 'native'] as const) test(`uses the UI build version after ${failure} lookup failure (mobile=${isMobile})`, async () => withDom(async (container) => {
    mobile = isMobile; desktop = failure === 'native'; nativeVersion = null;
    setBuildVersion('2.0.4');
    installFetch(async () => {
      if (failure === 'network') throw new Error('offline');
      return failure === 'http' ? new Response(null, { status: 503 }) : Response.json({ openchamberVersion: 42 });
    });
    const root = await mount(container);
    try { expectVersion(container, '2.0.4'); }
    finally { await act(async () => root.unmount()); }
  }));

  test(`shows localized Unavailable when neither source provides a version (mobile=${isMobile})`, async () => withDom(async (container) => {
    mobile = isMobile;
    installFetch(async () => Response.json({ openchamberVersion: ' ' }));
    const root = await mount(container);
    try { expectVersion(container, t('settings.openchamber.about.state.unavailable')); }
    finally { await act(async () => root.unmount()); }
  }));
}

test('aborts the host lookup on unmount and ignores its late result', async () => withDom(async (container) => {
  let resolve: (value: Response) => void = () => {};
  let signal: AbortSignal | null | undefined;
  globalThis.fetch = Object.assign(mock((_input: string | URL | Request, init?: RequestInit) => {
    signal = init?.signal;
    return new Promise<Response>(done => { resolve = done; });
  }), { preconnect: () => {} });
  const root = await mount(container);
  await act(async () => root.unmount());
  expect(signal?.aborted).toBe(true);
  await act(async () => { resolve(Response.json({ openchamberVersion: '9.0.0' })); });
  expect(container.textContent).toBe('');
}));
