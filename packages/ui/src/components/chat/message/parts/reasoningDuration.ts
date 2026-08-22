import type { Part } from '@opencode-ai/sdk/v2';

export interface TimedReasoningEntry {
    part: Part;
}

interface ReasoningTime {
    start?: number;
    end?: number;
}

export const getReasoningDurationMilliseconds = (
    entries: readonly TimedReasoningEntry[],
): number | null => {
    if (entries.length === 0) return null;

    let earliestStart = Number.POSITIVE_INFINITY;
    let latestEnd = Number.NEGATIVE_INFINITY;

    for (const entry of entries) {
        const time = (entry.part as Part & { time?: ReasoningTime }).time;
        const start = time?.start;
        const end = time?.end;
        if (typeof start !== 'number' || !Number.isFinite(start) || start < 0) return null;
        if (typeof end !== 'number' || !Number.isFinite(end) || end < 0 || end < start) return null;
        earliestStart = Math.min(earliestStart, start);
        latestEnd = Math.max(latestEnd, end);
    }

    const duration = latestEnd - earliestStart;
    return Number.isFinite(duration) && duration >= 0 ? duration : null;
};

export const formatReasoningDuration = (milliseconds: number): string | null => {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return null;

    const roundedSeconds = milliseconds > 0
        ? Math.max(1, Math.round(milliseconds / 1_000))
        : 0;
    if (roundedSeconds < 60) {
        return `${roundedSeconds}s`;
    }

    if (roundedSeconds < 3_600) {
        const minutes = Math.floor(roundedSeconds / 60);
        return `${minutes}m ${roundedSeconds % 60}s`;
    }

    const hours = Math.floor(roundedSeconds / 3_600);
    const minutes = Math.floor((roundedSeconds % 3_600) / 60);
    const seconds = roundedSeconds % 60;
    return `${hours}h ${minutes}m ${seconds}s`;
};
