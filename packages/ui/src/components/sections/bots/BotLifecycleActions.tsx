import React from 'react';
import {
  RiChatDeleteLine,
  RiDeleteBinLine,
  RiPauseCircleLine,
  RiPlayCircleLine,
} from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type {
  BotCompleteDeleteRequest,
  BotPurgeExecutionResult,
  BotSummary,
} from '@/lib/botsApi';

export type BotLifecycleActionsProps = {
  bot: BotSummary;
  purgeResult?: BotPurgeExecutionResult | null;
  readOnly?: boolean;
  busyAction?: string | null;
  error?: string | null;
  hasChatHistory?: boolean;
  onTransition: (lifecycle: 'active' | 'paused' | 'retired') => void;
  onClearChatHistory?: () => void;
  onDeleteCompletely?: (request: BotCompleteDeleteRequest) => void;
  onRetryPurge?: (resourceIds: readonly string[]) => void;
};

export const BotLifecycleActions: React.FC<BotLifecycleActionsProps> = ({
  bot,
  purgeResult = null,
  readOnly = false,
  busyAction = null,
  error = null,
  hasChatHistory = false,
  onTransition,
  onClearChatHistory,
  onDeleteCompletely,
  onRetryPurge,
}) => {
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [clearHistoryOpen, setClearHistoryOpen] = React.useState(false);
  const [typedName, setTypedName] = React.useState('');

  React.useEffect(() => {
    setDeleteOpen(false);
    setClearHistoryOpen(false);
    setTypedName('');
  }, [bot.id]);

  const retryableStepIds = purgeResult?.steps
    .filter((step) => step.status === 'failed' || step.status === 'pending')
    .map((step) => step.id) || [];
  const deleting = busyAction === 'purge-complete';
  const clearingHistory = busyAction === 'clear-chat-history';
  const visibleState = !bot.activeRevisionId
    ? 'Setup incomplete'
    : bot.lifecycle === 'active' ? 'Active' : 'Paused';

  return (
    <section className="space-y-5" aria-labelledby="bot-lifecycle-heading">
      <div>
        <h3 id="bot-lifecycle-heading" className="typography-ui-header font-semibold text-foreground">Lifecycle</h3>
        <p className="typography-ui text-muted-foreground">Pause work temporarily or delete this Bot.</p>
      </div>

      <div className="rounded-xl border border-border/70 p-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h4 className="typography-ui-label font-medium text-foreground">Current state</h4>
            <p className="typography-micro text-muted-foreground">{visibleState}</p>
          </div>
          {visibleState === 'Active'
            ? <RiPlayCircleLine className="h-5 w-5 text-[var(--status-success)]" aria-hidden />
            : <RiPauseCircleLine className="h-5 w-5 text-[var(--status-warning)]" aria-hidden />}
        </div>
        {!readOnly && bot.activeRevisionId ? (
          <div className="mt-3">
            {bot.lifecycle === 'active' ? (
              <Button type="button" size="xs" variant="outline" disabled={busyAction !== null} onClick={() => onTransition('paused')}>
                <RiPauseCircleLine className="h-3.5 w-3.5" aria-hidden /> Pause
              </Button>
            ) : (
              <Button type="button" size="xs" variant="outline" disabled={busyAction !== null} onClick={() => onTransition('active')}>
                <RiPlayCircleLine className="h-3.5 w-3.5" aria-hidden /> Resume
              </Button>
            )}
          </div>
        ) : null}
      </div>

      <div className="rounded-xl border border-border/70 p-4">
        {!clearHistoryOpen ? (
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h4 className="typography-ui-label font-medium text-foreground">Chat history</h4>
              <p className="typography-micro text-muted-foreground">
                Remove the messages and attachments shown in your chat. Shared learning remains available to the Bot.
              </p>
            </div>
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={!hasChatHistory || busyAction !== null || !onClearChatHistory}
              onClick={() => setClearHistoryOpen(true)}
            >
              <RiChatDeleteLine className="h-3.5 w-3.5" aria-hidden /> Clear History
            </Button>
          </div>
        ) : (
          <div className="space-y-3 rounded-xl border border-[var(--status-error)]/40 bg-[var(--status-error)]/5 p-4" role="alertdialog" aria-label="Clear Chat History">
            <div>
              <h4 className="typography-ui-label font-semibold text-foreground">Clear your chat with {bot.name}?</h4>
              <p className="mt-1 typography-ui text-muted-foreground">
                Messages and chat attachments will be permanently removed. Shared learning will not be deleted.
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" size="xs" variant="ghost" disabled={clearingHistory} onClick={() => setClearHistoryOpen(false)}>Cancel</Button>
              <Button
                type="button"
                size="xs"
                variant="destructive"
                disabled={clearingHistory || !onClearChatHistory}
                onClick={() => {
                  setClearHistoryOpen(false);
                  onClearChatHistory?.();
                }}
              >
                <RiChatDeleteLine className="h-3.5 w-3.5" aria-hidden /> {clearingHistory ? 'Clearing…' : 'Clear Permanently'}
              </Button>
            </div>
          </div>
        )}
      </div>

      {!readOnly ? (
        <div className="border-t border-[var(--status-error)]/25 pt-5">
          {!deleteOpen ? (
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h4 className="typography-ui-label font-medium text-[var(--status-error)]">Delete Bot</h4>
                <p className="typography-micro text-muted-foreground">Permanently removes conversations, memory, files, credentials, and computer data.</p>
              </div>
              <Button type="button" size="xs" variant="destructive" disabled={busyAction !== null} onClick={() => setDeleteOpen(true)}>
                <RiDeleteBinLine className="h-3.5 w-3.5" aria-hidden /> Delete
              </Button>
            </div>
          ) : (
            <div className="space-y-3 rounded-xl border border-[var(--status-error)]/40 bg-[var(--status-error)]/5 p-4" role="alertdialog" aria-label="Delete Bot">
              <div>
                <h4 className="typography-ui-label font-semibold text-[var(--status-error)]">Delete {bot.name}?</h4>
                <p className="mt-1 typography-ui text-muted-foreground">This cannot be undone. Type the Bot name to confirm.</p>
              </div>
              <Input value={typedName} aria-label={`Type ${bot.name} to confirm`} onChange={(event) => setTypedName(event.target.value)} disabled={deleting} />
              <div className="flex justify-end gap-2">
                <Button type="button" size="xs" variant="ghost" disabled={deleting} onClick={() => { setDeleteOpen(false); setTypedName(''); }}>Cancel</Button>
                <Button
                  type="button"
                  size="xs"
                  variant="destructive"
                  disabled={!onDeleteCompletely || deleting || typedName !== bot.name}
                  onClick={() => onDeleteCompletely?.({
                    typedName,
                    confirm: true,
                    expectedUpdatedAt: bot.updatedAt,
                  })}
                >
                  <RiDeleteBinLine className="h-3.5 w-3.5" aria-hidden /> {deleting ? 'Deleting…' : 'Delete Permanently'}
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : null}

      {purgeResult && !purgeResult.complete ? (
        <div className="rounded-lg border border-[var(--status-warning)]/40 bg-[var(--status-warning)]/10 p-3" role="status">
          <p className="typography-ui-label font-medium text-foreground">Deletion needs cleanup</p>
          <p className="mt-1 typography-micro text-muted-foreground">Some protected resources could not be removed. Completed steps will not be repeated.</p>
          {purgeResult.retryable && onRetryPurge ? (
            <Button type="button" size="xs" variant="outline" className="mt-3" disabled={busyAction !== null} onClick={() => onRetryPurge(retryableStepIds)}>
              Retry Cleanup
            </Button>
          ) : null}
        </div>
      ) : null}

      {error ? <p role="alert" className="typography-ui text-[var(--status-error)]">{error}</p> : null}
    </section>
  );
};
