import { isPlanModeUserMessage } from '@/lib/messages/actionablePlan';
import { projectTurnActivity } from './projectTurnActivity';
import { projectTurnIndexes } from './projectTurnIndexes';
import { projectPlanTurnTraceIndex } from './projectPlanTurnTraceIndex';
import { projectTurnDiffStats, projectTurnSummary } from './projectTurnSummary';
import type {
    ChatMessageEntry,
    TurnMessageRecord,
    TurnProjectionResult,
    TurnRecord,
    TurnStreamState,
} from './types';

const resolveMessageRole = (message: ChatMessageEntry): string => {
    const role = (message.info as { clientRole?: string | null; role?: string | null }).clientRole ?? message.info.role;
    return typeof role === 'string' ? role : '';
};

const getMessageParentId = (message: ChatMessageEntry): string | undefined => {
    const parentId = (message.info as { parentID?: unknown }).parentID;
    if (typeof parentId !== 'string' || parentId.trim().length === 0) {
        return undefined;
    }
    return parentId;
};

const getMessageCreatedAt = (message: ChatMessageEntry): number | undefined => {
    const created = (message.info as { time?: { created?: unknown } }).time?.created;
    return typeof created === 'number' ? created : undefined;
};

const getMessageCompletedAt = (message: ChatMessageEntry): number | undefined => {
    const completed = (message.info as { time?: { completed?: unknown } }).time?.completed;
    return typeof completed === 'number' ? completed : undefined;
};

const getUserSummaryBody = (message: ChatMessageEntry): string | undefined => {
    const summaryBody = (message.info as { summary?: { body?: unknown } | null | undefined })?.summary?.body;
    if (typeof summaryBody !== 'string') {
        return undefined;
    }

    const trimmed = summaryBody.trim();
    return trimmed.length > 0 ? summaryBody : undefined;
};

const createTurnMessageRecord = (message: ChatMessageEntry, order: number): TurnMessageRecord => {
    const role = resolveMessageRole(message);
    return {
        messageId: message.info.id,
        role,
        parentMessageId: getMessageParentId(message),
        message,
        order,
    };
};

const buildTurnStreamState = (userMessage: ChatMessageEntry, assistantMessages: ChatMessageEntry[]): TurnStreamState => {
    const startedAt = getMessageCreatedAt(userMessage);
    let completedAt: number | undefined;
    let isStreaming = false;

    assistantMessages.forEach((message) => {
        const completed = getMessageCompletedAt(message);
        if (typeof completed === 'number') {
            completedAt = Math.max(completedAt ?? 0, completed);
        } else {
            isStreaming = true;
        }
    });

    const durationMs = typeof startedAt === 'number' && typeof completedAt === 'number' && completedAt >= startedAt
        ? completedAt - startedAt
        : undefined;

    return {
        isStreaming,
        isRetrying: assistantMessages.length > 1,
        startedAt,
        completedAt,
        durationMs,
    };
};

const areTurnMessagesEqual = (left: TurnMessageRecord[], right: TurnMessageRecord[]): boolean => {
    if (left === right) return true;
    if (left.length !== right.length) return false;

    for (let index = 0; index < left.length; index += 1) {
        const leftMessage = left[index];
        const rightMessage = right[index];
        if (
            leftMessage.messageId !== rightMessage.messageId
            || leftMessage.role !== rightMessage.role
            || leftMessage.parentMessageId !== rightMessage.parentMessageId
            || leftMessage.message !== rightMessage.message
            || leftMessage.order !== rightMessage.order
        ) {
            return false;
        }
    }

    return true;
};

const areMessageRefsEqual = (left: ChatMessageEntry[], right: ChatMessageEntry[]): boolean => {
    if (left === right) return true;
    if (left.length !== right.length) return false;

    for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) {
            return false;
        }
    }

    return true;
};

const areStringArraysEqual = (left: string[], right: string[]): boolean => {
    if (left === right) return true;
    if (left.length !== right.length) return false;

    for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) {
            return false;
        }
    }

    return true;
};

