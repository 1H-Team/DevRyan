import type { Message, Part } from "@opencode-ai/sdk/v2";
import type {
    ContextUsageRelatedSession,
    ContextUsageTokenBreakdown,
    SessionContextUsage,
} from "@/stores/types/sessionTypes";
import { calculateContextUsage } from "./contextUtils";
import {
    resolveModelContextCapacity,
    UNAVAILABLE_MODEL_CONTEXT_CAPACITY,
    type ResolvedModelContextCapacity,
} from "./modelContextCapacity";
import { extractTokenBreakdownFromMessage, type ExtractedTokenBreakdown } from "./tokenUtils";

export type ContextUsageMessage = Message | { info: Message; parts: Part[] };

export type ContextUsageSessionLike = {
    id?: string;
    title?: string | null;
    parentID?: string | null;
};

export type SubagentContextUsageResult = {
    sessions: ContextUsageRelatedSession[];
    activeInputTokens: number;
};

export type ContextUsageRequestState = {
    providerID: string | null;
    lastMessageId: string | null;
    activeInputTokens: number;
    compactionBoundaryId: string | null;
};

export type ContextUsageProviderModelLike = {
    id?: string;
    limit?: { input?: number; context?: number; output?: number };
    variants?: Record<string, { limit?: { input?: number; context?: number; output?: number } }>;
};

export type ContextUsageProviderLike = {
    id?: string;
    authType?: string;
    models?: ContextUsageProviderModelLike[];
};

const OPENAI_OAUTH_OFFICIAL_CONTEXT_MODEL_IDS = new Set([
    "gpt-5.4",
    "gpt-5.4-fast",
    "gpt-5.4-mini",
    "gpt-5.4-mini-fast",
    "gpt-5.5",
    "gpt-5.5-fast",
    "gpt-5.6-sol",
    "gpt-5.6-sol-fast",
    "gpt-5.6-terra",
    "gpt-5.6-terra-fast",
    "gpt-5.6-luna",
    "gpt-5.6-luna-fast",
]);

const getMessageInfo = (message: ContextUsageMessage): Message => {
    return "info" in message ? message.info : message;
};

const isAssistantMessage = (message: ContextUsageMessage): boolean => {
    return getMessageInfo(message).role === "assistant";
};

const getMessageId = (message: ContextUsageMessage): string | undefined => {
    const id = getMessageInfo(message).id;
    return typeof id === "string" ? id : undefined;
};

const getMessageParts = (message: ContextUsageMessage): Part[] => (
    "info" in message && Array.isArray(message.parts) ? message.parts : []
);

const getCompactionBoundary = (
    messages: ContextUsageMessage[],
): { index: number; id: string | null } => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        const isBoundary = getMessageParts(message).some((part) => {
            if (part.type === "compaction") return true;
            if (part.type !== "text") return false;
            const text = (part as Part & { text?: unknown; content?: unknown }).text;
            const content = (part as Part & { content?: unknown }).content;
            const value = typeof text === "string" ? text : typeof content === "string" ? content : "";
            return value.trim() === "/compact";
        });
        if (!isBoundary) continue;
        return { index, id: getMessageId(message) ?? null };
    }
    return { index: -1, id: null };
};

const activeInputTokens = (breakdown: ExtractedTokenBreakdown): number => {
    const detailed = breakdown.input + breakdown.cacheRead + breakdown.cacheWrite;
    return detailed > 0 ? detailed : breakdown.total;
};

const getProcessedInputTokens = (messages: ContextUsageMessage[]): number => messages.reduce((sum, message) => {
    if (!isAssistantMessage(message)) return sum;
    return sum + activeInputTokens(extractTokenBreakdownFromMessage(message));
}, 0);

const getLatestTokenBearingAssistantMessage = (
    messages: ContextUsageMessage[],
): { message: ContextUsageMessage; breakdown: ExtractedTokenBreakdown } | null => {
    const boundary = getCompactionBoundary(messages).index;
    for (let index = messages.length - 1; index > boundary; index -= 1) {
        const message = messages[index];
        if (!isAssistantMessage(message)) continue;
        const breakdown = extractTokenBreakdownFromMessage(message);
        if (activeInputTokens(breakdown) <= 0) continue;
        return { message, breakdown };
    }
    return null;
};

