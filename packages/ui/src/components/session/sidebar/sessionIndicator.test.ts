import { describe, expect, test } from 'bun:test';
import {
  collectSessionIndicatorScopeIds,
  hasWorkingDescendantSession,
  resolveLeadingRailLayout,
  resolveMobileSessionIndicatorPresentation,
  resolveSidebarIndicator,
  resolveSidebarWorkingStatus,
  resolveSubtaskSidebarIndicator,
} from './sessionIndicator';

describe('hasWorkingDescendantSession', () => {
  test('keeps a parent active while one of its descendant sessions is working', () => {
    expect(hasWorkingDescendantSession(['child-idle', 'child-busy'], {
      session_status: {
        'child-idle': { type: 'idle' },
        'child-busy': { type: 'busy' },
      },
      permission: {},
    })).toBe(true);
  });

  test('settles the parent when every descendant is idle or blocked on permission', () => {
    expect(hasWorkingDescendantSession(['child-idle', 'child-blocked'], {
      session_status: {
        'child-idle': { type: 'idle' },
        'child-blocked': { type: 'retry' },
      },
      permission: {
        'child-blocked': [{}],
      },
    })).toBe(false);
  });

  test('ignores unrelated session activity outside the parent branch', () => {
    expect(hasWorkingDescendantSession(['child-idle'], {
      session_status: {
        'child-idle': { type: 'idle' },
        unrelated: { type: 'busy' },
      },
      permission: {},
    })).toBe(false);
  });
});

describe('resolveSidebarIndicator', () => {
  test('does not show a completed-plan indicator without unread completion state', () => {
    expect(resolveSidebarIndicator({
      isRootSession: true,
      isWorking: false,
      isActive: false,
      hasUnreadCompletion: false,
      hasCompletedStatus: false,
      hasErrorStatus: false,
      pendingQuestionCount: 0,
      planState: 'completed',
    })).toBeNull();
  });

  test('shows a success indicator for unread background normal turns', () => {
    expect(resolveSidebarIndicator({
      isRootSession: true,
      isWorking: false,
      isActive: false,
      hasUnreadCompletion: true,
      hasCompletedStatus: true,
      hasErrorStatus: false,
      pendingQuestionCount: 0,
      planState: null,
    })).toEqual({
      className: 'bg-status-success',
      labelKey: 'sessions.sidebar.session.status.completed',
    });
  });

  test('does not show completion from unread notifications without a settled completion indicator', () => {
    expect(resolveSidebarIndicator({
      isRootSession: true,
      isWorking: false,
      isActive: false,
      hasUnreadCompletion: true,
      hasCompletedStatus: false,
      hasErrorStatus: false,
      pendingQuestionCount: 0,
      planState: null,
    })).toBeNull();
  });

  test('hides completion when read-state cleanup has cleared completion inputs', () => {
    expect(resolveSidebarIndicator({
      isRootSession: true,
      isWorking: false,
      isActive: false,
      hasUnreadCompletion: false,
      hasCompletedStatus: false,
      hasErrorStatus: false,
      pendingQuestionCount: 0,
      planState: null,
    })).toBeNull();
  });

  test('keeps pending questions higher priority than completion', () => {
    expect(resolveSidebarIndicator({
      isRootSession: true,
      isWorking: false,
      isActive: true,
      hasUnreadCompletion: true,
      hasCompletedStatus: true,
      hasErrorStatus: true,
      pendingQuestionCount: 1,
      planState: 'completed',
    })).toEqual({
      className: 'bg-status-info',
      labelKey: 'sessions.sidebar.session.status.questionRequired',
    });
  });

  test('keeps pending questions higher priority than a proposed plan, errors, and completion', () => {
    expect(resolveSidebarIndicator({
      isRootSession: true,
      isWorking: true,
      isActive: true,
      hasUnreadCompletion: true,
      hasCompletedStatus: true,
      hasErrorStatus: true,
      pendingQuestionCount: 1,
      planState: 'proposed',
    })).toEqual({
      className: 'bg-status-info',
      labelKey: 'sessions.sidebar.session.status.questionRequired',
    });
  });

  test('hides completion while the session is working', () => {
    expect(resolveSidebarIndicator({
      isRootSession: true,
      isWorking: true,
      isActive: false,
      hasUnreadCompletion: true,
      hasCompletedStatus: true,
      hasErrorStatus: false,
      pendingQuestionCount: 0,
      planState: 'completed',
    })).toBeNull();
  });

  test('keeps proposed plans higher priority than stale completion', () => {
    expect(resolveSidebarIndicator({
      isRootSession: true,
      isWorking: false,
      isActive: false,
      hasUnreadCompletion: true,
      hasCompletedStatus: true,
      hasErrorStatus: false,
      pendingQuestionCount: 0,
      planState: 'proposed',
    })).toEqual({
      className: 'bg-status-warning',
      labelKey: 'sessions.sidebar.session.status.planReady',
    });
  });

  test('keeps proposed plans higher priority than stale unread errors and completion', () => {
    expect(resolveSidebarIndicator({
      isRootSession: true,
      isWorking: false,
      isActive: false,
      hasUnreadCompletion: true,
      hasCompletedStatus: true,
      hasErrorStatus: true,
      pendingQuestionCount: 0,
      planState: 'proposed',
    })).toEqual({
      className: 'bg-status-warning',
      labelKey: 'sessions.sidebar.session.status.planReady',
    });
  });

  test('keeps active work ahead of a proposed plan indicator', () => {
    expect(resolveSidebarIndicator({
      isRootSession: true,
      isWorking: true,
      isActive: true,
      hasUnreadCompletion: false,
      hasCompletedStatus: false,
      hasErrorStatus: false,
      pendingQuestionCount: 0,
      planState: 'proposed',
    })).toBeNull();
  });

  test('does not show green for the active session even when completion state is stale', () => {
    expect(resolveSidebarIndicator({
      isRootSession: true,
      isWorking: false,
      isActive: true,
      hasUnreadCompletion: true,
      hasCompletedStatus: true,
      hasErrorStatus: false,
      pendingQuestionCount: 0,
      planState: null,
    })).toBeNull();
  });

  test('shows completed plans only for unread background completion', () => {
    expect(resolveSidebarIndicator({
      isRootSession: true,
      isWorking: false,
      isActive: false,
      hasUnreadCompletion: true,
      hasCompletedStatus: false,
      hasErrorStatus: false,
      pendingQuestionCount: 0,
      planState: 'completed',
    })).toEqual({
      className: 'bg-status-success',
      labelKey: 'sessions.sidebar.session.status.planCompleted',
    });
  });

  test('keeps unread errors higher priority than unread completion', () => {
    expect(resolveSidebarIndicator({
      isRootSession: true,
      isWorking: false,
      isActive: false,
      hasUnreadCompletion: true,
      hasCompletedStatus: true,
      hasErrorStatus: true,
      pendingQuestionCount: 0,
      planState: 'completed',
    })).toEqual({
      className: 'bg-status-error',
      labelKey: 'sessions.sidebar.session.status.error',
    });
  });
});

