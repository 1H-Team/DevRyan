import type { PlanCardSentinelSplit } from './actionablePlan';

export type PlanCardRenderSegment =
  | { kind: 'preserved-text'; text: string }
  | { kind: 'consumed-plan-text'; text: string }
  | { kind: 'plan-card' };

export const shouldSuppressPostPlanText = (
  messagePlan: PlanCardSentinelSplit | null | undefined,
  isPlanModeSource: boolean,
): boolean => {
  if (!messagePlan) return false;
  return isPlanModeSource === true || messagePlan.source === 'sentinel';
};

export const shouldStopAfterPlanCard = (
  messagePlan: PlanCardSentinelSplit | null | undefined,
  isPlanModeSource: boolean,
  planCardRendered: boolean,
): boolean => (
  planCardRendered && shouldSuppressPostPlanText(messagePlan, isPlanModeSource)
);

export const buildPlanCardRenderSegments = ({
  groupText,
  groupStart,
  groupEnd,
  messagePlan,
  planCardRendered,
  suppressPostPlanText = false,
  mountPlanCard = true,
}: {
  groupText: string;
  groupStart: number;
  groupEnd: number;
  messagePlan: PlanCardSentinelSplit;
  planCardRendered: boolean;
  suppressPostPlanText?: boolean;
  /**
   * When false the plan body is consumed without emitting a plan-card
   * segment — used for earlier siblings of a plan revision whose plan text
   * was superseded by the revision's selected source message.
   */
  mountPlanCard?: boolean;
}): { segments: PlanCardRenderSegment[]; planCardRendered: boolean } => {
  const planStart = messagePlan.preambleText.length;
  const planEnd = planStart + messagePlan.planText.length;
  const segments: PlanCardRenderSegment[] = [];
  let rendered = planCardRendered;
  const pushTextSegment = (kind: 'preserved-text' | 'consumed-plan-text', text: string) => {
    if (text.trim().length > 0) {
      segments.push({ kind, text });
    }
  };

  if (groupEnd <= planStart) {
    pushTextSegment('preserved-text', groupText);
    return { segments, planCardRendered: rendered };
  }

  if (groupStart >= planEnd) {
    pushTextSegment(suppressPostPlanText && rendered ? 'consumed-plan-text' : 'preserved-text', groupText);
    return { segments, planCardRendered: rendered };
  }

  if (groupStart < planStart) {
    const preamblePortion = groupText.slice(0, Math.max(0, planStart - groupStart));
    pushTextSegment('preserved-text', preamblePortion);
  }

  if (!rendered && groupEnd > planStart && messagePlan.planText.trim().length > 0) {
    if (mountPlanCard) {
      segments.push({ kind: 'plan-card' });
    }
    rendered = true;
  }

  const consumedStart = Math.max(groupStart, planStart);
  const consumedEnd = Math.min(groupEnd, planEnd);
  if (consumedEnd > consumedStart) {
    pushTextSegment(
      'consumed-plan-text',
      groupText.slice(consumedStart - groupStart, consumedEnd - groupStart),
    );
  }

  if (groupEnd > planEnd) {
    pushTextSegment(
      suppressPostPlanText && rendered ? 'consumed-plan-text' : 'preserved-text',
      groupText.slice(Math.max(0, planEnd - groupStart)),
    );
  }

  return { segments, planCardRendered: rendered };
};
