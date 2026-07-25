import React from 'react';
import { RiDraftLine, RiArrowDownSLine } from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { MarkdownRenderer } from '../../MarkdownRenderer';
import { extractPlanTitle } from '@/lib/messages/extractPlanTitle';
import { renderMagicPrompt } from '@/lib/magicPrompts';
import {
  type PlanSendAction,
  buildPlanImplementationSyntheticParts,
  buildPlanSendPromptVariables,
  getPlanSendInstructionsPromptId,
  getPlanSendPlanMode,
  getPlanSendVisiblePromptId,
} from '@/components/views/planSend';
import { useSelectionStore } from '@/sync/selection-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import {
  CHAT_PRESERVE_SCROLL_ANCHOR_EVENT,
  requestChatScrollToBottom,
  type ChatPreserveScrollAnchorEventDetail,
} from '@/hooks/useChatAutoFollow';

import type { StreamPhase } from '../types';
import { useStreamingTextThrottle } from '../../hooks/useStreamingTextThrottle';
import PlanCardSkeleton from './PlanCardSkeleton';
import { usePlanTurnTraceEntry } from '../../usePlanTurnTraceEntry';
import {
  PLAN_CARD_COLLAPSED_MAX_HEIGHT_PX,
  getPlanCardImplementationKey,
  getPlanCardActionState,
  getPlanCardDataState,
  getPlanSkeletonRevealState,
  getStableSkeletonLineCount,
  resolvePlanCardDisplayText,
  shouldPersistPlanCard,
} from './planCardReveal';
import { persistSessionPlanRevision } from '@/lib/plans/sessionPlanPersistence';
import { useSessionPlanFileStore } from '@/stores/useSessionPlanFileStore';

const COLLAPSED_MAX_HEIGHT = PLAN_CARD_COLLAPSED_MAX_HEIGHT_PX;
const EXPAND_AFFORDANCE_THRESHOLD_PX = 8;
const BODY_TRANSITION_MS = 420;
const ANCHOR_TAIL_MS = 80;
const ANCHOR_PRESERVE_BUFFER_MS = 120;
const CHAT_SCROLL_CONTAINER_SELECTOR = '[data-scrollbar="chat"]';

interface PlanCardProps {
  sessionId: string;
  sourceMessageId: string;
  streamPhase: StreamPhase;
  planText: string;
  projectPath: string | null;
  sessionCreated: number | null;
  sessionSlug: string | null;
}

