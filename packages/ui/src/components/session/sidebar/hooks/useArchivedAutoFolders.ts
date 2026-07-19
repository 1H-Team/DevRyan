import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import type { WorktreeMetadata } from '@/types/worktree';
import { dedupeSessionsById, getArchivedScopeKey, isSessionOwnedByProject, normalizePath, resolveArchivedFolderName, type SessionProjectOwnership } from '../utils';

export type ProjectForArchivedFolders = {
  normalizedPath: string;
};

type FolderEntry = {
  id: string;
  name: string;
  sessionIds: string[];
};

type Args = {
  normalizedProjects: ProjectForArchivedFolders[];
  sessions: Session[];
  archivedSessions: Session[];
  availableWorktreesByProject: Map<string, WorktreeMetadata[]>;
  isVSCode: boolean;
  isSessionsLoading: boolean;
  foldersMap: Record<string, FolderEntry[]>;
  createFolder: (scopeKey: string, name: string, parentId?: string | null) => FolderEntry;
  addSessionToFolder: (scopeKey: string, folderId: string, sessionId: string) => void;
  cleanupSessions: (scopeKey: string, existingSessionIds: Set<string>) => void;
  sessionProjectOwnership: SessionProjectOwnership;
};

const getArchivedSessionsForProject = (
  project: ProjectForArchivedFolders,
  params: Pick<Args, 'sessions' | 'archivedSessions' | 'sessionProjectOwnership'>,
): Session[] => {
  const collect = (input: Session[]): Session[] => input.filter((session) =>
    isSessionOwnedByProject(session, project.normalizedPath, params.sessionProjectOwnership),
  );

  const archived = collect(params.archivedSessions);
  const unassignedLive = params.sessions.filter((session) => {
    if (session.time?.archived) {
      return false;
    }
    const sessionDirectory = normalizePath((session as Session & { directory?: string | null }).directory ?? null);
    if (sessionDirectory) {
      return false;
    }
    return isSessionOwnedByProject(session, project.normalizedPath, params.sessionProjectOwnership);
  });

  return dedupeSessionsById([...archived, ...unassignedLive]);
};

export const useArchivedAutoFolders = (args: Args): void => {
  const {
    normalizedProjects,
    sessions,
    archivedSessions,
    availableWorktreesByProject,
    isVSCode,
    isSessionsLoading,
    foldersMap,
    createFolder,
    addSessionToFolder,
    cleanupSessions,
    sessionProjectOwnership,
  } = args;

  React.useEffect(() => {
    if (isSessionsLoading) {
      return;
    }

    normalizedProjects.forEach((project) => {
      const scopeKey = getArchivedScopeKey(project.normalizedPath);
      const worktreesForProject = isVSCode ? [] : (availableWorktreesByProject.get(project.normalizedPath) ?? []);
      const projectArchivedSessions = getArchivedSessionsForProject(project, {
        sessions,
        archivedSessions,
        sessionProjectOwnership,
      });
      const existingFolders = foldersMap[scopeKey] ?? [];
      const folderByName = new Map(existingFolders.map((folder) => [folder.name.toLowerCase(), folder]));
      const folderedSessionIds = new Set<string>();

      projectArchivedSessions.forEach((session) => {
        const folderName = resolveArchivedFolderName(session, project.normalizedPath, worktreesForProject);
        if (!folderName) {
          return;
        }
        folderedSessionIds.add(session.id);
        const key = folderName.toLowerCase();
        let folder = folderByName.get(key);
        if (!folder) {
          folder = createFolder(scopeKey, folderName);
          folderByName.set(key, folder);
        }

        if (!folder.sessionIds.includes(session.id)) {
          addSessionToFolder(scopeKey, folder.id, session.id);
        }
      });

      cleanupSessions(scopeKey, folderedSessionIds);
    });
  }, [
    normalizedProjects,
    sessions,
    archivedSessions,
    availableWorktreesByProject,
    isVSCode,
    isSessionsLoading,
    foldersMap,
    createFolder,
    addSessionToFolder,
    cleanupSessions,
    sessionProjectOwnership,
  ]);
};
