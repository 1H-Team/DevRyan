import React from 'react';
import { RiArrowLeftSLine, RiArrowRightSLine, RiCheckLine, RiCloseLine, RiEditLine, RiQuestionLine } from '@remixicon/react';
import { Checkbox } from '@/components/ui/checkbox';
import { Radio } from '@/components/ui/radio';

import { cn } from '@/lib/utils';
import { isIMECompositionEvent } from '@/lib/ime';
import type { QuestionRequest } from '@/types/question';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessions } from '@/sync/sync-context';
import * as sessionActions from '@/sync/session-actions';
import { useI18n } from '@/lib/i18n';
import {
  buildQuestionRequestAnswerGroups,
  submitQuestionRequestAnswerGroups,
  type QuestionAnswerEntry,
} from './questionCardRouting';
import {
  getIndexAfterOptionSelection,
  getNextQuestionIndex,
  getPreviousQuestionIndex,
  isQuestionAnswerComplete,
} from './questionCardNavigation';
import { getQuestionOptionPresentation } from './questionCardOptions';

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

  // The session id is shared across the merged requests; take it from the first.
  const sessionID = normalizedRequests[0]?.sessionID;

  const isFromSubagent = React.useMemo(() => {
    if (!currentSessionId || !sessionID || sessionID === currentSessionId) return false;
    const sourceSession = sessions.find((session) => session.id === sessionID);
    return Boolean(sourceSession?.parentID && sourceSession.parentID === currentSessionId);
  }, [sessionID, currentSessionId, sessions]);

  // Flatten all questions across all requests.
  const entries = React.useMemo<QuestionEntry[]>(() => {
    const acc: QuestionEntry[] = [];
    let flatIndex = 0;
    for (const req of normalizedRequests) {
      const list = req.questions ?? [];
      for (let i = 0; i < list.length; i += 1) {
        acc.push({
          flatIndex,
          request: req,
          withinRequestIndex: i,
          question: list[i],
        });
        flatIndex += 1;
      }
    }
    return acc;
  }, [normalizedRequests]);

  const totalCount = entries.length;

  const [activeIndex, setActiveIndex] = React.useState(0);
  const [isResponding, setIsResponding] = React.useState(false);
  const [hasResponded, setHasResponded] = React.useState(false);

  // Per-flat-index answer state.
  const [selectedOptions, setSelectedOptions] = React.useState<Record<number, string[]>>({});
  const [customMode, setCustomMode] = React.useState<Record<number, boolean>>({});
  const [customText, setCustomText] = React.useState<Record<number, string>>({});
  // Per-request error after partial submit failure.
  const [requestErrors, setRequestErrors] = React.useState<Record<string, string>>({});

  // Reset when the underlying request-set changes.
  const requestKey = React.useMemo(
    () => normalizedRequests.map((r) => r.id).join('|'),
    [normalizedRequests],
  );
  React.useEffect(() => {
    setActiveIndex(0);
    setSelectedOptions({});
    setCustomMode({});
    setCustomText({});
    setHasResponded(false);
    setRequestErrors({});
  }, [requestKey]);

  React.useEffect(() => {
    setActiveIndex((current) => Math.min(current, Math.max(0, totalCount - 1)));
  }, [totalCount]);

  const activeEntry = entries[activeIndex] ?? null;
  const isLastQuestion = activeIndex >= totalCount - 1;
  const progressLabel = totalCount > 1
    ? t('chat.questionCard.progress', { current: activeIndex + 1, total: totalCount })
    : null;

  const isEntryAnswered = React.useCallback(
    (flatIndex: number): boolean => isQuestionAnswerComplete({
      isCustom: Boolean(customMode[flatIndex]),
      customText: customText[flatIndex],
      selectedOptions: selectedOptions[flatIndex] ?? [],
    }),
    [customMode, customText, selectedOptions],
  );

  const unansweredIndexes = React.useMemo(() => {
    const pending: number[] = [];
    for (const entry of entries) {
      if (!isEntryAnswered(entry.flatIndex)) pending.push(entry.flatIndex);
    }
    return pending;
  }, [entries, isEntryAnswered]);

  const requiredSatisfied = totalCount > 0 && unansweredIndexes.length === 0;
  const activeAnswerComplete = activeEntry ? isEntryAnswered(activeEntry.flatIndex) : false;

  const handleBack = React.useCallback(() => {
    setActiveIndex((current) => getPreviousQuestionIndex(current));
  }, []);

  const handleNext = React.useCallback(() => {
    if (!activeAnswerComplete) return;
    setActiveIndex((current) => getNextQuestionIndex(current, totalCount));
  }, [activeAnswerComplete, totalCount]);

  const buildAnswerForEntry = React.useCallback(
    (flatIndex: number): string[] => {
      const isCustom = Boolean(customMode[flatIndex]);
      if (isCustom) {
        const value = (customText[flatIndex] ?? '').trim();
        return value ? [value] : [];
      }
      return selectedOptions[flatIndex] ?? [];
    },
    [customMode, customText, selectedOptions],
  );

  const handleToggleOption = React.useCallback(
    (entry: QuestionEntry, label: string) => {
      setCustomMode((prev) => ({ ...prev, [entry.flatIndex]: false }));
      setSelectedOptions((prev) => {
        const current = prev[entry.flatIndex] ?? [];
        if (entry.question.multiple) {
          const exists = current.includes(label);
          const next = exists ? current.filter((item) => item !== label) : [...current, label];
          return { ...prev, [entry.flatIndex]: next };
        }
        return { ...prev, [entry.flatIndex]: [label] };
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
    setCustomMode((prev) => ({ ...prev, [entry.flatIndex]: true }));
    setSelectedOptions((prev) => ({ ...prev, [entry.flatIndex]: [] }));
  }, []);

  const handleConfirm = React.useCallback(async () => {
    if (!requiredSatisfied) return;

    setIsResponding(true);
    setRequestErrors({});

    const answerGroups = buildQuestionRequestAnswerGroups(
      entries.map((entry): QuestionAnswerEntry => ({
        request: entry.request,
        withinRequestIndex: entry.withinRequestIndex,
        answers: buildAnswerForEntry(entry.flatIndex),
      })),
    );
    const results = await submitQuestionRequestAnswerGroups(answerGroups, respondToQuestion);

    const nextErrors: Record<string, string> = {};
    let anySucceeded = false;
    let anyFailed = false;
    for (const result of results) {
      if (result.status === 'fulfilled') {
        anySucceeded = true;
      } else {
        anyFailed = true;
        nextErrors[result.request.id] = result.reason instanceof Error
          ? result.reason.message
          : 'Failed to submit answer';
      }
    }

    if (anyFailed) setRequestErrors(nextErrors);
    if (!anyFailed) setHasResponded(true);
    if (anyFailed && !anySucceeded) {
      // Nothing got through — keep the card up for retry.
    }
    setIsResponding(false);
  }, [buildAnswerForEntry, entries, requiredSatisfied, respondToQuestion]);

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

  const handleDismiss = React.useCallback(async () => {
    setIsResponding(true);
    setRequestErrors({});
    // Reject every underlying request. Same partial-failure semantics as submit.
    const results = await Promise.allSettled(
      normalizedRequests.map((req) => rejectQuestion(req.sessionID, req.id).then(() => req.id)),
    );
    const nextErrors: Record<string, string> = {};
    let anyFailed = false;
    for (let i = 0; i < results.length; i += 1) {
      const result = results[i];
      if (result.status === 'rejected') {
        anyFailed = true;
        nextErrors[normalizedRequests[i].id] = result.reason instanceof Error
          ? result.reason.message
          : 'Failed to dismiss';
      }
    }
    if (anyFailed) setRequestErrors(nextErrors);
    if (!anyFailed) setHasResponded(true);
    setIsResponding(false);
  }, [normalizedRequests, rejectQuestion]);

  if (hasResponded || totalCount === 0) return null;

  const footerError = Array.from(new Set(Object.values(requestErrors).filter(Boolean))).join(' ');
  const primaryDisabled = isResponding || (isLastQuestion ? !requiredSatisfied : !activeAnswerComplete);
  const handlePrimaryAction = isLastQuestion ? handleConfirm : handleNext;

  const renderQuestionBody = (entry: QuestionEntry, opts: { withHeader: boolean }) => {
    const selected = selectedOptions[entry.flatIndex] ?? [];
    const isCustomActive = Boolean(customMode[entry.flatIndex]);
    return (
      <div key={entry.flatIndex}>
        {opts.withHeader && entry.question.header?.trim() ? (
          <div className="typography-micro font-medium text-muted-foreground mb-1">
            {entry.question.header}
          </div>
        ) : null}
        <div className="typography-meta font-medium text-foreground mb-1.5">{entry.question.question}</div>
        {entry.question.multiple ? (
          <div className="typography-micro text-muted-foreground mb-1.5">{t('chat.questionCard.selectMultiple')}</div>
        ) : null}

        <div className="space-y-0.5">
          {entry.question.options.map((option, index) => {
            const isSelected = selected.includes(option.label);
            const { displayLabel, recommended } = getQuestionOptionPresentation(option.label);
            return (
              <button
                key={`${index}:${option.label}`}
                type="button"
                onClick={() => handleToggleOption(entry, option.label)}
                disabled={isResponding}
                className={cn(
                  'w-full px-1.5 py-1 text-left rounded transition-colors',
                  'hover:bg-interactive-hover/30',
                  isSelected ? 'bg-interactive-selection/20' : null,
                  isResponding ? 'opacity-60 cursor-not-allowed' : null,
                )}
              >
                <div className="flex items-start gap-2">
                  <div className="mt-0.5 shrink-0">
                    {entry.question.multiple ? (
                      <Checkbox
                        checked={isSelected}
                        onChange={() => handleToggleOption(entry, option.label)}
                        disabled={isResponding}
                      />
                    ) : (
                      <Radio
                        checked={isSelected}
                        onChange={() => handleToggleOption(entry, option.label)}
                        disabled={isResponding}
                      />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={cn(
                          'typography-meta break-all',
                          isSelected ? 'text-foreground font-medium' : 'text-foreground/80',
                        )}
                      >
                        {displayLabel}
                      </span>
                      {recommended ? (
                        <span className="typography-micro text-primary/80">{t('chat.questionCard.recommended')}</span>
                      ) : null}
                    </div>
                    {option.description ? (
                      <div className="typography-micro text-muted-foreground break-words">{option.description}</div>
                    ) : null}
                  </div>
                </div>
              </button>
            );
          })}

          <button
            type="button"
            onClick={() => handleSelectCustom(entry)}
            disabled={isResponding}
            className={cn(
              'w-full px-1.5 py-1 text-left rounded transition-colors',
              'hover:bg-interactive-hover/30',
              isCustomActive ? 'bg-interactive-selection/20' : null,
              isResponding ? 'opacity-60 cursor-not-allowed' : null,
            )}
          >
            <div className="flex items-center gap-2">
              <RiEditLine
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
                value={customText[entry.flatIndex] ?? ''}
                onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => {
                  const el = event.target;
                  el.style.height = 'auto';
                  const lineHeight = 20;
                  const minHeight = lineHeight * 2;
                  const maxHeight = lineHeight * 4;
                  el.style.height = `${Math.min(Math.max(el.scrollHeight, minHeight), maxHeight)}px`;
                  setCustomText((prev) => ({ ...prev, [entry.flatIndex]: el.value }));
                }}
                placeholder={t('chat.questionCard.yourAnswer')}
                disabled={isResponding}
                rows={2}
                onKeyDown={handleKeyDown}
                className="w-full bg-transparent border border-border/30 focus:border-primary rounded px-2 py-1 outline-none typography-meta text-foreground placeholder:text-muted-foreground/50 transition-colors resize-none overflow-hidden"
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
            {activeIndex > 0 ? (
              <button
                type="button"
                onClick={handleBack}
                disabled={isResponding}
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
              onClick={handleDismiss}
              disabled={isResponding}
              className={cn(
                'flex items-center gap-1 px-2 py-1 typography-meta font-medium rounded transition-colors',
                'bg-[rgb(var(--status-error)/0.1)] text-[var(--status-error)] hover:bg-[rgb(var(--status-error)/0.2)]',
                'disabled:opacity-50 disabled:cursor-not-allowed',
              )}
            >
              <RiCloseLine className="h-3 w-3" />
              {t('chat.questionCard.dismiss')}
            </button>

            {isResponding ? (
              <div className="ml-auto">
                <div className="animate-spin h-3 w-3 border border-primary border-t-transparent rounded-full" />
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
};
