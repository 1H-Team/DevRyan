import React, { act } from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { withDom } from '@/components/bots/chat/botMountedDom';
import { ChildStoreManager } from '@/sync/child-store';
import { SessionMessageLoader } from '@/sync/session-message-loader';
import { clearSyncRefs, setSyncRefs } from '@/sync/sync-refs';
import { opencodeClient } from '@/lib/opencode/client';
import { useConfigStore } from '@/stores/useConfigStore';
import { useMessageQueueStore, type QueuedMessage } from '@/stores/messageQueueStore';
import { useSelectionStore } from '@/sync/selection-store';
import type { Session } from '@opencode-ai/sdk/v2';

const sessionID = 'session-auto-queue-plan';
const directory = '/repo/auto-queue-plan';
const statuses = { [sessionID]: { type: 'idle' as const } };
let liveStores: ChildStoreManager | undefined;
const currentStores = () => { if (!liveStores) throw Error('Queue fixture is not mounted'); return liveStores; };
const emptyStatuses = {};
const syncModule = await import('@/sync/sync-context');
mock.module('@/sync/sync-context', () => ({ ...syncModule, useSyncChildStores: currentStores,
  useAllSessionStatuses: () => React.useSyncExternalStore(
    notify => currentStores().subscribeAll(notify),
    () => currentStores().getState(directory)?.session_status ?? emptyStatuses,
  ),
}));
const queuedSendModule = await import('@/components/chat/queuedSend');
const originalFlush = queuedSendModule.flushQueuedMessagesForSession;
const flushCalls: Array<Parameters<typeof queuedSendModule.flushQueuedMessagesForSession>[0]> = [];
let sendThroughOriginal = false;
const sentIDs: Array<string | undefined> = [];
const acceptedIDs: Array<string | undefined> = [];
let rejectNextSend: (() => void) | undefined;
let holdNextSend: (() => Promise<void>) | undefined;
const flush = async (options: Parameters<typeof queuedSendModule.flushQueuedMessagesForSession>[0]) => {
  flushCalls.push(options);
  if (sendThroughOriginal) return originalFlush({ ...options,
    sendMessageToSession: async (...args) => {
      sentIDs.push(args[11]?.messageID);
      if (holdNextSend) { const hold = holdNextSend; holdNextSend = undefined; await hold(); }
      if (rejectNextSend) {
        const reject = rejectNextSend; rejectNextSend = undefined; reject();
        throw Object.assign(Error('Native subtree became busy'), { code: 'native_queued_input_blocked' });
      }
      acceptedIDs.push(args[11]?.messageID);
    },
  });
  return 0;
};
mock.module('@/components/chat/queuedSend', () => ({ ...queuedSendModule, flushQueuedMessagesForSession: flush }));
const { useQueuedMessageAutoSend } = await import('./useQueuedMessageAutoSend');
const { I18nProvider } = await import('@/lib/i18n');
const Harness = ({ enabled = true }: { enabled?: boolean }) => { useQueuedMessageAutoSend(enabled); return null; };

const captured = (id: string, planMode: boolean): QueuedMessage => ({
  id, content: `Send ${id}`, createdAt: 1,
  sendConfig: { providerID: 'fixture', modelID: `model-${id}`, variant: null, planMode },
});
const session = (id: string, parentID?: string): Session => ({ id, parentID, directory,
  title: id, slug: id, projectID: 'fixture', version: '2.0.20', time: { created: 1, updated: 1 },
});
const withQueue = (queue: QueuedMessage[], check: (warnings: unknown[][]) => void) => withDom(async container => {
  const stores = new ChildStoreManager();
  liveStores = stores;
  const loader = new SessionMessageLoader(stores);
  stores.ensureChild(directory, { bootstrap: false }).setState({ session: [session(sessionID)], session_status: statuses });
  setSyncRefs(opencodeClient.getSdkClient(), stores, directory, undefined, loader);
  useSelectionStore.getState().clearSessionSelection(sessionID);
  useConfigStore.setState({ isConnected: true });
  useMessageQueueStore.setState({ queuedMessages: { [sessionID]: queue } });
  flushCalls.length = 0;
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  try {
    await act(async () => { root.render(<I18nProvider><Harness /></I18nProvider>); });
    check(warnings);
    expect(useMessageQueueStore.getState().getQueueForSession(sessionID)).toEqual(queue);
  } finally {
    await act(async () => { root.unmount(); });
    console.warn = originalWarn;
    clearSyncRefs(stores);
    loader.dispose();
    stores.disposeDirectory(directory);
    liveStores = undefined;
    useMessageQueueStore.setState({ queuedMessages: {} });
    useSelectionStore.getState().clearSessionSelection(sessionID);
  }
});

