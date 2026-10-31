import { describe, expect, it } from 'vitest';
import { DEFAULT_MANAGED_TURN_BUDGET, resolveManagedTaskTurnBudget } from './managed-task-turn-budget.js';

describe('managed task turn budget', () => {
  it('budgets designer and fixer tasks only', () => {
    expect(resolveManagedTaskTurnBudget({ agent: 'designer' })).toBe(DEFAULT_MANAGED_TURN_BUDGET);
    expect(resolveManagedTaskTurnBudget({ agent: 'fixer' })).toBe(150);
    expect(resolveManagedTaskTurnBudget({ agent: ' Designer ' })).toBe(150);
    for (const agent of ['explorer', 'librarian', 'oracle', 'builder', undefined]) {
      expect(resolveManagedTaskTurnBudget({ agent })).toBeNull();
    }
    expect(resolveManagedTaskTurnBudget(null)).toBeNull();
  });
});
