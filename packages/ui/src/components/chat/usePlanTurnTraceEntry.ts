import React from 'react';

import type { PlanRevisionMessageRole, PlanTurnTraceEntry } from './lib/turns/types';
import { PlanTurnTraceContext } from './PlanTurnTraceContext';

export const usePlanTurnTraceEntry = (sourceMessageId: string): PlanTurnTraceEntry | null => {
    const index = React.useContext(PlanTurnTraceContext);
    return index?.bySourceMessageId.get(sourceMessageId) ?? null;
};

export interface PlanRevisionPresentation {
    /** Trace entry of the plan revision this message's turn belongs to, if any. */
    entry: PlanTurnTraceEntry | null;
    /** This assistant message's position relative to the revision's source. */
    role: PlanRevisionMessageRole | null;
}

const EMPTY_PLAN_REVISION_PRESENTATION: PlanRevisionPresentation = { entry: null, role: null };

export const usePlanRevisionPresentation = (
    messageId: string,
    turnId: string | undefined,
): PlanRevisionPresentation => {
    const index = React.useContext(PlanTurnTraceContext);
    return React.useMemo(() => {
        if (!index) return EMPTY_PLAN_REVISION_PRESENTATION;
        const entry = turnId ? index.byTurnId.get(turnId) ?? null : null;
        const role = index.messageRoleById.get(messageId) ?? null;
        if (!entry && !role) return EMPTY_PLAN_REVISION_PRESENTATION;
        return { entry, role };
    }, [index, messageId, turnId]);
};

/** True when a member turn renders no output because it follows the revision's source turn. */
export const useIsPlanRevisionSuppressedTurn = (turnId: string): boolean => {
    const index = React.useContext(PlanTurnTraceContext);
    return index?.suppressedTurnIds.has(turnId) ?? false;
};
