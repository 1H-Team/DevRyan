import React from 'react';

import type { PlanTurnTraceIndex } from './lib/turns/types';
import { PlanTurnTraceContext } from './PlanTurnTraceContext';

interface PlanTurnTraceProviderProps extends React.PropsWithChildren {
    value: PlanTurnTraceIndex;
}

export const PlanTurnTraceProvider: React.FC<PlanTurnTraceProviderProps> = ({ children, value }) => (
    <PlanTurnTraceContext.Provider value={value}>
        {children}
    </PlanTurnTraceContext.Provider>
);
