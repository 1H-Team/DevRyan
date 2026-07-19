import type { Message, Part } from '@opencode-ai/sdk/v2';
import type { ResponseStyleLevel } from '@/lib/responseStyle';

export interface ChatMessageEntry {
    info: Message;
    parts: Part[];
}

export type TurnActivityKind = 'tool' | 'reasoning' | 'justification';

export interface TurnMessageRecord {
    messageId: string;
    role: string;
    parentMessageId?: string;
    message: ChatMessageEntry;
    order: number;
}

export interface TurnPartRecord {
    id: string;
    turnId: string;
    messageId: string;
    part: Part;
    partIndex: number;
    endedAt?: number;
    providerID?: string;
}

export interface TurnActivityRecord extends TurnPartRecord {
    kind: TurnActivityKind;
}

export interface TurnDiffStats {
    additions: number;
    deletions: number;
    files: number;
}

export interface TurnActivityGroup {
    id: string;
    anchorMessageId: string;
    afterToolPartId: string | null;
    parts: TurnActivityRecord[];
}

export interface TurnSummaryRecord {
    text?: string;
    sourceMessageId?: string;
    sourcePartId?: string;
}

export interface TurnStreamState {
    isStreaming: boolean;
    isRetrying: boolean;
    startedAt?: number;
    completedAt?: number;
    durationMs?: number;
}

export interface TurnRecord {
    turnId: string;
    userMessageId: string;
    userMessage: ChatMessageEntry;
    headerMessageId?: string;
    messages: TurnMessageRecord[];
    assistantMessageIds: string[];
    assistantMessages: ChatMessageEntry[];
    activityParts: TurnActivityRecord[];
    activitySegments: TurnActivityGroup[];
    summary: TurnSummaryRecord;
    summaryText?: string;
    hasTools: boolean;
    hasReasoning: boolean;
    diffStats?: TurnDiffStats;
    stream: TurnStreamState;
    startedAt?: number;
    completedAt?: number;
    durationMs?: number;
}

export interface TurnMessageMeta {
    turnId: string;
    messageId: string;
    userMessageId: string;
    isUserMessage: boolean;
    isAssistantMessage: boolean;
    isFirstAssistantInTurn: boolean;
    isLastAssistantInTurn: boolean;
    headerMessageId?: string;
}

export interface TurnIndexes {
    turnById: Map<string, TurnRecord>;
    messageToTurnId: Map<string, string>;
    messageMetaById: Map<string, TurnMessageMeta>;
}

export interface PlanTurnTraceEntry {
    sessionId: string | null;
    planVersion: number;
    turnId: string;
    userMessageId: string;
    assistantSourceMessageId: string | null;
    assistantParentMessageId: string | null;
    completedAt: number | null;
    isLatestPlan: boolean;
    isSuperseded: boolean;
    isActionable: boolean;
}

export interface PlanTurnTraceIndex {
    entries: PlanTurnTraceEntry[];
    byTurnId: Map<string, PlanTurnTraceEntry>;
    bySourceMessageId: Map<string, PlanTurnTraceEntry>;
    latestPlanTurnId: string | null;
    latestPlanSourceMessageId: string | null;
    pendingPlanTurnId: string | null;
}

export interface TurnProjectionResult {
    turns: TurnRecord[];
    indexes: TurnIndexes;
    lastTurnId: string | null;
    lastTurnMessageIds: Set<string>;
    ungroupedMessageIds: Set<string>;
    planTraceIndex: PlanTurnTraceIndex;
}

export type Turn = Pick<TurnRecord, 'turnId' | 'userMessage' | 'assistantMessages'>;

export interface TurnGroupingContext {
    turnId: string;
    responseStyleLevel?: ResponseStyleLevel;
    activityOwnerMessageId?: string;
    isFirstAssistantInTurn: boolean;
    isLastAssistantInTurn: boolean;
    summaryBody?: string;
    summarySourceMessageId?: string;
    summarySourcePartId?: string;
    activityParts?: TurnActivityRecord[];
    activityGroupSegments?: TurnActivityGroup[];
    headerMessageId?: string;
    hasTools: boolean;
    hasReasoning: boolean;
    diffStats?: TurnDiffStats;
    userMessageCreatedAt?: number;
    userMessageVariant?: string;
    isPlanModeSource?: boolean;
    // Part id of the turn's final todowrite/todoread snapshot, used to collapse redundant todo
    // rows across all messages in the turn to a single up-to-date widget.
    lastTodoToolPartId?: string | null;
    isWorking: boolean;
    isTurnWorking: boolean;
    isGroupExpanded?: boolean;
    toggleGroup?: () => void;
}
