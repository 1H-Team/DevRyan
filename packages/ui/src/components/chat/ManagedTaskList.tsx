import React from 'react';
import { RiAiAgentLine, RiExternalLinkLine, RiGitBranchLine, RiRefreshLine } from '@remixicon/react';

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
import { ManagedTaskReadiness, type ManagedTaskCandidate, type ManagedTaskPresentation } from './ManagedTaskReadiness';
import { CursorNativeTaskRows } from './CursorNativeTaskRows';
import type { CursorNativeTaskDispatch } from './cursorNativeTaskDispatch';
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
const EMPTY_CURSOR_NATIVE_TASKS: readonly CursorNativeTaskDispatch[] = [];
const MANAGED_TASK_CARD_STYLE: React.CSSProperties & Record<'--managed-task-card-border', string> = {
  '--managed-task-card-border': 'color-mix(in srgb, var(--primary-base) 16%, var(--border))',
};

export const ManagedTaskPreparingRow = React.memo(({
  dispatch,
}: {
  dispatch: PendingManagedTaskDispatch;
}) => {
  const { t } = useI18n();
  if (dispatch.status !== 'error') return null;
  return (
    <p role="alert" data-managed-task-pending-id={dispatch.partId} className="typography-meta text-[var(--status-error)]">
      {t('chat.managedTasks.summary.startError')}
      {dispatch.errorMessage ? ` ${dispatch.errorMessage}` : ''}
    </p>
  );
});

ManagedTaskPreparingRow.displayName = 'ManagedTaskPreparingRow';

