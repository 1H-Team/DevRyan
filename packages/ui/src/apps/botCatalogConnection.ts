type CatalogConnectionOptions = {
  load: () => Promise<unknown>;
  shouldRetry: () => boolean;
  cancel: () => void;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
};

const RETRY_DELAYS_MS = [250, 1_000, 2_000, 5_000, 15_000] as const;

// One bootstrap/retry owner per authenticated principal. Successful SSE
// snapshots can settle bootstrap while HTTP is in flight or backing off.
export const createBotCatalogConnection = ({
  load,
  shouldRetry,
  cancel,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
}: CatalogConnectionOptions) => {
  let disposed = false;
  let pending = false;
  let retryAfterLoad = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (timer !== null) clearTimeoutImpl(timer);
    timer = null;
  };

  const refresh = async () => {
    if (disposed) return;
    if (pending) {
      retryAfterLoad = true;
      return;
    }
    pending = true;
    try {
      await load();
    } finally {
      pending = false;
      if (!disposed) {
        if (retryAfterLoad) {
          retryAfterLoad = false;
          void refresh();
        } else if (shouldRetry()) {
          const delay = RETRY_DELAYS_MS[Math.min(attempt++, RETRY_DELAYS_MS.length - 1)];
          timer = setTimeoutImpl(() => {
            timer = null;
            if (shouldRetry()) void refresh();
          }, delay);
        } else {
          attempt = 0;
        }
      }
    }
  };

  return {
    retry() {
      clearTimer();
      attempt = 0;
      void refresh();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimer();
      cancel();
    },
  };
};
