import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import { withDom, type HostElement } from '@/test/mountedDom';
import { settingsDict } from '@/lib/i18n/messages/en.settings';
import { I18nProvider } from '@/lib/i18n';
import type { DesktopSettings } from '@/lib/desktop';

const dict: Record<string, string> = settingsDict;
const t = (key: string, params?: Record<string, string | number>) =>
  (dict[key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) => String(params?.[name] ?? match));

const persisted: Array<Partial<DesktopSettings>> = [];
const actualDesktop = await import('@/lib/desktop');
const actualPersistence = await import('@/lib/persistence');
mock.module('@/lib/desktop', () => ({ ...actualDesktop, isDesktopShell: () => true }));
mock.module('@/lib/persistence', () => ({
  ...actualPersistence,
  updateDesktopSettings: async (changes: Partial<DesktopSettings>) => { persisted.push(changes); },
  saveDesktopSettingsNow: async () => null,
}));

const { NotificationSettings } = await import('./NotificationSettings');
const { useUIStore } = await import('@/stores/useUIStore');
const { startAppearanceAutoSave } = await import('@/lib/appearanceAutoSave');

const initial = useUIStore.getState();
beforeEach(() => {
  useUIStore.setState({
    nativeNotificationsEnabled: true,
    notifyOnCompletion: true,
    notifyOnPlanReady: true,
    notifyOnSubtasks: false,
    notifyOnError: true,
    notifyOnQuestion: true,
    notifyOnPermission: true,
  });
});
afterEach(() => { useUIStore.setState(initial, true); });

const mount = async (run: (container: HostElement) => Promise<void>) => withDom(async (container) => {
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  try {
    await act(async () => { root.render(<I18nProvider><NotificationSettings /></I18nProvider>); });
    await run(container);
  } finally { await act(async () => root.unmount()); }
});

const labelIndex = (text: string, key: string): number => text.indexOf(t(key));

describe('NotificationSettings Plan Ready controls', () => {
  test('places Plan Ready immediately after Session Completion', async () => {
    await mount(async (container) => {
      const text = container.textContent;
      const completion = labelIndex(text, 'settings.notifications.page.events.completionLabel');
      const planReady = labelIndex(text, 'settings.notifications.page.events.planReadyLabel');
      const subtask = labelIndex(text, 'settings.notifications.page.events.subtaskLabel');
      expect(completion).toBeGreaterThan(-1);
      expect(planReady).toBeGreaterThan(completion);
      expect(subtask).toBeGreaterThan(planReady);
    });
  });

  test('toggling Plan Ready changes only that setting', async () => {
    await mount(async (container) => {
      const row = container.find((node) => node.getAttribute('role') === 'button'
        && node.textContent.includes(t('settings.notifications.page.events.planReadyLabel')));
      expect(row).not.toBeNull();
      await act(async () => row!.click());
    });
    const state = useUIStore.getState();
    expect(state.notifyOnPlanReady).toBe(false);
    expect(state.notifyOnCompletion).toBe(true);
    expect(state.notifyOnPermission).toBe(true);
  });

  test('renders the Plan Ready template after Completion', async () => {
    await mount(async (container) => {
      const text = container.textContent;
      const order = ['completion', 'planReady', 'subtask', 'error', 'question', 'permission']
        .map((event) => text.lastIndexOf(t(`settings.notifications.page.template.event.${event}`)));
      for (const index of order) expect(index).toBeGreaterThan(-1);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    });
  });
});

describe('NotificationSettings Permissions Needed', () => {
  test('renders an independently configurable Permissions Needed event', async () => {
    await mount(async (container) => {
      expect(container.textContent).toContain('Permissions Needed');
      const row = container.find((node) => node.getAttribute('role') === 'button'
        && node.textContent.includes(t('settings.notifications.page.events.permissionLabel')));
      expect(row).not.toBeNull();
      expect(row!.getAttribute('aria-pressed')).toBe('true');
      await act(async () => row!.click());
    });
    const state = useUIStore.getState();
    expect(state.notifyOnPermission).toBe(false);
    expect(state.notifyOnQuestion).toBe(true);
    expect(state.notifyOnError).toBe(true);
  });

  test('uses the exact default title and message copy', () => {
    expect(dict['settings.notifications.page.events.completionLabel']).toBe('Session Completion');
    expect(dict['settings.notifications.page.template.event.completion']).toBe('Session Completion');
    expect(dict['settings.notifications.page.template.event.permission']).toBe('Permissions Needed');
    expect(dict['settings.notifications.page.template.defaults.completion.title']).toBe('Session complete');
    expect(dict['settings.notifications.page.template.defaults.completion.message']).toBe('{session_name} is ready to review');
    expect(dict['settings.notifications.page.template.defaults.planReady.title']).toBe('Plan ready');
    expect(dict['settings.notifications.page.template.defaults.planReady.message']).toBe('A plan is ready for review');
  });
});

let windowTouched = false;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const restoreWindow = () => {
  if (!windowTouched) return;
  windowTouched = false;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
};

describe('notification settings autosave', () => {
  test('persists the Plan Ready and Permissions toggles and template edits', async () => {
    Object.defineProperty(globalThis, 'window', { value: globalThis, configurable: true, writable: true });
    windowTouched = true;
    startAppearanceAutoSave();
    persisted.length = 0;

    useUIStore.setState({ notifyOnPlanReady: false });
    useUIStore.setState({ notifyOnPermission: false });
    useUIStore.getState().updateNotificationTemplate('planReady', 'title', 'Ready!');
    await new Promise((resolve) => setTimeout(resolve, 250));

    const merged = Object.assign({}, ...persisted) as Partial<DesktopSettings>;
    expect(merged.notifyOnPlanReady).toBe(false);
    expect(merged.notifyOnPermission).toBe(false);
    expect(merged.notificationTemplates?.planReady?.title).toBe('Ready!');
    restoreWindow();
  });
});
