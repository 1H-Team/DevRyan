import { getToolLifecycleState } from '@/lib/toolStatus';
import { TURN_WINDOW_DEFAULTS } from './constants';
import type { ChatMessageEntry, TurnActivityRecord, TurnRecord } from './types';

const key = (activity: TurnActivityRecord) => `${activity.messageId}\u0000${activity.partIndex}`;
const canHide = (activity: TurnActivityRecord, completed: Set<string>) => {
    if (activity.kind === 'tool' && activity.part.type === 'tool') {
        // Control cards carry interactions and task state independently of tool output.
        if (['question', 'task', 'devryan_task'].includes(activity.part.tool.toLowerCase())) return false;
        const lifecycle = getToolLifecycleState(activity.part.state);
        return lifecycle.isFinalized && !lifecycle.isStatusActive;
    }
    return completed.has(activity.messageId);
};

/** Window only settled activity; authoritative messages and indexes remain unchanged. */
export const windowTurnActivity = (turn: TurnRecord, messages: ChatMessageEntry[], anchor: string | null) => {
    const completed = new Set(messages.filter(message => message.info.role === 'assistant' && typeof message.info.time.completed === 'number').map(message => message.info.id));
    const eligible = turn.activityParts.filter(activity => canHide(activity, completed));
    const rowCount = 1 + messages.reduce((count, message) => count + Math.max(1, message.parts.length), 0);
    if (rowCount <= TURN_WINDOW_DEFAULTS.maxRowsBeforeWindowing) return { messages, activityParts: turn.activityParts, activitySegments: turn.activitySegments, hidden: 0, olderAnchor: null };
    const initialStart = Math.max(0, eligible.length - TURN_WINDOW_DEFAULTS.initialRows);
    const anchorIndex = anchor === null ? -1 : eligible.findIndex(activity => key(activity) === anchor);
    const start = anchor === '*' ? 0 : anchorIndex < 0 ? initialStart : Math.min(initialStart, anchorIndex);
    const hiddenKeys = new Set(eligible.slice(0, start).map(key));
    if (!hiddenKeys.size) return { messages, activityParts: turn.activityParts, activitySegments: turn.activitySegments, hidden: 0, olderAnchor: null };
    const byMessage = new Map<string, Set<number>>();
    for (const activity of eligible.slice(0, start)) {
        let indexes = byMessage.get(activity.messageId);
        if (!indexes) byMessage.set(activity.messageId, indexes = new Set());
        indexes.add(activity.partIndex);
    }
    const visibleMessages = messages.flatMap(message => {
        const indexes = byMessage.get(message.info.id);
        if (!indexes) return [message];
        const parts = message.parts.filter((_part, index) => !indexes.has(index));
        // Keep error surfaces and active rows even when every activity part is hidden.
        return parts.length || message.info.role === 'assistant' && message.info.error || !completed.has(message.info.id)
            ? [{ ...message, parts }] : [];
    });
    const activityParts = turn.activityParts.filter(activity => !hiddenKeys.has(key(activity)));
    const activitySegments = turn.activitySegments.flatMap(segment => {
        const parts = segment.parts.filter(activity => !hiddenKeys.has(key(activity)));
        if (!parts.length) return [];
        const anchorMessageId = parts.some(part => part.messageId === segment.anchorMessageId) ? segment.anchorMessageId : parts[0].messageId;
        return [{ ...segment, anchorMessageId, parts }];
    });
    return { messages: visibleMessages, activityParts, activitySegments, hidden: start,
        olderAnchor: key(eligible[Math.max(0, start - TURN_WINDOW_DEFAULTS.batchRows)]) };
};
