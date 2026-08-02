import { describe, expect, test } from 'bun:test';

import {
  PLAN_CARD_BODY_VERTICAL_PADDING_PX,
  PLAN_CARD_COLLAPSED_CONTENT_LINES,
  getPlanCardImplementationKey,
  getPlanSkeletonLineCount,
  getPlanSkeletonRevealState,
  getStableSkeletonLineCount,
  getPlanCardCollapsedMaxHeight,
  getPlanCardActionState,
  getPlanCardDataState,
  shouldPersistPlanCard,
  resolvePlanCardDisplayText,
} from './planCardReveal';

describe('getPlanSkeletonRevealState', () => {
  test('uses the initial skeleton while streaming before plan text exists', () => {
    expect(getPlanSkeletonRevealState({
      planText: '',
      streamPhase: 'streaming',
    })).toEqual({
      hasPlanText: false,
      showInitialSkeleton: true,
      skeletonLineCount: 8,
    });
  });

  test('drops the skeleton once plan text exists so it streams in like agent text', () => {
    const state = getPlanSkeletonRevealState({
      planText: '# Plan\n\n1. Do work',
      streamPhase: 'streaming',
    });

    expect(state.hasPlanText).toBe(true);
    expect(state.showInitialSkeleton).toBe(false);
  });

  test('renders the plan text directly once complete', () => {
    expect(getPlanSkeletonRevealState({
      planText: '# Plan\n\n1. Do work',
      streamPhase: 'completed',
    })).toEqual({
      hasPlanText: true,
      showInitialSkeleton: false,
      skeletonLineCount: 8,
    });
  });
});

describe('resolvePlanCardDisplayText', () => {
  test('uses throttled text while streaming so layout matches rendered markdown', () => {
    const rawPlanText = '# Plan\n\n' + 'Implementation detail. '.repeat(120);
    const throttledPlanText = '# Plan\n\n1. First visible task';

    expect(resolvePlanCardDisplayText({
      rawPlanText,
      throttledPlanText,
      isStreaming: true,
    })).toBe(throttledPlanText);
  });

  test('uses raw text once streaming has completed', () => {
    const rawPlanText = '# Plan\n\n' + 'Implementation detail. '.repeat(120);
    const throttledPlanText = '# Plan\n\n1. First visible task';

    expect(resolvePlanCardDisplayText({
      rawPlanText,
      throttledPlanText,
      isStreaming: false,
    })).toBe(rawPlanText);
  });
});

describe('getPlanSkeletonLineCount', () => {
  test('keeps at least eight skeleton rows for the initial collapsed card', () => {
    expect(getPlanSkeletonLineCount('')).toBe(8);
  });

  test('adds rows for long streamed plans instead of stopping at eight lines', () => {
    expect(getPlanSkeletonLineCount('Plan detail. '.repeat(80))).toBeGreaterThan(8);
  });
});

describe('getPlanCardCollapsedMaxHeight', () => {
  test('reserves eight lines plus vertical body padding', () => {
    expect(getPlanCardCollapsedMaxHeight({
      lineCount: PLAN_CARD_COLLAPSED_CONTENT_LINES,
      bodyVerticalPaddingPx: PLAN_CARD_BODY_VERTICAL_PADDING_PX,
    })).toBe(224);
  });
});

describe('getStableSkeletonLineCount', () => {
  test('grows monotonically as text streams in', () => {
    const short = getStableSkeletonLineCount('Plan detail. '.repeat(2), 0);
    const longer = getStableSkeletonLineCount('Plan detail. '.repeat(40), short);
    expect(longer === short || longer > short).toBe(true);
  });

  test('never shrinks below the previously observed maximum', () => {
    const peak = getStableSkeletonLineCount('Plan detail. '.repeat(80), 0);
    const shrunk = getStableSkeletonLineCount('', peak);
    expect(shrunk).toBe(peak);
  });
});

describe('getPlanCardImplementationKey', () => {
  test('uses the first plan block for the rendered assistant plan card', () => {
    expect(getPlanCardImplementationKey('session-a', 'msg_2_assistant')).toBe(
      'session-a:msg_2_assistant:plan:0',
    );
  });
});

describe('getPlanCardActionState', () => {
  test('allows only the latest completed unimplemented plan', () => {
    expect(getPlanCardActionState({
      streamPhase: 'completed',
      hasPlanText: true,
      isImplementationRequested: false,
      isLatestPlan: true,
    })).toEqual({
      canImplement: true,
      disabledReason: null,
    });
  });

  test('disables a superseded plan with an accessible reason', () => {
    expect(getPlanCardActionState({
      streamPhase: 'completed',
      hasPlanText: true,
      isImplementationRequested: false,
      isLatestPlan: false,
    })).toEqual({
      canImplement: false,
      disabledReason: 'Superseded by a newer plan.',
    });
  });

  test('keeps the latest plan disabled until its stream completes', () => {
    expect(getPlanCardActionState({
      streamPhase: 'streaming',
      hasPlanText: true,
      isImplementationRequested: false,
      isLatestPlan: true,
    }).canImplement).toBe(false);
  });

  test('disables an implemented plan with an accessible reason', () => {
    expect(getPlanCardActionState({
      streamPhase: 'completed',
      hasPlanText: true,
      isImplementationRequested: true,
      isLatestPlan: true,
    })).toEqual({
      canImplement: false,
      disabledReason: 'Implementation already started.',
    });
  });

  test('keeps the card disabled while a sibling assistant in the revision is still running', () => {
    expect(getPlanCardActionState({
      streamPhase: 'completed',
      hasPlanText: true,
      isImplementationRequested: false,
      isLatestPlan: true,
      isRevisionSettled: false,
    })).toEqual({
      canImplement: false,
      disabledReason: 'The response is still finishing.',
    });
  });
});

describe('getPlanCardDataState', () => {
  test('distinguishes implemented plans from pending and superseded plans', () => {
    expect(getPlanCardDataState({
      isSuperseded: false,
      isImplementationRequested: true,
      canImplement: false,
    })).toBe('implemented');
    expect(getPlanCardDataState({
      isSuperseded: true,
      isImplementationRequested: true,
      canImplement: false,
    })).toBe('superseded');
  });
});

describe('shouldPersistPlanCard', () => {
  test('persists only the latest completed plan with Markdown content', () => {
    expect(shouldPersistPlanCard({
      streamPhase: 'completed',
      hasPlanText: true,
      isLatestPlan: true,
    })).toBe(true);

    expect(shouldPersistPlanCard({
      streamPhase: 'streaming',
      hasPlanText: true,
      isLatestPlan: true,
    })).toBe(false);

    expect(shouldPersistPlanCard({
      streamPhase: 'completed',
      hasPlanText: true,
      isLatestPlan: false,
    })).toBe(false);
  });

  test('does not persist while the revision has an unsettled sibling assistant', () => {
    expect(shouldPersistPlanCard({
      streamPhase: 'completed',
      hasPlanText: true,
      isLatestPlan: true,
      isRevisionSettled: false,
    })).toBe(false);
  });
});
