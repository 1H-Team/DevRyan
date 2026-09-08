import React from 'react';
import type { Message, Session, SessionStatus } from '@opencode-ai/sdk/v2/client';

import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useIsGitRepo } from '@/stores/useGitStore';
import type { RevertTransaction } from '@/sync/revert-transactions';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useDirectorySync, useSessionMessagesResolved } from '@/sync/sync-context';
import { createSessionChangesTurnSelector } from './sessionChangesTurn';

/**
 * Live inputs for the session-changes footer, kept in one leaf module so the
 * footer's tests can swap them without mocking the sync layer process-wide.
 */
export type SessionChangesFooterSources = {
    currentSessionId: string | null;
    directory: string;
    sessions: readonly Session[];
    statuses: Readonly<Record<string, SessionStatus>>;
    revertTransactions: Readonly<Record<string, RevertTransaction | undefined>>;
    isGitRepo: boolean | null;
    isImplementationSettled: boolean;
};

export const useSessionChangesFooterSources = (): SessionChangesFooterSources => {
    const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
    const effectiveDirectory = useEffectiveDirectory();
    const directory = effectiveDirectory ?? '';
    const storeDirectory = directory || undefined;
    const sessions = useDirectorySync((state) => state.session, storeDirectory);
    const statuses = useDirectorySync((state) => state.session_status, storeDirectory);
    const revertTransactions = useDirectorySync((state) => state.revert_transaction, storeDirectory);
    const isGitRepo = useIsGitRepo(directory || null);
    const recordedPlanMessageId = useSessionUIStore((state) => currentSessionId
        ? state.planModeUserMessagesBySession.get(currentSessionId) : undefined);
    const selectSettledImplementation = React.useMemo(() => createSessionChangesTurnSelector(
        currentSessionId ?? '',
        (messageId) => messageId === recordedPlanMessageId,
    ), [currentSessionId, recordedPlanMessageId]);
    const settledImplementation = useDirectorySync(selectSettledImplementation, storeDirectory);
    const messagesResolved = useSessionMessagesResolved(currentSessionId ?? '', storeDirectory);
    const isImplementationSettled = messagesResolved && settledImplementation;

    return React.useMemo(() => ({
        currentSessionId,
        directory,
        sessions,
        statuses,
        revertTransactions,
        isGitRepo,
        isImplementationSettled,
    }), [currentSessionId, directory, sessions, statuses, revertTransactions, isGitRepo, isImplementationSettled]);
};

export const useSessionRootMessages = (
    rootSessionId: string | null,
    directory: string,
): readonly Message[] | undefined => useDirectorySync(
    React.useCallback((state) => (rootSessionId ? state.message[rootSessionId] : undefined), [rootSessionId]),
    directory || undefined,
);
