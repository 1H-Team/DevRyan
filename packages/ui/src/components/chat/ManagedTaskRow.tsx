import React from 'react';
import { RiExternalLinkLine } from '@remixicon/react';
import {
  formatManagedTaskDisplayName,
  type ManagedTaskEventRecord,
} from '@openchamber/orchestration-runtime';

import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import type {
  ManagedTaskProjectedEnvelope,
  ManagedTaskProjectedRecord,
} from '@/lib/orchestrationApi';
import { useConfigStore } from '@/stores/useConfigStore';
import type { ProviderRecoverySelection } from '@/stores/useProviderRecoveryStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionStatus } from '@/sync/sync-context';
import {
  managedOrchestrationSelectors,
  useManagedOrchestrationStore,
} from '@/stores/useManagedOrchestrationStore';
import { navigateToManagedTaskChild } from './managedTaskNavigation';
import { getSameChildFollowUpTaskId } from './managedTaskRetryLineage';
import { ModelRecoveryCard, type ModelRecoveryAutoResume } from './ModelRecoveryCard';
import type { ControlledModelPickerProvider } from './ControlledModelPicker';
import { formatEffortLabel } from './mobileControlsUtils';

/** Store records carry the (optional) recovery fields; plain wire records stay accepted. */
type ManagedTaskRowTask = ManagedTaskProjectedRecord;
type ManagedTaskRowEnvelope = ManagedTaskProjectedEnvelope;

const getStatusPresentation = (
  task: Pick<ManagedTaskRowTask, 'executionKind' | 'status' | 'childPromptedAt' | 'firstAssistantPartAt'>,
  t: ReturnType<typeof useI18n>['t'],
) => {
  if (task.status === 'completed') {
    return { label: t('chat.managedTasks.summary.complete'), className: 'text-[var(--status-success)]' };
  }
  if (task.status === 'failed' || task.status === 'aborted' || task.status === 'interrupted') {
    return { label: t('chat.managedTasks.summary.error'), className: 'text-[var(--status-error)]' };
  }
  if (task.status === 'queued') {
    return { label: t('chat.managedTasks.summary.queued'), className: 'text-muted-foreground' };
  }
  if (
    (task.status === 'starting' || task.status === 'running')
    && task.childPromptedAt
    && !task.firstAssistantPartAt
  ) {
    // The child has its prompt but the model has not produced anything yet.
    return { label: t('chat.managedTasks.summary.startingModel'), className: 'text-muted-foreground' };
  }
  if (task.status === 'starting') {
    return { label: t('chat.managedTasks.summary.preparing'), className: 'text-muted-foreground' };
  }
  return { label: t('chat.managedTasks.summary.running'), className: 'text-muted-foreground' };
};

const providerModelLabel = (
  task: Pick<ManagedTaskEventRecord, 'modelId' | 'providerId'>,
  providers: ControlledModelPickerProvider[],
) => {
  const provider = providers.find((entry) => entry.id === task.providerId);
  const model = provider?.models?.find((entry) => entry.id === task.modelId);
  return {
    provider: provider?.name ?? task.providerId,
    model: model?.name ?? task.modelId,
    combined: `${provider?.name ?? task.providerId} / ${model?.name ?? task.modelId}`,
  };
};

const getProviderFailurePresentation = ({
  task,
  recoverySourceTask,
  priorEnvelope,
  providers,
  t,
}: {
  task: ManagedTaskRowTask;
  recoverySourceTask?: ManagedTaskRowTask;
  priorEnvelope?: ManagedTaskRowEnvelope;
  providers: ControlledModelPickerProvider[];
  t: ReturnType<typeof useI18n>['t'];
}) => {
  if (task.failureKind === 'provider_usage_limit') {
    const failedModel = providerModelLabel(task, providers);
    return {
      message: t('chat.managedTasks.providerLimit.reached', {
        provider: failedModel.provider,
        model: failedModel.model,
      }),
      className: 'text-[var(--status-warning)]',
      role: 'alert' as const,
    };
  }

  if (task.failureKind === 'model_unavailable') {
    return {
      message: task.failureReason || t('chat.modelRecovery.modelUnavailable', {
        provider: task.providerId,
        model: task.modelId,
      }),
      className: 'text-[var(--status-warning)]',
      role: 'alert' as const,
    };
  }

  if (task.failureKind === 'provider_prompt_rejected') {
    return {
      message: task.agentRetryAvailable
        ? t('chat.managedTasks.promptRejected.reframe')
        : t('chat.managedTasks.promptRejected.exhausted'),
      className: 'text-[var(--status-warning)]',
      role: 'alert' as const,
    };
  }

  if (task.failureKind === 'deadline_exceeded') {
    return {
      message: t(task.agentRetryAvailable
        ? 'chat.modelRecovery.timeoutAgentRetry'
        : 'chat.modelRecovery.timeoutTerminal'),
      className: 'text-[var(--status-warning)]',
      role: 'alert' as const,
    };
  }

  // This task is the attempt the prior usage-limit envelope's auto-resume launched.
  const continuedAfterLimit = Boolean(
    task.priorTaskId
    && priorEnvelope?.taskId === task.priorTaskId
    && priorEnvelope.autoResume?.lastAttemptTaskId === task.taskId,
  );
  if (continuedAfterLimit) {
    return {
      message: t('chat.managedTasks.providerLimit.continued', {
        model: providerModelLabel(task, providers).model,
        thinking: formatEffortLabel(task.variant ?? undefined, { providerId: task.providerId }),
      }),
      className: 'text-[var(--status-success)]',
      role: 'status' as const,
    };
  }

  const recoveredSameChild = recoverySourceTask?.failureKind === 'provider_usage_limit'
    && (task.executionKind === 'retry_in_place' || task.executionKind === 'recover_in_place')
    && task.status === 'completed';
  if (!recoveredSameChild) return null;

  return {
    message: t('chat.managedTasks.providerLimit.recovered', {
      model: providerModelLabel(task, providers).model,
      thinking: formatEffortLabel(task.variant ?? undefined, { providerId: task.providerId }),
    }),
    className: 'text-[var(--status-success)]',
    role: 'status' as const,
  };
};

