import { create } from 'zustand';
import type { Session } from '@opencode-ai/sdk/v2';
import { isStrictlyOlderSession } from '@/sync/session-recency';
import { opencodeClient } from '@/lib/opencode/client';
import { listGlobalSessionPages } from '@/stores/globalSessions';

type GlobalSessionsStatus = 'idle' | 'loading' | 'ready' | 'error';

type LoadResult = {
  activeSessions: Session[];
  archivedSessions: Session[];
};

type GlobalSessionsSnapshotCompleteness = {
  activeComplete: boolean;
  archivedComplete: boolean;
};

export type GlobalSessionMembershipMutationKind = 'archive' | 'delete' | 'unarchive';

export type GlobalSessionMembershipMutationHandle = Readonly<{
  entries: ReadonlyArray<Readonly<{
    sessionID: string;
    version: number;
  }>>;
}>;

export type BeginGlobalSessionMembershipMutationInput =
  | {
    kind: 'archive';
    sessionIds: string[];
    snapshots: Session[];
    archivedAt: number;
  }
  | {
    kind: 'delete';
    sessionIds: string[];
  }
  | {
    kind: 'unarchive';
    sessionIds: string[];
    snapshots: Session[];
  };

type GlobalSessionMembershipMutationIntent = {
  kind: GlobalSessionMembershipMutationKind;
  version: number;
  phase: 'pending' | 'succeeded';
  desiredSession?: Session;
};

type GlobalSessionsState = {
  activeSessions: Session[];
  archivedSessions: Session[];
  sessionsByDirectory: Map<string, Session[]>;
  hasLoaded: boolean;
  status: GlobalSessionsStatus;
  loadSessions: (fallbackActive?: Session[]) => Promise<LoadResult>;
  applySnapshot: (
    activeSessions: Session[],
    archivedSessions: Session[],
    status?: GlobalSessionsStatus,
    completeness?: GlobalSessionsSnapshotCompleteness,
  ) => void;
  upsertSession: (session: Session) => void;
  restoreSessions: (sessions: Session[]) => void;
  archiveSessionSnapshots: (sessions: Session[], archivedAt?: number) => void;
  removeSessions: (ids: Iterable<string>) => void;
  archiveSessions: (ids: Iterable<string>, archivedAt?: number) => void;
  unarchiveSessions: (ids: Iterable<string>) => void;
};

const PAGE_SIZE = 200;

let inflightLoad: Promise<LoadResult> | null = null;
let postMutationRefreshRequested = false;
let postMutationRefreshPromise: Promise<void> | null = null;
let nextMembershipMutationVersion = 0;
const membershipMutationShadow = new Map<string, GlobalSessionMembershipMutationIntent>();

const COMPLETE_GLOBAL_SNAPSHOT: GlobalSessionsSnapshotCompleteness = {
  activeComplete: true,
  archivedComplete: true,
};

const normalizePath = (value?: string | null): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const replaced = trimmed.replace(/\\/g, '/');
  if (replaced === '/') {
    return '/';
  }
  return replaced.length > 1 ? replaced.replace(/\/+$/, '') : replaced;
};

export const resolveGlobalSessionDirectory = (session: Session): string | null => {
  const record = session as Session & {
    directory?: string | null;
    project?: { worktree?: string | null } | null;
  };

  return normalizePath(record.directory ?? null)
    ?? normalizePath(record.project?.worktree ?? null);
};

const buildSessionsByDirectory = (sessions: Session[]): Map<string, Session[]> => {
  const next = new Map<string, Session[]>();
  for (const session of sessions) {
    const directory = resolveGlobalSessionDirectory(session);
    if (!directory) {
      continue;
    }
    const existing = next.get(directory);
    if (existing) {
      existing.push(session);
      continue;
    }
    next.set(directory, [session]);
  }
  return next;
};

const getSessionSignature = (session: Session): string => {
  return [
    session.id,
    session.title ?? '',
    session.time?.created ?? 0,
    session.time?.updated ?? 0,
    session.time?.archived ?? 0,
    session.share ? 1 : 0,
    resolveGlobalSessionDirectory(session) ?? '',
  ].join(':');
};

