import type {
  ManagedTaskEventRecord,
  ManagedTaskResultAction,
  ManagedTaskResultEnvelope,
} from '@openchamber/orchestration-runtime';

export type ManagedOrchestrationSnapshot = {
  available: boolean;
  bridgeReady: boolean;
  recoveryWarning: string | null;
  tasks: ManagedTaskEventRecord[];
  resultEnvelopes: ManagedTaskResultEnvelope[];
};

export type ManagedTaskProjection = {
  task: ManagedTaskEventRecord;
  resultEnvelope?: ManagedTaskResultEnvelope;
};

export type ManagedTaskActionResponse = ManagedTaskProjection | {
  tasks: ManagedTaskProjection[];
};

export type ManagedTaskAcknowledgementResponse = {
  resultEnvelope: ManagedTaskResultEnvelope;
  followUpTask: ManagedTaskProjection | null;
};

export type ManagedTaskAutoResumeState =
  | 'planning'
  | 'scheduled'
  | 'attempting'
  | 'superseded'
  | 'succeeded'
  | 'ended'
  | 'cancelled'
  | 'exhausted'
  | 'acknowledged';

export type ManagedTaskAutoResumeResetSource = 'opencode_status' | 'meridian_quota' | 'backoff';

export type ManagedTaskAutoResumeTarget = {
  kind: 'backup' | 'original';
  providerId: string;
  modelId: string;
  variant: string | null;
};

export type ManagedTaskAutoResumeError = {
  code: string;
  message: string;
  at: number;
};

/**
 * Host-owned automatic recovery state carried on a usage-limit result
 * envelope. `revision` only moves forward; the store keeps the highest one.
 */
export type ManagedTaskAutoResume = {
  revision: number;
  enabled: boolean;
  state: ManagedTaskAutoResumeState;
  cancelGeneration: number;
  lineageStartedAt: number;
  expiresAt: number;
  attemptCount: number;
  noSignalProbes: number;
  rejectionsInWindow: number;
  windowResetAt: number | null;
  nextAttemptAt: number | null;
  resetAt: number | null;
  resetSource: ManagedTaskAutoResumeResetSource | null;
  target: ManagedTaskAutoResumeTarget | null;
  lastAttemptTaskId: string | null;
  lastAttemptAt: number | null;
  lastError: ManagedTaskAutoResumeError | null;
  hostFailures: number;
  reason: string | null;
};

const MANAGED_TASK_AUTO_RESUME_ACTIVE_STATES: ReadonlySet<ManagedTaskAutoResumeState> = new Set([
  'planning',
  'scheduled',
  'attempting',
]);

export const isManagedTaskAutoResumeActive = (
  autoResume: Pick<ManagedTaskAutoResume, 'enabled' | 'state'> | null | undefined,
) => Boolean(autoResume?.enabled && MANAGED_TASK_AUTO_RESUME_ACTIVE_STATES.has(autoResume.state));

/**
 * Task fields added for automatic recovery. Optional so wire-shaped records from
 * older hosts (and fixtures) stay assignable; the store always writes them,
 * normalizing absent values to null.
 */
export type ManagedTaskRecoveryFields = {
  recoveryLineageId?: string | null;
  childPromptedAt?: number | null;
  firstAssistantPartAt?: number | null;
};

export type ManagedTaskProjectedRecord = ManagedTaskEventRecord & ManagedTaskRecoveryFields;

/** Envelope fields added for automatic recovery; same optionality rule as the task fields. */
export type ManagedTaskEnvelopeRecoveryFields = {
  providerResetAt?: number | null;
  autoResume?: ManagedTaskAutoResume | null;
};

export type ManagedTaskProjectedEnvelope = ManagedTaskResultEnvelope & ManagedTaskEnvelopeRecoveryFields;

export type ManagedTaskAutoResumeResponse = {
  resultEnvelope: ManagedTaskResultEnvelope;
};

export type ManagedAgentHandoffRequest = {
  rootSessionId: string;
  fromMode: 'orchestrator';
  toMode: 'builder';
  confirm: boolean;
  idempotencyKey?: string;
};

export type ManagedAgentHandoffResponse = {
  rootSessionId: string;
  fromMode: 'orchestrator';
  toMode: 'builder';
  state: 'clear' | 'confirmation_required' | 'blocked';
  tasks: ManagedTaskProjection[];
  failures: Array<{
    taskId: string;
    code: 'cleanup_failed';
    message: string;
  }>;
};

