import { assertRuntimeFeatureAvailable } from './opencode/runtime-capabilities';
import { opencodeClient } from './opencode/client';
import {
  decodedEnvelopeMatchesTask,
  decodeResultEnvelopePayload,
  decodeTaskEventRecord,
  isAutoResumeActiveState,
  type ManagedTaskAutoResume,
  type ManagedTaskWaitingReason,
  type ManagedTaskEventRecord,
  type ManagedTaskResultAction,
  type ManagedTaskResultEnvelope,
} from '@devryan/orchestration-runtime';
import { isRecord } from './decoders/guards';

export type ManagedOrchestrationSnapshot = {
  available: boolean;
  bridgeReady: boolean;
  dispatchReady?: boolean;
  recoveryWarning: string | null;
  tasks: ManagedTaskEventRecord[];
  resultEnvelopes: ManagedTaskResultEnvelope[];
};

export type ManagedTaskProjection = {
  task: ManagedTaskProjectedRecord;
  resultEnvelope?: ManagedTaskProjectedEnvelope;
};

export type ManagedTaskActionResponse = ManagedTaskProjection | {
  tasks: ManagedTaskProjection[];
};

export type ManagedTaskAcknowledgementResponse = {
  resultEnvelope: ManagedTaskResultEnvelope;
  followUpTask: ManagedTaskProjection | null;
};

export type {
  ManagedTaskAutoResume,
  ManagedTaskAutoResumeError,
  ManagedTaskAutoResumeReason,
  ManagedTaskAutoResumeResetSource,
  ManagedTaskAutoResumeState,
  ManagedTaskAutoResumeTarget,
  ManagedTaskWaitingReason,
  ManagedTaskWaitingReasonKind,
} from '@devryan/orchestration-runtime';

export const isManagedTaskAutoResumeActive = (
  autoResume: { enabled: boolean; state: string } | null | undefined,
) => Boolean(autoResume?.enabled && isAutoResumeActiveState(autoResume.state));

/**
 * A task record as the store holds it. The store writes what the orchestration
 * codec decodes (`DecodedManagedTaskEventRecord`, every field present); the
 * recovery and scheduling fields stay optional so wire-shaped records from
 * older hosts and fixtures remain assignable.
 */
export type ManagedTaskProjectedRecord = ManagedTaskEventRecord & {
  recoveryLineageId?: string | null;
  childPromptedAt?: number | null;
  firstAssistantPartAt?: number | null;
  waitingReason?: ManagedTaskWaitingReason | null;
};

/** A result envelope as the store holds it; same optionality rule as the task. */
export type ManagedTaskProjectedEnvelope = ManagedTaskResultEnvelope & {
  providerResetAt?: number | null;
  autoResume?: ManagedTaskAutoResume | null;
};

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

/**
 * The orchestration HTTP API. `handoff` returns a decoded response. The task
 * endpoints return the parsed JSON as `unknown`: the managed-orchestration
 * store decodes each one (orchestration codec, lenient) against the task it
 * acted on. Their wire shapes are the `Managed*Response` types above.
 */
export type ManagedOrchestrationApi = {
  handoff(request: ManagedAgentHandoffRequest): Promise<ManagedAgentHandoffResponse>;
  getSnapshot(options?: { rootSessionId?: string }): Promise<unknown>;
  getTask(taskId: string, scope: { rootSessionId: string; directory?: string }): Promise<unknown>;
  cancelTask(taskId: string, body: {
    rootSessionId: string;
    directory?: string;
    reason?: string;
    cascade?: boolean;
  }): Promise<unknown>;
  acknowledgeTask(taskId: string, body: {
    rootSessionId: string;
    directory?: string;
    action: ManagedTaskResultAction;
    idempotencyKey: string;
    providerId?: string;
    modelId?: string;
    variant?: string | null;
  }): Promise<unknown>;
  setAutoResume(taskId: string, body: {
    rootSessionId: string;
    directory?: string;
    enabled: boolean;
  }): Promise<unknown>;
};

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

const LENIENT = { mode: 'lenient' } as const;

const HANDOFF_STATES: ReadonlySet<string> = new Set(['clear', 'confirmation_required', 'blocked']);

const invalidResponse = () => new ManagedOrchestrationApiError(
  'Managed orchestration returned an invalid response',
  { status: 502, code: 'invalid_response' },
);

