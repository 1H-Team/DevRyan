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

export type MobileSessionIndicatorPresentation =
  | { kind: 'status'; indicator: SessionIndicator }
  | {
      kind: 'working';
      labelKey:
        | 'sessions.sidebar.session.status.active'
        | 'sessions.sidebar.session.status.planExecuting';
    }
  | { kind: 'idle' };

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
  hasManualRecovery: boolean;
  manualRecoveryFailureKind?: 'provider_usage_limit' | null;
};

type ResolveLeadingRailLayoutOptions = {
  hasChildren: boolean;
  showLeadingStatus: boolean;
  isPinnedSession: boolean;
};

export type LeadingRailLayout = {
  slots: [
    'status' | null,
    'status' | 'pin' | null,
    'pin' | 'chevron' | null,
  ];
};

type SessionChildIdentity = {
  id: string;
};

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

export function collectSessionIndicatorScopeIds(
  rootSessionId: string,
  childrenByParent: ReadonlyMap<string, readonly SessionChildIdentity[]>,
): string[] {
  const scope = [rootSessionId];
  const seen = new Set(scope);
  const pending = [...(childrenByParent.get(rootSessionId) ?? [])];

  while (pending.length > 0) {
    const child = pending.shift();
    if (!child || seen.has(child.id)) continue;

    seen.add(child.id);
    scope.push(child.id);
    pending.push(...(childrenByParent.get(child.id) ?? []));
  }

  return scope;
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

export function resolveMobileSessionIndicatorPresentation({
  indicator,
  isWorking,
  planState,
}: {
  indicator: SessionIndicator | null;
  isWorking: boolean;
  planState: PlanIndicatorState | null;
}): MobileSessionIndicatorPresentation {
  if (indicator) {
    return { kind: 'status', indicator };
  }

  if (isWorking) {
    return {
      kind: 'working',
      labelKey: planState === 'implementing'
        ? 'sessions.sidebar.session.status.planExecuting'
        : 'sessions.sidebar.session.status.active',
    };
  }

  return { kind: 'idle' };
}

export function resolveSubtaskSidebarIndicator({
  isRootSession,
  notifyOnSubtasks,
  isWorking,
  isActive,
  hasUnreadCompletion,
  hasUnreadError,
  hasManualRecovery,
  manualRecoveryFailureKind,
}: ResolveSubtaskSidebarIndicatorOptions): SessionIndicator | null {
  if (isRootSession) return null;
  if (hasManualRecovery && (!isWorking || manualRecoveryFailureKind === 'provider_usage_limit')) {
    return ERROR_INDICATOR;
  }
  if (!notifyOnSubtasks || isWorking || isActive) return null;
  if (hasUnreadError) return ERROR_INDICATOR;
  if (hasUnreadCompletion) return SESSION_COMPLETED_INDICATOR;
  return null;
}

export function resolveLeadingRailLayout({
  hasChildren,
  showLeadingStatus,
  isPinnedSession,
}: ResolveLeadingRailLayoutOptions): LeadingRailLayout {
  const slots: LeadingRailLayout['slots'] = [null, null, null];

  if (hasChildren) {
    slots[2] = 'chevron';
  }

  if (showLeadingStatus && isPinnedSession) {
    slots[0] = 'status';
    slots[1] = 'pin';
    return { slots };
  }

  if (showLeadingStatus) {
    slots[1] = 'status';
    return { slots };
  }

  if (isPinnedSession) {
    slots[hasChildren ? 1 : 2] = 'pin';
  }

  return {
    slots,
  };
}
