import { describe, expect, test } from 'bun:test';

import { shouldCollapseContextPlanForSessionChange } from './contextPlanSessionLifecycle';

describe('context plan session lifecycle', () => {
  test('collapses an open plan when the selected session changes', () => {
    expect(shouldCollapseContextPlanForSessionChange({
      previousSessionId: 'session-a',
      currentSessionId: 'session-b',
      isPanelOpen: true,
      activeMode: 'plan',
    })).toBe(true);
  });

  test('also collapses when moving between a session and a draft', () => {
    expect(shouldCollapseContextPlanForSessionChange({
      previousSessionId: 'session-a',
      currentSessionId: null,
      isPanelOpen: true,
      activeMode: 'plan',
    })).toBe(true);
    expect(shouldCollapseContextPlanForSessionChange({
      previousSessionId: null,
      currentSessionId: 'session-b',
      isPanelOpen: true,
      activeMode: 'plan',
    })).toBe(true);
  });

  test('does not collapse on initial mount or an update within the same session', () => {
    expect(shouldCollapseContextPlanForSessionChange({
      previousSessionId: undefined,
      currentSessionId: 'session-a',
      isPanelOpen: true,
      activeMode: 'plan',
    })).toBe(false);
    expect(shouldCollapseContextPlanForSessionChange({
      previousSessionId: 'session-a',
      currentSessionId: 'session-a',
      isPanelOpen: true,
      activeMode: 'plan',
    })).toBe(false);
  });

  test('leaves non-plan context and already-closed panels alone', () => {
    expect(shouldCollapseContextPlanForSessionChange({
      previousSessionId: 'session-a',
      currentSessionId: 'session-b',
      isPanelOpen: true,
      activeMode: 'file',
    })).toBe(false);
    expect(shouldCollapseContextPlanForSessionChange({
      previousSessionId: 'session-a',
      currentSessionId: 'session-b',
      isPanelOpen: false,
      activeMode: 'plan',
    })).toBe(false);
  });
});
