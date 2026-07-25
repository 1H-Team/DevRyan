import { describe, expect, test } from 'bun:test';

import {
  isSessionWithinContextPlanOwner,
  resolveContextPlanSessionChange,
  shouldCollapseContextPlanForSessionChange,
} from './contextPlanSessionLifecycle';

describe('context plan session lifecycle', () => {
  test('replaces an open plan with the newly selected session plan', () => {
    expect(resolveContextPlanSessionChange({
      previousSessionId: 'session-a',
      currentSessionId: 'session-b',
      isPanelOpen: true,
      activeMode: 'plan',
      activeTargetPath: '/plans/a.md',
      ownerSessionId: 'session-a',
      currentSessionPlanPath: '/plans/b.md',
    })).toBe('replace');
  });

  test('prefers a child session own plan over retaining the parent plan', () => {
    expect(resolveContextPlanSessionChange({
      previousSessionId: 'session-owner',
      currentSessionId: 'session-child',
      isPanelOpen: true,
      activeMode: 'plan',
      activeTargetPath: '/plans/owner.md',
      ownerSessionId: 'session-owner',
      currentSessionPlanPath: '/plans/child.md',
      sessions: [{ id: 'session-child', parentID: 'session-owner' }],
    })).toBe('replace');
  });

  test('replaces an open plan when the current session receives a newer saved revision', () => {
    expect(resolveContextPlanSessionChange({
      previousSessionId: 'session-a',
      currentSessionId: 'session-a',
      isPanelOpen: true,
      activeMode: 'plan',
      activeTargetPath: '/plans/revision-1.md',
      ownerSessionId: 'session-a',
      currentSessionPlanPath: '/plans/revision-2.md',
    })).toBe('replace');
  });

  test('keeps an already-matching current session plan unchanged', () => {
    expect(resolveContextPlanSessionChange({
      previousSessionId: 'session-a',
      currentSessionId: 'session-a',
      isPanelOpen: true,
      activeMode: 'plan',
      activeTargetPath: '/plans/current.md',
      ownerSessionId: 'session-a',
      currentSessionPlanPath: '/plans/current.md',
    })).toBe('keep');
  });

  test('collapses when the destination is unrelated and has no saved plan', () => {
    expect(resolveContextPlanSessionChange({
      previousSessionId: 'session-a',
      currentSessionId: 'session-b',
      isPanelOpen: true,
      activeMode: 'plan',
      activeTargetPath: '/plans/a.md',
      ownerSessionId: 'session-a',
      currentSessionPlanPath: null,
      sessions: [{ id: 'session-b' }],
    })).toBe('collapse');
  });

  test('collapses an open plan when the selected session changes', () => {
    expect(shouldCollapseContextPlanForSessionChange({
      previousSessionId: 'session-a',
      currentSessionId: 'session-b',
      isPanelOpen: true,
      activeMode: 'plan',
    })).toBe(true);
  });

  test('keeps the owner plan open while navigating through its session family', () => {
    const sessions = [
      { id: 'session-owner' },
      { id: 'session-child-a', parentID: 'session-owner' },
      { id: 'session-child-b', parentID: 'session-owner' },
      { id: 'session-grandchild', parentID: 'session-child-a' },
    ];

    expect(shouldCollapseContextPlanForSessionChange({
      previousSessionId: 'session-owner',
      currentSessionId: 'session-child-a',
      isPanelOpen: true,
      activeMode: 'plan',
      ownerSessionId: 'session-owner',
      sessions,
    })).toBe(false);
    expect(resolveContextPlanSessionChange({
      previousSessionId: 'session-owner',
      currentSessionId: 'session-child-a',
      isPanelOpen: true,
      activeMode: 'plan',
      activeTargetPath: '/plans/owner.md',
      ownerSessionId: 'session-owner',
      currentSessionPlanPath: null,
      sessions,
    })).toBe('keep');
    expect(shouldCollapseContextPlanForSessionChange({
      previousSessionId: 'session-child-a',
      currentSessionId: 'session-grandchild',
      isPanelOpen: true,
      activeMode: 'plan',
      ownerSessionId: 'session-owner',
      sessions,
    })).toBe(false);
    expect(shouldCollapseContextPlanForSessionChange({
      previousSessionId: 'session-grandchild',
      currentSessionId: 'session-child-b',
      isPanelOpen: true,
      activeMode: 'plan',
      ownerSessionId: 'session-owner',
      sessions,
    })).toBe(false);
    expect(shouldCollapseContextPlanForSessionChange({
      previousSessionId: 'session-child-b',
      currentSessionId: 'session-owner',
      isPanelOpen: true,
      activeMode: 'plan',
      ownerSessionId: 'session-owner',
      sessions,
    })).toBe(false);
  });

  test('uses the managed task root as a narrow fallback before child session sync', () => {
    expect(shouldCollapseContextPlanForSessionChange({
      previousSessionId: 'session-owner',
      currentSessionId: 'session-child',
      isPanelOpen: true,
      activeMode: 'plan',
      ownerSessionId: 'session-owner',
      managedTasks: [{ childSessionId: 'session-child', rootSessionId: 'session-owner' }],
    })).toBe(false);
  });

  test('collapses for unrelated, draft, legacy, and unresolved cyclic session changes', () => {
    const sessions = [
      { id: 'session-owner' },
      { id: 'session-unrelated' },
      { id: 'session-cycle-a', parentID: 'session-cycle-b' },
      { id: 'session-cycle-b', parentID: 'session-cycle-a' },
    ];

    expect(shouldCollapseContextPlanForSessionChange({
      previousSessionId: 'session-owner',
      currentSessionId: 'session-unrelated',
      isPanelOpen: true,
      activeMode: 'plan',
      ownerSessionId: 'session-owner',
      sessions,
    })).toBe(true);
    expect(shouldCollapseContextPlanForSessionChange({
      previousSessionId: 'session-owner',
      currentSessionId: null,
      isPanelOpen: true,
      activeMode: 'plan',
      ownerSessionId: 'session-owner',
      sessions,
    })).toBe(true);
    expect(shouldCollapseContextPlanForSessionChange({
      previousSessionId: 'session-owner',
      currentSessionId: 'session-unrelated',
      isPanelOpen: true,
      activeMode: 'plan',
      sessions,
    })).toBe(true);
    expect(shouldCollapseContextPlanForSessionChange({
      previousSessionId: 'session-owner',
      currentSessionId: 'session-cycle-a',
      isPanelOpen: true,
      activeMode: 'plan',
      ownerSessionId: 'session-owner',
      sessions,
    })).toBe(true);
  });

  test('normalizes session identifiers when resolving ownership', () => {
    expect(isSessionWithinContextPlanOwner({
      ownerSessionId: ' session-owner ',
      currentSessionId: 'session-child',
      sessions: [{ id: 'session-child', parentID: ' session-owner ' }],
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
