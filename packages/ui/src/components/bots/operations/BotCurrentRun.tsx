import React from 'react';
import { RiCloseLine, RiTimeLine } from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import type { BotRun } from '@/lib/botsApi';
import { useBotOperationsStore, type BotOperationsStore } from '@/stores/useBotOperationsStore';

const activeStates = new Set<BotRun['state']>([
  'queued', 'starting', 'running', 'waiting_approval', 'needs_reconciliation',
]);

export const BotCurrentRun: React.FC<{
  channelId: string;
  canCancel: boolean;
  operationsStore?: BotOperationsStore;
}> = ({ channelId, canCancel, operationsStore = useBotOperationsStore }) => {
  const { t } = useI18n();
  const runId = operationsStore((state) => {
    const ids = state.runIdsByChannelId[channelId] || [];
    for (let index = ids.length - 1; index >= 0; index -= 1) {
      const candidate = state.runsById[ids[index]];
      if (candidate && activeStates.has(candidate.state)) return candidate.id;
    }
    return null;
  });
  const run = operationsStore((state) => runId ? state.runsById[runId] : undefined);
  const [cancelling, setCancelling] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  if (!run) return null;

  return (
    <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2" role="status">
      <RiTimeLine className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
      <span className="min-w-0 flex-1 truncate typography-micro text-foreground">
        {run.state === 'waiting_approval' ? 'Waiting for confirmation' : t(`bots.run.${run.state}`)}
      </span>
      {failed ? <span className="typography-micro text-[var(--status-error)]">Cancel failed</span> : null}
      {canCancel ? (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-6 w-6"
          aria-label={t('bots.run.cancelAria')}
          disabled={cancelling}
          onClick={async () => {
            setCancelling(true);
            setFailed(false);
            try {
              await operationsStore.getState().cancelRun(run.id);
            } catch {
              setFailed(true);
            } finally {
              setCancelling(false);
            }
          }}
        >
          <RiCloseLine className="h-3.5 w-3.5" aria-hidden />
        </Button>
      ) : null}
    </div>
  );
};
