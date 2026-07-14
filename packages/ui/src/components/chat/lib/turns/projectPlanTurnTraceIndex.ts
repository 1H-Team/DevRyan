import { isPlanModeUserMessage, resolveMessagePlanCard } from '@/lib/messages/actionablePlan';

import type {
    PlanTurnTraceEntry,
    PlanTurnTraceIndex,
    TurnRecord,
} from './types';

interface ProjectPlanTurnTraceIndexOptions {
    previousIndex?: PlanTurnTraceIndex | null;
    recordedPlanModeMessageIds?: ReadonlySet<string>;
}

const areTraceEntriesEqual = (left: PlanTurnTraceEntry, right: PlanTurnTraceEntry): boolean => (
    left.sessionId === right.sessionId
    && left.planVersion === right.planVersion
    && left.turnId === right.turnId
    && left.userMessageId === right.userMessageId
    && left.assistantSourceMessageId === right.assistantSourceMessageId
    && left.assistantParentMessageId === right.assistantParentMessageId
    && left.completedAt === right.completedAt
    && left.isLatestPlan === right.isLatestPlan
    && left.isSuperseded === right.isSuperseded
    && left.isActionable === right.isActionable
);

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

const resolvePlanSource = (turn: TurnRecord, isPlanModeTurn: boolean) => {
    let source: TurnRecord['assistantMessages'][number] | null = null;

    for (const assistantMessage of turn.assistantMessages) {
        const plan = resolveMessagePlanCard(assistantMessage.parts, { isPlanModeSource: isPlanModeTurn });
        if (plan?.planText.trim()) {
            source = assistantMessage;
        }
    }

    return source;
};

export const projectPlanTurnTraceIndex = (
    turns: TurnRecord[],
    options: ProjectPlanTurnTraceIndexOptions = {},
): PlanTurnTraceIndex => {
    const recordedPlanModeMessageIds = options.recordedPlanModeMessageIds ?? new Set<string>();
    const candidates = turns
        .map((turn) => {
            const isPlanModeTurn = isPlanModeUserMessage(
                turn.userMessage.info,
                turn.userMessage.parts,
                recordedPlanModeMessageIds.has(turn.userMessageId),
            );
            return {
                turn,
                isPlanModeTurn,
                source: resolvePlanSource(turn, isPlanModeTurn),
            };
        })
        .filter(({ isPlanModeTurn, source }) => source !== null || isPlanModeTurn);
    const latestPlanTurnId = candidates[candidates.length - 1]?.turn.turnId ?? null;

    const entries: PlanTurnTraceEntry[] = candidates.map(({ turn, source }, index) => {
        const completedAt = source ? getAssistantCompletedAt(source) : null;
        const isLatestPlan = turn.turnId === latestPlanTurnId;

        return {
            sessionId: getSessionId(turn),
            planVersion: index + 1,
            turnId: turn.turnId,
            userMessageId: turn.userMessageId,
            assistantSourceMessageId: source?.info.id ?? null,
            assistantParentMessageId: source ? getAssistantParentMessageId(source) : null,
            completedAt,
            isLatestPlan,
            isSuperseded: !isLatestPlan,
            isActionable: isLatestPlan && source !== null && completedAt !== null,
        };
    });

    const byTurnId = new Map<string, PlanTurnTraceEntry>();
    const bySourceMessageId = new Map<string, PlanTurnTraceEntry>();
    for (const entry of entries) {
        byTurnId.set(entry.turnId, entry);
        if (entry.assistantSourceMessageId) {
            bySourceMessageId.set(entry.assistantSourceMessageId, entry);
        }
    }

    const latestEntry = latestPlanTurnId ? byTurnId.get(latestPlanTurnId) ?? null : null;
    const pendingPlanTurnId = latestEntry && !latestEntry.isActionable ? latestEntry.turnId : null;

    const nextIndex: PlanTurnTraceIndex = {
        entries,
        byTurnId,
        bySourceMessageId,
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
    ) {
        return previousIndex;
    }

    return nextIndex;
};
