import { createSessionPlanSelectionSelector } from '@/sync/session-plan-selection';
import type { State } from '@/sync/types';

/** Submitted intent, independent of the next prompt's composer settings. */
export const createSessionChangesTurnSelector = (
    sessionId: string,
    isRecordedPlanMode: (messageId: string) => boolean,
) => {
    const selectPlan = createSessionPlanSelectionSelector(sessionId, isRecordedPlanMode);
    return (state: Pick<State, 'message' | 'part'>): boolean => {
        const selection = selectPlan(state);
        if (!selection || selection.enabled) return false;
        const messages = state.message[sessionId];
        const latest = messages?.[messages.length - 1];
        // A submitted user message or unfinished response must not expose an
        // older summary before the authoritative busy status arrives.
        return latest?.role === 'assistant' && typeof latest.time.completed === 'number';
    };
};
