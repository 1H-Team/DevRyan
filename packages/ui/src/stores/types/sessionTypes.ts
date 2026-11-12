import type { ContextCapacityBasis } from "@/stores/utils/modelContextCapacity";

export type SessionWorktreeAttachment = {
  worktreeRoot: string | null;
  cwd: string | null;
  branch: string | null;
  headState: 'branch' | 'detached' | 'unborn';
  worktreeStatus: 'ready' | 'missing' | 'invalid' | 'not-a-repo';
  worktreeSource: 'existing' | 'created-for-session' | null;
  legacy: boolean;
  degraded: boolean;
  attentionReason?: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | null;
};

export interface AttachedFile {
    id: string;
    file: File;
    dataUrl: string;
    mimeType: string;
    filename: string;
    size: number;
    source: "local" | "server";
    serverPath?: string;

}

export type EditPermissionMode = 'allow' | 'ask' | 'deny' | 'full';

export type MessageStreamPhase = 'streaming' | 'cooldown' | 'completed';

export interface SessionMemoryState {
    viewportAnchor: number;
    isStreaming: boolean;
    streamStartTime?: number;
    lastAccessedAt: number;
    backgroundMessageCount: number;
    isZombie?: boolean;
    totalAvailableMessages?: number;
    loadedTurnCount?: number;
    hasMoreAbove?: boolean;
    hasMoreTurnsAbove?: boolean;
    historyLoading?: boolean;
    historyComplete?: boolean;
    historyLimit?: number;
    streamingCooldownUntil?: number;
    lastUserMessageAt?: number; // Timestamp when user last sent a message
}

export interface SessionHistoryMeta {
    limit: number;
    complete: boolean;
    loading: boolean;
}

export interface ContextUsageTokenBreakdown {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
}

export interface ContextUsageRelatedSession {
    sessionId: string;
    title?: string;
    activeInputTokens: number;
    processedInputTokens?: number;
    capacityLimit: number | null;
    capacityBasis: ContextCapacityBasis;
    inputLimit: number | null;
    contextLimit: number | null;
    outputLimit: number | null;
    percentage: number | null;
    lastMessageId?: string;
    /** Parent in the subagent tree: the root session for top-level rows. */
    parentSessionId?: string;
    /** Nesting depth below the root session; 0 for direct children. */
    depth?: number;
    /** False when the child's messages are not loaded, so tokens are unknown. */
    hasData?: boolean;
    tokenBreakdown?: ContextUsageTokenBreakdown;
}

export interface SessionContextUsage {
    providerID?: string;
    activeInputTokens: number;
    lastOutputTokens: number;
    processedInputTokens?: number;
    source: 'meridian' | 'message-fallback';
    updatedAt: number;
    percentage: number | null;
    capacityLimit: number | null;
    capacityBasis: ContextCapacityBasis;
    inputLimit: number | null;
    contextLimit: number | null;
    outputLimit: number | null;
    lastMessageId?: string;
    tokenBreakdown: ContextUsageTokenBreakdown;
    hasTokenBreakdown: boolean;
    relatedSubagentSessions?: ContextUsageRelatedSession[];
    relatedSubagentActiveInputTokens?: number;
}

// Default message limit (can be overridden via settings).
// Single value controls: fetch from server, active session ceiling, Load More chunk.
// Background trim is derived automatically as Math.round(limit * 0.6).
export const DEFAULT_MESSAGE_LIMIT = 200;

export const MEMORY_CONSTANTS = {
    MAX_SESSIONS: 3,
    ZOMBIE_TIMEOUT: 10 * 60 * 1000,
} as const;

/** OpenCode parity: fixed page/window size for message history. */
export const getMessageLimit = (): number => {
    return DEFAULT_MESSAGE_LIMIT;
};

/** Background trim target — automatic, not user-facing. */
export const getBackgroundTrimLimit = (): number =>
    Math.round(getMessageLimit() * 0.6);

// --- Backward-compat shims (avoid mass refactor of non-critical callers) ---
export const DEFAULT_MEMORY_LIMITS = {
    MAX_SESSIONS: MEMORY_CONSTANTS.MAX_SESSIONS,
    VIEWPORT_MESSAGES: Math.round(DEFAULT_MESSAGE_LIMIT * 0.6),
    HISTORICAL_MESSAGES: DEFAULT_MESSAGE_LIMIT,
    FETCH_BUFFER: 20,
    HISTORY_CHUNK: DEFAULT_MESSAGE_LIMIT,
    STREAMING_BUFFER: Infinity,
    ZOMBIE_TIMEOUT: MEMORY_CONSTANTS.ZOMBIE_TIMEOUT,
} as const;

export const getMemoryLimits = () => {
    const limit = getMessageLimit();
    const bgTrim = getBackgroundTrimLimit();
    return {
        ...DEFAULT_MEMORY_LIMITS,
        HISTORICAL_MESSAGES: limit,
        VIEWPORT_MESSAGES: bgTrim,
        HISTORY_CHUNK: limit,
    };
};

export const MEMORY_LIMITS = DEFAULT_MEMORY_LIMITS;

/** Synthetic context parts to attach when sending initial message */
export interface SyntheticContextPart {
    text: string;
    synthetic: true;
}

export type DraftSendConfig = {
    providerID?: string;
    modelID?: string;
    agent?: string;
    variant?: string | null;
    planMode?: boolean;
    modelProvenance?: 'explicit' | 'agent-default';
};

export type NewSessionDraftState = {
    open: boolean;
    id?: string | null;
    selectedProjectId?: string | null;
    directoryOverride: string | null;
    pendingWorktreeRequestId?: string | null;
    bootstrapPendingDirectory?: string | null;
    preserveDirectoryOverride?: boolean;
    targetBranchName?: string | null;
    targetPreparationError?: string | null;
    parentID: string | null;
    title?: string;
    initialPrompt?: string;
    /** Synthetic context parts to include with the initial message */
    syntheticParts?: SyntheticContextPart[];
    planMode?: boolean;
    sendConfig?: DraftSendConfig;
    targetFolderId?: string;
};

export type ChatDraft = Omit<NewSessionDraftState, 'open'> & {
    id: string;
    text: string;
    /** Lightweight metadata; attachment payloads live in IndexedDB. */
    attachmentCount?: number;
    createdAt: number;
    updatedAt: number;
};

export type StarterAssistantMessage = {
    sessionId: string;
    sourceMessageId: string;
    messageId: string;
    partId: string;
    text: string;
    createdAt: number;
    pendingContext: boolean;
};
