export type SessionLineageEntry = {
  id: string;
  parentID?: string | null;
};

const normalizeSessionID = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
};

const buildSessionParentIndex = (
  sessions: readonly SessionLineageEntry[],
): Map<string, string | null> => {
  const parents = new Map<string, string | null>();
  for (const session of sessions) {
    const id = normalizeSessionID(session?.id);
    if (!id) continue;
    parents.set(id, normalizeSessionID(session.parentID));
  }
  return parents;
};

/**
 * Returns the selected session followed by each known ancestor. Missing
 * ancestors are retained by identity so callers can still scope server-owned
 * records before the parent session has materialized in the renderer.
 */
export const resolveSessionLineage = (
  sessionID: string,
  sessions: readonly SessionLineageEntry[],
): string[] => {
  const startID = normalizeSessionID(sessionID);
  if (!startID) return [];

  const parents = buildSessionParentIndex(sessions);
  const lineage: string[] = [];
  const seen = new Set<string>();
  let currentID: string | null = startID;

  while (currentID && !seen.has(currentID)) {
    lineage.push(currentID);
    seen.add(currentID);
    currentID = parents.get(currentID) ?? null;
  }

  return lineage;
};

/**
 * Resolves a stable root identity without looping on corrupt cyclic lineage.
 * A cycle falls back to the selected session rather than arbitrarily assigning
 * it to another member of the cycle.
 */
export const resolveRootSessionID = (
  sessionID: string | null | undefined,
  sessions: readonly SessionLineageEntry[],
): string | null => {
  const startID = normalizeSessionID(sessionID);
  if (!startID) return null;

  const parents = buildSessionParentIndex(sessions);
  const seen = new Set<string>();
  let currentID = startID;

  while (!seen.has(currentID)) {
    seen.add(currentID);
    const parentID = parents.get(currentID) ?? null;
    if (!parentID) return currentID;
    currentID = parentID;
  }

  return startID;
};