const sameSessionList = (prev: Session[], next: Session[]): boolean => {
  if (prev === next) {
    return true;
  }
  if (prev.length !== next.length) {
    return false;
  }
  for (let index = 0; index < prev.length; index += 1) {
    if (getSessionSignature(prev[index]) !== getSessionSignature(next[index])) {
      return false;
    }
  }
  return true;
};

const upsertSessionIntoList = (sessions: Session[], session: Session): Session[] => {
  const index = sessions.findIndex((candidate) => candidate.id === session.id);
  if (index === -1) {
    return [session, ...sessions];
  }
  if (isStrictlyOlderSession(session, sessions[index])) {
    return sessions;
  }
  if (getSessionSignature(sessions[index]) === getSessionSignature(session)) {
    return sessions;
  }
  const next = [...sessions];
  next[index] = session;
  return next;
};

const removeSessionsFromList = (sessions: Session[], ids: Set<string>): Session[] => {
  let removed = false;
  const next = sessions.filter((session) => {
    if (!ids.has(session.id)) {
      return true;
    }
    removed = true;
    return false;
  });

  return removed ? next : sessions;
};

const markSessionArchived = (session: Session, archivedAt: number): Session => ({
  ...session,
  time: {
    ...session.time,
    archived: archivedAt,
  },
});

const markSessionUnarchived = (session: Session): Session => {
  const time = { ...session.time };
  delete time.archived;
  return { ...session, time };
};

const prependDesiredSessions = (sessions: Session[], desiredSessions: Session[]): Session[] => {
  if (desiredSessions.length === 0) {
    return sessions;
  }
  const desiredIds = new Set(desiredSessions.map((session) => session.id));
  const remaining = sessions.filter((session) => !desiredIds.has(session.id));
  return [...desiredSessions, ...remaining];
};

const isMembershipMutationConfirmed = (
  sessionID: string,
  intent: GlobalSessionMembershipMutationIntent,
  activeById: Map<string, Session>,
  archivedById: Map<string, Session>,
  completeness: GlobalSessionsSnapshotCompleteness,
): boolean => {
  if (
    intent.phase !== 'succeeded'
    || !completeness.activeComplete
    || !completeness.archivedComplete
  ) {
    return false;
  }

  const isActive = activeById.has(sessionID);
  const isArchived = archivedById.has(sessionID);
  if (intent.kind === 'archive') {
    return !isActive && isArchived;
  }
  if (intent.kind === 'unarchive') {
    return isActive && !isArchived;
  }
  return !isActive && !isArchived;
};

const reconcileMembershipMutationShadow = (
  activeSessions: Session[],
  archivedSessions: Session[],
  completeness: GlobalSessionsSnapshotCompleteness,
): LoadResult => {
  if (membershipMutationShadow.size === 0) {
    return { activeSessions, archivedSessions };
  }

  const activeById = new Map(activeSessions.map((session) => [session.id, session]));
  const archivedById = new Map(archivedSessions.map((session) => [session.id, session]));
  const protectedIds = new Set<string>();
  const desiredActiveSessions: Session[] = [];
  const desiredArchivedSessions: Session[] = [];

  for (const [sessionID, intent] of membershipMutationShadow) {
    if (isMembershipMutationConfirmed(sessionID, intent, activeById, archivedById, completeness)) {
      membershipMutationShadow.delete(sessionID);
      continue;
    }

    protectedIds.add(sessionID);
    if (intent.kind === 'archive') {
      const desired = archivedById.get(sessionID) ?? intent.desiredSession;
      if (desired) {
        desiredArchivedSessions.push(desired);
      }
      continue;
    }
    if (intent.kind === 'unarchive') {
      const desired = activeById.get(sessionID) ?? intent.desiredSession;
      if (desired) {
        desiredActiveSessions.push(desired);
      }
    }
  }

  if (protectedIds.size === 0) {
    return { activeSessions, archivedSessions };
  }

  return {
    activeSessions: prependDesiredSessions(
      removeSessionsFromList(activeSessions, protectedIds),
      desiredActiveSessions,
    ),
    archivedSessions: prependDesiredSessions(
      removeSessionsFromList(archivedSessions, protectedIds),
      desiredArchivedSessions,
    ),
  };
};

