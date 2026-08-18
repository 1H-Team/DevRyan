import { describe, expect, test } from 'bun:test';

import { resolveSubtaskIconAgent } from './subtaskAgentIdentity';

describe('resolveSubtaskIconAgent', () => {
  test('prefers the authoritative managed-task agent over stale session metadata', () => {
    expect(resolveSubtaskIconAgent({
      managedTaskAgent: 'fixer',
      sessionAgent: 'explorer',
    })).toBe('fixer');
  });

  test('falls back to session metadata for ordinary child sessions', () => {
    expect(resolveSubtaskIconAgent({
      managedTaskAgent: undefined,
      sessionAgent: 'designer',
    })).toBe('designer');
  });

  test('ignores blank agent values', () => {
    expect(resolveSubtaskIconAgent({
      managedTaskAgent: '   ',
      sessionAgent: ' oracle ',
    })).toBe('oracle');
    expect(resolveSubtaskIconAgent({
      managedTaskAgent: null,
      sessionAgent: undefined,
    })).toBe(undefined);
  });
});
