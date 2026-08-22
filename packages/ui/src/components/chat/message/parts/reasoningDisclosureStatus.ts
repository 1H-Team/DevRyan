import React from 'react';

const activeCountsBySession = new Map<string, number>();
const listenersBySession = new Map<string, Set<() => void>>();

const notifySession = (sessionID: string): void => {
    listenersBySession.get(sessionID)?.forEach((listener) => listener());
};

export const hasActiveReasoningDisclosure = (sessionID: string | null | undefined): boolean => (
    Boolean(sessionID && (activeCountsBySession.get(sessionID) ?? 0) > 0)
);

export const registerActiveReasoningDisclosure = (sessionID: string): (() => void) => {
    const previousCount = activeCountsBySession.get(sessionID) ?? 0;
    activeCountsBySession.set(sessionID, previousCount + 1);
    if (previousCount === 0) {
        notifySession(sessionID);
    }

    let registered = true;
    return () => {
        if (!registered) return;
        registered = false;

        const currentCount = activeCountsBySession.get(sessionID) ?? 0;
        if (currentCount <= 1) {
            activeCountsBySession.delete(sessionID);
            notifySession(sessionID);
            return;
        }
        activeCountsBySession.set(sessionID, currentCount - 1);
    };
};

const subscribeToSession = (
    sessionID: string | null | undefined,
    listener: () => void,
): (() => void) => {
    if (!sessionID) return () => undefined;
    const listeners = listenersBySession.get(sessionID) ?? new Set<() => void>();
    listeners.add(listener);
    listenersBySession.set(sessionID, listeners);
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
            listenersBySession.delete(sessionID);
        }
    };
};

export const useHasActiveReasoningDisclosure = (
    sessionID: string | null | undefined,
): boolean => {
    const subscribe = React.useCallback(
        (listener: () => void) => subscribeToSession(sessionID, listener),
        [sessionID],
    );
    const getSnapshot = React.useCallback(
        () => hasActiveReasoningDisclosure(sessionID),
        [sessionID],
    );
    return React.useSyncExternalStore(subscribe, getSnapshot, () => false);
};
