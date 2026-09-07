import React, { act } from 'react';
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { useStore } from 'zustand';
import { createManagedTaskRecord, toManagedTaskEvent, type ManagedTaskRecord } from '@openchamber/orchestration-runtime';
import { I18nProvider } from '@/lib/i18n';
import { resolveDisplaySessionTitle } from '@/lib/sessionTitles';
import { managedTitleFixture } from './managedTaskTestFixture';
import { HostElement, type HostNode, withDom } from '../bots/chat/botMountedDom';
import type { ManagedTaskDispatchFallback, PendingManagedTaskDispatch } from './managedTaskDispatch';

let resyncCalls = 0;
const resync = async () => { resyncCalls += 1; };
const syncModule = { ...(await import('@/sync/sync-context')) };
mock.module('@/sync/sync-context', () => ({
  ...syncModule,
  useDirectoryStore: () => managedTitleFixture,
  useSessionStatus: () => undefined,
  useSyncResyncSession: () => resync,
  setActiveSession: () => undefined,
}));
mock.module('@/components/ui/ProviderLogo', () => ({ ProviderLogo: () => null }));
const storeModule = { ...(await import('@/stores/useManagedOrchestrationStore')) };
const store = storeModule.createManagedOrchestrationStore({ api: {
  async handoff() { throw new Error('not used'); },
  async getSnapshot() { return { available: true, bridgeReady: true, recoveryWarning: null, tasks: [], resultEnvelopes: [] }; },
  async getTask() { throw new Error('not used'); },
  async cancelTask() { throw new Error('not used'); },
  async acknowledgeTask() { throw new Error('not used'); },
  async setAutoResume() { throw new Error('not used'); },
} });
mock.module('@/stores/useManagedOrchestrationStore', () => ({
  ...storeModule,
  useManagedOrchestrationStore: Object.assign(
    <T,>(selector: (state: ReturnType<typeof store.getState>) => T) => useStore(store, selector), store,
  ),
}));
const { ManagedTaskList } = await import('./ManagedTaskList');
const { MANAGED_TITLE_RECOVERY_DELAYS } = await import('./ManagedTaskReadiness');
const { resolveManagedTaskTitle, useManagedTaskTitle } = await import('./managedTaskTitle');

const task = (id: string, overrides: Partial<ManagedTaskRecord> = {}): ManagedTaskRecord => ({
  ...createManagedTaskRecord({
    taskId: id, idempotencyKey: id, rootSessionId: 'ses_root', parentTaskId: null,
    directory: '/workspace', sequence: 1, mode: 'orchestrator', providerId: 'openai', modelId: 'gpt-6-astra',
    agent: 'designer', variant: null, label: 'Managed designer task', prompt: 'Implement approved plan: Feedback Chat Greeting and Form.',
    attempt: 1, priorTaskId: null, executionKind: 'start', createdAt: 1_000, timeoutAt: null,
  }),
  childSessionId: 'ses_child', status: 'running', startedAt: 1_100, dispatchCallId: 'call_start', ...overrides,
});
const ingest = (record: ManagedTaskRecord) => store.getState().ingestEvent(toManagedTaskEvent(record));
const count = (node: HostNode, attr: string): number => (
  Number(node instanceof HostElement && node.hasAttribute(attr)) + node.childNodes.reduce((total, child) => total + count(child, attr), 0)
);
const title = (value: string, id = 'ses_child') => managedTitleFixture.setState((state) => ({
  session: [...state.session.filter((session) => session.id !== id), { id, title: value }],
}));
const pending: PendingManagedTaskDispatch = { partId: 'part_start', dispatchCallId: 'call_start', agent: 'designer', label: 'Managed designer task', status: 'preparing' };

afterEach(() => {
  store.getState().reset();
  managedTitleFixture.setState({ session: [] });
  resyncCalls = 0;
});

