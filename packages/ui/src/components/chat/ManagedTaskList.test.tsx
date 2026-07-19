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
import {
  collapseManagedTaskLineages,
  getManagedTaskWindow,
  shouldRenderManagedTaskList,
} from './managedTaskListWindow';
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
    const renderedPartsIndex = messageBodySource.lastIndexOf('{renderedParts}');
    const footerIndex = messageBodySource.lastIndexOf('{shouldShowTurnFooter');
    const managedTaskListIndex = messageBodySource.lastIndexOf('<ManagedTaskList');

    expect(messageListSource).not.toContain('<ManagedTaskList');
    expect(messageBodySource).toContain('<ManagedTaskList');
    expect(managedTaskListIndex).toBeGreaterThan(renderedPartsIndex);
    expect(managedTaskListIndex).toBeGreaterThan(footerIndex);
  });

  test('keeps the final dispatch projection independent of reasoning visibility', () => {
    const messageBodySource = readFileSync(fileURLToPath(new URL('./message/MessageBody.tsx', import.meta.url)), 'utf8');
    const tailSource = messageBodySource.slice(messageBodySource.lastIndexOf('{shouldShowTurnFooter'));

    expect(tailSource).toContain('<ManagedTaskList');
    expect(tailSource).not.toContain('showReasoningTraces');
  });

  test('uses simplified agent-dispatch copy', () => {
    expect(dict['chat.managedTasks.title']).toBe('Agent Dispatch');
    expect(dict['chat.managedTasks.child.open']).toBe('Open Subtask');
    expect(dict['chat.managedTasks.summary.queued']).toBe('Queued...');
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
    expect(html).toContain('Workspace Surface Map');
    expect(html).toContain('Error');
    expect(html.indexOf('Workspace Surface Map')).toBeLessThan(html.indexOf('Error'));
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

  test('shows a resumed child as running instead of the stale terminal error', () => {
    const task = terminalTask('failed');
    const projected = toManagedTaskEvent(task).properties.task;

    const html = renderToStaticMarkup(
      <I18nProvider>
        <ManagedTaskRowView
          task={projected}
          childActive
          onOpenChild={() => undefined}
        />
      </I18nProvider>,
    );

    expect(html).toContain('Running');
    expect(html).not.toContain('Error');
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

  test('shows a provider-limit explanation while automatic recovery remains available', () => {
    const task = {
      ...terminalTask('failed'),
      dispatchGroupId: 'msg_parent',
      failureReason: 'Usage limit reached',
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

    expect(projected.agentRetryAvailable).toBe(true);
    expect(projected.failureKind).toBe('provider_usage_limit');
    expect(html).toContain('GitHub Copilot rate limit reached for GPT 4.1.');
    expect(html).not.toContain('Choose a model to continue this subtask');
    expect(html).not.toContain('Try Again');
  });

  test('shows same-child recovery with the replacement model in one row', () => {
    const source = {
      ...toManagedTaskEvent({
        ...terminalTask('failed'),
        failureReason: 'Usage limit reached',
      }).properties.task,
      taskId: 'dvr_task_usage_limit',
    };
    const recovery = {
      ...toManagedTaskEvent(terminalTask('running')).properties.task,
      taskId: 'dvr_task_recovery',
      attempt: 2,
      priorTaskId: source.taskId,
      executionKind: 'recover_in_place' as const,
      providerId: 'openai',
      modelId: 'gpt-5.4',
    };

    const html = renderToStaticMarkup(
      <I18nProvider>
        <ManagedTaskRowView
          task={recovery}
          recoverySourceTask={source}
          providers={[
            { id: 'github-copilot', name: 'GitHub Copilot', models: [{ id: 'gpt-4.1', name: 'GPT 4.1' }] },
            { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-5.4', name: 'GPT 5.4' }] },
          ]}
          onOpenChild={() => undefined}
        />
      </I18nProvider>,
    );

    expect(html).toContain('Recovering...');
    expect(html).toContain('GitHub Copilot rate limit reached for GPT 4.1. Recovering with OpenAI / GPT 5.4');
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

  test('collapses same-child recovery attempts to one logical dispatch row', () => {
    const taskById = {
      dvr_task_1: toManagedTaskEvent(terminalTask('failed')).properties.task,
      dvr_task_2: {
        ...toManagedTaskEvent(terminalTask('running')).properties.task,
        taskId: 'dvr_task_2',
        priorTaskId: 'dvr_task_1',
        executionKind: 'recover_in_place' as const,
      },
    };

    expect(collapseManagedTaskLineages(
      ['dvr_task_1', 'dvr_task_2'],
      (taskId) => taskById[taskId as keyof typeof taskById],
    )).toEqual(['dvr_task_2']);
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

  test('collects start and retry tasks while omitting wait-only tool calls', () => {
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
      contentParts: [],
      taskIds: ['dvr_task_start', 'dvr_task_retry'],
      pendingDispatches: [],
    });
  });

  test('suppresses reasoning from managed control-only polling messages', () => {
    const visibleText = {
      id: 'explicit-text',
      type: 'text',
      text: 'Explicit parent narration remains visible.',
    };
    const presentation = resolveManagedTaskDispatch([
      {
        id: 'wait-reasoning',
        type: 'reasoning',
        text: 'Deciding how to wait again.',
      },
      visibleText,
      {
        id: 'wait-part',
        type: 'tool',
        tool: 'devryan_task',
        state: {
          status: 'completed',
          input: { action: 'wait', task_id: 'dvr_task_explorer' },
          output: JSON.stringify({ task: { taskId: 'dvr_task_explorer', status: 'running' } }),
        },
      },
    ] as never);

    expect(presentation).toEqual({
      contentParts: [visibleText],
      taskIds: [],
      pendingDispatches: [],
    });
  });

  test('preserves reasoning when a managed control shares a message with ordinary tool work', () => {
    const reasoning = {
      id: 'mixed-reasoning',
      type: 'reasoning',
      text: 'Inspecting after the wait.',
    };
    const readTool = {
      id: 'read-part',
      type: 'tool',
      tool: 'read',
      state: { status: 'completed', input: { filePath: '/workspace/file.ts' } },
    };
    const presentation = resolveManagedTaskDispatch([
      reasoning,
      {
        id: 'wait-part',
        type: 'tool',
        tool: 'devryan_task',
        state: { status: 'completed', input: { action: 'wait' } },
      },
      readTool,
    ] as never);

    expect(presentation.contentParts).toEqual([reasoning, readTool]);
  });

  test('preserves narration around parallel dispatches while removing every raw managed tool part', () => {
    const reasoningBefore = {
      id: 'reasoning-before',
      type: 'reasoning',
      text: 'Preparing two independent investigations.',
    };
    const reasoningAfter = {
      id: 'reasoning-after',
      type: 'reasoning',
      text: 'Considering parallel barrier waits',
    };
    const presentation = resolveManagedTaskDispatch([
      reasoningBefore,
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
      reasoningAfter,
      {
        id: 'wait-part',
        type: 'tool',
        tool: 'devryan_task',
        state: {
          status: 'running',
          input: { action: 'wait', taskIds: ['dvr_task_explorer', 'dvr_task_designer'] },
        },
      },
    ] as never);

    expect(presentation.contentParts).toEqual([reasoningBefore, reasoningAfter]);
    expect(presentation.pendingDispatches).toEqual([
      { partId: 'explorer-start', agent: 'explorer', label: 'inspect-runtime' },
      { partId: 'designer-start', agent: 'designer', label: 'review-layout' },
    ]);
  });

  test('keeps sequential dispatches scoped to their invoking messages', () => {
    const explorerDispatch = resolveManagedTaskDispatch([{
      id: 'explorer-start',
      type: 'tool',
      tool: 'devryan_task',
      state: {
        status: 'completed',
        input: { action: 'start', agent: 'explorer', label: 'inspect-runtime' },
        output: JSON.stringify({ task: { taskId: 'dvr_task_explorer' } }),
      },
    }] as never);
    const waitMessage = resolveManagedTaskDispatch([{
      id: 'wait-part',
      type: 'tool',
      tool: 'devryan_task',
      state: {
        status: 'completed',
        input: { action: 'wait', task_id: 'dvr_task_explorer' },
        output: JSON.stringify({ task: { taskId: 'dvr_task_explorer', status: 'completed' } }),
      },
    }] as never);
    const designerDispatch = resolveManagedTaskDispatch([{
      id: 'designer-start',
      type: 'tool',
      tool: 'devryan_task',
      state: {
        status: 'completed',
        input: { action: 'start', agent: 'designer', label: 'review-layout' },
        output: JSON.stringify({ task: { taskId: 'dvr_task_designer' } }),
      },
    }] as never);

    expect(explorerDispatch.taskIds).toEqual(['dvr_task_explorer']);
    expect(waitMessage.taskIds).toEqual([]);
    expect(waitMessage.pendingDispatches).toEqual([]);
    expect(designerDispatch.taskIds).toEqual(['dvr_task_designer']);
  });

  test('renders each Agent Dispatch from its message-local projection', () => {
    const messageListSource = readFileSync(fileURLToPath(new URL('./MessageList.tsx', import.meta.url)), 'utf8');
    const messageBodySource = readFileSync(fileURLToPath(new URL('./message/MessageBody.tsx', import.meta.url)), 'utf8');

    expect(messageListSource).not.toContain('resolveManagedTaskTurnPlacement');
    expect(messageListSource).not.toContain('managedTaskOwnerMessageId');
    expect(messageBodySource).not.toContain('managedTaskProjection');
    expect(messageBodySource).toContain('taskIds={managedTaskDispatch.taskIds}');
    expect(messageBodySource).toContain('pendingDispatches={managedTaskDispatch.pendingDispatches}');
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
      contentParts: [],
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
      contentParts: [],
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
      contentParts: [],
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
      contentParts: [],
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
          label: 'locate-chat_ui',
        }} />
      </I18nProvider>,
    );

    expect(html).toContain('Locate Chat UI');
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

    expect(html).toContain('Inspect the Runtime');
    expect(html).toContain('Running');
    expect(html).not.toContain('Open Subtask');
  });

  test('shows queued truthfully and enables Open Subtask when the canonical child arrives', () => {
    const queued = {
      ...toManagedTaskEvent(terminalTask('running')).properties.task,
      status: 'queued' as const,
      childSessionId: null,
      startedAt: null,
    };
    const startingWithChild = {
      ...queued,
      status: 'starting' as const,
      childSessionId: 'ses_child_materialized',
      startedAt: 1_100,
    };

    const queuedHtml = renderToStaticMarkup(
      <I18nProvider>
        <ManagedTaskRowView task={queued} onOpenChild={() => undefined} />
      </I18nProvider>,
    );
    const startingHtml = renderToStaticMarkup(
      <I18nProvider>
        <ManagedTaskRowView task={startingWithChild} onOpenChild={() => undefined} />
      </I18nProvider>,
    );

    expect(queuedHtml).toContain('Queued...');
    expect(queuedHtml).not.toContain('Open Subtask');
    expect(startingHtml).toContain('Preparing...');
    expect(startingHtml).toContain('Open Subtask');
  });

  test('shows complete beneath a completed subtask name', () => {
    const task = toManagedTaskEvent(terminalTask('completed')).properties.task;
    const html = renderToStaticMarkup(
      <I18nProvider>
        <ManagedTaskRowView task={task} onOpenChild={() => undefined} />
      </I18nProvider>,
    );

    expect(html).toContain('Complete');
    expect(html.indexOf('Inspect the Runtime')).toBeLessThan(html.indexOf('Complete'));
  });

  test('humanizes running names and keeps the open action primary blue', () => {
    const task = {
      ...toManagedTaskEvent(terminalTask('running')).properties.task,
      label: 'locate-chat_ui',
    };
    const html = renderToStaticMarkup(
      <I18nProvider>
        <ManagedTaskRowView task={task} onOpenChild={() => undefined} />
      </I18nProvider>,
    );

    expect(html).toContain('Locate Chat UI');
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

  test('optically centers the agent icon and name within a fixed-height header', () => {
    const source = readFileSync(fileURLToPath(new URL('./ManagedTaskList.tsx', import.meta.url)), 'utf8');

    expect(source).toContain('flex h-7 items-center');
    expect(source).toContain('inline-flex min-w-0 translate-y-1 items-center gap-1.5 leading-none');
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