const resolveMessageContextCapacity = (
    message: ContextUsageMessage,
    providers: ContextUsageProviderLike[],
): ResolvedModelContextCapacity => {
    const info = getMessageInfo(message) as Message & {
        providerID?: unknown;
        modelID?: unknown;
        variant?: unknown;
    };
    if (typeof info.providerID !== "string" || typeof info.modelID !== "string") {
        return UNAVAILABLE_MODEL_CONTEXT_CAPACITY;
    }
    const provider = providers.find((entry) => entry.id === info.providerID);
    const model = provider?.models?.find((entry) => entry.id === info.modelID);
    if (!model) return UNAVAILABLE_MODEL_CONTEXT_CAPACITY;
    const variant = typeof info.variant === "string" ? info.variant : undefined;
    const preferOfficialOpenAIContext = info.providerID === "openai"
        && provider?.authType === "oauth"
        && OPENAI_OAUTH_OFFICIAL_CONTEXT_MODEL_IDS.has(info.modelID);
    return resolveModelContextCapacity(model, variant, {
        preferContext: preferOfficialOpenAIContext,
    });
};

const buildTokenBreakdown = (breakdown: ExtractedTokenBreakdown): ContextUsageTokenBreakdown => ({
    input: breakdown.input,
    output: breakdown.output,
    reasoning: breakdown.reasoning,
    cacheRead: breakdown.cacheRead,
    cacheWrite: breakdown.cacheWrite,
    total: breakdown.total,
});

const hasDetailedTokenBreakdown = (breakdown: ContextUsageTokenBreakdown): boolean => (
    breakdown.input > 0
    || breakdown.output > 0
    || breakdown.reasoning > 0
    || breakdown.cacheRead > 0
    || breakdown.cacheWrite > 0
);

export const buildContextUsageFromTokenBreakdown = (
    breakdown: ExtractedTokenBreakdown,
    capacity: ResolvedModelContextCapacity,
    lastMessageId?: string,
    processedInputTokens?: number,
    updatedAt: number = Date.now(),
    providerID?: string,
): SessionContextUsage => {
    const activeTokens = activeInputTokens(breakdown);
    const usage = calculateContextUsage(activeTokens, capacity);
    const tokenBreakdown = buildTokenBreakdown(breakdown);
    tokenBreakdown.total = activeTokens;

    return {
        ...(providerID ? { providerID } : {}),
        activeInputTokens: activeTokens,
        lastOutputTokens: breakdown.output,
        ...(processedInputTokens === undefined ? {} : { processedInputTokens }),
        source: "message-fallback",
        updatedAt,
        percentage: usage.percentage,
        capacityLimit: usage.capacityLimit,
        capacityBasis: usage.capacityBasis,
        inputLimit: usage.inputLimit,
        contextLimit: usage.contextLimit,
        outputLimit: usage.outputLimit,
        lastMessageId,
        tokenBreakdown,
        hasTokenBreakdown: hasDetailedTokenBreakdown(tokenBreakdown),
    };
};

export const getContextUsageFromMessages = (
    messages: ContextUsageMessage[],
    capacity: ResolvedModelContextCapacity,
): SessionContextUsage | null => {
    const latest = getLatestTokenBearingAssistantMessage(messages);
    if (!latest) return null;
    const info = getMessageInfo(latest.message) as Message & {
        providerID?: unknown;
        time?: { completed?: number; created?: number };
    };
    return buildContextUsageFromTokenBreakdown(
        latest.breakdown,
        capacity,
        getMessageId(latest.message),
        getProcessedInputTokens(messages),
        info.time?.completed ?? info.time?.created ?? Date.now(),
        typeof info.providerID === "string" ? info.providerID : undefined,
    );
};

export const getProviderContextUsageFromMessages = (
    messages: ContextUsageMessage[],
    providers: ContextUsageProviderLike[],
): SessionContextUsage | null => {
    const latest = getLatestTokenBearingAssistantMessage(messages);
    if (!latest) return null;
    const info = getMessageInfo(latest.message) as Message & {
        providerID?: unknown;
        time?: { completed?: number; created?: number };
    };
    return buildContextUsageFromTokenBreakdown(
        latest.breakdown,
        resolveMessageContextCapacity(latest.message, providers),
        getMessageId(latest.message),
        getProcessedInputTokens(messages),
        info.time?.completed ?? info.time?.created ?? Date.now(),
        typeof info.providerID === "string" ? info.providerID : undefined,
    );
};