const areActivityPartsEqual = (left: TurnRecord['activityParts'], right: TurnRecord['activityParts']): boolean => {
    if (left === right) return true;
    if (left.length !== right.length) return false;

    for (let index = 0; index < left.length; index += 1) {
        const leftPart = left[index];
        const rightPart = right[index];
        if (
            leftPart.id !== rightPart.id
            || leftPart.kind !== rightPart.kind
            || leftPart.turnId !== rightPart.turnId
            || leftPart.messageId !== rightPart.messageId
            || leftPart.part !== rightPart.part
            || leftPart.partIndex !== rightPart.partIndex
            || leftPart.endedAt !== rightPart.endedAt
        ) {
            return false;
        }
    }

    return true;
};

const areActivitySegmentsEqual = (left: TurnRecord['activitySegments'], right: TurnRecord['activitySegments']): boolean => {
    if (left === right) return true;
    if (left.length !== right.length) return false;

    for (let index = 0; index < left.length; index += 1) {
        const leftSegment = left[index];
        const rightSegment = right[index];
        if (
            leftSegment.id !== rightSegment.id
            || leftSegment.anchorMessageId !== rightSegment.anchorMessageId
            || leftSegment.afterToolPartId !== rightSegment.afterToolPartId
            || !areActivityPartsEqual(leftSegment.parts, rightSegment.parts)
        ) {
            return false;
        }
    }

    return true;
};

const areTurnSummariesEqual = (left: TurnRecord['summary'], right: TurnRecord['summary']): boolean => {
    return left.text === right.text
        && left.sourceMessageId === right.sourceMessageId
        && left.sourcePartId === right.sourcePartId;
};

const areTurnDiffStatsEqual = (left: TurnRecord['diffStats'], right: TurnRecord['diffStats']): boolean => {
    if (!left || !right) return left === right;
    return left.additions === right.additions
        && left.deletions === right.deletions
        && left.files === right.files;
};

const areTurnStreamsEqual = (left: TurnStreamState, right: TurnStreamState): boolean => {
    return left.isStreaming === right.isStreaming
        && left.isRetrying === right.isRetrying
        && left.startedAt === right.startedAt
        && left.completedAt === right.completedAt
        && left.durationMs === right.durationMs;
};

const canReusePreviousTurn = (previous: TurnRecord, next: TurnRecord): boolean => {
    return previous.turnId === next.turnId
        && previous.userMessageId === next.userMessageId
        && previous.userMessage === next.userMessage
        && previous.headerMessageId === next.headerMessageId
        && areTurnMessagesEqual(previous.messages, next.messages)
        && areStringArraysEqual(previous.assistantMessageIds, next.assistantMessageIds)
        && areMessageRefsEqual(previous.assistantMessages, next.assistantMessages)
        && areActivityPartsEqual(previous.activityParts, next.activityParts)
        && areActivitySegmentsEqual(previous.activitySegments, next.activitySegments)
        && areTurnSummariesEqual(previous.summary, next.summary)
        && previous.summaryText === next.summaryText
        && previous.hasTools === next.hasTools
        && previous.hasReasoning === next.hasReasoning
        && areTurnDiffStatsEqual(previous.diffStats, next.diffStats)
        && areTurnStreamsEqual(previous.stream, next.stream)
        && previous.startedAt === next.startedAt
        && previous.completedAt === next.completedAt
        && previous.durationMs === next.durationMs;
};

interface ProjectTurnRecordsOptions {
    previousProjection?: TurnProjectionResult | null;
    recordedPlanModeMessageIds?: ReadonlySet<string>;
}

const DEFAULT_OPTIONS: ProjectTurnRecordsOptions = {
    previousProjection: null,
    recordedPlanModeMessageIds: new Set<string>(),
};