const removeSessionsFromDirectoryMap = (
  directories: Map<string, Session[]>,
  removedSessions: Session[],
): Map<string, Session[]> => {
  if (removedSessions.length === 0) {
    return directories;
  }

  const removedIdsByDirectory = new Map<string, Set<string>>();
  for (const session of removedSessions) {
    const directory = resolveGlobalSessionDirectory(session);
    if (!directory) {
      continue;
    }
    const removedIds = removedIdsByDirectory.get(directory) ?? new Set<string>();
    removedIds.add(session.id);
    removedIdsByDirectory.set(directory, removedIds);
  }

  if (removedIdsByDirectory.size === 0) {
    return directories;
  }

  let changed = false;
  const next = new Map(directories);
  for (const [directory, removedIds] of removedIdsByDirectory) {
    const currentSessions = directories.get(directory);
    if (!currentSessions) {
      continue;
    }

    const nextSessions = currentSessions.filter((session) => !removedIds.has(session.id));
    if (nextSessions.length === currentSessions.length) {
      continue;
    }

    changed = true;
    if (nextSessions.length === 0) {
      next.delete(directory);
    } else {
      next.set(directory, nextSessions);
    }
  }

  return changed ? next : directories;
};

const mergeSessionLists = (existing: Session[], incoming?: Session[]): Session[] => {
  if (!incoming || incoming.length === 0) {
    return existing;
  }

  if (existing.length === 0) {
    return incoming;
  }

  const byId = new Map(existing.map((session) => [session.id, session]));
  incoming.forEach((session) => {
    byId.set(session.id, session);
  });

  const ordered: Session[] = [];
  const seen = new Set<string>();

  existing.forEach((session) => {
    const next = byId.get(session.id);
    if (!next) {
      return;
    }
    ordered.push(next);
    seen.add(session.id);
  });

  incoming.forEach((session) => {
    if (seen.has(session.id)) {
      return;
    }
    const next = byId.get(session.id);
    if (next) {
      ordered.push(next);
      seen.add(session.id);
    }
  });

  return ordered;
};

const applySnapshot = (
  state: GlobalSessionsState,
  activeSessions: Session[],
  archivedSessions: Session[],
  status: GlobalSessionsStatus,
): Partial<GlobalSessionsState> | GlobalSessionsState => {
  const nextActiveSessions = sameSessionList(state.activeSessions, activeSessions)
    ? state.activeSessions
    : activeSessions;
  const nextArchivedSessions = sameSessionList(state.archivedSessions, archivedSessions)
    ? state.archivedSessions
    : archivedSessions;
  const nextSessionsByDirectory = nextActiveSessions === state.activeSessions
    ? state.sessionsByDirectory
    : buildSessionsByDirectory(nextActiveSessions);

  if (
    nextActiveSessions === state.activeSessions
    && nextArchivedSessions === state.archivedSessions
    && nextSessionsByDirectory === state.sessionsByDirectory
    && state.hasLoaded
    && state.status === status
  ) {
    return state;
  }

  return {
    activeSessions: nextActiveSessions,
    archivedSessions: nextArchivedSessions,
    sessionsByDirectory: nextSessionsByDirectory,
    hasLoaded: true,
    status,
  };
};

