import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { RiDeleteBinLine } from '@remixicon/react';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { useDeviceInfo, useTabletStandalonePwaRuntime } from '@/lib/device';
import { isDesktopShell } from '@/lib/desktop';
import { sessionEvents } from '@/lib/sessionEvents';
import { resolveDisplaySessionTitle } from '@/lib/sessionTitles';
import { formatDirectoryName, cn } from '@/lib/utils';
import { resolveProjectDisplayName } from '@/lib/projectDisplayName';
import { useSessionUIStore, type ChatDraft } from '@/sync/session-ui-store';
import { useAllLiveSessions, useAllSessionUserActivity, useEnsureSessionChildren } from '@/sync/sync-context';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useSync } from '@/sync/use-sync';
import { useSessionPrefetch } from './sidebar/hooks/useSessionPrefetch';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { getSafeStorage } from '@/stores/utils/safeStorage';
import { useGitStore, useGitAllBranches, useGitRepoStatusMap } from '@/stores/useGitStore';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useArchivedAutoFolders } from './sidebar/hooks/useArchivedAutoFolders';
import { useSessionSidebarSections } from './sidebar/hooks/useSessionSidebarSections';
import { useProjectSessionSelection } from './sidebar/hooks/useProjectSessionSelection';
import { useGroupOrdering } from './sidebar/hooks/useGroupOrdering';
import { useSessionGrouping } from './sidebar/hooks/useSessionGrouping';
import { useSessionActions } from './sidebar/hooks/useSessionActions';
import { useSidebarPersistence } from './sidebar/hooks/useSidebarPersistence';
import { useProjectRepoStatus } from './sidebar/hooks/useProjectRepoStatus';
import { useProjectSessionLists } from './sidebar/hooks/useProjectSessionLists';
import { useSessionFolderCleanup } from './sidebar/hooks/useSessionFolderCleanup';
import { useStickyProjectHeaders } from './sidebar/hooks/useStickyProjectHeaders';
import { useSidebarArchivedAssistantActivityHydration } from './sidebar/hooks/useSidebarArchivedAssistantActivityHydration';
import { useSidebarUserActivityHydration } from './sidebar/hooks/useSidebarUserActivityHydration';
import {
  collectSidebarChildHydrationTargets,
  type SidebarChildHydrationTarget,
} from './sidebar/sidebarChildHydration';
import { SessionGroupSection } from './sidebar/SessionGroupSection';
import { SidebarHeader } from './sidebar/SidebarHeader';
import { SidebarFooter } from './sidebar/SidebarFooter';
import { SidebarProjectsList } from './sidebar/SidebarProjectsList';
import { SessionNodeItem } from './sidebar/SessionNodeItem';
import { beginSessionNavigation } from '@/sync/session-load-performance';
import type { SessionSearchDialogItem } from './sidebar/SessionSearchDialog';
import { listProjectWorktrees } from '@/lib/worktrees/worktreeManager';
import {
  filterUserVisibleSessions,
  isUserVisibleSessionRecord,
} from '@/lib/sessionVisibility';
import type { WorktreeMetadata } from '@/types/worktree';
import type { SortableDragHandleProps } from './sidebar/sortableItems';
import type {
  BulkDeleteSessionsConfirmState,
  ArchiveBranchSessionsConfirmState,
  DeleteFolderConfirmState,
  DeleteSessionConfirmState,
} from './sidebar/ConfirmDialogs';
import {
  DeferredSessionDialog,
  LazyBranchSessionArchiveConfirmDialog,
  LazyBulkSessionDeleteConfirmDialog,
  LazyFolderDeleteConfirmDialog,
  LazyNewWorktreeDialog,
  LazyProjectEditDialog,
  LazyScheduledTasksDialog,
  LazySessionDeleteConfirmDialog,
  LazySessionSearchDialog,
} from './sidebar/lazySessionDialogs';
import { LazyBotSidebarSection, LazyViewBoundary } from '@/components/views/lazyViews';
import { BulkActionBar } from './sidebar/BulkActionBar';
import { useSessionMultiSelectStore } from '@/stores/useSessionMultiSelectStore';
import { type SessionGroup, type SessionNode } from './sidebar/types';
import {
  compareSessionsByPinnedAndTime,
  buildSessionProjectOwnership,
  dedupeSessionsById,
  discardPendingArchiveRevealSessionIds,
  normalizePath,
  reconcileArchivedGroupCollapse,
  removeExpandedSessionIds,
  selectVisibleChatDrafts,
} from './sidebar/utils';
import {
  isGlobalSessionDeletionPending,
  refreshGlobalSessions,
  resolveGlobalSessionDirectory,
  useGlobalSessionsStore,
} from '@/stores/useGlobalSessionsStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import type { GitHubAuthStatus } from '@/lib/api/types';
import { markWorktreeBootstrapPending } from '@/lib/worktrees/worktreeBootstrap';
import { hasAuthCapability, useAuthPrincipal } from '@/lib/authSession';
import {
  filterWorktreesByGrantedBranches,
  isManagedBranchGranted,
} from '@/lib/worktrees/managedBranches';
import { archiveBranchSessions } from './sidebar/branchSessionCleanup';
import { useMainSidebarAudienceStore } from '@/stores/useMainSidebarAudienceStore';

const PROJECT_COLLAPSE_STORAGE_KEY = 'oc.sessions.projectCollapse';
const GROUP_ORDER_STORAGE_KEY = 'oc.sessions.groupOrder';
const GROUP_COLLAPSE_STORAGE_KEY = 'oc.sessions.groupCollapse';
const PROJECT_ACTIVE_SESSION_STORAGE_KEY = 'oc.sessions.activeSessionByProject';
const SESSION_EXPANDED_STORAGE_KEY = 'oc.sessions.expandedParents';
const SESSION_PINNED_STORAGE_KEY = 'oc.sessions.pinned';

const buildKnownSessionDirectories = (
  projects: Array<{ path: string }>,
  availableWorktreesByProject: Map<string, WorktreeMetadata[]>,
): Set<string> => {
  const directories = new Set<string>();
  for (const project of projects) {
    const normalized = normalizePath(project.path)?.toLowerCase();
    if (normalized) directories.add(normalized);
  }
  for (const worktrees of availableWorktreesByProject.values()) {
    for (const worktree of worktrees) {
      const normalized = normalizePath(worktree.path)?.toLowerCase();
      if (normalized) directories.add(normalized);
    }
  }
  return directories;
};

const isKnownActiveSessionDirectory = (session: Session, knownDirectories: Set<string>): boolean => {
  if (session.time?.archived) return true;
  const directory = normalizePath(resolveGlobalSessionDirectory(session))?.toLowerCase();
  if (!directory) return true;
  if (knownDirectories.size === 0) return true;
  return knownDirectories.has(directory);
};

const getDraftPreview = (draft: ChatDraft): string => {
  const text = draft.text.trim().split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? '';
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
};

const getDraftDirectory = (draft: ChatDraft): string | null => (
  normalizePath(draft.bootstrapPendingDirectory ?? draft.directoryOverride ?? null)
);

const isPathInProject = (directory: string, projectPath: string): boolean => (
  directory === projectPath || directory.startsWith(`${projectPath}/`)
);

type DraftSidebarListProps = {
  drafts: ChatDraft[];
  currentDraftId: string | null;
  onSelectDraft: (draftId: string) => void;
  onDeleteDraft: (draftId: string) => void;
  mobileVariant: boolean;
  className?: string;
};

