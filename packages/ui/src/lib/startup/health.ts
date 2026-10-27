import { parseArtifactDiagnostic, describeArtifactFailure, type ArtifactDiagnostic } from '@devryan/shared-runtime/startup-diagnostics.js';

export interface StartupHealthSnapshot {
  ready: boolean;
  runtimeIdentity: string | null;
  error: string | null;
  startup?: {
    state: 'idle' | 'starting' | 'ready' | 'failed';
    attempt: number;
    code: string | null;
    diagnostic?: ArtifactDiagnostic;
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
      const diagnostic = parseArtifactDiagnostic(item.diagnostic);
      startup = { state: item.state, attempt: item.attempt,
        code: typeof item.code === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(item.code) ? item.code : null,
        ...(diagnostic ? { diagnostic } : {}) };
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

export const STARTUP_PROGRESS_TIMEOUT_MS = 120_000;
export const STARTUP_MAX_TIMEOUT_MS = 600_000;

/**
 * `timeoutMs` bounds a wait without progress. Every snapshot that reports the
 * host still `starting` restarts that window, up to `maxTimeoutMs` in total, so
 * a slow but advancing native startup is not reported as a failure.
 */
export const waitForStartupHealth = async (
  readHealth: (signal: AbortSignal) => Promise<StartupHealthSnapshot | null>,
  options: { signal: AbortSignal; intervalMs?: number; requestTimeoutMs?: number; timeoutMs?: number; maxTimeoutMs?: number },
): Promise<void> => {
  const progressWindowMs = options.timeoutMs ?? STARTUP_PROGRESS_TIMEOUT_MS;
  const hardDeadline = performance.now() + Math.max(progressWindowMs, options.maxTimeoutMs ?? STARTUP_MAX_TIMEOUT_MS);
  const deadline = new AbortController();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const armDeadline = () => {
    clearTimeout(deadlineTimer);
    const remaining = Math.min(progressWindowMs, hardDeadline - performance.now());
    deadlineTimer = setTimeout(() => deadline.abort(
      new DOMException('OpenCode did not become ready in time.', 'TimeoutError')), Math.max(0, remaining));
  };
  armDeadline();
  const signal = AbortSignal.any([options.signal, deadline.signal]);
  try {
    await pollStartupHealth(readHealth, options, signal, armDeadline);
  } finally {
    clearTimeout(deadlineTimer);
  }
};

const pollStartupHealth = async (
  readHealth: (signal: AbortSignal) => Promise<StartupHealthSnapshot | null>,
  options: { intervalMs?: number; requestTimeoutMs?: number },
  signal: AbortSignal,
  onProgress: () => void,
): Promise<void> => {
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
          const { code, diagnostic } = health.startup;
          throw Object.assign(new Error(code === 'native_runtime_artifacts_unverified'
            ? describeArtifactFailure(diagnostic) : code || 'OpenCode could not start.'),
          { code, attempt: health.startup.attempt, ...(diagnostic ? { diagnostic } : {}) });
        }
        if (health.ready) return;
        if (health.startup?.state === 'starting') onProgress();
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

/**
 * Keeps checking a host after startup gave up, so a runtime that becomes
 * ready late recovers the Retry screen without a manual retry. Resolves once
 * the host reports ready; rejects only when `signal` aborts.
 */
export const watchStartupRecovery = async (
  readHealth: (signal: AbortSignal) => Promise<StartupHealthSnapshot | null>,
  options: { signal: AbortSignal; intervalMs?: number; requestTimeoutMs?: number },
): Promise<void> => {
  const { signal } = options;
  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await abortable(new Promise<void>(resolve => { timer = setTimeout(resolve, options.intervalMs ?? 5_000); }), signal);
    } finally {
      clearTimeout(timer);
    }
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(options.requestTimeoutMs ?? 3_000)]);
    const health = await abortable(readHealth(requestSignal), requestSignal).catch(() => null);
    signal.throwIfAborted();
    if (health?.ready) return;
  }
};
