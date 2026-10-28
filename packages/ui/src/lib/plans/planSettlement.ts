// Why a plan's run had not settled when the plan was saved: the host's closed
// set (packages/web/server/lib/opencode/runtime-host/native-plan-settlement.js).
// A transient reason, or none from an older host, is waited out and the save
// retried; a terminal reason is final.
export const PLAN_SETTLEMENT_TERMINAL_REASONS: ReadonlySet<string> = new Set([
  'source_changed', 'superseded', 'cancelled', 'needs_attention', 'pin_changed', 'invalid_state',
]);

export interface PlanSettlementWait {
  reason: string | null;
}

/** A refusal to wait out, or null for any other failure. */
export const planSettlementWait = (error: unknown): PlanSettlementWait | null => {
  if (typeof error !== 'object' || error === null) return null;
  const code = 'code' in error ? error.code : undefined;
  const message = error instanceof Error ? error.message : undefined;
  if (code !== 'plan_source_unsettled' && message !== 'plan_source_unsettled') return null;
  const reason = 'reason' in error && typeof error.reason === 'string' && error.reason ? error.reason : null;
  return reason && PLAN_SETTLEMENT_TERMINAL_REASONS.has(reason) ? null : { reason };
};

const WAITING_TEXT: Readonly<Record<string, string>> = {
  tasks_active: 'Waiting for subagents to finish…',
  sessions_busy: 'Waiting for subagents to finish…',
  leases_active: 'Waiting for running commands to finish…',
};

/** Neutral unless the host named a reason this text knows. */
export const planSettlementWaitingText = (reason?: string | null): string => (reason ? WAITING_TEXT[reason] : undefined)
  ?? 'Waiting for the run to settle…';
