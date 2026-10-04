import React, { act } from 'react';
import { beforeEach, expect, mock, test } from 'bun:test';
import { create } from 'zustand';
import type { Message, Part } from '@opencode-ai/sdk/v2';
import type { RecoveredInputDetails } from '@/lib/primaryRecoveryApi';
import { usePrimaryRecoveryStore, type PrimaryRecoverySnapshot } from '@/stores/usePrimaryRecoveryStore';
import { withDom } from '../bots/chat/botMountedDom';

const noop = () => {};
const messages: Array<{ info: Message; parts: Part[] }> = [{ info: {
  id: 'msg_user', sessionID: 'ses_composer', role: 'user', time: { created: 1 },
  agent: 'builder', model: { providerID: 'fixture', modelID: 'model' },
}, parts: [] }];
let records: typeof messages = [];
let renderable = false;
let loadStatus = 'loading';
let mounts = 0;
let unmounts = 0;
let sends = 0;
const sessionUi = create(() => ({
  currentSessionId: 'ses_composer', currentDraftId: null, newSessionDraft: null,
  getDirectoryForSession: () => '/fixture', openNewSessionDraft: noop, setCurrentSession: noop,
}));
const ui = create(() => ({ isExpandedInput: false, isTimelineDialogOpen: false, setTimelineDialogOpen: noop }));
const streaming = create(() => ({ streamingMessageIds: new Map(), messageStreamStates: new Map() }));
const sync = { ensureSessionRenderable: async () => {}, loadMore: async () => {}, resyncSession: async () => {} };
const directory = { permission: {}, question: {}, session: [] };
const recoverySnapshot = (): PrimaryRecoverySnapshot => ({
  schemaVersion: 1, mode: 'off', supported: false, enforced: false, progressTimeoutMs: false, record: null,
});
const retainedInput: NonNullable<PrimaryRecoverySnapshot['recoveredInput']> = {
  revision: 'a'.repeat(64), state: 'paused', inputs: [{
    messageID: 'msg_retained', payloadHash: 'b'.repeat(64), type: 'user', delivery: 'queue', location: 'queued',
    preview: 'Saved request with an attachment', attachmentCount: 1, canResume: true, canDiscard: true, reason: null,
  }],
};
const retainedText = 'The full retained input remains readable. '.repeat(200);
let recoveryActions = 0;

beforeEach(() => {
  records = []; renderable = false; loadStatus = 'loading';
  mounts = 0; unmounts = 0; sends = 0; recoveryActions = 0;
  usePrimaryRecoveryStore.setState({ snapshots: {} });
});

