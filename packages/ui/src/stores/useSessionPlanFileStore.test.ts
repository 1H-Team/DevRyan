import { beforeEach, describe, expect, test } from 'bun:test';

import { useSessionPlanFileStore } from './useSessionPlanFileStore';

describe('useSessionPlanFileStore', () => {
  beforeEach(() => {
    useSessionPlanFileStore.setState({ recordsBySession: {} });
  });

  test('guards latest revision state from stale async completions', () => {
    const store = useSessionPlanFileStore.getState();
    store.beginSaving('session-a', 'msg-1');
    store.beginSaving('session-a', 'msg-2');
    store.markSaved('session-a', 'msg-1', '/plans/old.md');

    expect(useSessionPlanFileStore.getState().recordsBySession['session-a']).toEqual({
      sourceMessageId: 'msg-2',
      path: null,
      status: 'saving',
      error: null,
      autoRevealed: false,
    });

    store.markSaved('session-a', 'msg-2', '/plans/latest.md');
    expect(useSessionPlanFileStore.getState().recordsBySession['session-a']).toEqual({
      sourceMessageId: 'msg-2',
      path: '/plans/latest.md',
      status: 'saved',
      error: null,
      autoRevealed: false,
    });
  });

  test('records retryable failures and clears only the deleted session pointer', () => {
    const store = useSessionPlanFileStore.getState();
    store.beginSaving('session-a', 'msg-1');
    store.markError('session-a', 'msg-1', 'disk full');
    store.beginSaving('session-b', 'msg-2');
    store.markSaved('session-b', 'msg-2', '/plans/b.md');

    expect(useSessionPlanFileStore.getState().recordsBySession['session-a']).toEqual({
      sourceMessageId: 'msg-1',
      path: null,
      status: 'error',
      error: 'disk full',
      autoRevealed: false,
    });

    store.clearSession('session-a');
    expect(useSessionPlanFileStore.getState().recordsBySession['session-a']).toBe(undefined);
    expect(useSessionPlanFileStore.getState().recordsBySession['session-b']?.path).toBe('/plans/b.md');
  });

  test('claims one auto-reveal per saved plan revision', () => {
    const store = useSessionPlanFileStore.getState();
    store.beginSaving('session-a', 'msg-1');
    expect(store.claimAutoReveal('session-a', 'msg-1')).toBe(false);

    store.markSaved('session-a', 'msg-1', '/plans/a.md');
    expect(store.claimAutoReveal('session-a', 'msg-1')).toBe(true);
    expect(store.claimAutoReveal('session-a', 'msg-1')).toBe(false);

    store.beginSaving('session-a', 'msg-2');
    store.markSaved('session-a', 'msg-2', '/plans/b.md');
    expect(store.claimAutoReveal('session-a', 'msg-1')).toBe(false);
    expect(store.claimAutoReveal('session-a', 'msg-2')).toBe(true);
  });
});
