import type { Session } from '@opencode-ai/sdk/v2';
import type { StoreApi } from 'zustand';

export const EMPTY_SESSION_CHILDREN: Session[] = [];

export const selectSessionById = (
  sessions: Session[],
  sessionID?: string | null,
): Session | undefined => {
  if (!sessionID) return undefined;
  return sessions.find((session) => session.id === sessionID);
};

export const selectSessionDirectoryById = (
  sessions: Session[],
  sessionID?: string | null,
): string | undefined => {
  const session = selectSessionById(sessions, sessionID) as (Session & { directory?: string | null }) | undefined;
  return session?.directory ?? undefined;
};

/**
 * Project one parent's direct children while retaining the previous array when
 * both membership and child object identities are unchanged.
 */
export const selectSessionChildren = (
  sessions: Session[],
  parentID?: string | null,
  previous: Session[] = EMPTY_SESSION_CHILDREN,
): Session[] => {
  if (!parentID) return EMPTY_SESSION_CHILDREN;

  const next: Session[] = [];
  for (const session of sessions) {
    if (session.parentID === parentID) {
      next.push(session);
    }
  }

  if (next.length === 0) return EMPTY_SESSION_CHILDREN;
  if (
    previous.length === next.length
    && next.every((session, index) => session === previous[index])
  ) {
    return previous;
  }

  return next;
};

/**
 * Subscribe at the session branch boundary so unrelated directory-store writes
 * never ask React to re-read session leaf snapshots.
 */
export const subscribeToSessionBranch = <TState extends { session: Session[] }>(
  store: StoreApi<TState>,
  notify: () => void,
): (() => void) => store.subscribe((state, previous) => {
  if (state.session !== previous.session) {
    notify();
  }
});
