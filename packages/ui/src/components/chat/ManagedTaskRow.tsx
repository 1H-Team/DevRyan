import React from 'react';
import { RiExternalLinkLine } from '@remixicon/react';
import {
  formatManagedTaskDisplayName,
  type ManagedTaskEventRecord,
  type ManagedTaskResultEnvelope,
  type ManagedTaskStatus,
} from '@openchamber/orchestration-runtime';

import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { useConfigStore } from '@/stores/useConfigStore';
import type { ProviderRecoverySelection } from '@/stores/useProviderRecoveryStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import {
  managedOrchestrationSelectors,
  useManagedOrchestrationStore,
} from '@/stores/useManagedOrchestrationStore';
import { navigateToManagedTaskChild } from './managedTaskNavigation';
import { getRetryInPlaceFollowUpTaskId } from './managedTaskRetryLineage';
import { ModelRecoveryCard } from './ModelRecoveryCard';
import type { ControlledModelPickerProvider } from './ControlledModelPicker';

const getStatusPresentation = (
  status: ManagedTaskStatus,
  t: ReturnType<typeof useI18n>['t'],
) => {
  if (status === 'completed') {
    return { label: t('chat.managedTasks.summary.complete'), className: 'text-[var(--status-success)]' };
  }
  if (status === 'failed' || status === 'aborted' || status === 'interrupted') {
    return { label: t('chat.managedTasks.summary.error'), className: 'text-[var(--status-error)]' };
  }
  return { label: t('chat.managedTasks.summary.running'), className: 'text-muted-foreground' };
};

export type ManagedTaskRowViewProps = {
  task: ManagedTaskEventRecord;
  onOpenChild(): void;
  resultEnvelope?: ManagedTaskResultEnvelope;
  pending?: boolean;
  actionError?: string | null;
  providers?: ControlledModelPickerProvider[];
  onRetryInPlace?(selection: ProviderRecoverySelection): void | Promise<void>;
};

export const ManagedTaskRowView = React.memo(({
  task,
  onOpenChild,
  resultEnvelope,
  pending = false,
  actionError = null,
  providers = [],
  onRetryInPlace,
}: ManagedTaskRowViewProps) => {
  const { t } = useI18n();
  const status = getStatusPresentation(task.status, t);
  const [selection, setSelection] = React.useState<ProviderRecoverySelection>(() => ({
    providerId: task.providerId,
    modelId: task.modelId,
    variant: task.variant,
  }));
  React.useEffect(() => {
    setSelection({ providerId: task.providerId, modelId: task.modelId, variant: task.variant });
  }, [task.taskId, task.providerId, task.modelId, task.variant]);
  const showRecovery = Boolean(
    onRetryInPlace
    && resultEnvelope?.resumable
    && resultEnvelope.action === null
    && (task.status === 'failed' || task.status === 'interrupted'),
  );

  return (
    <article data-managed-task-id={task.taskId}>
      <div className="flex min-w-0 items-center gap-3 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <h4 className="truncate typography-ui-label font-medium text-foreground">
            {formatManagedTaskDisplayName(task.label)}
          </h4>
          <p className={`truncate typography-meta ${status.className}`}>{status.label}</p>
        </div>
        {task.childSessionId ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="normal-case text-[var(--primary-base)] hover:text-[var(--primary-base)]"
            onClick={onOpenChild}
          >
            <RiExternalLinkLine className="size-3" />
            {t('chat.managedTasks.child.open')}
          </Button>
        ) : null}
      </div>
      {showRecovery ? (
        <ModelRecoveryCard
          embedded
          title={t('chat.modelRecovery.subagentPrompt')}
          originalModelLabel={`${task.providerId} / ${task.modelId}`}
          providers={providers}
          selection={selection}
          pending={pending}
          actionError={actionError}
          onSelectionChange={setSelection}
          onRetry={() => onRetryInPlace?.(selection)}
        />
      ) : null}
    </article>
  );
});

ManagedTaskRowView.displayName = 'ManagedTaskRowView';

export const ManagedTaskRow = React.memo(({
  taskId,
  onContentChange,
}: {
  taskId: string;
  onContentChange?: () => void;
}) => {
  const task = useManagedOrchestrationStore(React.useMemo(
    () => managedOrchestrationSelectors.task(taskId),
    [taskId],
  ));
  const didMountRef = React.useRef(false);
  const resultEnvelope = useManagedOrchestrationStore(React.useMemo(
    () => managedOrchestrationSelectors.resultEnvelope(taskId),
    [taskId],
  ));
  const pendingAction = useManagedOrchestrationStore(React.useMemo(
    () => managedOrchestrationSelectors.pendingAction(taskId),
    [taskId],
  ));
  const actionError = useManagedOrchestrationStore(React.useMemo(
    () => managedOrchestrationSelectors.actionError(taskId),
    [taskId],
  ));
  const providers = useConfigStore((state) => state.providers);
  const retryFollowUpTaskId = getRetryInPlaceFollowUpTaskId(resultEnvelope);

  React.useLayoutEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    if (task) onContentChange?.();
  }, [onContentChange, task]);

  if (retryFollowUpTaskId) {
    return <ManagedTaskRow taskId={retryFollowUpTaskId} onContentChange={onContentChange} />;
  }
  if (!task) return null;
  return (
    <ManagedTaskRowView
      task={task}
      resultEnvelope={resultEnvelope}
      pending={pendingAction === 'retry_in_place'}
      actionError={actionError}
      providers={providers}
      onRetryInPlace={(selection) => useManagedOrchestrationStore.getState().acknowledgeTask(
        taskId,
        'retry_in_place',
        selection,
      )}
      onOpenChild={() => {
        navigateToManagedTaskChild(task, (sessionId, directory) => {
          useSessionUIStore.getState().setCurrentSession(sessionId, directory);
        });
      }}
    />
  );
});

ManagedTaskRow.displayName = 'ManagedTaskRow';
