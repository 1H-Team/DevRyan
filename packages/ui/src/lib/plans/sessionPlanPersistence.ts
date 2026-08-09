import { useSessionPlanFileStore, type SessionPlanFileRecord } from '@/stores/useSessionPlanFileStore';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { RuntimeAPIs, SessionPlansAPI } from '@/lib/api/types';

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
}

const pendingSaves = new Map<string, Promise<SessionPlanFileRecord>>();

const getRuntimeSessionPlans = (): SessionPlansAPI | null => {
  const registered = getRegisteredRuntimeAPIs()?.sessionPlans;
  if (registered) return registered;
  if (typeof window === 'undefined') return null;
  const runtimeWindow = window as typeof window & { __OPENCHAMBER_RUNTIME_APIS__?: RuntimeAPIs };
  return runtimeWindow.__OPENCHAMBER_RUNTIME_APIS__?.sessionPlans ?? null;
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
  const key = persistenceKey(sessionId, sourceMessageId);
  const current = getCurrentRecord(sessionId, sourceMessageId);

  if (current?.status === 'saved' && current.path) {
    return Promise.resolve(current);
  }

  const pending = pendingSaves.get(key);
  if (pending) return pending;

  if (current?.status === 'error' && options.retry !== true) {
    return Promise.resolve(current);
  }

  useSessionPlanFileStore.getState().beginSaving(sessionId, sourceMessageId);

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
      let result;
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
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save plan file';
      useSessionPlanFileStore.getState().markError(sessionId, sourceMessageId, message);
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
