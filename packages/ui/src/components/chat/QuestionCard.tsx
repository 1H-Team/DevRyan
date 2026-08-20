import React from 'react';
import { RiArrowLeftSLine, RiArrowRightSLine, RiCheckLine, RiEditLine, RiQuestionLine } from '@remixicon/react';

import { cn } from '@/lib/utils';
import { isIMECompositionEvent } from '@/lib/ime';
import type { QuestionRequest } from '@/types/question';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSession } from '@/sync/sync-context';
import * as sessionActions from '@/sync/session-actions';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/components/ui/toast';
import {
  buildQuestionRequestAnswerGroups,
  submitQuestionRequestAnswerGroups,
  type QuestionAnswerEntry,
  type QuestionRequestSubmitResult,
} from './questionCardRouting';
import {
  getIndexAfterOptionSelection,
  getNextQuestionIndex,
  getPreviousQuestionIndex,
  isQuestionAnswerComplete,
} from './questionCardNavigation';
import { deriveCustomModeFromText, getQuestionOptionPresentation } from './questionCardOptions';
import { QuestionOptionRow } from './QuestionOptionRow';
import {
  acknowledgeQuestionRequests,
  claimQuestionSubmissions,
  createQuestionSubmissionLock,
  createQuestionSubmissionShadow,
  filterPendingQuestionRequestAnswerGroups,
  filterPendingQuestionRequests,
  getQuestionEntryKey,
  getQuestionRequestKey,
  getQuestionSubmissionStatus,
  reconcileAcknowledgedQuestionRequestKeys,
  releaseQuestionSubmissions,
  settleOptimisticQuestionSubmissionResults,
  submitQuestionRequestRejections,
} from './questionCardSubmission';

interface QuestionCardProps {
  /**
   * One or more pending QuestionRequests for the same session. When multiple
   * requests arrive close together they are surfaced in a single card; on
   * submit each request still receives its own `question.reply` call so the
   * server can resolve them independently (a rejection on one does not
   * cancel the others).
   *
   * For back-compat the legacy `question` prop is still accepted.
   */
  requests?: QuestionRequest[];
  question?: QuestionRequest;
}

interface QuestionEntry {
  /** Stable identity across filtering and authoritative request updates. */
  entryKey: string;
  /** Stable flat index across all requests. */
  flatIndex: number;
  /** The source request this question came from. */
  request: QuestionRequest;
  /** Position within the source request's `questions[]` array. */
  withinRequestIndex: number;
  /** The question info itself (header, question, options, multiple). */
  question: QuestionRequest['questions'][number];
}

