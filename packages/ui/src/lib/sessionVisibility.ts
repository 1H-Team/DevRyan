import { isGitGenerationSessionRecord } from '@/lib/git/gitGenerationSessions';

export const SMARTFETCH_SECONDARY_SESSION_TITLE = 'smartfetch-secondary';
export const SESSION_TITLE_HELPER_SESSION_TITLE = 'DevRyan title generation (internal)';

export type SessionVisibilityRecord = {
  id?: string | null;
  title?: string | null;
};

const isSmartFetchSecondarySession = (
  session: SessionVisibilityRecord,
): boolean => (
  typeof session.title === 'string'
  && session.title.trim() === SMARTFETCH_SECONDARY_SESSION_TITLE
);

const isTitleGenerationHelperSession = (
  session: SessionVisibilityRecord,
): boolean => (
  typeof session.title === 'string'
  && session.title.trim() === SESSION_TITLE_HELPER_SESSION_TITLE
);

/**
 * Returns whether a session belongs in user-facing navigation surfaces.
 *
 * SmartFetch creates short-lived root sessions for prompted secondary-model
 * extraction. They remain authoritative OpenCode state while running, but are
 * implementation details rather than chats a user can navigate to.
 */
export const isUserVisibleSessionRecord = (
  session: SessionVisibilityRecord | null | undefined,
): boolean => {
  if (!session) return false;
  return !isGitGenerationSessionRecord(session)
    && !isSmartFetchSecondarySession(session)
    && !isTitleGenerationHelperSession(session);
};

/** Preserve the source array when every session is visible. */
export const filterUserVisibleSessions = <T extends SessionVisibilityRecord>(
  sessions: T[],
): T[] => {
  const firstHiddenIndex = sessions.findIndex(
    (session) => !isUserVisibleSessionRecord(session),
  );
  if (firstHiddenIndex === -1) return sessions;
  return sessions.filter(isUserVisibleSessionRecord);
};
