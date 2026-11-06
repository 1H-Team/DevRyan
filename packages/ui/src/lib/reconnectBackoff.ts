// Shared stream reconnect backoff: 1 s, doubling, capped at 30 s. Callers reset
// it once a stream is confirmed ready, not merely when a connection opens.
export const RECONNECT_BASE_DELAY_MS = 1_000;
export const RECONNECT_MAX_DELAY_MS = 30_000;
const MAX_DOUBLINGS = 5;

export const reconnectDelayMs = (attempt: number): number => {
  const doublings = Number.isFinite(attempt) ? Math.min(Math.max(Math.floor(attempt), 0), MAX_DOUBLINGS) : MAX_DOUBLINGS;
  return Math.min(RECONNECT_BASE_DELAY_MS * 2 ** doublings, RECONNECT_MAX_DELAY_MS);
};

export type ReconnectBackoff = {
  /** Delay for the next retry; advances the attempt count. */
  next(): number;
  reset(): void;
  readonly attempt: number;
};

export const createReconnectBackoff = (): ReconnectBackoff => {
  let attempt = 0;
  return {
    next() {
      const delay = reconnectDelayMs(attempt);
      attempt += 1;
      return delay;
    },
    reset() {
      attempt = 0;
    },
    get attempt() {
      return attempt;
    },
  };
};
