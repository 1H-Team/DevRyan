import React from 'react';
import { RiAiAgentLine, RiGitBranchLine, RiRefreshLine } from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { getAgentColor } from '@/lib/agentColors';
import {
  managedOrchestrationSelectors,
  useManagedOrchestrationStore,
} from '@/stores/useManagedOrchestrationStore';
import { ManagedTaskRow } from './ManagedTaskRow';
import {
  getManagedTaskWindow,
  MANAGED_TASK_ROW_BATCH,
  shouldRenderManagedTaskList,
} from './managedTaskListWindow';

export const ManagedTaskList = React.memo(({
  rootSessionId,
  taskIds: explicitTaskIds,
  onContentChange,
}: {
  rootSessionId?: string;
  taskIds?: readonly string[];
  onContentChange?: () => void;
}) => {
  const { t } = useI18n();
  const rootTaskIds = useManagedOrchestrationStore(React.useMemo(
    () => managedOrchestrationSelectors.taskIdsForRoot(rootSessionId ?? ''),
    [rootSessionId],
  ));
  const taskIds = explicitTaskIds ?? rootTaskIds;
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
    taskIds,
    visibleLimit,
    (taskId) => useManagedOrchestrationStore.getState().tasksById[taskId]?.agent,
  );
  const showRuntimeWarnings = rootSessionId !== undefined && explicitTaskIds === undefined;

  React.useLayoutEffect(() => {
    if (taskIds.length > 0 || recoveryWarning || snapshotError) onContentChange?.();
  }, [onContentChange, recoveryWarning, snapshotError, taskIds, visibleLimit]);

  if (!shouldRenderManagedTaskList({
    available,
    taskCount: taskIds.length,
    recoveryWarning: showRuntimeWarnings ? recoveryWarning : null,
    snapshotError: showRuntimeWarnings ? snapshotError : null,
  })) return null;
  return (
    <section
      aria-label={t('chat.managedTasks.title')}
      className="chat-message-column px-4 pb-2 pt-3"
    >
      <div className="overflow-hidden rounded-xl border border-[color-mix(in_srgb,var(--primary-base)_16%,var(--border))] bg-[color-mix(in_srgb,var(--primary-base)_3%,var(--surface-background))]">
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
          {agentGroups.map((group) => (
            <section key={group.agent.toLocaleLowerCase()} aria-label={group.agent}>
              <div className="flex h-7 items-center bg-muted/25 px-3 typography-meta text-muted-foreground">
                <span className="inline-flex min-w-0 items-center gap-1.5 leading-none">
                  <RiAiAgentLine
                    className="size-3.5 shrink-0"
                    style={{ color: `var(${getAgentColor(group.agent).var})` }}
                    aria-hidden="true"
                  />
                  <span className="truncate capitalize">{group.agent}</span>
                </span>
              </div>
              <div className="divide-y divide-border/60">
                {group.taskIds.map((taskId) => (
                  <ManagedTaskRow key={taskId} taskId={taskId} onContentChange={onContentChange} />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </section>
  );
});

ManagedTaskList.displayName = 'ManagedTaskList';
