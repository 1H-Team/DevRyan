import React from 'react';
import { RiErrorWarningLine, RiRefreshLine } from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { BotsApiError, getBotRetryReason, type BotRetryReason } from '@/lib/botsApi';
import { useBotChannelStore } from '@/stores/useBotChannelStore';
import { useBotOperationsStore } from '@/stores/useBotOperationsStore';

type BotRunFailureNoticeProps = {
  runId: string;
  channelId: string;
  sourceHasAttachments: boolean;
};

const isAttachmentFailure = (code: string | null) => Boolean(code && (
  code.startsWith('bot_attachment_')
  || code.startsWith('bot_artifact_')
  || code.startsWith('bot_shared_file_')
  || code.startsWith('bot_object_')
));

const failureMessageKey = (code: string | null) => {
  switch (code) {
    case 'bot_object_expired': return 'bots.chat.failure.reattach';
    case 'bot_shared_file_copy_failed':
    case 'bot_shared_file_copy_timeout':
    case 'bot_shared_file_integrity_failed':
    case 'bot_object_not_found': return 'bots.chat.failure.attachmentCopy';
    case 'bot_response_missing':
    case 'bot_response_incomplete':
    case 'bot_response_unverified': return 'bots.chat.failure.noAnswer';
    case 'bot_opencode_request_failed':
    case 'bot_opencode_request_aborted':
    case 'bot_agent_execution_lost':
    case 'bot_opencode_provider_unknown':
    case 'bot_opencode_api_retryable':
    case 'bot_opencode_message_aborted':
    case 'bot_agent_run_failed': return 'bots.chat.failure.providerTransient';
    case 'bot_action_invalid':
    case 'bot_gateway_operation_unavailable': return 'bots.chat.failure.actionInvalid';
    case 'bot_approval_expired':
    case 'bot_action_denied': return 'bots.chat.failure.approvalExpired';
    case 'bot_run_context_missing':
    case 'bot_message_not_found': return 'bots.chat.failure.retryMissing';
    case 'bot_runtime_scope_busy': return 'bots.chat.failure.retryBusy';
    case 'bot_opencode_provider_authentication': return 'bots.chat.failure.authentication';
    case 'bot_oauth_coordinator_unavailable':
    case 'bot_oauth_runtime_update_required':
    case 'bot_oauth_refresh_unavailable':
    case 'bot_oauth_persistence_failed': return 'bots.chat.failure.runtimeUnavailable';
    case 'bot_compiled_config_conflict':
    case 'bot_compiled_config_invalid':
    case 'bot_runtime_scoped_file_invalid': return 'bots.chat.failure.configuration';
    case 'bot_opencode_content_filter': return 'bots.chat.failure.contentFilter';
    case 'bot_opencode_api_rejected': return 'bots.chat.failure.rejected';
    case 'bot_run_timeout':
    case 'bot_opencode_request_timeout': return 'bots.chat.failure.timeout';
    case 'bots_unavailable':
    case 'bot_runtime_docker_unavailable':
    case 'bot_agent_adapter_unavailable':
    case 'bot_runtime_supervisor_unavailable':
    case 'bot_browser_recovery_failed':
    case 'bot_opencode_start_timeout': return 'bots.chat.failure.runtimeUnavailable';
    default: return isAttachmentFailure(code)
      ? 'bots.chat.failure.attachments'
      : 'bots.chat.failure.generic';
  }
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
  const messageKey = failureMessageKey(run.interruptionKind);

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
