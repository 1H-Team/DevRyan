import { MAX_CHAT_WIDTH, MIN_CHAT_WIDTH } from '@/lib/chatLayout';

export interface PreviewSegment {
    kind: 'text' | 'strong' | 'code';
    text: string;
}

const INLINE_MARKDOWN_PATTERN = /(\*\*[^*]+\*\*|`[^`]+`)/g;

/**
 * Splits preview sample text into plain, `**strong**` and `` `code` `` runs.
 * Only these two inline forms are supported; the preview never renders real Markdown.
 */
export const parsePreviewMarkdown = (source: string): PreviewSegment[] => {
    const segments: PreviewSegment[] = [];
    let cursor = 0;

    for (const match of source.matchAll(INLINE_MARKDOWN_PATTERN)) {
        const index = match.index ?? 0;
        const token = match[0];
        if (index > cursor) segments.push({ kind: 'text', text: source.slice(cursor, index) });
        segments.push(token.startsWith('**')
            ? { kind: 'strong', text: token.slice(2, -2) }
            : { kind: 'code', text: token.slice(1, -1) });
        cursor = index + token.length;
    }

    if (cursor < source.length) segments.push({ kind: 'text', text: source.slice(cursor) });
    return segments;
};

/** Horizontal padding the preview's miniature window adds on each side of the chat column. */
export const PREVIEW_WINDOW_GUTTER_PX = 96;

/** Chat column width as a fraction of the miniature window (640px → 0.4, 1408px → 0.88). */
export const getChatWidthRatio = (chatWidth: number): number => {
    const clamped = Number.isFinite(chatWidth)
        ? Math.min(MAX_CHAT_WIDTH, Math.max(MIN_CHAT_WIDTH, chatWidth))
        : MIN_CHAT_WIDTH;
    return clamped / (MAX_CHAT_WIDTH + 2 * PREVIEW_WINDOW_GUTTER_PX);
};
