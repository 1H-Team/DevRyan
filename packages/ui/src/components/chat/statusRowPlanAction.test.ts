import { describe, expect, test } from 'bun:test';

import { getStatusRowPlanActionState, hasPlanTaskTrackingContext } from './statusRowPlanAction';

describe('getStatusRowPlanActionState', () => {
  test('shows the composer action without tasks and enables it only after save', () => {
    expect(getStatusRowPlanActionState({
      showTodos: true,
      isPlanAvailable: true,
      isVSCode: false,
      record: { sourceMessageId: 'msg-1', path: null, status: 'saving', error: null },
    })).toEqual({ visible: true, enabled: false, disabledReason: 'Plan file is still saving.' });

    expect(getStatusRowPlanActionState({
      showTodos: true,
      isPlanAvailable: true,
      isVSCode: false,
      record: { sourceMessageId: 'msg-1', path: '/plans/a.md', status: 'saved', error: null },
    })).toEqual({ visible: true, enabled: true, disabledReason: null });
  });

  test('does not add the right-panel action to VS Code or non-composer rows', () => {
    expect(getStatusRowPlanActionState({
      showTodos: true,
      isPlanAvailable: true,
      isVSCode: true,
      record: undefined,
    }).visible).toBe(false);
    expect(getStatusRowPlanActionState({
      showTodos: false,
      isPlanAvailable: true,
      isVSCode: false,
      record: undefined,
    }).visible).toBe(false);
  });

  test('keeps the action visible after reload when the saved file record outlives the transient plan projection', () => {
    expect(getStatusRowPlanActionState({
      showTodos: true,
      isPlanAvailable: false,
      isVSCode: false,
      record: { sourceMessageId: 'msg-1', path: '/plans/a.md', status: 'saved', error: null },
    })).toEqual({ visible: true, enabled: true, disabledReason: null });

    expect(hasPlanTaskTrackingContext({
      isPlanAvailable: false,
      record: { sourceMessageId: 'msg-1', path: '/plans/a.md', status: 'saved', error: null },
    })).toBe(true);
  });

  test('does not infer plan task tracking from an unsaved record alone', () => {
    expect(hasPlanTaskTrackingContext({
      isPlanAvailable: false,
      record: { sourceMessageId: 'msg-1', path: null, status: 'saving', error: null },
    })).toBe(false);
  });
});
