import { create } from 'zustand';

import {
  invokeDesktop,
  isDesktopLocalOriginActive,
  isElectronShell,
} from '@/lib/desktop';
import { resolveRootSessionID } from '@/lib/sessionLineage';
import { useUIStore } from '@/stores/useUIStore';

export type BrowserAgentLease = {
  leaseId: string;
  rootSessionId: string;
  opencodeSessionID: string;
  directory: string;
  agent: string;
  title: string;
  hostname: string;
  url: string;
  lastActivityAt: number;
  clientAttached: boolean;
};

export type BrowserAgentLeaseSnapshot = {
  revision: number;
  leases: BrowserAgentLease[];
};

export type BrowserAgentWindowContext = {
  rootSessionId: string;
  directory: string;
};

type BrowserAgentClaimSession = {
  id?: unknown;
  parentID?: unknown;
  directory?: unknown;
};

type BrowserAgentClaimTask = {
  rootSessionId?: unknown;
  directory?: unknown;
  status?: unknown;
};

type BrowserAgentLeaseState = {
  revision: number;
  leasesById: ReadonlyMap<string, BrowserAgentLease>;
  leaseIds: readonly string[];
  leaseIdsByRoot: ReadonlyMap<string, readonly string[]>;
  activeLeaseCount: number;
  observedLeaseId: string | null;
  applySnapshot: (snapshot: unknown) => void;
};

const EMPTY_LEASE_IDS: readonly string[] = Object.freeze([]);
const MAX_ID_LENGTH = 180;
const MAX_DIRECTORY_LENGTH = 4096;
const MAX_LABEL_LENGTH = 300;
const MAX_URL_LENGTH = 8192;
const MAX_CLAIM_CONTEXTS_PER_REQUEST = 1_000;
const ACTIVE_MANAGED_TASK_STATUSES = new Set(['queued', 'starting', 'running']);

const normalizeRequiredString = (value: unknown, maxLength: number): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
};

const normalizeOptionalString = (value: unknown, maxLength: number): string => {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
};

export const collectBrowserAgentWindowContexts = ({
  sessions,
  managedTasks = [],
}: {
  sessions: readonly BrowserAgentClaimSession[];
  managedTasks?: readonly BrowserAgentClaimTask[];
}): BrowserAgentWindowContext[] => {
  const lineageSessions = sessions.flatMap((session) => {
    const id = normalizeRequiredString(session.id, MAX_ID_LENGTH);
    if (!id) return [];
    const parentID = normalizeRequiredString(session.parentID, MAX_ID_LENGTH);
    return [{ id, parentID }];
  });
  const contexts: BrowserAgentWindowContext[] = [];
  const seen = new Set<string>();
  const append = (rootSessionIdInput: unknown, directoryInput: unknown) => {
    const rootSessionId = normalizeRequiredString(rootSessionIdInput, MAX_ID_LENGTH);
    const directory = normalizeRequiredString(directoryInput, MAX_DIRECTORY_LENGTH);
    if (!rootSessionId || !directory || rootSessionId.includes('\u0000') || directory.includes('\u0000')) return;
    const key = `${directory}\u0000${rootSessionId}`;
    if (seen.has(key)) return;
    seen.add(key);
    contexts.push({ rootSessionId, directory });
  };

  for (const session of sessions) {
    const sessionId = normalizeRequiredString(session.id, MAX_ID_LENGTH);
    if (!sessionId) continue;
    append(resolveRootSessionID(sessionId, lineageSessions), session.directory);
  }

  // Managed children can begin before their session.created event has reached
  // the renderer. Their task projection is the authoritative early claim for
  // recovered or otherwise unselected background Builder roots.
  for (const task of managedTasks) {
    if (!ACTIVE_MANAGED_TASK_STATUSES.has(String(task.status))) continue;
    append(task.rootSessionId, task.directory);
  }

  return contexts;
};

const normalizeLeaseUrl = (value: unknown): string => {
  const raw = normalizeOptionalString(value, MAX_URL_LENGTH);
  if (!raw) return '';
  if (raw === 'about:blank') return raw;

  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch {
    return '';
  }
};