export class ManagedOrchestrationApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, options: { status: number; code: string }) {
    super(message);
    this.name = 'ManagedOrchestrationApiError';
    this.status = options.status;
    this.code = options.code;
  }
}

export type ManagedOrchestrationApi = {
  handoff(request: ManagedAgentHandoffRequest): Promise<ManagedAgentHandoffResponse>;
  getSnapshot(options?: { rootSessionId?: string }): Promise<ManagedOrchestrationSnapshot>;
  getTask(taskId: string, scope: { rootSessionId: string; directory?: string }): Promise<ManagedTaskProjection>;
  cancelTask(taskId: string, body: {
    rootSessionId: string;
    directory?: string;
    reason?: string;
    cascade?: boolean;
  }): Promise<ManagedTaskActionResponse>;
  acknowledgeTask(taskId: string, body: {
    rootSessionId: string;
    directory?: string;
    action: ManagedTaskResultAction;
    idempotencyKey: string;
    providerId?: string;
    modelId?: string;
    variant?: string | null;
  }): Promise<ManagedTaskAcknowledgementResponse>;
  setAutoResume(taskId: string, body: {
    rootSessionId: string;
    directory?: string;
    enabled: boolean;
  }): Promise<ManagedTaskAutoResumeResponse>;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const parseError = (status: number, payload: unknown) => {
  const error = isRecord(payload) && isRecord(payload.error) ? payload.error : null;
  const code = typeof error?.code === 'string' && error.code.trim()
    ? error.code
    : 'managed_orchestration_error';
  const message = typeof error?.message === 'string' && error.message.trim()
    ? error.message
    : `Managed orchestration request failed (${status})`;
  return new ManagedOrchestrationApiError(message, { status, code });
};

export const createManagedOrchestrationApi = (options: {
  fetchImpl?: typeof fetch;
} = {}): ManagedOrchestrationApi => {
  const fetchImpl = options.fetchImpl ?? fetch;

  const requestJson = async <T>(input: string, init?: RequestInit): Promise<T> => {
    let response: Response;
    try {
      response = await fetchImpl(input, init);
    } catch (error) {
      throw new ManagedOrchestrationApiError(
        error instanceof Error ? error.message : 'Managed orchestration request failed',
        { status: 0, code: 'network_error' },
      );
    }

    const text = await response.text();
    let payload: unknown = null;
    if (text.trim()) {
      try {
        payload = JSON.parse(text);
      } catch {
        if (response.ok) {
          throw new ManagedOrchestrationApiError(
            'Managed orchestration returned an invalid response',
            { status: 502, code: 'invalid_response' },
          );
        }
      }
    }
    if (!response.ok) throw parseError(response.status, payload);
    return payload as T;
  };

  const postJson = <T>(input: string, body: Record<string, unknown>) => requestJson<T>(input, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-DevRyan-CSRF': '1',
    },
    body: JSON.stringify(body),
  });

  return {
    handoff(request) {
      return postJson<ManagedAgentHandoffResponse>('/api/orchestration/handoff', request);
    },
    getSnapshot({ rootSessionId }: { rootSessionId?: string } = {}) {
      const query = new URLSearchParams();
      if (rootSessionId?.trim()) query.set('rootSessionId', rootSessionId.trim());
      const suffix = query.size > 0 ? `?${query.toString()}` : '';
      return requestJson<ManagedOrchestrationSnapshot>(`/api/orchestration/snapshot${suffix}`, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
    },
    getTask(taskId, scope) {
      const query = new URLSearchParams({ rootSessionId: scope.rootSessionId });
      if (scope.directory?.trim()) query.set('directory', scope.directory.trim());
      return requestJson<ManagedTaskProjection>(
        `/api/orchestration/task/${encodeURIComponent(taskId)}?${query.toString()}`,
        { cache: 'no-store', headers: { Accept: 'application/json' } },
      );
    },
    cancelTask(taskId, body) {
      return postJson<ManagedTaskActionResponse>(
        `/api/orchestration/task/${encodeURIComponent(taskId)}/cancel`,
        body,
      );
    },
    acknowledgeTask(taskId, body) {
      return postJson<ManagedTaskAcknowledgementResponse>(
        `/api/orchestration/task/${encodeURIComponent(taskId)}/acknowledge`,
        body,
      );
    },
    setAutoResume(taskId, body) {
      return postJson<ManagedTaskAutoResumeResponse>(
        `/api/orchestration/task/${encodeURIComponent(taskId)}/auto-resume`,
        body,
      );
    },
  };
};

export const managedOrchestrationApi = createManagedOrchestrationApi();
