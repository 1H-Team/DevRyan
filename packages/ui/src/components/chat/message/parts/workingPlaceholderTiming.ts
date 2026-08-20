const EPOCH_SECONDS_THRESHOLD = 1_000_000_000;
const EPOCH_MILLISECONDS_THRESHOLD = 1_000_000_000_000;

export const toRetryTargetTimestamp = (next: number, now: number = Date.now()): number => {
  if (next >= EPOCH_MILLISECONDS_THRESHOLD) return next;
  if (next >= EPOCH_SECONDS_THRESHOLD) return next * 1000;
  return now + next;
};

export const formatRetryCountdown = (seconds: number): string => {
  if (seconds < 60) return `${seconds}s`;

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
  return remainderHours > 0 ? `${days}d ${remainderHours}h` : `${days}d`;
};

export const getRetryCountdownSeconds = (retryTargetAt: number, now: number): number => (
  Math.ceil(Math.max(0, retryTargetAt - now) / 1000)
);

export const getRetryCountdownBoundaryDelayMs = (retryTargetAt: number, now: number): number | null => {
  const remaining = retryTargetAt - now;
  if (remaining <= 0) return null;
  const displayedSeconds = Math.ceil(remaining / 1000);
  return Math.max(1, Math.ceil(remaining - ((displayedSeconds - 1) * 1000)));
};
