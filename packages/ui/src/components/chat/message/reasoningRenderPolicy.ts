export const filterGroupedActivityReasoning = <T extends { kind: string }>(parts: T[]): T[] => {
    if (!parts.some((part) => part.kind === 'reasoning')) {
        return parts;
    }

    return parts.filter((part) => part.kind !== 'reasoning');
};

export const shouldRenderReasoning = (showReasoningTraces: boolean): boolean => showReasoningTraces;

export const getReasoningPartRenderKey = (
    messageId: string,
    partId: string | undefined,
    index: number,
): string => `reasoning-${messageId}-${partId || index}`;
