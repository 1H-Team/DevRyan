import type { SessionPlanFileRecord } from '@/stores/useSessionPlanFileStore';

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
