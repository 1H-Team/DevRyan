import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
export { resolveSessionDiffStats } from '@/lib/sessionDiffStats';
import type { SessionAssistantActivity } from '@/sync/session-assistant-activity';
import type { SessionUserActivity } from '@/sync/session-user-activity';
import type { WorktreeMetadata } from '@/types/worktree';
import type { SessionNode } from './types';

type ArchivedGroupSection = {
  project: { id: string };
  groups: Array<{ id: string; isArchivedBucket?: boolean; sessions?: SessionNode[] }>;
};

type VisibleChatDraft = {
  id: string;
  text: string;
  createdAt: number;
};

export const selectVisibleChatDrafts = <T extends VisibleChatDraft>(
  drafts: T[],
  currentDraftId: string | null,
  promotedDraftIds: ReadonlySet<string> = new Set(),
): T[] => {
  const newestDraftId = drafts.reduce<string | null>((newestId, draft) => {
    if (!newestId) return draft.id;
    const newest = drafts.find((candidate) => candidate.id === newestId);
    return !newest || draft.createdAt > newest.createdAt ? draft.id : newestId;
  }, null);

  return drafts
    .filter((draft) => {
      if (draft.text.trim().length === 0) return false;
      if (promotedDraftIds.has(draft.id)) return false;
      return draft.id !== currentDraftId || draft.id !== newestDraftId;
    })
    .sort((a, b) => b.createdAt - a.createdAt);
};

const formatDateLabel = (value: string | number) => {
  const targetDate = new Date(value);
  const today = new Date();
  const isSameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  if (isSameDay(targetDate, today)) {
    return 'Today';
  }
  if (isSameDay(targetDate, yesterday)) {
    return 'Yesterday';
  }
  const formatted = targetDate.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  return formatted.replace(',', '');
};

export const formatSessionDateLabel = (updatedMs: number): string => {
  const today = new Date();
  const updatedDate = new Date(updatedMs);
  const isSameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  if (isSameDay(updatedDate, today)) {
    const diff = Date.now() - updatedMs;
    if (diff < 60_000) return 'Just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}min ago`;
    return `${Math.floor(diff / 3_600_000)}h ago`;
  }

  return formatDateLabel(updatedMs);
};

export const formatSessionCompactDateLabel = (updatedMs: number): string => {
  const diff = Math.max(0, Date.now() - updatedMs);

  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  const month = 30 * day;
  const year = 365 * day;

  if (diff < hour) {
    return `${Math.max(1, Math.floor(diff / minute))}m`;
  }
  if (diff < day) {
    return `${Math.floor(diff / hour)}h`;
  }
  if (diff < week) {
    return `${Math.floor(diff / day)}d`;
  }
  if (diff < 5 * week) {
    return `${Math.floor(diff / week)}w`;
  }
  if (diff < year) {
    return `${Math.floor(diff / month)}mo`;
  }
  return `${Math.floor(diff / year)}y`;
};

export const normalizePath = (value?: string | null) => {
  if (!value) {
    return null;
  }
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized.length === 0 ? '/' : normalized;
};

export const resolveSessionRoutingDirectory = (
  routingHint?: string | null,
  sessionDirectory?: string | null,
  groupDirectory?: string | null,
): string | null => (
  normalizePath(routingHint)
  ?? normalizePath(sessionDirectory)
  ?? normalizePath(groupDirectory)
);

export const normalizeForBranchComparison = (value: string): string => {
  return value
    .toLowerCase()
    .replace(/^opencode[/-]?/i, '')
    .replace(/[-_]/g, '')
    .trim();
};

export const isBranchDifferentFromLabel = (branch: string | null, label: string): boolean => {
  if (!branch) return false;
  return normalizeForBranchComparison(branch) !== normalizeForBranchComparison(label);
};

const toFiniteNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
};

const getSessionCreatedAt = (session: Session): number => {
  return toFiniteNumber(session.time?.created) ?? 0;
};

const getSessionUpdatedAt = (session: Session): number => {
  return toFiniteNumber(session.time?.updated) ?? toFiniteNumber(session.time?.created) ?? 0;
};

