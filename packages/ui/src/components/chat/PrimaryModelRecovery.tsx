import { SessionFailureNotice } from './SessionFailureNotice';
import React from 'react';

import { INTERRUPTED_PROVIDER_RESPONSE_REASON } from '@/hooks/providerErrorRecoveryDecision';
import { useI18n } from '@/lib/i18n';
import { getProviderUsageLimitDisplayReason } from '@/lib/messages/providerRecovery';
import { useConfigStore } from '@/stores/useConfigStore';
import {
  providerRecoverySelector,
  useProviderRecoveryStore,
  type ProviderRecoverySelection,
} from '@/stores/useProviderRecoveryStore';
import { executeProviderRecovery } from '@/sync/transient-retry';
import {
  PROVIDER_INFERENCE_STALL_REASON,
  PROVIDER_TOOL_INPUT_STALL_REASON,
} from '@/sync/provider-stall-recovery';
import { ModelRecoveryCard } from './ModelRecoveryCard';
import { HostPrimaryRecovery } from './HostPrimaryRecovery';
import { primaryRecoveryDefersToHost, usePrimaryRecoveryStore } from '@/stores/usePrimaryRecoveryStore';

export const PrimaryModelRecovery = React.memo(({
  sessionId,
  onContentChange,
}: {
  sessionId: string;
  onContentChange?: () => void;
}) => {
  const { t } = useI18n();
  const recovery = useProviderRecoveryStore(React.useMemo(
    () => providerRecoverySelector(sessionId),
    [sessionId],
  ));
  const providers = useConfigStore((state) => state.providers);
  const defersToHost = usePrimaryRecoveryStore((state) => primaryRecoveryDefersToHost(state.snapshots[sessionId]));

  React.useLayoutEffect(() => {
    if (recovery) onContentChange?.();
  }, [onContentChange, recovery]);

  if (!recovery || defersToHost) return <><SessionFailureNotice sessionId={sessionId} /><HostPrimaryRecovery sessionId={sessionId} /></>;

  const usageLimitReason = getProviderUsageLimitDisplayReason(recovery.reason);
  const setSelection = (selection: ProviderRecoverySelection) => {
    useProviderRecoveryStore.getState().setSelection(sessionId, selection);
  };
  const retry = async (selection: ProviderRecoverySelection) => {
    const current = useProviderRecoveryStore.getState().recoveriesBySessionId[sessionId];
    if (!current || current.pending) return;
    useProviderRecoveryStore.getState().setActionState(sessionId, true, null);
    try {
      const sent = await executeProviderRecovery({ ...current, selection });
      if (!sent) throw new Error('The failed turn could not be retried.');
      useProviderRecoveryStore.getState().clearRecovery(sessionId, current);
    } catch (error) {
      useProviderRecoveryStore.getState().setActionState(
        sessionId,
        false,
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  return (
    <><SessionFailureNotice sessionId={sessionId} /><HostPrimaryRecovery sessionId={sessionId} showAvailability /><ModelRecoveryCard
      title={t('chat.modelRecovery.primaryPrompt')}
      originalModelLabel={`${recovery.providerId} / ${recovery.modelId}`}
      providers={providers}
      selection={recovery.selection}
      pending={recovery.pending}
      actionError={recovery.actionError}
      failureMessage={usageLimitReason
        ? t('chat.modelRecovery.usageLimitStopped', { detail: usageLimitReason })
        : recovery.reason === INTERRUPTED_PROVIDER_RESPONSE_REASON
          ? t('chat.modelRecovery.interrupted')
          : recovery.reason === PROVIDER_TOOL_INPUT_STALL_REASON
            ? t('chat.modelRecovery.toolInputStall')
          : recovery.reason === PROVIDER_INFERENCE_STALL_REASON
            ? t('chat.modelRecovery.inferenceStall')
        : null}
      onSelectionChange={setSelection}
      onRetry={retry}
    /></>
  );
});

PrimaryModelRecovery.displayName = 'PrimaryModelRecovery';
