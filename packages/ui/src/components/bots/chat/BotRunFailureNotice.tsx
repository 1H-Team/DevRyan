import React from 'react';
import { RiErrorWarningLine, RiRefreshLine } from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { useBotChannelStore } from '@/stores/useBotChannelStore';
import { useBotOperationsStore } from '@/stores/useBotOperationsStore';

type BotRunFailureNoticeProps = {
  runId: string;
  channelId: string;
  sourceHasAttachments: boolean;
};

const RUNTIME_CONFIGURATION_FAILURES = new Set([
  'bot_compiled_config_conflict',
  'bot_compiled_config_invalid',
  'bot_runtime_scoped_file_invalid',
]);

export const BotRunFailureNotice: React.FC<BotRunFailureNoticeProps> = ({
  runId,
  channelId,
  sourceHasAttachments,
}) => {
  const { t } = useI18n();
  const run = useBotOperationsStore((state) => state.runsById[runId]);
  const channelPending = useBotChannelStore((state) => (
    Boolean(state.pendingMessageIdByChannelId[channelId])
  ));
  const sendErrorCode = useBotChannelStore((state) => state.sendErrorCodeByChannelId[channelId]);
  const [retryPending, setRetryPending] = React.useState(false);
  const [retryFailed, setRetryFailed] = React.useState(false);

  if (!run || (run.state !== 'failed' && run.state !== 'interrupted')) return null;
  const retryable = run.retryable;
  const messageKey = run.interruptionKind === 'bot_object_expired'
    ? 'bots.chat.failure.reattach'
    : run.interruptionKind === 'bot_opencode_provider_authentication'
    ? 'bots.chat.failure.authentication'
    : run.interruptionKind && RUNTIME_CONFIGURATION_FAILURES.has(run.interruptionKind)
      ? 'bots.chat.failure.configuration'
    : run.interruptionKind === 'bot_opencode_content_filter'
      ? 'bots.chat.failure.contentFilter'
      : run.interruptionKind === 'bot_opencode_api_rejected'
        ? 'bots.chat.failure.rejected'
        : sourceHasAttachments
          ? 'bots.chat.failure.attachments'
          : 'bots.chat.failure.generic';

  return (
    <div
      className="ml-[68px] flex items-start gap-2 rounded-xl border border-[var(--status-error)]/30 bg-[var(--status-error)]/5 px-3 py-2.5"
      role="alert"
      data-bot-run-failure={run.id}
    >
      <RiErrorWarningLine className="mt-0.5 h-4 w-4 shrink-0 text-[var(--status-error)]" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="typography-ui-label text-foreground">{t(messageKey)}</p>
        {retryFailed ? (
          <p className="mt-1 typography-micro text-[var(--status-error)]">
            {t(sendErrorCode === 'bot_object_expired'
              ? 'bots.chat.failure.reattach'
              : 'bots.chat.failure.retryFailed')}
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
            setRetryFailed(false);
            try {
              await useBotChannelStore.getState().retryRun(run.id);
            } catch {
              setRetryFailed(true);
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