export const QuestionCard: React.FC<QuestionCardProps> = ({ requests, question }) => {
  const { t } = useI18n();
  const respondToQuestion = sessionActions.respondToQuestion;
  const rejectQuestion = sessionActions.rejectQuestion;
  const isMobile = useUIStore((state) => state.isMobile);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);

  // Normalize to an array. Legacy single-request callers still work.
  const normalizedRequests = React.useMemo<QuestionRequest[]>(() => {
    if (requests && requests.length > 0) return requests;
    if (question) return [question];
    return [];
  }, [requests, question]);

  const sessionID = normalizedRequests[0]?.sessionID;
  const sessionScopeKey = React.useMemo(
    () => JSON.stringify(Array.from(new Set(normalizedRequests.map((request) => request.sessionID))).sort()),
    [normalizedRequests],
  );
  const requestSetKey = React.useMemo(
    () => JSON.stringify(normalizedRequests.map(getQuestionRequestKey)),
    [normalizedRequests],
  );

  const [activeIndex, setActiveIndex] = React.useState(0);
  const [submissionPending, setSubmissionPending] = React.useState(false);
  const [selectedOptions, setSelectedOptions] = React.useState<Record<string, string[]>>({});
  const [customMode, setCustomMode] = React.useState<Record<string, boolean>>({});
  const [customText, setCustomText] = React.useState<Record<string, string>>({});
  const [acknowledgedRequestKeys, setAcknowledgedRequestKeys] = React.useState<Set<string>>(
    () => new Set(),
  );
  const [requestErrors, setRequestErrors] = React.useState<Record<string, string>>({});
  const initialSubmissionLock = React.useMemo(createQuestionSubmissionLock, []);
  const submissionLockRef = React.useRef(initialSubmissionLock);
  const initialSubmissionShadow = React.useMemo(createQuestionSubmissionShadow, []);
  const submissionShadowRef = React.useRef(initialSubmissionShadow);
  const previousSessionScopeRef = React.useRef(sessionScopeKey);
  const activeScopeRef = React.useRef(sessionScopeKey);
  activeScopeRef.current = sessionScopeKey;
  const isMountedRef = React.useRef(true);

  React.useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const currentRequestKeys = React.useMemo(
    () => new Set(normalizedRequests.map(getQuestionRequestKey)),
    [normalizedRequests],
  );
  const currentRequestKeysRef = React.useRef(currentRequestKeys);
  currentRequestKeysRef.current = currentRequestKeys;

  React.useEffect(() => {
    if (previousSessionScopeRef.current !== sessionScopeKey) {
      previousSessionScopeRef.current = sessionScopeKey;
      submissionLockRef.current = createQuestionSubmissionLock();
      submissionShadowRef.current = createQuestionSubmissionShadow();
      setActiveIndex(0);
      setSubmissionPending(false);
      setSelectedOptions({});
      setCustomMode({});
      setCustomText({});
      setAcknowledgedRequestKeys(new Set());
      setRequestErrors({});
      return;
    }

    setAcknowledgedRequestKeys((previous) => {
      const next = reconcileAcknowledgedQuestionRequestKeys(previous, normalizedRequests);
      if (next.size === previous.size && Array.from(next).every((key) => previous.has(key))) {
        return previous;
      }
      return next;
    });
  }, [normalizedRequests, requestSetKey, sessionScopeKey]);

  const pendingRequests = React.useMemo(
    () => filterPendingQuestionRequests(normalizedRequests, acknowledgedRequestKeys),
    [acknowledgedRequestKeys, normalizedRequests],
  );
  const submissionStatus = previousSessionScopeRef.current === sessionScopeKey
    ? getQuestionSubmissionStatus(submissionShadowRef.current)
    : null;
  const isSubmitting = submissionPending && Boolean(submissionStatus);

  const sourceSession = useSession(sessionID);
  const isFromSubagent = Boolean(
    currentSessionId
    && sessionID
    && sessionID !== currentSessionId
    && sourceSession?.parentID === currentSessionId,
  );

  // Flatten unresolved questions while preserving stable request-scoped answer keys.
  const entries = React.useMemo<QuestionEntry[]>(() => {
    const acc: QuestionEntry[] = [];
    let flatIndex = 0;
    for (const req of pendingRequests) {
      const list = req.questions ?? [];
      for (let i = 0; i < list.length; i += 1) {
        acc.push({
          entryKey: getQuestionEntryKey(req, i),
          flatIndex,
          request: req,
          withinRequestIndex: i,
          question: list[i],
        });
        flatIndex += 1;
      }
    }
    return acc;
  }, [pendingRequests]);

  const totalCount = entries.length;

  React.useEffect(() => {
    setActiveIndex((current) => Math.min(current, Math.max(0, totalCount - 1)));
  }, [totalCount]);

  const boundedActiveIndex = Math.min(activeIndex, Math.max(0, totalCount - 1));
  const activeEntry = entries[boundedActiveIndex] ?? null;
  const isLastQuestion = boundedActiveIndex >= totalCount - 1;
  const progressLabel = totalCount > 1
    ? t('chat.questionCard.progress', { current: boundedActiveIndex + 1, total: totalCount })
    : null;

  const isEntryAnswered = React.useCallback(
    (entryKey: string): boolean => isQuestionAnswerComplete({
      isCustom: Boolean(customMode[entryKey]),
      customText: customText[entryKey],
      selectedOptions: selectedOptions[entryKey] ?? [],
    }),
    [customMode, customText, selectedOptions],
  );

  const unansweredEntryKeys = React.useMemo(() => {
    const pending: string[] = [];
    for (const entry of entries) {
      if (!isEntryAnswered(entry.entryKey)) pending.push(entry.entryKey);
    }
    return pending;
  }, [entries, isEntryAnswered]);

  const requiredSatisfied = totalCount > 0 && unansweredEntryKeys.length === 0;
  const activeAnswerComplete = activeEntry ? isEntryAnswered(activeEntry.entryKey) : false;

  const handleBack = React.useCallback(() => {
    setActiveIndex((current) => getPreviousQuestionIndex(current));
  }, []);

  const handleNext = React.useCallback(() => {
    if (!activeAnswerComplete) return;
    setActiveIndex((current) => getNextQuestionIndex(current, totalCount));
  }, [activeAnswerComplete, totalCount]);

  const buildAnswerForEntry = React.useCallback(
    (entryKey: string): string[] => {
      const isCustom = Boolean(customMode[entryKey]);
      if (isCustom) {
        const value = (customText[entryKey] ?? '').trim();
        return value ? [value] : [];
      }
      return selectedOptions[entryKey] ?? [];
    },
    [customMode, customText, selectedOptions],
  );

  const customInputRef = React.useRef<HTMLInputElement | null>(null);

  const handleToggleOption = React.useCallback(
    (entry: QuestionEntry, label: string) => {
      setCustomMode((prev) => ({ ...prev, [entry.entryKey]: false }));
      // Picking an option clears the custom pill so the visible state always
      // matches the answer that will be submitted.
      setCustomText((prev) => (prev[entry.entryKey] ? { ...prev, [entry.entryKey]: '' } : prev));
      setSelectedOptions((prev) => {
        const current = prev[entry.entryKey] ?? [];
        if (entry.question.multiple) {
          const exists = current.includes(label);
          const next = exists ? current.filter((item) => item !== label) : [...current, label];
          return { ...prev, [entry.entryKey]: next };
        }
        return { ...prev, [entry.entryKey]: [label] };
      });

      const nextIndex = getIndexAfterOptionSelection({
        currentIndex: entry.flatIndex,
        totalCount,
        multiple: Boolean(entry.question.multiple),
      });
      if (nextIndex !== entry.flatIndex) setActiveIndex(nextIndex);

      // Return focus to the answer pill so a follow-up Enter submits instead
      // of re-activating the clicked option button (which would toggle
      // multi-select answers off). Skipped on mobile: focusing the input
      // would pop the on-screen keyboard.
      if (!isMobile) {
        requestAnimationFrame(() => customInputRef.current?.focus());
      }
    },
    [isMobile, totalCount],
  );

  const handleCustomTextChange = React.useCallback((entry: QuestionEntry, value: string) => {
    setCustomText((prev) => ({ ...prev, [entry.entryKey]: value }));
    const isCustom = deriveCustomModeFromText(value);
    setCustomMode((prev) => (Boolean(prev[entry.entryKey]) === isCustom ? prev : { ...prev, [entry.entryKey]: isCustom }));
  }, []);

  const settleRelevantSubmissionResults = React.useCallback((
    submissionScope: string,
    results: readonly QuestionRequestSubmitResult[],
    fallbackError: string,
  ) => {
    if (!isMountedRef.current || activeScopeRef.current !== submissionScope) {
      // The card is gone (unmount or scope change) — failures must not be silent.
      for (const result of results) {
        if (result.status !== 'rejected') continue;
        toast.error(t('chat.questionCard.submitFailedToast'), {
          description: result.reason instanceof Error ? result.reason.message : fallbackError,
        });
      }
      return;
    }

    const relevantResults = results.filter((result) => (
      currentRequestKeysRef.current.has(getQuestionRequestKey(result.request))
    ));
    const outcome = settleOptimisticQuestionSubmissionResults(new Set(), relevantResults, fallbackError);

    setAcknowledgedRequestKeys((previous) => {
      const next = settleOptimisticQuestionSubmissionResults(previous, relevantResults, fallbackError)
        .acknowledgedRequestKeys;
      if (next.size === previous.size && Array.from(next).every((key) => previous.has(key))) {
        return previous;
      }
      return next;
    });
    setRequestErrors(outcome.errorsByRequestKey);
  }, [t]);

  const handleConfirm = React.useCallback(async () => {
    const submissionLock = submissionLockRef.current;
    if (!requiredSatisfied || !submissionLock.tryAcquire()) return;

    const submissionScope = sessionScopeKey;
    const answerGroups = filterPendingQuestionRequestAnswerGroups(
      buildQuestionRequestAnswerGroups(
        entries.map((entry): QuestionAnswerEntry => ({
          request: entry.request,
          withinRequestIndex: entry.withinRequestIndex,
          answers: buildAnswerForEntry(entry.entryKey),
        })),
      ),
      acknowledgedRequestKeys,
    );
    const submissionShadow = submissionShadowRef.current;
    const claimed = claimQuestionSubmissions(
      submissionShadow,
      answerGroups.map((group) => ({
        action: 'answer',
        request: group.request,
        answers: group.answers.map((answer) => [...answer]),
      })),
    );
    if (!claimed) {
      submissionLock.release();
      return;
    }

    setSubmissionPending(true);
    setRequestErrors({});
    // Optimistic: hide the submitted requests immediately — the POST settles in
    // the background and failures restore the card (or toast if it is gone).
    setAcknowledgedRequestKeys((previous) => (
      acknowledgeQuestionRequests(previous, answerGroups.map((group) => group.request))
    ));

    try {
      const results = await submitQuestionRequestAnswerGroups(answerGroups, respondToQuestion);
      settleRelevantSubmissionResults(submissionScope, results, 'Failed to submit answer');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to submit answer';
      if (isMountedRef.current && activeScopeRef.current === submissionScope) {
        const claimedKeys = new Set(answerGroups.map((group) => getQuestionRequestKey(group.request)));
        setAcknowledgedRequestKeys((previous) => (
          new Set(Array.from(previous).filter((key) => !claimedKeys.has(key)))
        ));
        if (answerGroups[0]) {
          setRequestErrors({ [getQuestionRequestKey(answerGroups[0].request)]: message });
        }
      } else {
        toast.error(t('chat.questionCard.submitFailedToast'), { description: message });
      }
    } finally {
      releaseQuestionSubmissions(submissionShadow, answerGroups.map((group) => group.request));
      submissionLock.release();
      if (activeScopeRef.current === submissionScope) setSubmissionPending(false);
    }
  }, [
    acknowledgedRequestKeys,
    settleRelevantSubmissionResults,
    t,
    buildAnswerForEntry,
    entries,
    requiredSatisfied,
    respondToQuestion,
    sessionScopeKey,
  ]);

  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
      if (isIMECompositionEvent(e)) return;
      if (e.key === 'Enter' && !e.shiftKey && (!isMobile || e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (isLastQuestion && requiredSatisfied) {
          handleConfirm();
        } else if (!isLastQuestion) {
          handleNext();
        }
      }
    },
    [handleConfirm, handleNext, isLastQuestion, isMobile, requiredSatisfied],
  );

  const handleSkip = React.useCallback(async () => {
    const submissionLock = submissionLockRef.current;
    if (!submissionLock.tryAcquire()) return;

    const submissionScope = sessionScopeKey;
    const targetRequests = pendingRequests;
    const submissionShadow = submissionShadowRef.current;
    const claimed = claimQuestionSubmissions(
      submissionShadow,
      targetRequests.map((request) => ({ action: 'skip', request, answers: null })),
    );
    if (!claimed) {
      submissionLock.release();
      return;
    }

    setSubmissionPending(true);
    setRequestErrors({});
    setAcknowledgedRequestKeys((previous) => (
      acknowledgeQuestionRequests(previous, targetRequests)
    ));

    try {
      const results = await submitQuestionRequestRejections(targetRequests, rejectQuestion);
      settleRelevantSubmissionResults(submissionScope, results, 'Failed to skip question');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to skip question';
      if (isMountedRef.current && activeScopeRef.current === submissionScope) {
        const claimedKeys = new Set(targetRequests.map((request) => getQuestionRequestKey(request)));
        setAcknowledgedRequestKeys((previous) => (
          new Set(Array.from(previous).filter((key) => !claimedKeys.has(key)))
        ));
        if (targetRequests[0]) {
          setRequestErrors({ [getQuestionRequestKey(targetRequests[0])]: message });
        }
      } else {
        toast.error(t('chat.questionCard.submitFailedToast'), { description: message });
      }
    } finally {
      releaseQuestionSubmissions(submissionShadow, targetRequests);
      submissionLock.release();
      if (activeScopeRef.current === submissionScope) setSubmissionPending(false);
    }
  }, [settleRelevantSubmissionResults, t, pendingRequests, rejectQuestion, sessionScopeKey]);

  if (totalCount === 0) {
    if (normalizedRequests.length === 0 || acknowledgedRequestKeys.size === 0) {
      return null;
    }

    return (
      <div
        className="flex min-h-[54px] items-center gap-2 px-3 py-2 text-muted-foreground"
        role="status"
        aria-live="polite"
      >
        <RiQuestionLine aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span className="typography-meta">{t('chat.questionCard.sendingResponse')}</span>
      </div>
    );
  }

  const footerError = Array.from(new Set(Object.values(requestErrors).filter(Boolean))).join(' ');
  const primaryDisabled = isSubmitting || (isLastQuestion ? !requiredSatisfied : !activeAnswerComplete);
  const handlePrimaryAction = isLastQuestion ? handleConfirm : handleNext;

  const renderQuestionBody = (entry: QuestionEntry, opts: { withHeader: boolean }) => {
    const selected = selectedOptions[entry.entryKey] ?? [];
    return (
      <div key={entry.entryKey}>
        {opts.withHeader && entry.question.header?.trim() ? (
          <div className="typography-micro font-medium text-muted-foreground mb-0.5">
            {entry.question.header}
          </div>
        ) : null}
        <div className="typography-ui-label font-medium text-foreground mb-2">{entry.question.question}</div>
        {entry.question.multiple ? (
          <div className="typography-micro text-muted-foreground mb-1.5">{t('chat.questionCard.selectMultiple')}</div>
        ) : null}

        <div
          className="space-y-0.5"
          role={entry.question.multiple ? 'group' : 'radiogroup'}
          aria-label={entry.question.question}
        >
          {entry.question.options.map((option, index) => {
            const isSelected = selected.includes(option.label);
            const { displayLabel, recommended } = getQuestionOptionPresentation(option.label);
            return (
              <QuestionOptionRow
                key={`${index}:${option.label}`}
                label={displayLabel}
                description={option.description}
                selected={isSelected}
                multiple={Boolean(entry.question.multiple)}
                disabled={isSubmitting}
                recommended={recommended}
                recommendedLabel={t('chat.questionCard.recommended')}
                onSelect={() => handleToggleOption(entry, option.label)}
              />
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col px-3 pt-2.5 pb-2.5" role="group" aria-label={t('chat.questionCard.inputNeeded')}>
      {/* Meta row */}
      <div className="flex items-center gap-2 pb-1.5">
        <RiQuestionLine className="h-3.5 w-3.5 text-primary" />
        <span className="typography-micro font-medium text-muted-foreground">{t('chat.questionCard.inputNeeded')}</span>
        {isFromSubagent ? (
          <span className="typography-micro text-muted-foreground px-1.5 py-0.5 rounded bg-foreground/5">
            {t('chat.questionCard.fromSubagent')}
          </span>
        ) : null}
        {progressLabel ? (
          <span className="ml-auto typography-micro font-medium text-foreground/70 px-1.5 py-0.5 rounded bg-muted/30 border border-border/20">
            {progressLabel}
          </span>
        ) : null}
      </div>

      {activeEntry ? renderQuestionBody(activeEntry, { withHeader: totalCount > 1 }) : null}

      {footerError ? (
        <div className="pt-1 typography-micro text-[var(--status-error)]" role="alert">
          {footerError}
        </div>
      ) : null}

      {/* Custom answer pill with the actions inside it */}
      {activeEntry ? (
        <div className="pt-2">
          <div
            className={cn(
              'flex min-w-0 items-center gap-1.5 rounded-full border border-border/50 py-1 pl-3 pr-1.5 transition-colors',
              'focus-within:border-primary/60',
              isSubmitting ? 'opacity-60' : null,
            )}
          >
            <RiEditLine aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
            <input
              ref={customInputRef}
              type="text"
              value={customText[activeEntry.entryKey] ?? ''}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) => (
                handleCustomTextChange(activeEntry, event.target.value)
              )}
              onKeyDown={handleKeyDown}
              placeholder={t('chat.questionCard.customPlaceholder')}
              disabled={isSubmitting}
              autoFocus={!isMobile}
              className="min-w-0 flex-1 border-0 bg-transparent outline-none typography-meta text-foreground placeholder:text-muted-foreground/60 disabled:cursor-not-allowed"
            />

            {boundedActiveIndex > 0 ? (
              <button
                type="button"
                onClick={handleBack}
                disabled={isSubmitting}
                className={cn(
                  'flex shrink-0 items-center gap-1 px-2 py-0.5 typography-meta font-medium rounded-full transition-colors',
                  'text-muted-foreground hover:text-foreground hover:bg-interactive-hover/20',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                )}
              >
                <RiArrowLeftSLine className="h-3 w-3" />
                {t('chat.questionCard.back')}
              </button>
            ) : null}

            <button
              type="button"
              onClick={handlePrimaryAction}
              disabled={primaryDisabled}
              className={cn(
                'flex shrink-0 items-center gap-1 px-2 py-0.5 typography-meta font-medium rounded-full transition-colors',
                'text-[var(--status-success)] hover:bg-[rgb(var(--status-success)/0.1)]',
                'disabled:opacity-50 disabled:cursor-not-allowed',
              )}
            >
              {isLastQuestion ? <RiCheckLine className="h-3 w-3" /> : <RiArrowRightSLine className="h-3 w-3" />}
              {isLastQuestion ? t('chat.questionCard.submit') : t('chat.questionCard.next')}
            </button>

            <button
              type="button"
              onClick={handleSkip}
              disabled={isSubmitting}
              className={cn(
                'flex shrink-0 items-center gap-1 px-2 py-0.5 typography-meta font-medium rounded-full transition-colors',
                'text-muted-foreground hover:text-foreground hover:bg-interactive-hover/20',
                'disabled:opacity-50 disabled:cursor-not-allowed',
              )}
            >
              {t('chat.questionCard.skip')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
};
