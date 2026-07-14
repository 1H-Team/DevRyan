import React from 'react';

import type { PlanTurnTraceIndex } from './lib/turns/types';

export const PlanTurnTraceContext = React.createContext<PlanTurnTraceIndex | null>(null);
