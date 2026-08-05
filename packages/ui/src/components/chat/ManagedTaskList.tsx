import React from 'react';
import { RiAiAgentLine, RiExternalLinkLine, RiGitBranchLine, RiRefreshLine } from '@remixicon/react';
import { formatManagedTaskDisplayName } from '@openchamber/orchestration-runtime';

import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { getAgentIconColor } from '@/lib/agentColors';
import { cn } from '@/lib/utils';
import {
  managedOrchestrationSelectors,
  useManagedOrchestrationStore,
} from '@/stores/useManagedOrchestrationStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { ManagedTaskRow } from './ManagedTaskRow';
import type {
  ManagedTaskDispatchFallback,
  PendingManagedTaskDispatch,
} from './managedTaskDispatch';
import { formatAgentLabel } from './mobileControlsUtils';
import {
  collapseManagedTaskLineages,
  getManagedTaskWindow,
  MANAGED_TASK_ROW_BATCH,
  shouldRenderManagedTaskList,
} from './managedTaskListWindow';

const EMPTY_PENDING_DISPATCHES: readonly PendingManagedTaskDispatch[] = [];
const EMPTY_FALLBACK_TASKS: readonly ManagedTaskDispatchFallback[] = [];
const MISSING_DISPATCH_RECOVERY_DELAY_MS = 500;

export const ManagedTaskPreparingRow = React.memo(({
  dispatch,
}: {
  dispatch: PendingManagedTaskDispatch;
}) => {
  const { t } = useI18n();
  return (
    <article data-managed-task-pending-id={dispatch.partId}>
      <div className="flex min-w-0 items-center gap-3 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <h4 className="line-clamp-2 break-words typography-ui-label font-medium text-foreground sm:line-clamp-1">
            {formatManagedTaskDisplayName(dispatch.label)}
          </h4>
          <p
            role={dispatch.status === 'error' ? 'alert' : 'status'}
            className={cn(
              'typography-meta',
              dispatch.status === 'error'
                ? 'text-[var(--status-error)]'
                : 'truncate text-muted-foreground',
            )}
          >
            {dispatch.status === 'error'
              ? t('chat.managedTasks.summary.startError')
              : t('chat.managedTasks.summary.preparing')}
          </p>
          {dispatch.status === 'error' && dispatch.errorMessage ? (
            <p className="mt-1 line-clamp-2 break-words typography-micro text-muted-foreground">
              {dispatch.errorMessage}
            </p>
          ) : null}
        </div>
      </div>
    </article>
  );
});

ManagedTaskPreparingRow.displayName = 'ManagedTaskPreparingRow';

const ManagedTaskFallbackRow = React.memo(({
  task,
}: {
  task: ManagedTaskDispatchFallback;
}) => {
  const { t } = useI18n();
  const status = task.status === 'completed'
    ? { label: t('chat.managedTasks.summary.complete'), className: 'text-[var(--status-success)]' }
    : task.status === 'failed' || task.status === 'aborted' || task.status === 'interrupted'
      ? { label: t('chat.managedTasks.summary.error'), className: 'text-[var(--status-error)]' }
      : task.status === 'queued'
        ? { label: t('chat.managedTasks.summary.queued'), className: 'text-muted-foreground' }
        : task.status === 'starting'
          ? { label: t('chat.managedTasks.summary.preparing'), className: 'text-muted-foreground' }
          : { label: t('chat.managedTasks.summary.running'), className: 'text-muted-foreground' };
  return (
    <article data-managed-task-fallback-id={task.taskId}>
      <div className="flex min-w-0 flex-col items-start gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3">
        <div className="min-w-0 flex-1">
          <h4 className="line-clamp-2 break-words typography-ui-label font-medium text-foreground sm:line-clamp-1">
            {formatManagedTaskDisplayName(task.label)}
          </h4>
          <p className={`truncate typography-meta ${status.className}`}>{status.label}</p>
        </div>
        {task.childSessionId ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="self-start w-auto min-h-[36px] min-w-[36px] gap-1 px-1 normal-case text-[var(--primary-base)] hover:text-[var(--primary-base)] sm:self-auto sm:w-auto sm:min-h-9 sm:min-w-9 sm:px-1.5"
            onClick={() => useSessionUIStore.getState().setCurrentSession(
              task.childSessionId,
              task.directory,
            )}
          >
            <RiExternalLinkLine className="hidden size-3 sm:block" />
            {t('chat.managedTasks.child.open')}
          </Button>
        ) : null}
      </div>
    </article>
  );
});

