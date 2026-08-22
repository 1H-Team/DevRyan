import { findPlanCardReasoningPartIndex, hasStructuredPlanBody, joinAssistantTextParts, splitPlanCardSentinel } from '@/lib/messages/actionablePlan';
import { isStandaloneTool } from '../../message/parts/toolRenderUtils';
import type {
    ChatMessageEntry,
    TurnActivityGroup,
    TurnActivityRecord,
    TurnPartRecord,
} from './types';

const getPartEndTime = (part: unknown): number | undefined => {
    const stateEnd = (part as { state?: { time?: { end?: unknown } } }).state?.time?.end;
    if (typeof stateEnd === 'number') {
        return stateEnd;
    }
    const timeEnd = (part as { time?: { end?: unknown } }).time?.end;
    return typeof timeEnd === 'number' ? timeEnd : undefined;
};

const getPartText = (part: unknown): string | undefined => {
    const text = (part as { text?: unknown }).text;
    if (typeof text === 'string' && text.trim().length > 0) {
        return text;
    }
    const content = (part as { content?: unknown }).content;
    if (typeof content === 'string' && content.trim().length > 0) {
        return content;
    }
    return undefined;
};

const isActiveReasoningPart = (part: unknown): boolean => {
    return (part as { type?: unknown }).type === 'reasoning' && getPartEndTime(part) === undefined;
};

const getMessageFinish = (message: ChatMessageEntry): string | undefined => {
    const finish = (message.info as { finish?: unknown }).finish;
    return typeof finish === 'string' ? finish : undefined;
};

const buildTurnPartRecord = (
    turnId: string,
    messageId: string,
    part: ChatMessageEntry['parts'][number],
    partIndex: number,
): TurnPartRecord => {
    return {
        id: part.id ?? `${messageId}-part-${partIndex}-${part.type}`,
        turnId,
        messageId,
        part,
        partIndex,
        endedAt: getPartEndTime(part),
    };
};

interface ProjectActivityInput {
    turnId: string;
    assistantMessages: ChatMessageEntry[];
    summarySourceMessageId?: string;
    summarySourcePartId?: string;
    /** True when the turn's user message was sent in plan mode; enables the
     * structured-plan justification exemption for sentinel-less plans. */
    isPlanModeTurn?: boolean;
}

interface ProjectActivityResult {
    activityParts: TurnActivityRecord[];
    activitySegments: TurnActivityGroup[];
    hasTools: boolean;
    hasReasoning: boolean;
}

