import type { Session } from '@opencode-ai/sdk/v2/client';

import type { SessionNode } from './types';
import {
  getSidebarSessionDirectory,
  isActiveSidebarHydrationDirectory,
} from './hooks/sidebarHydrationUtils';
import { normalizePath } from './utils';

export const SIDEBAR_CHILD_HYDRATION_LIMIT = 40;

export type SidebarChildHydrationTarget = {
  sessionId: string;
  directory: string;
  refreshKey: string;
};

type SidebarChildHydrationSection = {
  projectId: string;
  groups: Array<{
    directory?: string | null;
    isArchivedBucket?: boolean;
    sessions: SessionNode[];
  }>;
};

export const collectSidebarChildHydrationTargets = (input: {
  sections: SidebarChildHydrationSection[];
  collapsedProjectIds: Set<string>;
  currentSessionId: string | null;
  sessions: Session[];
  activeDirectory: string | null;
  limit?: number;
}): SidebarChildHydrationTarget[] => {
  const limit = input.limit ?? SIDEBAR_CHILD_HYDRATION_LIMIT;
  const targets = new Map<string, SidebarChildHydrationTarget>();
  const addRootSession = (session: Session, directoryHint?: string | null) => {
    if ((session as Session & { parentID?: string | null }).parentID) return;

    const directory = normalizePath(getSidebarSessionDirectory(session) ?? directoryHint ?? null);
    if (!directory || !isActiveSidebarHydrationDirectory(directory, input.activeDirectory)) return;

    const key = `${directory}:${session.id}`;
    if (targets.has(key)) return;
    targets.set(key, {
      sessionId: session.id,
      directory,
      refreshKey: [
        session.time?.created ?? 0,
        session.time?.updated ?? 0,
        session.time?.archived ?? 0,
      ].join(':'),
    });
  };

  const visitNodes = (nodes: SessionNode[], directoryHint?: string | null) => {
    for (const node of nodes) {
      if (targets.size >= limit) return;
      addRootSession(node.session, directoryHint);
      if (node.children.length > 0) visitNodes(node.children, directoryHint);
    }
  };

  for (const section of input.sections) {
    if (input.collapsedProjectIds.has(section.projectId)) continue;
    for (const group of section.groups) {
      if (group.isArchivedBucket) continue;
      visitNodes(group.sessions, group.directory);
      if (targets.size >= limit) break;
    }
    if (targets.size >= limit) break;
  }

  const sessionById = new Map(input.sessions.map((session) => [session.id, session]));
  let currentSession = input.currentSessionId ? sessionById.get(input.currentSessionId) ?? null : null;
  const seenCurrentChain = new Set<string>();
  while (currentSession) {
    if (seenCurrentChain.has(currentSession.id)) break;
    seenCurrentChain.add(currentSession.id);
    const parentID = (currentSession as Session & { parentID?: string | null }).parentID;
    if (!parentID) {
      addRootSession(currentSession);
      break;
    }
    currentSession = sessionById.get(parentID) ?? null;
  }

  return Array.from(targets.values());
};
