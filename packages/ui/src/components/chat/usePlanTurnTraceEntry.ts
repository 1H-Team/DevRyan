import React from 'react';

import type { PlanTurnTraceEntry } from './lib/turns/types';
import { PlanTurnTraceContext } from './PlanTurnTraceContext';

export const usePlanTurnTraceEntry = (sourceMessageId: string): PlanTurnTraceEntry | null => {
    const index = React.useContext(PlanTurnTraceContext);
    return index?.bySourceMessageId.get(sourceMessageId) ?? null;
};
