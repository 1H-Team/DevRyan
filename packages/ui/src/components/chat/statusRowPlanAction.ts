import type { SessionPlanFileRecord } from '@/stores/useSessionPlanFileStore';
import type { PlanIndicatorEntry } from '@/sync/plan-indicator';

interface StatusRowPlanActionOptions {
  showTodos: boolean;
  isPlanAvailable: boolean;
  isVSCode: boolean;
  record: SessionPlanFileRecord | undefined;
}

export interface StatusRowPlanActionState {
  visible: boolean;
  enabled: boolean;
  disabledReason: string | null;
}

export interface PlanAutoRevealTarget {
  sessionId: string;
  sourceMessageId: string;
  path: string;
}

export const shouldAutoRevealPlanInMainTab = ({
  isMobile,
  isVSCode,
}: {
  isMobile: boolean;
  isVSCode: boolean;
}): boolean => isMobile || isVSCode;

export const getPlanAutoRevealTarget = ({
  sessionId,
  isPlanAvailable,
  planIndicator,
  isPlanSourceImplemented,
  record,
}: {
  sessionId: string | null;
  isPlanAvailable: boolean;
  planIndicator: PlanIndicatorEntry | undefined;
  isPlanSourceImplemented: boolean;
  record: SessionPlanFileRecord | undefined;
}): PlanAutoRevealTarget | null => {
  if (
    !sessionId
    || !isPlanAvailable
    || isPlanSourceImplemented
    || record?.status !== 'saved'
    || !record.path
    || record.autoRevealed === true
  ) {
    return null;
  }

  if (planIndicator && planIndicator.state !== 'proposed') {
    return null;
  }

  if (planIndicator?.sourceMessageId && planIndicator.sourceMessageId !== record.sourceMessageId) {
    return null;
  }

  return {
    sessionId,
    sourceMessageId: record.sourceMessageId,
    path: record.path,
  };
};

export const hasPlanTaskTrackingContext = ({
  isPlanAvailable,
  record,
}: Pick<StatusRowPlanActionOptions, 'isPlanAvailable' | 'record'>): boolean => (
  isPlanAvailable || (record?.status === 'saved' && Boolean(record.path))
);

export const getStatusRowPlanActionState = ({
  showTodos,
  isPlanAvailable,
  isVSCode,
  record,
}: StatusRowPlanActionOptions): StatusRowPlanActionState => {
  if (!showTodos || (!isPlanAvailable && !record) || isVSCode) {
    return { visible: false, enabled: false, disabledReason: null };
  }

  if (record?.status === 'saved' && record.path) {
    return { visible: true, enabled: true, disabledReason: null };
  }

  if (record?.status === 'saving') {
    return { visible: true, enabled: false, disabledReason: 'Plan file is still saving.' };
  }

  if (record?.status === 'error') {
    return { visible: true, enabled: false, disabledReason: 'Plan file could not be saved. Retry from the plan card.' };
  }

  return { visible: true, enabled: false, disabledReason: 'Plan file is not ready yet.' };
};