export const projectTurnActivity = (input: ProjectActivityInput): ProjectActivityResult => {
    const activityParts: TurnActivityRecord[] = [];
    let hasTools = false;
    let hasReasoning = false;

    input.assistantMessages.forEach((message) => {
        message.parts.forEach((part) => {
            if (part.type === 'tool') {
                hasTools = true;
                return;
            }

            if (part.type === 'reasoning' && (getPartText(part) || isActiveReasoningPart(part))) {
                hasReasoning = true;
            }
        });
    });

    // Grok can split a single plan across two assistant messages when it emits a
    // tool call at the message boundary — neither message's own joined text is
    // plan-bearing, so the per-message exemption below misses it and the plan
    // fragments fall into the justification bucket (thought-style render).
    // Joining across the whole turn catches that case; the per-message check is
    // kept as the narrower, cheaper path.
    let turnPlanBearing = false;
    if (input.isPlanModeTurn === true) {
        const turnText = input.assistantMessages
            .map((message) => joinAssistantTextParts(message.parts))
            .filter((chunk) => chunk.length > 0)
            .join('\n');
        turnPlanBearing = turnText.length > 0
            && (splitPlanCardSentinel(turnText) !== null || hasStructuredPlanBody(turnText));
    }

    const taskMessageById = new Map<string, string>();
    const taskOrder: string[] = [];
    const partsByAfterTool = new Map<string | null, TurnActivityRecord[]>();
    let currentAfterToolPartId: string | null = null;

    input.assistantMessages.forEach((message) => {
        const finish = getMessageFinish(message);
        const messageHasTool = message.parts.some((part) => part.type === 'tool');

        // When the plan card is mounted from a reasoning part, that part must not
        // ALSO render as a thought — otherwise the same plan appears twice.
        const planCardReasoningIndex = findPlanCardReasoningPartIndex(message.parts, {
            isPlanModeSource: input.isPlanModeTurn === true,
        });

        // Providers like Grok interleave tool calls mid-plan, splitting the plan
        // across text parts none of which is plan-bearing on its own. When the
        // message-level joined text is plan-bearing (same '\n' join
        // resolveMessagePlanCard consumes, so this agrees with plan-card
        // detection by construction), exempt ALL of the message's text parts
        // from the justification bucket — otherwise plan fragments render in
        // the thought-style block. A reasoning-hosted plan card counts too:
        // its text tail may be plan continuation the straddle resolution needs,
        // and justification-classifying it would desync MessageBody's filtered
        // plan-resolution parts from this projection. Deliberate consequence:
        // narration fragments in such messages render as body/preamble text
        // instead of thought-style; post-plan fragments are consumed by
        // shouldSuppressPostPlanText.
        let messagePlanBearing = turnPlanBearing || planCardReasoningIndex >= 0;
        if (!messagePlanBearing && input.isPlanModeTurn === true) {
            const joinedText = joinAssistantTextParts(message.parts);
            messagePlanBearing = joinedText.length > 0
                && (splitPlanCardSentinel(joinedText) !== null || hasStructuredPlanBody(joinedText));
        }

        message.parts.forEach((part, partIndex) => {
            const isTool = part.type === 'tool';

            const text = part.type === 'reasoning' || part.type === 'text'
                ? getPartText(part)
                : undefined;
            const partId = part.id ?? `${message.info.id}-part-${partIndex}-${part.type}`;

            const toolName = isTool
                ? (part as { tool?: unknown }).tool
                : undefined;
            const standaloneTool = isTool && isStandaloneTool(toolName);
            if (standaloneTool) {
                const toolPartId = partId;
                if (!taskMessageById.has(toolPartId)) {
                    taskMessageById.set(toolPartId, message.info.id);
                    taskOrder.push(toolPartId);
                }
                currentAfterToolPartId = toolPartId;
            }

            const isConfirmedSummaryText = part.type === 'text'
                && typeof text === 'string'
                && finish === 'stop'
                && input.summarySourceMessageId === message.info.id
                && input.summarySourcePartId === partId;

            // A plan-bearing text part must render as normal text so it reaches
            // the plan-card branch — the justification bucket is skipped before
            // plan detection, which silently killed Grok plans whose message
            // reported finish !== 'stop' or carried a trailing sign-off part.
            const isPlanBearingText = part.type === 'text'
                && typeof text === 'string'
                && (
                    splitPlanCardSentinel(text) !== null
                    || (input.isPlanModeTurn === true && hasStructuredPlanBody(text))
                );

            let kind: TurnActivityRecord['kind'] | null = null;
            if (isTool) {
                kind = 'tool';
            } else if (part.type === 'reasoning') {
                if (partIndex === planCardReasoningIndex) {
                    // Rendered by the plan card instead; see
                    // findPlanCardReasoningPartIndex.
                    kind = null;
                } else if (text || isActiveReasoningPart(part)) {
                    kind = 'reasoning';
                }
            } else if (
                part.type === 'text'
                && text
                && !isConfirmedSummaryText
                && !isPlanBearingText
                && !messagePlanBearing
                && (messageHasTool || (typeof finish === 'string' && finish !== 'stop'))
            ) {
                kind = 'justification';
            }

            if (!kind) {
                return;
            }

            const activity: TurnActivityRecord = {
                ...buildTurnPartRecord(input.turnId, message.info.id, part, partIndex),
                kind,
                ...(
                    typeof (message.info as { providerID?: unknown }).providerID === 'string'
                        ? { providerID: (message.info as { providerID: string }).providerID }
                        : {}
                ),
            };
            activityParts.push(activity);

            if (kind === 'tool' && standaloneTool) {
                return;
            }

            const list = partsByAfterTool.get(currentAfterToolPartId) ?? [];
            list.push(activity);
            partsByAfterTool.set(currentAfterToolPartId, list);
        });
    });

    const activitySegments: TurnActivityGroup[] = [];

    const pickStartAnchor = (segmentParts: TurnActivityRecord[]): string | undefined => {
        if (segmentParts.length === 0) {
            return undefined;
        }

        const countByMessage = new Map<string, number>();
        segmentParts.forEach((activity) => {
            countByMessage.set(activity.messageId, (countByMessage.get(activity.messageId) ?? 0) + 1);
        });

        let firstWithAny: string | undefined;
        for (const message of input.assistantMessages) {
            const count = countByMessage.get(message.info.id) ?? 0;
            if (count > 0 && !firstWithAny) {
                firstWithAny = message.info.id;
            }
        }

        return firstWithAny;
    };

    const orderedKeys: Array<string | null> = [null, ...taskOrder];
    orderedKeys.forEach((afterToolPartId) => {
        const segmentParts = partsByAfterTool.get(afterToolPartId) ?? [];
        if (segmentParts.length === 0) {
            return;
        }

        const anchorMessageId = afterToolPartId === null
            ? pickStartAnchor(segmentParts)
            : taskMessageById.get(afterToolPartId);

        if (!anchorMessageId) {
            return;
        }

        activitySegments.push({
            id: `${input.turnId}:${anchorMessageId}:${afterToolPartId ?? 'start'}`,
            anchorMessageId,
            afterToolPartId,
            parts: segmentParts,
        });
    });

    return {
        activityParts,
        activitySegments,
        hasTools,
        hasReasoning,
    };
};