ManagedTaskFallbackRow.displayName = 'ManagedTaskFallbackRow';

const ManagedTaskReconciledFallbackRow = React.memo(({
  rootSessionId,
  task,
  onContentChange,
}: {
  rootSessionId?: string;
  task: ManagedTaskDispatchFallback;
  onContentChange?: () => void;
}) => {
  const authoritativeTask = useManagedOrchestrationStore(React.useMemo(
    () => managedOrchestrationSelectors.task(task.taskId),
    [task.taskId],
  ));
  const recoveryRequestedRef = React.useRef(false);

  React.useEffect(() => {
    if (!rootSessionId || authoritativeTask || recoveryRequestedRef.current) return;

    const timer = window.setTimeout(() => {
      recoveryRequestedRef.current = true;
      void useManagedOrchestrationStore.getState().loadSnapshot({ rootSessionId });
    }, MISSING_DISPATCH_RECOVERY_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [authoritativeTask, rootSessionId]);

  if (authoritativeTask) {
    return <ManagedTaskRow taskId={task.taskId} onContentChange={onContentChange} />;
  }
  return <ManagedTaskFallbackRow task={task} />;
});

ManagedTaskReconciledFallbackRow.displayName = 'ManagedTaskReconciledFallbackRow';

const ManagedTaskReconciledPendingRow = React.memo(({
  rootSessionId,
  dispatch,
  fallbackTask,
  recoverMissingDispatch,
  onContentChange,
}: {
  rootSessionId?: string;
  dispatch: PendingManagedTaskDispatch;
  fallbackTask?: ManagedTaskDispatchFallback;
  recoverMissingDispatch: boolean;
  onContentChange?: () => void;
}) => {
  const taskId = useManagedOrchestrationStore(React.useMemo(
    () => managedOrchestrationSelectors.taskIdForDispatchCall(
      rootSessionId ?? '',
      dispatch.dispatchCallId ?? '',
    ),
    [dispatch.dispatchCallId, rootSessionId],
  ));
  const recoveryRequestedRef = React.useRef(false);

  React.useEffect(() => {
    if (
      !recoverMissingDispatch
      || !rootSessionId
      || !dispatch.dispatchCallId
      || taskId
      || fallbackTask
      || recoveryRequestedRef.current
    ) return;

    const timer = window.setTimeout(() => {
      recoveryRequestedRef.current = true;
      void useManagedOrchestrationStore.getState().loadSnapshot({ rootSessionId });
    }, MISSING_DISPATCH_RECOVERY_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [
    dispatch.dispatchCallId,
    fallbackTask,
    recoverMissingDispatch,
    rootSessionId,
    taskId,
  ]);

  if (taskId) {
    return <ManagedTaskRow taskId={taskId} onContentChange={onContentChange} />;
  }
  if (fallbackTask) {
    return (
      <ManagedTaskReconciledFallbackRow
        rootSessionId={rootSessionId}
        task={fallbackTask}
        onContentChange={onContentChange}
      />
    );
  }
  return <ManagedTaskPreparingRow dispatch={dispatch} />;
});

ManagedTaskReconciledPendingRow.displayName = 'ManagedTaskReconciledPendingRow';

export const ManagedTaskList = React.memo(({
  rootSessionId,
  taskIds: explicitTaskIds,
  pendingDispatches = EMPTY_PENDING_DISPATCHES,
  fallbackTasks = EMPTY_FALLBACK_TASKS,
  recoverMissingDispatches = false,
  onContentChange,
  isMobile = false,
}: {
  rootSessionId?: string;
  taskIds?: readonly string[];
  pendingDispatches?: readonly PendingManagedTaskDispatch[];
  fallbackTasks?: readonly ManagedTaskDispatchFallback[];
  recoverMissingDispatches?: boolean;
  onContentChange?: () => void;
  isMobile?: boolean;
}) => {
  const { t } = useI18n();
  const usesRootTaskIds = explicitTaskIds === undefined;
  const rootTaskIds = useManagedOrchestrationStore(React.useMemo(
    () => managedOrchestrationSelectors.taskIdsForRoot(
      usesRootTaskIds ? rootSessionId ?? '' : '',
    ),
    [rootSessionId, usesRootTaskIds],
  ));
  const taskIds = explicitTaskIds ?? rootTaskIds;
  const visibleTaskIds = React.useMemo(
    () => collapseManagedTaskLineages(
      taskIds,
      (taskId) => useManagedOrchestrationStore.getState().tasksById[taskId],
    ),
    [taskIds],
  );
  const fallbackTasksById = React.useMemo(
    () => new Map(fallbackTasks.map((task) => [task.taskId, task])),
    [fallbackTasks],
  );
  const fallbackTasksByDispatchCallId = React.useMemo(() => {
    const tasksByCallId = new Map<string, ManagedTaskDispatchFallback>();
    for (const task of fallbackTasks) {
      if (task.dispatchCallId) tasksByCallId.set(task.dispatchCallId, task);
    }
    return tasksByCallId;
  }, [fallbackTasks]);
  const available = useManagedOrchestrationStore((state) => state.available);
  const recoveryWarning = useManagedOrchestrationStore((state) => state.recoveryWarning);
  const snapshotError = useManagedOrchestrationStore((state) => state.snapshotError);
  const [visibility, setVisibility] = React.useState(() => ({
    rootSessionId,
    limit: MANAGED_TASK_ROW_BATCH,
  }));
  const visibleLimit = visibility.rootSessionId === rootSessionId
    ? visibility.limit
    : MANAGED_TASK_ROW_BATCH;

  const { hiddenCount, agentGroups = [] } = getManagedTaskWindow(
    visibleTaskIds,
    visibleLimit,
    (taskId) => useManagedOrchestrationStore.getState().tasksById[taskId]?.agent,
  );
  const displayGroups = React.useMemo(() => {
    const groups = new Map<string, {
      agent: string;
      taskIds: string[];
      fallbackTasks: ManagedTaskDispatchFallback[];
      pendingDispatches: PendingManagedTaskDispatch[];
    }>();

    for (const group of agentGroups) {
      groups.set(group.agent.toLocaleLowerCase(), {
        agent: group.agent,
        taskIds: group.taskIds,
        fallbackTasks: [],
        pendingDispatches: [],
      });
    }

    for (const taskId of visibleTaskIds) {
      if (useManagedOrchestrationStore.getState().tasksById[taskId]) continue;
      const fallback = fallbackTasksById.get(taskId);
      if (!fallback) continue;
      const key = fallback.agent.toLocaleLowerCase();
      const existing = groups.get(key);
      if (existing) {
        existing.fallbackTasks.push(fallback);
      } else {
        groups.set(key, {
          agent: fallback.agent,
          taskIds: [],
          fallbackTasks: [fallback],
          pendingDispatches: [],
        });
      }
    }

    for (const dispatch of pendingDispatches) {
      const key = dispatch.agent.toLocaleLowerCase();
      const existing = groups.get(key);
      if (existing) {
        existing.pendingDispatches.push(dispatch);
      } else {
        groups.set(key, {
          agent: dispatch.agent,
          taskIds: [],
          fallbackTasks: [],
          pendingDispatches: [dispatch],
        });
      }
    }

    return Array.from(groups.values());
  }, [agentGroups, fallbackTasksById, pendingDispatches, visibleTaskIds]);
  const showRuntimeWarnings = rootSessionId !== undefined && explicitTaskIds === undefined;

  React.useLayoutEffect(() => {
    if (visibleTaskIds.length > 0 || pendingDispatches.length > 0 || recoveryWarning || snapshotError) {
      onContentChange?.();
    }
  }, [onContentChange, pendingDispatches, recoveryWarning, snapshotError, visibleTaskIds, visibleLimit]);

  if (!shouldRenderManagedTaskList({
    available,
    taskCount: visibleTaskIds.length + pendingDispatches.length,
    recoveryWarning: showRuntimeWarnings ? recoveryWarning : null,
    snapshotError: showRuntimeWarnings ? snapshotError : null,
  })) return null;
  return (
    <section
      aria-label={t('chat.managedTasks.title')}
      className={cn(
        isMobile ? 'w-full px-0 pb-1 pt-1' : 'chat-message-column px-4 pb-2 pt-3',
      )}
    >
      <div data-managed-task-card="true" className="overflow-hidden rounded-xl border border-[color-mix(in_srgb,var(--primary-base)_16%,var(--border))] bg-[color-mix(in_srgb,var(--primary-base)_3%,var(--surface-background))]">
        <header className="flex items-center gap-2 border-b border-border/70 px-3 py-2">
          <RiGitBranchLine className="size-3.5 text-[var(--primary-base)]" aria-hidden="true" />
          <h3 className="typography-ui-label font-semibold text-foreground">
            {t('chat.managedTasks.title')}
          </h3>
        </header>
        {showRuntimeWarnings && recoveryWarning ? (
          <p role="alert" className="border-b border-border/70 px-3 py-2 typography-micro text-[var(--status-warning)]">
            {t('chat.managedTasks.recoveryWarning', { message: recoveryWarning })}
          </p>
        ) : null}
        {showRuntimeWarnings && snapshotError ? (
          <div className="flex items-center gap-2 border-b border-border/70 px-3 py-2">
            <p role="alert" className="min-w-0 flex-1 typography-micro text-[var(--status-error)]">
              {t('chat.managedTasks.snapshotError', { message: snapshotError })}
            </p>
            <Button
              type="button"
              size="xs"
              variant="neutral"
              onClick={() => void useManagedOrchestrationStore.getState().loadSnapshot()}
            >
              <RiRefreshLine className="size-3" />
              {t('chat.managedTasks.snapshotRetry')}
            </Button>
          </div>
        ) : null}
        {hiddenCount > 0 ? (
          <div className="border-b border-border/70 px-3 py-1.5">
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => setVisibility({
                rootSessionId,
                limit: visibleLimit + MANAGED_TASK_ROW_BATCH,
              })}
            >
              {t('chat.managedTasks.showOlder', { count: Math.min(hiddenCount, MANAGED_TASK_ROW_BATCH) })}
            </Button>
          </div>
        ) : null}
        <div className="divide-y divide-border/70">
          {displayGroups.map((group) => {
            const agentLabel = formatAgentLabel(group.agent);
            return (
              <section key={group.agent.toLocaleLowerCase()} aria-label={agentLabel}>
                <div className="flex h-7 items-center bg-muted/25 px-3 typography-meta text-muted-foreground">
                  <span className="inline-flex min-w-0 translate-y-1 items-center gap-1.5 leading-none">
                    <RiAiAgentLine
                      className="size-3.5 shrink-0"
                      style={{ color: `var(${getAgentIconColor(group.agent).var})` }}
                      aria-hidden="true"
                    />
                    <span className="truncate">{agentLabel}</span>
                  </span>
                </div>
                <div className="divide-y divide-border/60">
                  {group.taskIds.map((taskId) => (
                    <ManagedTaskRow key={taskId} taskId={taskId} onContentChange={onContentChange} />
                  ))}
                  {group.fallbackTasks.map((task) => (
                    <ManagedTaskReconciledFallbackRow
                      key={task.taskId}
                      rootSessionId={rootSessionId}
                      task={task}
                      onContentChange={onContentChange}
                    />
                  ))}
                  {group.pendingDispatches.map((dispatch) => (
                    <ManagedTaskReconciledPendingRow
                      key={dispatch.partId}
                      rootSessionId={rootSessionId}
                      dispatch={dispatch}
                      fallbackTask={dispatch.dispatchCallId
                        ? fallbackTasksByDispatchCallId.get(dispatch.dispatchCallId)
                        : undefined}
                      recoverMissingDispatch={recoverMissingDispatches}
                      onContentChange={onContentChange}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </section>
  );
});

ManagedTaskList.displayName = 'ManagedTaskList';