const sanitizeLease = (value: unknown): BrowserAgentLease | null => {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const leaseId = normalizeRequiredString(candidate.leaseId, MAX_ID_LENGTH);
  const rootSessionId = normalizeRequiredString(candidate.rootSessionId, MAX_ID_LENGTH);
  const opencodeSessionID = normalizeRequiredString(candidate.opencodeSessionID, MAX_ID_LENGTH);
  const directory = normalizeRequiredString(candidate.directory, MAX_DIRECTORY_LENGTH);
  if (!leaseId || !rootSessionId || !opencodeSessionID || !directory) return null;

  const lastActivityAt = typeof candidate.lastActivityAt === 'number'
    && Number.isFinite(candidate.lastActivityAt)
    && candidate.lastActivityAt >= 0
    ? candidate.lastActivityAt
    : 0;

  const url = normalizeLeaseUrl(candidate.url);
  let hostname = normalizeOptionalString(candidate.hostname, MAX_LABEL_LENGTH);
  if (!hostname && url && url !== 'about:blank') {
    try {
      hostname = new URL(url).hostname.slice(0, MAX_LABEL_LENGTH);
    } catch {
      hostname = '';
    }
  }

  return {
    leaseId,
    rootSessionId,
    opencodeSessionID,
    directory,
    agent: normalizeOptionalString(candidate.agent, MAX_LABEL_LENGTH),
    title: normalizeOptionalString(candidate.title, MAX_LABEL_LENGTH),
    hostname,
    url,
    lastActivityAt,
    clientAttached: candidate.clientAttached === true,
  };
};

export const sanitizeBrowserAgentLeaseSnapshot = (value: unknown): BrowserAgentLeaseSnapshot | null => {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { revision?: unknown; leases?: unknown };
  if (
    typeof candidate.revision !== 'number'
    || !Number.isSafeInteger(candidate.revision)
    || candidate.revision < 0
    || !Array.isArray(candidate.leases)
  ) {
    return null;
  }

  const leases: BrowserAgentLease[] = [];
  const seen = new Set<string>();
  for (const rawLease of candidate.leases) {
    const lease = sanitizeLease(rawLease);
    if (!lease || seen.has(lease.leaseId)) continue;
    seen.add(lease.leaseId);
    leases.push(lease);
  }

  return { revision: candidate.revision, leases };
};

const leasesEqual = (left: BrowserAgentLease, right: BrowserAgentLease): boolean => (
  left.leaseId === right.leaseId
  && left.rootSessionId === right.rootSessionId
  && left.opencodeSessionID === right.opencodeSessionID
  && left.directory === right.directory
  && left.agent === right.agent
  && left.title === right.title
  && left.hostname === right.hostname
  && left.url === right.url
  && left.lastActivityAt === right.lastActivityAt
  && left.clientAttached === right.clientAttached
);

const stringArraysEqual = (left: readonly string[], right: readonly string[]): boolean => (
  left === right
  || (left.length === right.length && left.every((value, index) => value === right[index]))
);

const buildRootIndex = (
  leases: readonly BrowserAgentLease[],
  previous: ReadonlyMap<string, readonly string[]>,
): ReadonlyMap<string, readonly string[]> => {
  const grouped = new Map<string, string[]>();
  for (const lease of leases) {
    const ids = grouped.get(lease.rootSessionId) ?? [];
    ids.push(lease.leaseId);
    grouped.set(lease.rootSessionId, ids);
  }

  const next = new Map<string, readonly string[]>();
  for (const [rootSessionId, ids] of grouped) {
    ids.sort();
    const previousIds = previous.get(rootSessionId);
    next.set(rootSessionId, previousIds && stringArraysEqual(previousIds, ids) ? previousIds : ids);
  }

  if (next.size !== previous.size) return next;
  for (const [rootSessionId, ids] of next) {
    if (previous.get(rootSessionId) !== ids) return next;
  }
  return previous;
};

export const useBrowserAgentStore = create<BrowserAgentLeaseState>((set) => ({
  revision: -1,
  leasesById: new Map(),
  leaseIds: EMPTY_LEASE_IDS,
  leaseIdsByRoot: new Map(),
  activeLeaseCount: 0,
  observedLeaseId: null,
  applySnapshot: (value) => {
    const snapshot = sanitizeBrowserAgentLeaseSnapshot(value);
    if (!snapshot) return;

    set((state) => {
      if (snapshot.revision <= state.revision) return state;

      const leasesById = new Map<string, BrowserAgentLease>();
      for (const incoming of snapshot.leases) {
        const previous = state.leasesById.get(incoming.leaseId);
        leasesById.set(incoming.leaseId, previous && leasesEqual(previous, incoming) ? previous : incoming);
      }

      const sortedLeaseIds = [...leasesById.keys()].sort();
      const leaseIds = stringArraysEqual(state.leaseIds, sortedLeaseIds)
        ? state.leaseIds
        : sortedLeaseIds;
      const leaseIdsByRoot = buildRootIndex([...leasesById.values()], state.leaseIdsByRoot);
      const observedLeaseId = state.observedLeaseId && leasesById.has(state.observedLeaseId)
        ? state.observedLeaseId
        : null;

      return {
        revision: snapshot.revision,
        leasesById,
        leaseIds,
        leaseIdsByRoot,
        activeLeaseCount: leaseIds.length,
        observedLeaseId,
      };
    });
  },
}));

