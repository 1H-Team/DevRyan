import React from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';

interface WorkingPlaceholderProps {
  isWorking: boolean;
  statusText: string | null;
  isGenericStatus?: boolean;
  isWaitingForPermission?: boolean;
  retryInfo?: { attempt?: number; next?: number; message?: string } | null;
  agentName?: string;
}

const STATUS_DISPLAY_TIME_MS = 1200;

const EPOCH_SECONDS_THRESHOLD = 1_000_000_000;
const EPOCH_MILLISECONDS_THRESHOLD = 1_000_000_000_000;

const toRetryTargetTimestamp = (next: number): number => {
  if (next >= EPOCH_MILLISECONDS_THRESHOLD) {
    return next;
  }
  if (next >= EPOCH_SECONDS_THRESHOLD) {
    return next * 1000;
  }
  return Date.now() + next;
};

const formatRetryCountdown = (seconds: number): string => {
  if (seconds < 60) {
    return `${seconds}s`;
  }

  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const remainderSeconds = seconds % 60;
    return remainderSeconds > 0 ? `${minutes}m ${remainderSeconds}s` : `${minutes}m`;
  }

  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    const remainderMinutes = Math.floor((seconds % 3600) / 60);
    return remainderMinutes > 0 ? `${hours}h ${remainderMinutes}m` : `${hours}h`;
  }

  const days = Math.floor(seconds / 86400);
  const remainderHours = Math.floor((seconds % 86400) / 3600);
  if (remainderHours > 0) {
    return `${days}d ${remainderHours}h`;
  }

  return `${days}d`;

};

export function WorkingPlaceholder({
  isWorking,
  statusText,
  isGenericStatus,
  isWaitingForPermission,
  retryInfo,
}: WorkingPlaceholderProps) {
  const shouldReduceMotion = useReducedMotion() === true;
  const [displayedText, setDisplayedText] = React.useState<string | null>(null);
  const [displayedPermission, setDisplayedPermission] = React.useState<boolean>(false);
  const displayedTextRef = React.useRef(displayedText);
  const displayedPermissionRef = React.useRef(displayedPermission);
  displayedTextRef.current = displayedText;
  displayedPermissionRef.current = displayedPermission;

  const statusShownAtRef = React.useRef<number>(0);
  const queuedStatusRef = React.useRef<{ text: string; permission: boolean } | null>(null);
  const processQueueTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Countdown state for retry mode
  const [retryCountdown, setRetryCountdown] = React.useState<number | null>(null);

  React.useEffect(() => {
    const rawNext = retryInfo?.next;
    if (!rawNext || rawNext <= 0) {
      setRetryCountdown(null);
      return;
    }

    const retryTargetAt = toRetryTargetTimestamp(rawNext);

    const update = () => {
      const remaining = Math.max(0, retryTargetAt - Date.now());
      setRetryCountdown(Math.ceil(remaining / 1000));
    };

    update();
    const id = setInterval(update, 500);
    return () => clearInterval(id);
  }, [retryInfo?.next, retryInfo?.attempt]);

  const clearTimers = React.useCallback(() => {
    if (processQueueTimerRef.current) {
      clearTimeout(processQueueTimerRef.current);
      processQueueTimerRef.current = null;
    }
  }, []);

  const showStatus = React.useCallback((text: string, permission: boolean) => {
    clearTimers();
    queuedStatusRef.current = null;
    setDisplayedText(text);
    setDisplayedPermission(permission);
    statusShownAtRef.current = Date.now();
  }, [clearTimers]);

  const scheduleQueueProcess = React.useCallback(() => {
    if (processQueueTimerRef.current) return;
    const elapsed = Date.now() - statusShownAtRef.current;
    const remaining = Math.max(0, STATUS_DISPLAY_TIME_MS - elapsed);
    processQueueTimerRef.current = setTimeout(() => {
      processQueueTimerRef.current = null;

      const queued = queuedStatusRef.current;
      if (queued) {
        showStatus(queued.text, queued.permission);
      }
    }, remaining);
  }, [showStatus]);

  React.useEffect(() => {
    if (!isWorking) {
      clearTimers();
      queuedStatusRef.current = null;
      setDisplayedText(null);
      setDisplayedPermission(false);
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

    if (!displayedTextRef.current) {
      showStatus(incomingText, incomingPermission);
      return;
    }

    if (incomingText === displayedTextRef.current && incomingPermission === displayedPermissionRef.current) {
      return;
    }

    // Ignore generic churn.
    if (incomingGeneric) {
      return;
    }

    const elapsed = Date.now() - statusShownAtRef.current;
    if (elapsed >= STATUS_DISPLAY_TIME_MS) {
      showStatus(incomingText, incomingPermission);
      return;
    }

    queuedStatusRef.current = { text: incomingText, permission: incomingPermission };
    scheduleQueueProcess();
  }, [
    isWorking,
    statusText,
    isGenericStatus,
    isWaitingForPermission,
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
    const countdownLabel = retryCountdown !== null && retryCountdown > 0
      ? ` in ${formatRetryCountdown(retryCountdown)}`
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
          <span
            className="oc-text-shimmer whitespace-nowrap"
            data-shimmer-text={retryText}
          >
            {retryText}
          </span>
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
        'flex h-full items-center text-muted-foreground pl-0.5'
      }
      role="status"
      aria-live={displayedPermission ? 'assertive' : 'polite'}
      data-waiting={displayedPermission ? 'true' : undefined}
    >
      <span className="sr-only">{label}</span>
      <span
        aria-hidden="true"
        className="typography-ui-header relative inline-flex overflow-hidden"
      >
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={label}
            initial={shouldReduceMotion ? false : { y: 12, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={shouldReduceMotion ? { opacity: 0 } : { y: -12, opacity: 0 }}
            transition={{ duration: shouldReduceMotion ? 0 : 0.25, ease: 'easeOut' }}
            className="oc-text-shimmer whitespace-nowrap"
            data-shimmer-text={label}
          >
            {label}
          </motion.span>
        </AnimatePresence>
      </span>
    </div>
  );
}
