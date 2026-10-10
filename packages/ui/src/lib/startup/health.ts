export interface StartupHealthSnapshot {
  ready: boolean;
  runtimeIdentity: string | null;
  error: string | null;
  startup?: {
    state: 'idle' | 'starting' | 'ready' | 'failed';
    attempt: number;
    code: string | null;
  };
}

export const parseStartupHealth = (value: unknown): StartupHealthSnapshot | null => {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  const openCode = data.openCode;
  const raw = data.openCodeStartup;
  let startup: StartupHealthSnapshot['startup'];
  if (raw && typeof raw === 'object') {
    const item = raw as Record<string, unknown>;
    if ((item.state === 'idle' || item.state === 'starting' || item.state === 'ready' || item.state === 'failed')
      && typeof item.attempt === 'number' && Number.isSafeInteger(item.attempt) && item.attempt >= 0
      && (item.code === null || typeof item.code === 'string')) {
      startup = { state: item.state, attempt: item.attempt,
        code: typeof item.code === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(item.code) ? item.code : null };
    }
  }
  return {
    ready: Boolean(openCode && typeof openCode === 'object' && 'generation' in openCode
      && openCode.generation === 2 && data.isOpenCodeReady === true),
    runtimeIdentity: typeof data.openCodeRuntimeIdentity === 'string' ? data.openCodeRuntimeIdentity : null,
    error: typeof data.lastOpenCodeError === 'string' && data.lastOpenCodeError.trim()
      ? data.lastOpenCodeError.trim() : null,
    startup,
  };
};

const abortable = async <T>(work: Promise<T>, signal: AbortSignal): Promise<T> => {
  signal.throwIfAborted();
  let rejectAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(signal.reason);
    signal.addEventListener('abort', rejectAbort, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    if (rejectAbort) signal.removeEventListener('abort', rejectAbort);
  }
};

export const waitForStartupHealth = async (
  readHealth: (signal: AbortSignal) => Promise<StartupHealthSnapshot | null>,
  options: { signal: AbortSignal; intervalMs?: number; requestTimeoutMs?: number; timeoutMs?: number },
): Promise<void> => {
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 120_000)]);
  let runtimeIdentity: string | null = null;
  let attempt = -1;
  while (true) {
    signal.throwIfAborted();
    const startedAt = performance.now();
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(options.requestTimeoutMs ?? 3_000)]);
    const health = await abortable(readHealth(requestSignal), requestSignal).catch(() => null);
    signal.throwIfAborted();
    if (health) {
      if (health.runtimeIdentity !== runtimeIdentity) {
        runtimeIdentity = health.runtimeIdentity;
        attempt = -1;
      }
      if (!health.startup || health.startup.attempt >= attempt) {
        attempt = health.startup?.attempt ?? attempt;
        if (health.startup?.state === 'failed') {
          throw new Error(health.startup.code || 'OpenCode could not start.');
        }
        if (health.ready) return;
      }
    }
    const delay = Math.max(0, (options.intervalMs ?? 1_000) - (performance.now() - startedAt));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await abortable(new Promise<void>(resolve => { timer = setTimeout(resolve, delay); }), signal);
    } finally {
      clearTimeout(timer);
    }
  }
};
