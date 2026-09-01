import React from 'react';
import { RiCloseLine, RiTimeLine } from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { useBotOperationsStore, type BotOperationsStore } from '@/stores/useBotOperationsStore';

import { selectBotCurrentRunId } from './selectBotCurrentRun';

export const BotCurrentRun: React.FC<{
  channelId: string;
  canCancel: boolean;
  operationsStore?: BotOperationsStore;
}> = ({ channelId, canCancel, operationsStore = useBotOperationsStore }) => {
  const { t } = useI18n();
  const runId = operationsStore((state) => selectBotCurrentRunId(state, channelId));
  const queuedCount = operationsStore((state) => (
    (state.runIdsByChannelId[channelId] ?? []).reduce((count, id) => (
      count + (id !== runId && state.runsById[id]?.state === 'queued' ? 1 : 0)
    ), 0)
  ));
  const run = operationsStore((state) => runId ? state.runsById[runId] : undefined);
  const [cancellingId, setCancellingId] = React.useState<string | null>(null);
  const [failedId, setFailedId] = React.useState<string | null>(null);

  if (!run) return null;

  return (
    <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2" role="status">
      <RiTimeLine className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
      <span className="min-w-0 flex-1 truncate typography-micro text-foreground">
        {run.state === 'waiting_approval' ? 'Waiting for confirmation' : t(`bots.run.${run.state}`)}
      </span>
      {queuedCount > 0 ? <span className="shrink-0 typography-micro text-muted-foreground">{queuedCount} queued</span> : null}
      {failedId === run.id ? <span className="typography-micro text-[var(--status-error)]">Cancel failed</span> : null}
      {canCancel ? (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-6 w-6"
          aria-label={t('bots.run.cancelAria')}
          disabled={cancellingId === run.id}
          onClick={async () => {
            setCancellingId(run.id);
            setFailedId(null);
            try {
              await operationsStore.getState().cancelRun(run.id);
            } catch {
              setFailedId(run.id);
            } finally {
              setCancellingId((id) => id === run.id ? null : id);
            }
          }}
        >
          <RiCloseLine className="h-3.5 w-3.5" aria-hidden />
        </Button>
      ) : null}
    </div>
  );
};
