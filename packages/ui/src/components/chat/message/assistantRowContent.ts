import type { Part, ToolPart as ToolPartType } from '@opencode-ai/sdk/v2';

import {
    collapseSupersededTodoWrites,
    extractTextContent,
    filterVisibleParts,
    isEmptyTextPart,
} from './partUtils';
import { shouldSuppressIntermediateAssistantStatusText } from './assistantInlineActions';
import { isHiddenTool, isManagedTaskToolName } from './parts/toolRenderUtils';
import { isOrphanNarrationFragment } from '@/lib/messages/orphanNarration';
import { resolveCursorNativeTaskDispatches } from '../cursorNativeTaskDispatch';
import { resolveManagedTaskDispatch } from '../managedTaskDispatch';

/**
 * Shared projections for an assistant message row.
 *
 * `ChatMessage` and `MessageBody` both narrow a message's parts down to what is
 * actually painted, in two successive stages. Those stages used to be inlined in
 * each component, which meant nothing could cheaply answer "does this row render
 * anything at all?" without re-implementing (and drifting from) the filters.
 * Both stages now live here so the renderers and the header-visibility decision
 * share one source of truth.
 */

export interface AssistantDisplayPartsInput {
    parts: Part[];
    includeReasoning?: boolean;
    messageFinish?: string;
    isUser?: boolean;
}

export interface AssistantDisplayPartsProjection {
    visibleParts: Part[];
    displayParts: Part[];
}

/** Stage 1: synthetic/reasoning/patch filtering plus intermediate status-text suppression. */
export const projectAssistantDisplayParts = ({
    parts,
    includeReasoning = true,
    messageFinish,
    isUser = false,
}: AssistantDisplayPartsInput): AssistantDisplayPartsProjection => {
    const visibleParts = filterVisibleParts(parts, { includeReasoning });

    if (isUser) {
        return { visibleParts, displayParts: visibleParts };
    }

    const hasToolParts = visibleParts.some((part) => part.type === 'tool');
    if (!hasToolParts || messageFinish !== 'tool-calls') {
        return { visibleParts, displayParts: visibleParts };
    }

    let removedStatusText = false;
    const filtered = visibleParts.filter((part) => {
        if (part.type !== 'text') {
            return true;
        }
        const shouldSuppress = shouldSuppressIntermediateAssistantStatusText({
            messageFinish,
            hasToolParts,
            text: extractTextContent(part),
        });
        if (shouldSuppress) {
            removedStatusText = true;
            return false;
        }
        return true;
    });

    return { visibleParts, displayParts: removedStatusText ? filtered : visibleParts };
};

export interface AssistantVisiblePartsOptions {
    lastTodoToolPartId?: string | null;
}

export interface AssistantVisiblePartsProjection {
    visibleParts: Part[];
    cursorNativeTasks: ReturnType<typeof resolveCursorNativeTaskDispatches>;
    cursorNativeTaskPartIds: Set<string>;
}

/** Stage 2: the content filter `MessageBody` renders from. */
export const projectAssistantVisibleParts = (
    parts: Part[],
    { lastTodoToolPartId = null }: AssistantVisiblePartsOptions = {},
): AssistantVisiblePartsProjection => {
    const cursorNativeTasks = resolveCursorNativeTaskDispatches(parts);
    const cursorNativeTaskPartIds = new Set(cursorNativeTasks.map((task) => task.partId));

    const visibleParts = collapseSupersededTodoWrites(parts, lastTodoToolPartId)
        .filter((part) => !isEmptyTextPart(part))
        .filter((part) => {
            const rawPart = part as Record<string, unknown>;
            return rawPart.type !== 'compaction';
        })
        .filter((part) => part.type !== 'tool' || !cursorNativeTaskPartIds.has(part.id))
        .filter((part) => {
            // Hidden tools (e.g. create_plan, which is surfaced as the rich
            // Implementation Plan card) must never render as their own row.
            if (part.type !== 'tool') return true;
            if (isManagedTaskToolName((part as ToolPartType).tool)) return true;
            return !isHiddenTool((part as ToolPartType).tool);
        })
        .filter((part, index, arr) => {
            // Drop short mid-sentence narration fragments wedged between
            // tool/reasoning activity (composer choppy-narration noise).
            if (part.type !== 'text') return true;
            return !isOrphanNarrationFragment(
                extractTextContent(part),
                arr[index - 1]?.type,
                arr[index + 1]?.type,
            );
        });

    return { visibleParts, cursorNativeTasks, cursorNativeTaskPartIds };
};

export interface AssistantRowContentInput {
    /** Raw `message.parts`. */
    parts: Part[];
    messageFinish?: string;
    lastTodoToolPartId?: string | null;
    /** The row currently streaming keeps its header even with no content yet. */
    isLiveStreamingRow?: boolean;
    /** Row paints an error, transport-recovery or abort surface. */
    hasErrorSurface?: boolean;
    /** Row owns the turn's Agent Dispatch card. */
    ownsManagedTaskCard?: boolean;
    /** Row owns the turn's generated-image gallery. */
    ownsAssistantImages?: boolean;
    /** Row anchors turn activity rows. */
    ownsActivityOutput?: boolean;
}

/**
 * Does this assistant row paint anything?
 *
 * Deliberately permissive: every uncertain input resolves to `true`, so the only
 * possible error is keeping a header that could have been dropped — never
 * dropping one that was needed.
 *
 * `includeReasoning` is pinned to `true` because the real value in `ChatMessage`
 * depends on a per-row store read (`effectiveIsPlanModeSource`) that callers such
 * as `MessageList` cannot cheaply reproduce. Pinning it keeps this helper pure
 * and errs in the safe direction.
 */
export const assistantRowRendersContent = ({
    parts,
    messageFinish,
    lastTodoToolPartId = null,
    isLiveStreamingRow = false,
    hasErrorSurface = false,
    ownsManagedTaskCard = false,
    ownsAssistantImages = false,
    ownsActivityOutput = false,
}: AssistantRowContentInput): boolean => {
    if (isLiveStreamingRow
        || hasErrorSurface
        || ownsManagedTaskCard
        || ownsAssistantImages
        || ownsActivityOutput) {
        return true;
    }

    const { displayParts } = projectAssistantDisplayParts({
        parts,
        includeReasoning: true,
        messageFinish,
    });
    const { visibleParts, cursorNativeTasks } = projectAssistantVisibleParts(displayParts, {
        lastTodoToolPartId,
    });

    if (cursorNativeTasks.length > 0) {
        return true;
    }

    // `resolveManagedTaskDispatch` already applies the same managed-control
    // reasoning suppression MessageBody renders with, so an orchestrator
    // poll/wait message resolves to zero content parts here.
    const dispatch = resolveManagedTaskDispatch(visibleParts);
    return dispatch.taskIds.length > 0
        || dispatch.pendingDispatches.length > 0
        || dispatch.contentParts.length > 0;
};

/**
 * The assistant message that should own a turn's header: the first one that
 * actually renders content, so an empty leading row cannot strand the header
 * above nothing. `null` when no row in the turn renders anything.
 */
export const selectAssistantHeaderTargetId = (
    orderedAssistantIds: readonly string[],
    contentBearingIds: ReadonlySet<string>,
): string | null => {
    for (const id of orderedAssistantIds) {
        if (contentBearingIds.has(id)) {
            return id;
        }
    }
    return null;
};
