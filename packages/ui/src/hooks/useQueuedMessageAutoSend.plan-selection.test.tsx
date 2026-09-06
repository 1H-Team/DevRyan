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

const sessionID = 'session-auto-queue-plan';
const directory = '/repo/auto-queue-plan';
const statuses = { [sessionID]: { type: 'idle' as const } };
const syncModule = await import('@/sync/sync-context');
mock.module('@/sync/sync-context', () => ({ ...syncModule, useAllSessionStatuses: () => statuses }));
const queuedSendModule = await import('@/components/chat/queuedSend');
const flushCalls: Array<Parameters<typeof queuedSendModule.flushQueuedMessagesForSession>[0]> = [];
const flush = async (options: Parameters<typeof queuedSendModule.flushQueuedMessagesForSession>[0]) => {
  flushCalls.push(options);
  return 0;
};
mock.module('@/components/chat/queuedSend', () => ({ ...queuedSendModule, flushQueuedMessagesForSession: flush }));
const { useQueuedMessageAutoSend } = await import('./useQueuedMessageAutoSend');
const { I18nProvider } = await import('@/lib/i18n');
const Harness = () => { useQueuedMessageAutoSend(); return null; };

const captured = (id: string, planMode: boolean): QueuedMessage => ({
  id, content: `Send ${id}`, createdAt: 1,
  sendConfig: { providerID: 'fixture', modelID: `model-${id}`, variant: null, planMode },
});
const withQueue = (queue: QueuedMessage[], check: (warnings: unknown[][]) => void) => withDom(async container => {
  const stores = new ChildStoreManager();
  const loader = new SessionMessageLoader(stores);
  stores.ensureChild(directory, { bootstrap: false }).setState({ session_status: statuses });
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
    useMessageQueueStore.setState({ queuedMessages: {} });
    useSelectionStore.getState().clearSessionSelection(sessionID);
  }
});

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
