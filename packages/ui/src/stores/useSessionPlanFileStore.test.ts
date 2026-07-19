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
    });

    store.markSaved('session-a', 'msg-2', '/plans/latest.md');
    expect(useSessionPlanFileStore.getState().recordsBySession['session-a']).toEqual({
      sourceMessageId: 'msg-2',
      path: '/plans/latest.md',
      status: 'saved',
      error: null,
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
    });

    store.clearSession('session-a');
    expect(useSessionPlanFileStore.getState().recordsBySession['session-a']).toBe(undefined);
    expect(useSessionPlanFileStore.getState().recordsBySession['session-b']?.path).toBe('/plans/b.md');
  });
});
