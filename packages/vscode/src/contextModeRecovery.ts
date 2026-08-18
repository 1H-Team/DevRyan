const CONTEXT_MODE_IOERR_PATTERNS = [
  /\bSQLITE_IOERR\b/i,
  /\bdisk I\/O error\b/i,
];

export const CONTEXT_MODE_WEDGE_FAILURE_TEXT =
  'Context-mode SQLITE_IOERR persisted after one safe handle reopen. DevRyan paused new work and will restart managed OpenCode after active turns finish.';
export const CONTEXT_MODE_EXTERNAL_ACTION_REQUIRED_TEXT =
  'Context-mode SQLITE_IOERR requires the owner of the external OpenCode process to restart it. DevRyan will not patch, pause, or restart an external runtime.';
export const CONTEXT_MODE_RECOVERY_POLL_INTERVAL_MS = 1000;
export const CONTEXT_MODE_RECOVERY_RETRY_DELAYS_MS = Object.freeze([1000, 5000, 30000]);

export type ContextModeToolFailure = {
  tool: string;
  failureText: string;
};

export type ContextModeRecoveryState =
  | 'healthy'
  | 'draining'
  | 'restarting'
  | 'external_action_required';

export type ContextModeRecoveryStatus = {
  state: ContextModeRecoveryState;
  incidentId: string | null;
  detectedAt: number | null;
  updatedAt: number;
  recoveredAt: number | null;
  occurrenceCount: number;
  restartAttempts: number;
  lastRestartError: string | null;
  outcome: 'recovered' | 'external_action_required' | null;
  guidance: string | null;
  failure?: ContextModeToolFailure;
  transitions: Array<{ state: ContextModeRecoveryState; at: number; error?: string }>;
};

type ContextModeRecoveryOptions = {
  restartOpenCode: () => Promise<unknown> | unknown;
  getActiveSessionCount?: () => number | Promise<number>;
  isExternalOpenCode?: boolean | (() => boolean);
  acquireAdmissionHold?: (
    name: string,
    block: { code: string; error: string; retryAfterSeconds: number },
  ) => (() => unknown);
  recordIncident?: (status: ContextModeRecoveryStatus) => unknown;
  pollIntervalMs?: number;
  retryDelaysMs?: readonly number[];
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  logger?: {
    log?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
  };
};

const isFunction = (value: unknown): value is (...args: never[]) => unknown => typeof value === 'function';
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function isContextModeToolName(tool: unknown): boolean {
  const name = typeof tool === 'string' ? tool.trim().toLowerCase() : '';
  return name.startsWith('ctx_')
    || name.startsWith('mcp__context_mode__')
    || name.startsWith('mcp__context-mode__');
}

export function isContextModeIoerrFailureText(failureText: unknown): boolean {
  const text = typeof failureText === 'string' ? failureText : '';
  return CONTEXT_MODE_IOERR_PATTERNS.some((pattern) => pattern.test(text));
}

export function isContextModeIoerrFailure({
  tool,
  failureText,
}: {
  tool?: unknown;
  failureText?: unknown;
} = {}): boolean {
  return isContextModeToolName(tool) && isContextModeIoerrFailureText(failureText);
}

export function rewriteContextModeWedgeFailureText({
  tool,
  failureText,
}: {
  tool?: unknown;
  failureText?: string | null;
} = {}): string | null | undefined {
  if (!failureText) return failureText ?? null;
  if (!isContextModeIoerrFailure({ tool, failureText })) return failureText;
  return CONTEXT_MODE_WEDGE_FAILURE_TEXT;
}

const toolFailureTextFromPart = (part: Record<string, unknown> | undefined): string => {
  const state = part?.state && typeof part.state === 'object' ? part.state as Record<string, unknown> : null;
  const stateError = state?.error;
  if (typeof stateError === 'string') return stateError;
  if (stateError && typeof stateError === 'object' && typeof (stateError as { message?: unknown }).message === 'string') {
    return (stateError as { message: string }).message;
  }
  return '';
};

export function extractContextModeToolFailure(payload: unknown): ContextModeToolFailure | null {
  if (!payload || typeof payload !== 'object' || (payload as { type?: unknown }).type !== 'message.part.updated') {
    return null;
  }
  const properties = (payload as { properties?: { part?: Record<string, unknown> } }).properties;
  const part = properties?.part;
  if (!part || part.type !== 'tool') return null;
  const state = part.state && typeof part.state === 'object' ? part.state as Record<string, unknown> : null;
  const status = typeof state?.status === 'string' ? state.status.toLowerCase() : '';
  if (status !== 'error') return null;
  const tool = typeof part.tool === 'string' ? part.tool : '';
  const failureText = toolFailureTextFromPart(part);
  if (!isContextModeIoerrFailure({ tool, failureText })) return null;
  return { tool, failureText };
}

const resolveFlag = (value: boolean | (() => boolean) | undefined): boolean => (
  isFunction(value) ? Boolean(value()) : Boolean(value)
);