/**
 * Only usage-limit failures get the auto-resume row. An envelope without the
 * host's block (older host, or not applicable) renders the box unchecked and off.
 */
const deriveAutoResume = (
  task: ManagedTaskRowTask,
  resultEnvelope: ManagedTaskRowEnvelope | undefined,
  providers: ControlledModelPickerProvider[],
): ModelRecoveryAutoResume | undefined => {
  if (task.failureKind !== 'provider_usage_limit') return undefined;
  const providerResetAt = resultEnvelope?.providerResetAt ?? null;
  const autoResume = resultEnvelope?.autoResume ?? null;
  if (!autoResume) {
    return {
      enabled: false,
      state: 'cancelled',
      nextAttemptAt: null,
      expiresAt: null,
      attemptCount: 0,
      targetLabel: null,
      resetAt: providerResetAt,
      lastError: null,
      reason: null,
    };
  }
  return {
    enabled: autoResume.enabled,
    state: autoResume.state,
    nextAttemptAt: autoResume.nextAttemptAt,
    expiresAt: autoResume.expiresAt,
    attemptCount: autoResume.attemptCount,
    targetLabel: autoResume.target ? providerModelLabel(autoResume.target, providers).combined : null,
    resetAt: autoResume.resetAt ?? providerResetAt,
    lastError: autoResume.lastError,
    reason: autoResume.reason,
  };
};

export type ManagedTaskRowViewProps = {
  task: ManagedTaskRowTask;
  recoverySourceTask?: ManagedTaskRowTask;
  /** Envelope of `task.priorTaskId`, when that task is still in the store. */
  priorEnvelope?: ManagedTaskRowEnvelope;
  onOpenChild(): void;
  resultEnvelope?: ManagedTaskRowEnvelope;
  pending?: boolean;
  childActive?: boolean;
  actionError?: string | null;
  providers?: ControlledModelPickerProvider[];
  onRetryInPlace?(selection: ProviderRecoverySelection): void | Promise<void>;
  autoResumePending?: boolean;
  onAutoResumeChange?(enabled: boolean): void | Promise<void>;
};