const getCounsellorTitleNumber = (session: Session): number | undefined => {
  const match = /^Counsellor\s+(\d+)\s*:/i.exec((session.title ?? '').trim());
  if (!match) return undefined;
  return toFiniteNumber(match[1]);
};

const compareCounsellorTitles = (a: Session, b: Session): number | undefined => {
  const aNumber = getCounsellorTitleNumber(a);
  const bNumber = getCounsellorTitleNumber(b);
  if (aNumber === undefined || bNumber === undefined) return undefined;
  if (aNumber !== bNumber) return aNumber - bNumber;
  return a.id.localeCompare(b.id);
};

const getSessionArchivedAt = (session: Session): number => {
  return toFiniteNumber(session.time?.archived) ?? 0;
};

const hasParentSession = (session: Session): boolean => {
  return Boolean((session as Session & { parentID?: string | null }).parentID);
};

export const getArchivedParentSessionId = (session: Session): string => {
  return (session as Session & { parentID?: string | null }).parentID || session.id;
};

const getSessionUserActivityAt = (
  session: Session,
  sessionUserActivity?: SessionUserActivity,
): number | undefined => {
  if (hasParentSession(session)) return undefined;
  return toFiniteNumber(sessionUserActivity?.[session.id]);
};

const compareSessionsByUserActivity = (
  a: Session,
  b: Session,
  sessionUserActivity?: SessionUserActivity,
): number => {
  const aUserActivityAt = getSessionUserActivityAt(a, sessionUserActivity);
  const bUserActivityAt = getSessionUserActivityAt(b, sessionUserActivity);
  const aHasUserActivity = aUserActivityAt !== undefined;
  const bHasUserActivity = bUserActivityAt !== undefined;

  if (aHasUserActivity !== bHasUserActivity) {
    return aHasUserActivity ? -1 : 1;
  }

  const aSortAt = aUserActivityAt ?? getSessionCreatedAt(a);
  const bSortAt = bUserActivityAt ?? getSessionCreatedAt(b);
  if (aSortAt !== bSortAt) {
    return bSortAt - aSortAt;
  }

  return getSessionCreatedAt(b) - getSessionCreatedAt(a);
};

export const compareSessionsByPinnedAndTime = (
  a: Session,
  b: Session,
  pinnedSessionIds: Set<string>,
  sessionUserActivity?: SessionUserActivity,
): number => {
  const counsellorDelta = compareCounsellorTitles(a, b);
  if (counsellorDelta !== undefined) return counsellorDelta;

  const aPinned = pinnedSessionIds.has(a.id);
  const bPinned = pinnedSessionIds.has(b.id);
  if (aPinned !== bPinned) {
    return aPinned ? -1 : 1;
  }

  if (aPinned && bPinned) {
    return sessionUserActivity
      ? compareSessionsByUserActivity(a, b, sessionUserActivity)
      : getSessionCreatedAt(b) - getSessionCreatedAt(a);
  }

  return sessionUserActivity
    ? compareSessionsByUserActivity(a, b, sessionUserActivity)
    : getSessionUpdatedAt(b) - getSessionUpdatedAt(a);
};

export const compareSessionsByPinnedAndCreated = (
  a: Session,
  b: Session,
  pinnedSessionIds: Set<string>,
): number => {
  const aPinned = pinnedSessionIds.has(a.id);
  const bPinned = pinnedSessionIds.has(b.id);
  if (aPinned !== bPinned) {
    return aPinned ? -1 : 1;
  }

  return getSessionCreatedAt(b) - getSessionCreatedAt(a);
};

export const compareArchivedSessionsByParentAssistantActivity = (
  a: Session,
  b: Session,
  archivedAssistantActivity?: SessionAssistantActivity,
): number => {
  const aActivityAt = toFiniteNumber(archivedAssistantActivity?.[getArchivedParentSessionId(a)]);
  const bActivityAt = toFiniteNumber(archivedAssistantActivity?.[getArchivedParentSessionId(b)]);
  const aHasActivity = aActivityAt !== undefined;
  const bHasActivity = bActivityAt !== undefined;

  if (aHasActivity !== bHasActivity) {
    return aHasActivity ? -1 : 1;
  }
  if (aActivityAt !== bActivityAt) {
    return (bActivityAt ?? 0) - (aActivityAt ?? 0);
  }

  const archivedDelta = getSessionArchivedAt(b) - getSessionArchivedAt(a);
  if (archivedDelta !== 0) return archivedDelta;

  const createdDelta = getSessionCreatedAt(b) - getSessionCreatedAt(a);
  if (createdDelta !== 0) return createdDelta;

  return a.id.localeCompare(b.id);
};