export const projectTurnRecords = (
    messages: ChatMessageEntry[],
    options?: Partial<ProjectTurnRecordsOptions>,
): TurnProjectionResult => {
    const effectiveOptions: ProjectTurnRecordsOptions = {
        ...DEFAULT_OPTIONS,
        ...options,
    };

    const turns: TurnRecord[] = [];
    const turnByUserId = new Map<string, TurnRecord>();
    const groupedMessageIds = new Set<string>();

    messages.forEach((message, index) => {
        const role = resolveMessageRole(message);
        if (role !== 'user') {
            return;
        }

        const turnId = message.info.id;
        const turn: TurnRecord = {
            turnId,
            userMessageId: message.info.id,
            userMessage: message,
            headerMessageId: undefined,
            messages: [createTurnMessageRecord(message, index)],
            assistantMessageIds: [],
            assistantMessages: [],
            activityParts: [],
            activitySegments: [],
            summary: {},
            summaryText: undefined,
            hasTools: false,
            hasReasoning: false,
            diffStats: undefined,
            stream: {
                isStreaming: false,
                isRetrying: false,
            },
        };
        turns.push(turn);
        turnByUserId.set(turn.userMessageId, turn);
        groupedMessageIds.add(message.info.id);
    });

    messages.forEach((message, index) => {
        const role = resolveMessageRole(message);
        if (role !== 'assistant') {
            return;
        }

        const parentId = getMessageParentId(message);
        const targetTurn = parentId ? turnByUserId.get(parentId) : undefined;
        if (!targetTurn) {
            return;
        }

        targetTurn.assistantMessages.push(message);
        targetTurn.assistantMessageIds.push(message.info.id);
        targetTurn.messages.push(createTurnMessageRecord(message, index));
        if (!targetTurn.headerMessageId) {
            targetTurn.headerMessageId = message.info.id;
        }
        groupedMessageIds.add(message.info.id);
    });

    turns.forEach((turn) => {
        turn.summary = projectTurnSummary(turn.assistantMessages);
        turn.summaryText = turn.summary.text ?? getUserSummaryBody(turn.userMessage);
        turn.diffStats = projectTurnDiffStats(turn.userMessage);

        const activity = projectTurnActivity({
            turnId: turn.turnId,
            assistantMessages: turn.assistantMessages,
            summarySourceMessageId: turn.summary.sourceMessageId,
            summarySourcePartId: turn.summary.sourcePartId,
            isPlanModeTurn: isPlanModeUserMessage(
                turn.userMessage.info,
                turn.userMessage.parts,
                effectiveOptions.recordedPlanModeMessageIds?.has(turn.userMessage.info.id) ?? false,
            ),
        });
        turn.activityParts = activity.activityParts;
        turn.activitySegments = activity.activitySegments;
        turn.hasTools = activity.hasTools;
        turn.hasReasoning = activity.hasReasoning;

        turn.stream = buildTurnStreamState(turn.userMessage, turn.assistantMessages);
        turn.startedAt = turn.stream.startedAt;
        turn.completedAt = turn.stream.completedAt;
        turn.durationMs = turn.stream.durationMs;
    });

    const previousProjection = effectiveOptions.previousProjection;
    const stableTurns = previousProjection
        ? turns.map((turn) => {
            const previousTurn = previousProjection.indexes.turnById.get(turn.turnId);
            return previousTurn && canReusePreviousTurn(previousTurn, turn) ? previousTurn : turn;
        })
        : turns;

    const projection = projectTurnIndexes(stableTurns);
    const ungroupedMessageIds = new Set<string>();
    messages.forEach((message) => {
        if (resolveMessageRole(message) === 'assistant') {
            return;
        }
        if (!groupedMessageIds.has(message.info.id)) {
            ungroupedMessageIds.add(message.info.id);
        }
    });

    return {
        ...projection,
        ungroupedMessageIds,
        planTraceIndex: projectPlanTurnTraceIndex(stableTurns, {
            previousIndex: effectiveOptions.previousProjection?.planTraceIndex,
            recordedPlanModeMessageIds: effectiveOptions.recordedPlanModeMessageIds,
        }),
    };
};