export const ManagedTaskRowView = React.memo(({
  task,
  recoverySourceTask,
  priorEnvelope,
  onOpenChild,
  resultEnvelope,
  pending = false,
  childActive = false,
  actionError = null,
  providers = [],
  onRetryInPlace,
  autoResumePending = false,
  onAutoResumeChange,
}: ManagedTaskRowViewProps) => {
  const { t } = useI18n();
  const manualRecoveryRequired = Boolean(
    resultEnvelope?.resumable
    && resultEnvelope.action === null
    && !task.agentRetryAvailable
    && task.failureKind !== 'provider_prompt_rejected'
    && (
      task.failureKind === 'provider_usage_limit'
      || task.failureKind === 'model_unavailable'
      || (task.mode === 'orchestrator' && task.dispatchGrouped && task.attempt >= 2)
    )
    && (task.status === 'failed' || task.status === 'interrupted'),
  );
  const showRecovery = Boolean(onRetryInPlace && manualRecoveryRequired);
  const presentedTask = childActive && (
    task.status === 'failed' || task.status === 'aborted' || task.status === 'interrupted'
  ) && !manualRecoveryRequired
    && task.failureKind !== 'provider_usage_limit'
    && task.failureKind !== 'provider_prompt_rejected'
    ? { ...task, status: 'running' as const }
    : task;
  const status = getStatusPresentation(presentedTask, t);
  const providerFailurePresentation = getProviderFailurePresentation({
    task,
    recoverySourceTask,
    priorEnvelope,
    providers,
    t,
  });
  const autoResume = showRecovery ? deriveAutoResume(task, resultEnvelope, providers) : undefined;
  const [selection, setSelection] = React.useState<ProviderRecoverySelection>(() => ({
    providerId: task.providerId,
    modelId: task.modelId,
    variant: task.variant,
  }));
  React.useEffect(() => {
    setSelection({ providerId: task.providerId, modelId: task.modelId, variant: task.variant });
  }, [task.taskId, task.providerId, task.modelId, task.variant]);
  return (
    <article data-managed-task-id={task.taskId}>
      <div className="flex min-w-0 flex-col items-start gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3">
        <div className="min-w-0 flex-1">
          <h4 className="line-clamp-2 break-words typography-ui-label font-medium text-foreground sm:line-clamp-1">
            {formatManagedTaskDisplayName(task.label)}
          </h4>
          <p className={`truncate typography-meta ${status.className}`}>{status.label}</p>
          {providerFailurePresentation && !(showRecovery && task.failureKind === 'deadline_exceeded') ? (
            <p role={providerFailurePresentation.role} className={`mt-1 typography-micro ${providerFailurePresentation.className}`}>
              {providerFailurePresentation.message}
            </p>
          ) : null}
          {!providerFailurePresentation && (task.executionKind === 'retry_in_place' || task.executionKind === 'recover_in_place' || task.executionKind === 'resume') ? (
            <p className="mt-1 typography-micro text-muted-foreground">
              {providerModelLabel(task, providers).combined} · {formatEffortLabel(task.variant ?? undefined, { providerId: task.providerId })}
            </p>
          ) : null}
        </div>
        {task.childSessionId ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="self-start w-auto min-h-[36px] min-w-[36px] gap-1 px-1 normal-case text-[var(--primary-base)] hover:text-[var(--primary-base)] sm:self-auto sm:w-auto sm:min-h-9 sm:min-w-9 sm:px-1.5"
            onClick={onOpenChild}
          >
            <RiExternalLinkLine className="hidden size-3 sm:block" />
            {t('chat.managedTasks.child.open')}
          </Button>
        ) : null}
      </div>
      {showRecovery ? (
        <ModelRecoveryCard
          embedded
          title={t(task.failureKind === 'deadline_exceeded'
            ? 'chat.modelRecovery.timeoutSubagentPrompt'
            : 'chat.modelRecovery.subagentPrompt')}
          detail={task.failureKind === 'deadline_exceeded'
            ? t('chat.modelRecovery.timeoutDetail')
            : null}
          originalModelLabel={providerModelLabel(task, providers).combined}
          providers={providers}
          selection={selection}
          pending={pending}
          actionError={actionError}
          onSelectionChange={setSelection}
          onRetry={(nextSelection) => onRetryInPlace?.(nextSelection)}
          autoResume={autoResume}
          onAutoResumeChange={onAutoResumeChange}
          autoResumePending={autoResumePending}
        />
      ) : null}
    </article>
  );
});

ManagedTaskRowView.displayName = 'ManagedTaskRowView';

export const ManagedTaskRow = React.memo(({
  taskId: sourceTaskId,
  onContentChange,
}: {
  taskId: string;
  onContentChange?: () => void;
}) => {
  const taskId = useManagedOrchestrationStore(React.useMemo(
    () => managedOrchestrationSelectors.taskIdForRecovery(sourceTaskId),
    [sourceTaskId],
  )) ?? sourceTaskId;
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
  const recoverySourceTask = useManagedOrchestrationStore(React.useMemo(
    () => managedOrchestrationSelectors.task(task?.priorTaskId ?? ''),
    [task?.priorTaskId],
  ));
  // Undefined when the prior task was compacted away; the row then renders on its own.
  const priorEnvelope = useManagedOrchestrationStore(React.useMemo(
    () => managedOrchestrationSelectors.resultEnvelope(task?.priorTaskId ?? ''),
    [task?.priorTaskId],
  ));
  const sameChildFollowUpTaskId = getSameChildFollowUpTaskId(resultEnvelope);
  const childStatus = useSessionStatus(task?.childSessionId ?? '', task?.directory ?? undefined);
  const childActive = childStatus?.type === 'busy' || childStatus?.type === 'retry';

  React.useLayoutEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    if (task) onContentChange?.();
  }, [onContentChange, task]);

  if (sameChildFollowUpTaskId) {
    return <ManagedTaskRow taskId={sameChildFollowUpTaskId} onContentChange={onContentChange} />;
  }
  if (!task) return null;
  return (
    <ManagedTaskRowView
      task={task}
      recoverySourceTask={recoverySourceTask}
      priorEnvelope={priorEnvelope}
      resultEnvelope={resultEnvelope}
      pending={pendingAction === 'retry_in_place'}
      childActive={childActive}
      actionError={actionError}
      providers={providers}
      onRetryInPlace={(selection) => useManagedOrchestrationStore.getState().acknowledgeTask(
        taskId,
        'retry_in_place',
        selection,
      )}
      autoResumePending={pendingAction === 'auto_resume'}
      onAutoResumeChange={(enabled) => useManagedOrchestrationStore.getState().setAutoResume(
        taskId,
        enabled,
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
