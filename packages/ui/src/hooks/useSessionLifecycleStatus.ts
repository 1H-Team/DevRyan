import React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import { useSessionQuestions } from '@/sync/sync-context';
import { useAssistantStatus } from './useAssistantStatus';
import { resolveEffectivePlanIndicatorState } from '@/sync/plan-indicator';
import {
  deriveSessionLifecycleStatus,
  type AssistantActivity,
  type PlanIndicatorPhase,
  type SessionLifecycleStatus,
} from '@/lib/sessionLifecycleStatus';

/**
 * Single per-session status the sidebar indicator (and the future plan card)
 * subscribe to. Composes:
 *   - plan-mode toggle (useSelectionStore.getSessionPlanMode)
 *   - pending questions (useSessionQuestions)
 *   - plan-indicator phase (useSessionUIStore.sessionPlanIndicator)
 *   - assistant activity (useAssistantStatus)
 *   - SDK session-status error
 *
 * Pass `directory` only when reading a status for a session that lives in a
 * non-current directory (otherwise the default sync directory is used).
 */
export function useSessionLifecycleStatus(
  sessionId: string | null | undefined,
  directory?: string,
): SessionLifecycleStatus {
  const planModeOn = useSelectionStore(
    React.useCallback(
      (state) => (sessionId ? state.getSessionPlanMode(sessionId) : false),
      [sessionId],
    ),
  );

  const sessionQuestions = useSessionQuestions(sessionId ?? '', directory);
  const questionCount = sessionQuestions.length;

  const planIndicatorState = useSessionUIStore(
    React.useCallback(
      (state): PlanIndicatorPhase => {
        if (!sessionId) return null;
        return resolveEffectivePlanIndicatorState(
          state.sessionPlanIndicator.get(sessionId),
          state.planModeUserMessagesBySession.get(sessionId),
        );
      },
      [sessionId],
    ),
  );

  const { working } = useAssistantStatus(sessionId ?? undefined, directory);
  const assistantActivity: AssistantActivity = working.activity;

  // TODO(plan-card-rebuild): wire a per-session error signal here. The SDK's
  // SessionStatus enum is { idle, busy, retry } — error events flow through
  // notification-store, not session_status, so there's no clean per-session
  // error to read yet. Leaving null until a session-error store field exists.
  const sdkSessionStatusError = null;

  return React.useMemo(
    () =>
      deriveSessionLifecycleStatus({
        planModeOn,
        questionCount,
        planIndicatorState,
        assistantActivity,
        sdkSessionStatusError,
      }),
    [planModeOn, questionCount, planIndicatorState, assistantActivity, sdkSessionStatusError],
  );
}