describe('managed dispatch title readiness', () => {
  test('recognizes only resolved canonical child titles and uses sidebar formatting', () => {
    const identity = { childSessionId: 'ses_child', agent: 'designer' };
    for (const value of [undefined, '', 'Untitled Session', 'Managed designer task', 'New session - 2026-09-07T12:00:00.000Z']) {
      expect(resolveManagedTaskTitle(identity, value)).toBeNull();
    }
    expect(resolveManagedTaskTitle({ ...identity, childSessionId: null }, 'Feedback Chat')).toBeNull();
    expect(resolveManagedTaskTitle(identity, 'Feedback Chat Greeting and Form'))
      .toBe(resolveDisplaySessionTitle({ title: 'Feedback Chat Greeting and Form' }));
  });

  test('keeps the implementation statement visible while task-first title delivery hides the entire card', async () => withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    try {
      managedTitleFixture.setState({ session: [] });
      ingest(task('dvr_task_first', { childSessionId: null, status: 'starting' }));
      await act(async () => root.render(<I18nProvider><p>I will implement the feedback-only change and verify it.</p><ManagedTaskList rootSessionId="ses_root" /></I18nProvider>));
      expect(count(container, 'data-managed-task-card')).toBe(0);
      expect(container.textContent).toContain('I will implement');
      await act(async () => { ingest(task('dvr_task_first')); title('Managed designer task'); });
      expect(count(container, 'data-managed-task-card')).toBe(0);
      expect(container.textContent).not.toContain('Managed designer task');
      await act(async () => title('Feedback Chat Greeting and Form'));
      expect(count(container, 'data-managed-task-card')).toBe(1);
      expect(count(container, 'data-managed-task-id')).toBe(1);
      expect(container.textContent.indexOf('I will implement')).toBeLessThan(container.textContent.indexOf('Agent Dispatch'));
      expect(container.textContent).toContain('Feedback Chat Greeting and Form');
    } finally { await act(async () => root.unmount()); }
  }));

  test('reconciles title-first delivery, pending calls and renames without duplicate rows', async () => withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    try {
      title('Feedback Chat Greeting and Form');
      await act(async () => root.render(<I18nProvider><ManagedTaskList rootSessionId="ses_root" pendingDispatches={[pending]} /></I18nProvider>));
      expect(count(container, 'data-managed-task-card')).toBe(0);
      await act(async () => ingest(task('dvr_task_late')));
      expect(count(container, 'data-managed-task-card')).toBe(1);
      expect(count(container, 'data-managed-task-id')).toBe(1);
      await act(async () => title('My chosen subtask name'));
      expect(container.textContent).toContain('My chosen subtask name');
      expect(container.textContent).not.toContain('Feedback Chat Greeting');
      await act(async () => root.render(<I18nProvider><ManagedTaskList rootSessionId="ses_root" /></I18nProvider>));
      expect(count(container, 'data-managed-task-id')).toBe(1);
    } finally { await act(async () => root.unmount()); }
  }));

  test('reveals parallel children independently and recovers persisted fallbacks on remount', async () => withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    const fallback: ManagedTaskDispatchFallback = { partId: 'part_saved', taskId: 'dvr_task_saved', dispatchCallId: 'call_saved', agent: 'designer', label: 'Managed designer task', childSessionId: 'ses_saved', directory: '/workspace', status: 'completed' };
    try {
      ingest(task('dvr_task_one'));
      ingest(task('dvr_task_two', { sequence: 2, agent: 'fixer', childSessionId: 'ses_second', dispatchCallId: 'call_two' }));
      await act(async () => root.render(<I18nProvider><ManagedTaskList rootSessionId="ses_root" /></I18nProvider>));
      expect(count(container, 'data-managed-task-card')).toBe(0);
      await act(async () => title('Feedback Chat Greeting and Form'));
      expect(count(container, 'data-managed-task-id')).toBe(1);
      expect(container.textContent).not.toContain('Fixer');
      await act(async () => title('Preserve feedback submission', 'ses_second'));
      expect(count(container, 'data-managed-task-card')).toBe(1);
      expect(count(container, 'data-managed-task-id')).toBe(2);
      await act(async () => {
        title('Saved verified feedback task', 'ses_saved');
        root.render(<I18nProvider><ManagedTaskList taskIds={[fallback.taskId]} fallbackTasks={[fallback]} /></I18nProvider>);
      });
      expect(count(container, 'data-managed-task-fallback-id')).toBe(1);
      expect(container.textContent).toContain('Saved verified feedback task');
      expect(container.textContent).not.toContain('Managed designer task');
    } finally { await act(async () => root.unmount()); }
  }));

  test('shows a rejected start outside a hidden card', async () => withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<I18nProvider><ManagedTaskList taskIds={[]} pendingDispatches={[{ ...pending, status: 'error', errorMessage: 'Write an implementation statement before dispatching.' }]} /></I18nProvider>));
      expect(count(container, 'data-managed-task-card')).toBe(0);
      expect(container.textContent).toContain('Write an implementation statement');
      expect(container.textContent).not.toContain('Managed designer task');
    } finally { await act(async () => root.unmount()); }
  }));

  test('deduplicates a failed child start when pending and authoritative identities overlap', async () => withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    try {
      ingest(task('dvr_task_failed', { childSessionId: null, status: 'failed', failureReason: 'Child creation failed' }));
      await act(async () => root.render(<I18nProvider><ManagedTaskList rootSessionId="ses_root" pendingDispatches={[pending]} /></I18nProvider>));
      expect(count(container, 'data-managed-task-card')).toBe(0);
      expect(count(container, 'data-managed-task-start-error')).toBe(1);
      expect(container.textContent).toContain('Child creation failed');
    } finally { await act(async () => root.unmount()); }
  }));

  test('bounds title recovery, shows exhaustion, and clears the warning when a late title arrives', async () => withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const timers: Array<{ callback: () => void; delay: number }> = [];
    const timerHost: Pick<Window, 'setTimeout' | 'clearTimeout'> = window;
    const schedule = spyOn(timerHost, 'setTimeout').mockImplementation((callback: TimerHandler, delay?: number) => {
      timers.push({ callback: callback as () => void, delay: delay ?? 0 });
      return timers.length;
    });
    const clear = spyOn(window, 'clearTimeout').mockImplementation(() => undefined);
    const root = createRoot(container as unknown as Element);
    try {
      ingest(task('dvr_task_waiting'));
      await act(async () => root.render(<I18nProvider><ManagedTaskList rootSessionId="ses_root" /></I18nProvider>));
      for (const delay of MANAGED_TITLE_RECOVERY_DELAYS) {
        const timer = timers.find((entry) => entry.delay === delay);
        expect(timer).toBeDefined();
        await act(async () => timer?.callback());
      }
      expect(resyncCalls).toBe(3);
      expect(count(container, 'data-managed-task-card')).toBe(0);
      expect(container.textContent).toContain('The subtask title is not available yet');
      expect(container.textContent).toContain('Open Subtask');
      await act(async () => title('Recovered feedback task title'));
      expect(count(container, 'data-managed-task-card')).toBe(1);
      expect(container.textContent).not.toContain('The subtask title is not available yet');
    } finally { await act(async () => root.unmount()); schedule.mockRestore(); clear.mockRestore(); }
  }));

  test('title subscribers ignore unrelated session activity and unchanged title metadata', async () => withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    let renders = 0;
    const Title = () => { renders += 1; return <span>{useManagedTaskTitle(task('dvr_task_title'))}</span>; };
    try {
      title('Feedback Chat Greeting and Form');
      await act(async () => root.render(<Title />));
      const before = renders;
      await act(async () => { title('Other session activity', 'ses_other'); title('Feedback Chat Greeting and Form'); });
      expect(renders).toBe(before);
      await act(async () => title('Renamed feedback task'));
      expect(renders).toBe(before + 1);
    } finally { await act(async () => root.unmount()); }
  }));
});
