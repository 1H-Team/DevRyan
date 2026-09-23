import type { Part } from '@opencode-ai/sdk/v2';

export type CompactionKind = 'automatic' | 'manual';

export interface CompactionBoundary {
    kind: CompactionKind;
}

type PartLike = { type?: unknown; auto?: unknown } | null | undefined;

/** The native compaction request part carries `auto: true` for automatic
 * (overflow) compaction; a missing flag is a manual /compact. */
export const readCompactionPart = (parts: readonly (Part | PartLike)[] | undefined): CompactionBoundary | null => {
    if (!parts) return null;
    for (const part of parts) {
        const candidate = part as PartLike;
        if (candidate?.type === 'compaction') {
            return { kind: candidate.auto === true ? 'automatic' : 'manual' };
        }
    }
    return null;
};

/** Display-normalized compaction user messages carry their boundary on info. */
export const getCompactionBoundary = (message: { info: unknown } | null | undefined): CompactionBoundary | null => {
    const boundary = (message?.info as { clientCompaction?: unknown } | undefined)?.clientCompaction;
    if (!boundary || typeof boundary !== 'object') return null;
    const kind = (boundary as { kind?: unknown }).kind;
    return kind === 'automatic' || kind === 'manual' ? { kind } : null;
};

export { isCompactionSummaryInfo } from '@/sync/compaction-summary';
