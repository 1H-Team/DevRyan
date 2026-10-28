import { useSessionPlanFileStore, type SessionPlanFileRecord } from '@/stores/useSessionPlanFileStore';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { RuntimeAPIs, SessionPlansAPI, SessionPlanSourceIdentity } from '@/lib/api/types';

import { planSettlementWait } from './planSettlement';
import {
  ensureSessionPlanFile,
  type SessionPlanFileIdentity,
  type SessionPlanFileStorage,
} from './sessionPlanFile';

export interface PersistSessionPlanRevisionInput {
  sessionId: string;
  identity: SessionPlanFileIdentity;
  markdown: string;
}

export interface PersistSessionPlanRevisionOptions {
  retry?: boolean;
  storage?: SessionPlanFileStorage;
  validationAttempt?: string;
}

const pendingSaves = new Map<string, Promise<SessionPlanFileRecord>>();

const getRuntimeSessionPlans = (): SessionPlansAPI | null => {
  const registered = getRegisteredRuntimeAPIs()?.sessionPlans;
  if (registered) return registered;
  if (typeof window === 'undefined') return null;
  const runtimeWindow = window as typeof window & { __DEVRYAN_RUNTIME_APIS__?: RuntimeAPIs };
  return runtimeWindow.__DEVRYAN_RUNTIME_APIS__?.sessionPlans ?? null;
};

const persistenceKey = (sessionId: string, sourceMessageId: string): string => (
  `${sessionId.trim()}\u0000${sourceMessageId.trim()}`
);

const getCurrentRecord = (
  sessionId: string,
  sourceMessageId: string,
): SessionPlanFileRecord | undefined => {
  const current = useSessionPlanFileStore.getState().recordsBySession[sessionId];
  return current?.sourceMessageId === sourceMessageId ? current : undefined;
};

export const persistSessionPlanRevision = (
  input: PersistSessionPlanRevisionInput,
  options: PersistSessionPlanRevisionOptions = {},
): Promise<SessionPlanFileRecord> => {
  const sessionId = input.sessionId.trim();
  const sourceMessageId = input.identity.sourceMessageId.trim();
  const key = `${persistenceKey(sessionId, sourceMessageId)}\u0000${options.validationAttempt ?? ''}`;
  const current = getCurrentRecord(sessionId, sourceMessageId);

  if (current?.status === 'saved' && current.path && options.retry !== true
    && (options.validationAttempt === undefined || current.validationAttempt === options.validationAttempt)) {
    return Promise.resolve(current);
  }

  const pending = pendingSaves.get(key);
  if (pending) return pending;

  if (current?.status === 'error' && options.retry !== true
    && (options.validationAttempt === undefined || current.validationAttempt === options.validationAttempt)) {
    return Promise.resolve(current);
  }

  useSessionPlanFileStore.getState().beginSaving(sessionId, sourceMessageId, options.validationAttempt);

  const operation = (async (): Promise<SessionPlanFileRecord> => {
    try {
      const identity = { ...input.identity, sourceMessageId };
      const revisionIdentity = {
        sessionId,
        sourceMessageId,
        directory: identity.projectPath,
        sessionCreated: identity.sessionCreated,
        sessionSlug: identity.sessionSlug,
      };
      let result: { path: string; sourceIdentity?: SessionPlanSourceIdentity; content?: string; version?: string };
      if (options.storage) {
        result = await ensureSessionPlanFile({ identity, markdown: input.markdown, storage: options.storage });
      } else {
        const sessionPlans = getRuntimeSessionPlans();
        if (!sessionPlans) throw new Error('Plan storage is unavailable');
        result = await sessionPlans.ensureRevision({
          ...revisionIdentity,
          markdown: input.markdown,
        });
      }
      useSessionPlanFileStore.getState().markSaved(
        sessionId,
        sourceMessageId,
        result.path,
        revisionIdentity,
        result.sourceIdentity,
        result.content,
        result.version,
        options.validationAttempt,
      );
    } catch (error) {
      // An unsettled run is waited out, not cached as a failure: the record
      // stays saving and the caller's lifecycle retries it.
      const wait = planSettlementWait(error);
      if (wait) {
        useSessionPlanFileStore.getState().markWaiting(sessionId, sourceMessageId, wait.reason, options.validationAttempt);
      } else {
        const message = error instanceof Error ? error.message : 'Failed to save plan file';
        useSessionPlanFileStore.getState().markError(sessionId, sourceMessageId, message, options.validationAttempt);
      }
    }

    return getCurrentRecord(sessionId, sourceMessageId) ?? {
      sourceMessageId,
      path: null,
      revisionIdentity: null,
      status: 'error',
      error: 'Plan revision was superseded before its save completed',
    };
  })();

  pendingSaves.set(key, operation);
  void operation.finally(() => {
    if (pendingSaves.get(key) === operation) {
      pendingSaves.delete(key);
    }
  });
  return operation;
};
