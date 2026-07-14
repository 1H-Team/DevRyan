import React from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { fileURLToPath } from 'node:url';
import {
  createManagedTaskRecord,
  createManagedTaskResultEnvelope,
  toManagedTaskEvent,
  type ManagedTaskStatus,
} from '@openchamber/orchestration-runtime';

import { I18nProvider } from '@/lib/i18n';
import { dict } from '@/lib/i18n/messages/en';
import { formatAgentLabel } from './mobileControlsUtils';
import { resolveManagedTaskDispatch } from './managedTaskDispatch';
import { getManagedTaskWindow, shouldRenderManagedTaskList } from './managedTaskListWindow';
import { navigateToManagedTaskChild } from './managedTaskNavigation';
import { getRetryInPlaceFollowUpTaskId } from './managedTaskRetryLineage';

mock.module('@/components/ui/ProviderLogo', () => ({
  ProviderLogo: ({ providerId }: { providerId: string }) => React.createElement('img', { src: `/logos/${providerId}.svg` }),
}));

const { ManagedTaskRowView } = await import('./ManagedTaskRow');
const { ManagedTaskPreparingRow } = await import('./ManagedTaskList');

const terminalTask = (status: ManagedTaskStatus) => ({
  ...createManagedTaskRecord({
    taskId: `dvr_task_${status}`,
    idempotencyKey: status,
    rootSessionId: 'ses_root',
    parentTaskId: null,
    directory: '/workspace',
    sequence: 1,
    mode: 'orchestrator',
    providerId: 'github-copilot',
    modelId: 'gpt-4.1',
    agent: 'explorer',
    variant: null,
    label: 'Inspect the runtime',
    prompt: 'Inspect it.',
    attempt: 1,
    priorTaskId: null,
    executionKind: 'start',
    createdAt: 1_000,
    timeoutAt: null,
  }),
  status,
  childSessionId: 'ses_child',
  startedAt: 1_100,
  finishedAt: 2_000,
  failureReason: status === 'completed' ? null : 'Provider connection ended',
  partial: status !== 'completed',
  recoverablePreview: status === 'completed' ? 'Finished result' : 'Useful partial result',
});

