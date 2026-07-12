import type { PlanIndicatorState } from '@/sync/plan-indicator';

export type SessionIndicator = {
  className: string;
  labelKey:
    | 'sessions.sidebar.session.status.unread'
    | 'sessions.sidebar.session.status.completed'
    | 'sessions.sidebar.session.status.questionRequired'
    | 'sessions.sidebar.session.status.planReady'
    | 'sessions.sidebar.session.status.planCompleted'
    | 'sessions.sidebar.session.status.error';
};

type ResolveSidebarIndicatorOptions = {
  isRootSession: boolean;
  isWorking: boolean;
  isActive: boolean;
  hasUnreadCompletion: boolean;
  hasCompletedStatus: boolean;
  hasErrorStatus: boolean;
  pendingQuestionCount: number;
  planState: PlanIndicatorState | null;
};

type ResolveSidebarWorkingStatusOptions = {
  isWorking: boolean;
  pendingQuestionCount: number;
  planState?: PlanIndicatorState | null;
};

type ResolveSubtaskSidebarIndicatorOptions = {
  isRootSession: boolean;
  notifyOnSubtasks: boolean;
  isWorking: boolean;
  isActive: boolean;
  hasUnreadCompletion: boolean;
  hasUnreadError: boolean;
};

type ResolveLeadingIndicatorPositionOptions = {
  hasChildren: boolean;
  showLeadingStatus: boolean;
  isPinnedSession: boolean;
};

// Must cover the largest absolute left offset used by leading status/pin
// indicators so the animated row wrapper can clip vertically without hiding them.
export const SESSION_LEADING_INDICATOR_CLIP_GUTTER_PX = 34;

const QUESTION_REQUIRED_INDICATOR: SessionIndicator = {
  className: 'bg-status-info',
  labelKey: 'sessions.sidebar.session.status.questionRequired',
};

const PLAN_READY_INDICATOR: SessionIndicator = {
  className: 'bg-status-warning',
  labelKey: 'sessions.sidebar.session.status.planReady',
};

const PLAN_COMPLETED_INDICATOR: SessionIndicator = {
  className: 'bg-status-success',
  labelKey: 'sessions.sidebar.session.status.planCompleted',
};

const ERROR_INDICATOR: SessionIndicator = {
  className: 'bg-status-error',
  labelKey: 'sessions.sidebar.session.status.error',
};

const SESSION_COMPLETED_INDICATOR: SessionIndicator = {
  className: 'bg-status-success',
  labelKey: 'sessions.sidebar.session.status.completed',
};

export function resolveSidebarWorkingStatus({
  isWorking,
  pendingQuestionCount,
  planState,
}: ResolveSidebarWorkingStatusOptions): boolean {
  if (pendingQuestionCount > 0) return false;
  if (planState === 'proposed') return false;
  return isWorking;
}

export function resolveSidebarIndicator({
  isRootSession,
  isWorking,
  isActive,
  hasUnreadCompletion,
  hasCompletedStatus,
  hasErrorStatus,
  pendingQuestionCount,
  planState,
}: ResolveSidebarIndicatorOptions): SessionIndicator | null {
  if (!isRootSession) return null;

  if (pendingQuestionCount > 0) {
    return QUESTION_REQUIRED_INDICATOR;
  }

  // A proposed plan is an explicit plan-card lifecycle state. It must stay
  // yellow even if stale unread error/completion notifications remain until
  // the user opens the session and read-state cleanup runs.
  if (planState === 'proposed') {
    return PLAN_READY_INDICATOR;
  }

  if (hasErrorStatus) {
    return ERROR_INDICATOR;
  }

  if (isWorking || isActive || !hasUnreadCompletion) return null;

  if (planState === 'completed') {
    return PLAN_COMPLETED_INDICATOR;
  }

  if (hasCompletedStatus) {
    return SESSION_COMPLETED_INDICATOR;
  }

  return null;
}

export function resolveSubtaskSidebarIndicator({
  isRootSession,
  notifyOnSubtasks,
  isWorking,
  isActive,
  hasUnreadCompletion,
  hasUnreadError,
}: ResolveSubtaskSidebarIndicatorOptions): SessionIndicator | null {
  if (isRootSession || !notifyOnSubtasks || isWorking || isActive) return null;
  if (hasUnreadError) return ERROR_INDICATOR;
  if (hasUnreadCompletion) return SESSION_COMPLETED_INDICATOR;
  return null;
}

export function resolveLeadingIndicatorPositionClasses({
  hasChildren,
  showLeadingStatus,
  isPinnedSession,
}: ResolveLeadingIndicatorPositionOptions): string {
  if (showLeadingStatus && isPinnedSession) return 'left-[-34px] w-6';
  if (showLeadingStatus) return 'left-[-24px] w-3.5';
  if (hasChildren && isPinnedSession) return 'left-[-18px] w-3.5';
  return 'left-[-10px] w-3.5';
}
