import type {
  ManagedAgentHandoffResponse,
  ManagedOrchestrationApi,
  ManagedTaskProjection,
} from '@/lib/orchestrationApi';

export type AgentHandoffPhase = 'idle' | 'inspecting' | 'confirmation' | 'cleaning' | 'error';

export type AgentHandoffViewState = {
  open: boolean;
  phase: AgentHandoffPhase;
  sessionId: string | null;
  tasks: ManagedTaskProjection[];
  failures: ManagedAgentHandoffResponse['failures'];
  errorMessage: string | null;
};

type PendingHandoff = {
  sessionId: string;
  commitBuilder: () => void;
  restoreOrchestrator?: () => void;
  reconcilePersistedBuilder: boolean;
  restored: boolean;
};

type AgentChangeRequest = {
  sessionId: string | null;
  currentAgentName: string | null | undefined;
  nextAgentName: string;
  commit: () => void;
};

type PersistedBuilderRequest = {
  sessionId: string;
  restoreOrchestrator: () => void;
  commitBuilder: () => void;
};

type CoordinatorOptions = {
  api: Pick<ManagedOrchestrationApi, 'handoff'>;
  createIdempotencyKey?: () => string;
};

const normalizedAgent = (value: string | null | undefined) => (
  typeof value === 'string' ? value.trim().toLowerCase() : ''
);

export const shouldGuardAgentChange = (request: AgentChangeRequest) => (
  Boolean(request.sessionId)
  && normalizedAgent(request.currentAgentName) === 'orchestrator'
  && normalizedAgent(request.nextAgentName) === 'builder'
);

const defaultIdempotencyKey = () => {
  const id = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  return `agent-handoff:${id}`;
};

const idleState = (sessionId: string | null): AgentHandoffViewState => ({
  open: false,
  phase: 'idle',
  sessionId,
  tasks: [],
  failures: [],
  errorMessage: null,
});

const errorMessage = (error: unknown) => (
  error instanceof Error && error.message.trim()
    ? error.message.trim()
    : 'Managed task cleanup could not finish.'
);

