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

type SessionWorkingLabelKey =
  | 'sessions.sidebar.session.status.active'
  | 'sessions.sidebar.session.status.planExecuting';

export type SessionLeadingIndicatorPresentation =
  | { kind: 'status'; indicator: SessionIndicator }
  | { kind: 'working'; labelKey: SessionWorkingLabelKey }
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
  hasParentOwnedRecovery: boolean;
};

type ResolveLeadingRailLayoutOptions = {
  hasChildren: boolean;
  isPinnedSession: boolean;
};

export type LeadingRailLayout = {
  slots: [
    'status' | null,
    'status' | 'pin',
    'chevron' | null,
  ];
};

type SessionChildIdentity = {
  id: string;
};

type SessionBranchActivityState = {
  session_status: Record<string, { type?: string } | undefined>;
  permission: Record<string, readonly unknown[] | undefined>;
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
}: ResolveSidebarWorkingStatusOptions): boolean {
  if (pendingQuestionCount > 0) return false;
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

export function hasWorkingDescendantSession(
  descendantSessionIds: readonly string[],
  state: SessionBranchActivityState,
): boolean {
  return descendantSessionIds.some((sessionId) => {
    if ((state.permission[sessionId]?.length ?? 0) > 0) return false;
    const status = state.session_status[sessionId];
    return status !== undefined && status.type !== 'idle';
  });
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

  // Authoritative activity always owns the leading status slot. Plan and
  // completion attention are only meaningful after the run reaches idle.
  if (isWorking) return null;

  // A proposed plan is an explicit plan-card lifecycle state. It must stay
  // yellow even if stale unread error/completion notifications remain until
  // the user opens the session and read-state cleanup runs.
  if (planState === 'proposed') {
    return PLAN_READY_INDICATOR;
  }

  if (hasErrorStatus) {
    return ERROR_INDICATOR;
  }

  if (isActive || !hasUnreadCompletion) return null;

  if (planState === 'completed') {
    return PLAN_COMPLETED_INDICATOR;
  }

  if (hasCompletedStatus) {
    return SESSION_COMPLETED_INDICATOR;
  }

  return null;
}

// One leading slot per row: attention color first, then the working blink,
// otherwise the idle placeholder ring.
export function resolveSessionLeadingIndicatorPresentation({
  indicator,
  isWorking,
  isImplementingPlan,
}: {
  indicator: SessionIndicator | null;
  isWorking: boolean;
  isImplementingPlan: boolean;
}): SessionLeadingIndicatorPresentation {
  if (indicator) {
    return { kind: 'status', indicator };
  }

  if (isWorking) {
    return {
      kind: 'working',
      labelKey: isImplementingPlan
        ? 'sessions.sidebar.session.status.planExecuting'
        : 'sessions.sidebar.session.status.active',
    };
  }

  return { kind: 'idle' };
}

export function resolveSessionLeadingIndicatorLabelKey(
  presentation: SessionLeadingIndicatorPresentation,
): SessionIndicator['labelKey'] | SessionWorkingLabelKey | null {
  if (presentation.kind === 'status') return presentation.indicator.labelKey;
  if (presentation.kind === 'working') return presentation.labelKey;
  return null;
}

export function resolveSubtaskSidebarIndicator({
  isRootSession,
  notifyOnSubtasks,
  isWorking,
  isActive,
  hasUnreadCompletion,
  hasUnreadError,
  hasParentOwnedRecovery,
}: ResolveSubtaskSidebarIndicatorOptions): SessionIndicator | null {
  if (isRootSession || hasParentOwnedRecovery) return null;
  if (!notifyOnSubtasks || isWorking || isActive) return null;
  if (hasUnreadError) return ERROR_INDICATOR;
  if (hasUnreadCompletion) return SESSION_COMPLETED_INDICATOR;
  return null;
}

// The status slot is always occupied (colored dot, working blink, or idle
// ring), so it keeps a fixed position: left of the pin on pinned rows,
// immediately left of the chevron/title otherwise.
export function resolveLeadingRailLayout({
  hasChildren,
  isPinnedSession,
}: ResolveLeadingRailLayoutOptions): LeadingRailLayout {
  const chevron = hasChildren ? 'chevron' : null;

  if (isPinnedSession) {
    return { slots: ['status', 'pin', chevron] };
  }

  return { slots: [null, 'status', chevron] };
}