describe('resolveSidebarWorkingStatus', () => {
  test('does not show a stale active spinner while a question requires an answer', () => {
    expect(resolveSidebarWorkingStatus({
      isWorking: true,
      pendingQuestionCount: 1,
      planState: null,
    })).toBe(false);
  });

  test('keeps the active spinner until a proposed plan is authoritatively idle', () => {
    expect(resolveSidebarWorkingStatus({
      isWorking: true,
      pendingQuestionCount: 0,
      planState: 'proposed',
    })).toBe(true);
  });

  test('keeps active spinner while a plan is implementing', () => {
    expect(resolveSidebarWorkingStatus({
      isWorking: true,
      pendingQuestionCount: 0,
      planState: 'implementing',
    })).toBe(true);
  });

  test('keeps active spinner while completed plan state lingers during new work', () => {
    expect(resolveSidebarWorkingStatus({
      isWorking: true,
      pendingQuestionCount: 0,
      planState: 'completed',
    })).toBe(true);
  });
});

describe('collectSessionIndicatorScopeIds', () => {
  test('collects nested descendants once for root-level question and error aggregation', () => {
    const childrenByParent = new Map([
      ['root', [{ id: 'child-a' }, { id: 'child-b' }]],
      ['child-a', [{ id: 'grandchild' }]],
      ['grandchild', [{ id: 'root' }]],
    ]);

    expect(collectSessionIndicatorScopeIds('root', childrenByParent)).toEqual([
      'root',
      'child-a',
      'child-b',
      'grandchild',
    ]);
  });

  test('keeps a leaf scope limited to the root session', () => {
    expect(collectSessionIndicatorScopeIds('leaf', new Map())).toEqual(['leaf']);
  });
});