export const createAgentHandoffCoordinator = (options: CoordinatorOptions) => {
  let state = idleState(null);
  let generation = 0;
  let pending: PendingHandoff | null = null;
  let pendingInspection: Promise<ManagedAgentHandoffResponse | null> | null = null;
  let pendingInspectionToken: symbol | null = null;
  let cleanupConfirmed = false;
  let idempotencyKey: string | null = null;
  let builderBlockedSessionId: string | null = null;
  const listeners = new Set<() => void>();

  const emit = (next: AgentHandoffViewState) => {
    state = next;
    for (const listener of listeners) listener();
  };

  const reset = (sessionId = state.sessionId) => {
    pending = null;
    pendingInspection = null;
    pendingInspectionToken = null;
    cleanupConfirmed = false;
    idempotencyKey = null;
    builderBlockedSessionId = null;
    emit(idleState(sessionId));
  };

  const restorePersistedBuilder = (request: PendingHandoff) => {
    if (!request.reconcilePersistedBuilder || request.restored) return;
    request.restored = true;
    request.restoreOrchestrator?.();
  };

  const runInspection = (request: PendingHandoff) => {
    if (pendingInspection && pending === request) return pendingInspection;
    pending = request;
    cleanupConfirmed = false;
    idempotencyKey = null;
    if (request.reconcilePersistedBuilder) {
      builderBlockedSessionId = request.sessionId;
    }
    const requestGeneration = ++generation;
    emit({
      ...idleState(request.sessionId),
      phase: 'inspecting',
    });

    const inspectionToken = Symbol(request.sessionId);
    pendingInspectionToken = inspectionToken;
    let handoffRequest: Promise<ManagedAgentHandoffResponse>;
    try {
      handoffRequest = options.api.handoff({
        rootSessionId: request.sessionId,
        fromMode: 'orchestrator',
        toMode: 'builder',
        confirm: false,
      });
    } catch (error) {
      handoffRequest = Promise.reject(error);
    }
    const inspection = (async () => {
      try {
        const result = await handoffRequest;
        if (requestGeneration !== generation || state.sessionId !== request.sessionId) return null;

        if (result.state === 'clear') {
          const commit = request.reconcilePersistedBuilder && !request.restored
            ? null
            : request.commitBuilder;
          reset(request.sessionId);
          commit?.();
          return result;
        }

        restorePersistedBuilder(request);
        builderBlockedSessionId = request.sessionId;
        emit({
          open: true,
          phase: result.state === 'confirmation_required' ? 'confirmation' : 'error',
          sessionId: request.sessionId,
          tasks: result.tasks,
          failures: result.failures,
          errorMessage: result.state === 'blocked'
            ? result.failures[0]?.message ?? 'Managed task cleanup could not finish.'
            : null,
        });
        return result;
      } catch (error) {
        if (requestGeneration !== generation || state.sessionId !== request.sessionId) return null;
        restorePersistedBuilder(request);
        builderBlockedSessionId = request.sessionId;
        emit({
          open: true,
          phase: 'error',
          sessionId: request.sessionId,
          tasks: state.tasks,
          failures: [],
          errorMessage: errorMessage(error),
        });
        return null;
      } finally {
        if (pendingInspectionToken === inspectionToken) {
          pendingInspectionToken = null;
          pendingInspection = null;
        }
      }
    })();
    pendingInspection = inspection;
    return inspection;
  };

  const requestAgentChange = async (request: AgentChangeRequest) => {
    if (!shouldGuardAgentChange(request)) {
      request.commit();
      return null;
    }
    const sessionId = request.sessionId as string;
    if (state.sessionId !== sessionId) {
      generation += 1;
      reset(sessionId);
    }
    if (pendingInspection && pending?.sessionId === sessionId) {
      return await pendingInspection;
    }
    if (pending && pending.sessionId === sessionId && state.open) return null;
    return await runInspection({
      sessionId,
      commitBuilder: request.commit,
      reconcilePersistedBuilder: false,
      restored: false,
    });
  };

  const reconcileBuilderSession = async (request: PersistedBuilderRequest) => {
    if (state.sessionId !== request.sessionId) {
      generation += 1;
      reset(request.sessionId);
    }
    if (pendingInspection && pending?.sessionId === request.sessionId) {
      return await pendingInspection;
    }
    if (pending && pending.sessionId === request.sessionId && state.open) return null;
    return await runInspection({
      sessionId: request.sessionId,
      commitBuilder: request.commitBuilder,
      restoreOrchestrator: request.restoreOrchestrator,
      reconcilePersistedBuilder: true,
      restored: false,
    });
  };

  const runCleanup = async () => {
    const request = pending;
    if (!request || (state.phase !== 'confirmation' && state.phase !== 'error')) return null;
    cleanupConfirmed = true;
    idempotencyKey ??= (options.createIdempotencyKey ?? defaultIdempotencyKey)();
    const requestGeneration = ++generation;
    emit({ ...state, open: true, phase: 'cleaning', errorMessage: null });

    try {
      const result = await options.api.handoff({
        rootSessionId: request.sessionId,
        fromMode: 'orchestrator',
        toMode: 'builder',
        confirm: true,
        idempotencyKey,
      });
      if (requestGeneration !== generation || state.sessionId !== request.sessionId) return null;
      if (result.state === 'clear') {
        const commit = request.commitBuilder;
        reset(request.sessionId);
        commit();
        return result;
      }
      builderBlockedSessionId = request.sessionId;
      emit({
        open: true,
        phase: 'error',
        sessionId: request.sessionId,
        tasks: result.tasks,
        failures: result.failures,
        errorMessage: result.failures[0]?.message ?? 'Managed task cleanup could not finish.',
      });
      return result;
    } catch (error) {
      if (requestGeneration !== generation || state.sessionId !== request.sessionId) return null;
      builderBlockedSessionId = request.sessionId;
      emit({
        ...state,
        open: true,
        phase: 'error',
        errorMessage: errorMessage(error),
      });
      return null;
    }
  };

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setSession(sessionId: string | null) {
      if (state.sessionId === sessionId) return;
      generation += 1;
      reset(sessionId);
    },
    requestAgentChange,
    reconcileBuilderSession,
    confirm: runCleanup,
    retry() {
      if (!pending) return Promise.resolve(null);
      return cleanupConfirmed ? runCleanup() : runInspection(pending);
    },
    cancel() {
      if (state.phase === 'cleaning') return false;
      generation += 1;
      reset(state.sessionId);
      return true;
    },
    isBuilderSendBlocked(sessionId: string | null) {
      return Boolean(sessionId && builderBlockedSessionId === sessionId);
    },
  };
};

export type AgentHandoffCoordinator = ReturnType<typeof createAgentHandoffCoordinator>;