export const dedupeSessionsById = (sessions: Session[]): Session[] => {
  const byId = new Map<string, Session>();
  sessions.forEach((session) => {
    byId.set(session.id, session);
  });
  return Array.from(byId.values());
};

export const collectArchivedActionSessions = (nodes: SessionNode[]): Session[] => {
  const collected: Session[] = [];
  const visit = (list: SessionNode[]) => {
    list.forEach((node) => {
      if (!node.isArchiveAncestorOnly) {
        collected.push(node.session);
      }
      if (node.children.length > 0) {
        visit(node.children);
      }
    });
  };
  visit(nodes);
  return collected;
};

export const resolveArchivedFolderDisplayNodes = (
  roots: SessionNode[],
  sessionIds: string[],
): SessionNode[] => {
  const wantedIds = new Set(sessionIds);
  const result: SessionNode[] = [];
  const emittedRootIds = new Set<string>();

  const containsWantedSession = (node: SessionNode): boolean => {
    if (wantedIds.has(node.session.id)) {
      return true;
    }
    return node.children.some((child) => containsWantedSession(child));
  };

  roots.forEach((root) => {
    if (!containsWantedSession(root) || emittedRootIds.has(root.session.id)) {
      return;
    }
    emittedRootIds.add(root.session.id);
    result.push(root);
  });

  return result;
};

export const getArchivedScopeKey = (projectRoot: string): string => `__archived__:${projectRoot}`;

export const getArchivedGroupKeys = (sections: ArchivedGroupSection[]): string[] => sections.flatMap((section) =>
  section.groups
    .filter((group) => group.isArchivedBucket)
    .map((group) => `${section.project.id}:${group.id}`),
);

export const addMissingCollapsedGroupKeys = (collapsedGroups: Set<string>, groupKeys: string[]): Set<string> => {
  const missingKeys = groupKeys.filter((key) => !collapsedGroups.has(key));
  if (missingKeys.length === 0) {
    return collapsedGroups;
  }
  return new Set([...collapsedGroups, ...missingKeys]);
};

const collectMatchingArchiveRevealSessionIds = (
  nodes: SessionNode[] | undefined,
  pendingRevealSessionIds: Set<string>,
): Set<string> => {
  const matches = new Set<string>();
  if (!nodes || nodes.length === 0 || pendingRevealSessionIds.size === 0) {
    return matches;
  }

  const visit = (node: SessionNode): void => {
    if (pendingRevealSessionIds.has(node.session.id)) {
      matches.add(node.session.id);
    }
    node.children.forEach(visit);
  };

  nodes.forEach(visit);
  return matches;
};

export const reconcileArchivedGroupCollapse = (input: {
  sections: ArchivedGroupSection[];
  previousVisibleArchivedGroupKeys: Set<string>;
  collapsedGroups: Set<string>;
  pendingRevealSessionIds: Set<string>;
}): {
  collapsedGroups: Set<string>;
  visibleArchivedGroupKeys: Set<string>;
  revealedSessionIds: Set<string>;
} => {
  const archivedGroupKeys = getArchivedGroupKeys(input.sections);
  const visibleArchivedGroupKeys = new Set(archivedGroupKeys);
  const newlyVisibleArchivedGroupKeys = archivedGroupKeys.filter((key) => !input.previousVisibleArchivedGroupKeys.has(key));
  const nextCollapsedGroups = addMissingCollapsedGroupKeys(input.collapsedGroups, newlyVisibleArchivedGroupKeys);
  const revealedSessionIds = new Set<string>();

  if (input.pendingRevealSessionIds.size > 0) {
    input.sections.forEach((section) => {
      section.groups.forEach((group) => {
        if (!group.isArchivedBucket) {
          return;
        }
        const matches = collectMatchingArchiveRevealSessionIds(group.sessions, input.pendingRevealSessionIds);
        if (matches.size === 0) {
          return;
        }
        matches.forEach((sessionId) => revealedSessionIds.add(sessionId));
      });
    });
  }

  return {
    collapsedGroups: nextCollapsedGroups,
    visibleArchivedGroupKeys,
    revealedSessionIds,
  };
};