/** A `{task, resultEnvelope?}` projection; null when the task or its envelope cannot be shown. */
export const decodeManagedTaskProjection = (value: unknown): ManagedTaskProjection | null => {
  if (!isRecord(value)) return null;
  const task = decodeTaskEventRecord(value.task, LENIENT);
  if (!task) return null;
  if (value.resultEnvelope === undefined) return { task };
  const resultEnvelope = decodeResultEnvelopePayload(value.resultEnvelope, LENIENT);
  return resultEnvelope && decodedEnvelopeMatchesTask(task, resultEnvelope) ? { task, resultEnvelope } : null;
};

/** Decodes a handoff response; a task it cannot show is left out, a malformed response is refused. */
export const decodeManagedAgentHandoffResponse = (value: unknown): ManagedAgentHandoffResponse => {
  if (
    !isRecord(value)
    || typeof value.rootSessionId !== 'string'
    || value.fromMode !== 'orchestrator'
    || value.toMode !== 'builder'
    || typeof value.state !== 'string'
    || !HANDOFF_STATES.has(value.state)
    || !Array.isArray(value.tasks)
    || !Array.isArray(value.failures)
  ) throw invalidResponse();
  const tasks: ManagedTaskProjection[] = [];
  for (const projection of value.tasks) {
    const decoded = decodeManagedTaskProjection(projection);
    if (decoded) tasks.push(decoded);
  }
  const failures: ManagedAgentHandoffResponse['failures'] = [];
  for (const failure of value.failures) {
    if (isRecord(failure) && typeof failure.taskId === 'string' && failure.code === 'cleanup_failed' && typeof failure.message === 'string') {
      failures.push({ taskId: failure.taskId, code: 'cleanup_failed', message: failure.message });
    }
  }
  return {
    rootSessionId: value.rootSessionId,
    fromMode: 'orchestrator',
    toMode: 'builder',
    state: value.state === 'clear' || value.state === 'confirmation_required' ? value.state : 'blocked',
    tasks,
    failures,
  };
};

export const createManagedOrchestrationApi = (options: {
  fetchImpl?: typeof fetch;
} = {}): ManagedOrchestrationApi => {
  const fetchImpl = options.fetchImpl ?? fetch;

  const requestJson = async (input: string, init?: RequestInit): Promise<unknown> => {
    assertRuntimeFeatureAvailable('managedChildTasks');
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
          throw invalidResponse();
        }
      }
    }
    if (!response.ok) throw parseError(response.status, payload);
    return payload;
  };

  const postJson = (input: string, body: object) => requestJson(input, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-DevRyan-CSRF': '1',
    },
    body: JSON.stringify(body),
  });

  return {
    async handoff(request) {
      return decodeManagedAgentHandoffResponse(await postJson('/api/orchestration/handoff', request));
    },
    getSnapshot({ rootSessionId }: { rootSessionId?: string } = {}) {
      const query = new URLSearchParams();
      if (rootSessionId?.trim()) query.set('rootSessionId', rootSessionId.trim());
      const suffix = query.size > 0 ? `?${query.toString()}` : '';
      return requestJson(`/api/orchestration/snapshot${suffix}`, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
    },
    getTask(taskId, scope) {
      const query = new URLSearchParams({ rootSessionId: scope.rootSessionId });
      if (scope.directory?.trim()) query.set('directory', scope.directory.trim());
      return requestJson(
        `/api/orchestration/task/${encodeURIComponent(taskId)}?${query.toString()}`,
        { cache: 'no-store', headers: { Accept: 'application/json' } },
      );
    },
    cancelTask(taskId, body) {
      return postJson(
        `/api/orchestration/task/${encodeURIComponent(taskId)}/cancel`,
        body,
      );
    },
    async acknowledgeTask(taskId, body) {
      assertRuntimeFeatureAvailable('managedChildTasks');
      if (body.action === 'retry' || body.action === 'resume' || body.action === 'retry_in_place') {
        (await opencodeClient.awaitInputSubscription())();
      }
      return postJson(
        `/api/orchestration/task/${encodeURIComponent(taskId)}/acknowledge`,
        body,
      );
    },
    setAutoResume(taskId, body) {
      return postJson(
        `/api/orchestration/task/${encodeURIComponent(taskId)}/auto-resume`,
        body,
      );
    },
  };
};

export const managedOrchestrationApi = createManagedOrchestrationApi();
