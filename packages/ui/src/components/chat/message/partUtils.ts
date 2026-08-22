import type { Part } from '@opencode-ai/sdk/v2';

type PartWithText = Part & { text?: string; content?: string; value?: string };

export const isValidPart = (part: unknown): part is Part => {
    return Boolean(part && typeof part === 'object' && typeof (part as { type?: unknown }).type === 'string');
};

export const normalizeParts = (parts: Part[]): Part[] => {
    return parts.filter(isValidPart);
};

export const extractTextContent = (part: Part): string => {
    const partWithText = part as PartWithText;
    const rawText = partWithText.text;
    if (typeof rawText === 'string') {
        return rawText;
    }
    return partWithText.content || partWithText.value || '';
};

export const isEmptyTextPart = (part: Part): boolean => {
    if (part.type !== 'text') {
        return false;
    }
    const text = extractTextContent(part);
    return !text || text.trim().length === 0;
};

type PartWithSynthetic = Part & { synthetic?: boolean };

interface VisibleFilterOptions {
    includeReasoning?: boolean;
}

export const filterVisibleParts = (parts: Part[], options: VisibleFilterOptions = {}): Part[] => {
    const { includeReasoning = true } = options;
    const validParts = normalizeParts(parts);

    // Check if there are any non-synthetic parts
    const hasNonSynthetic = validParts.some((part) => {
        const partWithSynthetic = part as PartWithSynthetic;
        return !partWithSynthetic.synthetic;
    });

    return validParts.filter((part) => {
        const partWithSynthetic = part as PartWithSynthetic;
        const isSynthetic = Boolean(partWithSynthetic.synthetic);

        if (isSynthetic && part.type === 'text') {
            const text = extractTextContent(part);
            if (text.includes('<system-reminder>')) {
                return false;
            }
        }

        // Only filter out synthetic parts if there are non-synthetic parts present
        // Otherwise, show synthetic parts so the message is displayed
        if (isSynthetic && hasNonSynthetic) {
            return false;
        }
        if (!includeReasoning && part.type === 'reasoning') {
            return false;
        }
        const isPatchPart = part.type === 'patch';

        return !isPatchPart;
    });
};

type PartWithTime = Part & { time?: { start?: number; end?: number } };

export const isFinalizedTextPart = (part: Part): boolean => {
    if (part.type !== 'text') {
        return false;
    }
    const time = (part as PartWithTime).time;
    return Boolean(time && typeof time.end !== 'undefined');
};

const MIN_DUPLICATE_TEXT_PART_LENGTH = 32;

// Compare text parts for duplication after collapsing internal whitespace runs, so
// frames that differ only by incidental whitespace/newlines still collapse.
const normalizeForDuplicateCompare = (value: string): string => value.trim().replace(/\s+/g, ' ');

// Detection hook for the intermittent "duplicate output" bug. Fires only on an actual
// duplicate (rare by construction), so it is safe to surface in any build. The distinctive
// tag makes occurrences greppable in console logs / bug reports.
const reportDuplicateTextPart = (
    kind: 'collapsed-exact' | 'near-duplicate-not-collapsed',
    detail: Record<string, unknown>,
): void => {
    try {
        console.warn(`[DevRyan:dup] ${kind} adjacent text part`, detail);
    } catch {
        // Telemetry must never break rendering.
    }
};

const partId = (part: Part): string | null => {
    const id = (part as { id?: unknown }).id;
    return typeof id === 'string' ? id : null;
};

export const collapseExactDuplicateAdjacentTextParts = (parts: Part[]): Part[] => {
    const collapsed: Part[] = [];
    let previousText: string | null = null;
    let previousId: string | null = null;

    for (const part of parts) {
        if (part.type !== 'text') {
            collapsed.push(part);
            previousText = null;
            previousId = null;
            continue;
        }

        const text = normalizeForDuplicateCompare(extractTextContent(part));
        if (text.length >= MIN_DUPLICATE_TEXT_PART_LENGTH && previousText !== null) {
            if (previousText === text) {
                reportDuplicateTextPart('collapsed-exact', {
                    keptId: previousId,
                    droppedId: partId(part),
                    length: text.length,
                });
                continue;
            }
            // Detection only (no behavior change): a separate part that fully contains the
            // previous one usually means a re-emitted/partial frame replay. Surface it so the
            // partial-overlap case can be measured before we change collapsing behavior.
            if (previousText.includes(text) || text.includes(previousText)) {
                reportDuplicateTextPart('near-duplicate-not-collapsed', {
                    previousId,
                    partId: partId(part),
                    previousLength: previousText.length,
                    length: text.length,
                });
            }
        }

        collapsed.push(part);
        previousText = text.length > 0 ? text : null;
        previousId = text.length > 0 ? partId(part) : null;
    }

    return collapsed;
};

