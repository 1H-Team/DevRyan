import {
    projectPlanRevisions,
    type PlanRevision,
    type PlanRevisionTurnInput,
} from '@/lib/messages/planRevisions';

import type {
    PlanRevisionMessageRole,
    PlanTurnTraceEntry,
    PlanTurnTraceIndex,
    TurnRecord,
} from './types';

interface ProjectPlanTurnTraceIndexOptions {
    previousIndex?: PlanTurnTraceIndex | null;
    recordedPlanModeMessageIds?: ReadonlySet<string>;
}

const areStringArraysEqual = (left: string[], right: string[]): boolean => {
    if (left === right) return true;
    if (left.length !== right.length) return false;
    return left.every((value, index) => value === right[index]);
};

const areTraceEntriesEqual = (left: PlanTurnTraceEntry, right: PlanTurnTraceEntry): boolean => (
    left.sessionId === right.sessionId
    && left.planVersion === right.planVersion
    && left.turnId === right.turnId
    && left.userMessageId === right.userMessageId
    && areStringArraysEqual(left.memberTurnIds, right.memberTurnIds)
    && left.sourceTurnId === right.sourceTurnId
    && left.isPlanModeRevision === right.isPlanModeRevision
    && left.assistantSourceMessageId === right.assistantSourceMessageId
    && left.assistantParentMessageId === right.assistantParentMessageId
    && left.completedAt === right.completedAt
    && left.isLatestPlan === right.isLatestPlan
    && left.isSuperseded === right.isSuperseded
    && left.isSettled === right.isSettled
    && left.isActionable === right.isActionable
);

const areMessageRoleMapsEqual = (
    left: Map<string, PlanRevisionMessageRole>,
    right: Map<string, PlanRevisionMessageRole>,
): boolean => {
    if (left.size !== right.size) return false;
    for (const [messageId, role] of left) {
        if (right.get(messageId) !== role) return false;
    }
    return true;
};

const getAssistantParentMessageId = (message: TurnRecord['assistantMessages'][number]): string | null => {
    const parentId = (message.info as { parentID?: unknown }).parentID;
    return typeof parentId === 'string' && parentId.trim().length > 0 ? parentId : null;
};

const getAssistantCompletedAt = (message: TurnRecord['assistantMessages'][number]): number | null => {
    const completedAt = (message.info as { time?: { completed?: unknown } }).time?.completed;
    return typeof completedAt === 'number' && completedAt > 0 ? completedAt : null;
};

const getSessionId = (turn: TurnRecord): string | null => {
    const sessionId = (turn.userMessage.info as { sessionID?: unknown }).sessionID;
    return typeof sessionId === 'string' && sessionId.trim().length > 0 ? sessionId : null;
};

const toRevisionTurnInput = (
    turn: TurnRecord,
    recordedPlanModeMessageIds: ReadonlySet<string>,
): PlanRevisionTurnInput => ({
    turnId: turn.turnId,
    userMessageId: turn.userMessageId,
    userInfo: turn.userMessage.info,
    userParts: turn.userMessage.parts,
    isRecordedPlanMode: recordedPlanModeMessageIds.has(turn.userMessageId),
    assistants: turn.assistantMessages.map((message) => ({
        id: message.info.id,
        parentMessageId: getAssistantParentMessageId(message),
        completedAt: getAssistantCompletedAt(message),
        parts: message.parts,
    })),
});

const buildTraceEntry = (
    revision: PlanRevision,
    planVersion: number,
    isLatestPlan: boolean,
    sessionId: string | null,
): PlanTurnTraceEntry => ({
    sessionId,
    planVersion,
    turnId: revision.rootTurnId,
    userMessageId: revision.rootUserMessageId,
    memberTurnIds: revision.memberTurnIds,
    sourceTurnId: revision.sourceTurnId,
    isPlanModeRevision: revision.isPlanModeRevision,
    assistantSourceMessageId: revision.sourceMessageId,
    assistantParentMessageId: revision.sourceParentMessageId,
    completedAt: revision.sourceCompletedAt,
    isLatestPlan,
    isSuperseded: !isLatestPlan,
    isSettled: revision.isSettled,
    isActionable: isLatestPlan
        && revision.sourceMessageId !== null
        && revision.sourceCompletedAt !== null
        && revision.isSettled,
});

export const projectPlanTurnTraceIndex = (
    turns: TurnRecord[],
    options: ProjectPlanTurnTraceIndexOptions = {},
): PlanTurnTraceIndex => {
    const recordedPlanModeMessageIds = options.recordedPlanModeMessageIds ?? new Set<string>();
    const sessionIdByTurnId = new Map<string, string | null>();
    const inputs = turns.map((turn) => {
        sessionIdByTurnId.set(turn.turnId, getSessionId(turn));
        return toRevisionTurnInput(turn, recordedPlanModeMessageIds);
    });

    const revisions = projectPlanRevisions(inputs);
    const latestRevision = revisions[revisions.length - 1] ?? null;

    const entries: PlanTurnTraceEntry[] = [];
    const byTurnId = new Map<string, PlanTurnTraceEntry>();
    const bySourceMessageId = new Map<string, PlanTurnTraceEntry>();
    const messageRoleById = new Map<string, PlanRevisionMessageRole>();
    const suppressedTurnIds = new Set<string>();

    revisions.forEach((revision, index) => {
        const entry = buildTraceEntry(
            revision,
            index + 1,
            revision === latestRevision,
            sessionIdByTurnId.get(revision.rootTurnId) ?? null,
        );
        entries.push(entry);
        for (const memberTurnId of revision.memberTurnIds) {
            byTurnId.set(memberTurnId, entry);
        }
        if (entry.assistantSourceMessageId) {
            bySourceMessageId.set(entry.assistantSourceMessageId, entry);
        }
        for (const [messageId, role] of revision.messageRoles) {
            messageRoleById.set(messageId, role);
        }
        for (const turnId of revision.turnIdsAfterSource) {
            suppressedTurnIds.add(turnId);
        }
    });

    const latestEntry = entries[entries.length - 1] ?? null;
    const latestPlanTurnId = latestEntry?.turnId ?? null;
    const pendingPlanTurnId = latestEntry && !latestEntry.isActionable ? latestEntry.turnId : null;

    const nextIndex: PlanTurnTraceIndex = {
        entries,
        byTurnId,
        bySourceMessageId,
        messageRoleById,
        suppressedTurnIds,
        latestPlanTurnId,
        latestPlanSourceMessageId: latestEntry?.assistantSourceMessageId ?? null,
        pendingPlanTurnId,
    };

    const previousIndex = options.previousIndex;
    if (
        previousIndex
        && previousIndex.latestPlanTurnId === nextIndex.latestPlanTurnId
        && previousIndex.latestPlanSourceMessageId === nextIndex.latestPlanSourceMessageId
        && previousIndex.pendingPlanTurnId === nextIndex.pendingPlanTurnId
        && previousIndex.entries.length === nextIndex.entries.length
        && previousIndex.entries.every((entry, index) => {
            const nextEntry = nextIndex.entries[index];
            return nextEntry ? areTraceEntriesEqual(entry, nextEntry) : false;
        })
        && areMessageRoleMapsEqual(previousIndex.messageRoleById, nextIndex.messageRoleById)
    ) {
        return previousIndex;
    }

    return nextIndex;
};
