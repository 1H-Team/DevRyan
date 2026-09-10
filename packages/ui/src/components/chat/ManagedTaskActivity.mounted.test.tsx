import React, { act } from 'react';
import { expect, mock, test } from 'bun:test';
import { useStore } from 'zustand';
import {
  createManagedAssistantActivityRegistry,
  createManagedOpenCodeExecutor,
  createManagedTaskScheduler,
  toManagedTaskEvent,
  type ManagedOpenCodeTransport,
} from '@openchamber/orchestration-runtime';
import { I18nProvider } from '@/lib/i18n';
import { withDom } from '../bots/chat/botMountedDom';
import { managedTitleFixture } from './managedTaskTestFixture';

mock.module('@/components/ui/ProviderLogo', () => ({
  ProviderLogo: ({ providerId }: { providerId: string }) => <img src={`/logos/${providerId}.svg`} />,
}));

const syncModule = { ...(await import('@/sync/sync-context')) };
mock.module('@/sync/sync-context', () => ({
  ...syncModule,
  useSessionStatus: () => undefined,
  useDirectoryStore: () => managedTitleFixture,
  useSyncResyncSession: () => async () => undefined,
  setActiveSession: () => undefined,
}));
const storeModule = { ...(await import('@/stores/useManagedOrchestrationStore')) };
const store = storeModule.createManagedOrchestrationStore();
mock.module('@/stores/useManagedOrchestrationStore', () => ({
  ...storeModule,
  useManagedOrchestrationStore: Object.assign(
    <T,>(selector: (state: ReturnType<typeof store.getState>) => T) => useStore(store, selector), store,
  ),
}));
const { ManagedTaskRow } = await import('./ManagedTaskRow');
const { resolveManagedChildGenericStatusText } = await import('./StatusRowContainer');
const ChildStatus = () => {
  const task = useStore(store, (state) => state.tasksById.dvr_task_activity);
  return <span data-child-status>{resolveManagedChildGenericStatusText({
    task, isGenericStatus: true, waitingText: 'Waiting for model', recoveringText: 'Recovering subtask',
  }) ?? 'Working'}</span>;
};

const deferred = <T,>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
};

test('first Claude activity reaches the subscribed card and child copy before a blocked transcript completes', async () => {
  const registry = createManagedAssistantActivityRegistry();
  const read = deferred<Awaited<ReturnType<ManagedOpenCodeTransport['readMessages']>>>();
  const reading = deferred<void>();
  let reads = 0;
  const executor = createManagedOpenCodeExecutor({
    subscribeAssistantActivity: registry.subscribe,
    idleStablePolls: 1,
    transport: {
      async createSession() { return { id: 'ses_child' }; },
      async promptSession() {}, async readSession() { return { id: 'ses_child' }; },
      async readStatus() { return { type: 'idle' }; },
      async readMessages() { reads++; reading.resolve(); return await read.promise; },
      async abortSession() { return true; }, async deleteSession() { return true; },
    },
  });
  const scheduler = createManagedTaskScheduler({
    executor, createTaskId: () => 'dvr_task_activity', createLeaseToken: () => 'dvr_lease_activity',
    publishEvent: (event) => { store.getState().ingestEvent(event); },
  });
  await withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    let submitted = false;
    try {
      await scheduler.submit({
        idempotencyKey: 'activity', rootSessionId: 'ses_root', parentTaskId: null,
        directory: '/workspace', mode: 'builder', providerId: 'anthropic', modelId: 'claude-opus-5',
        agent: 'designer', variant: null, label: 'Layout', prompt: 'Inspect layout', timeoutAt: null,
      });
      submitted = true;
      await reading.promise;
      await scheduler.flush();
      const current = scheduler.getTask('dvr_task_activity');
      if (!current) throw new Error('Missing submitted activity task');
      store.getState().ingestEvent(toManagedTaskEvent({
        ...current, taskId: 'dvr_task_unrelated', rootSessionId: 'ses_other_root', childSessionId: 'ses_other_child',
      }));
      const unrelated = store.getState().tasksById.dvr_task_unrelated;
      await act(async () => { root.render(<I18nProvider><ManagedTaskRow taskId="dvr_task_activity" /><ChildStatus /></I18nProvider>); });
      expect(container.textContent).toContain('Starting model…');
      expect(container.textContent).toContain('Waiting for model');
      const started = performance.now();
      await act(async () => {
        registry.observe({ type: 'message.updated', properties: { info: {
          id: 'msg_activity', sessionID: 'ses_child', role: 'assistant', time: { created: Date.now() },
        } } });
        registry.observe({ type: 'message.part.updated', properties: { part: {
          messageID: 'msg_activity', sessionID: 'ses_child', type: 'reasoning', text: 'Checking layout',
        } } });
        await scheduler.flush();
      });
      expect(container.textContent).toContain('Running...');
      expect(container.textContent).toContain('Working');
      expect(container.textContent).not.toContain('Waiting for model');
      expect(container.textContent).not.toContain('Starting model');
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(reads).toBe(1);
      expect(store.getState().tasksById.dvr_task_unrelated).toBe(unrelated);
      const active = store.getState().tasksById.dvr_task_activity;
      await act(async () => {
        // A snapshot/event captured before semantic activity must not restore
        // the startup labels while the same attempt is already working.
        store.getState().ingestEvent(toManagedTaskEvent(current));
      });
      expect(store.getState().tasksById.dvr_task_activity).toBe(active);
      expect(container.textContent).toContain('Running...');
      expect(container.textContent).toContain('Working');
      expect(container.textContent).not.toContain('Waiting for model');
      expect(container.textContent).not.toContain('Starting model');
    } finally {
      await act(async () => {
        read.resolve([{ info: { id: 'msg_activity', role: 'assistant', finish: 'stop', time: { completed: Date.now() } }, parts: [{ type: 'text', text: 'Done' }] }]);
        if (submitted) await scheduler.waitForTask('dvr_task_activity');
        await scheduler.flush();
        root.unmount();
      });
      await scheduler.shutdown();
    }
  });
});
