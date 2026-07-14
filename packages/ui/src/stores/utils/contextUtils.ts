import type { ResolvedModelContextCapacity } from "./modelContextCapacity";

export const calculateContextUsage = (
    totalTokens: number,
    capacity: ResolvedModelContextCapacity,
) => {
    const reportedTokens = Number.isFinite(totalTokens) ? Math.max(totalTokens, 0) : 0;
    const percentage = capacity.capacityLimit !== null
        ? (reportedTokens / capacity.capacityLimit) * 100
        : null;

    return {
        ...capacity,
        percentage,
    };
};
