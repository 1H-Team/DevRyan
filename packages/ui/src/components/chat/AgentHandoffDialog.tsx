import React from 'react';
import { RiAlertLine, RiLoader4Line } from '@remixicon/react';
import { formatManagedTaskDisplayName } from '@openchamber/orchestration-runtime';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
} from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { ManagedTaskProjection } from '@/lib/orchestrationApi';
import type { AgentHandoffViewState } from './agentHandoffCoordinator';

const MAX_VISIBLE_TASKS = 10;
const ACTIVE_STATUSES = new Set(['queued', 'starting', 'running']);
const TITLE_ID = 'agent-handoff-dialog-title';
const DESCRIPTION_ID = 'agent-handoff-dialog-description';

const getAgentHandoffTaskSummary = (tasks: readonly ManagedTaskProjection[]) => ({
  activeCount: tasks.filter(({ task }) => ACTIVE_STATUSES.has(task.status)).length,
  unreviewedCount: tasks.filter(({ task, resultEnvelope }) => (
    !ACTIVE_STATUSES.has(task.status) && (!resultEnvelope || resultEnvelope.action === null)
  )).length,
  visibleTasks: tasks.slice(0, MAX_VISIBLE_TASKS),
  remainingCount: Math.max(0, tasks.length - MAX_VISIBLE_TASKS),
});

const statusTone = (projection: ManagedTaskProjection) => {
  if (projection.resultEnvelope?.action !== null && projection.resultEnvelope?.action !== undefined) {
    return 'cleared';
  }
  return projection.task.status === 'completed' ? 'unreviewed' : projection.task.status;
};

const statusKey = (projection: ManagedTaskProjection) => {
  const tone = statusTone(projection);
  if (tone === 'queued') return 'chat.agentHandoff.status.queued' as const;
  if (tone === 'starting') return 'chat.agentHandoff.status.starting' as const;
  if (tone === 'running') return 'chat.agentHandoff.status.running' as const;
  if (tone === 'unreviewed') return 'chat.agentHandoff.status.unreviewed' as const;
  if (tone === 'cleared') return 'chat.agentHandoff.status.cleared' as const;
  if (tone === 'failed') return 'chat.agentHandoff.status.failed' as const;
  if (tone === 'aborted') return 'chat.agentHandoff.status.aborted' as const;
  return 'chat.agentHandoff.status.interrupted' as const;
};

const TaskRow: React.FC<{ projection: ManagedTaskProjection; index: number }> = ({ projection, index }) => {
  const { t } = useI18n();
  const tone = statusTone(projection);
  const label = formatManagedTaskDisplayName(projection.task.label);
  const isActive = ACTIVE_STATUSES.has(projection.task.status);

  return (
    <li
      className="grid min-w-0 grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-2.5 border-b border-border/45 px-3 py-2.5 last:border-b-0"
      data-task-status={tone}
    >
      <span className="font-mono typography-micro tabular-nums text-muted-foreground/65">
        {String(index + 1).padStart(2, '0')}
      </span>
      <span className="min-w-0 truncate typography-ui-label text-foreground" title={label}>
        {label}
      </span>
      <span
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 typography-micro font-medium',
          isActive && 'border-[color-mix(in_srgb,var(--status-warning)_25%,transparent)] bg-[color-mix(in_srgb,var(--status-warning)_9%,transparent)] text-[var(--status-warning)]',
          tone === 'cleared' && 'border-[color-mix(in_srgb,var(--status-success)_22%,transparent)] bg-[color-mix(in_srgb,var(--status-success)_8%,transparent)] text-[var(--status-success)]',
          !isActive && tone !== 'cleared' && 'border-border/60 bg-interactive-hover text-muted-foreground',
        )}
      >
        <span
          aria-hidden
          className={cn(
            'size-1.5 rounded-full bg-current',
            (tone === 'starting' || tone === 'running') && 'animate-pulse',
          )}
        />
        {t(statusKey(projection))}
      </span>
    </li>
  );
};