// Tools whose every call emits a full-state snapshot, so only the final call is meaningful.
const LATEST_ONLY_TOOL_NAMES = new Set<string>(['todowrite', 'todoread']);

const toolPartName = (part: Part): string | null => {
    if (part.type !== 'tool') {
        return null;
    }
    const name = (part as { tool?: unknown }).tool;
    return typeof name === 'string' ? name.toLowerCase() : null;
};

// `todowrite`/`todoread` re-emit the entire todo list on every update, so a turn with several
// updates renders a churn of redundant "Update Todo List" rows. Keep only the surviving snapshot
// so the transcript shows one up-to-date todo summary. Display-only: the store retains every part.
//
// `keepPartId` lets a caller scope the survivor across an entire turn (which can span multiple
// assistant messages): pass the turn's last todo-tool part id and every message hides its todo
// rows except the one that owns that id. When omitted, it falls back to keep-last within `parts`.
export const collapseSupersededTodoWrites = (parts: Part[], keepPartId?: string | null): Part[] => {
    const hasTodoPart = parts.some((part) => {
        const name = toolPartName(part);
        return name !== null && LATEST_ONLY_TOOL_NAMES.has(name);
    });
    if (!hasTodoPart) {
        return parts;
    }

    let keepIndex = -1;
    if (keepPartId) {
        // Turn-scoped: keep only the part matching the turn's surviving todo id. If that part
        // lives in another message, keepIndex stays -1 and all todo rows here are hidden.
        keepIndex = parts.findIndex((part) => {
            const name = toolPartName(part);
            return name !== null
                && LATEST_ONLY_TOOL_NAMES.has(name)
                && (part as { id?: unknown }).id === keepPartId;
        });
    } else {
        // Message-scoped fallback: keep the last todo snapshot within these parts.
        for (let index = 0; index < parts.length; index += 1) {
            const name = toolPartName(parts[index]);
            if (name !== null && LATEST_ONLY_TOOL_NAMES.has(name)) {
                keepIndex = index;
            }
        }
    }

    return parts.filter((part, index) => {
        const name = toolPartName(part);
        if (name !== null && LATEST_ONLY_TOOL_NAMES.has(name)) {
            return index === keepIndex;
        }
        return true;
    });
};

type MergeableTextPart = Part & {
    id?: string;
    text?: string;
    content?: string;
    value?: string;
    time?: { start?: number; end?: number };
};

export const mergeConsecutiveTextParts = (parts: Part[]): Part => {
    if (parts.length <= 1) {
        return parts[0];
    }

    const displayParts = collapseExactDuplicateAdjacentTextParts(parts);
    if (displayParts.length <= 1) {
        return displayParts[0] ?? parts[0];
    }

    const firstPart = displayParts[0] as MergeableTextPart;
    // Keep the transport's own whitespace at each seam; only fabricate a soft
    // break when the split point carries none. Trimming the seams used to
    // manufacture markdown artifacts — a list split right after its marker
    // rendered an empty "1." item, and mid-sentence splits lost their space.
    const mergedText = displayParts
        .map((part) => extractTextContent(part))
        .filter((text) => text.trim().length > 0)
        .reduce((accumulated, text) => {
            if (!accumulated) return text;
            const seamHasWhitespace = /\s$/.test(accumulated) || /^\s/.test(text);
            return seamHasWhitespace ? accumulated + text : `${accumulated}\n${text}`;
        }, '');
    const finalizedTextParts = displayParts
        .map((part) => part as MergeableTextPart)
        .filter((part) => typeof part.time?.end !== 'undefined');
    const lastFinalizedPart = finalizedTextParts[finalizedTextParts.length - 1];
    const allPartsFinalized = finalizedTextParts.length === displayParts.length;
    const mergedTime = allPartsFinalized && typeof firstPart.time?.start === 'number'
        ? { start: firstPart.time.start, end: lastFinalizedPart?.time?.end }
        : firstPart.time;

    // Decision: merge only adjacent text parts for rendering so a plan split by the
    // message transport is detected as one plan, while tool/reasoning boundaries stay intact.
    const mergedPart = {
        ...firstPart,
        id: displayParts
            .map((part, index) => (part as MergeableTextPart).id ?? `text-${index}`)
            .join(':merged:'),
        text: mergedText,
        content: undefined,
        value: undefined,
        time: mergedTime,
    };
    return mergedPart as unknown as Part;
};
