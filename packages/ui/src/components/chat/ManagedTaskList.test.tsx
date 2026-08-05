import React from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { fileURLToPath } from 'node:url';
import {
  createManagedTaskRecord,
  createManagedTaskResultEnvelope,
  toManagedTaskEvent,
  type ManagedTaskRecord,
  type ManagedTaskStatus,
} from '@openchamber/orchestration-runtime';

import { I18nProvider } from '@/lib/i18n';
import { dict } from '@/lib/i18n/messages/en';
import { formatAgentLabel } from './mobileControlsUtils';
import {
  resolveManagedTaskDispatch,
  resolveManagedTaskFallbacks,
} from './managedTaskDispatch';
import {
  collapseManagedTaskLineages,
  getManagedTaskWindow,
  shouldRenderManagedTaskList,
} from './managedTaskListWindow';
import { navigateToManagedTaskChild } from './managedTaskNavigation';
import { getSameChildFollowUpTaskId } from './managedTaskRetryLineage';

mock.module('@/components/ui/ProviderLogo', () => ({
  ProviderLogo: ({ providerId }: { providerId: string }) => React.createElement('img', { src: `/logos/${providerId}.svg` }),
}));

const { ManagedTaskRowView } = await import('./ManagedTaskRow');
const { ManagedTaskList, ManagedTaskPreparingRow } = await import('./ManagedTaskList');

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

  test('keeps same-child recovery in the original Agent Dispatch row', () => {
    expect(getSameChildFollowUpTaskId({
      action: 'resume',
      followUpTaskId: 'dvr_task_attempt_2',
    })).toBe('dvr_task_attempt_2');
    expect(getSameChildFollowUpTaskId({
      action: 'retry_in_place',
      followUpTaskId: 'dvr_task_attempt_2',
    })).toBe('dvr_task_attempt_2');
    expect(getSameChildFollowUpTaskId({
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

  test('shows immediate manual recovery for a first provider-limit failure', () => {
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
          childActive
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

    expect(projected.agentRetryAvailable).toBe(false);
    expect(projected.failureKind).toBe('provider_usage_limit');
    expect(html).toContain('GitHub Copilot rate limit reached for GPT 4.1.');
    expect(html).toContain('Error');
    expect(html).toContain('Choose a model to continue this subtask');
    expect(html).toContain('Try Again');
  });

  test('renders independent recovery cards for designer and fixer siblings', () => {
    const tasks = [
      {
        ...terminalTask('failed'),
        taskId: 'dvr_task_designer',
        idempotencyKey: 'designer',
        childSessionId: 'ses_child_designer',
        dispatchGroupId: 'msg_parent',
        agent: 'designer',
        label: 'Implement booking table',
        failureReason: 'Usage limit reached',
      },
      {
        ...terminalTask('failed'),
        taskId: 'dvr_task_fixer_a',
        idempotencyKey: 'fixer-a',
        childSessionId: 'ses_child_fixer_a',
        dispatchGroupId: 'msg_parent',
        sequence: 2,
        agent: 'fixer',
        label: 'Implement query gates',
        attempt: 2,
        priorTaskId: 'dvr_task_fixer_a_initial',
        executionKind: 'resume',
      },
      {
        ...terminalTask('failed'),
        taskId: 'dvr_task_fixer_b',
        idempotencyKey: 'fixer-b',
        childSessionId: 'ses_child_fixer_b',
        dispatchGroupId: 'msg_parent',
        sequence: 3,
        agent: 'fixer',
        label: 'Implement editor RPC',
        attempt: 2,
        priorTaskId: 'dvr_task_fixer_b_initial',
        executionKind: 'resume',
      },
    ] satisfies ManagedTaskRecord[];
    const rows = tasks.map((task, index) => {
      const envelope = createManagedTaskResultEnvelope(task, {
        sequence: index + 1,
        createdAt: 3_000 + index,
        resumable: true,
      });
      return {
        envelope,
        task: toManagedTaskEvent(task, envelope).properties.task,
      };
    });

    const html = renderToStaticMarkup(
      <I18nProvider>
        {rows.map(({ envelope, task }) => (
          <ManagedTaskRowView
            key={task.taskId}
            task={task}
            resultEnvelope={envelope}
            providers={[]}
            onOpenChild={() => undefined}
            onRetryInPlace={() => undefined}
          />
        ))}
      </I18nProvider>,
    );

    expect(rows.every(({ task }) => task.agentRetryAvailable === false)).toBe(true);
    expect(html.match(/Choose a model to continue this subtask/g)).toHaveLength(3);
    expect(html.match(/Try Again/g)).toHaveLength(3);
  });

  test('shows the selected model and thinking after same-child manual recovery', () => {
    const source = {
      ...toManagedTaskEvent({
        ...terminalTask('failed'),
        failureReason: 'Usage limit reached',
      }).properties.task,
      taskId: 'dvr_task_usage_limit',
    };
    const recovery = {
      ...toManagedTaskEvent(terminalTask('completed')).properties.task,
      taskId: 'dvr_task_recovery',
      attempt: 2,
      priorTaskId: source.taskId,
      executionKind: 'retry_in_place' as const,
      providerId: 'openai',
      modelId: 'gpt-5.4',
      variant: 'medium',
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

    expect(html).toContain('Complete');
    expect(html).toContain('Subagent Task Recovered with GPT 5.4 · Medium');
    expect(html).toContain('text-[var(--status-success)]');
    expect(html).not.toContain('Recovering...');
    expect(html).not.toContain('rate limit reached for GPT 4.1. Recovering with');
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
    expect(html).toContain('GitHub Copilot / GPT 4.1');
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

  test('collects fresh-child dispatches while omitting same-child resume and wait controls', () => {
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
      {
        id: 'resume-part',
        type: 'tool',
        tool: 'devryan_task',
        state: {
          input: { action: 'resume' },
          output: JSON.stringify({ followUpTask: { task: { taskId: 'dvr_task_resume' } } }),
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
        callID: 'call_explorer_start',
        state: {
          status: 'pending',
          input: { action: 'start', agent: 'explorer', label: 'inspect-runtime' },
        },
      },
      {
        id: 'designer-start',
        type: 'tool',
        tool: 'devryan_task',
        callID: 'call_designer_start',
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
      { partId: 'explorer-start', dispatchCallId: 'call_explorer_start', agent: 'explorer', label: 'inspect-runtime', status: 'preparing' },
      { partId: 'designer-start', dispatchCallId: 'call_designer_start', agent: 'designer', label: 'review-layout', status: 'preparing' },
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
    const managedTaskListSource = readFileSync(fileURLToPath(new URL('./ManagedTaskList.tsx', import.meta.url)), 'utf8');

    expect(messageListSource).not.toContain('resolveManagedTaskTurnPlacement');
    expect(messageListSource).not.toContain('managedTaskOwnerMessageId');
    expect(messageBodySource).not.toContain('managedTaskProjection');
    expect(messageBodySource).toContain('rootSessionId={sessionId}');
    expect(messageBodySource).toContain('taskIds={managedTaskDispatch.taskIds}');
    expect(messageBodySource).toContain('pendingDispatches={managedTaskDispatch.pendingDispatches}');
    expect(messageBodySource).toContain('fallbackTasks={managedTaskFallbacks}');
    expect(messageBodySource).toContain("shouldRecoverMissingManagedDispatches = streamPhase === 'completed'");
    expect(messageBodySource).toContain('recoverMissingDispatches={shouldRecoverMissingManagedDispatches}');
    expect(messageBodySource).not.toContain('recoverMissingDispatches={isMessageCompleted}');
    expect(managedTaskListSource).toContain('managedOrchestrationSelectors.task(task.taskId)');
    expect(managedTaskListSource).toContain('<ManagedTaskReconciledFallbackRow');
    expect(managedTaskListSource).toContain('managedOrchestrationSelectors.taskIdForDispatchCall');
    expect(managedTaskListSource).toContain('fallbackTasksByDispatchCallId.get(dispatch.dispatchCallId)');
    expect(managedTaskListSource).toContain('loadSnapshot({ rootSessionId })');
  });

  test('surfaces an active managed start before an authoritative task id exists', () => {
    expect(resolveManagedTaskDispatch([{
      id: 'start-part',
      type: 'tool',
      tool: 'devryan_task',
      callID: 'call_start',
      state: {
        status: 'running',
        input: { action: 'start', agent: 'explorer', label: 'workspace-surface_map' },
      },
    }] as never)).toEqual({
      contentParts: [],
      taskIds: [],
      pendingDispatches: [{
        partId: 'start-part',
        dispatchCallId: 'call_start',
        agent: 'explorer',
        label: 'workspace-surface_map',
        status: 'preparing',
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

  test('reconstructs the latest persisted task row from managed tool results after a runtime restart', () => {
    const task = {
      taskId: 'dvr_task_restart',
      dispatchCallId: 'call_restart',
      agent: 'oracle',
      label: 'review-error-precedence-contract',
      status: 'running',
      childSessionId: 'ses_child',
      directory: '/workspace',
    };
    const fallbacks = resolveManagedTaskFallbacks([
      {
        id: 'start-part',
        type: 'tool',
        tool: 'devryan_task',
        state: {
          status: 'completed',
          input: { action: 'start' },
          output: JSON.stringify({ task }),
        },
      },
      {
        id: 'wait-part',
        type: 'tool',
        tool: 'devryan_task',
        state: {
          status: 'completed',
          input: { action: 'wait' },
          output: JSON.stringify({ task: { ...task, status: 'completed' } }),
        },
      },
    ] as never);

    expect(fallbacks).toEqual([{
      partId: 'wait-part',
      taskId: 'dvr_task_restart',
      dispatchCallId: 'call_restart',
      agent: 'oracle',
      label: 'review-error-precedence-contract',
      status: 'completed',
      childSessionId: 'ses_child',
      directory: '/workspace',
    }]);

    const html = renderToStaticMarkup(
      <I18nProvider>
        <ManagedTaskList taskIds={['dvr_task_restart']} fallbackTasks={fallbacks} />
      </I18nProvider>,
    );
    expect(html).toContain('Oracle');
    expect(html).toContain('Review Error Precedence Contract');
    expect(html).toContain('Complete');
    expect(html).toContain('Open Subtask');
  });

  test('keeps a terminal managed start failure visible in the dispatch card', () => {
    expect(resolveManagedTaskDispatch([{
      id: 'start-part',
      type: 'tool',
      tool: 'devryan_task',
      callID: 'call_failed_start',
      state: {
        status: 'error',
        input: { action: 'start', agent: 'explorer', label: 'workspace-surface_map' },
        error: 'bridge offline',
      },
    }] as never)).toEqual({
      contentParts: [],
      taskIds: [],
      pendingDispatches: [{
        partId: 'start-part',
        dispatchCallId: 'call_failed_start',
        agent: 'explorer',
        label: 'workspace-surface_map',
        status: 'error',
        errorMessage: 'bridge offline',
      }],
    });
  });

  test('keeps parallel active starts distinct and in source order', () => {
    expect(resolveManagedTaskDispatch([
      {
        id: 'explorer-start',
        type: 'tool',
        tool: 'devryan_task',
        callID: 'call_parallel_explorer',
        state: {
          status: 'pending',
          input: { action: 'start', agent: 'explorer', label: 'inspect-runtime' },
        },
      },
      {
        id: 'designer-start',
        type: 'tool',
        tool: 'devryan_task',
        callID: 'call_parallel_designer',
        state: {
          status: 'running',
          input: { action: 'start', agent: 'designer', label: 'review-layout' },
        },
      },
    ] as never)).toEqual({
      contentParts: [],
      taskIds: [],
      pendingDispatches: [
        { partId: 'explorer-start', dispatchCallId: 'call_parallel_explorer', agent: 'explorer', label: 'inspect-runtime', status: 'preparing' },
        { partId: 'designer-start', dispatchCallId: 'call_parallel_designer', agent: 'designer', label: 'review-layout', status: 'preparing' },
      ],
    });
  });

  test('renders a provisional dispatch without exposing child navigation', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <ManagedTaskPreparingRow dispatch={{
          partId: 'start-part',
          dispatchCallId: null,
          agent: 'explorer',
          label: 'locate-chat_ui',
          status: 'preparing',
        }} />
      </I18nProvider>,
    );

    expect(html).toContain('Locate Chat UI');
    expect(html).toContain('Preparing...');
    expect(html).not.toContain('Open Subtask');
  });

  test('renders a failed managed start without exposing permission-rule JSON', () => {
    const dispatch = resolveManagedTaskDispatch([{
      id: 'start-part',
      type: 'tool',
      tool: 'devryan_task',
      state: {
        status: 'error',
        input: { action: 'start', agent: 'explorer', label: 'inspect-runtime' },
        error: 'Task could not start. Here are some of the relevant rules [{"permission":"task","action":"deny"}]',
      },
    }] as never).pendingDispatches[0];

    const html = renderToStaticMarkup(
      <I18nProvider>
        <ManagedTaskPreparingRow dispatch={dispatch} />
      </I18nProvider>,
    );

    expect(html).toContain('Could not start this subtask');
    expect(html).toContain('Task could not start.');
    expect(html).not.toContain('relevant rules');
    expect(html).not.toContain('&quot;permission&quot;');
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
    expect(html).toContain('self-start');
    expect(html).toContain('w-auto');
    expect(html).toContain('min-h-[36px]');
    expect(html).toContain('min-w-[36px]');
    expect(html).not.toContain('w-full');
    expect(html).toContain('sm:w-auto');
  });

  test('keeps the mobile dispatch card aligned with the assistant output width and clips its rounded surface', () => {
    const source = readFileSync(fileURLToPath(new URL('./ManagedTaskList.tsx', import.meta.url)), 'utf8');
    const mobileStyles = readFileSync(fileURLToPath(new URL('../../styles/mobile.css', import.meta.url)), 'utf8');

    expect(source).toContain('isMobile?: boolean');
    expect(source).toContain("isMobile ? 'w-full px-0 pb-1 pt-1'");
    expect(source).toContain('data-managed-task-card="true"');
    expect(mobileStyles).toContain('[data-managed-task-card="true"]');
    expect(mobileStyles).toContain('overflow: hidden !important;');
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