describe('managed task presentation', () => {
  test('renders Agent Dispatch inside the assistant turn instead of at the root timeline boundary', () => {
    const messageListSource = readFileSync(fileURLToPath(new URL('./MessageList.tsx', import.meta.url)), 'utf8');
    const messageBodySource = readFileSync(fileURLToPath(new URL('./message/MessageBody.tsx', import.meta.url)), 'utf8');

    expect(messageListSource).not.toContain('<ManagedTaskList');
    expect(messageBodySource).toContain('<ManagedTaskList');
  });

  test('uses simplified agent-dispatch copy', () => {
    expect(dict['chat.managedTasks.title']).toBe('Agent Dispatch');
    expect(dict['chat.managedTasks.child.open']).toBe('Open Subtask');
    expect(dict['chat.managedTasks.summary.running']).toBe('Running...');
  });

  test('keeps an in-place retry in the original Agent Dispatch row', () => {
    expect(getRetryInPlaceFollowUpTaskId({
      action: 'retry_in_place',
      followUpTaskId: 'dvr_task_attempt_2',
    })).toBe('dvr_task_attempt_2');
    expect(getRetryInPlaceFollowUpTaskId({
      action: 'retry',
      followUpTaskId: 'dvr_task_fresh_child',
    })).toBeNull();
  });

  test('bounds the initial task DOM while retaining access to older tasks', () => {
    const taskIds = Array.from({ length: 30 }, (_, index) => `dvr_task_${index + 1}`);
    expect(getManagedTaskWindow(taskIds)).toEqual({
      hiddenCount: 6,
      visibleTaskIds: taskIds.slice(6),
    });
    expect(getManagedTaskWindow(taskIds, 48)).toEqual({
      hiddenCount: 0,
      visibleTaskIds: taskIds,
    });
  });

  test('keeps a failed snapshot visible when the runtime was unavailable', () => {
    expect(shouldRenderManagedTaskList({
      available: false,
      taskCount: 0,
      recoveryWarning: null,
      snapshotError: 'bridge offline',
    })).toBe(true);
    expect(shouldRenderManagedTaskList({
      available: false,
      taskCount: 0,
      recoveryWarning: null,
      snapshotError: null,
    })).toBe(false);
  });

  test('renders only the subtask name and open-subtask action', () => {
    const task = terminalTask('failed');
    const envelope = createManagedTaskResultEnvelope(task, {
      sequence: 1,
      createdAt: 2_000,
      resumable: true,
    });
    const projected = toManagedTaskEvent(task, envelope).properties.task;

    const html = renderToStaticMarkup(
      <I18nProvider>
        <ManagedTaskRowView
          task={{ ...projected, label: 'workspace-surface-map' }}
          onOpenChild={() => undefined}
        />
      </I18nProvider>,
    );

    expect(html).not.toContain('explorer');
    expect(html).toContain('Workspace surface map');
    expect(html).toContain('Error');
    expect(html.indexOf('Workspace surface map')).toBeLessThan(html.indexOf('Error'));
    expect(html).toContain('Open Subtask');
    expect(html).toContain('normal-case');
    expect(html).not.toContain('DevRyan · orchestrator');
    expect(html).not.toContain('Completed');
    expect(html).not.toContain('github-copilot/gpt-4.1');
    expect(html).not.toContain('Useful partial result');
    expect(html).not.toContain('Provider connection ended');
    expect(html).not.toContain('saved reference');
    expect(html).not.toContain('Continue');
    expect(html).not.toContain('Cancel');
    expect(html).not.toContain('Retry');
    expect(html).not.toContain('Resume');
    expect(html).not.toContain('Abandon');
  });

  test('does not render manual recovery while the grouped agent retry remains', () => {
    const task = { ...terminalTask('failed'), dispatchGroupId: 'msg_parent' };
    const envelope = createManagedTaskResultEnvelope(task, {
      sequence: 1,
      createdAt: 2_000,
      resumable: true,
    });
    const projected = toManagedTaskEvent(task, envelope).properties.task;

    const html = renderToStaticMarkup(
      <I18nProvider>
        <ManagedTaskRowView
          task={projected}
          resultEnvelope={envelope}
          providers={[]}
          onOpenChild={() => undefined}
          onRetryInPlace={() => undefined}
        />
      </I18nProvider>,
    );

    expect(projected.agentRetryAvailable).toBe(true);
    expect(html).not.toContain('Choose a model to continue this subtask');
    expect(html).not.toContain('Try Again');
  });

  test('expands a final grouped failure with enabled model and thinking controls', () => {
    const task = {
      ...terminalTask('failed'),
      dispatchGroupId: 'msg_parent',
      attempt: 2,
      priorTaskId: 'dvr_task_failed_initial',
      executionKind: 'retry' as const,
    };
    const envelope = createManagedTaskResultEnvelope(task, {
      sequence: 1,
      createdAt: 2_000,
      resumable: true,
    });
    const projected = toManagedTaskEvent(task, envelope).properties.task;

    const html = renderToStaticMarkup(
      <I18nProvider>
        <ManagedTaskRowView
          task={projected}
          resultEnvelope={envelope}
          providers={[{
            id: 'github-copilot',
            name: 'GitHub Copilot',
            models: [{
              id: 'gpt-4.1',
              name: 'GPT 4.1',
              variants: { low: {}, high: {} },
            }],
          }]}
          onOpenChild={() => undefined}
          onRetryInPlace={() => undefined}
        />
      </I18nProvider>,
    );

    expect(html).toContain('Choose a model to continue this subtask');
    expect(html).not.toContain('Provider connection ended');
    expect(html).toContain('github-copilot / gpt-4.1');
    expect(html).toContain('model-controls__model-trigger');
    expect(html).toContain('model-controls__variant-trigger');
    expect(html).not.toContain('disabled=""');
    expect(html).toContain('Try Again');
  });

  test('groups parallel task ids by agent while preserving task order', () => {
    const taskIds = ['dvr_task_1', 'dvr_task_2', 'dvr_task_3'];
    const agentByTaskId: Record<string, string> = {
      dvr_task_1: 'explorer',
      dvr_task_2: 'designer',
      dvr_task_3: 'explorer',
    };

    expect(getManagedTaskWindow(taskIds, 24, (taskId) => agentByTaskId[taskId])).toEqual({
      hiddenCount: 0,
      visibleTaskIds: taskIds,
      agentGroups: [
        { agent: 'explorer', taskIds: ['dvr_task_1', 'dvr_task_3'] },
        { agent: 'designer', taskIds: ['dvr_task_2'] },
      ],
    });
  });

  test('capitalizes the Agent Dispatch heading while preserving its task row', () => {
    const taskIds = ['dvr_task_explorer'];
    const window = getManagedTaskWindow(taskIds, 24, () => 'explorer');
    const source = readFileSync(fileURLToPath(new URL('./ManagedTaskList.tsx', import.meta.url)), 'utf8');

    expect(window.agentGroups).toEqual([{ agent: 'explorer', taskIds }]);
    expect(formatAgentLabel(window.agentGroups?.[0]?.agent ?? '')).toBe('Explorer');
    expect(source).toContain('const agentLabel = formatAgentLabel(group.agent);');
    expect(source).toContain('aria-label={agentLabel}');
    expect(source).toContain('{agentLabel}</span>');
    expect(source).toContain('<ManagedTaskRow key={taskId} taskId={taskId}');
  });

  test('anchors start and retry tasks while omitting wait-only tool calls', () => {
    const parts = [
      {
        id: 'start-part',
        type: 'tool',
        tool: 'devryan_task',
        state: {
          input: { action: 'start' },
          output: JSON.stringify({ task: { taskId: 'dvr_task_start' } }),
        },
      },
      {
        id: 'wait-part',
        type: 'tool',
        tool: 'devryan_task',
        state: {
          input: { action: 'wait' },
          output: JSON.stringify({ task: { taskId: 'dvr_task_start' } }),
        },
      },
      {
        id: 'retry-part',
        type: 'tool',
        tool: 'devryan_task',
        state: {
          input: { action: 'retry' },
          output: JSON.stringify({ followUpTask: { task: { taskId: 'dvr_task_retry' } } }),
        },
      },
    ];

    expect(resolveManagedTaskDispatch(parts as never)).toEqual({
      anchorPartId: 'start-part',
      taskIds: ['dvr_task_start', 'dvr_task_retry'],
      pendingDispatches: [],
    });
  });

  test('surfaces an active managed start before an authoritative task id exists', () => {
    expect(resolveManagedTaskDispatch([{
      id: 'start-part',
      type: 'tool',
      tool: 'devryan_task',
      state: {
        status: 'running',
        input: { action: 'start', agent: 'explorer', label: 'workspace-surface_map' },
      },
    }] as never)).toEqual({
      anchorPartId: 'start-part',
      taskIds: [],
      pendingDispatches: [{
        partId: 'start-part',
        agent: 'explorer',
        label: 'workspace-surface_map',
      }],
    });
  });

  test('replaces provisional dispatch data with the authoritative task id', () => {
    expect(resolveManagedTaskDispatch([{
      id: 'start-part',
      type: 'tool',
      tool: 'devryan_task',
      state: {
        status: 'completed',
        input: { action: 'start', agent: 'explorer', label: 'workspace-surface_map' },
        output: JSON.stringify({ task: { taskId: 'dvr_task_start' } }),
      },
    }] as never)).toEqual({
      anchorPartId: 'start-part',
      taskIds: ['dvr_task_start'],
      pendingDispatches: [],
    });
  });

  test('does not strand a provisional row after a terminal start failure', () => {
    expect(resolveManagedTaskDispatch([{
      id: 'start-part',
      type: 'tool',
      tool: 'devryan_task',
      state: {
        status: 'error',
        input: { action: 'start', agent: 'explorer', label: 'workspace-surface_map' },
        error: 'bridge offline',
      },
    }] as never)).toEqual({
      anchorPartId: null,
      taskIds: [],
      pendingDispatches: [],
    });
  });

  test('keeps parallel active starts distinct and in source order', () => {
    expect(resolveManagedTaskDispatch([
      {
        id: 'explorer-start',
        type: 'tool',
        tool: 'devryan_task',
        state: {
          status: 'pending',
          input: { action: 'start', agent: 'explorer', label: 'inspect-runtime' },
        },
      },
      {
        id: 'designer-start',
        type: 'tool',
        tool: 'devryan_task',
        state: {
          status: 'running',
          input: { action: 'start', agent: 'designer', label: 'review-layout' },
        },
      },
    ] as never)).toEqual({
      anchorPartId: 'explorer-start',
      taskIds: [],
      pendingDispatches: [
        { partId: 'explorer-start', agent: 'explorer', label: 'inspect-runtime' },
        { partId: 'designer-start', agent: 'designer', label: 'review-layout' },
      ],
    });
  });

  test('renders a provisional dispatch without exposing child navigation', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <ManagedTaskPreparingRow dispatch={{
          partId: 'start-part',
          agent: 'explorer',
          label: 'workspace-surface_map',
        }} />
      </I18nProvider>,
    );

    expect(html).toContain('Workspace surface map');
    expect(html).toContain('Preparing...');
    expect(html).not.toContain('Open Subtask');
  });

  test('does not repeat the agent name inside every subtask row', () => {
    const first = toManagedTaskEvent(terminalTask('completed')).properties.task;
    const second = { ...first, taskId: 'dvr_task_completed_2', sequence: 2 };
    const html = renderToStaticMarkup(
      <I18nProvider>
        <div>
          <ManagedTaskRowView task={first} onOpenChild={() => undefined} />
          <ManagedTaskRowView task={second} onOpenChild={() => undefined} />
        </div>
      </I18nProvider>,
    );

    expect(html).not.toContain('explorer');
  });

  test('omits the open-subtask action until a child session exists', () => {
    const task = {
      ...toManagedTaskEvent(terminalTask('running')).properties.task,
      childSessionId: null,
    };

    const html = renderToStaticMarkup(
      <I18nProvider>
        <ManagedTaskRowView task={task} onOpenChild={() => undefined} />
      </I18nProvider>,
    );

    expect(html).toContain('Inspect the runtime');
    expect(html).toContain('Running');
    expect(html).not.toContain('Open Subtask');
  });

  test('shows complete beneath a completed subtask name', () => {
    const task = toManagedTaskEvent(terminalTask('completed')).properties.task;
    const html = renderToStaticMarkup(
      <I18nProvider>
        <ManagedTaskRowView task={task} onOpenChild={() => undefined} />
      </I18nProvider>,
    );

    expect(html).toContain('Complete');
    expect(html.indexOf('Inspect the runtime')).toBeLessThan(html.indexOf('Complete'));
  });

  test('humanizes running names and keeps the open action primary blue', () => {
    const task = {
      ...toManagedTaskEvent(terminalTask('running')).properties.task,
      label: 'workspace-surface_map',
    };
    const html = renderToStaticMarkup(
      <I18nProvider>
        <ManagedTaskRowView task={task} onOpenChild={() => undefined} />
      </I18nProvider>,
    );

    expect(html).toContain('Workspace surface map');
    expect(html).toContain('Running...');
    expect(html).toContain('text-[var(--primary-base)]');
    expect(html).toContain('hover:text-[var(--primary-base)]');
  });

  test('stacks the open-subtask action when the task card is narrow', () => {
    const task = toManagedTaskEvent(terminalTask('running')).properties.task;
    const html = renderToStaticMarkup(
      <I18nProvider>
        <ManagedTaskRowView task={task} onOpenChild={() => undefined} />
      </I18nProvider>,
    );

    expect(html).toContain('flex-col');
    expect(html).toContain('sm:flex-row');
    expect(html).toContain('w-full');
    expect(html).toContain('sm:w-auto');
  });

  test('centers the agent icon and name within a fixed-height header', () => {
    const source = readFileSync(fileURLToPath(new URL('./ManagedTaskList.tsx', import.meta.url)), 'utf8');

    expect(source).toContain('flex h-7 items-center');
    expect(source).toContain('inline-flex min-w-0 items-center gap-1.5 leading-none');
    expect(source).not.toContain('bg-muted/25 px-3 py-1.5');
  });

  test('navigates to the canonical child session with its directory hint', () => {
    const task = toManagedTaskEvent(terminalTask('failed')).properties.task;
    const navigations: Array<[string, string]> = [];

    expect(navigateToManagedTaskChild(task, (sessionId, directory) => {
      navigations.push([sessionId, directory]);
    })).toBe(true);
    expect(navigations).toEqual([['ses_child', '/workspace']]);

    expect(navigateToManagedTaskChild({ ...task, childSessionId: null }, () => {
      throw new Error('must not navigate');
    })).toBe(false);
  });
});
