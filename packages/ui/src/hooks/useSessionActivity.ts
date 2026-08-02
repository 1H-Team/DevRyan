import React from 'react';
import type { Message, SessionStatus } from '@opencode-ai/sdk/v2/client';
import { useProviderRecoveryStore } from '@/stores/useProviderRecoveryStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { isSessionWorkingFromState } from '@/sync/session-working';
import { useStreamingStore } from '@/sync/streaming';
import { useSessionStatus, useSessionMessages, useSessionPermissions, useSessionQuestions } from '@/sync/sync-context';

// Mirrors OpenCode SessionStatus: busy|retry|idle.
export type SessionActivityPhase = 'idle' | 'busy' | 'retry';

export interface SessionActivityResult {
  phase: SessionActivityPhase;
  isWorking: boolean;
  isBusy: boolean;
  isCooldown: boolean;
}

const IDLE_RESULT: SessionActivityResult = {
  phase: 'idle',
  isWorking: false,
  isBusy: false,
  isCooldown: false,
};

export function resolveSessionActivityState({
  sessionId,
  status,
  messages,
  permissions,
  questions,
  liveStreamingMessageId,
  hasProviderRecovery = false,
}: {
  sessionId: string | null | undefined;
  status: SessionStatus | undefined;
  messages: readonly Message[];
  permissions: readonly unknown[];
  questions: readonly unknown[];
  liveStreamingMessageId?: string | null;
  hasProviderRecovery?: boolean;
}): SessionActivityResult {
  if (!sessionId) return IDLE_RESULT;
  if (hasProviderRecovery) return IDLE_RESULT;

  // Pending permissions or questions take priority over working state.
  if (permissions.length > 0) return IDLE_RESULT;
  if (questions.length > 0) return IDLE_RESULT;

  const phase: SessionActivityPhase = (status?.type ?? 'idle') as SessionActivityPhase;
  const isWorking = isSessionWorkingFromState({ status, permissions, messages, liveStreamingMessageId });

  if (!isWorking) return IDLE_RESULT;

  const hasAuthoritativeStatus = status !== undefined;
  const statusWorking = hasAuthoritativeStatus && phase !== 'idle';

  return {
    phase: statusWorking ? phase : 'busy',
    isWorking: true,
    isBusy: phase === 'busy' || !statusWorking,
    isCooldown: false,
  };
}

/**
 * Determines if a session is actively working.
 * Checks session_status and, only when status is missing, falls back to the
 * trailing assistant message when its completion update has not landed yet.
 * Returns idle when permissions or questions are pending because their blocking
 * indicators take priority over working state.
 */
export function useSessionActivity(sessionId: string | null | undefined, directory?: string): SessionActivityResult {
  const status = useSessionStatus(sessionId ?? '', directory);
  const messages = useSessionMessages(sessionId ?? '', directory);
  const permissions = useSessionPermissions(sessionId ?? '', directory);
  const questions = useSessionQuestions(sessionId ?? '', directory);
  const liveStreamingMessageId = useStreamingStore(
    React.useCallback(
      (state) => (sessionId ? state.streamingMessageIds.get(sessionId) ?? null : null),
      [sessionId],
    ),
  );
  const hasProviderRecovery = useProviderRecoveryStore(
    React.useCallback(
      (state) => Boolean(sessionId && state.recoveriesBySessionId[sessionId]),
      [sessionId],
    ),
  );

  return React.useMemo<SessionActivityResult>(() => {
    return resolveSessionActivityState({
      sessionId,
      status,
      messages,
      permissions,
      questions,
      liveStreamingMessageId,
      hasProviderRecovery,
    });
  }, [
    sessionId,
    status,
    messages,
    permissions,
    questions,
    liveStreamingMessageId,
    hasProviderRecovery,
  ]);
}

export function useCurrentSessionActivity(): SessionActivityResult {
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentSessionDirectory = useSessionUIStore(
    React.useCallback(
      (state) => (currentSessionId ? state.getDirectoryForSession(currentSessionId) : null),
      [currentSessionId],
    ),
  );
  return useSessionActivity(currentSessionId, currentSessionDirectory ?? undefined);
}
