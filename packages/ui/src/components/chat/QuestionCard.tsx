import React from 'react';
import { RiArrowLeftSLine, RiArrowRightSLine, RiCheckLine, RiCloseLine, RiEditLine, RiQuestionLine } from '@remixicon/react';

import { cn } from '@/lib/utils';
import { isIMECompositionEvent } from '@/lib/ime';
import type { QuestionRequest } from '@/types/question';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessions } from '@/sync/sync-context';
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
import { getQuestionOptionPresentation } from './questionCardOptions';
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
  const sessions = useSessions();
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

  const isFromSubagent = React.useMemo(() => {
    if (!currentSessionId || !sessionID || sessionID === currentSessionId) return false;
    const sourceSession = sessions.find((session) => session.id === sessionID);
    return Boolean(sourceSession?.parentID && sourceSession.parentID === currentSessionId);
  }, [sessionID, currentSessionId, sessions]);

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

  const handleToggleOption = React.useCallback(
    (entry: QuestionEntry, label: string) => {
      setCustomMode((prev) => ({ ...prev, [entry.entryKey]: false }));
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
    },
    [totalCount],
  );

  const handleSelectCustom = React.useCallback((entry: QuestionEntry) => {
    setCustomMode((prev) => ({ ...prev, [entry.entryKey]: true }));
    setSelectedOptions((prev) => ({ ...prev, [entry.entryKey]: [] }));
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
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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

  if (totalCount === 0) return null;

  const footerError = Array.from(new Set(Object.values(requestErrors).filter(Boolean))).join(' ');
  const primaryDisabled = isSubmitting || (isLastQuestion ? !requiredSatisfied : !activeAnswerComplete);
  const handlePrimaryAction = isLastQuestion ? handleConfirm : handleNext;

  const renderQuestionBody = (entry: QuestionEntry, opts: { withHeader: boolean }) => {
    const selected = selectedOptions[entry.entryKey] ?? [];
    const isCustomActive = Boolean(customMode[entry.entryKey]);
    return (
      <div key={entry.entryKey}>
        {opts.withHeader && entry.question.header?.trim() ? (
          <div className="typography-micro font-medium text-muted-foreground mb-1">
            {entry.question.header}
          </div>
        ) : null}
        <div className="typography-meta font-medium text-foreground mb-1.5">{entry.question.question}</div>
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

          <button
            type="button"
            role={entry.question.multiple ? 'checkbox' : 'radio'}
            aria-checked={isCustomActive}
            onClick={() => handleSelectCustom(entry)}
            disabled={isSubmitting}
            className={cn(
              'w-full px-1.5 py-1 text-left rounded transition-colors',
              'hover:bg-interactive-hover/30',
              isCustomActive ? 'bg-interactive-selection/20' : null,
              isSubmitting ? 'opacity-60 cursor-not-allowed' : null,
            )}
          >
            <div className="flex items-center gap-2">
              <RiEditLine
                aria-hidden="true"
                className={cn('h-3.5 w-3.5', isCustomActive ? 'text-primary' : 'text-muted-foreground/50')}
              />
              <span
                className={cn(
                  'typography-meta',
                  isCustomActive ? 'text-foreground font-medium' : 'text-muted-foreground',
                )}
              >
                {t('chat.questionCard.other')}
              </span>
            </div>
          </button>

          {isCustomActive ? (
            <div className="pl-6 pr-1 pt-0.5">
              <textarea
                ref={(el) => {
                  if (el) {
                    el.style.height = 'auto';
                    const lineHeight = 20;
                    const minHeight = lineHeight * 2;
                    const maxHeight = lineHeight * 4;
                    el.style.height = `${Math.min(Math.max(el.scrollHeight, minHeight), maxHeight)}px`;
                  }
                }}
                value={customText[entry.entryKey] ?? ''}
                onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => {
                  const el = event.target;
                  el.style.height = 'auto';
                  const lineHeight = 20;
                  const minHeight = lineHeight * 2;
                  const maxHeight = lineHeight * 4;
                  el.style.height = `${Math.min(Math.max(el.scrollHeight, minHeight), maxHeight)}px`;
                  setCustomText((prev) => ({ ...prev, [entry.entryKey]: el.value }));
                }}
                placeholder={t('chat.questionCard.yourAnswer')}
                disabled={isSubmitting}
                rows={2}
                onKeyDown={handleKeyDown}
                data-scrollable
                className="w-full bg-transparent border border-border/30 focus:border-primary rounded px-2 py-1 outline-none typography-meta text-foreground placeholder:text-muted-foreground/50 transition-colors resize-none overflow-y-auto overflow-x-hidden"
                autoFocus
              />
            </div>
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <div className="group w-full pt-0 pb-2">
      <div className="chat-column">
        <div className="-mt-1 border border-border/30 rounded-xl bg-muted/10">
          {/* Header */}
          <div className="px-2 py-1.5 border-b border-border/20">
            <div className="flex items-center gap-2">
              <RiQuestionLine className="h-3.5 w-3.5 text-primary" />
              <span className="typography-meta font-medium text-muted-foreground">{t('chat.questionCard.inputNeeded')}</span>
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
          </div>

          <div className="px-2 py-2">
            {activeEntry ? renderQuestionBody(activeEntry, { withHeader: totalCount > 1 }) : null}
          </div>

          {footerError ? (
            <div className="px-2 pb-1 typography-micro text-[var(--status-error)]" role="alert">
              {footerError}
            </div>
          ) : null}

          {/* Footer actions */}
          <div className="px-2 pb-1.5 pt-1 flex items-center gap-1.5 border-t border-border/20">
            {boundedActiveIndex > 0 ? (
              <button
                type="button"
                onClick={handleBack}
                disabled={isSubmitting}
                className={cn(
                  'flex items-center gap-1 px-2 py-1 typography-meta font-medium rounded transition-colors',
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
                'flex items-center gap-1 px-2 py-1 typography-meta font-medium rounded transition-colors',
                'bg-[rgb(var(--status-success)/0.1)] text-[var(--status-success)] hover:bg-[rgb(var(--status-success)/0.2)]',
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
                'flex items-center gap-1 px-2 py-1 typography-meta font-medium rounded transition-colors',
                'bg-[rgb(var(--status-error)/0.1)] text-[var(--status-error)] hover:bg-[rgb(var(--status-error)/0.2)]',
                'disabled:opacity-50 disabled:cursor-not-allowed',
              )}
            >
              <RiCloseLine className="h-3 w-3" />
              {t('chat.questionCard.skip')}
            </button>

          </div>
        </div>
      </div>
    </div>
  );
};
