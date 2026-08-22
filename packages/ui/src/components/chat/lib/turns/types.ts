import type { Message, Part } from '@opencode-ai/sdk/v2';
import type {
    ManagedTaskFailureKind,
    ProviderTransportFailureKind,
} from '@openchamber/orchestration-runtime';
import type { ResponseStyleLevel } from '@/lib/responseStyle';
import type { ManagedTaskTurnProjection } from '../../managedTaskDispatch';
import type { AssistantImageMessage } from '../../message/parts/generatedImageResults';

export type ManagedTransportRecoveryState = 'recovering' | 'recovered' | 'failed';

export interface ManagedTransportRecoveryPresentation {
    kind: ProviderTransportFailureKind;
    state: ManagedTransportRecoveryState;
}

export type ManagedAbortRecoveryState = 'continuing' | 'recovered' | 'manual_recovery' | 'stopped';

export interface ManagedAbortRecoveryPresentation {
    state: ManagedAbortRecoveryState;
    failureKind?: ManagedTaskFailureKind;
}

export interface ChatMessageEntry {
    info: Message;
    parts: Part[];
    presentation?: {
        managedAbortRecovery?: ManagedAbortRecoveryPresentation;
        managedTransportRecovery?: ManagedTransportRecoveryPresentation;
    };
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
    /** Root turn of the logical plan revision — the user-authored request. */
    turnId: string;
    userMessageId: string;
    /** Root turn plus folded compaction/synthetic continuation turns, in order. */
    memberTurnIds: string[];
    /** Member turn containing the selected source message. */
    sourceTurnId: string | null;
    isPlanModeRevision: boolean;
    assistantSourceMessageId: string | null;
    assistantParentMessageId: string | null;
    completedAt: number | null;
    isLatestPlan: boolean;
    isSuperseded: boolean;
    /** True once every assistant sibling across member turns has completed. */
    isSettled: boolean;
    isActionable: boolean;
}

export type PlanRevisionMessageRole = 'before-source' | 'source' | 'after-source';

export interface PlanTurnTraceIndex {
    entries: PlanTurnTraceEntry[];
    /** Keyed by every member turn id (root and folded continuations). */
    byTurnId: Map<string, PlanTurnTraceEntry>;
    bySourceMessageId: Map<string, PlanTurnTraceEntry>;
    /** Position of each assistant sibling relative to its revision's source. */
    messageRoleById: Map<string, PlanRevisionMessageRole>;
    /** Member turns rendered as no output because they follow the source turn. */
    suppressedTurnIds: Set<string>;
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
    managedTaskProjection?: ManagedTaskTurnProjection;
    isFirstAssistantInTurn: boolean;
    isLastAssistantInTurn: boolean;
    summaryBody?: string;
    summarySourceMessageId?: string;
    summarySourcePartId?: string;
    activityParts?: TurnActivityRecord[];
    activityGroupSegments?: TurnActivityGroup[];
    assistantImageMessages?: AssistantImageMessage[];
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