const DraftSidebarList: React.FC<DraftSidebarListProps> = ({
  drafts,
  currentDraftId,
  onSelectDraft,
  onDeleteDraft,
  mobileVariant,
  className,
}) => {
  const { t } = useI18n();
  if (drafts.length === 0) return null;

  return (
    <div className={cn('pb-1', className)}>
      <div className="space-y-0.5">
        {drafts.map((draft) => {
          const isActive = draft.id === currentDraftId;
          const preview = getDraftPreview(draft) || t('sessions.sidebar.drafts.emptyPreview');
          return (
            <div key={draft.id} className="group relative flex items-center gap-1">
              <button
                type="button"
                onClick={() => onSelectDraft(draft.id)}
                onAuxClick={(event) => {
                  if (event.button !== 1) return;
                  event.preventDefault();
                  event.stopPropagation();
                  onDeleteDraft(draft.id);
                }}
                className={cn(
                  'min-w-0 flex-1 rounded-sm px-2 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                  isActive
                    ? 'text-primary'
                    : 'text-foreground',
                )}
                aria-label={t('sessions.sidebar.drafts.open')}
              >
                <div className="flex min-w-0 items-baseline gap-1.5">
                  <span className={cn('shrink-0 typography-meta italic', isActive ? 'text-primary' : 'text-muted-foreground')}>
                    {t('sessions.sidebar.drafts.label')}
                  </span>
                  <span className="truncate typography-ui-label">{preview}</span>
                </div>
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onDeleteDraft(draft.id);
                }}
                className={cn(
                  'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                  mobileVariant ? '' : 'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto',
                )}
                aria-label={t('sessions.sidebar.drafts.delete')}
                title={t('sessions.sidebar.drafts.delete')}
              >
                <RiDeleteBinLine className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const SidebarSessionChildrenHydrationItem: React.FC<{ target: SidebarChildHydrationTarget }> = ({ target }) => {
  useEnsureSessionChildren(target.sessionId, target.directory, true, target.refreshKey);
  return null;
};

const SidebarSessionChildrenHydrator: React.FC<{ targets: SidebarChildHydrationTarget[] }> = React.memo(({ targets }) => (
  <>
    {targets.map((target) => (
      <SidebarSessionChildrenHydrationItem
        key={`${target.directory}:${target.sessionId}`}
        target={target}
      />
    ))}
  </>
));
SidebarSessionChildrenHydrator.displayName = 'SidebarSessionChildrenHydrator';

interface SessionSidebarProps {
  mobileVariant?: boolean;
  onSessionSelected?: (sessionId: string) => void;
  allowReselect?: boolean;
  hideDirectoryControls?: boolean;
  showOnlyMainWorkspace?: boolean;
}

export const SessionSidebar: React.FC<SessionSidebarProps> = ({
  mobileVariant = false,
  onSessionSelected,
  allowReselect = false,
  hideDirectoryControls = false,
  showOnlyMainWorkspace = false,
}) => {
  const { t } = useI18n();
  const audience = useMainSidebarAudienceStore((state) => state.audience);
  const setAudience = useMainSidebarAudienceStore((state) => state.setAudience);
  const principal = useAuthPrincipal();
  const canUseBots = hasAuthCapability(principal, 'bots');
  const canManageProjects = hasAuthCapability(principal, 'manageProjects');
  const canCreateWorktrees = hasAuthCapability(principal, 'createWorktrees');
  const canCreateBranches = hasAuthCapability(principal, 'createBranches');
  const canEditProjectMetadata = principal.scope !== 'managed' || principal.role === 'admin';
  const shouldHideProjectAdminControls = hideDirectoryControls || !canManageProjects || !canEditProjectMetadata;
  const isSessionSearchOpen = useUIStore((state) => state.isSessionSearchOpen);
  const setIsSessionSearchOpen = useUIStore((state) => state.setSessionSearchOpen);
  const [sessionSearchQuery, setSessionSearchQuery] = React.useState('');
  const sessionSearchInputRef = React.useRef<HTMLInputElement | null>(null);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editTitle, setEditTitle] = React.useState('');
  const [editingProjectDialogId, setEditingProjectDialogId] = React.useState<string | null>(null);
  const [expandedParents, setExpandedParents] = React.useState<Set<string>>(new Set());
  const [directoryStatus] = React.useState<Map<string, 'unknown' | 'exists' | 'missing'>>(
    () => new Map(),
  );
  const safeStorage = React.useMemo(() => getSafeStorage(), []);
  const [collapsedProjects, setCollapsedProjects] = React.useState<Set<string>>(new Set());

  const [projectRepoStatus, setProjectRepoStatus] = React.useState<Map<string, boolean | null>>(new Map());
  const [expandedSessionGroups, setExpandedSessionGroups] = React.useState<Set<string>>(new Set());
  const [newWorktreeDialogOpen, setNewWorktreeDialogOpen] = React.useState(false);
  const [openSidebarMenuKey, setOpenSidebarMenuKey] = React.useState<string | null>(null);
  const [renamingFolderId, setRenamingFolderId] = React.useState<string | null>(null);
  const [renameFolderDraft, setRenameFolderDraft] = React.useState('');
  const [deleteSessionConfirm, setDeleteSessionConfirm] = React.useState<DeleteSessionConfirmState>(null);
  const [deleteFolderConfirm, setDeleteFolderConfirm] = React.useState<DeleteFolderConfirmState>(null);
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = React.useState<BulkDeleteSessionsConfirmState>(null);
  const [archiveBranchConfirm, setArchiveBranchConfirm] = React.useState<ArchiveBranchSessionsConfirmState>(null);
  const [archiveBranchPending, setArchiveBranchPending] = React.useState(false);
  const archiveBranchPendingRef = React.useRef(false);
  const [bulkDeletePending, setBulkDeletePending] = React.useState(false);
  const bulkDeletePendingRef = React.useRef(false);
  const [pinnedSessionIds, setPinnedSessionIds] = React.useState<Set<string>>(() => {
    try {
      const raw = getSafeStorage().getItem(SESSION_PINNED_STORAGE_KEY);
      if (!raw) {
        return new Set();
      }
      const parsed = JSON.parse(raw) as string[];
      return new Set(Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []);
    } catch {
      return new Set();
    }
  });
  const [collapsedGroups, setCollapsedGroups] = React.useState<Set<string>>(() => {
    try {
      const raw = getSafeStorage().getItem(GROUP_COLLAPSE_STORAGE_KEY);
      if (!raw) {
        return new Set();
      }
      const parsed = JSON.parse(raw) as string[];
      return new Set(Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []);
    } catch {
      return new Set();
    }
  });
  const [groupOrderByProject, setGroupOrderByProject] = React.useState<Map<string, string[]>>(() => {
    try {
      const raw = getSafeStorage().getItem(GROUP_ORDER_STORAGE_KEY);
      if (!raw) {
        return new Map();
      }
      const parsed = JSON.parse(raw) as Record<string, string[]>;
      const next = new Map<string, string[]>();
      Object.entries(parsed).forEach(([projectId, order]) => {
        if (Array.isArray(order)) {
          next.set(projectId, order.filter((item) => typeof item === 'string'));
        }
      });
      return next;
    } catch {
      return new Map();
    }
  });
  const [activeSessionByProject, setActiveSessionByProject] = React.useState<Map<string, string>>(() => {
    try {
      const raw = getSafeStorage().getItem(PROJECT_ACTIVE_SESSION_STORAGE_KEY);
      if (!raw) {
        return new Map();
      }
      const parsed = JSON.parse(raw) as Record<string, string>;
      const next = new Map<string, string>();
      Object.entries(parsed).forEach(([projectId, sessionId]) => {
        if (typeof sessionId === 'string' && sessionId.length > 0) {
          next.set(projectId, sessionId);
        }
      });
      return next;
    } catch {
      return new Map();
    }
  });

  const [projectRootBranches, setProjectRootBranches] = React.useState<Map<string, string>>(new Map());
  const projectHeaderSentinelRefs = React.useRef<Map<string, HTMLDivElement | null>>(new Map());
  const ignoreIntersectionUntil = React.useRef<number>(0);

  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const setDirectory = useDirectoryStore((state) => state.setDirectory);

  const projects = useProjectsStore((state) => state.projects);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const removeProject = useProjectsStore((state) => state.removeProject);
  const setActiveProjectIdOnly = useProjectsStore((state) => state.setActiveProjectIdOnly);
  const updateProjectMeta = useProjectsStore((state) => state.updateProjectMeta);
  const reorderProjects = useProjectsStore((state) => state.reorderProjects);

  const setActiveMainTab = useUIStore((state) => state.setActiveMainTab);
  const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setSessionSwitcherOpen = useUIStore((state) => state.setSessionSwitcherOpen);
  const isScheduledTasksDialogOpen = useUIStore((state) => state.isScheduledTasksDialogOpen);
  const setScheduledTasksDialogOpen = useUIStore((state) => state.setScheduledTasksDialogOpen);
  const setMultiRunLauncherOpen = useUIStore((state) => state.setMultiRunLauncherOpen);
  const toggleSidebar = useUIStore((state) => state.toggleSidebar);
  const notifyOnSubtasks = useUIStore((state) => state.notifyOnSubtasks);
  const showDeletionDialog = useUIStore((state) => state.showDeletionDialog);
  const setShowDeletionDialog = useUIStore((state) => state.setShowDeletionDialog);

  const debouncedSessionSearchQuery = useDebouncedValue(sessionSearchQuery, 120);
  const normalizedSessionSearchQuery = React.useMemo(
    () => debouncedSessionSearchQuery.trim().toLowerCase(),
    [debouncedSessionSearchQuery],
  );

  const hasSessionSearchQuery = normalizedSessionSearchQuery.length > 0;

  // Session Folders store
  const collapsedFolderIds = useSessionFoldersStore((state) => state.collapsedFolderIds);
  const foldersMap = useSessionFoldersStore((state) => state.foldersMap);
  const getFoldersForScope = useSessionFoldersStore((state) => state.getFoldersForScope);
  const createFolder = useSessionFoldersStore((state) => state.createFolder);
  const renameFolder = useSessionFoldersStore((state) => state.renameFolder);
  const deleteFolder = useSessionFoldersStore((state) => state.deleteFolder);
  const addSessionToFolder = useSessionFoldersStore((state) => state.addSessionToFolder);
  const addSessionsToFolder = useSessionFoldersStore((state) => state.addSessionsToFolder);
  const removeSessionFromFolder = useSessionFoldersStore((state) => state.removeSessionFromFolder);
  const removeSessionsFromFolders = useSessionFoldersStore((state) => state.removeSessionsFromFolders);
  const toggleFolderCollapse = useSessionFoldersStore((state) => state.toggleFolderCollapse);
  const cleanupSessions = useSessionFoldersStore((state) => state.cleanupSessions);
  const getSessionFolderId = useSessionFoldersStore((state) => state.getSessionFolderId);

  const gitBranches = useGitAllBranches();

  const sync = useSync();
  const prepareSession = React.useCallback((sessionId: string, sessionDirectory: string) => {
    beginSessionNavigation(sessionId, sessionDirectory);
    void sync.ensureSessionRenderable(sessionId, {
      directory: sessionDirectory,
      reason: 'selected',
    });
  }, [sync]);
  const liveSessions = useAllLiveSessions();
  const sessionUserActivity = useAllSessionUserActivity();
  const hasLoadedGlobalSessions = useGlobalSessionsStore((state) => state.hasLoaded);
  const globalActiveSessions = useGlobalSessionsStore((state) => state.activeSessions);
  const globalArchivedSessions = useGlobalSessionsStore((state) => state.archivedSessions);
  const archivedSessions = React.useMemo(
    () => filterUserVisibleSessions(globalArchivedSessions),
    [globalArchivedSessions],
  );
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentDraftId = useSessionUIStore((state) => state.currentDraftId);
  const draftOrder = useSessionUIStore((state) => state.draftOrder);
  const draftsById = useSessionUIStore((state) => state.draftsById);
  const chatDrafts = React.useMemo(
    () => draftOrder.map((id) => draftsById[id]).filter((draft): draft is ChatDraft => Boolean(draft)),
    [draftOrder, draftsById],
  );
  const newSessionDraftOpen = useSessionUIStore((state) => Boolean(state.currentDraftId && state.newSessionDraft?.open));
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const selectNewSessionDraft = useSessionUIStore((state) => state.selectNewSessionDraft);
  const deleteNewSessionDraft = useSessionUIStore((state) => state.deleteNewSessionDraft);
  const updateSessionTitle = useSessionUIStore((state) => state.updateSessionTitle);
  const shareSession = useSessionUIStore((state) => state.shareSession);
  const unshareSession = useSessionUIStore((state) => state.unshareSession);
  // sessionAttentionStates removed — now using notification-store directly in SessionNodeItem
  const worktreeMetadata = useSessionUIStore((state) => state.worktreeMetadata);
  const availableWorktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);
  const openNewSessionDraft = useSessionUIStore((state) => state.openNewSessionDraft);
  const knownSessionDirectories = React.useMemo(
    () => buildKnownSessionDirectories(projects, availableWorktreesByProject),
    [availableWorktreesByProject, projects],
  );

  const sessions = React.useMemo(() => {
    const visibleLiveSessions = liveSessions.filter((session) => !isGlobalSessionDeletionPending(session.id));
    const visibleGlobalSessions = globalActiveSessions.filter((session) => !isGlobalSessionDeletionPending(session.id));
    const liveById = new Map(visibleLiveSessions.map((session) => [session.id, session]));
    const merged = visibleGlobalSessions.map((session) => liveById.get(session.id) ?? session);
    const seenIds = new Set(merged.map((session) => session.id));

    visibleLiveSessions.forEach((session) => {
      if (seenIds.has(session.id)) {
        return;
      }
      merged.push(session);
    });

    return merged.filter((session) => (
      isKnownActiveSessionDirectory(session, knownSessionDirectories)
      && isUserVisibleSessionRecord(session)
    ));
  }, [globalActiveSessions, knownSessionDirectories, liveSessions]);

  const managedVisibleWorktreeDirectories = React.useMemo(() => {
    const directories = new Set<string>();
    const addDirectory = (value: string | null | undefined) => {
      const normalized = normalizePath(value ?? null);
      if (normalized) directories.add(normalized);
    };
    [...globalActiveSessions, ...liveSessions].forEach((session) => {
      addDirectory((session as Session & { directory?: string | null }).directory);
    });
    chatDrafts.forEach((draft) => {
      addDirectory(draft.directoryOverride ?? draft.bootstrapPendingDirectory ?? null);
    });
    return directories;
  }, [chatDrafts, globalActiveSessions, liveSessions]);

  const archivedAssistantActivity = useSidebarArchivedAssistantActivityHydration(
    sessions,
    archivedSessions,
    currentDirectory,
  );
  useSidebarUserActivityHydration(sessions, sessionUserActivity, currentDirectory);

  const liveSessionStructureSignature = React.useMemo(
    () => liveSessions
      .map((session) => {
        const directory = normalizePath((session as Session & { directory?: string | null }).directory ?? null) ?? '';
        const parentID = (session as Session & { parentID?: string | null }).parentID ?? '';
        return `${session.id}:${session.time?.archived ? 1 : 0}:${directory}:${parentID}`;
      })
      .sort()
      .join('|'),
    [liveSessions],
  );

  const syncSessionsSnapshotRef = React.useRef<Session[]>(liveSessions);
  React.useEffect(() => {
    syncSessionsSnapshotRef.current = liveSessions;
  }, [liveSessions]);

  React.useEffect(() => {
    void refreshGlobalSessions(syncSessionsSnapshotRef.current);
  }, [currentDirectory, liveSessionStructureSignature]);

  React.useEffect(() => {
    let cancelled = false;

    const discoverWorktrees = async () => {
      const projectEntries = useProjectsStore.getState().projects;
      if (projectEntries.length === 0) return;

      const worktreesByProject = new Map<string, WorktreeMetadata[]>();
      const allWorktrees: WorktreeMetadata[] = [];

      await Promise.all(
        projectEntries.map(async (project) => {
          const projectPath = normalizePath(project.path);
          if (!projectPath) return;
          const filterByGrant = principal.scope === 'managed' && principal.role !== 'admin';
          try {
            // Use store-cached isGitRepo when available; fall back to direct check for initial worktree discovery
            const cachedIsGitRepo = useGitStore.getState().directories.get(projectPath)?.isGitRepo;
            const isGitRepo = cachedIsGitRepo ?? await import('@/lib/gitApi').then(m => m.checkIsGitRepository(projectPath));
            if (!isGitRepo) return;
            const discoveredWorktrees = await listProjectWorktrees({ id: project.id, path: projectPath });
            const worktrees = filterByGrant
              ? filterWorktreesByGrantedBranches(discoveredWorktrees, project, managedVisibleWorktreeDirectories)
              : discoveredWorktrees;
            if (cancelled || worktrees.length === 0) return;
            worktreesByProject.set(projectPath, worktrees);
            allWorktrees.push(...worktrees);
          } catch {
            // ignore discovery errors
          }
        }),
      );

      if (cancelled) return;

      useSessionUIStore.setState({
        availableWorktrees: allWorktrees,
        availableWorktreesByProject: worktreesByProject,
      });
    };

    void discoverWorktrees();

    return () => {
      cancelled = true;
    };
  }, [currentDirectory, managedVisibleWorktreeDirectories, principal.role, principal.scope, projects]);

  React.useEffect(() => {
    let refreshTimeout: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeOpenchamberEvents((event) => {
      if (event.type !== 'scheduled-task-ran') {
        return;
      }
      if (refreshTimeout) {
        clearTimeout(refreshTimeout);
      }
      refreshTimeout = setTimeout(() => {
        void refreshGlobalSessions(syncSessionsSnapshotRef.current);
      }, 500);
    });
    return () => {
      if (refreshTimeout) {
        clearTimeout(refreshTimeout);
      }
      unsubscribe();
    };
  }, []);

  const isDesktopShellRuntime = React.useMemo(() => isDesktopShell(), []);
  const isTabletStandalonePwa = useTabletStandalonePwaRuntime();

  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);
  const {
    buildGroupSearchText,
    filterSessionNodesForSearch,
    buildGroupedSessions,
  } = useSessionGrouping({
    homeDirectory,
    worktreeMetadata,
    pinnedSessionIds,
    sessionUserActivity,
    archivedAssistantActivity,
    gitBranches,
    isVSCode,
  });
  const { isTablet } = useDeviceInfo();
  const alwaysShowSidebarActions = mobileVariant || isTablet;
  const isWebRuntime = !mobileVariant && !isVSCode && !isDesktopShellRuntime;
  const hideSearchInSidebarHeader = isDesktopShellRuntime && !mobileVariant && !isVSCode;

  const { scheduleCollapsedProjectsPersist } = useSidebarPersistence({
    isVSCode,
    hasLoadedGlobalSessions,
    safeStorage,
    keys: {
      sessionExpanded: SESSION_EXPANDED_STORAGE_KEY,
      projectCollapse: PROJECT_COLLAPSE_STORAGE_KEY,
      sessionPinned: SESSION_PINNED_STORAGE_KEY,
      groupOrder: GROUP_ORDER_STORAGE_KEY,
      projectActiveSession: PROJECT_ACTIVE_SESSION_STORAGE_KEY,
      groupCollapse: GROUP_COLLAPSE_STORAGE_KEY,
    },
    sessions,
    pinnedSessionIds,
    setPinnedSessionIds,
    groupOrderByProject,
    activeSessionByProject,
    collapsedGroups,
    setExpandedParents,
    setCollapsedProjects,
  });

  const togglePinnedSession = React.useCallback((sessionId: string) => {
    setPinnedSessionIds((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  }, []);

  const sortedSessions = React.useMemo(() => {
    return [...sessions].sort((a, b) => compareSessionsByPinnedAndTime(a, b, pinnedSessionIds, sessionUserActivity));
  }, [sessions, pinnedSessionIds, sessionUserActivity]);

  const sessionOrderIndex = React.useMemo(
    () => new Map(sortedSessions.map((session, index) => [session.id, index])),
    [sortedSessions],
  );

  const childrenMap = React.useMemo(() => {
    const map = new Map<string, Session[]>();
    sortedSessions.forEach((session) => {
      const parentID = (session as Session & { parentID?: string | null }).parentID;
      if (!parentID) {
        return;
      }
      const collection = map.get(parentID) ?? [];
      collection.push(session);
      map.set(parentID, collection);
    });
    map.forEach((list) => list.sort((a, b) => compareSessionsByPinnedAndTime(a, b, pinnedSessionIds, sessionUserActivity)));
    return map;
  }, [sortedSessions, pinnedSessionIds, sessionUserActivity]);

  const emptyState = (
    <div className="py-6 text-center text-muted-foreground">
      <p className="typography-ui-label font-semibold">{t('sessions.sidebar.empty.noSessions.title')}</p>
      <p className="typography-meta mt-1">{t('sessions.sidebar.empty.noSessions.description')}</p>
    </div>
  );

  const editingProject = React.useMemo(
    () => projects.find((project) => project.id === editingProjectDialogId) ?? null,
    [projects, editingProjectDialogId],
  );

  const handleSaveProjectEdit = React.useCallback((data: { label: string; icon: string | null; color: string | null; iconBackground: string | null }) => {
    if (!editingProjectDialogId) {
      return;
    }
    updateProjectMeta(editingProjectDialogId, data);
    setEditingProjectDialogId(null);
  }, [editingProjectDialogId, updateProjectMeta]);

  const openNewWorktreeDialog = React.useCallback(() => {
    if (!canCreateWorktrees) return;
    setNewWorktreeDialogOpen(true);
  }, [canCreateWorktrees]);

  const handleOpenSettings = React.useCallback(() => {
    if (mobileVariant) {
      setSessionSwitcherOpen(false);
    }
    setSettingsDialogOpen(true);
  }, [mobileVariant, setSessionSwitcherOpen, setSettingsDialogOpen]);

  const deleteSession = useSessionUIStore((state) => state.deleteSession);
  const deleteSessions = useSessionUIStore((state) => state.deleteSessions);
  const archiveSession = useSessionUIStore((state) => state.archiveSession);
  const archiveSessions = useSessionUIStore((state) => state.archiveSessions);
  const unarchiveSession = useSessionUIStore((state) => state.unarchiveSession);
  const unarchiveSessions = useSessionUIStore((state) => state.unarchiveSessions);
  const pendingArchiveRevealSessionIdsRef = React.useRef<Set<string>>(new Set());
  const recordPendingArchiveRevealSessionIds = React.useCallback((ids: string[]) => {
    if (ids.length === 0) {
      return;
    }
    pendingArchiveRevealSessionIdsRef.current = new Set([
      ...pendingArchiveRevealSessionIdsRef.current,
      ...ids,
    ]);
  }, []);
  const discardPendingArchiveRevealSessionIdsFor = React.useCallback((ids: Iterable<string>) => {
    pendingArchiveRevealSessionIdsRef.current = discardPendingArchiveRevealSessionIds(
      pendingArchiveRevealSessionIdsRef.current,
      ids,
    );
  }, []);
  const collapseArchivedSessionTrees = React.useCallback((ids: Iterable<string>) => {
    setExpandedParents((prev) => {
      const next = removeExpandedSessionIds(prev, ids);
      if (next === prev) {
        return prev;
      }
      try {
        safeStorage.setItem(SESSION_EXPANDED_STORAGE_KEY, JSON.stringify(Array.from(next)));
      } catch { /* ignored */ }
      return next;
    });
  }, [safeStorage]);

  const {
    copiedSessionId,
    handleSessionSelect: handleOrdinarySessionSelect,
    handleSessionDoubleClick,
    handleSaveEdit,
    handleCancelEdit,
    handleCopyShareUrl,
    handleUnshareSession,
    handleUnarchiveSession,
    handleArchiveSession,
    handleDeleteSession,
    confirmDeleteSession,
  } = useSessionActions({
    activeProjectId,
    currentDirectory,
    currentSessionId,
    mobileVariant,
    allowReselect,
    onSessionSelected,
    isSessionSearchOpen,
    sessionSearchQuery,
    setSessionSearchQuery,
    setIsSessionSearchOpen,
    setActiveProjectIdOnly,
    setDirectory,
    setActiveMainTab,
    setSessionSwitcherOpen,
    setCurrentSession,
    prepareSession,
    updateSessionTitle,
    shareSession,
    unshareSession,
    deleteSession,
    deleteSessions,
    archiveSession,
    archiveSessions,
    unarchiveSession,
    unarchiveSessions,
    onArchiveRequested: recordPendingArchiveRevealSessionIds,
    onArchiveSucceeded: collapseArchivedSessionTrees,
    onArchiveFailed: discardPendingArchiveRevealSessionIdsFor,
    childrenMap,
    showDeletionDialog,
    setDeleteSessionConfirm,
    deleteSessionConfirm,
    setEditingId,
    setEditTitle,
    editingId,
    editTitle,
  });

  const handleSessionSelect = React.useCallback((
    sessionId: string,
    sessionDirectory?: string | null,
    disabled?: boolean,
    projectId?: string | null,
  ) => {
    if (!disabled) setAudience('coding-agents');
    handleOrdinarySessionSelect(sessionId, sessionDirectory, disabled, projectId);
  }, [handleOrdinarySessionSelect, setAudience]);

  const confirmDeleteFolder = React.useCallback(() => {
    if (!deleteFolderConfirm) return;
    const { scopeKey, folderId } = deleteFolderConfirm;
    setDeleteFolderConfirm(null);
    deleteFolder(scopeKey, folderId);
  }, [deleteFolderConfirm, deleteFolder]);

  const handleOpenDirectoryDialog = React.useCallback(() => {
    sessionEvents.requestDirectoryDialog();
  }, []);

  // Auto-expand parent session when navigating to a subagent (child) session
  React.useEffect(() => {
    if (!currentSessionId) return;
    const current = sessions.find((s) => s.id === currentSessionId);
    const parentID = (current as Session & { parentID?: string | null })?.parentID;
    if (!parentID) return;
    setExpandedParents((prev) => {
      if (prev.has(parentID)) return prev;
      const next = new Set(prev);
      next.add(parentID);
      try {
        safeStorage.setItem(SESSION_EXPANDED_STORAGE_KEY, JSON.stringify(Array.from(next)));
      } catch { /* ignored */ }
      return next;
    });
  }, [currentSessionId, sessions, safeStorage]);

  const toggleParent = React.useCallback((sessionId: string) => {
    setExpandedParents((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      try {
        safeStorage.setItem(SESSION_EXPANDED_STORAGE_KEY, JSON.stringify(Array.from(next)));
      } catch { /* ignored */ }
      return next;
    });
  }, [safeStorage]);

  const createFolderAndStartRename = React.useCallback(
    (scopeKey: string, parentId?: string | null) => {
      if (!scopeKey) {
        return null;
      }

      if (parentId && collapsedFolderIds.has(parentId)) {
        toggleFolderCollapse(parentId);
      }

      const newFolder = createFolder(scopeKey, t('sessions.sidebar.folder.newFolderName'), parentId);
      setRenamingFolderId(newFolder.id);
      setRenameFolderDraft(newFolder.name);
      return newFolder;
    },
    [collapsedFolderIds, toggleFolderCollapse, createFolder, t],
  );

  const toggleGroupSessionLimit = React.useCallback((groupId: string) => {
    setExpandedSessionGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }, []);

  const toggleProject = React.useCallback((projectId: string) => {
    // Ignore intersection events for a short period after toggling
    ignoreIntersectionUntil.current = Date.now() + 150;
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      try {
        safeStorage.setItem(PROJECT_COLLAPSE_STORAGE_KEY, JSON.stringify(Array.from(next)));
      } catch { /* ignored */ }

      // Persist collapse state to server settings (web + desktop local/remote).
      if (!isVSCode) {
        scheduleCollapsedProjectsPersist(next);
      }
      return next;
    });
  }, [isVSCode, safeStorage, scheduleCollapsedProjectsPersist]);

  const normalizedProjects = React.useMemo(() => {
    return projects
      .map((project) => ({
        ...project,
        normalizedPath: normalizePath(project.path),
      }))
      .filter((project) => Boolean(project.normalizedPath)) as Array<{
        id: string;
        path: string;
        label?: string;
        normalizedPath: string;
        icon?: string;
        color?: string;
        iconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' };
        iconBackground?: string;
      }>;
  }, [projects]);

  const normalizedProjectPaths = React.useMemo(
    () => normalizedProjects.map((project) => project.normalizedPath),
    [normalizedProjects],
  );

  const { github, git } = useRuntimeAPIs();
  const githubAuthStatus = useGitHubAuthStore((state) => state.status);
  const setGitHubAuthStatus = useGitHubAuthStore((state) => state.setStatus);
  const [isSwitchingGitHubAccount, setIsSwitchingGitHubAccount] = React.useState(false);
  const gitRepoStatus = useGitRepoStatusMap(normalizedProjectPaths);

  React.useEffect(() => {
    if (!canCreateWorktrees) return;
    const listActive = git.worktree?.activeOperations
      ?? git.listActiveGitWorktreeBootstrapOperations;
    if (!listActive) return;
    let cancelled = false;
    void listActive()
      .then((operations) => {
        if (cancelled || operations.length === 0) return;
        const projectPaths = new Set(normalizedProjectPaths);
        const matching = operations.find((operation) => {
          const primary = typeof operation.metadata?.primaryWorktree === 'string'
            ? normalizePath(operation.metadata.primaryWorktree)
            : '';
          return !primary || projectPaths.has(primary);
        });
        if (!matching) return;
        markWorktreeBootstrapPending(matching.directory, matching);
        setNewWorktreeDialogOpen(true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [canCreateWorktrees, git.listActiveGitWorktreeBootstrapOperations, git.worktree, normalizedProjectPaths]);

  useProjectRepoStatus({
    normalizedProjects,
    gitRepoStatus,
    setProjectRepoStatus,
    setProjectRootBranches,
  });

  const handleGitHubAccountSwitch = React.useCallback(async (accountId: string) => {
    if (!accountId || isSwitchingGitHubAccount) return;
    setIsSwitchingGitHubAccount(true);
    try {
      const payload = github
        ? await github.authActivate(accountId)
        : await (async () => {
          const response = await fetch('/api/github/auth/activate', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify({ accountId }),
          });
          const body = (await response.json().catch(() => null)) as
            | (GitHubAuthStatus & { error?: string })
            | null;
          if (!response.ok || !body) {
            throw new Error(body?.error || response.statusText);
          }
          return body;
        })();

      setGitHubAuthStatus(payload);
    } catch (error) {
      console.error('Failed to switch GitHub account:', error);
    } finally {
      setIsSwitchingGitHubAccount(false);
    }
  }, [github, isSwitchingGitHubAccount, setGitHubAuthStatus]);

  const isSessionsLoading = useSessionUIStore((state) => state.isLoading);
  const sessionProjectOwnership = React.useMemo(
    () => buildSessionProjectOwnership(
      normalizedProjects,
      availableWorktreesByProject,
      dedupeSessionsById([...sessions, ...archivedSessions]),
      isVSCode,
    ),
    [archivedSessions, availableWorktreesByProject, isVSCode, normalizedProjects, sessions],
  );
  useSessionFolderCleanup({
    isSessionsLoading,
    hasLoadedGlobalSessions,
    sessions,
    archivedSessions,
    normalizedProjects,
    cleanupSessions,
    sessionProjectOwnership,
  });

  const { getSessionsForProject, getArchivedSessionsForProject } = useProjectSessionLists({
    isVSCode,
    sessions,
    archivedSessions,
    availableWorktreesByProject,
    sessionProjectOwnership,
  });

  const hiddenProjectRootIds = React.useMemo(() => {
    if (principal.scope !== 'managed' || principal.role === 'admin') {
      return new Set<string>();
    }
    return new Set(projects
      .filter((project) => !isManagedBranchGranted(project, projectRootBranches.get(project.id)))
      .map((project) => project.id));
  }, [principal.role, principal.scope, projectRootBranches, projects]);

  useArchivedAutoFolders({
    normalizedProjects,
    sessions,
    archivedSessions,
    availableWorktreesByProject,
    isVSCode,
    isSessionsLoading,
    foldersMap,
    createFolder,
    addSessionToFolder,
    cleanupSessions,
    sessionProjectOwnership,
  });

  // Keep last-known repo status to avoid UI jiggling during project switch
  const lastRepoStatusRef = React.useRef(false);
  if (activeProjectId && projectRepoStatus.has(activeProjectId)) {
    lastRepoStatusRef.current = Boolean(projectRepoStatus.get(activeProjectId));
  }

  const {
    projectSections,
    groupSearchDataByGroup,
    sectionsForRender,
  } = useSessionSidebarSections({
    normalizedProjects,
    getSessionsForProject,
    getArchivedSessionsForProject,
    availableWorktreesByProject,
    projectRepoStatus,
    projectRootBranches,
    lastRepoStatus: lastRepoStatusRef.current,
    buildGroupedSessions,
    hasSessionSearchQuery,
    normalizedSessionSearchQuery,
    filterSessionNodesForSearch,
    buildGroupSearchText,
    foldersMap,
    hiddenProjectRootIds,
  });

  const sidebarChildHydrationTargets = React.useMemo<SidebarChildHydrationTarget[]>(() => {
    return collectSidebarChildHydrationTargets({
      sections: sectionsForRender.map((section) => ({
        projectId: section.project.id,
        groups: section.groups,
      })),
      collapsedProjectIds: collapsedProjects,
      currentSessionId,
      sessions,
      activeDirectory: currentDirectory,
    });
  }, [collapsedProjects, currentDirectory, currentSessionId, sectionsForRender, sessions]);

  const searchEmptyState = (
    <div className="py-6 text-center text-muted-foreground">
      <p className="typography-ui-label font-semibold">{t('sessions.sidebar.empty.noMatches.title')}</p>
      <p className="typography-meta mt-1">{t('sessions.sidebar.empty.noMatches.description')}</p>
    </div>
  );

  const reserveHeaderActionsSpace = true;

  useProjectSessionSelection({
    projectSections,
    activeProjectId,
    activeSessionByProject,
    setActiveSessionByProject,
    currentSessionId,
    handleSessionSelect,
    newSessionDraftOpen,
    mobileVariant,
    openNewSessionDraft,
    setActiveMainTab,
    setSessionSwitcherOpen,
    sessions,
    worktreeMetadata,
  });

  const { getOrderedGroups } = useGroupOrdering(groupOrderByProject);
  const visibleArchivedGroupKeysRef = React.useRef<Set<string>>(new Set());

  React.useEffect(() => {
    if (projectSections.length === 0) {
      visibleArchivedGroupKeysRef.current = new Set();
      return;
    }
    const previousArchivedGroupKeys = visibleArchivedGroupKeysRef.current;
    const result = reconcileArchivedGroupCollapse({
      sections: projectSections,
      previousVisibleArchivedGroupKeys: previousArchivedGroupKeys,
      collapsedGroups,
      pendingRevealSessionIds: pendingArchiveRevealSessionIdsRef.current,
    });

    if (result.revealedSessionIds.size > 0) {
      pendingArchiveRevealSessionIdsRef.current = discardPendingArchiveRevealSessionIds(
        pendingArchiveRevealSessionIdsRef.current,
        result.revealedSessionIds,
      );
    }

    if (result.collapsedGroups !== collapsedGroups) {
      setCollapsedGroups(result.collapsedGroups);
    }
    visibleArchivedGroupKeysRef.current = result.visibleArchivedGroupKeys;
  }, [collapsedGroups, projectSections]);

  const sessionSidebarMetaById = React.useMemo(() => {
    const meta = new Map<string, {
      node: SessionNode;
      projectId: string | null;
      groupDirectory: string | null;
      secondaryMeta: {
        projectLabel?: string | null;
        branchLabel?: string | null;
      } | null;
    }>();
    const projectPathLengthBySessionId = new Map<string, number>();

    projectSections.forEach((section) => {
      const projectLabel = resolveProjectDisplayName({
        label: section.project.label,
        path: section.project.normalizedPath,
      });
      section.groups.forEach((group) => {
        const secondaryMeta = group.branch && group.branch !== projectLabel
          ? { projectLabel, branchLabel: group.branch }
          : { projectLabel, branchLabel: null };

        const visit = (nodes: SessionNode[]) => {
          nodes.forEach((node) => {
            const nextProjectPathLength = section.project.normalizedPath.length;
            const currentProjectPathLength = projectPathLengthBySessionId.get(node.session.id) ?? -1;
            if (nextProjectPathLength < currentProjectPathLength) {
              return;
            }

            meta.set(node.session.id, {
              node,
              projectId: section.project.id,
              groupDirectory: group.directory,
              secondaryMeta,
            });
            projectPathLengthBySessionId.set(node.session.id, nextProjectPathLength);
            if (node.children.length > 0) {
              visit(node.children);
            }
          });
        };

        visit(group.sessions);
      });
    });

    return meta;
  }, [projectSections]);

  const buildSessionSearchDialogItem = React.useCallback((session: Session): SessionSearchDialogItem => {
    const meta = sessionSidebarMetaById.get(session.id);
    const directory = normalizePath(meta?.groupDirectory ?? resolveGlobalSessionDirectory(session));
    const fallbackProjectLabel = directory ? formatDirectoryName(directory, homeDirectory) : null;
    const projectLabel = meta?.secondaryMeta?.projectLabel ?? fallbackProjectLabel;
    const branchLabel = meta?.secondaryMeta?.branchLabel ?? null;
    const title = resolveDisplaySessionTitle({
      title: session.title,
      fallback: t('sessions.sidebar.session.untitled'),
    });
    const searchText = [
      title,
      projectLabel,
      branchLabel,
      directory,
      session.id,
    ]
      .filter((value): value is string => Boolean(value))
      .join(' ')
      .toLowerCase();

    return {
      id: session.id,
      title,
      projectLabel,
      branchLabel,
      directory,
      projectId: meta?.projectId ?? null,
      searchText,
    };
  }, [homeDirectory, sessionSidebarMetaById, t]);

  const sessionSearchDialogItems = React.useMemo(
    () => sortedSessions.map(buildSessionSearchDialogItem),
    [buildSessionSearchDialogItem, sortedSessions],
  );

  const handleSessionSearchSelect = React.useCallback((item: SessionSearchDialogItem) => {
    handleSessionSelect(item.id, item.directory, false, item.projectId);
  }, [handleSessionSelect]);

  const handleDraftSelect = React.useCallback((draftId: string) => {
    setAudience('coding-agents');
    setActiveMainTab('chat');
    selectNewSessionDraft(draftId);
    if (mobileVariant) {
      setSessionSwitcherOpen(false);
    }
    onSessionSelected?.(draftId);
  }, [mobileVariant, onSessionSelected, selectNewSessionDraft, setActiveMainTab, setAudience, setSessionSwitcherOpen]);

  const handleDraftDelete = React.useCallback((draftId: string) => {
    deleteNewSessionDraft(draftId);
  }, [deleteNewSessionDraft]);

  const sessionPrefetchIntent = useSessionPrefetch({
    currentSessionId,
    currentDirectory,
    sortedSessions,
    prefetchSession: sync.prefetchSession,
  });

  const desktopHeaderActionButtonClass =
    'inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-md leading-none text-foreground hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed';
  const mobileHeaderActionButtonClass =
    'inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-md leading-none text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed';
  const headerActionButtonClass = mobileVariant ? mobileHeaderActionButtonClass : desktopHeaderActionButtonClass;
  const headerActionIconClass = 'h-4.5 w-4.5';
  const stuckProjectHeaders = useStickyProjectHeaders({
    isDesktopShellRuntime,
    projectSections,
    projectHeaderSentinelRefs,
  });

  const renderSessionNode = React.useCallback(
    (
      node: SessionNode,
      depth = 0,
      groupDirectory?: string | null,
      projectId?: string | null,
      archivedBucket = false,
      secondaryMeta?: { projectLabel?: string | null; branchLabel?: string | null } | null,
      renderContext: 'project' | 'recent' = 'project',
    ): React.ReactNode => (
      <SessionNodeItem
        key={node.session.id}
        node={node}
        depth={depth}
        groupDirectory={groupDirectory}
        projectId={projectId}
        archivedBucket={archivedBucket}
        directoryStatus={directoryStatus}
        currentSessionId={currentSessionId}
        pinnedSessionIds={pinnedSessionIds}
        expandedParents={expandedParents}
        hasSessionSearchQuery={hasSessionSearchQuery}
        normalizedSessionSearchQuery={normalizedSessionSearchQuery}
        notifyOnSubtasks={notifyOnSubtasks}
        editingId={editingId}
        setEditingId={setEditingId}
        editTitle={editTitle}
        setEditTitle={setEditTitle}
        handleSaveEdit={handleSaveEdit}
        handleCancelEdit={handleCancelEdit}
        toggleParent={toggleParent}
        handleSessionSelect={handleSessionSelect}
        prepareSession={prepareSession}
        scheduleSessionPrefetch={sessionPrefetchIntent.schedule}
        cancelSessionPrefetch={sessionPrefetchIntent.cancel}
        handleSessionDoubleClick={handleSessionDoubleClick}
        togglePinnedSession={togglePinnedSession}
        copiedSessionId={copiedSessionId}
        handleCopyShareUrl={handleCopyShareUrl}
        handleUnshareSession={handleUnshareSession}
        handleUnarchiveSession={handleUnarchiveSession}
        handleArchiveSession={handleArchiveSession}
        openSidebarMenuKey={openSidebarMenuKey}
        setOpenSidebarMenuKey={setOpenSidebarMenuKey}
        renamingFolderId={renamingFolderId}
        getFoldersForScope={getFoldersForScope}
        getSessionFolderId={getSessionFolderId}
        removeSessionFromFolder={removeSessionFromFolder}
        addSessionToFolder={addSessionToFolder}
        createFolderAndStartRename={createFolderAndStartRename}
        openContextPanelTab={openContextPanelTab}
        handleDeleteSession={handleDeleteSession}
        mobileVariant={mobileVariant}
        alwaysShowActions={alwaysShowSidebarActions}
        renderSessionNode={renderSessionNode}
        secondaryMeta={secondaryMeta}
        renderContext={renderContext}
      />
    ),
    [
      directoryStatus,
      currentSessionId,
      pinnedSessionIds,
      expandedParents,
      hasSessionSearchQuery,
      normalizedSessionSearchQuery,
      notifyOnSubtasks,
      editingId,
      setEditingId,
      editTitle,
      setEditTitle,
      handleSaveEdit,
      handleCancelEdit,
      toggleParent,
      handleSessionSelect,
      prepareSession,
      sessionPrefetchIntent,
      handleSessionDoubleClick,
      togglePinnedSession,
      copiedSessionId,
      handleCopyShareUrl,
      handleUnshareSession,
      handleUnarchiveSession,
      handleArchiveSession,
      openSidebarMenuKey,
      setOpenSidebarMenuKey,
      renamingFolderId,
      getFoldersForScope,
      getSessionFolderId,
      removeSessionFromFolder,
      addSessionToFolder,
      createFolderAndStartRename,
      openContextPanelTab,
      handleDeleteSession,
      mobileVariant,
      alwaysShowSidebarActions,
    ],
  );

  const toggleCollapsedGroup = React.useCallback((key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const handleArchiveGroupSessions = React.useCallback((group: SessionGroup, sessions: Session[]) => {
    const projectDirectory = normalizePath(group.worktree?.projectDirectory ?? null);
    if (!projectDirectory || sessions.length === 0) {
      return;
    }
    setArchiveBranchConfirm({
      branchLabel: group.branch?.trim() || group.label,
      projectDirectory,
      sessions,
    });
  }, []);

  const confirmArchiveGroupSessions = React.useCallback(async () => {
    const request = archiveBranchConfirm;
    if (!request || archiveBranchPendingRef.current) {
      return;
    }

    archiveBranchPendingRef.current = true;
    setArchiveBranchPending(true);
    const requestedIds = request.sessions.map((session) => session.id);
    recordPendingArchiveRevealSessionIds(requestedIds);
    try {
      const result = await archiveBranchSessions(request.sessions, archiveSessions);
      collapseArchivedSessionTrees(result.archivedIds);
      discardPendingArchiveRevealSessionIdsFor(result.failedIds);

      if (currentSessionId && result.archivedIds.includes(currentSessionId)) {
        setCurrentSession(null);
        setDirectory(request.projectDirectory, { showOverlay: false });
      }

      if (result.archivedIds.length > 0) {
        toast.success(t('sessions.sidebar.dialogs.archiveBranchSessions.success', {
          count: result.archivedIds.length,
          branch: request.branchLabel,
        }), {
          description: t('sessions.sidebar.dialogs.archiveBranchSessions.preservedDescription'),
        });
      }
      if (result.failedIds.length > 0) {
        toast.error(t('sessions.sidebar.dialogs.archiveBranchSessions.partialFailure', {
          count: result.failedIds.length,
        }));
      }
      setArchiveBranchConfirm(null);
    } finally {
      archiveBranchPendingRef.current = false;
      setArchiveBranchPending(false);
    }
  }, [
    archiveBranchConfirm,
    archiveSessions,
    collapseArchivedSessionTrees,
    currentSessionId,
    discardPendingArchiveRevealSessionIdsFor,
    recordPendingArchiveRevealSessionIds,
    setCurrentSession,
    setDirectory,
    t,
  ]);

  const visibleDrafts = React.useMemo(
    () => selectVisibleChatDrafts(chatDrafts, currentDraftId),
    [chatDrafts, currentDraftId],
  );

  const projectPathById = React.useMemo(() => {
    const map = new Map<string, string>();
    normalizedProjects.forEach((project) => {
      map.set(project.id, project.normalizedPath);
    });
    return map;
  }, [normalizedProjects]);

  const renderedGroupDirectories = React.useMemo(() => {
    const directories = new Set<string>();
    sectionsForRender.forEach((section) => {
      section.groups.forEach((group) => {
        const directory = normalizePath(group.directory ?? null);
        if (directory) directories.add(directory);
      });
    });
    return directories;
  }, [sectionsForRender]);

  const getDraftsForGroup = React.useCallback((group: SessionGroup, projectId?: string | null): ChatDraft[] => {
    if (group.isArchivedBucket) return [];
    const groupDirectory = normalizePath(group.directory ?? null);
    const projectPath = projectId ? projectPathById.get(projectId) ?? null : null;

    return visibleDrafts.filter((draft) => {
      const draftDirectory = getDraftDirectory(draft);
      if (!draftDirectory) return false;
      if (groupDirectory && draftDirectory === groupDirectory) return true;
      // If no exact worktree/branch group exists for a draft directory, place it
      // at the top of the parent project's main group rather than in a global list.
      return Boolean(group.isMain && projectPath && isPathInProject(draftDirectory, projectPath) && !renderedGroupDirectories.has(draftDirectory));
    });
  }, [projectPathById, renderedGroupDirectories, visibleDrafts]);

  const fallbackDrafts = React.useMemo(() => visibleDrafts.filter((draft) => {
    const draftDirectory = getDraftDirectory(draft);
    if (!draftDirectory) return true;
    if (renderedGroupDirectories.has(draftDirectory)) return false;
    for (const projectPath of projectPathById.values()) {
      if (isPathInProject(draftDirectory, projectPath)) return false;
    }
    return true;
  }), [projectPathById, renderedGroupDirectories, visibleDrafts]);

  const renderGroupSessions = React.useCallback(
    (group: SessionGroup, groupKey: string, projectId?: string | null, hideGroupLabel?: boolean, dragHandleProps?: SortableDragHandleProps | null, compactBodyPadding?: boolean) => {
      const groupDrafts = getDraftsForGroup(group, projectId);
      return (
        <SessionGroupSection
        group={group}
        groupKey={groupKey}
        projectId={projectId}
        hideGroupLabel={hideGroupLabel}
        compactBodyPadding={compactBodyPadding}
        hasSessionSearchQuery={hasSessionSearchQuery}
        normalizedSessionSearchQuery={normalizedSessionSearchQuery}
        groupSearchDataByGroup={groupSearchDataByGroup}
        expandedSessionGroups={expandedSessionGroups}
        collapsedGroups={collapsedGroups}
        hideDirectoryControls={shouldHideProjectAdminControls}
        collapsedFolderIds={collapsedFolderIds}
        toggleFolderCollapse={toggleFolderCollapse}
        renameFolder={renameFolder}
        deleteFolder={deleteFolder}
        showDeletionDialog={showDeletionDialog}
        setDeleteFolderConfirm={setDeleteFolderConfirm}
        renderSessionNode={renderSessionNode}
        toggleGroupSessionLimit={toggleGroupSessionLimit}
        mobileVariant={mobileVariant}
        alwaysShowActions={alwaysShowSidebarActions}
        activeProjectId={activeProjectId}
        setActiveProjectIdOnly={setActiveProjectIdOnly}
        setActiveMainTab={setActiveMainTab}
        setSessionSwitcherOpen={setSessionSwitcherOpen}
        openNewSessionDraft={openNewSessionDraft}
        addSessionToFolder={addSessionToFolder}
        createFolderAndStartRename={createFolderAndStartRename}
        renamingFolderId={renamingFolderId}
        renameFolderDraft={renameFolderDraft}
        setRenameFolderDraft={setRenameFolderDraft}
        setRenamingFolderId={setRenamingFolderId}
        pinnedSessionIds={pinnedSessionIds}
        sessionOrderIndex={sessionOrderIndex}
        archivedAssistantActivity={archivedAssistantActivity}
        onArchiveGroupSessions={handleArchiveGroupSessions}
        onToggleCollapsedGroup={toggleCollapsedGroup}
        dragHandleProps={dragHandleProps}
        draftCount={groupDrafts.length}
        draftItems={groupDrafts.length > 0 ? (
          <DraftSidebarList
            drafts={groupDrafts}
            currentDraftId={currentDraftId}
            onSelectDraft={handleDraftSelect}
            onDeleteDraft={handleDraftDelete}
            mobileVariant={mobileVariant}
          />
        ) : null}
      />
      );
    },
    [
      hasSessionSearchQuery,
      normalizedSessionSearchQuery,
      groupSearchDataByGroup,
      expandedSessionGroups,
      collapsedGroups,
      shouldHideProjectAdminControls,
      collapsedFolderIds,
      toggleFolderCollapse,
      renameFolder,
      deleteFolder,
      showDeletionDialog,
      renderSessionNode,
      toggleGroupSessionLimit,
      mobileVariant,
      alwaysShowSidebarActions,
      activeProjectId,
      setActiveProjectIdOnly,
      setActiveMainTab,
      setSessionSwitcherOpen,
      openNewSessionDraft,
      addSessionToFolder,
      createFolderAndStartRename,
      renamingFolderId,
      renameFolderDraft,
      pinnedSessionIds,
      sessionOrderIndex,
      archivedAssistantActivity,
      handleArchiveGroupSessions,
      toggleCollapsedGroup,
      getDraftsForGroup,
      currentDraftId,
      handleDraftSelect,
      handleDraftDelete,
    ],
  );

  const topContent = !hasSessionSearchQuery ? (
    <>
      {fallbackDrafts.length > 0 ? (
        <DraftSidebarList
          drafts={fallbackDrafts}
          currentDraftId={currentDraftId}
          onSelectDraft={handleDraftSelect}
          onDeleteDraft={handleDraftDelete}
          mobileVariant={mobileVariant}
          className="px-2 pb-2"
        />
      ) : null}
    </>
  ) : null;
  const isInlineEditing = Boolean(renamingFolderId || editingId || editingProjectDialogId);

  const selectionModeEnabled = useSessionMultiSelectStore((state) => state.enabled);
  const selectedIds = useSessionMultiSelectStore((state) => state.selectedIds);
  const selectionScopeKey = useSessionMultiSelectStore((state) => state.scopeKey);
  const multiSelectStoreApi = useSessionMultiSelectStore;

  const handleExitSelectionMode = React.useCallback(() => {
    useSessionMultiSelectStore.getState().disable();
  }, []);

  const bulkScopeIsArchived = React.useMemo(() => {
    if (selectedIds.size === 0) return false;
    if (typeof document === 'undefined') return false;
    let sawActive = false;
    let sawArchived = false;
    for (const id of selectedIds) {
      const rows = document.querySelectorAll<HTMLElement>(`[data-session-row="${CSS.escape(id)}"]`);
      for (const row of rows) {
        if (row.getAttribute('data-session-archived') === '1') sawArchived = true;
        else sawActive = true;
      }
    }
    return sawArchived && !sawActive;
  }, [selectedIds]);

  const derivedSelectionScope = React.useMemo(() => {
    if (selectionScopeKey) return selectionScopeKey;
    if (selectedIds.size === 0) return null;
    if (typeof document === 'undefined') return null;
    for (const id of selectedIds) {
      const row = document.querySelector<HTMLElement>(`[data-session-row="${CSS.escape(id)}"]`);
      const scope = row?.getAttribute('data-session-scope');
      if (scope && scope.length > 0) return scope;
    }
    return null;
  }, [selectedIds, selectionScopeKey]);

  const bulkScopeFolders = React.useMemo(() => {
    if (!derivedSelectionScope) return [];
    return foldersMap[derivedSelectionScope] ?? [];
  }, [foldersMap, derivedSelectionScope]);

  const bulkCanRemoveFromFolder = React.useMemo(() => {
    if (!derivedSelectionScope || selectedIds.size === 0) return false;
    const scopeFolders = foldersMap[derivedSelectionScope] ?? [];
    for (const folder of scopeFolders) {
      for (const id of folder.sessionIds) {
        if (selectedIds.has(id)) return true;
      }
    }
    return false;
  }, [foldersMap, derivedSelectionScope, selectedIds]);

  const handleBulkMoveToFolder = React.useCallback((folderId: string) => {
    if (!derivedSelectionScope || selectedIds.size === 0) return;
    addSessionsToFolder(derivedSelectionScope, folderId, Array.from(selectedIds));
  }, [addSessionsToFolder, selectedIds, derivedSelectionScope]);

  const handleBulkCreateFolderAndMove = React.useCallback(() => {
    if (!derivedSelectionScope || selectedIds.size === 0) return;
    const newFolder = createFolderAndStartRename(derivedSelectionScope);
    if (!newFolder) return;
    addSessionsToFolder(derivedSelectionScope, newFolder.id, Array.from(selectedIds));
  }, [addSessionsToFolder, createFolderAndStartRename, selectedIds, derivedSelectionScope]);

  const handleBulkRemoveFromFolder = React.useCallback(() => {
    if (!derivedSelectionScope || selectedIds.size === 0) return;
    removeSessionsFromFolders(derivedSelectionScope, Array.from(selectedIds));
  }, [removeSessionsFromFolders, selectedIds, derivedSelectionScope]);

  const executeBulkDelete = React.useCallback(async () => {
    if (bulkDeletePendingRef.current) return;
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    bulkDeletePendingRef.current = true;
    setBulkDeletePending(true);
    try {
      let successfulCount = 0;
      let failedCount = 0;
      if (bulkScopeIsArchived) {
        const { deletedIds, failedIds } = await deleteSessions(ids);
        successfulCount = deletedIds.length;
        failedCount = failedIds.length;
        if (failedIds.length > 0) {
          toast.error(failedIds.length === 1
            ? t('sessions.sidebar.bulkActions.failedDeleteSingle', { count: failedIds.length })
            : t('sessions.sidebar.bulkActions.failedDeletePlural', { count: failedIds.length }));
        }
      } else {
        recordPendingArchiveRevealSessionIds(ids);
        const { archivedIds, failedIds } = await archiveSessions(ids);
        collapseArchivedSessionTrees(archivedIds);
        successfulCount = archivedIds.length;
        failedCount = failedIds.length;
        if (failedIds.length > 0) {
          discardPendingArchiveRevealSessionIdsFor(failedIds);
        }
        if (failedIds.length > 0) {
          toast.error(failedIds.length === 1
            ? t('sessions.sidebar.bulkActions.failedArchiveSingle', { count: failedIds.length })
            : t('sessions.sidebar.bulkActions.failedArchivePlural', { count: failedIds.length }));
        }
      }

      // Keep selection active when every item failed so the retry target is preserved.
      if (successfulCount > 0 || failedCount === 0) {
        useSessionMultiSelectStore.getState().clear();
      }
    } finally {
      bulkDeletePendingRef.current = false;
      setBulkDeletePending(false);
    }
  }, [archiveSessions, bulkScopeIsArchived, collapseArchivedSessionTrees, deleteSessions, discardPendingArchiveRevealSessionIdsFor, recordPendingArchiveRevealSessionIds, selectedIds, t]);

  const handleBulkDelete = React.useCallback(() => {
    const count = selectedIds.size;
    if (count === 0) return;
    if (!showDeletionDialog) {
      void executeBulkDelete();
      return;
    }
    setBulkDeleteConfirm({ sessionCount: count, archivedBucket: bulkScopeIsArchived });
  }, [bulkScopeIsArchived, executeBulkDelete, selectedIds, showDeletionDialog]);

  const confirmBulkDelete = React.useCallback(async () => {
    setBulkDeleteConfirm(null);
    await executeBulkDelete();
  }, [executeBulkDelete]);

  React.useEffect(() => {
    if (!selectionModeEnabled) return;
    const isMac = typeof navigator !== 'undefined' && /Macintosh|Mac OS X/.test(navigator.userAgent || '');
    const listener = (event: KeyboardEvent) => {
      if (isInlineEditing) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      const modifier = isMac ? event.metaKey : event.ctrlKey;
      if (event.key === 'Escape') {
        event.preventDefault();
        useSessionMultiSelectStore.getState().disable();
        return;
      }
      if (modifier && event.key === 'Backspace') {
        event.preventDefault();
        handleBulkDelete();
        return;
      }
      if (modifier && (event.key === 'a' || event.key === 'A')) {
        const rows = typeof document !== 'undefined'
          ? Array.from(document.querySelectorAll<HTMLElement>('[data-session-row]'))
          : [];
        if (rows.length === 0) return;
        event.preventDefault();
        const currentScope = multiSelectStoreApi.getState().scopeKey;
        const targetScope = currentScope
          ?? rows[0]?.getAttribute('data-session-scope')
          ?? null;
        const scopeFilter = (el: HTMLElement): boolean => {
          if (!targetScope) return true;
          return el.getAttribute('data-session-scope') === targetScope;
        };
        const ids = rows
          .filter(scopeFilter)
          .map((el) => el.getAttribute('data-session-row'))
          .filter((id): id is string => typeof id === 'string' && id.length > 0);
        if (ids.length === 0) return;
        multiSelectStoreApi.getState().replaceAll(ids, targetScope || null);
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [handleBulkDelete, isInlineEditing, multiSelectStoreApi, selectionModeEnabled]);
  const handleSidebarNewSession = React.useCallback(() => {
    setAudience('coding-agents');
    setActiveMainTab('chat');
    if (mobileVariant) {
      setSessionSwitcherOpen(false);
    }
    openNewSessionDraft();
  }, [mobileVariant, openNewSessionDraft, setActiveMainTab, setAudience, setSessionSwitcherOpen]);

  return (
    <div
      className={cn(
        'relative flex h-full flex-col text-foreground overflow-x-hidden',
        mobileVariant ? '' : 'bg-transparent',
      )}
    >
      <SidebarHeader
        hideDirectoryControls={hideDirectoryControls}
        handleNewSession={handleSidebarNewSession}
        onOpenScheduledTasks={() => setScheduledTasksDialogOpen(true)}
        onOpenMultiRun={() => setMultiRunLauncherOpen(true)}
        showMultiRun={!hideDirectoryControls && canManageProjects && canCreateWorktrees && canCreateBranches}
        headerActionIconClass={headerActionIconClass}
        reserveHeaderActionsSpace={reserveHeaderActionsSpace}
        headerActionButtonClass={headerActionButtonClass}
        isSessionSearchOpen={isSessionSearchOpen}
        setIsSessionSearchOpen={setIsSessionSearchOpen}
        showSidebarToggle={isWebRuntime && audience !== 'bots'}
        onToggleSidebar={toggleSidebar}
        hideSearchAction={hideSearchInSidebarHeader}
        avoidWindowControlsOverlay={isTabletStandalonePwa}
        reserveExternalDesktopChromeRow={!mobileVariant && !isVSCode && (isDesktopShellRuntime || audience === 'bots')}
        audience={audience}
        onAudienceChange={setAudience}
      />

      {canUseBots && audience === 'bots' ? (
        <div
          id="main-sidebar-audience-panel"
          role="tabpanel"
          aria-labelledby="main-sidebar-audience-bots-tab"
          className="min-h-0 flex-1 overflow-y-auto px-2 pb-3"
        >
          <LazyViewBoundary>
            <LazyBotSidebarSection
              standalone
              onBotSelected={(botId) => {
                if (mobileVariant) setSessionSwitcherOpen(false);
                onSessionSelected?.(`bot:${botId}`);
              }}
            />
          </LazyViewBoundary>
        </div>
      ) : null}

      {audience === 'coding-agents' ? <div
        id="main-sidebar-audience-panel"
        role={canUseBots ? 'tabpanel' : undefined}
        aria-labelledby={canUseBots ? 'main-sidebar-audience-coding-agents-tab' : undefined}
        className="flex min-h-0 flex-1 flex-col"
      >
        <DeferredSessionDialog active={isSessionSearchOpen}>
          <LazyViewBoundary>
            <LazySessionSearchDialog
              open={isSessionSearchOpen}
              onOpenChange={setIsSessionSearchOpen}
              query={sessionSearchQuery}
              onQueryChange={setSessionSearchQuery}
              items={sessionSearchDialogItems}
              recentItems={sessionSearchDialogItems}
              currentSessionId={currentSessionId}
              inputRef={sessionSearchInputRef}
              onSelect={handleSessionSearchSelect}
            />
          </LazyViewBoundary>
        </DeferredSessionDialog>

        <SidebarSessionChildrenHydrator targets={sidebarChildHydrationTargets} />

        <SidebarProjectsList
          topContent={topContent}
          sectionsForRender={sectionsForRender}
          projectSections={projectSections}
          activeProjectId={activeProjectId}
          showOnlyMainWorkspace={showOnlyMainWorkspace}
          hasSessionSearchQuery={hasSessionSearchQuery}
          emptyState={emptyState}
          searchEmptyState={searchEmptyState}
          renderGroupSessions={renderGroupSessions}
          homeDirectory={homeDirectory}
          collapsedProjects={collapsedProjects}
          hideProjectAdminControls={shouldHideProjectAdminControls}
          hideWorktreeControls={hideDirectoryControls || !canCreateWorktrees}
          projectRepoStatus={projectRepoStatus}
          isDesktopShellRuntime={isDesktopShellRuntime}
          stuckProjectHeaders={stuckProjectHeaders}
          mobileVariant={mobileVariant}
          alwaysShowActions={alwaysShowSidebarActions}
          toggleProject={toggleProject}
          setActiveProjectIdOnly={setActiveProjectIdOnly}
          setActiveMainTab={setActiveMainTab}
          setSessionSwitcherOpen={setSessionSwitcherOpen}
          openNewSessionDraft={openNewSessionDraft}
          openNewWorktreeDialog={openNewWorktreeDialog}
          openProjectEditDialog={setEditingProjectDialogId}
          removeProject={removeProject}
          projectHeaderSentinelRefs={projectHeaderSentinelRefs}
          reorderProjects={reorderProjects}
          getOrderedGroups={getOrderedGroups}
          setGroupOrderByProject={setGroupOrderByProject}
          openSidebarMenuKey={openSidebarMenuKey}
          setOpenSidebarMenuKey={setOpenSidebarMenuKey}
          isInlineEditing={isInlineEditing}
        />

        {selectionModeEnabled && selectedIds.size > 0 ? (
          <BulkActionBar
            selectedCount={selectedIds.size}
            scopeKey={derivedSelectionScope}
            scopeFolders={bulkScopeFolders}
            archivedBucket={bulkScopeIsArchived}
            onMoveToFolder={handleBulkMoveToFolder}
            onCreateFolderAndMove={handleBulkCreateFolderAndMove}
            onRemoveFromFolder={handleBulkRemoveFromFolder}
            canRemoveFromFolder={bulkCanRemoveFromFolder}
            onDelete={handleBulkDelete}
            deletePending={bulkDeletePending}
            onDone={handleExitSelectionMode}
          />
        ) : null}

      </div> : null}

      <SidebarFooter
        onOpenSettings={handleOpenSettings}
        githubAuthStatus={githubAuthStatus}
        isSwitchingGitHubAccount={isSwitchingGitHubAccount}
        onGitHubAccountSwitch={principal.scope === 'managed' ? undefined : handleGitHubAccountSwitch}
        showGitHubProfilePlaceholder={principal.scope === 'managed'
          && principal.assignments.some((assignment) => Boolean(assignment.githubAccountId))}
        showRuntimeButtons={!isVSCode}
        hideDirectoryControls={audience === 'bots' || shouldHideProjectAdminControls}
        handleOpenDirectoryDialog={handleOpenDirectoryDialog}
      />

      <DeferredSessionDialog active={Boolean(editingProject)}>
        {editingProject ? (
          <LazyViewBoundary>
            <LazyProjectEditDialog
              open={Boolean(editingProject)}
              onOpenChange={(open) => {
                if (!open) {
                  setEditingProjectDialogId(null);
                }
              }}
              projectId={editingProject.id}
              projectName={resolveProjectDisplayName(editingProject)}
              projectPath={editingProject.path}
              initialIcon={editingProject.icon}
              initialColor={editingProject.color}
              initialIconBackground={editingProject.iconBackground}
              readOnly={!canEditProjectMetadata}
              onSave={handleSaveProjectEdit}
            />
          </LazyViewBoundary>
        ) : null}
      </DeferredSessionDialog>

      <DeferredSessionDialog active={canCreateWorktrees && newWorktreeDialogOpen}>
        <LazyViewBoundary>
          <LazyNewWorktreeDialog
            open={canCreateWorktrees && newWorktreeDialogOpen}
            onOpenChange={setNewWorktreeDialogOpen}
            onWorktreeCreated={(worktreePath, options) => {
              setActiveMainTab('chat');
              if (mobileVariant) {
                setSessionSwitcherOpen(false);
              }
              if (options?.sessionId) {
                setCurrentSession(options.sessionId);
                return;
              }
              openNewSessionDraft({
                selectedProjectId: options?.projectId,
                directoryOverride: worktreePath,
                preserveDirectoryOverride: true,
              });
            }}
          />
        </LazyViewBoundary>
      </DeferredSessionDialog>

      <DeferredSessionDialog active={isScheduledTasksDialogOpen}>
        <LazyViewBoundary>
          <LazyScheduledTasksDialog />
        </LazyViewBoundary>
      </DeferredSessionDialog>

      <DeferredSessionDialog active={Boolean(deleteSessionConfirm)}>
        <LazyViewBoundary>
          <LazySessionDeleteConfirmDialog
            value={deleteSessionConfirm}
            setValue={setDeleteSessionConfirm}
            showDeletionDialog={showDeletionDialog}
            setShowDeletionDialog={setShowDeletionDialog}
            onConfirm={confirmDeleteSession}
          />
        </LazyViewBoundary>
      </DeferredSessionDialog>

      <DeferredSessionDialog active={Boolean(deleteFolderConfirm)}>
        <LazyViewBoundary>
          <LazyFolderDeleteConfirmDialog
            value={deleteFolderConfirm}
            setValue={setDeleteFolderConfirm}
            onConfirm={confirmDeleteFolder}
          />
        </LazyViewBoundary>
      </DeferredSessionDialog>

      <DeferredSessionDialog active={Boolean(bulkDeleteConfirm)}>
        <LazyViewBoundary>
          <LazyBulkSessionDeleteConfirmDialog
            value={bulkDeleteConfirm}
            setValue={setBulkDeleteConfirm}
            showDeletionDialog={showDeletionDialog}
            setShowDeletionDialog={setShowDeletionDialog}
            onConfirm={confirmBulkDelete}
          />
        </LazyViewBoundary>
      </DeferredSessionDialog>

      <DeferredSessionDialog active={Boolean(archiveBranchConfirm)}>
        <LazyViewBoundary>
          <LazyBranchSessionArchiveConfirmDialog
            value={archiveBranchConfirm}
            setValue={setArchiveBranchConfirm}
            pending={archiveBranchPending}
            onConfirm={confirmArchiveGroupSessions}
          />
        </LazyViewBoundary>
      </DeferredSessionDialog>
    </div>
  );
};