describe('queued root waits for live descendants', () => {
  for (const initial of ['busy', 'unknown', 'raced'] as const) {
    test(`idle root dispatches the captured ID once after its ${initial} descendant settles`, async () => withDom(async container => {
      const stores = new ChildStoreManager(); liveStores = stores;
      const loader = new SessionMessageLoader(stores);
      const childID = `${sessionID}-child`, grandchildID = `${sessionID}-grandchild`;
      const store = stores.ensureChild(directory, { bootstrap: false });
      store.setState({ session: [session(sessionID), session(childID, sessionID), session(grandchildID, childID)],
        session_status: { ...statuses, [childID]: { type: 'idle' }, ...(initial !== 'unknown' ? { [grandchildID]: { type: 'busy' as const } } : {}) } });
      setSyncRefs(opencodeClient.getSdkClient(), stores, directory, undefined, loader);
      useConfigStore.setState({ isConnected: true });
      const queued = { ...captured('retained', false), messageId: 'msg_sameCapturedID', messageIdScope: 'dispatch' as const };
      useMessageQueueStore.setState({ queuedMessages: { [sessionID]: [queued] } });
      flushCalls.length = 0; sentIDs.length = 0; acceptedIDs.length = 0; sendThroughOriginal = true;
      const warnings: unknown[][] = [], originalWarn = console.warn;
      console.warn = (...args: unknown[]) => { warnings.push(args); };
      const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
      try {
        await act(async () => { root.render(<I18nProvider><Harness /></I18nProvider>); });
        expect(flushCalls).toHaveLength(0); expect(sentIDs).toEqual([]);
        expect(useMessageQueueStore.getState().getQueueForSession(sessionID)).toEqual([queued]);
        if (initial === 'raced') rejectNextSend = () => store.setState({ session_status: { ...statuses, [childID]: { type: 'idle' }, [grandchildID]: { type: 'busy' } } });
        await act(async () => { store.setState({ session_status: { ...statuses, [childID]: { type: 'idle' }, [grandchildID]: { type: 'idle' } } }); });
        expect(sentIDs).toEqual(['msg_sameCapturedID']); expect(flushCalls).toHaveLength(1);
        if (initial === 'raced') {
          expect(acceptedIDs).toEqual([]); expect(warnings).toHaveLength(1);
          expect(useMessageQueueStore.getState().getQueueForSession(sessionID)).toEqual([queued]);
          await act(async () => { store.setState({ session_status: { ...statuses, [childID]: { type: 'idle' }, [grandchildID]: { type: 'idle' } } }); });
          expect(sentIDs).toEqual(['msg_sameCapturedID', 'msg_sameCapturedID']); expect(flushCalls).toHaveLength(2);
        } else expect(warnings).toEqual([]);
        expect(acceptedIDs).toEqual(['msg_sameCapturedID']);
        expect(useMessageQueueStore.getState().getQueueForSession(sessionID)).toEqual([]);
        await act(async () => { store.setState({ session_status: { ...store.getState().session_status } }); });
        expect(acceptedIDs).toEqual(['msg_sameCapturedID']); expect(flushCalls).toHaveLength(initial === 'raced' ? 2 : 1);
      } finally {
        await act(async () => { root.unmount(); }); sendThroughOriginal = false;
        rejectNextSend = undefined; console.warn = originalWarn;
        clearSyncRefs(stores); loader.dispose(); stores.disposeDirectory(directory); liveStores = undefined;
        useMessageQueueStore.setState({ queuedMessages: {} });
      }
    }));
  }
});

