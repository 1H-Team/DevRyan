export type PlanIndicatorState = "proposed" | "implementing" | "completed"

export type PlanIndicatorEntry = {
  state: PlanIndicatorState
  sourceMessageId?: string
  implementationMessageId?: string
}

export type PlanIndicatorTone = "warning" | "success"

export const getPlanIndicatorTone = (state: PlanIndicatorState): PlanIndicatorTone => {
  return state === "completed" ? "success" : "warning"
}

const compareSourceMessageIds = (left?: string, right?: string): number => {
  if (!left || !right || left === right) return 0
  // Message ids are generated as sortable ids in the sync layer; use lexical
  // ordering only to prevent older rendered plan blocks from clobbering newer
  // plan lifecycle state.
  return left < right ? -1 : 1
}

export const resolveEffectivePlanIndicatorState = (
  entry: PlanIndicatorEntry | undefined,
  latestPlanModeUserMessageId?: string,
): PlanIndicatorState | null => {
  if (!entry) return null
  if (entry.state !== "proposed") return entry.state
  if (!entry.sourceMessageId || !latestPlanModeUserMessageId) return entry.state

  // Plan-mode message ids and assistant source ids share the same sortable
  // identity format. A later plan-mode turn makes the current proposal
  // non-actionable immediately, before its replacement plan has completed.
  return compareSourceMessageIds(latestPlanModeUserMessageId, entry.sourceMessageId) > 0
    ? null
    : entry.state
}

const PLAN_INDICATOR_RANK: Record<PlanIndicatorState, number> = {
  proposed: 0,
  implementing: 1,
  completed: 2,
}

const createPlanIndicatorEntry = (
  state: PlanIndicatorState,
  sourceMessageId?: string,
  implementationMessageId?: string,
): PlanIndicatorEntry => ({
  state,
  sourceMessageId,
  ...(implementationMessageId ? { implementationMessageId } : {}),
})

export const nextPlanIndicatorEntry = (
  current: PlanIndicatorEntry | undefined,
  nextState: PlanIndicatorState,
  sourceMessageId?: string,
  implementationMessageId?: string,
): PlanIndicatorEntry | undefined => {
  if (!current) return createPlanIndicatorEntry(nextState, sourceMessageId, implementationMessageId)

  const sourceOrder = compareSourceMessageIds(sourceMessageId, current.sourceMessageId)
  if (sourceOrder < 0) return current

  if (sourceOrder > 0) return createPlanIndicatorEntry(nextState, sourceMessageId, implementationMessageId)

  const currentRank = PLAN_INDICATOR_RANK[current.state]
  const nextRank = PLAN_INDICATOR_RANK[nextState]
  if (nextRank < currentRank) return current

  const nextImplementationMessageId = implementationMessageId ?? current.implementationMessageId
  if (
    current.state === nextState
    && current.sourceMessageId === sourceMessageId
    && current.implementationMessageId === nextImplementationMessageId
  ) {
    return current
  }

  return createPlanIndicatorEntry(
    nextState,
    sourceMessageId ?? current.sourceMessageId,
    nextImplementationMessageId,
  )
}
