export const filterGroupedActivityReasoning = <T extends { kind: string }>(parts: T[]): T[] => {
    if (!parts.some((part) => part.kind === 'reasoning')) {
        return parts;
    }

    return parts.filter((part) => part.kind !== 'reasoning');
};

export const shouldRenderInlineReasoning = (showReasoningTraces: boolean): boolean => showReasoningTraces;
