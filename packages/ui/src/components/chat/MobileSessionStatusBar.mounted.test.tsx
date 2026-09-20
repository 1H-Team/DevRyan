import React, { act } from 'react';
import { expect, mock, test } from 'bun:test';
import { create } from 'zustand';
import { useNotificationStore } from '@/sync/notification-store';
import { withDom } from '../bots/chat/botMountedDom';

const sessions = [{ id: 'root', title: 'Finished task', directory: '/repo', time: { created: 1, updated: 2 } }];
const statuses = { root: { type: 'idle' } };
const sessionUI = create(() => ({
  currentSessionId: 'another-task', currentDraftId: null, newSessionDraft: null,
  sessionPlanIndicator: new Map(), planModeUserMessagesBySession: new Map(),
  sessionCompletionIndicator: new Map([['root', { messageId: 'done', completedAt: 10 }]]),
  availableWorktreesByProject: new Map(), setCurrentSession: () => {}, openNewSessionDraft: () => {},
}));
mock.module('@/sync/session-ui-store', () => ({ useSessionUIStore: sessionUI }));
mock.module('@/sync/sync-context', () => ({
  useSessions: () => sessions, useAllSessionStatuses: () => statuses,
  useIsSessionWorking: () => false,
  useDirectorySync: (selector: (state: { question: Record<string, never[]> }) => unknown) => selector({ question: {} }),
}));
mock.module('@/sync/selection-store', () => ({ useSelectionStore: { getState: () => ({ getSessionAgentSelection: () => null }) } }));
mock.module('@/stores/useConfigStore', () => ({ useConfigStore: create(() => ({ agents: [] })) }));
mock.module('@/stores/useUIStore', () => ({ useUIStore: create(() => ({
  isMobile: true, showMobileSessionStatusBar: true, isMobileSessionStatusBarCollapsed: false,
  setIsMobileSessionStatusBarCollapsed: () => {}, setActiveMainTab: () => {},
})) }));
mock.module('@/stores/useProjectsStore', () => ({ useProjectsStore: create(() => ({ getActiveProject: () => null })) }));
mock.module('@/stores/useDirectoryStore', () => ({ useDirectoryStore: create(() => ({ homeDirectory: '/fixture' })) }));
mock.module('@/contexts/useThemeSystem', () => ({ useThemeSystem: () => ({ currentTheme: { metadata: { variant: 'dark' } } }) }));
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
mock.module('@/hooks/useDrawerSwipe', () => ({ useDrawerSwipe: () => ({}) }));

const { MobileSessionStatusBar } = await import('./MobileSessionStatusBar');

test('mounted mobile indicator changes from error to completed without marking errors read', async () => {
  const completedAt = Date.now();
  useNotificationStore.setState({ list: [], index: {
    session: { unseenCount: {}, unseenHasError: {}, unseenHasCompletion: {} },
    project: { unseenCount: {}, unseenHasError: {}, unseenHasCompletion: {} },
  } });
  useNotificationStore.getState().append({ type: 'error', session: 'root', directory: '/repo', time: completedAt - 1, viewed: false });
  const errors = useNotificationStore.getState().list;
  useNotificationStore.getState().append({ type: 'turn-complete', session: 'root', directory: '/repo', messageId: 'done', time: completedAt, viewed: false });
  await withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<MobileSessionStatusBar />));
      expect(container.find((node) => node.getAttribute('aria-label') === 'sessions.sidebar.session.status.error')).not.toBeNull();
      await act(async () => useNotificationStore.getState().resolveErrors(errors, 'done', completedAt));
      expect(container.find((node) => node.getAttribute('aria-label') === 'sessions.sidebar.session.status.error')).toBeNull();
      const completed = container.find((node) => node.getAttribute('aria-label') === 'sessions.sidebar.session.status.completed');
      expect(completed).not.toBeNull();
      expect(completed?.getAttribute('class')).toContain('bg-status-success');
      expect(useNotificationStore.getState().list[0]?.viewed).toBe(false);
      await act(async () => useNotificationStore.getState().append({ type: 'error', session: 'root', directory: '/repo', time: completedAt + 1, viewed: false }));
      expect(container.find((node) => node.getAttribute('aria-label') === 'sessions.sidebar.session.status.error')).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
    }
  });
});
