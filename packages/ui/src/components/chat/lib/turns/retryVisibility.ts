import * as React from 'react';

export const RETRY_VISIBILITY_GRACE_MS = 1200;
export const TRANSIENT_PROVIDER_RETRY_VISIBILITY_GRACE_MS = 10_000;

const TRANSIENT_PROVIDER_RESPONSE_HEADER_TIMEOUT = /provider response headers timed out after/i;

export interface RetryVisibilityStatus {
    sessionId: string;
    message: string;
    confirmedAt?: number;
    attempt?: number;
    next?: number;
}

export interface RetryVisibilityState {
    identity: string;
    firstSeenAt: number;
    visibleSessionId?: string | null;
}

export const getRetryVisibilityIdentity = (retry: RetryVisibilityStatus): string => {
    return [
        retry.sessionId,
        retry.message,
        typeof retry.attempt === 'number' ? retry.attempt : '',
        typeof retry.next === 'number' ? retry.next : '',
    ].join('\u0000');
};

export const getRetryVisibilityStartTime = (retry: RetryVisibilityStatus, observedAt: number): number => {
    return typeof retry.confirmedAt === 'number' ? retry.confirmedAt : observedAt;
};

export const getRetryVisibilityGraceMs = (retry: RetryVisibilityStatus): number => {
    return TRANSIENT_PROVIDER_RESPONSE_HEADER_TIMEOUT.test(retry.message)
        ? TRANSIENT_PROVIDER_RETRY_VISIBILITY_GRACE_MS
        : RETRY_VISIBILITY_GRACE_MS;
};

export const shouldShowRetryVisibility = (
    retry: RetryVisibilityStatus | null,
    state: RetryVisibilityState | null,
    now: number,
    graceMs?: number,
): boolean => {
    if (!retry || !state) {
        return false;
    }

    if (state.visibleSessionId === retry.sessionId) {
        return true;
    }

    if (getRetryVisibilityIdentity(retry) !== state.identity) {
        return false;
    }

    const effectiveGraceMs = typeof graceMs === 'number' ? graceMs : getRetryVisibilityGraceMs(retry);
    return now - state.firstSeenAt >= effectiveGraceMs;
};

export const useRetryVisibility = <T extends RetryVisibilityStatus>(retry: T | null): T | null => {
    const [visibleSessionId, setVisibleSessionId] = React.useState<string | null>(null);
    const stateRef = React.useRef<RetryVisibilityState | null>(null);
    const identity = retry ? getRetryVisibilityIdentity(retry) : null;
    const confirmedAt = retry?.confirmedAt;
    const sessionId = retry?.sessionId ?? null;
    const retryGraceMs = retry ? getRetryVisibilityGraceMs(retry) : RETRY_VISIBILITY_GRACE_MS;

    React.useEffect(() => {
        if (!identity || !sessionId) {
            stateRef.current = null;
            setVisibleSessionId(null);
            return;
        }

        if (stateRef.current?.visibleSessionId === sessionId) {
            stateRef.current = {
                identity,
                firstSeenAt: stateRef.current.firstSeenAt,
                visibleSessionId: sessionId,
            };
            setVisibleSessionId(sessionId);
            return;
        }

        const now = Date.now();
        const observedAt = typeof confirmedAt === 'number' ? confirmedAt : now;
        const firstSeenAt = stateRef.current?.identity === identity
            ? Math.min(stateRef.current.firstSeenAt, observedAt)
            : observedAt;

        stateRef.current = { identity, firstSeenAt, visibleSessionId: null };

        const remainingMs = retryGraceMs - (now - firstSeenAt);
        if (remainingMs <= 0) {
            stateRef.current = { identity, firstSeenAt, visibleSessionId: sessionId };
            setVisibleSessionId(sessionId);
            return;
        }

        setVisibleSessionId(null);
        const timeout = setTimeout(() => {
            if (stateRef.current?.identity === identity) {
                stateRef.current = { identity, firstSeenAt, visibleSessionId: sessionId };
                setVisibleSessionId(sessionId);
            }
        }, remainingMs);

        return () => clearTimeout(timeout);
    }, [confirmedAt, identity, retryGraceMs, sessionId]);

    if (!retry) {
        return null;
    }

    return visibleSessionId === retry.sessionId ? retry : null;
};
