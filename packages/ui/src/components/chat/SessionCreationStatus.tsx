import React from 'react';
import { forgetCreationAttempt, useSessionCreationStore, type CreationAttempt } from '@/sync/session-creation';
import { useSessionUIStore } from '@/sync/session-ui-store';

export function SessionCreationRecoveryContent({ attempt, onRetry, confirmRetry, onConfirmRetryChange }: {
    attempt: CreationAttempt;
    onRetry: () => void;
    confirmRetry: boolean;
    onConfirmRetryChange: (confirm: boolean) => void;
}) {
    return (
        <div role="status" aria-live="polite" className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground">
            <span>{attempt.phase === 'created' ? 'A session was created. Your draft is retained.' : 'Creation outcome is unknown. A session may already exist; your draft is retained.'}</span>
            {attempt.sessionId && <button type="button" className="underline" onClick={() => useSessionUIStore.getState().setCurrentSession(attempt.sessionId!, attempt.directoryHint)}>Open Session</button>}
            {!confirmRetry ? <button type="button" className="underline" onClick={() => onConfirmRetryChange(true)}>Retry as New Session</button> : <>
                <span>This may create a duplicate session.</span>
                <button type="button" className="underline" onClick={() => { forgetCreationAttempt(attempt.draftId, attempt.id); onRetry(); }}>Confirm Retry as New Session</button>
                <button type="button" className="underline" onClick={() => onConfirmRetryChange(false)}>Keep Draft</button>
            </>}
        </div>
    );
}

export function SessionCreationRecoveryStatus({ attempt, onRetry }: {
    attempt: CreationAttempt;
    onRetry: () => void;
}) {
    const [confirmRetry, setConfirmRetry] = React.useState(false);
    React.useEffect(() => {
        setConfirmRetry(false);
    }, [attempt.id]);
    return <SessionCreationRecoveryContent
        attempt={attempt}
        onRetry={onRetry}
        confirmRetry={confirmRetry}
        onConfirmRetryChange={setConfirmRetry}
    />;
}

export const SessionCreationStatus = React.memo(function SessionCreationStatus({ draftId, onRetry }: {
    draftId: string | null;
    onRetry: () => void;
}) {
    const attempt = useSessionCreationStore((state) => draftId ? state.attempts[draftId] : undefined);
    if (!attempt || attempt.phase === 'failed' || attempt.phase === 'preparing' || attempt.phase === 'creating') return null;
    return <SessionCreationRecoveryStatus attempt={attempt} onRetry={onRetry} />;
});
