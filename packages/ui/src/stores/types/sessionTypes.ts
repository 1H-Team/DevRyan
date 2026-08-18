import type { Session, Message, Part } from "@opencode-ai/sdk/v2";
import type { PermissionRequest, PermissionResponse } from "@/types/permission";
import type { QuestionRequest } from "@/types/question";
import type { ContextCapacityBasis, ResolvedModelContextCapacity } from "@/stores/utils/modelContextCapacity";

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
    source: "local" | "server" | "vscode";
    serverPath?: string;
    vscodePath?: string;
    vscodeSource?: 'file' | 'selection';
}

export type EditPermissionMode = 'allow' | 'ask' | 'deny' | 'full';

export type MessageStreamPhase = 'streaming' | 'cooldown' | 'completed';

export interface MessageStreamLifecycle {
    phase: MessageStreamPhase;
    startedAt: number;
    lastUpdateAt: number;
    completedAt?: number;
}

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

/** Timeout after which a session stuck in 'busy' or 'retry' with no SSE events is force-reset to idle. */
export const STUCK_SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

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

export const getActiveSessionWindow = () => getMessageLimit();

export const DEFAULT_ACTIVE_SESSION_WINDOW = DEFAULT_MESSAGE_LIMIT;
export const MEMORY_LIMITS = DEFAULT_MEMORY_LIMITS;
export const ACTIVE_SESSION_WINDOW = DEFAULT_ACTIVE_SESSION_WINDOW;

/** Synthetic context parts to attach when sending initial message */
export interface SyntheticContextPart {
    text: string;
    synthetic: true;
}