const PlanCard: React.FC<PlanCardProps> = ({
  sessionId,
  sourceMessageId,
  streamPhase,
  planText,
  projectPath,
  sessionCreated,
  sessionSlug,
}) => {
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [isExpanded, setIsExpanded] = React.useState(false);
  const [contentHeight, setContentHeight] = React.useState(0);

  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const cardRef = React.useRef<HTMLDivElement | null>(null);
  const measureRafRef = React.useRef<number | null>(null);
  const anchorRafRef = React.useRef<number | null>(null);
  const stableLineCountRef = React.useRef(0);

  const isStreaming = streamPhase === 'streaming' || streamPhase === 'cooldown';
  const throttledPlanText = useStreamingTextThrottle({
    text: planText,
    isStreaming,
    identityKey: `${sourceMessageId}:plan-card`,
  });
  const displayPlanText = resolvePlanCardDisplayText({
    rawPlanText: planText,
    throttledPlanText,
    isStreaming,
  });

  const reveal = React.useMemo(
    () => getPlanSkeletonRevealState({ planText: displayPlanText, streamPhase }),
    [displayPlanText, streamPhase],
  );

  // Lock skeleton line count to the running max so it never shrinks mid-stream.
  stableLineCountRef.current = getStableSkeletonLineCount(displayPlanText, stableLineCountRef.current);
  const skeletonLineCount = Math.max(reveal.skeletonLineCount, stableLineCountRef.current);

  const implementationKey = React.useMemo(
    () => getPlanCardImplementationKey(sessionId, sourceMessageId),
    [sessionId, sourceMessageId],
  );
  const isImplementationRequested = useSessionUIStore(
    (state) => (
      state.implementedPlanRequests.has(implementationKey)
      || state.externallyHandedOffPlanRequests.has(implementationKey)
    ),
  );
  const traceEntry = usePlanTurnTraceEntry(sourceMessageId);
  const isLatestPlan = traceEntry?.isLatestPlan === true;
  const planFileRecord = useSessionPlanFileStore((state) => state.recordsBySession[sessionId]);
  const currentPlanFileRecord = planFileRecord?.sourceMessageId === sourceMessageId
    ? planFileRecord
    : undefined;
  const actionState = getPlanCardActionState({
    streamPhase,
    hasPlanText: planText.trim().length > 0,
    isImplementationRequested,
    isLatestPlan: traceEntry?.isLatestPlan ?? true,
  });
  const shouldPersist = shouldPersistPlanCard({
    streamPhase,
    hasPlanText: planText.trim().length > 0,
    isLatestPlan,
  });
  const isPlanFileReady = currentPlanFileRecord?.status === 'saved' && Boolean(currentPlanFileRecord.path);
  const canImplement = actionState.canImplement && isPlanFileReady;
  const planFileDisabledReason = actionState.canImplement && !isPlanFileReady
    ? currentPlanFileRecord?.status === 'error'
      ? 'Save the plan file before implementing.'
      : 'The plan file must finish saving before implementation.'
    : null;
  const implementDisabledReason = actionState.disabledReason ?? planFileDisabledReason;
  const disabledReasonId = implementDisabledReason
    ? `${sourceMessageId}-plan-action-disabled-reason`
    : undefined;

  const persistPlan = React.useCallback(async (retry = false) => {
    await persistSessionPlanRevision({
      sessionId,
      identity: {
        projectPath: projectPath ?? '',
        sessionCreated: sessionCreated ?? 0,
        sessionSlug: sessionSlug ?? '',
        sourceMessageId,
      },
      markdown: planText,
    }, { retry });
  }, [planText, projectPath, sessionCreated, sessionId, sessionSlug, sourceMessageId]);

  React.useEffect(() => {
    if (!shouldPersist || currentPlanFileRecord) return;
    void persistPlan();
  }, [currentPlanFileRecord, persistPlan, shouldPersist]);

  // Measure the content so the collapsed→expanded max-height transition has a
  // concrete target. Re-measure as the plan streams in or the skeleton grows.
  // rAF-batched + 1px threshold so sub-pixel ResizeObserver chatter mid-stream
  // doesn't restart the max-height transition.
  React.useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const measure = () => {
      measureRafRef.current = null;
      const target = contentRef.current;
      if (!target) return;
      const next = target.scrollHeight;
      setContentHeight((prev) => (Math.abs(prev - next) <= 1 ? prev : next));
    };
    const schedule = () => {
      if (measureRafRef.current !== null) return;
      measureRafRef.current = window.requestAnimationFrame(measure);
    };
    schedule();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(schedule);
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (measureRafRef.current !== null) {
        window.cancelAnimationFrame(measureRafRef.current);
        measureRafRef.current = null;
      }
    };
  }, [reveal.showInitialSkeleton, skeletonLineCount, displayPlanText, streamPhase]);

  const canCollapse = contentHeight > COLLAPSED_MAX_HEIGHT + EXPAND_AFFORDANCE_THRESHOLD_PX;
  const showExpandButton = canCollapse;
  const effectiveMaxHeight = !canCollapse
    ? undefined
    : isExpanded
      ? contentHeight
      : COLLAPSED_MAX_HEIGHT;

  const handleToggleExpanded = React.useCallback(() => {
    const card = cardRef.current;
    const scrollContainer = card?.closest<HTMLElement>(CHAT_SCROLL_CONTAINER_SELECTOR) ?? null;

    if (!card || !scrollContainer) {
      setIsExpanded((prev) => !prev);
      return;
    }

    // Anchor the card's top edge to its current viewport position throughout
    // the max-height transition. Without this, expanding pushes content below
    // down; if the chat is auto-following the bottom the user sees a downward
    // yank, and if they're scrolled up the card grows out of view.
    const containerRect = scrollContainer.getBoundingClientRect();
    const offsetWithinContainer = card.getBoundingClientRect().top - containerRect.top;
    const startedAt = performance.now();

    if (anchorRafRef.current !== null) {
      window.cancelAnimationFrame(anchorRafRef.current);
    }

    scrollContainer.dispatchEvent(new CustomEvent<ChatPreserveScrollAnchorEventDetail>(
      CHAT_PRESERVE_SCROLL_ANCHOR_EVENT,
      {
        bubbles: true,
        detail: {
          durationMs: BODY_TRANSITION_MS + ANCHOR_TAIL_MS + ANCHOR_PRESERVE_BUFFER_MS,
        },
      },
    ));

    const tick = () => {
      anchorRafRef.current = null;
      const cardNow = cardRef.current;
      if (!cardNow || !scrollContainer.isConnected) return;
      const elapsed = performance.now() - startedAt;
      const nowOffset = cardNow.getBoundingClientRect().top - scrollContainer.getBoundingClientRect().top;
      const delta = nowOffset - offsetWithinContainer;
      if (Math.abs(delta) > 0.5) {
        scrollContainer.scrollTop += delta;
      }
      if (elapsed < BODY_TRANSITION_MS + ANCHOR_TAIL_MS) {
        anchorRafRef.current = window.requestAnimationFrame(tick);
      }
    };

    setIsExpanded((prev) => !prev);
    anchorRafRef.current = window.requestAnimationFrame(tick);
  }, []);

  React.useEffect(() => {
    return () => {
      if (anchorRafRef.current !== null) {
        window.cancelAnimationFrame(anchorRafRef.current);
        anchorRafRef.current = null;
      }
    };
  }, []);

  const handleImplement = React.useCallback(async () => {
    const planPath = currentPlanFileRecord?.status === 'saved' ? currentPlanFileRecord.path : null;
    if (isSubmitting || !actionState.canImplement || !planPath) return;
    setIsSubmitting(true);
    requestChatScrollToBottom(sessionId);
    let implementationMessageId: string | undefined;

    try {
      const title = extractPlanTitle(planText);
      const action: PlanSendAction = 'implement';

      const visible = await renderMagicPrompt(getPlanSendVisiblePromptId(action), {
        plan_title: title,
      });
      const instructions = await renderMagicPrompt(
        getPlanSendInstructionsPromptId(action),
        buildPlanSendPromptVariables({ action, title, path: planPath }),
      );
      const syntheticParts = buildPlanImplementationSyntheticParts({
        sourceSessionId: sessionId,
        sourceMessageId,
        instructions,
      });

      const selection = useSelectionStore.getState();
      const agent = selection.getSessionAgentSelection(sessionId) ?? undefined;
      const agentModel =
        agent != null
          ? selection.getAgentModelForSession(sessionId, agent)
          : null;
      const modelSel = agentModel ?? selection.getSessionModelSelection(sessionId);
      if (!modelSel?.providerId || !modelSel?.modelId) {
        setIsSubmitting(false);
        return;
      }
      useSelectionStore.getState().setPlanModeSelection(sessionId, false);
      useSessionUIStore.getState().markPlanImplementationRequested(implementationKey);
      useSessionUIStore.getState().markPlanImplementing(sessionId, sourceMessageId);
      const variant =
        agent != null
          ? selection.getAgentModelVariantForSession(
              sessionId,
              agent,
              modelSel.providerId,
              modelSel.modelId,
            )
          : undefined;

      await useSessionUIStore.getState().sendMessageToSession(
        sessionId,
        visible,
        modelSel.providerId,
        modelSel.modelId,
        agent,
        undefined,
        undefined,
        syntheticParts,
        variant,
        undefined,
        getPlanSendPlanMode(action),
        {
          onMessageID: (messageID) => {
            implementationMessageId = messageID;
            useSessionUIStore.getState().markPlanImplementing(sessionId, sourceMessageId, messageID);
          },
          onMessageRollback: (messageID) => {
            useSessionUIStore.getState().rollbackPlanImplementation(
              sessionId,
              sourceMessageId,
              implementationKey,
              messageID,
            );
          },
        },
      );
    } catch {
      useSessionUIStore.getState().rollbackPlanImplementation(
        sessionId,
        sourceMessageId,
        implementationKey,
        implementationMessageId,
      );
      setIsSubmitting(false);
    }
  }, [actionState.canImplement, currentPlanFileRecord?.path, currentPlanFileRecord?.status, implementationKey, isSubmitting, planText, sessionId, sourceMessageId]);

  // The text container's minHeight only matters during the initial skeleton
  // phase, to prevent a height pop the instant the skeleton swaps for the
  // first tokens. Once any plan text exists the rendered children carry the
  // height — keeping the reservation past that point creates dead space at
  // the bottom of the expanded body.
  const textMinHeight = !reveal.hasPlanText ? COLLAPSED_MAX_HEIGHT - 32 : undefined;

  return (
    <div
      ref={cardRef}
      className="overflow-hidden rounded-xl border border-border bg-card"
      data-plan-source-message-id={sourceMessageId}
      data-plan-turn-id={traceEntry?.turnId}
      data-plan-version={traceEntry?.planVersion}
      data-plan-state={getPlanCardDataState({
        isSuperseded: traceEntry?.isSuperseded === true,
        isImplementationRequested,
        canImplement,
      })}
    >
      <div className="flex items-center gap-2 border-b border-border/60 px-5 py-3">
        <RiDraftLine className="size-4 text-muted-foreground" />
        <span className="typography-ui-label text-muted-foreground">Implementation Plan</span>
      </div>
      <div className="relative">
        <div
          className="oc-plan-card-body"
          style={effectiveMaxHeight !== undefined ? { maxHeight: effectiveMaxHeight } : undefined}
          aria-expanded={canCollapse ? isExpanded : undefined}
        >
          <div ref={contentRef} className="px-5 py-4">
            {reveal.showInitialSkeleton ? (
              <PlanCardSkeleton
                lineCount={skeletonLineCount}
                minHeight={COLLAPSED_MAX_HEIGHT - 32}
              />
            ) : (
              <div
                className="oc-plan-card-text relative z-0"
                data-streaming={isStreaming ? 'true' : undefined}
                style={textMinHeight !== undefined ? { minHeight: textMinHeight } : undefined}
              >
                <MarkdownRenderer
                  content={displayPlanText}
                  messageId={`${sourceMessageId}-plan-card`}
                  isAnimated={false}
                  isStreaming={isStreaming}
                  variant="assistant"
                  enableFileReferences={!isStreaming}
                />
              </div>
            )}
          </div>
          {canCollapse ? (
            <div
              className="oc-plan-card-body-fade-mask"
              data-state={isExpanded ? 'hidden' : 'visible'}
              aria-hidden="true"
            />
          ) : null}
        </div>
        {showExpandButton ? (
          <button
            type="button"
            className="oc-plan-expand-button"
            data-expanded={isExpanded ? 'true' : 'false'}
            aria-expanded={isExpanded}
            aria-label={isExpanded ? 'Collapse Plan' : 'Expand Plan'}
            onClick={handleToggleExpanded}
          >
            <RiArrowDownSLine className="oc-plan-expand-button-icon size-4" />
          </button>
        ) : null}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-border/60 px-5 py-3">
        <div className="flex min-w-0 items-center gap-2 typography-ui-meta text-muted-foreground">
          {currentPlanFileRecord?.status === 'saving' ? <span>Saving plan…</span> : null}
          {currentPlanFileRecord?.status === 'error' ? (
            <>
              <span title={currentPlanFileRecord.error ?? undefined}>Couldn’t save plan.</span>
              <button
                type="button"
                className="text-foreground underline-offset-2 hover:underline"
                onClick={() => { void persistPlan(true); }}
              >
                Retry
              </button>
            </>
          ) : null}
          {implementDisabledReason ? (
            <span id={disabledReasonId} className="sr-only">
              {implementDisabledReason}
            </span>
          ) : null}
        </div>
        <Button
          variant="default"
          size="sm"
          className="oc-plan-implement-btn normal-case"
          disabled={isSubmitting || !canImplement}
          aria-describedby={disabledReasonId}
          title={implementDisabledReason ?? undefined}
          onClick={handleImplement}
        >
          Implement Plan
        </Button>
      </div>
    </div>
  );
};

export default PlanCard;
