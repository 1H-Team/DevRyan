import { describe, expect, test } from 'bun:test';
import {
  SESSION_LEADING_INDICATOR_CLIP_GUTTER_PX,
  resolveLeadingIndicatorPositionClasses,
  resolveSidebarIndicator,
  resolveSidebarWorkingStatus,
  resolveSubtaskSidebarIndicator,
} from './sessionIndicator';

function parseNegativeLeftOffsetPx(className: string): number {
  const match = className.match(/\bleft-\[-(\d+)px\]/);
  if (!match) {
    throw new Error(`Expected a negative pixel left offset in "${className}"`);
  }
  return Number(match[1]);
}

describe('resolveSidebarIndicator', () => {
  test('shows a success indicator for completed plans without unread notifications', () => {
    expect(resolveSidebarIndicator({
      isRootSession: true,
      isWorking: false,
      hasUnreadStatus: false,
      hasUnreadCompletion: false,
      hasCompletedStatus: false,
      hasErrorStatus: false,
      pendingQuestionCount: 0,
      planState: 'completed',
    })).toEqual({
      className: 'bg-status-success',
      labelKey: 'sessions.sidebar.session.status.planCompleted',
    });
  });

  test('shows a success indicator for completed normal turns', () => {
    expect(resolveSidebarIndicator({
      isRootSession: true,
      isWorking: false,
      hasUnreadStatus: false,
      hasUnreadCompletion: false,
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
      hasUnreadStatus: true,
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
      hasUnreadStatus: false,
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
      hasUnreadStatus: true,
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
      hasUnreadStatus: true,
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
      hasUnreadStatus: true,
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
      hasUnreadStatus: true,
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
      hasUnreadStatus: false,
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

describe('resolveSubtaskSidebarIndicator', () => {
  test('does not show a blue info dot for generic unread subtask updates', () => {
    expect(resolveSubtaskSidebarIndicator({
      isRootSession: false,
      notifyOnSubtasks: true,
      isWorking: false,
      isActive: false,
      hasUnreadCompletion: false,
      hasUnreadError: false,
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
    })).toEqual({
      className: 'bg-status-success',
      labelKey: 'sessions.sidebar.session.status.completed',
    });
  });
});

describe('resolveLeadingIndicatorPositionClasses', () => {
  test('aligns status indicators with the child-row indicator slot even without children', () => {
    expect(resolveLeadingIndicatorPositionClasses({
      hasChildren: false,
      showLeadingStatus: true,
      isPinnedSession: false,
    })).toBe('left-[-24px] w-3.5');
  });

  test('keeps the combined pinned and status slot aligned with child rows', () => {
    expect(resolveLeadingIndicatorPositionClasses({
      hasChildren: false,
      showLeadingStatus: true,
      isPinnedSession: true,
    })).toBe('left-[-34px] w-6');
  });

  test('keeps the motion-row clipping gutter wide enough for the widest leading status slot', () => {
    const className = resolveLeadingIndicatorPositionClasses({
      hasChildren: false,
      showLeadingStatus: true,
      isPinnedSession: true,
    });

    expect(SESSION_LEADING_INDICATOR_CLIP_GUTTER_PX >= parseNegativeLeftOffsetPx(className)).toBe(true);
  });
});
