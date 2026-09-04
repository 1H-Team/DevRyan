import type { Message, Part } from '@opencode-ai/sdk/v2/client';

import {
    hasPlanImplementationRequestPart,
    resolveMessagePlanCard,
    resolvePlanTurnIntent,
    type PlanTurnIntent,
} from './actionablePlan';
import { isFullySyntheticMessage } from './synthetic';

/**
 * A logical plan revision groups a user-authored turn with any follow-up
 * turns the runtime creates on its own (compaction commands and fully
 * synthetic continuation prompts). Providers may split one planning response
 * across several assistant siblings and continuation turns; presentation and
 * background detection must treat that whole group as a single plan with a
 * single canonical source message.
 */

const COMPACT_COMMAND_TEXT = '/compact';

export type PlanRevisionMessageRole = 'before-source' | 'source' | 'after-source';

export interface PlanRevisionAssistantInput {
    id: string;
    parentMessageId: string | null;
    completedAt: number | null;
    parts: readonly Part[];
}

export interface PlanRevisionTurnInput {
    turnId: string;
    userMessageId: string;
    userInfo: Message;
    userParts: readonly Part[];
    isRecordedPlanMode: boolean;
    assistants: PlanRevisionAssistantInput[];
}

export interface PlanRevision {
    /** Turn that opened the revision — a real user-authored request. */
    rootTurnId: string;
    rootUserMessageId: string;
    /** Root turn plus every folded continuation turn, in order. */
    memberTurnIds: string[];
    /** Intent of the root turn; never `implement` (those groups are not revisions). */
    intent: PlanTurnIntent;
    isPlanModeRevision: boolean;
    /** Member turn containing the selected source message. */
    sourceTurnId: string | null;
    /** Last canonical assistant message containing a valid plan. */
    sourceMessageId: string | null;
    sourceParentMessageId: string | null;
    sourceCompletedAt: number | null;
    /** Canonical plan markdown from the selected source. */
    planText: string | null;
    /** True once every assistant sibling across member turns has completed. */
    isSettled: boolean;
    /** Position of every assistant sibling relative to the selected source. */
    messageRoles: Map<string, PlanRevisionMessageRole>;
    /** Member turns that occur entirely after the source turn. */
    turnIdsAfterSource: string[];
}

const getPartText = (part: Part): string => {
    const text = (part as { text?: unknown }).text;
    if (typeof text === 'string') return text;
    const content = (part as { content?: unknown }).content;
    return typeof content === 'string' ? content : '';
};

const hasCompactionSignal = (parts: readonly Part[]): boolean => (
    parts.some((part) => {
        if (!part) return false;
        if ((part as { type?: unknown }).type === 'compaction') return true;
        return part.type === 'text' && getPartText(part).trim() === COMPACT_COMMAND_TEXT;
    })
);

/**
 * A continuation turn is one the runtime injected rather than the user
 * authoring: a compaction command, or a user message made entirely of
 * synthetic parts. Recorded plan-mode requests are always user-authored, and
 * so is an Implement Plan request: it is fully synthetic by construction but
 * always opens a new group, otherwise its assistants would be folded into the
 * plan revision as `after-source` siblings and render nothing.
 */
export const isContinuationTurnUserMessage = (
    parts: readonly Part[],
    isRecordedPlanMode: boolean,
): boolean => {
    if (isRecordedPlanMode) return false;
    if (hasPlanImplementationRequestPart(parts)) return false;
    if (hasCompactionSignal(parts)) return true;
    return isFullySyntheticMessage([...parts]);
};

interface TurnGroup {
    root: PlanRevisionTurnInput;
    members: PlanRevisionTurnInput[];
}

const groupTurnsIntoRevisions = (turns: readonly PlanRevisionTurnInput[]): TurnGroup[] => {
    const groups: TurnGroup[] = [];
    for (const turn of turns) {
        const openGroup = groups[groups.length - 1];
        if (openGroup && isContinuationTurnUserMessage(turn.userParts, turn.isRecordedPlanMode)) {
            openGroup.members.push(turn);
            continue;
        }
        groups.push({ root: turn, members: [turn] });
    }
    return groups;
};

const projectGroup = (group: TurnGroup): PlanRevision | null => {
    const { root, members } = group;
    const intent = resolvePlanTurnIntent(
        root.userInfo,
        root.userParts,
        root.isRecordedPlanMode,
    );
    // An implementation turn is never a plan revision: its assistants must not
    // become a plan source (even when they echo plan-shaped headings) and must
    // never be role-tagged relative to a source, so they render as normal work.
    if (intent === 'implement') {
        return null;
    }
    const isPlanModeRevision = intent === 'plan';

    let sourceTurnId: string | null = null;
    let source: PlanRevisionAssistantInput | null = null;
    let planText: string | null = null;
    let isSettled = true;

    for (const member of members) {
        for (const assistant of member.assistants) {
            if (assistant.completedAt === null) {
                isSettled = false;
            }
            const split = resolveMessagePlanCard(assistant.parts, { isPlanModeSource: isPlanModeRevision });
            const text = split?.planText.trim();
            if (text) {
                sourceTurnId = member.turnId;
                source = assistant;
                planText = split ? split.planText : null;
            }
        }
    }

    if (!source && !isPlanModeRevision) {
        return null;
    }

    const messageRoles = new Map<string, PlanRevisionMessageRole>();
    const turnIdsAfterSource: string[] = [];
    if (source) {
        let seenSource = false;
        let seenSourceTurn = false;
        for (const member of members) {
            if (seenSourceTurn) {
                turnIdsAfterSource.push(member.turnId);
            }
            for (const assistant of member.assistants) {
                if (assistant.id === source.id) {
                    messageRoles.set(assistant.id, 'source');
                    seenSource = true;
                    continue;
                }
                messageRoles.set(assistant.id, seenSource ? 'after-source' : 'before-source');
            }
            if (member.turnId === sourceTurnId) {
                seenSourceTurn = true;
            }
        }
    }

    return {
        rootTurnId: root.turnId,
        rootUserMessageId: root.userMessageId,
        memberTurnIds: members.map((member) => member.turnId),
        intent,
        isPlanModeRevision,
        sourceTurnId,
        sourceMessageId: source?.id ?? null,
        sourceParentMessageId: source?.parentMessageId ?? null,
        sourceCompletedAt: source?.completedAt ?? null,
        planText,
        isSettled,
        messageRoles,
        turnIdsAfterSource,
    };
};

/**
 * Projects ordered turns into logical plan revisions. Only groups that carry
 * a plan (a source message was found) or were opened by a plan-mode request
 * are returned; other turn groups — including every Implement Plan group —
 * are not plan revisions.
 */
export const projectPlanRevisions = (turns: readonly PlanRevisionTurnInput[]): PlanRevision[] => {
    const revisions: PlanRevision[] = [];
    for (const group of groupTurnsIntoRevisions(turns)) {
        const revision = projectGroup(group);
        if (revision) {
            revisions.push(revision);
        }
    }
    return revisions;
};
