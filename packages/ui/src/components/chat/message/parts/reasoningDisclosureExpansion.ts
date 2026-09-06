const MAX_EXPANDED_RUNS = 4_000;
const MAX_KEY_BYTES = 512 * 1024;

// Only explicit expansion choices survive row/layout remounts. Reasoning text and
// streaming state never enter this cache or notify other message subscribers.
const expandedRuns = new Set<string>();
let keyBytes = 0;

export const getReasoningDisclosureKey = (
    sessionId: string | undefined,
    messageId: string | undefined,
    firstPartId: string | undefined,
): string | null => {
    if (!sessionId || !messageId || !firstPartId) return null;
    return JSON.stringify([sessionId, messageId, firstPartId]);
};

export const readReasoningDisclosureExpansion = (key: string | null): boolean => {
    if (key === null || !expandedRuns.has(key)) return false;
    expandedRuns.delete(key);
    expandedRuns.add(key);
    return true;
};

export const writeReasoningDisclosureExpansion = (key: string | null, expanded: boolean): void => {
    if (key === null) return;

    if (expandedRuns.delete(key)) keyBytes -= key.length * 2;
    if (!expanded || key.length * 2 > MAX_KEY_BYTES) return;

    expandedRuns.add(key);
    keyBytes += key.length * 2;
    while (expandedRuns.size > MAX_EXPANDED_RUNS || keyBytes > MAX_KEY_BYTES) {
        const oldest = expandedRuns.values().next().value;
        if (oldest === undefined) break;
        expandedRuns.delete(oldest);
        keyBytes -= oldest.length * 2;
    }
};
