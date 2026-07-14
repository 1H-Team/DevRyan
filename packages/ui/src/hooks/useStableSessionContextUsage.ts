import * as React from "react";
import type { SessionContextUsage } from "@/stores/types/sessionTypes";
import { isSameSessionContextUsage } from "@/stores/utils/contextUsageUtils";

export type StableSessionContextUsageInput = {
    directory: string | null | undefined;
    sessionId: string | null | undefined;
    usage: SessionContextUsage | null;
    resolved: boolean;
};

export type StableSessionContextUsageState = {
    key: string | null;
    usage: SessionContextUsage | null;
};

const createUsageKey = (
    directory: string | null | undefined,
    sessionId: string | null | undefined,
): string | null => {
    const normalizedSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
    if (!normalizedSessionId) return null;
    const normalizedDirectory = typeof directory === "string" ? directory.trim() : "";
    return JSON.stringify([normalizedDirectory, normalizedSessionId]);
};

export const reduceStableSessionContextUsage = (
    previous: StableSessionContextUsageState | undefined,
    input: StableSessionContextUsageInput,
): StableSessionContextUsageState => {
    const key = createUsageKey(input.directory, input.sessionId);
    const usage = input.usage?.totalTokens && input.usage.totalTokens > 0 ? input.usage : null;

    if (!previous || previous.key !== key) {
        return { key, usage: key ? usage : null };
    }

    if (usage) {
        return isSameSessionContextUsage(previous.usage, usage)
            ? previous
            : { key, usage };
    }

    if (!input.resolved) return previous;
    return previous.usage === null ? previous : { key, usage: null };
};

export const useStableSessionContextUsage = (
    input: StableSessionContextUsageInput,
): SessionContextUsage | null => {
    const stateRef = React.useRef<StableSessionContextUsageState | undefined>(undefined);
    const nextState = reduceStableSessionContextUsage(stateRef.current, input);
    stateRef.current = nextState;
    return nextState.usage;
};