export const browserAgentLeaseSelectors = {
  lease: (leaseId: string) => (state: BrowserAgentLeaseState): BrowserAgentLease | null => (
    state.leasesById.get(leaseId) ?? null
  ),
  leaseIdsForRoot: (rootSessionId: string | null | undefined) => (
    state: BrowserAgentLeaseState
  ): readonly string[] => (
    rootSessionId ? state.leaseIdsByRoot.get(rootSessionId) ?? EMPTY_LEASE_IDS : EMPTY_LEASE_IDS
  ),
  activeCountForRoot: (rootSessionId: string | null | undefined) => (
    state: BrowserAgentLeaseState
  ): number => (
    rootSessionId ? state.leaseIdsByRoot.get(rootSessionId)?.length ?? 0 : 0
  ),
};

const isLocalElectronRenderer = (): boolean => (
  isElectronShell() && isDesktopLocalOriginActive()
);

export const canClaimBrowserAgentWindowContexts = (): boolean => isLocalElectronRenderer();

let observedRequestGeneration = 0;

export const setObservedBrowserAgentLease = async (leaseId: string | null): Promise<boolean> => {
  if (!isLocalElectronRenderer()) return false;

  const normalizedLeaseId = typeof leaseId === 'string' && leaseId.trim()
    ? leaseId.trim()
    : null;
  const state = useBrowserAgentStore.getState();
  const nextLeaseId = normalizedLeaseId && state.leasesById.has(normalizedLeaseId)
    ? normalizedLeaseId
    : null;
  if (state.observedLeaseId === nextLeaseId) return true;

  const previousLeaseId = state.observedLeaseId;
  const generation = ++observedRequestGeneration;
  useBrowserAgentStore.setState({ observedLeaseId: nextLeaseId });

  try {
    const result = await invokeDesktop<unknown>('desktop_browser_lease_set_observed', {
      leaseId: nextLeaseId,
    });
    return result !== null;
  } catch {
    if (
      generation === observedRequestGeneration
      && useBrowserAgentStore.getState().observedLeaseId === nextLeaseId
    ) {
      useBrowserAgentStore.setState({ observedLeaseId: previousLeaseId });
    }
    return false;
  }
};

export const claimBrowserAgentWindowContext = async (
  rootSessionId: string | null,
  directory: string,
): Promise<boolean> => {
  if (!isLocalElectronRenderer() || !rootSessionId || !directory.trim()) return false;
  try {
    const result = await invokeDesktop<unknown>('desktop_browser_lease_claim_context', {
      rootSessionId,
      directory: directory.trim(),
    });
    return result !== null;
  } catch {
    return false;
  }
};

export const claimBrowserAgentWindowContexts = async (
  contexts: readonly BrowserAgentWindowContext[],
): Promise<boolean> => {
  if (!isLocalElectronRenderer() || contexts.length === 0) return false;

  const deduped = collectBrowserAgentWindowContexts({
    sessions: [],
    managedTasks: contexts.map((context) => ({
      ...context,
      status: 'running',
    })),
  });
  if (deduped.length === 0) return false;

  try {
    for (let offset = 0; offset < deduped.length; offset += MAX_CLAIM_CONTEXTS_PER_REQUEST) {
      const result = await invokeDesktop<unknown>('desktop_browser_lease_claim_contexts', {
        contexts: deduped.slice(offset, offset + MAX_CLAIM_CONTEXTS_PER_REQUEST),
      });
      if (result === null) return false;
    }
    return true;
  } catch {
    return false;
  }
};

let listenersInstalled = false;

const applyAuthoritativeLeaseSnapshot = (snapshot: unknown): void => {
  const before = useBrowserAgentStore.getState();
  before.applySnapshot(snapshot);
  const after = useBrowserAgentStore.getState();
  if (after.revision === before.revision) return;

  useUIStore.getState().pruneBrowserLeaseTabs(after.leaseIds);
  if (before.observedLeaseId && !after.observedLeaseId) {
    void invokeDesktop('desktop_browser_lease_set_observed', { leaseId: null }).catch(() => {});
  }
};

export const ensureBrowserAgentListeners = (): void => {
  if (listenersInstalled || typeof window === 'undefined' || !isLocalElectronRenderer()) return;
  listenersInstalled = true;

  window.addEventListener('browser-agent-leases', (event: Event) => {
    applyAuthoritativeLeaseSnapshot((event as CustomEvent<unknown>).detail);
  });

  // Events may be emitted while React is still booting. Fetch once after the
  // listener is installed so renderer reloads cannot strand a waiting lease.
  void invokeDesktop<unknown>('desktop_browser_lease_snapshot')
    .then(applyAuthoritativeLeaseSnapshot)
    .catch(() => {});
};
