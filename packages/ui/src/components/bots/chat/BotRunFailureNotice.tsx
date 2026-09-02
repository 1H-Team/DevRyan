import React from 'react';
import { RiErrorWarningLine, RiRefreshLine } from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import {
  BotsApiError,
  getBotRetryReason,
  type BotRetryReason,
} from '@/lib/botsApi';
import { useBotChannelStore } from '@/stores/useBotChannelStore';
import { useBotOperationsStore } from '@/stores/useBotOperationsStore';
import { resolveBotRunFailureMessageKey } from '../botPresentation';

type BotRunFailureNoticeProps = {
  runId: string;
  channelId: string;
  sourceHasAttachments: boolean;
};

const retryMessageKeys = {
  not_found: 'bots.chat.failure.retryMissing',
  wrong_actor: 'bots.chat.failure.retryWrongActor',
  not_retryable: 'bots.chat.failure.retryUnsafe',
  execution_started: 'bots.chat.failure.retryUnsafe',
  revision_changed: 'bots.chat.failure.retryRevisionChanged',
  channel_unavailable: 'bots.chat.failure.retryAccessLost',
  access_revoked: 'bots.chat.failure.retryAccessLost',
  concurrent_active_run: 'bots.chat.failure.retryBusy',
  attachments_expired: 'bots.chat.failure.reattach',
} as const;

export const BotRunFailureNotice: React.FC<BotRunFailureNoticeProps> = ({
  runId,
  channelId,
}) => {
  const { t } = useI18n();
  const run = useBotOperationsStore((state) => state.runsById[runId]);
  const channelPending = useBotChannelStore((state) => (
    Boolean(state.pendingMessageIdByChannelId[channelId])
  ));
  const [retryPending, setRetryPending] = React.useState(false);
  const [retryFailure, setRetryFailure] = React.useState<{ reason: BotRetryReason | null } | null>(null);
  React.useEffect(() => { setRetryFailure(null); }, [runId]);

  if (!run || (run.state !== 'failed' && run.state !== 'interrupted')) return null;
  const retryable = run.retryable && (!retryFailure?.reason || retryFailure.reason === 'concurrent_active_run');
  const messageKey = resolveBotRunFailureMessageKey(run.interruptionKind, run.failurePhase ?? null);

  return (
    <div
      className="flex items-start gap-2 rounded-xl border border-[var(--status-error)]/30 bg-[var(--status-error)]/5 px-3 py-2.5"
      role="alert"
      data-bot-run-failure={run.id}
    >
      <RiErrorWarningLine className="mt-0.5 h-4 w-4 shrink-0 text-[var(--status-error)]" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="typography-ui-label text-foreground">{t(messageKey)}</p>
        {retryFailure ? (
          <p className="mt-1 typography-micro text-[var(--status-error)]">
            {t(retryFailure.reason ? retryMessageKeys[retryFailure.reason] : 'bots.chat.failure.retryFailed')}
          </p>
        ) : null}
      </div>
      {retryable ? (
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={retryPending || channelPending}
          onClick={async () => {
            setRetryPending(true);
            setRetryFailure(null);
            try {
              await useBotChannelStore.getState().retryRun(run.id);
            } catch (error) {
              let reason = getBotRetryReason(error);
              if (!reason && error instanceof BotsApiError) {
                if (error.status === 403) reason = 'access_revoked';
                else if (error.code === 'bot_object_expired') reason = 'attachments_expired';
                else if (error.status === 409) reason = 'not_retryable';
              }
              setRetryFailure({ reason });
            } finally {
              setRetryPending(false);
            }
          }}
        >
          <RiRefreshLine /> {t('bots.chat.failure.retry')}
        </Button>
      ) : null}
    </div>
  );
};
