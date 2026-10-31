// Agents whose long tool loops get an assistant-turn backstop; the others are
// bounded by their read-only tool surface and shorter task timeouts.
export const TURN_BUDGETED_MANAGED_AGENTS = Object.freeze(new Set(['designer', 'fixer']));
export const DEFAULT_MANAGED_TURN_BUDGET = 150;

const normalizeId = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');

export const resolveManagedTaskTurnBudget = (task) => (
  TURN_BUDGETED_MANAGED_AGENTS.has(normalizeId(task?.agent))
    ? DEFAULT_MANAGED_TURN_BUDGET
    : null
);