const ManagedTaskFallbackRow = React.memo(({
  task,
  title,
}: {
  task: ManagedTaskDispatchFallback;
  title: string;
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
            {title}
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

export const ManagedTaskList = React.memo(({
  rootSessionId,
  taskIds: explicitTaskIds,
  pendingDispatches = EMPTY_PENDING_DISPATCHES,
  fallbackTasks = EMPTY_FALLBACK_TASKS,
  recoverMissingDispatches = false,
  cursorNativeTasks = EMPTY_CURSOR_NATIVE_TASKS,
  onContentChange,
  isMobile = false,
}: {
  rootSessionId?: string;
  taskIds?: readonly string[];
  pendingDispatches?: readonly PendingManagedTaskDispatch[];
  fallbackTasks?: readonly ManagedTaskDispatchFallback[];
  recoverMissingDispatches?: boolean;
  cursorNativeTasks?: readonly CursorNativeTaskDispatch[];
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

  const { hiddenCount, visibleTaskIds: windowTaskIds } = React.useMemo(
    () => getManagedTaskWindow(visibleTaskIds, visibleLimit), [visibleTaskIds, visibleLimit],
  );
  const candidates = React.useMemo<ManagedTaskCandidate[]>(() => [
    ...windowTaskIds.map((taskId) => ({ key: taskId, taskId, fallback: fallbackTasksById.get(taskId) })),
    ...pendingDispatches.map((pending) => ({
      key: pending.partId,
      pending,
      fallback: pending.dispatchCallId ? fallbackTasksByDispatchCallId.get(pending.dispatchCallId) : undefined,
    })),
  ], [windowTaskIds, fallbackTasksById, pendingDispatches, fallbackTasksByDispatchCallId]);
  const [presentations, setPresentations] = React.useState<Record<string, ManagedTaskPresentation>>({});
  const onPresentationChange = React.useCallback((key: string, value: ManagedTaskPresentation | null) => {
    setPresentations((current) => {
      const previous = current[key];
      if (!value) {
        if (!previous) return current;
        const next = { ...current };
        delete next[key];
        return next;
      }
      if (previous && Object.keys(value).every((field) => (
        previous[field as keyof ManagedTaskPresentation] === value[field as keyof ManagedTaskPresentation]
      ))) return current;
      return { ...current, [key]: value };
    });
  }, []);
  const displayGroups = React.useMemo(() => {
    const groups = new Map<string, { agent: string; items: Array<{ candidate: ManagedTaskCandidate; presentation: ManagedTaskPresentation }> }>();
    const seen = new Set<string>();
    for (const candidate of candidates) {
      const presentation = presentations[candidate.key];
      if (!presentation?.title) continue;
      const taskId = presentation.taskId ?? candidate.fallback?.taskId;
      if (!taskId || seen.has(taskId)) continue;
      seen.add(taskId);
      const key = presentation.agent.toLocaleLowerCase();
      const group = groups.get(key) ?? { agent: presentation.agent, items: [] };
      group.items.push({ candidate, presentation });
      groups.set(key, group);
    }
    return [...groups.values()];
  }, [candidates, presentations]);
  const errorCandidates = React.useMemo(() => {
    const seen = new Set<string>();
    return candidates.filter((candidate) => {
      const taskId = presentations[candidate.key]?.taskId ?? candidate.fallback?.taskId;
      if (!taskId) return true;
      if (seen.has(taskId)) return false;
      seen.add(taskId);
      return true;
    });
  }, [candidates, presentations]);
  const showRuntimeWarnings = rootSessionId !== undefined && explicitTaskIds === undefined;

  React.useLayoutEffect(() => {
    onContentChange?.();
  }, [cursorNativeTasks, onContentChange, presentations, recoveryWarning, snapshotError, visibleLimit]);

  const shouldRenderManagedTasks = shouldRenderManagedTaskList({
    available,
    taskCount: displayGroups.length,
    recoveryWarning: showRuntimeWarnings ? recoveryWarning : null,
    snapshotError: showRuntimeWarnings ? snapshotError : null,
  });
  const showCard = (shouldRenderManagedTasks && displayGroups.length > 0) || cursorNativeTasks.length > 0;
  const showContent = showCard || hiddenCount > 0
    || (showRuntimeWarnings && Boolean(recoveryWarning || snapshotError))
    || candidates.some((candidate) => presentations[candidate.key]?.error || candidate.pending?.status === 'error');
  return (
    <>
      {candidates.map((candidate) => (
        <ManagedTaskReadiness key={candidate.key} candidate={candidate} rootSessionId={rootSessionId}
          recoverMissingDispatch={recoverMissingDispatches} onChange={onPresentationChange} />
      ))}
      {showContent ? (
    <section
      aria-label={showCard ? t('chat.managedTasks.title') : undefined}
      className={cn(isMobile ? 'w-full px-0' : 'chat-message-column px-4')}
    >
      {errorCandidates.map((candidate) => {
        const presentation = presentations[candidate.key];
        if (!presentation?.error) return candidate.pending && !presentation?.taskId && !candidate.fallback
          ? <ManagedTaskPreparingRow key={candidate.key} dispatch={candidate.pending} /> : null;
        if (presentation.taskId) return (
          <div key={candidate.key} data-managed-task-start-error={candidate.key}>
            <ManagedTaskRow taskId={presentation.taskId}
              displayTitle={t(presentation.error === 'title' ? 'chat.managedTasks.titleUnavailable' : 'chat.managedTasks.summary.startError')}
              onContentChange={onContentChange} />
            {presentation.errorMessage ? <p role="alert" className="typography-meta text-[var(--status-error)]">{presentation.errorMessage}</p> : null}
          </div>
        );
        return (
          <div key={candidate.key} data-managed-task-start-error={candidate.key} className="flex items-center gap-2 py-2">
            <p role="alert" className="min-w-0 flex-1 typography-meta text-[var(--status-error)]">
              {t(presentation.error === 'title' ? 'chat.managedTasks.titleUnavailable' : 'chat.managedTasks.summary.startError')}
              {presentation.errorMessage ? ` ${presentation.errorMessage}` : ''}
            </p>
            {presentation.childSessionId ? (
              <Button type="button" size="xs" variant="ghost" onClick={() => {
                if (presentation.childSessionId) useSessionUIStore.getState().setCurrentSession(presentation.childSessionId, presentation.directory);
              }}>{t('chat.managedTasks.child.open')}</Button>
            ) : null}
          </div>
        );
      })}
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
      {showCard ? (
      <div
        data-managed-task-card="true"
        className="relative isolate overflow-hidden rounded-xl border border-[color:var(--managed-task-card-border)] bg-[color-mix(in_srgb,var(--primary-base)_3%,var(--surface-background))]"
        style={MANAGED_TASK_CARD_STYLE}
      >
        <header className="flex items-center gap-2 border-b border-border/70 px-3 py-2">
          <RiGitBranchLine className="size-3.5 text-[var(--primary-base)]" aria-hidden="true" />
          <h3 className="typography-ui-label font-semibold text-foreground">
            {t('chat.managedTasks.title')}
          </h3>
        </header>
        <div className="divide-y divide-border/70">
          {displayGroups.map((group) => {
            const agentLabel = formatAgentLabel(group.agent);
            return (
              <section key={group.agent.toLocaleLowerCase()} aria-label={agentLabel}>
                <div className="flex h-7 items-center bg-muted/25 px-3 typography-meta text-muted-foreground">
                  <span className="inline-flex min-w-0 items-center gap-1.5">
                    <RiAiAgentLine
                      className="size-3.5 shrink-0"
                      style={{ color: `var(${getAgentIconColor(group.agent).var})` }}
                      aria-hidden="true"
                    />
                    <span className="truncate">{agentLabel}</span>
                  </span>
                </div>
                <div className="divide-y divide-border/60">
                  {group.items.map(({ candidate, presentation }) => presentation.taskId ? (
                    <ManagedTaskRow key={candidate.key} taskId={presentation.taskId}
                      displayTitle={presentation.title ?? undefined} onContentChange={onContentChange} />
                  ) : candidate.fallback && presentation.title ? (
                    <ManagedTaskFallbackRow key={candidate.key} task={candidate.fallback} title={presentation.title} />
                  ) : null)}
                </div>
              </section>
            );
          })}
          {cursorNativeTasks.length > 0 ? (
            <section aria-label={t('chat.managedTasks.cursorNative.source')} data-task-source="cursor-native">
              <div className="flex h-7 items-center gap-1.5 bg-muted/25 px-3 typography-meta text-muted-foreground">
                <RiAiAgentLine className="size-3.5 shrink-0 text-[var(--primary-base)]" aria-hidden="true" />
                <span className="truncate">{t('chat.managedTasks.cursorNative.source')}</span>
                <span className="ml-auto shrink-0 typography-micro text-muted-foreground/70">
                  {t('chat.managedTasks.cursorNative.observed')}
                </span>
              </div>
              <CursorNativeTaskRows tasks={cursorNativeTasks} isMobile={isMobile} />
            </section>
          ) : null}
        </div>
      </div>
      ) : null}
    </section>
      ) : null}
    </>
  );
});

ManagedTaskList.displayName = 'ManagedTaskList';
