import type { State } from '@/sync/types';
import { isPendingQuestionOrphaned } from '@/sync/question-orphan';

interface SessionLinkRecord {
    id: string;
    parentID?: string;
}

type BlockingRequestRecord<T extends { id: string }> = Record<string, T[] | undefined>;

type BlockingRequestStateLike<Permission extends { id: string }, Question extends { id: string }> = {
    session?: SessionLinkRecord[];
    permission?: BlockingRequestRecord<Permission>;
    question?: BlockingRequestRecord<Question>;
};

export type ScopedBlockingRequests<Permission extends { id: string }, Question extends { id: string }> = {
    permissions: Permission[];
    questions: Question[];
};

export const collectVisibleSessionIdsForBlockingRequests = (
    sessions: SessionLinkRecord[] | undefined,
    currentSessionId: string | null,
): string[] => {
    if (!currentSessionId) return [];
    if (!Array.isArray(sessions) || sessions.length === 0) return [currentSessionId];

    const current = sessions.find((session) => session.id === currentSessionId);
    if (!current) return [currentSessionId];

    const childrenByParent = new Map<string, string[]>();
    for (const session of sessions) {
        if (!session.parentID) {
            continue;
        }
        const existing = childrenByParent.get(session.parentID) ?? [];
        existing.push(session.id);
        childrenByParent.set(session.parentID, existing);
    }

    const scoped = [currentSessionId];
    const seen = new Set(scoped);
    for (const sessionId of scoped) {
        const children = childrenByParent.get(sessionId) ?? [];
        for (const childId of children) {
            if (seen.has(childId)) {
                continue;
            }
            seen.add(childId);
            scoped.push(childId);
        }
    }

    return scoped;
};

export const flattenBlockingRequests = <T extends { id: string }>(
    source: Map<string, T[]>,
    sessionIds: string[],
): T[] => {
    if (sessionIds.length === 0) return [];
    const seen = new Set<string>();
    const result: T[] = [];

    for (const sessionId of sessionIds) {
        const entries = source.get(sessionId);
        if (!entries || entries.length === 0) continue;
        for (const entry of entries) {
            if (seen.has(entry.id)) continue;
            seen.add(entry.id);
            result.push(entry);
        }
    }

    return result;
};

export const flattenBlockingRequestsFromRecord = <T extends { id: string }>(
    source: BlockingRequestRecord<T> | undefined,
    sessionIds: string[],
): T[] => {
    if (!source || sessionIds.length === 0) return [];
    const seen = new Set<string>();
    const result: T[] = [];

    for (const sessionId of sessionIds) {
        const entries = source[sessionId];
        if (!entries || entries.length === 0) continue;
        for (const entry of entries) {
            if (seen.has(entry.id)) continue;
            seen.add(entry.id);
            result.push(entry);
        }
    }

    return result;
};

const areArraysSame = <T>(left: T[], right: T[]): boolean => {
    if (left === right) return true;
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) return false;
    }
    return true;
};

export function createScopedBlockingRequestsSelector<
    Permission extends { id: string },
    Question extends { id: string },
>(currentSessionId: string | null) {
    let previousSessionIds: string[] = [];
    let previousPermissions: Permission[] = [];
    let previousQuestions: Question[] = [];
    let previousResult: ScopedBlockingRequests<Permission, Question> = {
        permissions: [],
        questions: [],
    };

    return (
        state: BlockingRequestStateLike<Permission, Question>,
    ): ScopedBlockingRequests<Permission, Question> => {
        const sessionIds = collectVisibleSessionIdsForBlockingRequests(state.session, currentSessionId);
        const permissions = flattenBlockingRequestsFromRecord(state.permission, sessionIds);
        const questions = flattenBlockingRequestsFromRecord(state.question, sessionIds);

        if (
            areArraysSame(previousSessionIds, sessionIds)
            && areArraysSame(previousPermissions, permissions)
            && areArraysSame(previousQuestions, questions)
        ) {
            return previousResult;
        }

        previousSessionIds = sessionIds;
        previousPermissions = permissions;
        previousQuestions = questions;
        previousResult = { permissions, questions };
        return previousResult;
    };
}

/**
 * Whether a live question is pending on the session or any descendant — the
 * scope that shows the question card. Orphaned questions (their turn already
 * stopped) are ignored: nothing is waiting on them. Runs as a store selector on
 * streaming updates, so it builds the parent lookup only while a live question
 * exists outside the session itself.
 */
export function hasScopedPendingQuestions(
    state: Pick<State, 'session' | 'question' | 'part' | 'message'>,
    sessionId: string | null,
): boolean {
    if (!sessionId) return false;
    let liveQuestionSessionIds: string[] | null = null;
    for (const [questionSessionId, questions] of Object.entries(state.question)) {
        if (!questions?.some((question) => !isPendingQuestionOrphaned(state, question))) continue;
        if (questionSessionId === sessionId) return true;
        (liveQuestionSessionIds ??= []).push(questionSessionId);
    }
    if (!liveQuestionSessionIds) return false;

    const parentById = new Map<string, string>();
    for (const session of state.session) {
        if (session.parentID) parentById.set(session.id, session.parentID);
    }
    return liveQuestionSessionIds.some((questionSessionId) => {
        const visited = new Set<string>([questionSessionId]);
        let parentId = parentById.get(questionSessionId);
        while (parentId && !visited.has(parentId)) {
            if (parentId === sessionId) return true;
            visited.add(parentId);
            parentId = parentById.get(parentId);
        }
        return false;
    });
}
