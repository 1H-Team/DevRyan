import React from 'react';

import { INTERRUPTED_PROVIDER_RESPONSE_REASON } from '@/hooks/providerErrorRecoveryDecision';
import { useI18n } from '@/lib/i18n';
import { getProviderUsageLimitDisplayReason } from '@/lib/messages/providerRecovery';
import {
  executeClaudeAwareProviderRecovery,
  requiresClaudeCompatibilityRecovery,
} from '@/lib/messages/claudeCompatibilityRecovery';
import { isClaudeThirdPartyUsageClassificationError } from '@/lib/messages/claudeThirdPartyUsage';
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
import { usePrimaryRecoveryStore } from '@/stores/usePrimaryRecoveryStore';

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
  const hostEnforced = usePrimaryRecoveryStore((state) => {
    const snapshot = state.snapshots[sessionId];
    return Boolean(snapshot?.record && (snapshot.enforced || snapshot.record.readOnly));
  });

  React.useLayoutEffect(() => {
    if (recovery) onContentChange?.();
  }, [onContentChange, recovery]);

  if (!recovery || hostEnforced) return <HostPrimaryRecovery sessionId={sessionId} />;

  const usageLimitReason = getProviderUsageLimitDisplayReason(recovery.reason);
  const isClaudeClassificationError = isClaudeThirdPartyUsageClassificationError(recovery.reason);
  const needsClaudeCompatibility = requiresClaudeCompatibilityRecovery(
    recovery.reason,
    recovery.selection.providerId,
  );
  const setSelection = (selection: ProviderRecoverySelection) => {
    useProviderRecoveryStore.getState().setSelection(sessionId, selection);
  };
  const retry = async (selection: ProviderRecoverySelection) => {
    const current = useProviderRecoveryStore.getState().recoveriesBySessionId[sessionId];
    if (!current || current.pending) return;
    useProviderRecoveryStore.getState().setActionState(sessionId, true, null);
    try {
      const sent = await executeClaudeAwareProviderRecovery({ ...current, selection }, executeProviderRecovery);
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
    <><HostPrimaryRecovery sessionId={sessionId} showAvailability /><ModelRecoveryCard
      title={isClaudeClassificationError
        ? t('chat.modelRecovery.claudeCompatibilityPrompt')
        : t('chat.modelRecovery.primaryPrompt')}
      originalModelLabel={`${recovery.providerId} / ${recovery.modelId}`}
      providers={providers}
      selection={recovery.selection}
      pending={recovery.pending}
      actionError={recovery.actionError}
      failureMessage={isClaudeClassificationError
        ? t('chat.modelRecovery.claudeThirdPartyUsage')
        : usageLimitReason
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
      retryLabel={needsClaudeCompatibility
        ? t('chat.modelRecovery.enableCompatibilityRetry')
        : undefined}
      retryingLabel={needsClaudeCompatibility
        ? t('chat.modelRecovery.enablingCompatibility')
        : undefined}
    /></>
  );
});

PrimaryModelRecovery.displayName = 'PrimaryModelRecovery';
