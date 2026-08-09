import type { Session } from '@opencode-ai/sdk/v2';
import type { SessionGroup } from './types';

export type BranchSessionCleanupResult = {
  archivedIds: string[];
  failedIds: string[];
};

type ArchiveSessions = (ids: string[]) => Promise<BranchSessionCleanupResult>;

export const resolveBranchGroupLabel = (
  group: Pick<SessionGroup, 'branch' | 'label'>,
): string => group.branch?.trim() || group.label;

export const archiveBranchSessions = async (
  sessions: Session[],
  archiveSessions: ArchiveSessions,
): Promise<BranchSessionCleanupResult> => {
  const ids = [...new Set(sessions.map((session) => session.id))];
  if (ids.length === 0) {
    return { archivedIds: [], failedIds: [] };
  }
  return archiveSessions(ids);
};