// Keep ChatContainer's actual branches and React reconciliation. This stateful
// leaf isolates mount ownership from ChatInput's unrelated transport APIs.
mock.module('./ChatInput', () => ({ ChatInput: () => {
  const [text, setText] = React.useState('');
  const [variant, setVariant] = React.useState('high');
  const [attachment, setAttachment] = React.useState(false);
  React.useEffect(() => { mounts += 1; return () => { unmounts += 1; }; }, []);
  return <section>
    <textarea value={text} onInput={(event) => setText(event.currentTarget.value)} />
    <button data-action="variant" onClick={() => setVariant('low')}>{variant}</button>
    <button data-action="attach" onClick={() => setAttachment(true)}>{attachment ? 'brief.txt' : 'Attach'}</button>
    <button data-action="send" onClick={() => { sends += 1; }}>Send</button>
  </section>;
} }));
mock.module('@/stores/useUIStore', () => ({ useUIStore: ui }));
mock.module('@/sync/session-ui-store', () => ({ useSessionUIStore: sessionUi }));
mock.module('@/sync/streaming', () => ({ useStreamingStore: streaming }));
mock.module('@/sync/sync-context', () => ({
  useSessionMessageCount: () => records.length, useSessionMessageRecords: () => records,
  useSession: () => undefined, useSessionStatus: () => ({ type: 'idle' }),
  useSessionMessageLoadState: () => ({ status: loadStatus, resolved: renderable, complete: true }),
  useDirectorySync: (selector: (state: typeof directory) => unknown) => selector(directory),
  useSyncDirectory: () => '/fixture',
}));
mock.module('@/sync/materialization', () => ({ getSessionMaterializationStatus: () => ({ renderable }) }));
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
  turnStart: 0, renderedMessages: records, historySignals: { hasMoreAboveTurns: false },
  isLoadingOlder: false, showScrollToBottom: false, loadEarlier: async () => {},
  handleActiveTurnChange: noop, turnIds: [], activeTurnId: null,
  scrollToTurn: noop, scrollToMessage: noop, resumeToBottomInstant: noop,
}) }));
mock.module('./hooks/useChatTurnNavigation', () => ({ useChatTurnNavigation: () => ({
  resumeToLatest: noop, scrollByTurnOffset: noop,
}) }));
mock.module('./MessageList', () => ({ default: () => <div>Loaded history</div> }));
mock.module('./ChatEmptyState', () => ({ default: () => <div>Empty history</div> }));
// Keep the real recovery panel and store; only its host transport is isolated.
mock.module('@/lib/primaryRecoveryApi', () => ({
  requestPrimaryRecovery: async () => {},
  actOnRecoveredInput: async () => { recoveryActions += 1; },
  readRecoveredInput: async (): Promise<RecoveredInputDetails> => ({
    messageID: 'msg_retained', payloadHash: 'b'.repeat(64), type: 'user', delivery: 'queue', location: 'queued',
    text: retainedText, files: [{ uri: 'https://fixture.invalid/saved.txt', name: 'Saved attachment.txt', mime: 'text/plain' }],
  }),
}));
mock.module('./PermissionCard', () => ({ PermissionCard: () => null }));
mock.module('./StatusRowContainer', () => ({ StatusRowContainer: () => null }));
mock.module('./ManagedTaskCompactionContinuity', () => ({ ManagedTaskCompactionContinuity: () => null }));
mock.module('./SessionChangesCard', () => ({ SessionChangesCard: () => null }));
mock.module('./components/ScrollToBottomButton', () => ({ default: () => null }));
mock.module('@/components/ui/OverlayScrollbar', () => ({ OverlayScrollbar: () => null }));
mock.module('./lazyChatDialogs', () => ({ DeferredChatDialog: () => null, LazyTimelineDialog: () => null }));
mock.module('@/components/views/lazyViews', () => ({ LazyViewBoundary: () => null }));
const { ChatContainer } = await import('./ChatContainer');

test('same-target composer preserves text and selections across history branches without draft persistence', async () => {
  await withDom(async (container) => {
    Object.defineProperty(window, 'location', { value: { hash: '' }, configurable: true });
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    const render = async (status: string, ready: boolean, populated: boolean) => {
      loadStatus = status; renderable = ready; records = populated ? messages : [];
      await act(async () => root.render(<ChatContainer />));
    };
    try {
      await render('loading', false, false);
      const textarea = container.find((node) => node.tagName === 'TEXTAREA');
      if (!textarea) throw new Error('Missing mounted composer');
      await act(async () => {
        textarea.value = 'Continue after the compacted boundary.';
        textarea.dispatch('input');
        container.find((node) => node.getAttribute('data-action') === 'variant')?.click();
        container.find((node) => node.getAttribute('data-action') === 'attach')?.click();
      });
      expect(textarea.value).toBe('Continue after the compacted boundary.');
      for (const [status, ready, populated] of [
        ['loaded', true, true], ['loaded', true, false], ['loaded', true, true], ['error', true, false],
        ['loading', false, false], ['loaded', true, true],
      ] as const) {
        await render(status, ready, populated);
        expect(container.find((node) => node.tagName === 'TEXTAREA')).toBe(textarea);
        expect(textarea.value).toBe('Continue after the compacted boundary.');
        expect(container.find((node) => node.getAttribute('data-action') === 'variant')?.textContent).toBe('low');
        expect(container.find((node) => node.getAttribute('data-action') === 'attach')?.textContent).toBe('brief.txt');
        expect(mounts).toBe(1);
        expect(unmounts).toBe(0);
        expect(sends).toBe(0);
      }
    } finally { await act(async () => root.unmount()); }
    expect(unmounts).toBe(1);
  });
});

