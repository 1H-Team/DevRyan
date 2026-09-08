import React from 'react';
import { useDocumentAnimationState } from '@/hooks/useDocumentAnimationState';
import { cn } from '@/lib/utils';
import { shouldPreserveWorkingStatus, type WorkingStatusLabel } from './workingPlaceholderStatus';
import {
  formatRetryCountdown,
  getRetryCountdownBoundaryDelayMs,
  getRetryCountdownSeconds,
  toRetryTargetTimestamp,
} from './workingPlaceholderTiming';

interface WorkingPlaceholderProps {
  isWorking: boolean;
  statusText: string | null;
  isGenericStatus?: boolean;
  isWaitingForPermission?: boolean;
  retryInfo?: { attempt?: number; next?: number; message?: string } | null;
  agentName?: string;
}

const STATUS_DISPLAY_TIME_MS = 1200;

export function StatusShimmerText({
  text,
  shouldAnimate,
  className,
}: {
  text: string;
  shouldAnimate: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn('oc-text-shimmer', className)}
      data-animation-state={shouldAnimate ? 'running' : 'paused'}
      data-live-status-shimmer="true"
      data-shimmer-text={text}
    >
      {text}
    </span>
  );
}

export function WorkingPlaceholder({
  isWorking,
  statusText,
  isGenericStatus,
  isWaitingForPermission,
  retryInfo,
}: WorkingPlaceholderProps) {
  const { isVisible, shouldAnimate } = useDocumentAnimationState();
  const [displayedText, setDisplayedText] = React.useState<string | null>(null);
  const [displayedPermission, setDisplayedPermission] = React.useState<boolean>(false);
  const displayedTextRef = React.useRef(displayedText);
  const displayedPermissionRef = React.useRef(displayedPermission);
  const displayedGenericRef = React.useRef(false);
  displayedTextRef.current = displayedText;
  displayedPermissionRef.current = displayedPermission;

  const statusShownAtRef = React.useRef<number>(0);
  const queuedStatusRef = React.useRef<WorkingStatusLabel | null>(null);
  const processQueueTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Countdown state for retry mode
  const [retryCountdownLabel, setRetryCountdownLabel] = React.useState<string | null>(null);
  const retryAttempt = retryInfo?.attempt;
  const rawRetryNext = retryInfo?.next;
  const retryTargetAt = React.useMemo(() => {
    void retryAttempt;
    if (!rawRetryNext || rawRetryNext <= 0) return null;
    return toRetryTargetTimestamp(rawRetryNext);
  }, [rawRetryNext, retryAttempt]);

  React.useEffect(() => {
    if (retryTargetAt === null) {
      setRetryCountdownLabel((current) => current === null ? current : null);
      return;
    }

    let timer: ReturnType<typeof setTimeout> | null = null;

    const update = () => {
      const now = Date.now();
      const seconds = getRetryCountdownSeconds(retryTargetAt, now);
      const nextLabel = seconds > 0 ? formatRetryCountdown(seconds) : null;
      setRetryCountdownLabel((current) => current === nextLabel ? current : nextLabel);

      if (!isVisible || seconds === 0) return;
      const delay = getRetryCountdownBoundaryDelayMs(retryTargetAt, now);
      if (delay === null) return;
      timer = setTimeout(update, delay);
    };

    update();
    return () => {
      if (timer !== null) clearTimeout(timer);
    };
  }, [isVisible, retryTargetAt]);

  const clearTimers = React.useCallback(() => {
    if (processQueueTimerRef.current) {
      clearTimeout(processQueueTimerRef.current);
      processQueueTimerRef.current = null;
    }
  }, []);

  const showStatus = React.useCallback((text: string, permission: boolean, generic: boolean) => {
    clearTimers();
    queuedStatusRef.current = null;
    setDisplayedText(text);
    setDisplayedPermission(permission);
    displayedGenericRef.current = generic;
    statusShownAtRef.current = Date.now();
  }, [clearTimers]);

  const scheduleQueueProcess = React.useCallback(() => {
    if (!isVisible || processQueueTimerRef.current) return;
    const elapsed = Date.now() - statusShownAtRef.current;
    const remaining = Math.max(0, STATUS_DISPLAY_TIME_MS - elapsed);
    processQueueTimerRef.current = setTimeout(() => {
      processQueueTimerRef.current = null;

      const queued = queuedStatusRef.current;
      if (queued) {
        showStatus(queued.text, queued.permission, queued.generic);
      }
    }, remaining);
  }, [isVisible, showStatus]);

  React.useEffect(() => {
    if (!isWorking) {
      clearTimers();
      queuedStatusRef.current = null;
      setDisplayedText(null);
      setDisplayedPermission(false);
      displayedGenericRef.current = false;
      return;
    }

    // Retry state has its own display — skip the normal queue
    if (retryInfo) {
      clearTimers();
      queuedStatusRef.current = null;
      return;
    }

    const incomingText = isWaitingForPermission ? 'waiting for permission' : statusText;
    const incomingPermission = Boolean(isWaitingForPermission);
    const incomingGeneric = Boolean(isGenericStatus) && !incomingPermission;

    if (!incomingText) {
      return;
    }

    if (!isVisible) {
      clearTimers();
      queuedStatusRef.current = { text: incomingText, permission: incomingPermission, generic: incomingGeneric };
      return;
    }

    if (!displayedTextRef.current) {
      showStatus(incomingText, incomingPermission, incomingGeneric);
      return;
    }

    if (shouldPreserveWorkingStatus(
      { text: displayedTextRef.current, permission: displayedPermissionRef.current, generic: displayedGenericRef.current },
      { text: incomingText, permission: incomingPermission, generic: incomingGeneric },
    )) {
      // A newer state supersedes queued labels too: a short tool call may have
      // already finished before its minimum-display timer was allowed to fire.
      clearTimers();
      queuedStatusRef.current = null;
      displayedGenericRef.current = incomingGeneric;
      return;
    }

    const elapsed = Date.now() - statusShownAtRef.current;
    if (elapsed >= STATUS_DISPLAY_TIME_MS) {
      showStatus(incomingText, incomingPermission, incomingGeneric);
      return;
    }

    queuedStatusRef.current = { text: incomingText, permission: incomingPermission, generic: incomingGeneric };
    scheduleQueueProcess();
  }, [
    isWorking,
    statusText,
    isGenericStatus,
    isWaitingForPermission,
    isVisible,
    retryInfo,
    clearTimers,
    showStatus,
    scheduleQueueProcess,
  ]);

  React.useEffect(() => () => clearTimers(), [clearTimers]);

  if (!isWorking) {
    return null;
  }

  // Retry state: show countdown, attempt info, and the provider's reason
  // (e.g. an out-of-usage / rate-limit message) so the user knows why.
  if (retryInfo) {
    const attemptLabel = retryInfo.attempt && retryInfo.attempt > 1 ? ` (attempt ${retryInfo.attempt})` : '';
    const countdownLabel = retryCountdownLabel
      ? ` in ${retryCountdownLabel}`
      : '';
    const retryText = `Retrying${countdownLabel}${attemptLabel}`;
    const retryReason = typeof retryInfo.message === 'string' ? retryInfo.message.trim() : '';

    return (
      <div
        className="flex h-full min-w-0 items-center text-muted-foreground pl-0.5"
        role="status"
        aria-live="polite"
        aria-label={retryReason ? `${retryText} — ${retryReason}` : retryText}
      >
        <span className="typography-ui-header flex min-w-0 items-center">
          <StatusShimmerText
            text={retryText}
            shouldAnimate={shouldAnimate}
            className="shrink-0"
          />
          {retryReason ? (
            <span className="truncate">&nbsp;— {retryReason}</span>
          ) : null}
        </span>
      </div>
    );
  }

  if (!displayedText) {
    return null;
  }

  const label = displayedText.charAt(0).toUpperCase() + displayedText.slice(1);

  return (
    <div
      className={
        'flex h-full min-w-0 max-w-full items-center text-muted-foreground pl-0.5'
      }
      role="status"
      aria-live={displayedPermission ? 'assertive' : 'polite'}
      data-waiting={displayedPermission ? 'true' : undefined}
    >
      <StatusShimmerText
        text={label}
        shouldAnimate={shouldAnimate}
        className="typography-ui-header"
      />
    </div>
  );
}
