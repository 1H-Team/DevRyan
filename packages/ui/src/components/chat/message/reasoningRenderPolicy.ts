import type { Part } from '@opencode-ai/sdk/v2';

type ReasoningPreviewPart = Part & {
    text?: string;
    content?: string;
    time?: { end?: number };
};

const XAI_PROVIDER_ID = 'xai';
const XAI_CLIPPED_REASONING_PREFIX_LENGTH = 200;
const XAI_CLIPPED_REASONING_SUFFIX = '...';

const clippedXaiPreviewEnd = (text: string, providerID?: string | null): number | null => {
    if (text.length < XAI_CLIPPED_REASONING_PREFIX_LENGTH + XAI_CLIPPED_REASONING_SUFFIX.length
        || providerID?.trim().toLowerCase() !== XAI_PROVIDER_ID) return null;

    // Count characters without allocating an array for the entire streamed text.
    let offset = 0;
    let characters = 0;
    for (const character of text) {
        offset += character.length;
        characters += 1;
        if (characters === XAI_CLIPPED_REASONING_PREFIX_LENGTH) break;
    }
    if (characters !== XAI_CLIPPED_REASONING_PREFIX_LENGTH
        || !text.startsWith(XAI_CLIPPED_REASONING_SUFFIX, offset)
        || text[offset + XAI_CLIPPED_REASONING_SUFFIX.length] === '.') return null;

    return offset + XAI_CLIPPED_REASONING_SUFFIX.length;
};

/** Keep the fuller summary xAI sometimes appends directly to its clipped preview. */
export const stripKnownClippedXaiReasoningPrefix = (
    text: string,
    providerID?: string | null,
): string => {
    const end = clippedXaiPreviewEnd(text, providerID);
    if (end === null) return text;
    const summary = text.slice(end).trim();
    // A preview alone is still live text; the part lifecycle owns its visibility.
    return summary || text;
};

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
    return normalizedText.length === clippedXaiPreviewEnd(normalizedText, providerID);
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
