import React from 'react';

import type { QuestionRequest } from '@/types/question';
import type { State } from '@/sync/types';
import { useSyncChildStores } from '@/sync/sync-context';
import { isPendingQuestionOrphaned } from '@/sync/question-orphan';
import { getQuestionRequestKey } from './questionCardRouting';

const KEY_SEPARATOR = '\n';

/**
 * Keys of requests whose turn already stopped, joined into one primitive so the
 * subscription only re-renders when the orphaned set itself changes. Each
 * request is judged in whichever directory store holds it, so a card mixing
 * sessions from several worktrees still sees every orphan.
 */
export function computeOrphanedQuestionSignature(
    states: Iterable<Pick<State, 'question' | 'part' | 'message'>>,
    requests: readonly QuestionRequest[],
): string {
    if (requests.length === 0) return '';
    const snapshot = Array.from(states);
    const keys: string[] = [];
    for (const request of requests) {
        const owner = snapshot.find((state) => (
            state.question[request.sessionID]?.some((pending) => pending.id === request.id)
        ));
        if (owner && isPendingQuestionOrphaned(owner, request)) {
            keys.push(getQuestionRequestKey(request));
        }
    }
    return keys.join(KEY_SEPARATOR);
}

export function useOrphanedQuestionKeys(requests: readonly QuestionRequest[]): ReadonlySet<string> {
    const childStores = useSyncChildStores();
    const subscribe = React.useCallback(
        (notify: () => void) => childStores.subscribeAll(notify),
        [childStores],
    );
    const getSnapshot = React.useCallback(
        () => computeOrphanedQuestionSignature(
            Array.from(childStores.children.values(), (store) => store.getState()),
            requests,
        ),
        [childStores, requests],
    );
    const signature = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    return React.useMemo(
        () => new Set(signature ? signature.split(KEY_SEPARATOR) : []),
        [signature],
    );
}