describe('resolveMobileSessionIndicatorPresentation', () => {
  test('renders a working spinner before stale lifecycle attention', () => {
    const indicator = resolveSidebarIndicator({
      isRootSession: true,
      isWorking: true,
      isActive: false,
      hasUnreadCompletion: false,
      hasCompletedStatus: false,
      hasErrorStatus: true,
      pendingQuestionCount: 0,
      planState: null,
    });

    expect(resolveMobileSessionIndicatorPresentation({
      indicator,
      isWorking: true,
      planState: null,
    })).toEqual({
      kind: 'working',
      labelKey: 'sessions.sidebar.session.status.active',
    });
  });

  test('labels ordinary and plan implementation work distinctly', () => {
    expect(resolveMobileSessionIndicatorPresentation({
      indicator: null,
      isWorking: true,
      planState: null,
    })).toEqual({
      kind: 'working',
      labelKey: 'sessions.sidebar.session.status.active',
    });

    expect(resolveMobileSessionIndicatorPresentation({
      indicator: null,
      isWorking: true,
      planState: 'implementing',
    })).toEqual({
      kind: 'working',
      labelKey: 'sessions.sidebar.session.status.planExecuting',
    });
  });

  test('retains the mobile neutral marker when no lifecycle state is active', () => {
    expect(resolveMobileSessionIndicatorPresentation({
      indicator: null,
      isWorking: false,
      planState: null,
    })).toEqual({ kind: 'idle' });
  });
});

describe('resolveSubtaskSidebarIndicator', () => {
  test('does not show a blue info dot for generic unread subtask updates', () => {
    expect(resolveSubtaskSidebarIndicator({
      isRootSession: false,
      notifyOnSubtasks: true,
      isWorking: false,
      isActive: false,
      hasUnreadCompletion: false,
      hasUnreadError: false,
      hasParentOwnedRecovery: false,
    })).toBeNull();
  });

  test('shows red for unread subtask errors and green for unread subtask completion', () => {
    expect(resolveSubtaskSidebarIndicator({
      isRootSession: false,
      notifyOnSubtasks: true,
      isWorking: false,
      isActive: false,
      hasUnreadCompletion: true,
      hasUnreadError: true,
      hasParentOwnedRecovery: false,
    })).toEqual({
      className: 'bg-status-error',
      labelKey: 'sessions.sidebar.session.status.error',
    });

    expect(resolveSubtaskSidebarIndicator({
      isRootSession: false,
      notifyOnSubtasks: true,
      isWorking: false,
      isActive: false,
      hasUnreadCompletion: true,
      hasUnreadError: false,
      hasParentOwnedRecovery: false,
    })).toEqual({
      className: 'bg-status-success',
      labelKey: 'sessions.sidebar.session.status.completed',
    });
  });

  test('does not put parent-owned recovery attention or a duplicate unread error on a child row', () => {
    expect(resolveSubtaskSidebarIndicator({
      isRootSession: false,
      notifyOnSubtasks: true,
      isWorking: false,
      isActive: false,
      hasUnreadCompletion: false,
      hasUnreadError: true,
      hasParentOwnedRecovery: true,
    })).toBeNull();
  });
});

describe('resolveLeadingRailLayout', () => {
  test('keeps status, pin, and parent chevron in left-to-right order', () => {
    expect(resolveLeadingRailLayout({
      hasChildren: true,
      showLeadingStatus: true,
      isPinnedSession: true,
    })).toEqual({
      slots: ['status', 'pin', 'chevron'],
    });
  });

  test('keeps status immediately left of the parent chevron without a pin', () => {
    expect(resolveLeadingRailLayout({
      hasChildren: true,
      showLeadingStatus: true,
      isPinnedSession: false,
    })).toEqual({
      slots: [null, 'status', 'chevron'],
    });
  });

  test('uses the middle status slot for an unpinned leaf session', () => {
    expect(resolveLeadingRailLayout({
      hasChildren: false,
      showLeadingStatus: true,
      isPinnedSession: false,
    })).toEqual({
      slots: [null, 'status', null],
    });
  });

  test('keeps status and pin in independent slots for a pinned leaf session', () => {
    expect(resolveLeadingRailLayout({
      hasChildren: false,
      showLeadingStatus: true,
      isPinnedSession: true,
    })).toEqual({
      slots: ['status', 'pin', null],
    });
  });

  test('reserves only the pin slot for a pinned leaf session', () => {
    expect(resolveLeadingRailLayout({
      hasChildren: false,
      showLeadingStatus: false,
      isPinnedSession: true,
    })).toEqual({
      slots: [null, null, 'pin'],
    });
  });

  test('keeps an unmarked leaf row empty while the fixed rail preserves title alignment', () => {
    expect(resolveLeadingRailLayout({
      hasChildren: false,
      showLeadingStatus: false,
      isPinnedSession: false,
    })).toEqual({
      slots: [null, null, null],
    });
  });
});
