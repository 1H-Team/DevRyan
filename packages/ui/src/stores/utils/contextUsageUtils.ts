import type { Message, Part } from "@opencode-ai/sdk/v2";
import type {
    ContextUsageRelatedSession,
    ContextUsageTokenBreakdown,
    SessionContextUsage,
} from "@/stores/types/sessionTypes";
import { calculateContextUsage } from "./contextUtils";
import type { ResolvedModelContextCapacity } from "./modelContextCapacity";
import { extractTokenBreakdownFromMessage, type ExtractedTokenBreakdown } from "./tokenUtils";

export type ContextUsageMessage = Message | { info: Message; parts: Part[] };

export type ContextUsageSessionLike = {
    id?: string;
    title?: string | null;
    parentID?: string | null;
};

export type SubagentContextUsageResult = {
    sessions: ContextUsageRelatedSession[];
    totalTokens: number;
};

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
): SessionContextUsage => {
    const usage = calculateContextUsage(breakdown.total, capacity);
    const tokenBreakdown = buildTokenBreakdown(breakdown);

    return {
        totalTokens: breakdown.total,
        percentage: usage.percentage,
        capacityLimit: usage.capacityLimit,
        capacityBasis: usage.capacityBasis,
        inputLimit: usage.inputLimit,
        contextLimit: usage.contextLimit,
        outputLimit: usage.outputLimit,
        lastMessageId,
        tokenBreakdown,
        hasTokenBreakdown: hasDetailedTokenBreakdown(tokenBreakdown),
        sources: breakdown.sources,
        sourceTotalTokens: breakdown.sourceTotalTokens,
        sourceAccuracy: breakdown.sourceAccuracy,
    };
};

export const getContextUsageFromMessages = (
    messages: ContextUsageMessage[],
    capacity: ResolvedModelContextCapacity,
): SessionContextUsage | null => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (!isAssistantMessage(message)) continue;
        const breakdown = extractTokenBreakdownFromMessage(message);
        if (breakdown.total <= 0) continue;
        return buildContextUsageFromTokenBreakdown(
            breakdown,
            capacity,
            getMessageId(message),
        );
    }

    return null;
};

export const getSubagentContextUsageForSession = (
    rootSessionId: string,
    sessions: ContextUsageSessionLike[],
    getMessages: (sessionId: string, session: ContextUsageSessionLike) => ContextUsageMessage[],
    getCapacity: (session: ContextUsageSessionLike, messages: ContextUsageMessage[]) => ResolvedModelContextCapacity,
): SubagentContextUsageResult => {
    if (!rootSessionId || sessions.length === 0) {
        return { sessions: [], totalTokens: 0 };
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
    const queue = [...(childrenByParent.get(rootSessionId) ?? [])];

    for (let index = 0; index < queue.length; index += 1) {
        const session = queue[index];
        const sessionId = session.id;
        if (!sessionId || visited.has(sessionId)) continue;
        visited.add(sessionId);

        const childMessages = getMessages(sessionId, session);
        if (childMessages.length > 0) {
            const capacity = getCapacity(session, childMessages);
            const usage = getContextUsageFromMessages(childMessages, capacity);
            if (usage && usage.totalTokens > 0) {
                relatedSessions.push({
                    sessionId,
                    ...(session.title?.trim() ? { title: session.title.trim() } : {}),
                    totalTokens: usage.totalTokens,
                    capacityLimit: usage.capacityLimit,
                    capacityBasis: usage.capacityBasis,
                    inputLimit: usage.inputLimit,
                    contextLimit: usage.contextLimit,
                    outputLimit: usage.outputLimit,
                    percentage: usage.percentage,
                    ...(usage.lastMessageId ? { lastMessageId: usage.lastMessageId } : {}),
                });
            }
        }

        queue.push(...(childrenByParent.get(sessionId) ?? []));
    }

    return {
        sessions: relatedSessions,
        totalTokens: relatedSessions.reduce((sum, session) => sum + session.totalTokens, 0),
    };
};

export const attachRelatedSubagentContextUsage = (
    usage: SessionContextUsage,
    related: SubagentContextUsageResult,
): SessionContextUsage => {
    if (related.sessions.length === 0 || related.totalTokens <= 0) {
        return usage;
    }

    return {
        ...usage,
        relatedSubagentSessions: related.sessions,
        relatedSubagentTotalTokens: related.totalTokens,
    };
};

export const isSameSessionContextUsage = (
    a: SessionContextUsage | null | undefined,
    b: SessionContextUsage | null | undefined,
): boolean => {
    if (a === b) return true;
    if (!a || !b) return false;
    const aSources = a.sources ?? [];
    const bSources = b.sources ?? [];
    const aSubagents = a.relatedSubagentSessions ?? [];
    const bSubagents = b.relatedSubagentSessions ?? [];

    return a.totalTokens === b.totalTokens
        && a.percentage === b.percentage
        && a.capacityLimit === b.capacityLimit
        && a.capacityBasis === b.capacityBasis
        && a.inputLimit === b.inputLimit
        && a.contextLimit === b.contextLimit
        && a.outputLimit === b.outputLimit
        && (a.lastMessageId ?? "") === (b.lastMessageId ?? "")
        && (a.sourceTotalTokens ?? 0) === (b.sourceTotalTokens ?? 0)
        && a.sourceAccuracy === b.sourceAccuracy
        && a.hasTokenBreakdown === b.hasTokenBreakdown
        && a.tokenBreakdown.input === b.tokenBreakdown.input
        && a.tokenBreakdown.output === b.tokenBreakdown.output
        && a.tokenBreakdown.reasoning === b.tokenBreakdown.reasoning
        && a.tokenBreakdown.cacheRead === b.tokenBreakdown.cacheRead
        && a.tokenBreakdown.cacheWrite === b.tokenBreakdown.cacheWrite
        && a.tokenBreakdown.total === b.tokenBreakdown.total
        && (a.relatedSubagentTotalTokens ?? 0) === (b.relatedSubagentTotalTokens ?? 0)
        && aSources.length === bSources.length
        && aSources.every((source, index) => {
            const other = bSources[index];
            return other
                && source.source === other.source
                && source.tokens === other.tokens
                && (source.label ?? "") === (other.label ?? "");
        })
        && aSubagents.length === bSubagents.length
        && aSubagents.every((session, index) => {
            const other = bSubagents[index];
            return other
                && session.sessionId === other.sessionId
                && (session.title ?? "") === (other.title ?? "")
                && session.totalTokens === other.totalTokens
                && session.capacityLimit === other.capacityLimit
                && session.capacityBasis === other.capacityBasis
                && session.inputLimit === other.inputLimit
                && session.contextLimit === other.contextLimit
                && session.outputLimit === other.outputLimit
                && session.percentage === other.percentage
                && (session.lastMessageId ?? "") === (other.lastMessageId ?? "");
        });
};