export const useGlobalSessionsStore = create<GlobalSessionsState>((set, get) => ({
  activeSessions: [],
  archivedSessions: [],
  sessionsByDirectory: new Map(),
  hasLoaded: false,
  status: 'idle',

  applySnapshot: (
    activeSessions,
    archivedSessions,
    status = 'ready',
    completeness = COMPLETE_GLOBAL_SNAPSHOT,
  ) => {
    const reconciled = reconcileMembershipMutationShadow(
      activeSessions,
      archivedSessions,
      completeness,
    );
    set((state) => applySnapshot(
      state,
      reconciled.activeSessions,
      reconciled.archivedSessions,
      status,
    ));
  },

  loadSessions: async (fallbackActive) => {
    if (inflightLoad) {
      return inflightLoad;
    }

    set((state) => (state.status === 'loading' ? state : { status: 'loading' }));

    inflightLoad = (async () => {
      const current = get();

      try {
        const sdk = opencodeClient.getSdkClient();
        const [activeResult, archivedResult] = await Promise.allSettled([
          listGlobalSessionPages(sdk, { archived: false, pageSize: PAGE_SIZE }),
          listGlobalSessionPages(sdk, { archived: true, pageSize: PAGE_SIZE }),
        ]);

        const fallbackSnapshot = mergeSessionLists(current.activeSessions, fallbackActive);
        const nextActiveSessions = activeResult.status === 'fulfilled'
          ? activeResult.value
          : fallbackSnapshot;
        const nextArchivedSessions = archivedResult.status === 'fulfilled'
          ? archivedResult.value
          : current.archivedSessions;

        if (activeResult.status === 'rejected') {
          console.warn('[GlobalSessions] Failed to load active sessions, preserving existing snapshot with fallback merge:', activeResult.reason);
        }
        if (archivedResult.status === 'rejected') {
          console.warn('[GlobalSessions] Failed to load archived sessions, preserving current snapshot:', archivedResult.reason);
        }

        const reconciled = reconcileMembershipMutationShadow(
          nextActiveSessions,
          nextArchivedSessions,
          {
            activeComplete: activeResult.status === 'fulfilled',
            archivedComplete: archivedResult.status === 'fulfilled',
          },
        );
        set((state) => applySnapshot(
          state,
          reconciled.activeSessions,
          reconciled.archivedSessions,
          'ready',
        ));
        return reconciled;
      } catch (error) {
        const nextActiveSessions = mergeSessionLists(current.activeSessions, fallbackActive);
        const nextArchivedSessions = current.archivedSessions;
        console.warn('[GlobalSessions] Failed to load sessions, using fallback snapshot:', error);
        const reconciled = reconcileMembershipMutationShadow(
          nextActiveSessions,
          nextArchivedSessions,
          { activeComplete: false, archivedComplete: false },
        );
        set((state) => applySnapshot(
          state,
          reconciled.activeSessions,
          reconciled.archivedSessions,
          'error',
        ));
        return reconciled;
      } finally {
        inflightLoad = null;
      }
    })();

    return inflightLoad;
  },

  upsertSession: (session) => {
    set((state) => {
      const currentSession = state.activeSessions.find((candidate) => candidate.id === session.id)
        ?? state.archivedSessions.find((candidate) => candidate.id === session.id);
      if (currentSession && isStrictlyOlderSession(session, currentSession)) {
        return state;
      }
      const isArchived = Boolean(session.time?.archived);
      const removedActiveSession = isArchived
        ? state.activeSessions.find((candidate) => candidate.id === session.id)
        : undefined;
      const nextActiveSessions = isArchived
        ? removeSessionsFromList(state.activeSessions, new Set([session.id]))
        : upsertSessionIntoList(state.activeSessions, session);
      const nextArchivedSessions = isArchived
        ? upsertSessionIntoList(state.archivedSessions, session)
        : removeSessionsFromList(state.archivedSessions, new Set([session.id]));

      if (
        nextActiveSessions === state.activeSessions
        && nextArchivedSessions === state.archivedSessions
      ) {
        return state;
      }

      return {
        activeSessions: nextActiveSessions,
        archivedSessions: nextArchivedSessions,
        sessionsByDirectory: isArchived
          ? removeSessionsFromDirectoryMap(state.sessionsByDirectory, removedActiveSession ? [removedActiveSession] : [])
          : nextActiveSessions === state.activeSessions
            ? state.sessionsByDirectory
            : buildSessionsByDirectory(nextActiveSessions),
      };
    });
  },

  restoreSessions: (sessions) => {
    if (sessions.length === 0) {
      return;
    }

    set((state) => {
      let nextActiveSessions = state.activeSessions;
      let nextArchivedSessions = state.archivedSessions;

      for (const session of sessions) {
        const idSet = new Set([session.id]);
        if (session.time?.archived) {
          nextActiveSessions = removeSessionsFromList(nextActiveSessions, idSet);
          nextArchivedSessions = upsertSessionIntoList(nextArchivedSessions, session);
        } else {
          nextArchivedSessions = removeSessionsFromList(nextArchivedSessions, idSet);
          nextActiveSessions = upsertSessionIntoList(nextActiveSessions, session);
        }
      }

      if (
        nextActiveSessions === state.activeSessions
        && nextArchivedSessions === state.archivedSessions
      ) {
        return state;
      }

      return {
        activeSessions: nextActiveSessions,
        archivedSessions: nextArchivedSessions,
        sessionsByDirectory: nextActiveSessions === state.activeSessions
          ? state.sessionsByDirectory
          : buildSessionsByDirectory(nextActiveSessions),
      };
    });
  },

  archiveSessionSnapshots: (sessions, archivedAt = Date.now()) => {
    if (sessions.length === 0) {
      return;
    }

    const idSet = new Set(sessions.map((session) => session.id));
    const archivedSnapshots = sessions.map((session) => ({
      ...session,
      time: {
        ...session.time,
        archived: archivedAt,
      },
    }));

    set((state) => {
      const nextActiveSessions = removeSessionsFromList(state.activeSessions, idSet);
      const remainingArchivedSessions = state.archivedSessions.filter((session) => !idSet.has(session.id));

      return {
        activeSessions: nextActiveSessions,
        archivedSessions: [...archivedSnapshots, ...remainingArchivedSessions],
        sessionsByDirectory: nextActiveSessions === state.activeSessions
          ? state.sessionsByDirectory
          : buildSessionsByDirectory(nextActiveSessions),
      };
    });
  },

  removeSessions: (ids) => {
    const idSet = ids instanceof Set ? ids : new Set(ids);
    if (idSet.size === 0) {
      return;
    }

    set((state) => {
      const removedActiveSessions = state.activeSessions.filter((session) => idSet.has(session.id));
      const nextActiveSessions = removeSessionsFromList(state.activeSessions, idSet);
      const nextArchivedSessions = removeSessionsFromList(state.archivedSessions, idSet);

      if (
        nextActiveSessions.length === state.activeSessions.length
        && nextArchivedSessions.length === state.archivedSessions.length
      ) {
        return state;
      }

      return {
        activeSessions: nextActiveSessions,
        archivedSessions: nextArchivedSessions,
        sessionsByDirectory: removeSessionsFromDirectoryMap(state.sessionsByDirectory, removedActiveSessions),
      };
    });
  },

  archiveSessions: (ids, archivedAt = Date.now()) => {
    const idSet = ids instanceof Set ? ids : new Set(ids);
    if (idSet.size === 0) {
      return;
    }

    set((state) => {
      const movedSessions: Session[] = [];
      const removedActiveSessions: Session[] = [];
      const nextActiveSessions = state.activeSessions.filter((session) => {
        if (!idSet.has(session.id)) {
          return true;
        }

        removedActiveSessions.push(session);
        movedSessions.push({
          ...session,
          time: {
            ...session.time,
            archived: archivedAt,
          },
        });
        return false;
      });

      if (movedSessions.length === 0) {
        return state;
      }

      const remainingArchivedSessions = state.archivedSessions.filter((session) => !idSet.has(session.id));

      return {
        activeSessions: nextActiveSessions,
        archivedSessions: [...movedSessions, ...remainingArchivedSessions],
        sessionsByDirectory: removeSessionsFromDirectoryMap(state.sessionsByDirectory, removedActiveSessions),
      };
    });
  },

  unarchiveSessions: (ids) => {
    const idSet = ids instanceof Set ? ids : new Set(ids);
    if (idSet.size === 0) {
      return;
    }

    set((state) => {
      const movedSessions: Session[] = [];
      const nextArchivedSessions = state.archivedSessions.filter((session) => {
        if (!idSet.has(session.id)) {
          return true;
        }

        const time = { ...session.time };
        delete time.archived;
        movedSessions.push({
          ...session,
          time,
        });
        return false;
      });

      if (movedSessions.length === 0) {
        return state;
      }

      const remainingActiveSessions = state.activeSessions.filter((session) => !idSet.has(session.id));
      const nextActiveSessions = [...movedSessions, ...remainingActiveSessions];

      return {
        activeSessions: nextActiveSessions,
        archivedSessions: nextArchivedSessions,
        sessionsByDirectory: buildSessionsByDirectory(nextActiveSessions),
      };
    });
  },
}));

