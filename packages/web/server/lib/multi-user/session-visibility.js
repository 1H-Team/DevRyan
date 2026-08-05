const DEFAULT_SESSION_PAGE_LIMIT = 100;
const MAX_SESSION_PAGE_LIMIT = 1_000;

const finiteCursor = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const sessionCursor = (session) => finiteCursor(session?.time?.updated);

export const normalizeSessionPageLimit = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_SESSION_PAGE_LIMIT;
  return Math.min(MAX_SESSION_PAGE_LIMIT, Math.max(1, Math.trunc(parsed)));
};

/**
 * Fill one caller-visible session page without exposing the presence, count, or
 * metadata of sessions owned by another managed user.
 */
export async function listVisibleSessionPage({ limit, cursor = null, fetchPage, isVisible }) {
  const requestedLimit = normalizeSessionPageLimit(limit);
  const visible = [];
  const seenCursors = new Set();
  let upstreamCursor = finiteCursor(cursor);

  while (visible.length < requestedLimit) {
    const cursorKey = upstreamCursor === null ? 'initial' : String(upstreamCursor);
    if (seenCursors.has(cursorKey)) break;
    seenCursors.add(cursorKey);

    const page = await fetchPage({ cursor: upstreamCursor, limit: requestedLimit });
    const sessions = Array.isArray(page?.sessions) ? page.sessions : [];
    if (sessions.length === 0) break;

    for (let index = 0; index < sessions.length; index += 1) {
      const session = sessions[index];
      if (!session?.id || !await isVisible(session)) continue;
      visible.push(session);
      if (visible.length < requestedLimit) continue;

      const moreInCurrentPage = index < sessions.length - 1;
      const moreUpstream = finiteCursor(page?.nextCursor) !== null;
      return {
        sessions: visible,
        nextCursor: moreInCurrentPage || moreUpstream ? sessionCursor(session) : null,
      };
    }

    const declaredCursor = finiteCursor(page?.nextCursor);
    const fallbackCursor = sessions.length >= requestedLimit
      ? sessionCursor(sessions[sessions.length - 1])
      : null;
    const nextCursor = declaredCursor ?? fallbackCursor;
    if (nextCursor === null || (upstreamCursor !== null && nextCursor >= upstreamCursor)) break;
    upstreamCursor = nextCursor;
  }

  return { sessions: visible, nextCursor: null };
}

/**
 * Reconciliation is intentionally strict: a session directory must resolve to
 * assignments belonging to exactly one active user. Multiple matching branches
 * for that same user are reduced deterministically without widening ownership.
 */
export function selectUniqueOwnershipCandidate(candidates, canonicalDirectory) {
  const matches = (Array.isArray(candidates) ? candidates : []).filter((candidate) => (
    candidate?.canonicalDirectory === canonicalDirectory
  ));
  const userIds = new Set(matches.map((candidate) => candidate.userId).filter(Boolean));
  if (userIds.size !== 1) return null;
  return [...matches].sort((left, right) => {
    if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
    return `${left.projectId}\0${left.branchName}`.localeCompare(`${right.projectId}\0${right.branchName}`);
  })[0] || null;
}