export const getContextUsageRequestState = (
    messages: ContextUsageMessage[],
): ContextUsageRequestState => {
    const latest = getLatestTokenBearingAssistantMessage(messages);
    const info = latest ? getMessageInfo(latest.message) as Message & { providerID?: unknown } : null;
    return {
        providerID: typeof info?.providerID === "string" ? info.providerID : null,
        lastMessageId: latest ? getMessageId(latest.message) ?? null : null,
        activeInputTokens: latest ? activeInputTokens(latest.breakdown) : 0,
        compactionBoundaryId: getCompactionBoundary(messages).id,
    };
};

export const buildContextUsageFromProviderSnapshot = (
    snapshot: {
        inputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        activeInputTokens: number;
        lastOutputTokens: number;
        fetchedAt: number;
    },
    fallback: SessionContextUsage | null,
): SessionContextUsage => {
    const capacity: ResolvedModelContextCapacity = fallback
        ? {
            capacityLimit: fallback.capacityLimit,
            capacityBasis: fallback.capacityBasis,
            inputLimit: fallback.inputLimit,
            contextLimit: fallback.contextLimit,
            outputLimit: fallback.outputLimit,
        }
        : UNAVAILABLE_MODEL_CONTEXT_CAPACITY;
    const usage = calculateContextUsage(snapshot.activeInputTokens, capacity);
    return {
        ...(fallback?.providerID ? { providerID: fallback.providerID } : {}),
        activeInputTokens: snapshot.activeInputTokens,
        lastOutputTokens: snapshot.lastOutputTokens,
        ...(fallback?.processedInputTokens === undefined
            ? {}
            : { processedInputTokens: fallback.processedInputTokens }),
        source: "meridian",
        updatedAt: snapshot.fetchedAt,
        percentage: usage.percentage,
        capacityLimit: usage.capacityLimit,
        capacityBasis: usage.capacityBasis,
        inputLimit: usage.inputLimit,
        contextLimit: usage.contextLimit,
        outputLimit: usage.outputLimit,
        ...(fallback?.lastMessageId ? { lastMessageId: fallback.lastMessageId } : {}),
        tokenBreakdown: {
            input: snapshot.inputTokens,
            output: snapshot.lastOutputTokens,
            reasoning: fallback?.tokenBreakdown.reasoning ?? 0,
            cacheRead: snapshot.cacheReadTokens,
            cacheWrite: snapshot.cacheWriteTokens,
            total: snapshot.activeInputTokens,
        },
        hasTokenBreakdown: true,
        ...(fallback?.relatedSubagentSessions
            ? { relatedSubagentSessions: fallback.relatedSubagentSessions }
            : {}),
        ...(fallback?.relatedSubagentActiveInputTokens === undefined
            ? {}
            : { relatedSubagentActiveInputTokens: fallback.relatedSubagentActiveInputTokens }),
    };
};

export const getSubagentContextUsageForSession = (
    rootSessionId: string,
    sessions: ContextUsageSessionLike[],
    getMessages: (sessionId: string, session: ContextUsageSessionLike) => ContextUsageMessage[],
    providers: ContextUsageProviderLike[],
): SubagentContextUsageResult => {
    if (!rootSessionId || sessions.length === 0) {
        return { sessions: [], activeInputTokens: 0 };
    }

    const childrenByParent = new Map<string, ContextUsageSessionLike[]>();
    for (const session of sessions) {
        if (!session.id || !session.parentID) continue;
        const collection = childrenByParent.get(session.parentID) ?? [];
        collection.push(session);
        childrenByParent.set(session.parentID, collection);
    }

    const relatedSessions: ContextUsageRelatedSession[] = [];
    const visited = new Set<string>([rootSessionId]);
    const queue: Array<{ session: ContextUsageSessionLike; parentSessionId: string; depth: number }> = (
        childrenByParent.get(rootSessionId) ?? []
    ).map((session) => ({ session, parentSessionId: rootSessionId, depth: 0 }));

    for (let index = 0; index < queue.length; index += 1) {
        const { session, parentSessionId, depth } = queue[index];
        const sessionId = session.id;
        if (!sessionId || visited.has(sessionId)) continue;
        visited.add(sessionId);

        const childMessages = getMessages(sessionId, session);
        const usage = childMessages.length > 0
            ? getProviderContextUsageFromMessages(childMessages, providers)
            : null;

        if (usage && usage.activeInputTokens > 0) {
            relatedSessions.push({
                sessionId,
                ...(session.title?.trim() ? { title: session.title.trim() } : {}),
                activeInputTokens: usage.activeInputTokens,
                ...(usage.processedInputTokens === undefined ? {} : { processedInputTokens: usage.processedInputTokens }),
                capacityLimit: usage.capacityLimit,
                capacityBasis: usage.capacityBasis,
                inputLimit: usage.inputLimit,
                contextLimit: usage.contextLimit,
                outputLimit: usage.outputLimit,
                percentage: usage.percentage,
                ...(usage.lastMessageId ? { lastMessageId: usage.lastMessageId } : {}),
                parentSessionId,
                depth,
                hasData: true,
                tokenBreakdown: usage.tokenBreakdown,
            });
        } else {
            // The child's messages are not loaded (or carry no token data) —
            // keep the row so the panel can show it and fetch on expand.
            relatedSessions.push({
                sessionId,
                ...(session.title?.trim() ? { title: session.title.trim() } : {}),
                activeInputTokens: 0,
                capacityLimit: null,
                capacityBasis: "unavailable",
                inputLimit: null,
                contextLimit: null,
                outputLimit: null,
                percentage: null,
                parentSessionId,
                depth,
                hasData: false,
            });
        }

        queue.push(...(childrenByParent.get(sessionId) ?? [])
            .map((child) => ({ session: child, parentSessionId: sessionId, depth: depth + 1 })));
    }

    return {
        sessions: relatedSessions,
        activeInputTokens: relatedSessions.reduce((sum, session) => sum + session.activeInputTokens, 0),
    };
};

