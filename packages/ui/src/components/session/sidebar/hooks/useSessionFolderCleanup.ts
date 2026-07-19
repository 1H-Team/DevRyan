import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { dedupeSessionsById, getArchivedScopeKey, isSessionOwnedByProject, normalizePath, type SessionProjectOwnership } from '../utils';

type NormalizedProject = {
  id: string;
  normalizedPath: string;
};

type Args = {
  isSessionsLoading: boolean;
  hasLoadedGlobalSessions: boolean;
  sessions: Session[];
  archivedSessions: Session[];
  normalizedProjects: NormalizedProject[];
  cleanupSessions: (scopeKey: string, validSessionIds: Set<string>) => void;
  sessionProjectOwnership: SessionProjectOwnership;
};

export const useSessionFolderCleanup = (args: Args): void => {
  const {
    isSessionsLoading,
    hasLoadedGlobalSessions,
    sessions,
    archivedSessions,
    normalizedProjects,
    cleanupSessions,
    sessionProjectOwnership,
  } = args;

  React.useEffect(() => {
    if (isSessionsLoading || !hasLoadedGlobalSessions) {
      return;
    }

    const idsByScope = new Map<string, Set<string>>();
    sessions.forEach((session) => {
      const directory = normalizePath((session as Session & { directory?: string | null }).directory ?? null);
      if (!directory) {
        return;
      }
      const existing = idsByScope.get(directory);
      if (existing) {
        existing.add(session.id);
        return;
      }
      idsByScope.set(directory, new Set([session.id]));
    });

    normalizedProjects.forEach((project) => {
      const scopeKey = getArchivedScopeKey(project.normalizedPath);
      const archivedForProject = dedupeSessionsById([
        ...archivedSessions,
        ...sessions.filter((session) => {
          if (session.time?.archived) {
            return false;
          }
          const sessionDirectory = normalizePath((session as Session & { directory?: string | null }).directory ?? null);
          if (sessionDirectory) {
            return false;
          }
          return isSessionOwnedByProject(session, project.normalizedPath, sessionProjectOwnership);
        }),
      ]).filter((session) => isSessionOwnedByProject(session, project.normalizedPath, sessionProjectOwnership));

      idsByScope.set(scopeKey, new Set(archivedForProject.map((session) => session.id)));
    });

    const currentFoldersMap = useSessionFoldersStore.getState().foldersMap;
    const allScopeKeys = new Set([...Object.keys(currentFoldersMap), ...idsByScope.keys()]);
    allScopeKeys.forEach((scopeKey) => {
      cleanupSessions(scopeKey, idsByScope.get(scopeKey) ?? new Set<string>());
    });
  }, [
    archivedSessions,
    cleanupSessions,
    hasLoadedGlobalSessions,
    isSessionsLoading,
    normalizedProjects,
    sessionProjectOwnership,
    sessions,
  ]);
};
