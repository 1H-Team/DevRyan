import React from 'react';
import { managedOrchestrationApi } from '@/lib/orchestrationApi';
import { useI18n } from '@/lib/i18n';
import { objectiveVerificationKey, useObjectiveVerificationStore } from '@/stores/useObjectiveVerificationStore';
import { VerificationDetails } from './ManagedTaskVerification';

/** The server selects the current root objective; the client cannot select an older one. */
export function ObjectiveVerification({ sessionId, directory, revision }: { sessionId: string; directory: string | null; revision: string }) {
  const { t } = useI18n();
  const translate = React.useRef(t);
  translate.current = t;
  const key = directory ? objectiveVerificationKey(sessionId, directory) : '';
  const entry = useObjectiveVerificationStore(state => state.entries[key]);
  const verification = entry?.status === 'confirmed' ? entry.proof?.verification : null;
  const refresh = React.useCallback(async (strict = false) => {
    const proof = directory ? await useObjectiveVerificationStore.getState().refresh(sessionId, directory, { force: strict }) : null;
    if (strict && !proof) throw new Error(translate.current('chat.managedTasks.verification.refreshFailed'));
  }, [directory, sessionId]);
  React.useEffect(() => { void refresh(); }, [refresh, revision]);
  if (!verification || !directory || !verification.objectiveId || !verification.checks.length) return null;
  return <section data-objective-verification={verification.objectiveId} className="chat-message-column py-2">
    <h3 className="typography-ui-label font-medium">{t('chat.managedTasks.verification.objectiveTitle')}</h3>
    <VerificationDetails verification={verification} submitWaiver={async (checks, reason) => {
      if (!managedOrchestrationApi.waiveObjectiveVerification || !verification.objectiveId) throw new Error(t('chat.managedTasks.verification.waiverFailed'));
      await managedOrchestrationApi.waiveObjectiveVerification({ rootSessionId: sessionId, directory, objectiveId: verification.objectiveId, checks, reason });
      await refresh(true);
    }} />
  </section>;
}
