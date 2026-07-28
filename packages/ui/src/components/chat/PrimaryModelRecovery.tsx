import React from 'react';

import { useI18n } from '@/lib/i18n';
import { getProviderUsageLimitDisplayReason } from '@/lib/messages/providerRecovery';
import { useConfigStore } from '@/stores/useConfigStore';
import {
  providerRecoverySelector,
  useProviderRecoveryStore,
  type ProviderRecoverySelection,
} from '@/stores/useProviderRecoveryStore';
import { executeProviderRecovery } from '@/sync/transient-retry';
import { ModelRecoveryCard } from './ModelRecoveryCard';

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

  React.useLayoutEffect(() => {
    if (recovery) onContentChange?.();
  }, [onContentChange, recovery]);

  if (!recovery) return null;

  const usageLimitReason = getProviderUsageLimitDisplayReason(recovery.reason);
  const setSelection = (selection: ProviderRecoverySelection) => {
    useProviderRecoveryStore.getState().setSelection(sessionId, selection);
  };
  const retry = async () => {
    const current = useProviderRecoveryStore.getState().recoveriesBySessionId[sessionId];
    if (!current || current.pending) return;
    useProviderRecoveryStore.getState().setActionState(sessionId, true, null);
    try {
      const sent = await executeProviderRecovery(current);
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
    <ModelRecoveryCard
      title={t('chat.modelRecovery.primaryPrompt')}
      originalModelLabel={`${recovery.providerId} / ${recovery.modelId}`}
      providers={providers}
      selection={recovery.selection}
      pending={recovery.pending}
      actionError={recovery.actionError}
      failureMessage={usageLimitReason
        ? t('chat.modelRecovery.usageLimitStopped', { detail: usageLimitReason })
        : null}
      onSelectionChange={setSelection}
      onRetry={retry}
    />
  );
});

PrimaryModelRecovery.displayName = 'PrimaryModelRecovery';