export function createContextModeRecovery({
  restartOpenCode,
  getActiveSessionCount = () => 0,
  isExternalOpenCode = false,
  acquireAdmissionHold = () => () => {},
  recordIncident = () => {},
  pollIntervalMs = CONTEXT_MODE_RECOVERY_POLL_INTERVAL_MS,
  retryDelaysMs = CONTEXT_MODE_RECOVERY_RETRY_DELAYS_MS,
  now = () => Date.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  logger = console,
}: ContextModeRecoveryOptions) {
  let incident: ContextModeRecoveryStatus | null = null;
  let incidentSequence = 0;
  let releaseAdmission: (() => unknown) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let advancing = false;
  let disposed = false;
  let lastStatus: ContextModeRecoveryStatus = {
    state: 'healthy',
    incidentId: null,
    detectedAt: null,
    updatedAt: now(),
    recoveredAt: null,
    occurrenceCount: 0,
    restartAttempts: 0,
    lastRestartError: null,
    outcome: null,
    guidance: null,
    transitions: [],
  };

  const snapshot = (): ContextModeRecoveryStatus => structuredClone(incident ?? lastStatus);

  const publish = () => {
    lastStatus = snapshot();
    try {
      recordIncident(lastStatus);
    } catch (error) {
      logger.warn?.('[OpenCode] Failed to record context-mode recovery incident:', errorMessage(error));
    }
  };

  const transition = (
    state: ContextModeRecoveryState,
    extra: Partial<ContextModeRecoveryStatus> = {},
  ) => {
    if (!incident) return;
    const at = now();
    incident = {
      ...incident,
      ...extra,
      state,
      updatedAt: at,
      transitions: [...incident.transitions, {
        state,
        at,
        ...(extra.lastRestartError ? { error: extra.lastRestartError } : {}),
      }],
    };
    publish();
  };

  const clearTimer = () => {
    if (!timer) return;
    clearTimeoutFn(timer);
    timer = null;
  };

  const schedule = (callback: () => void, delayMs: number) => {
    clearTimer();
    timer = setTimeoutFn(callback, delayMs);
    if (timer && typeof (timer as NodeJS.Timeout).unref === 'function') {
      (timer as NodeJS.Timeout).unref();
    }
  };

  const releaseHold = () => {
    if (!releaseAdmission) return;
    const release = releaseAdmission;
    releaseAdmission = null;
    try {
      release();
    } catch (error) {
      logger.warn?.('[OpenCode] Failed to release context-mode admission hold:', errorMessage(error));
    }
  };

  const scheduleAdvance = (delayMs: number) => schedule(() => {
    void advance();
  }, delayMs);

  const advance = async () => {
    if (disposed || !incident || advancing || incident.state === 'external_action_required') return;
    advancing = true;
    try {
      let activeCount: number;
      try {
        activeCount = Math.max(0, Number(await getActiveSessionCount()) || 0);
      } catch (error) {
        transition('draining', {
          lastRestartError: `Authoritative session status failed: ${errorMessage(error)}`,
        });
        scheduleAdvance(pollIntervalMs);
        return;
      }

      if (activeCount > 0) {
        scheduleAdvance(pollIntervalMs);
        return;
      }

      const restartAttempts = incident.restartAttempts + 1;
      transition('restarting', { restartAttempts, lastRestartError: null });
      logger.log?.('[OpenCode] Restarting managed OpenCode for context-mode SQLITE_IOERR recovery');
      try {
        await restartOpenCode();
      } catch (error) {
        if (disposed || !incident) return;
        const message = errorMessage(error);
        transition('restarting', { lastRestartError: message });
        const retryDelay = retryDelaysMs[Math.min(
          Math.max(0, restartAttempts - 1),
          retryDelaysMs.length - 1,
        )] ?? 30_000;
        logger.warn?.('[OpenCode] Context-mode recovery restart failed:', message);
        scheduleAdvance(Math.min(30_000, Math.max(1, retryDelay)));
        return;
      }

      if (disposed || !incident) return;
      releaseHold();
      transition('healthy', {
        recoveredAt: now(),
        lastRestartError: null,
        outcome: 'recovered',
      });
      lastStatus = snapshot();
      incident = null;
    } finally {
      advancing = false;
    }
  };

  const observeContextModeToolFailure = (payload: unknown): boolean => {
    if (disposed) return false;
    const failure = extractContextModeToolFailure(payload);
    if (!failure) return false;

    if (incident) {
      incident = {
        ...incident,
        occurrenceCount: incident.occurrenceCount + 1,
        updatedAt: now(),
      };
      publish();
      return true;
    }

    const detectedAt = now();
    incidentSequence += 1;
    incident = {
      state: 'healthy',
      incidentId: `context_mode_recovery_${detectedAt}_${incidentSequence}`,
      detectedAt,
      updatedAt: detectedAt,
      recoveredAt: null,
      occurrenceCount: 1,
      restartAttempts: 0,
      lastRestartError: null,
      outcome: null,
      guidance: null,
      failure,
      transitions: [],
    };

    if (resolveFlag(isExternalOpenCode)) {
      transition('external_action_required', {
        outcome: 'external_action_required',
        guidance: CONTEXT_MODE_EXTERNAL_ACTION_REQUIRED_TEXT,
      });
      logger.warn?.(`[OpenCode] ${CONTEXT_MODE_EXTERNAL_ACTION_REQUIRED_TEXT}`);
      return true;
    }

    releaseAdmission = acquireAdmissionHold('context_mode_recovery', {
      code: 'CONTEXT_MODE_RECOVERY_PENDING',
      error: 'Context-mode recovery is pending; active work is being preserved',
      retryAfterSeconds: 1,
    });
    transition('draining');
    logger.log?.('[OpenCode] Context-mode SQLITE_IOERR detected; prompt admission paused until idle recovery');
    void advance();
    return true;
  };

  const dispose = () => {
    disposed = true;
    clearTimer();
    releaseHold();
    incident = null;
  };

  return {
    observeContextModeToolFailure,
    getStatus: snapshot,
    dispose,
  };
}
