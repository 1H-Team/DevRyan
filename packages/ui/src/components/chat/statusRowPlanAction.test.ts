import { describe, expect, test } from 'bun:test';

import {
  getPlanAutoRevealTarget,
  getStatusRowPlanActionState,
  hasPlanTaskTrackingContext,
  shouldAutoRevealPlanInMainTab,
} from './statusRowPlanAction';

const revisionIdentity = (sourceMessageId: string) => ({
  sessionId: 'session-a',
  sourceMessageId,
  directory: '/repo',
  sessionCreated: 123,
  sessionSlug: 'Plan',
});

describe('getStatusRowPlanActionState', () => {
  test('shows the composer action without tasks and enables it only after save or retry recovery', () => {
    expect(getStatusRowPlanActionState({
      showTodos: true,
      isPlanAvailable: true,

      record: {
        sourceMessageId: 'msg-1',
        path: null,
        revisionIdentity: null,
        status: 'saving',
        error: null,
      },
    })).toEqual({ visible: true, enabled: false, disabledReason: 'Plan file is still saving.' });

    expect(getStatusRowPlanActionState({
      showTodos: true,
      isPlanAvailable: true,

      record: {
        sourceMessageId: 'msg-1',
        path: null,
        revisionIdentity: null,
        status: 'error',
        error: 'Plan storage is unavailable',
      },
    })).toEqual({
      visible: true,
      enabled: false,
      disabledReason: 'Plan file could not be saved. Retry from the plan card.',
    });

    expect(getStatusRowPlanActionState({
      showTodos: true,
      isPlanAvailable: true,

      record: {
        sourceMessageId: 'msg-1',
        path: '/plans/a.md',
        revisionIdentity: revisionIdentity('msg-1'),
        status: 'saved',
        error: null,
      },
    })).toEqual({ visible: true, enabled: true, disabledReason: null });
  });

  test('does not add the right-panel action to non-composer rows', () => {
    expect(getStatusRowPlanActionState({
      showTodos: false,
      isPlanAvailable: true,

      record: undefined,
    }).visible).toBe(false);
  });

  test('keeps the action visible after reload when the saved file record outlives the transient plan projection', () => {
    expect(getStatusRowPlanActionState({
      showTodos: true,
      isPlanAvailable: false,

      record: {
        sourceMessageId: 'msg-1',
        path: '/plans/a.md',
        revisionIdentity: revisionIdentity('msg-1'),
        status: 'saved',
        error: null,
      },
    })).toEqual({ visible: true, enabled: true, disabledReason: null });

    expect(hasPlanTaskTrackingContext({
      isPlanAvailable: false,
      record: {
        sourceMessageId: 'msg-1',
        path: '/plans/a.md',
        revisionIdentity: revisionIdentity('msg-1'),
        status: 'saved',
        error: null,
      },
    })).toBe(true);
  });

  test('does not infer plan task tracking from an unsaved record alone', () => {
    expect(hasPlanTaskTrackingContext({
      isPlanAvailable: false,
      record: {
        sourceMessageId: 'msg-1',
        path: null,
        revisionIdentity: null,
        status: 'saving',
        error: null,
      },
    })).toBe(false);
  });

  test('auto-reveals only the current saved actionable plan revision', () => {
    const record = {
      sourceMessageId: 'msg-plan-2',
      path: '/plans/plan-2.md',
      revisionIdentity: revisionIdentity('msg-plan-2'),
      status: 'saved' as const,
      error: null,
    };

    expect(getPlanAutoRevealTarget({
      sessionId: 'session-a',
      isPlanAvailable: true,
      planIndicator: { state: 'proposed', sourceMessageId: 'msg-plan-2' },
      isPlanSourceImplemented: false,
      record,
    })).toEqual({
      sessionId: 'session-a',
      sourceMessageId: 'msg-plan-2',
      path: '/plans/plan-2.md',
    });

    expect(getPlanAutoRevealTarget({
      sessionId: 'session-a',
      isPlanAvailable: true,
      planIndicator: { state: 'proposed', sourceMessageId: 'msg-plan-1' },
      isPlanSourceImplemented: false,
      record,
    })).toBeNull();
    expect(getPlanAutoRevealTarget({
      sessionId: 'session-a',
      isPlanAvailable: true,
      planIndicator: { state: 'implementing', sourceMessageId: 'msg-plan-2' },
      isPlanSourceImplemented: true,
      record,
    })).toBeNull();
  });

  test('does not reopen an auto-revealed revision or reveal an unsaved revision', () => {
    expect(getPlanAutoRevealTarget({
      sessionId: 'session-a',
      isPlanAvailable: true,
      planIndicator: { state: 'proposed', sourceMessageId: 'msg-plan-2' },
      isPlanSourceImplemented: false,
      record: {
        sourceMessageId: 'msg-plan-2',
        path: '/plans/plan-2.md',
        revisionIdentity: revisionIdentity('msg-plan-2'),
        status: 'saved',
        error: null,
        autoRevealed: true,
      },
    })).toBeNull();
    expect(getPlanAutoRevealTarget({
      sessionId: 'session-a',
      isPlanAvailable: true,
      planIndicator: { state: 'proposed', sourceMessageId: 'msg-plan-2' },
      isPlanSourceImplemented: false,
      record: {
        sourceMessageId: 'msg-plan-2',
        path: null,
        revisionIdentity: null,
        status: 'saving',
        error: null,
      },
    })).toBeNull();
  });
});

describe('shouldAutoRevealPlanInMainTab', () => {
  test('keeps desktop plan opening manual while preserving compact-runtime navigation', () => {
    expect(shouldAutoRevealPlanInMainTab({ isMobile: false, })).toBe(false);
    expect(shouldAutoRevealPlanInMainTab({ isMobile: true, })).toBe(true);
  });
});
