import type { SessionContextUsage } from '@/stores/types/sessionTypes';

export type ContextUsageAvailability = 'idle' | 'loading' | 'unavailable' | 'available';

type ResolveContextUsageAvailabilityInput = {
    sessionId: string | null | undefined;
    usage: SessionContextUsage | null;
    resolved: boolean;
};

export const resolveContextUsageAvailability = ({
    sessionId,
    usage,
    resolved,
}: ResolveContextUsageAvailabilityInput): ContextUsageAvailability => {
    const normalizedSessionId = sessionId?.trim() ?? '';
    if (!normalizedSessionId) return 'idle';
    if (usage && usage.activeInputTokens > 0) return 'available';
    return resolved ? 'unavailable' : 'loading';
};

export const shouldShowComposerContextUsage = ({
    isMobile,

}: {
    isMobile: boolean;

}): boolean => !isMobile;