export const discardPendingArchiveRevealSessionIds = (
  pendingSessionIds: Set<string>,
  sessionIds: Iterable<string>,
): Set<string> => {
  let next: Set<string> | null = null;
  for (const sessionId of sessionIds) {
    if (!pendingSessionIds.has(sessionId)) {
      continue;
    }
    if (!next) {
      next = new Set(pendingSessionIds);
    }
    next.delete(sessionId);
  }
  return next ?? pendingSessionIds;
};

export const resolveArchivedFolderName = (
  session: Session,
  projectRoot: string | null,
  availableWorktrees: WorktreeMetadata[] = [],
): string | null => {
  const sessionDirectory = normalizePath((session as Session & { directory?: string | null }).directory ?? null);
  const projectWorktree = normalizePath((session as Session & { project?: { worktree?: string | null } | null }).project?.worktree ?? null);
  const resolved = sessionDirectory ?? projectWorktree;
  if (!resolved) {
    return 'unassigned';
  }
  if (projectRoot && resolved === projectRoot) {
    return null;
  }
  const matchingWorktree = availableWorktrees.find((meta) => (normalizePath(meta.path) ?? meta.path) === resolved);
  if (matchingWorktree) {
    // Archived groups represent branch/worktree buckets; prefer branch identity over the worktree label.
    const branchLabel = matchingWorktree.branch?.trim();
    if (branchLabel) return branchLabel;
    const worktreeLabel = matchingWorktree.label?.trim() || matchingWorktree.name?.trim();
    if (worktreeLabel) return worktreeLabel;
  }
  const source = projectRoot && resolved.startsWith(`${projectRoot}/`)
    ? resolved.slice(projectRoot.length + 1)
    : resolved;
  const segments = source.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? 'unassigned';
};

export const isSessionRelatedToProject = (
  session: Session,
  projectRoot: string,
  validDirectories?: Set<string>,
): boolean => {
  const sessionDirectory = normalizePath((session as Session & { directory?: string | null }).directory ?? null);
  const projectWorktree = normalizePath((session as Session & { project?: { worktree?: string | null } | null }).project?.worktree ?? null);

  if (projectWorktree && (projectWorktree === projectRoot || projectWorktree.startsWith(`${projectRoot}/`))) {
    return true;
  }

  if (!sessionDirectory) {
    return false;
  }
  if (validDirectories && validDirectories.has(sessionDirectory)) {
    return true;
  }
  return sessionDirectory === projectRoot || sessionDirectory.startsWith(`${projectRoot}/`);
};

export type SessionProjectOwnership = ReadonlyMap<string, string>;

type ProjectOwnershipInput = {
  normalizedPath: string;
};

type ProjectDirectoryOwner = {
  directory: string;
  projectRoot: string;
  isRegisteredProject: boolean;
};

const resolveDirectoryOwner = (
  directory: string,
  directoryOwners: readonly ProjectDirectoryOwner[],
): string | null => {
  for (const owner of directoryOwners) {
    if (directory === owner.directory || directory.startsWith(`${owner.directory}/`)) {
      return owner.projectRoot;
    }
  }
  return null;
};

/**
 * Resolve every session to exactly one registered project. Explicit session
 * directories are authoritative; broad project metadata is only consulted
 * when that field is absent, and parent lineage is the final fallback.
 */