export const beginGlobalSessionMembershipMutation = (
  input: BeginGlobalSessionMembershipMutationInput,
): GlobalSessionMembershipMutationHandle => {
  const uniqueSessionIds = Array.from(new Set(input.sessionIds.filter(Boolean)));
  const snapshotsById = input.kind === 'delete'
    ? new Map<string, Session>()
    : new Map(input.snapshots.map((session) => [session.id, session]));
  const entries: Array<{ sessionID: string; version: number }> = [];

  for (const sessionID of uniqueSessionIds) {
    const snapshot = snapshotsById.get(sessionID);
    const desiredSession = input.kind === 'archive'
      ? (snapshot ? markSessionArchived(snapshot, input.archivedAt) : undefined)
      : input.kind === 'unarchive'
        ? (snapshot ? markSessionUnarchived(snapshot) : undefined)
        : undefined;
    const version = ++nextMembershipMutationVersion;
    membershipMutationShadow.set(sessionID, {
      kind: input.kind,
      version,
      phase: 'pending',
      desiredSession,
    });
    entries.push({ sessionID, version });
  }

  const idSet = new Set(uniqueSessionIds);
  const desiredSessions = entries
    .map((entry) => membershipMutationShadow.get(entry.sessionID)?.desiredSession)
    .filter((session): session is Session => Boolean(session));

  useGlobalSessionsStore.setState((state) => {
    const remainingActiveSessions = removeSessionsFromList(state.activeSessions, idSet);
    const remainingArchivedSessions = removeSessionsFromList(state.archivedSessions, idSet);
    const nextActiveSessions = input.kind === 'unarchive'
      ? prependDesiredSessions(remainingActiveSessions, desiredSessions)
      : remainingActiveSessions;
    const nextArchivedSessions = input.kind === 'archive'
      ? prependDesiredSessions(remainingArchivedSessions, desiredSessions)
      : remainingArchivedSessions;

    if (
      nextActiveSessions === state.activeSessions
      && nextArchivedSessions === state.archivedSessions
    ) {
      return state;
    }

    return {
      activeSessions: nextActiveSessions,
      archivedSessions: nextArchivedSessions,
      sessionsByDirectory: nextActiveSessions === state.activeSessions
        ? state.sessionsByDirectory
        : buildSessionsByDirectory(nextActiveSessions),
    };
  });

  return { entries };
};