export type DraftSendConfig = {
    providerID?: string;
    modelID?: string;
    agent?: string;
    variant?: string;
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

// Voice state types
export type VoiceStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
export type VoiceMode = 'idle' | 'speaking' | 'listening';

export interface VoiceState {
    status: VoiceStatus;
    mode: VoiceMode;
}

export interface SessionStore {

    sessions: Session[];
    archivedSessions: Session[];
    sessionsByDirectory: Map<string, Session[]>;
    currentSessionId: string | null;
    currentDraftId: string | null;
    draftsById: Record<string, ChatDraft>;
    draftOrder: string[];
    lastLoadedDirectory: string | null;
    messages: Map<string, { info: Message; parts: Part[] }[]>;
    sessionMemoryState: Map<string, SessionMemoryState>;
    sessionHistoryMeta: Map<string, SessionHistoryMeta>;
    messageStreamStates: Map<string, MessageStreamLifecycle>;
    sessionCompactionUntil: Map<string, number>;
    permissions: Map<string, PermissionRequest[]>;
    questions: Map<string, QuestionRequest[]>;
    sessionAbortFlags: Map<string, { timestamp: number; acknowledged: boolean; reason?: "manual" | "steered"; id?: string }>;
    attachedFiles: AttachedFile[];
    abortPromptSessionId: string | null;
    abortPromptExpiresAt: number | null;
    isLoading: boolean;
    error: string | null;
    streamingMessageIds: Map<string, string | null>;
    abortControllers: Map<string, AbortController>;
    /** Sessions with an optimistic "stopping" state: stop clicked, server abort not yet confirmed. Value = click timestamp. */
    stoppingSessions: Map<string, number>;
    lastUsedProvider: { providerID: string; modelID: string } | null;
    isSyncing: boolean;

    sessionModelSelections: Map<string, { providerId: string; modelId: string }>;
    sessionAgentSelections: Map<string, string>;

    sessionAgentModelSelections: Map<string, Map<string, { providerId: string; modelId: string }>>;

    webUICreatedSessions: Set<string>;
    worktreeMetadata: Map<string, import('@/types/worktree').WorktreeMetadata>;
    availableWorktrees: import('@/types/worktree').WorktreeMetadata[];
    availableWorktreesByProject: Map<string, import('@/types/worktree').WorktreeMetadata[]>;

    currentAgentContext: Map<string, string>;

    sessionContextUsage: Map<string, SessionContextUsage>;

    starterAssistantMessages: Map<string, StarterAssistantMessage>;

    sessionAgentEditModes: Map<string, Map<string, EditPermissionMode>>;

    // Server-owned session status (mirrors OpenCode SessionStatus: busy|retry|idle).
    // Use as the single source of truth for "assistant working" UI.
    // confirmedAt: timestamp when idle was confirmed locally (prevents race with server polling)
    sessionStatus?: Map<
        string,
        { type: 'idle' | 'busy' | 'retry'; attempt?: number; message?: string; next?: number; confirmedAt?: number }
    >;

    // sessionAttentionStates removed — replaced by notification-store

    userSummaryTitles: Map<string, { title: string; createdAt: number | null }>;

    pendingInputText: string | null;
    pendingInputMode: 'replace' | 'append' | 'append-inline';
    /** Synthetic context parts to include with the next message sent */
    pendingSyntheticParts: SyntheticContextPart[] | null;

    newSessionDraft: NewSessionDraftState;

    // Voice state
    voiceStatus: VoiceStatus;
    voiceMode: VoiceMode;

    // Voice actions
    setVoiceStatus: (status: VoiceStatus) => void;
    setVoiceMode: (mode: VoiceMode) => void;

    getSessionAgentEditMode: (sessionId: string, agentName: string | undefined, defaultMode?: EditPermissionMode) => EditPermissionMode;
    getStarterAssistantMessage: (sessionId: string) => StarterAssistantMessage | undefined;
    clearStarterAssistantPendingContext: (sessionId: string) => void;
    toggleSessionAgentEditMode: (sessionId: string, agentName: string | undefined, defaultMode?: EditPermissionMode) => void;
    setSessionAgentEditMode: (sessionId: string, agentName: string | undefined, mode: EditPermissionMode, defaultMode?: EditPermissionMode) => void;
    loadSessions: () => Promise<void>;

    openNewSessionDraft: (options?: { projectId?: string | null; directoryOverride?: string | null; pendingWorktreeRequestId?: string | null; bootstrapPendingDirectory?: string | null; preserveDirectoryOverride?: boolean; targetBranchName?: string | null; targetPreparationError?: string | null; parentID?: string | null; title?: string; initialPrompt?: string; syntheticParts?: SyntheticContextPart[]; targetFolderId?: string }) => void;
    selectNewSessionDraft: (draftId: string) => void;
    updateNewSessionDraftText: (draftId: string, text: string) => void;
    deleteNewSessionDraft: (draftId: string) => void;
    overrideNewSessionDraftTarget: (options: { projectId?: string | null; directoryOverride?: string | null; pendingWorktreeRequestId?: string | null; bootstrapPendingDirectory?: string | null; preserveDirectoryOverride?: boolean; targetBranchName?: string | null; targetPreparationError?: string | null; title?: string; initialPrompt?: string }) => void;
    setNewSessionDraftTarget: (target: { projectId?: string | null; directoryOverride?: string | null }, options?: { force?: boolean }) => void;
    setPendingDraftWorktreeRequest: (requestId: string | null) => void;
    resolvePendingDraftWorktreeTarget: (requestId: string, directory: string | null, options?: { projectId?: string | null; bootstrapPendingDirectory?: string | null; preserveDirectoryOverride?: boolean; targetBranchName?: string | null; targetPreparationError?: string | null }) => void;
    setDraftBootstrapPendingDirectory: (directory: string | null) => void;
    setDraftPreserveDirectoryOverride: (value: boolean) => void;
    closeNewSessionDraft: () => void;
    promoteDraftToSession: (options: { draftId?: string | null; sessionId: string; directoryHint?: string | null; submittedText?: string }) => void;
    claimPendingSendAbort: (key: string, controller?: AbortController) => AbortController | null;
    promotePendingSendAbort: (fromKey: string, toKey: string) => AbortController | null;
    abortPendingSend: (key: string) => boolean;
    clearPendingSendAbort: (key: string, controller?: AbortController) => void;
    hasPendingSendAbort: (key: string) => boolean;
    markSessionStopping: (sessionId: string) => void;
    clearSessionStopping: (sessionId: string) => void;

    createSession: (title?: string, directoryOverride?: string | null, parentID?: string | null) => Promise<Session | null>;
    createSessionFromAssistantMessage: (sourceMessageId: string) => Promise<void>;

    deleteSession: (id: string, options?: { archiveWorktree?: boolean; deleteRemoteBranch?: boolean; deleteLocalBranch?: boolean; remoteName?: string }) => Promise<boolean>;
    deleteSessions: (ids: string[], options?: { archiveWorktree?: boolean; deleteRemoteBranch?: boolean; deleteLocalBranch?: boolean; remoteName?: string; silent?: boolean }) => Promise<{ deletedIds: string[]; failedIds: string[] }>;
    archiveSession: (id: string) => Promise<boolean>;
    archiveSessions: (ids: string[], options?: { silent?: boolean }) => Promise<{ archivedIds: string[]; failedIds: string[] }>;
    unarchiveSession: (id: string) => Promise<boolean>;
    unarchiveSessions: (ids: string[], options?: { silent?: boolean }) => Promise<{ unarchivedIds: string[]; failedIds: string[] }>;
    updateSessionTitle: (id: string, title: string) => Promise<void>;
    shareSession: (id: string) => Promise<Session | null>;
    unshareSession: (id: string) => Promise<Session | null>;
    setCurrentSession: (id: string | null) => void;
    loadMessages: (sessionId: string, limit?: number) => Promise<void>;
    sendMessage: (content: string, providerID: string, modelID: string, agent?: string, attachments?: AttachedFile[], agentMentionName?: string, additionalParts?: Array<{ text: string; attachments?: AttachedFile[]; synthetic?: boolean }>, variant?: string, inputMode?: 'normal' | 'shell') => Promise<void>;
    abortCurrentOperation: (sessionIdOverride?: string) => Promise<void>;
    acknowledgeSessionAbort: (sessionId: string) => void;
    armAbortPrompt: (durationMs?: number) => number | null;
    clearAbortPrompt: () => void;
    addStreamingPart: (sessionId: string, messageId: string, part: Part, role?: string) => void;
    applyPartDelta: (sessionId: string, messageId: string, partId: string, field: string, delta: string, role?: string) => void;
    completeStreamingMessage: (sessionId: string, messageId: string) => void;
    markMessageStreamSettled: (messageId: string) => void;
    updateMessageInfo: (sessionId: string, messageId: string, messageInfo: Message) => void;
    updateSessionCompaction: (sessionId: string, compactingTimestamp?: number | null) => void;
    addPermission: (permission: PermissionRequest) => void;
    respondToPermission: (sessionId: string, requestId: string, response: PermissionResponse) => Promise<void>;
    dismissPermission: (sessionId: string, requestId: string) => void;

    addQuestion: (question: QuestionRequest) => void;
    dismissQuestion: (sessionId: string, requestId: string) => void;
    respondToQuestion: (sessionId: string, requestId: string, answers: string[] | string[][]) => Promise<void>;
    rejectQuestion: (sessionId: string, requestId: string) => Promise<void>;

    clearError: () => void;
    getSessionsByDirectory: (directory: string) => Session[];
    getDirectoryForSession: (sessionId: string) => string | null;
    getLastUserChoice: (sessionId: string) => { agent?: string; providerID?: string; modelID?: string; variant?: string } | null;
    getCurrentAgent: (sessionId: string) => string | undefined;
    syncMessages: (
      sessionId: string,
      messages: { info: Message; parts: Part[] }[],
      options?: { replace?: boolean }
    ) => void;
    applySessionMetadata: (sessionId: string, metadata: Partial<Session>) => void;
    setSessionDirectory: (sessionId: string, directory: string | null) => void;

    addAttachedFile: (file: File) => Promise<void>;
    addServerFile: (path: string, name: string, content?: string) => Promise<void>;
    removeAttachedFile: (id: string) => void;
    clearAttachedFiles: () => void;

    updateViewportAnchor: (sessionId: string, anchor: number) => void;
    loadMoreMessages: (sessionId: string, direction: "up" | "down") => Promise<void>;

    saveSessionModelSelection: (sessionId: string, providerId: string, modelId: string) => void;
    getSessionModelSelection: (sessionId: string) => { providerId: string; modelId: string } | null;
    saveSessionAgentSelection: (sessionId: string, agentName: string) => void;
    getSessionAgentSelection: (sessionId: string) => string | null;

    saveAgentModelForSession: (sessionId: string, agentName: string, providerId: string, modelId: string) => void;
    getAgentModelForSession: (sessionId: string, agentName: string) => { providerId: string; modelId: string } | null;

    saveAgentModelVariantForSession: (sessionId: string, agentName: string, providerId: string, modelId: string, variant: string | undefined) => void;
    getAgentModelVariantForSession: (sessionId: string, agentName: string, providerId: string, modelId: string) => string | undefined;


    isOpenChamberCreatedSession: (sessionId: string) => boolean;

    markSessionAsOpenChamberCreated: (sessionId: string) => void;

    initializeNewOpenChamberSession: (sessionId: string, agents: Array<{ name: string; [key: string]: unknown }>) => void;

    setWorktreeMetadata: (sessionId: string, metadata: import('@/types/worktree').WorktreeMetadata | null) => void;
    getWorktreeMetadata: (sessionId: string) => import('@/types/worktree').WorktreeMetadata | undefined;

    getContextUsageForSession: (sessionId: string | null, directory?: string | null) => SessionContextUsage | null;

    updateSessionContextUsage: (sessionId: string, capacity: ResolvedModelContextCapacity) => void;

    initializeSessionContextUsage: (sessionId: string, capacity: ResolvedModelContextCapacity) => void;

     debugSessionMessages: (sessionId: string) => Promise<void>;

     pollForTokenUpdates: (sessionId: string, messageId: string, maxAttempts?: number) => void;
     updateSession: (session: Session) => void;
     removeSessionFromStore: (sessionId: string) => void;

      revertToMessage: (sessionId: string, messageId: string) => Promise<void>;
      handleSlashUndo: (sessionId: string) => Promise<void>;
      handleSlashRedo: (sessionId: string) => Promise<void>;
      forkFromMessage: (sessionId: string, messageId: string) => Promise<void>;
      setPendingInputText: (
        text: string | null,
        mode?: 'replace' | 'append' | 'append-inline',
        payload?: {
          selection?: { start: number; end: number };
          source?: 'voice' | 'action';
          preserveFocus?: boolean;
        },
      ) => void;
      consumePendingInputText: () => {
        text: string;
        mode: 'replace' | 'append' | 'append-inline';
        selection?: { start: number; end: number };
        source?: 'voice' | 'action';
        preserveFocus?: boolean;
      } | null;
      setPendingSyntheticParts: (parts: SyntheticContextPart[] | null) => void;
     consumePendingSyntheticParts: () => SyntheticContextPart[] | null;
   }
