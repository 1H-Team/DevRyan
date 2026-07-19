import type { Session } from '@opencode-ai/sdk/v2/client';

import { normalizePath } from '../utils';

export const getSidebarSessionDirectory = (session: Session): string | null => {
  const record = session as Session & {
    directory?: string | null;
    project?: { worktree?: string | null } | null;
  };

  return normalizePath(record.directory ?? null)
    ?? normalizePath(record.project?.worktree ?? null);
};

const getDirectoryComparisonKey = (value?: string | null): string | null => {
  return normalizePath(value)?.toLowerCase() ?? null;
};

export const isActiveSidebarHydrationDirectory = (
  candidateDirectory?: string | null,
  activeDirectory?: string | null,
): boolean => {
  const candidateKey = getDirectoryComparisonKey(candidateDirectory);
  const activeKey = getDirectoryComparisonKey(activeDirectory);
  return candidateKey !== null && activeKey !== null && candidateKey === activeKey;
};

export const isSessionNotFoundHydrationError = (error: unknown): boolean => {
  const value = error as {
    name?: unknown;
    message?: unknown;
    status?: unknown;
    response?: { status?: unknown };
  } | null;

  if (!value || typeof value !== 'object') {
    return false;
  }

  if (value.name === 'NotFoundError') {
    return true;
  }

  if (value.status === 404 || value.response?.status === 404) {
    return true;
  }

  return typeof value.message === 'string' && /session not found/i.test(value.message);
};
