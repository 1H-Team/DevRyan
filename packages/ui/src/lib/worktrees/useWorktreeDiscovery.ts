import { useEffect, useRef } from 'react';
import type { ProjectEntry } from '@/lib/api/types';
import type { AuthPrincipal } from '@/lib/authSession';
import type { WorktreeMetadata } from '@/types/worktree';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { getSafeStorage } from '@/stores/utils/safeStorage';
import { useConfigStore } from '@/stores/useConfigStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { listProjectWorktrees } from './worktreeManager';
import { filterBranchBackedWorktrees, filterWorktreesByGrantedBranches } from './managedBranches';
import { mergeWorktreeDiscovery, retainDiscoveredSessionWorktrees, subscribeWorktreeDiscovery, readWorktreeHistory, writeWorktreeHistory } from './worktreeDiscovery';

const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
// External worktree changes are picked up while the window is visible, without
// running `git worktree list` for every project in hidden windows.
const POLL_INTERVAL_MS = 90_000;
const STALE_AFTER_MS = 60_000;
// Persisted history restores metadata once per page; later removals stick,
// including across remounts of the hook.
let historyApplied = false;

export function useWorktreeDiscovery(projects: ProjectEntry[], principal: AuthPrincipal,
  _currentDirectory?: string | null, visibleDirectories?: Iterable<string>, { poll = true }: { poll?: boolean } = {}) {
  const isConnected = useConfigStore(state => state.isConnected);
  // Grants only filter results: a change re-filters the last listing without
  // any git work. Directory switches never trigger discovery.
  const visibleRef = useRef(visibleDirectories);
  visibleRef.current = visibleDirectories;
  const regrantRef = useRef<(() => void) | null>(null);
  useEffect(() => { regrantRef.current?.(); }, [visibleDirectories]);
  useEffect(() => {
    const storage = getSafeStorage();
    let retainedHistory: Map<string, WorktreeMetadata> | null = historyApplied ? null : readWorktreeHistory(storage);
    const managed = principal.scope === 'managed' && principal.role !== 'admin';
    const listings = new Map<string, WorktreeMetadata[]>();
    let disposed = false;
    let generation = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastRefreshAt = 0;
    // A forced listing stays requested until one runs; a hidden window defers it.
    let pendingForce = false;
    let missedWhileHidden = false;
    const publish = (discovered: Map<string, WorktreeMetadata[]>, history: Map<string, WorktreeMetadata[]>) => {
      useSessionUIStore.setState(state => {
        const sessions = useGlobalSessionsStore.getState();
        let previous = state.worktreeMetadata;
        for (const [id, metadata] of retainedHistory ?? []) {
          if (previous.has(id)) continue;
          if (previous === state.worktreeMetadata) previous = new Map(previous);
          previous.set(id, metadata);
        }
        retainedHistory = null;
        historyApplied = true;
        const worktreeMetadata = retainDiscoveredSessionWorktrees(previous,
          [...sessions.activeSessions, ...sessions.archivedSessions],
          [...state.availableWorktreesByProject.values(), ...history.values()]);
        if (worktreeMetadata !== state.worktreeMetadata) writeWorktreeHistory(storage, worktreeMetadata);
        const next = mergeWorktreeDiscovery(state.availableWorktreesByProject, discovered, new Set(projects.map(project => normalize(project.path))));
        return next === state.availableWorktreesByProject && worktreeMetadata === state.worktreeMetadata ? state
          : { worktreeMetadata, availableWorktreesByProject: next,
            availableWorktrees: next === state.availableWorktreesByProject ? state.availableWorktrees : [...next.values()].flat() };
      });
    };
    const permit = (project: ProjectEntry, entries: WorktreeMetadata[]) => (managed
      ? filterWorktreesByGrantedBranches(entries, project, visibleRef.current) : entries);
    // Grants are applied when publishing, never when a listing resolves, so a
    // grant change during a slow refresh cannot be undone by its result.
    const publishListings = (listed: ReadonlySet<string>) => {
      const discovered = new Map<string, WorktreeMetadata[]>();
      const history = new Map<string, WorktreeMetadata[]>();
      for (const project of projects) {
        const projectPath = normalize(project.path);
        const entries = listed.has(projectPath) ? listings.get(projectPath) : undefined;
        if (entries) {
          const permitted = permit(project, entries);
          history.set(projectPath, permitted);
          discovered.set(projectPath, filterBranchBackedWorktrees(permitted));
        } else if (managed) {
          // Discovery failure cannot retain a grant that has since been revoked.
          const previous = useSessionUIStore.getState().availableWorktreesByProject.get(projectPath) ?? [];
          discovered.set(projectPath, filterWorktreesByGrantedBranches(previous, project, visibleRef.current));
        }
      }
      publish(discovered, history);
    };
    const refresh = async () => {
      if (document.visibilityState === 'hidden') { missedWhileHidden = true; return; }
      const force = pendingForce;
      pendingForce = false; missedWhileHidden = false;
      const request = ++generation;
      lastRefreshAt = Date.now();
      const listed = new Set<string>();
      const results = await Promise.all(projects.map(async project => {
        const projectPath = normalize(project.path);
        try {
          return [projectPath, await listProjectWorktrees({ id: project.id, path: projectPath }, { refresh: force })] as const;
        } catch {
          return [projectPath, null] as const;
        }
      }));
      if (disposed) return;
      // A superseded forced listing is still owed to the next refresh.
      if (request !== generation) { pendingForce ||= force; return; }
      for (const [projectPath, entries] of results) {
        if (entries) { listings.set(projectPath, entries); listed.add(projectPath); }
        else listings.delete(projectPath);
      }
      publishListings(listed);
    };
    const schedule = (force: boolean) => {
      pendingForce ||= force;
      generation++; // Fence an older response immediately, before the debounce.
      clearTimeout(timer);
      timer = setTimeout(() => { void refresh(); }, 150);
    };
    // A mutation bumps the discovery revision, so a cached read is fresh.
    const onInvalidate = () => schedule(false);
    const onReturn = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastRefreshAt >= STALE_AFTER_MS) schedule(true);
      else if (missedWhileHidden) schedule(false);
    };
    const onOnline = () => schedule(true);
    regrantRef.current = () => { if (managed) publishListings(new Set(listings.keys())); };
    const unsubscribe = subscribeWorktreeDiscovery(onInvalidate);
    window.addEventListener('focus', onReturn);
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onReturn);
    const interval = poll ? setInterval(() => {
      if (document.visibilityState === 'visible') schedule(true);
    }, POLL_INTERVAL_MS) : undefined;
    void refresh();
    return () => {
      disposed = true; clearTimeout(timer); clearInterval(interval); unsubscribe();
      regrantRef.current = null;
      window.removeEventListener('focus', onReturn);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, [projects, principal.id, principal.scope, principal.role, isConnected, poll]);
}