test('selected retained input replaces the empty prompt without remounting the composer', async () => {
  await withDom(async (container) => {
    Object.defineProperty(window, 'location', { value: { hash: '' }, configurable: true });
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    loadStatus = 'loaded'; renderable = true;
    try {
      await act(async () => root.render(<ChatContainer />));
      const textarea = container.find((node) => node.tagName === 'TEXTAREA');
      if (!textarea) throw new Error('Missing mounted composer');
      await act(async () => {
        textarea.value = 'Keep my unsent draft.';
        textarea.dispatch('input');
        container.find((node) => node.getAttribute('data-action') === 'variant')?.click();
        container.find((node) => node.getAttribute('data-action') === 'attach')?.click();
      });
      const expectComposerPreserved = () => {
        expect(container.find((node) => node.tagName === 'TEXTAREA')).toBe(textarea);
        expect(textarea.value).toBe('Keep my unsent draft.');
        expect(container.find((node) => node.getAttribute('data-action') === 'variant')?.textContent).toBe('low');
        expect(container.find((node) => node.getAttribute('data-action') === 'attach')?.textContent).toBe('brief.txt');
        expect(mounts).toBe(1); expect(unmounts).toBe(0); expect(sends).toBe(0); expect(recoveryActions).toBe(0);
      };
      await act(async () => usePrimaryRecoveryStore.getState().accept('ses_other', {
        ...recoverySnapshot(), recoveredInput: retainedInput,
      }));
      expect(container.textContent).toContain('Empty history');
      expect(container.textContent).not.toContain('Input retained after interruption');
      expectComposerPreserved();

      await act(async () => usePrimaryRecoveryStore.getState().accept('ses_composer', {
        ...recoverySnapshot(), recoveredInput: retainedInput,
      }));
      expect(container.textContent).toContain('Input retained after interruption');
      expect(container.textContent).not.toContain('Empty history');
      const disclosure = container.find((node) => node.tagName === 'DETAILS');
      if (!disclosure) throw new Error('Missing retained-input disclosure');
      await act(async () => disclosure.toggle(true));
      expect(container.textContent).toContain(retainedText);
      expect(container.textContent).toContain('Saved attachment.txt');
      expect(container.textContent).toContain('Resume Input');
      expect(container.textContent).toContain('Discard Input');
      expect(container.textContent).not.toContain('Empty history');
      expectComposerPreserved();

      for (const state of ['resuming', 'discarding'] as const) {
        await act(async () => usePrimaryRecoveryStore.getState().accept('ses_composer', {
          ...recoverySnapshot(), recoveredInput: { ...retainedInput, state },
        }));
        expect(container.find((node) => node.tagName === 'DETAILS')).toBe(disclosure);
        expect(container.textContent).toContain(retainedText);
        expect(container.textContent).not.toContain('Empty history');
        expectComposerPreserved();
      }
      await act(async () => usePrimaryRecoveryStore.getState().accept('ses_composer', {
        ...recoverySnapshot(), recoveredInputPartial: true,
      }));
      expect(container.find((node) => node.tagName === 'DETAILS')).toBe(disclosure);
      expect(container.textContent).toContain(retainedText);
      expect(container.textContent).not.toContain('Empty history');
      expectComposerPreserved();

      await act(async () => usePrimaryRecoveryStore.getState().accept('ses_composer', recoverySnapshot()));
      expect(container.textContent).toContain('Empty history');
      expect(container.textContent).not.toContain('Input retained after interruption');
      expect(container.textContent).not.toContain(retainedText);
      expect(container.find((node) => node.tagName === 'DETAILS')).toBeNull();
      expectComposerPreserved();
    } finally {
      await act(async () => root.unmount());
      usePrimaryRecoveryStore.setState({ snapshots: {} });
    }
    expect(unmounts).toBe(1);
  });
});
