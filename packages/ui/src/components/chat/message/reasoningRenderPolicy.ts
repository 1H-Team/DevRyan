import type { Part } from '@opencode-ai/sdk/v2';

type ReasoningPreviewPart = Part & {
    text?: string;
    content?: string;
    time?: { end?: number };
};

const XAI_PROVIDER_ID = 'xai';
const XAI_CLIPPED_REASONING_LENGTH = 203;
const XAI_CLIPPED_REASONING_SUFFIX = '...';

/**
 * Grok 4.6 can finalize its plaintext reasoning summary as a 200-character
 * prefix plus an ASCII ellipsis. The missing tail is not available to the UI,
 * so suppress only this confirmed provider fingerprint and fail open for every
 * other shape.
 */
export const isKnownClippedXaiReasoningPreview = (
    part: Part,
    providerID?: string | null,
): boolean => {
    if (providerID?.trim().toLowerCase() !== XAI_PROVIDER_ID || part.type !== 'reasoning') {
        return false;
    }

    const reasoningPart = part as ReasoningPreviewPart;
    if (typeof reasoningPart.time?.end !== 'number') {
        return false;
    }

    const text = reasoningPart.text || reasoningPart.content || '';
    const normalizedText = text.trim();
    return normalizedText.length === XAI_CLIPPED_REASONING_LENGTH
        && normalizedText.endsWith(XAI_CLIPPED_REASONING_SUFFIX);
};

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
