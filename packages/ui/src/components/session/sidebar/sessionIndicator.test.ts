import { describe, expect, test } from 'bun:test';
import {
  collectSessionIndicatorScopeIds,
  resolveLeadingRailLayout,
  resolveMobileSessionIndicatorPresentation,
  resolveSidebarIndicator,
  resolveSidebarWorkingStatus,
  resolveSubtaskSidebarIndicator,
} from './sessionIndicator';

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

  test('shows proposed plan indicator even while stale working status is present', () => {
    expect(resolveSidebarIndicator({
      isRootSession: true,
      isWorking: true,
      isActive: true,
      hasUnreadCompletion: false,
      hasCompletedStatus: false,
      hasErrorStatus: false,
      pendingQuestionCount: 0,
      planState: 'proposed',
    })).toEqual({
      className: 'bg-status-warning',
      labelKey: 'sessions.sidebar.session.status.planReady',
    });
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
  test('does not show a stale active spinner once a plan is ready', () => {
    expect(resolveSidebarWorkingStatus({
      isWorking: true,
      pendingQuestionCount: 0,
      planState: 'proposed',
    })).toBe(false);
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
  test('renders the shared lifecycle color before a working spinner', () => {
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
      kind: 'status',
      indicator: {
        className: 'bg-status-error',
        labelKey: 'sessions.sidebar.session.status.error',
      },
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
      hasManualRecovery: false,
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
      hasManualRecovery: false,
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
      hasManualRecovery: false,
    })).toEqual({
      className: 'bg-status-success',
      labelKey: 'sessions.sidebar.session.status.completed',
    });
  });

  test('suppresses a stale transient manual-recovery dot while the child is working', () => {
    expect(resolveSubtaskSidebarIndicator({
      isRootSession: false,
      notifyOnSubtasks: false,
      isWorking: true,
      isActive: true,
      hasUnreadCompletion: false,
      hasUnreadError: false,
      hasManualRecovery: true,
    })).toBeNull();
  });

  test('keeps unresolved provider-limit recovery red while the child reports working', () => {
    expect(resolveSubtaskSidebarIndicator({
      isRootSession: false,
      notifyOnSubtasks: false,
      isWorking: true,
      isActive: true,
      hasUnreadCompletion: false,
      hasUnreadError: false,
      hasManualRecovery: true,
      manualRecoveryFailureKind: 'provider_usage_limit',
    })).toEqual({
      className: 'bg-status-error',
      labelKey: 'sessions.sidebar.session.status.error',
    });
  });
});

describe('resolveLeadingRailLayout', () => {
  test('reserves only the status slot for a completed root session without children', () => {
    expect(resolveLeadingRailLayout({
      hasChildren: false,
      showLeadingStatus: true,
      isPinnedSession: false,
    })).toEqual({
      slots: [null, 'status', null],
    });
  });

  test('keeps status and pin in independent slots', () => {
    expect(resolveLeadingRailLayout({
      hasChildren: false,
      showLeadingStatus: true,
      isPinnedSession: true,
    })).toEqual({
      slots: ['status', 'pin', null],
    });
  });

  test('keeps parent chevron, status, and pin in three independent slots', () => {
    expect(resolveLeadingRailLayout({
      hasChildren: true,
      showLeadingStatus: true,
      isPinnedSession: true,
    })).toEqual({
      slots: ['status', 'pin', 'chevron'],
    });
  });

  test('reserves the chevron slot without manufacturing a status or pin', () => {
    expect(resolveLeadingRailLayout({
      hasChildren: true,
      showLeadingStatus: false,
      isPinnedSession: false,
    })).toEqual({
      slots: [null, null, 'chevron'],
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
