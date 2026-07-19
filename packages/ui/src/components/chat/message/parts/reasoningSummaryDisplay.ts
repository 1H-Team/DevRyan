import type { ResponseStyleLevel } from '@/lib/responseStyle';

const BLOCK_SEPARATOR_PATTERN = /(\n[ \t]*\n+)/;
const TERMINAL_PUNCTUATION_PATTERN = /[.!?…:;](?:["'’”)}\]])?$/;

const cleanReasoningText = (text: string): string => {
    if (typeof text !== 'string' || text.trim().length === 0) return '';
    return text.trim();
};

const projectParagraphs = (text: string, paragraphLimit: number): string => {
    const pieces = text.split(BLOCK_SEPARATOR_PATTERN);
    let paragraphsSeen = 0;
    let endIndex = pieces.length;

    for (let index = 0; index < pieces.length; index += 2) {
        if (!pieces[index]?.trim()) continue;
        paragraphsSeen += 1;
        if (paragraphsSeen === paragraphLimit) {
            endIndex = index + 1;
            break;
        }
    }

    return pieces.slice(0, endIndex).join('').trim();
};

const isProtectedMarkdownBlock = (text: string): boolean => {
    if (text.includes('\n')) return true;
    if (/^(?:#{1,6}\s|>\s?|[-+]\s|\*\s|\d+[.)]\s|```|~~~)/.test(text)) return true;
    if (text.includes('`')) return true;
    return /!?\[[^\]]+\]\([^)]+\)/.test(text);
};

const punctuateStandaloneSummary = (block: string): string => {
    const leading = block.match(/^\s*/)?.[0] ?? '';
    const trailing = block.match(/\s*$/)?.[0] ?? '';
    const text = block.slice(leading.length, block.length - trailing.length);
    if (!text || isProtectedMarkdownBlock(text)) return block;

    const boldMatch = /^\*\*(.+)\*\*$/.exec(text);
    if (boldMatch) {
        const inner = boldMatch[1].trimEnd();
        if (!inner || TERMINAL_PUNCTUATION_PATTERN.test(inner) || isProtectedMarkdownBlock(inner)) {
            return block;
        }
        return `${leading}**${inner}.**${trailing}`;
    }

    if (TERMINAL_PUNCTUATION_PATTERN.test(text)) return block;
    return `${leading}${text}.${trailing}`;
};

export const formatReasoningText = (
    text: string,
    providerID?: string | null,
    responseStyleLevel: ResponseStyleLevel = 'provider',
): string => {
    const cleaned = cleanReasoningText(text);
    if (!cleaned || providerID?.trim().toLowerCase() !== 'openai') return cleaned;

    const projected = responseStyleLevel === 'actions'
        ? projectParagraphs(cleaned, 1)
        : responseStyleLevel === 'concise'
            ? projectParagraphs(cleaned, 2)
            : cleaned;

    return projected
        .split(BLOCK_SEPARATOR_PATTERN)
        .map((piece, index) => index % 2 === 0 ? punctuateStandaloneSummary(piece) : piece)
        .join('');
};
