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
  };
};

export const managedOrchestrationApi = createManagedOrchestrationApi();
