import type { Session } from '@opencode-ai/sdk/v2';

const normalizeDirectory = (value?: string | null): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized) return value.trim() === '/' ? '/' : null;
  return normalized;
};

const getSessionDirectory = (session: Session): string | null => {
  const record = session as Session & {
    directory?: string | null;
    project?: { worktree?: string | null } | null;
  };
  return normalizeDirectory(record.directory ?? null)
    ?? normalizeDirectory(record.project?.worktree ?? null);
};

export const resolveRoutedSessionDirectory = (
  sessionId: string,
  liveDirectory: string | null | undefined,
  sessions: readonly Session[],
): string | null => {
  const live = normalizeDirectory(liveDirectory);
  if (live) return live;

  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const visited = new Set<string>();
  let current = sessionsById.get(sessionId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    const directory = getSessionDirectory(current);
    if (directory) return directory;
    const parentID = (current as Session & { parentID?: string | null }).parentID;
    current = parentID ? sessionsById.get(parentID) : undefined;
  }
  return null;
};