export const AgentHandoffDialogView: React.FC<{
  state: AgentHandoffViewState;
  onCancel: () => void;
  onConfirm: () => void;
  onRetry: () => void;
}> = ({ state, onCancel, onConfirm, onRetry }) => {
  const { t } = useI18n();
  const summary = getAgentHandoffTaskSummary(state.tasks);
  const cleaning = state.phase === 'cleaning';
  const failed = state.phase === 'error';

  return (
    <>
      <div className="flex flex-col gap-2.5 pr-1 text-center sm:text-left">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 id={TITLE_ID} className="typography-markdown text-lg font-semibold leading-tight text-foreground">
              {t('chat.agentHandoff.title')}
            </h2>
            <p id={DESCRIPTION_ID} className="mt-2 max-w-[52ch] typography-ui-label leading-relaxed text-muted-foreground">
              {t('chat.agentHandoff.description')}
            </p>
          </div>
          <div className="mt-0.5 flex shrink-0 flex-col items-end gap-1 font-mono typography-micro tabular-nums text-muted-foreground">
            <span>{t('chat.agentHandoff.activeCount', { count: summary.activeCount })}</span>
            <span>{t('chat.agentHandoff.unreviewedCount', { count: summary.unreviewedCount })}</span>
          </div>
        </div>
      </div>

      {state.tasks.length > 0 ? (
        <div className="overflow-hidden rounded-xl border border-border/65 bg-[var(--surface-subtle)]">
          <ol
            aria-label={t('chat.agentHandoff.taskListAria')}
            className="max-h-[min(42vh,22rem)] overflow-y-auto overscroll-contain"
          >
            {summary.visibleTasks.map((projection, index) => (
              <TaskRow key={projection.task.taskId} projection={projection} index={index} />
            ))}
          </ol>
          {summary.remainingCount > 0 ? (
            <div className="border-t border-border/50 px-3 py-2 text-right font-mono typography-micro text-muted-foreground">
              {summary.remainingCount === 1
                ? t('chat.agentHandoff.remainingCountSingle')
                : t('chat.agentHandoff.remainingCount', { count: summary.remainingCount })}
            </div>
          ) : null}
        </div>
      ) : null}

      {cleaning ? (
        <div
          aria-live="polite"
          className="flex items-center gap-2.5 rounded-xl border border-[color-mix(in_srgb,var(--primary-base)_18%,transparent)] bg-[color-mix(in_srgb,var(--primary-base)_7%,transparent)] px-3 py-2.5 text-[var(--primary-base)]"
        >
          <RiLoader4Line className="size-4 animate-spin" />
          <span className="typography-ui-label">{t('chat.agentHandoff.progress')}</span>
        </div>
      ) : null}

      {failed ? (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-xl border border-[color-mix(in_srgb,var(--status-error)_22%,transparent)] bg-[color-mix(in_srgb,var(--status-error)_7%,transparent)] px-3 py-2.5 text-[var(--status-error)]"
        >
          <RiAlertLine className="mt-0.5 size-4 shrink-0" />
          <span className="typography-ui-label leading-relaxed">
            {state.errorMessage || t('chat.agentHandoff.errorFallback')}
          </span>
        </div>
      ) : null}

      <div className="bottom-safe-area mt-0 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="neutral" disabled={cleaning} onClick={onCancel}>
          {t('chat.agentHandoff.keepOrchestrator')}
        </Button>
        <Button
          type="button"
          variant="destructive"
          disabled={cleaning}
          onClick={failed ? onRetry : onConfirm}
        >
          {cleaning ? <RiLoader4Line className="animate-spin" /> : null}
          {failed ? t('chat.agentHandoff.retry') : t('chat.agentHandoff.stopAndSwitch')}
        </Button>
      </div>
    </>
  );
};

export const AgentHandoffDialog: React.FC<{
  state: AgentHandoffViewState;
  onCancel: () => void;
  onConfirm: () => void;
  onRetry: () => void;
}> = ({ state, onCancel, onConfirm, onRetry }) => {
  const cleaning = state.phase === 'cleaning';
  return (
    <Dialog
      open={state.open}
      onOpenChange={(open) => {
        if (!open && !cleaning) onCancel();
      }}
    >
      <DialogContent
        aria-labelledby={TITLE_ID}
        aria-describedby={DESCRIPTION_ID}
        data-agent-handoff-phase={state.phase}
        showCloseButton={false}
        className="max-w-xl gap-4 p-5 sm:p-6"
      >
        <AgentHandoffDialogView
          state={state}
          onCancel={onCancel}
          onConfirm={onConfirm}
          onRetry={onRetry}
        />
      </DialogContent>
    </Dialog>
  );
};
