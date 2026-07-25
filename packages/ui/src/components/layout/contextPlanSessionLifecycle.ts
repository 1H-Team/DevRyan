import type { ContextPanelMode } from '@/stores/useUIStore';

type SessionLineageRecord = {
  id?: string | null;
  parentID?: string | null;
};

type ManagedTaskLineageRecord = {
  childSessionId?: string | null;
  rootSessionId?: string | null;
};

const normalizeSessionID = (value: string | null | undefined): string => value?.trim() ?? '';
const normalizePlanPath = (value: string | null | undefined): string => value?.trim().replace(/\\/g, '/') ?? '';

export type ContextPlanSessionChangeAction = 'keep' | 'replace' | 'collapse';

export const isSessionWithinContextPlanOwner = ({
  ownerSessionId,
  currentSessionId,
  sessions,
  managedTasks = [],
}: {
  ownerSessionId: string | null | undefined;
  currentSessionId: string | null;
  sessions: readonly SessionLineageRecord[];
  managedTasks?: readonly ManagedTaskLineageRecord[];
}): boolean => {
  const ownerID = normalizeSessionID(ownerSessionId);
  const currentID = normalizeSessionID(currentSessionId);
  if (!ownerID || !currentID) return false;
  if (ownerID === currentID) return true;

  const sessionsByID = new Map<string, SessionLineageRecord>();
  for (const session of sessions) {
    const sessionID = normalizeSessionID(session.id);
    if (sessionID) sessionsByID.set(sessionID, session);
  }

  const visited = new Set<string>();
  let candidateID = currentID;
  while (candidateID && !visited.has(candidateID)) {
    visited.add(candidateID);
    const parentID = normalizeSessionID(sessionsByID.get(candidateID)?.parentID);
    if (!parentID) break;
    if (parentID === ownerID) return true;
    candidateID = parentID;
  }

  return managedTasks.some((task) => (
    normalizeSessionID(task.childSessionId) === currentID
    && normalizeSessionID(task.rootSessionId) === ownerID
  ));
};

export const shouldCollapseContextPlanForSessionChange = ({
  previousSessionId,
  currentSessionId,
  isPanelOpen,
  activeMode,
  ownerSessionId,
  sessions = [],
  managedTasks = [],
}: {
  previousSessionId: string | null | undefined;
  currentSessionId: string | null;
  isPanelOpen: boolean;
  activeMode: ContextPanelMode | null;
  ownerSessionId?: string | null;
  sessions?: readonly SessionLineageRecord[];
  managedTasks?: readonly ManagedTaskLineageRecord[];
}): boolean => {
  if (
    previousSessionId === undefined
    || previousSessionId === currentSessionId
    || !isPanelOpen
    || activeMode !== 'plan'
  ) {
    return false;
  }

  if (!normalizeSessionID(ownerSessionId)) return true;

  return !isSessionWithinContextPlanOwner({
    ownerSessionId,
    currentSessionId,
    sessions,
    managedTasks,
  });
};

export const resolveContextPlanSessionChange = ({
  previousSessionId,
  currentSessionId,
  isPanelOpen,
  activeMode,
  activeTargetPath,
  ownerSessionId,
  currentSessionPlanPath,
  sessions = [],
  managedTasks = [],
}: {
  previousSessionId: string | null | undefined;
  currentSessionId: string | null;
  isPanelOpen: boolean;
  activeMode: ContextPanelMode | null;
  activeTargetPath?: string | null;
  ownerSessionId?: string | null;
  currentSessionPlanPath?: string | null;
  sessions?: readonly SessionLineageRecord[];
  managedTasks?: readonly ManagedTaskLineageRecord[];
}): ContextPlanSessionChangeAction => {
  if (!isPanelOpen || activeMode !== 'plan') {
    return 'keep';
  }

  const currentID = normalizeSessionID(currentSessionId);
  const ownerID = normalizeSessionID(ownerSessionId);
  const savedPlanPath = normalizePlanPath(currentSessionPlanPath);
  const activePlanPath = normalizePlanPath(activeTargetPath);

  if (
    currentID
    && savedPlanPath
    && (ownerID !== currentID || activePlanPath !== savedPlanPath)
  ) {
    return 'replace';
  }

  if (previousSessionId === undefined || previousSessionId === currentSessionId) {
    return 'keep';
  }

  if (!ownerID) {
    return 'collapse';
  }

  return isSessionWithinContextPlanOwner({
    ownerSessionId: ownerID,
    currentSessionId,
    sessions,
    managedTasks,
  })
    ? 'keep'
    : 'collapse';
};