for (const completion of ['retry', 'disabled', 'disconnected', 'removed', 'unmounted', 'repeat-refusal'] as const) {
 test(`held refusal consumes an idle edge safely: ${completion}`, async () => withDom(async container => {
  const stores = new ChildStoreManager(); liveStores = stores;
  const loader = new SessionMessageLoader(stores);
  const childID = `${sessionID}-child`;
  const store = stores.ensureChild(directory, { bootstrap: false });
  const setChild = (type: 'busy' | 'idle') => store.setState({ session_status: { ...statuses, [childID]: { type } } });
  store.setState({ session: [session(sessionID), session(childID, sessionID)] }); setChild('busy');
  setSyncRefs(opencodeClient.getSdkClient(), stores, directory, undefined, loader);
  useConfigStore.setState({ isConnected: true });
  const queued = { ...captured('held', false), messageId: 'msg_heldCapturedID', messageIdScope: 'dispatch' as const };
  useMessageQueueStore.setState({ queuedMessages: { [sessionID]: [queued] } });
  flushCalls.length = 0; sentIDs.length = 0; acceptedIDs.length = 0; sendThroughOriginal = true;
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  holdNextSend = () => held;
  const originalWarn = console.warn; console.warn = () => {};
  const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
  let unmounted = false;
  try {
    await act(async () => { root.render(<I18nProvider><Harness /></I18nProvider>); });
    expect(sentIDs).toEqual([]);
    await act(async () => { setChild('idle'); });
    expect(sentIDs).toEqual(['msg_heldCapturedID']);
    expect(useMessageQueueStore.getState().getQueueForSession(sessionID)).toEqual([]);
    await act(async () => { setChild('busy'); });
    await act(async () => { setChild('idle'); });
    expect(flushCalls).toHaveLength(1); expect(acceptedIDs).toEqual([]);
    if (completion === 'disabled') await act(async () => { root.render(<I18nProvider><Harness enabled={false} /></I18nProvider>); });
    if (completion === 'disconnected') await act(async () => { useConfigStore.setState({ isConnected: false }); });
    if (completion === 'removed') await act(async () => { store.setState({ session: [] }); });
    if (completion === 'unmounted') { await act(async () => { root.unmount(); }); unmounted = true; }
    rejectNextSend = () => { if (completion === 'repeat-refusal') rejectNextSend = () => {}; };
    await act(async () => { release(); });
    const retried = completion === 'retry' || completion === 'repeat-refusal';
    expect(sentIDs).toEqual(retried ? ['msg_heldCapturedID', 'msg_heldCapturedID'] : ['msg_heldCapturedID']);
    expect(acceptedIDs).toEqual(completion === 'retry' ? ['msg_heldCapturedID'] : []);
    expect(useMessageQueueStore.getState().getQueueForSession(sessionID)).toEqual(completion === 'retry' ? [] : [queued]);
    await act(async () => { setChild('idle'); });
    expect(flushCalls).toHaveLength(retried ? 2 : 1);
  } finally {
    release(); if (!unmounted) await act(async () => { root.unmount(); }); sendThroughOriginal = false;
    holdNextSend = undefined; rejectNextSend = undefined; console.warn = originalWarn;
    clearSyncRefs(stores); loader.dispose(); stores.disposeDirectory(directory); liveStores = undefined;
    useMessageQueueStore.setState({ queuedMessages: {} });
  }
}));
}

describe('queued auto-send with unresolved live Plan history', () => {
  test('dispatches fully captured OFF/ON rows without resolving live history', async () => {
    const queue = [captured('off', false), captured('on', true)];
    await withQueue(queue, warnings => {
      expect(warnings).toEqual([]);
      expect(flushCalls).toHaveLength(1);
      expect(flushCalls[0].fallbackSendConfig).toEqual(queue[0].sendConfig!);
    });
  });

  for (const incompleteIndex of [0, 1]) {
    test(`handles missing capture in row ${incompleteIndex + 1} without claiming the queue or leaking a rejection`, async () => {
      const queue = [captured('off', false), captured('on', true)];
      queue[incompleteIndex] = { ...queue[incompleteIndex], sendConfig: { providerID: 'fixture', modelID: 'legacy' } };
      await withQueue(queue, warnings => {
        expect(flushCalls).toHaveLength(0);
        expect(warnings).toHaveLength(1);
        expect(warnings[0][1]).toBeInstanceOf(Error);
        expect(String(warnings[0][1])).toContain('Plan choice is still loading');
      });
    });
  }
});
