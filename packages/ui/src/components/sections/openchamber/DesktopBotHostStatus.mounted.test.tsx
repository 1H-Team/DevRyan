import React, { act } from 'react';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { withDom, type HostElement } from '@/components/bots/chat/botMountedDom';
import type { BotCapabilities } from '@/lib/botsApi';
import type { RuntimeServiceStatus } from '@/lib/botsDesktopApi';

let available = true;
let mode: RuntimeServiceStatus['configuredMode'] = 'app_bound';
let runtime: BotCapabilities;
let calls = 0;
let destination = '';
const translation = { t: (key: string) => key };
mock.module('@/lib/i18n', () => ({ useI18n: () => translation }));
mock.module('@/lib/botsDesktopApi', () => ({ botsDesktopApi: {
  isAvailable: () => available,
  runtimeServiceStatus: async () => ({ configuredMode: mode }),
} }));
mock.module('@/lib/botsApi', () => ({ botsApi: {
  getCapabilities: async () => { calls++; return runtime; },
} }));
mock.module('@/stores/useUIStore', () => ({
  useUIStore: (selector: (state: { setSettingsPage: (page: string) => void }) => unknown) => selector({
    setSettingsPage: (page) => { destination = page; },
  }),
}));
const { DesktopBotHostStatus } = await import('./DesktopBotHostStatus');
const flush = async () => { for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); }); };
const mount = async (run: (container: HostElement) => Promise<void>) => withDom(async (container) => {
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(<DesktopBotHostStatus />));
    await flush();
    await run(container);
  } finally { await act(async () => root.unmount()); }
});
beforeEach(() => {
  available = true; mode = 'app_bound'; calls = 0; destination = '';
  runtime = { available: true, state: 'healthy', code: null, owner: 'electron', canManageRuntime: true, canCreateBot: true };
});

describe('About Bot host status', () => {
  for (const [value, label] of [
    ['app_bound', 'appBound'], ['service', 'service'], ['disabled', 'disabled'],
  ] as const) test(`shows ${value} without changing runtime preferences`, async () => {
    mode = value;
    await mount(async (container) => {
      expect(container.textContent).toContain(`settings.openchamber.botHost.${label}`);
      await act(async () => container.find((node) => node.tagName === 'BUTTON'
        && node.textContent === 'settings.openchamber.botHost.settings')?.click());
      expect(destination).toBe('bots');
      expect(calls).toBe(1);
    });
  });

  test('shows a stopped Docker host and refreshes after recovery', async () => {
    runtime = { ...runtime, available: false, state: 'docker_stopped' };
    await mount(async (container) => {
      expect(container.textContent).toContain('bots.runtime.dockerStopped');
      runtime = { ...runtime, available: true, state: 'healthy' };
      await act(async () => container.find((node) => node.tagName === 'BUTTON'
        && node.textContent === 'settings.openchamber.botHost.refresh')?.click());
      await flush();
      expect(container.textContent).toContain('settings.openchamber.botHost.ready');
      expect(calls).toBe(2);
    });
  });

  test('does not expose host controls or probe Docker in remote browsers', async () => {
    available = false;
    await mount(async (container) => {
      expect(container.textContent).toBe('');
      expect(calls).toBe(0);
    });
  });
});
