import type { StreamPhase } from '../types';
import { getPlanBlockId, getPlanImplementationKey } from '@/lib/messages/actionablePlan';

const MIN_SKELETON_LINES = 8;
const MAX_SKELETON_LINES = 48;
const ESTIMATED_CHARS_PER_LINE = 72;

export const PLAN_CARD_COLLAPSED_CONTENT_LINES = 8;
export const PLAN_CARD_COLLAPSED_LINE_HEIGHT_PX = 24;
export const PLAN_CARD_BODY_VERTICAL_PADDING_PX = 32;
export const getPlanCardCollapsedMaxHeight = ({
  lineCount = PLAN_CARD_COLLAPSED_CONTENT_LINES,
  lineHeightPx = PLAN_CARD_COLLAPSED_LINE_HEIGHT_PX,
  bodyVerticalPaddingPx = PLAN_CARD_BODY_VERTICAL_PADDING_PX,
}: {
  lineCount?: number;
  lineHeightPx?: number;
  bodyVerticalPaddingPx?: number;
} = {}): number => (lineCount * lineHeightPx) + bodyVerticalPaddingPx;

export const PLAN_CARD_COLLAPSED_MAX_HEIGHT_PX = getPlanCardCollapsedMaxHeight();
export const PLAN_CARD_EXPAND_BUTTON_SIZE_PX = 28;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export interface PlanSkeletonRevealState {
  hasPlanText: boolean;
  showInitialSkeleton: boolean;
  skeletonLineCount: number;
}

export interface PlanCardActionState {
  canImplement: boolean;
  disabledReason: string | null;
}

export const getPlanCardActionState = ({
  streamPhase,
  hasPlanText,
  isImplementationRequested,
  isLatestPlan,
}: {
  streamPhase: StreamPhase;
  hasPlanText: boolean;
  isImplementationRequested: boolean;
  isLatestPlan: boolean;
}): PlanCardActionState => {
  if (!isLatestPlan) {
    return {
      canImplement: false,
      disabledReason: 'Superseded by a newer plan.',
    };
  }

  return {
    canImplement: streamPhase === 'completed' && hasPlanText && !isImplementationRequested,
    disabledReason: null,
  };
};

export const resolvePlanCardDisplayText = ({
  rawPlanText,
  throttledPlanText,
  isStreaming,
}: {
  rawPlanText: string;
  throttledPlanText: string;
  isStreaming: boolean;
}): string => {
  return isStreaming ? throttledPlanText : rawPlanText;
};

export const getPlanSkeletonLineCount = (planText: string): number => {
  const trimmed = planText.trim();
  if (trimmed.length === 0) return MIN_SKELETON_LINES;

  const explicitLineCount = trimmed.split(/\r?\n/).length;
  const estimatedWrappedLineCount = Math.ceil(trimmed.length / ESTIMATED_CHARS_PER_LINE);

  return clamp(
    Math.max(MIN_SKELETON_LINES, explicitLineCount, estimatedWrappedLineCount),
    MIN_SKELETON_LINES,
    MAX_SKELETON_LINES,
  );
};

// Skeleton line count must only grow during a session — shrinking would
// reflow the skeleton as the streamed plan tokens arrive, which reads as
// jitter. Callers stash the previous value and pass it as `previous`.
export const getStableSkeletonLineCount = (
  planText: string,
  previous: number,
): number => {
  const next = getPlanSkeletonLineCount(planText);
  return next > previous ? next : previous;
};

// The card shows a loading skeleton only until the first plan tokens arrive.
// Once any text exists the plan streams in directly through the throttled
// markdown renderer — the same token-by-token reveal used for agent text and
// reasoning — instead of being unmasked line-by-line behind a skeleton overlay.
export const getPlanSkeletonRevealState = ({
  planText,
  streamPhase,
}: {
  planText: string;
  streamPhase: StreamPhase;
}): PlanSkeletonRevealState => {
  const hasPlanText = planText.trim().length > 0;
  const isComplete = streamPhase === 'completed';

  return {
    hasPlanText,
    showInitialSkeleton: !isComplete && !hasPlanText,
    skeletonLineCount: getPlanSkeletonLineCount(planText),
  };
};

export const getPlanCardImplementationKey = (
  sessionId: string,
  sourceMessageId: string,
): string => getPlanImplementationKey(sessionId, getPlanBlockId(sourceMessageId, 0));
