import React from 'react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createManagedTaskRecord, toManagedTaskEvent } from '@devryan/orchestration-runtime';

import { I18nProvider } from '@/lib/i18n';
import { useManagedOrchestrationStore } from '@/stores/useManagedOrchestrationStore';
import { managedTitleFixture, renderManagedTaskMarkup } from './managedTaskTestFixture';

const syncModule = { ...(await import('@/sync/sync-context')) };
mock.module('@/sync/sync-context', () => ({
  ...syncModule,
  useDirectoryStore: () => managedTitleFixture,
  useSessionStatus: () => undefined,
  useSyncResyncSession: () => async () => undefined,
  setActiveSession: () => undefined,
}));

mock.module('@/components/ui/ProviderLogo', () => ({
  ProviderLogo: ({ providerId }: { providerId: string }) => React.createElement('img', { src: `/logos/${providerId}.svg` }),
}));

const { ManagedTaskCompactionContinuity } = await import('./ManagedTaskCompactionContinuity');

const ROOT = 'ses_root';

const runningTask = (taskId: string, createdAt: number) => toManagedTaskEvent({
  ...createManagedTaskRecord({
    taskId,
    idempotencyKey: taskId,
    rootSessionId: ROOT,
    parentTaskId: null,
    directory: '/workspace',
    sequence: createdAt,
    mode: 'orchestrator',
    providerId: 'provider',
    modelId: 'model',
    agent: 'explorer',
    variant: null,
    label: 'inspect-runtime',
    prompt: 'Inspect.',
    attempt: 1,
    priorTaskId: null,
    executionKind: 'start',
    createdAt,
    timeoutAt: null,
  }),
  status: 'running',
  childSessionId: 'ses_child',
  startedAt: createdAt,
  finishedAt: null,
  partial: false,
}).properties.task;

const seed = (createdAt: number) => {
  const task = runningTask('dvr_task_carry', createdAt);
  useManagedOrchestrationStore.setState({
    tasksById: { [task.taskId]: task },
    taskIdsByRootId: { [ROOT]: [task.taskId] },
    resultEnvelopesByTaskId: {},
  });
};

const render = (props: { boundaryAt: number | null; isMobile?: boolean }) => renderManagedTaskMarkup(
  <I18nProvider>
    <ManagedTaskCompactionContinuity
      rootSessionId={ROOT}
      compactionBoundaryAt={props.boundaryAt}
      isMobile={props.isMobile ?? false}
      onContentChange={() => undefined}
    />
  </I18nProvider>,
);

afterEach(() => {
  useManagedOrchestrationStore.setState({ tasksById: {}, taskIdsByRootId: {}, resultEnvelopesByTaskId: {} });
});

describe('ManagedTaskCompactionContinuity rendering', () => {
  test('renders the pre-compaction running task inside the compaction continuity wrapper', async () => {
    seed(1_000);
    const html = await render({ boundaryAt: 2_000 });

    expect(html).toContain('data-managed-task-continuity="compaction"');
    expect(html).toContain('data-managed-task-card="true"');
    expect(html).toContain('data-managed-task-id="dvr_task_carry"');
  });

  test('renders nothing when no task needs carrying over', async () => {
    seed(2_100);
    const html = await render({ boundaryAt: 2_000 });

    expect(html).not.toContain('data-managed-task-continuity');
    expect(html).not.toContain('data-managed-task-card');
  });

  test('aligns the wrapper with the mobile message column only on mobile', async () => {
    seed(1_000);
    expect(await render({ boundaryAt: 2_000, isMobile: true })).toContain('data-managed-task-continuity="compaction" class="chat-message-column"');
    expect(await render({ boundaryAt: 2_000, isMobile: false })).toContain('data-managed-task-continuity="compaction" class=""');
  });
});
