import React, { act } from 'react';
import { expect, mock, test } from 'bun:test';
import { create } from 'zustand';
import { withDom } from '@/test/mountedDom';

const noop = () => {};
const selected: Array<[string, string | null]> = [];
const sessionUi = create(() => ({
  currentSessionId: 'ses_child', currentDraftId: null, newSessionDraft: null,
  getDirectoryForSession: () => '/fixture', openNewSessionDraft: noop,
  setCurrentSession: (id: string, directory: string | null) => { selected.push([id, directory]); },
}));
const ui = create(() => ({ isExpandedInput: false, isTimelineDialogOpen: false, setTimelineDialogOpen: noop }));
const streaming = create(() => ({ streamingMessageIds: new Map(), messageStreamStates: new Map() }));
const sync = { ensureSessionRenderable: async () => {}, loadMore: async () => {}, resyncSession: async () => {} };
const directory = { permission: {}, question: {}, session: [] };
const sessions: Record<string, { id: string; parentID?: string; title?: string; directory?: string }> = {
  ses_child: { id: 'ses_child', parentID: 'ses_parent' },
  ses_parent: { id: 'ses_parent', title: 'Parent chat', directory: '/parent-dir' },
};

mock.module('./ChatInput', () => ({ ChatInput: () => null }));
mock.module('@/stores/useUIStore', () => ({ useUIStore: ui }));
mock.module('@/sync/session-ui-store', () => ({ useSessionUIStore: sessionUi }));
mock.module('@/sync/streaming', () => ({ useStreamingStore: streaming }));
mock.module('@/sync/sync-context', () => ({
  useSessionMessageCount: () => 0, useSessionMessageRecords: () => [],
  useSession: (id?: string) => (id ? sessions[id] : undefined), useSessionStatus: () => ({ type: 'idle' }),
  useSessionMessageLoadState: () => ({ status: 'loaded', resolved: true, complete: true }),
  useDirectorySync: (selector: (state: typeof directory) => unknown) => selector(directory),
  useSyncDirectory: () => '/fixture',
}));
mock.module('@/sync/materialization', () => ({ getSessionMaterializationStatus: () => ({ renderable: true }) }));
mock.module('@/sync/use-sync', () => ({ useSync: () => sync }));
mock.module('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: false }) }));
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
mock.module('./lib/useChatSelectionCopySanitizer', () => ({ useChatSelectionCopySanitizer: noop }));
mock.module('@/hooks/useChatAutoFollow', () => ({
  CHAT_FORCE_SCROLL_BOTTOM_EVENT: 'scroll-bottom',
  useChatAutoFollow: () => ({ scrollRef: { current: null }, notifyContentChange: noop,
    getAnimationHandlers: noop, goToBottom: noop, releaseAutoFollow: noop, restoreSnapshot: async () => {},
    isPinned: true, isFollowingProgrammatically: false, showScrollButton: false }),
}));
mock.module('./hooks/useChatTimelineController', () => ({ useChatTimelineController: () => ({
  turnStart: 0, renderedMessages: [], historySignals: { hasMoreAboveTurns: false },
  isLoadingOlder: false, showScrollToBottom: false, loadEarlier: async () => {},
  handleActiveTurnChange: noop, turnIds: [], activeTurnId: null,
  scrollToTurn: noop, scrollToMessage: noop, resumeToBottomInstant: noop,
}) }));
mock.module('./hooks/useChatTurnNavigation', () => ({ useChatTurnNavigation: () => ({
  resumeToLatest: noop, scrollByTurnOffset: noop,
}) }));
mock.module('./MessageList', () => ({ default: () => null }));
mock.module('./ChatEmptyState', () => ({ default: () => <div>Empty history</div> }));
mock.module('./PermissionCard', () => ({ PermissionCard: () => null }));
mock.module('./StatusRowContainer', () => ({ StatusRowContainer: () => null }));
mock.module('./ManagedTaskCompactionContinuity', () => ({ ManagedTaskCompactionContinuity: () => null }));
mock.module('./SessionChangesCard', () => ({ SessionChangesCard: () => null }));
mock.module('./components/ScrollToBottomButton', () => ({ default: () => null }));
mock.module('@/components/ui/OverlayScrollbar', () => ({ OverlayScrollbar: () => null }));
mock.module('./lazyChatDialogs', () => ({ DeferredChatDialog: () => null, LazyTimelineDialog: () => null }));
mock.module('@/components/views/lazyViews', () => ({ LazyViewBoundary: () => null }));
const { ChatContainer } = await import('./ChatContainer');

test('preserves the capitalized Parent label from the translation', async () => {
  await withDom(async (container) => {
    Object.defineProperty(window, 'location', { value: { hash: '' }, configurable: true });
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<ChatContainer />));
      const button = container.find((node) => node.getAttribute('aria-label') === 'chat.container.returnToParent.aria');
      if (!button) throw new Error('Missing return-to-parent button');
      expect(button.textContent).toBe('chat.container.returnToParent.label');
      expect(button.getAttribute('class')?.split(/\s+/)).toContain('normal-case');
      expect(button.getAttribute('title')).toBe('chat.container.returnToParent.titleNamed');

      selected.length = 0;
      await act(async () => button.click());
      expect(selected).toContainEqual(['ses_parent', '/parent-dir']);
    } finally { await act(async () => root.unmount()); }
  });
});

test('shows no return-to-parent action for a root session', async () => {
  sessions.ses_child = { id: 'ses_child' };
  try {
    await withDom(async (container) => {
      Object.defineProperty(window, 'location', { value: { hash: '' }, configurable: true });
      const { createRoot } = await import('react-dom/client');
      const root = createRoot(container as unknown as Element);
      try {
        await act(async () => root.render(<ChatContainer />));
        expect(container.find((node) => node.getAttribute('aria-label') === 'chat.container.returnToParent.aria')).toBeNull();
      } finally { await act(async () => root.unmount()); }
    });
  } finally { sessions.ses_child = { id: 'ses_child', parentID: 'ses_parent' }; }
});