export const attachRelatedSubagentContextUsage = (
    usage: SessionContextUsage,
    related: SubagentContextUsageResult,
): SessionContextUsage => {
    // Rows without loaded data (hasData: false) are kept so the panel can show
    // them and fetch on expand — only an entirely empty tree is dropped.
    if (related.sessions.length === 0) {
        return usage;
    }

    return {
        ...usage,
        relatedSubagentSessions: related.sessions,
        relatedSubagentActiveInputTokens: related.activeInputTokens,
    };
};

export const isSameSessionContextUsage = (
    a: SessionContextUsage | null | undefined,
    b: SessionContextUsage | null | undefined,
): boolean => {
    if (a === b) return true;
    if (!a || !b) return false;
    const aSubagents = a.relatedSubagentSessions ?? [];
    const bSubagents = b.relatedSubagentSessions ?? [];

    return a.activeInputTokens === b.activeInputTokens
        && (a.providerID ?? "") === (b.providerID ?? "")
        && a.lastOutputTokens === b.lastOutputTokens
        && (a.processedInputTokens ?? 0) === (b.processedInputTokens ?? 0)
        && a.source === b.source
        && a.updatedAt === b.updatedAt
        && a.percentage === b.percentage
        && a.capacityLimit === b.capacityLimit
        && a.capacityBasis === b.capacityBasis
        && a.inputLimit === b.inputLimit
        && a.contextLimit === b.contextLimit
        && a.outputLimit === b.outputLimit
        && (a.lastMessageId ?? "") === (b.lastMessageId ?? "")
        && a.hasTokenBreakdown === b.hasTokenBreakdown
        && a.tokenBreakdown.input === b.tokenBreakdown.input
        && a.tokenBreakdown.output === b.tokenBreakdown.output
        && a.tokenBreakdown.reasoning === b.tokenBreakdown.reasoning
        && a.tokenBreakdown.cacheRead === b.tokenBreakdown.cacheRead
        && a.tokenBreakdown.cacheWrite === b.tokenBreakdown.cacheWrite
        && a.tokenBreakdown.total === b.tokenBreakdown.total
        && (a.relatedSubagentActiveInputTokens ?? 0) === (b.relatedSubagentActiveInputTokens ?? 0)
        && aSubagents.length === bSubagents.length
        && aSubagents.every((session, index) => {
            const other = bSubagents[index];
            return other
                && session.sessionId === other.sessionId
                && (session.title ?? "") === (other.title ?? "")
                && session.activeInputTokens === other.activeInputTokens
                && (session.processedInputTokens ?? 0) === (other.processedInputTokens ?? 0)
                && session.capacityLimit === other.capacityLimit
                && session.capacityBasis === other.capacityBasis
                && session.inputLimit === other.inputLimit
                && session.contextLimit === other.contextLimit
                && session.outputLimit === other.outputLimit
                && session.percentage === other.percentage
                && (session.lastMessageId ?? "") === (other.lastMessageId ?? "")
                && (session.parentSessionId ?? "") === (other.parentSessionId ?? "")
                && (session.depth ?? 0) === (other.depth ?? 0)
                && (session.hasData ?? true) === (other.hasData ?? true)
                && (session.tokenBreakdown?.total ?? 0) === (other.tokenBreakdown?.total ?? 0);
        });
};