export const settleGlobalSessionMembershipMutation = (
  handle: GlobalSessionMembershipMutationHandle,
  result: { successfulIds: string[]; failedIds: string[] },
): void => {
  const successfulIds = new Set(result.successfulIds);
  const failedIds = new Set(result.failedIds);

  for (const entry of handle.entries) {
    const current = membershipMutationShadow.get(entry.sessionID);
    if (!current || current.version !== entry.version) {
      continue;
    }
    if (failedIds.has(entry.sessionID)) {
      membershipMutationShadow.delete(entry.sessionID);
      continue;
    }
    if (successfulIds.has(entry.sessionID)) {
      membershipMutationShadow.set(entry.sessionID, {
        ...current,
        phase: 'succeeded',
      });
    }
  }
};

export const queueGlobalSessionsRefreshAfterMutation = (): Promise<void> => {
  postMutationRefreshRequested = true;
  if (postMutationRefreshPromise) {
    return postMutationRefreshPromise;
  }

  const runRefreshLoop = async () => {
    while (postMutationRefreshRequested) {
      postMutationRefreshRequested = false;
      const existingLoad = inflightLoad;
      if (existingLoad) {
        await existingLoad;
      }
      await useGlobalSessionsStore.getState().loadSessions();
    }
  };

  postMutationRefreshPromise = runRefreshLoop().finally(() => {
    postMutationRefreshPromise = null;
    if (postMutationRefreshRequested) {
      void queueGlobalSessionsRefreshAfterMutation();
    }
  });
  return postMutationRefreshPromise;
};

export const ensureGlobalSessionsLoaded = async (fallbackActive?: Session[]): Promise<LoadResult> => {
  const state = useGlobalSessionsStore.getState();
  if (state.hasLoaded && state.status !== 'error') {
    return {
      activeSessions: state.activeSessions,
      archivedSessions: state.archivedSessions,
    };
  }
  return state.loadSessions(fallbackActive);
};

export const refreshGlobalSessions = async (fallbackActive?: Session[]): Promise<LoadResult> => {
  return useGlobalSessionsStore.getState().loadSessions(fallbackActive);
};
