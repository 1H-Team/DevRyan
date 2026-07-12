export const BASELINE_QUOTA_REFRESH_MS = 30 * 60 * 1000;

export interface QuotaRefreshOptions {
  forceRefresh?: boolean;
  rediscover?: boolean;
}

export interface QuotaRefreshClock {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
}

export interface QuotaRefreshCoordinator {
  start(): void;
  stop(): void;
  refreshNow(options?: QuotaRefreshOptions): Promise<void>;
  settingsChanged(): void;
}

interface QuotaRefreshCoordinatorDependencies {
  loadSettings: () => Promise<void>;
  refresh: (options: QuotaRefreshOptions) => Promise<void>;
  getRefreshIntervalMs: () => number;
  clock?: QuotaRefreshClock;
}

const systemClock: QuotaRefreshClock = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof globalThis.setTimeout>),
};

const normalizeOptions = (options: QuotaRefreshOptions = {}): QuotaRefreshOptions => ({
  ...(options.forceRefresh ? { forceRefresh: true } : {}),
  ...(options.rediscover ? { rediscover: true } : {}),
});

const mergeOptions = (
  current: QuotaRefreshOptions | null,
  incoming: QuotaRefreshOptions,
): QuotaRefreshOptions => normalizeOptions({
  forceRefresh: Boolean(current?.forceRefresh || incoming.forceRefresh),
  rediscover: Boolean(current?.rediscover || incoming.rediscover),
});

const normalizeInterval = (intervalMs: number): number => {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return BASELINE_QUOTA_REFRESH_MS;
  }
  return Math.min(BASELINE_QUOTA_REFRESH_MS, Math.round(intervalMs));
};

export const createQuotaRefreshCoordinator = ({
  loadSettings,
  refresh,
  getRefreshIntervalMs,
  clock = systemClock,
}: QuotaRefreshCoordinatorDependencies): QuotaRefreshCoordinator => {
  let started = false;
  let lifecycle = 0;
  let stopEpoch = 0;
  let timer: unknown = null;
  let settingsLoad: Promise<void> | null = null;
  let inFlight: Promise<void> | null = null;
  let queuedRefresh: { options: QuotaRefreshOptions; stopEpoch: number } | null = null;

  const clearTimer = () => {
    if (timer === null) return;
    clock.clearTimeout(timer);
    timer = null;
  };

  const scheduleNext = () => {
    clearTimer();
    if (!started) return;

    timer = clock.setTimeout(() => {
      timer = null;
      void refreshNow().catch(() => {
        // Store state owns user-visible refresh failures.
      });
    }, normalizeInterval(getRefreshIntervalMs()));
  };

  const refreshNow = (options: QuotaRefreshOptions = {}): Promise<void> => {
    const normalized = normalizeOptions(options);
    if (inFlight) {
      queuedRefresh = {
        options: mergeOptions(
          queuedRefresh?.stopEpoch === stopEpoch ? queuedRefresh.options : null,
          normalized,
        ),
        stopEpoch,
      };
      return inFlight;
    }

    clearTimer();
    const task = Promise.resolve().then(async () => {
      let nextOptions: QuotaRefreshOptions | null = normalized;
      let runStopEpoch = stopEpoch;
      let firstError: unknown = null;

      while (nextOptions) {
        try {
          await refresh(nextOptions);
        } catch (error) {
          firstError ??= error;
        }

        const queued = queuedRefresh;
        queuedRefresh = null;
        if (runStopEpoch !== stopEpoch) {
          if (!queued || queued.stopEpoch !== stopEpoch) break;
          runStopEpoch = queued.stopEpoch;
          nextOptions = queued.options;
          continue;
        }

        nextOptions = queued?.options ?? null;
      }

      if (firstError) {
        throw firstError;
      }
    });

    const tracked = task.finally(() => {
      if (inFlight === tracked) {
        inFlight = null;
      }
      scheduleNext();
    });
    inFlight = tracked;
    return tracked;
  };

  const start = () => {
    if (started) return;
    started = true;
    const currentLifecycle = ++lifecycle;

    settingsLoad ??= Promise.resolve()
      .then(loadSettings)
      .finally(() => {
        settingsLoad = null;
      });

    void settingsLoad
      .catch(() => {
        // A settings failure must not prevent the baseline refresh.
      })
      .then(() => {
        if (!started || currentLifecycle !== lifecycle) return;
        return refreshNow({ rediscover: true });
      })
      .catch(() => {
        // Store state owns user-visible refresh failures.
      });
  };

  const stop = () => {
    started = false;
    lifecycle += 1;
    stopEpoch += 1;
    queuedRefresh = null;
    clearTimer();
  };

  const settingsChanged = () => {
    if (!started) return;
    void refreshNow({ forceRefresh: true, rediscover: true }).catch(() => {
      // Store state owns user-visible refresh failures.
    });
  };

  return {
    start,
    stop,
    refreshNow,
    settingsChanged,
  };
};
