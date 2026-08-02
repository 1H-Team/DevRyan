export interface PlanReadyRevision {
  sourceMessageId: string;
  sourceParentMessageId: string | null;
  planText: string;
}

export function detectPlanReadyRevision(messages: unknown[]): PlanReadyRevision | null;

export const PLAN_READY_DEFAULT_TEMPLATE: {
  title: 'Plan ready';
  message: 'A plan is ready for review';
};

export const PLAN_CARD_SENTINEL_TEXT: '<!--plan-->';