export const buildSessionProjectOwnership = (
  projects: readonly ProjectOwnershipInput[],
  availableWorktreesByProject: ReadonlyMap<string, readonly { path: string }[]>,
  sessions: readonly Session[],
  isVSCode: boolean,
): Map<string, string> => {
  const ownerByDirectory = new Map<string, ProjectDirectoryOwner>();

  for (const project of projects) {
    const projectRoot = normalizePath(project.normalizedPath);
    if (!projectRoot) continue;
    ownerByDirectory.set(projectRoot, {
      directory: projectRoot,
      projectRoot,
      isRegisteredProject: true,
    });
  }

  if (!isVSCode) {
    for (const [rawProjectRoot, worktrees] of availableWorktreesByProject.entries()) {
      const projectRoot = normalizePath(rawProjectRoot);
      if (!projectRoot || !ownerByDirectory.has(projectRoot)) continue;
      for (const worktree of worktrees) {
        const directory = normalizePath(worktree.path);
        if (!directory) continue;
        const existing = ownerByDirectory.get(directory);
        if (existing?.isRegisteredProject) continue;
        ownerByDirectory.set(directory, {
          directory,
          projectRoot,
          isRegisteredProject: false,
        });
      }
    }
  }

  const directoryOwners = [...ownerByDirectory.values()].sort((left, right) => (
    right.directory.length - left.directory.length
    || Number(right.isRegisteredProject) - Number(left.isRegisteredProject)
  ));

  const sessionsById = new Map<string, Session>();
  for (const session of sessions) {
    const previous = sessionsById.get(session.id);
    const previousDirectory = normalizePath((previous as (Session & { directory?: string | null }) | undefined)?.directory ?? null);
    const nextDirectory = normalizePath((session as Session & { directory?: string | null }).directory ?? null);
    if (!previous || (!previousDirectory && nextDirectory)) {
      sessionsById.set(session.id, session);
    }
  }

  const ownership = new Map<string, string>();
  const resolving = new Set<string>();
  const resolveSession = (session: Session): string | null => {
    const cached = ownership.get(session.id);
    if (cached) return cached;
    if (resolving.has(session.id)) return null;
    resolving.add(session.id);

    const record = session as Session & {
      directory?: string | null;
      parentID?: string | null;
      project?: { worktree?: string | null } | null;
    };
    const explicitDirectory = normalizePath(record.directory ?? null);
    const projectWorktree = normalizePath(record.project?.worktree ?? null);

    let owner: string | null = null;
    if (explicitDirectory) {
      owner = resolveDirectoryOwner(explicitDirectory, directoryOwners);
    } else if (projectWorktree) {
      owner = resolveDirectoryOwner(projectWorktree, directoryOwners);
    } else if (record.parentID) {
      const parent = sessionsById.get(record.parentID);
      owner = parent ? resolveSession(parent) : null;
    }

    resolving.delete(session.id);
    if (owner) ownership.set(session.id, owner);
    return owner;
  };

  for (const session of sessionsById.values()) {
    resolveSession(session);
  }
  return ownership;
};

export const isSessionOwnedByProject = (
  session: Session,
  projectRoot: string,
  ownership: SessionProjectOwnership,
): boolean => ownership.get(session.id) === normalizePath(projectRoot);

export const formatProjectLabel = (label: string): string => {
  return label
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
};

export const renderHighlightedText = (text: string, query: string): React.ReactNode => {
  if (!query) {
    return text;
  }

  const loweredText = text.toLowerCase();
  const loweredQuery = query.toLowerCase();
  const queryLength = loweredQuery.length;
  if (queryLength === 0) {
    return text;
  }

  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let matchIndex = loweredText.indexOf(loweredQuery, cursor);

  while (matchIndex !== -1) {
    if (matchIndex > cursor) {
      parts.push(text.slice(cursor, matchIndex));
    }
    const matchText = text.slice(matchIndex, matchIndex + queryLength);
    parts.push(
      <mark
        key={`${matchIndex}-${matchText}`}
        className="bg-primary text-primary-foreground ring-1 ring-primary/90"
      >
        {matchText}
      </mark>,
    );
    cursor = matchIndex + queryLength;
    matchIndex = loweredText.indexOf(loweredQuery, cursor);
  }

  if (cursor < text.length) {
    parts.push(text.slice(cursor));
  }

  return parts.length > 0 ? parts : text;
};
