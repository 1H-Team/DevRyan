import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { AnimatePresence } from 'motion/react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  RiAddLine,
  RiAiAgentLine,
  RiArchiveLine,
  RiArrowDownSLine,
  RiArrowGoBackLine,
  RiCheckLine,
  RiCloseLine,
  RiDeleteBinLine,
  RiDownloadLine,
  RiErrorWarningLine,
  RiFileCopyLine,
  RiFolderLine,
  RiLinkUnlinkM,
  RiPencilAiLine,
  RiPushpinLine,
  RiShieldLine,
  RiUnpinLine,
  RiWindowLine,
} from '@remixicon/react';
import { cn } from '@/lib/utils';
import { resolveDisplaySessionTitle } from '@/lib/sessionTitles';
import { canUseElectronDesktopIPC, invokeDesktop, isVSCodeRuntime } from '@/lib/desktop';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { buildExportFilename, formatSessionAsMarkdown, getExportRevealLabelKey, revealExportedMarkdown } from '@/lib/exportSession';
import type { ChildSessionExport } from '@/lib/exportSession';
import { saveSessionExportMarkdown } from '@/lib/sessionExportSave';
import { buildSessionMessageRecordsSnapshot, useDirectoryStore, useDirectorySync, useIsSessionWorking, useSession, useSessionPermissions } from '@/sync/sync-context';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSync } from '@/sync/use-sync';
import { useViewportStore } from '@/sync/viewport-store';
import { DraggableSessionRow } from './sessionFolderDnd';
import type { SessionNode } from './types';
import { formatSessionCompactDateLabel, normalizePath, renderHighlightedText, resolveSessionRoutingDirectory } from './utils';
import { useSessionMultiSelectStore } from '@/stores/useSessionMultiSelectStore';
import {
  managedOrchestrationSelectors,
  useManagedOrchestrationStore,
} from '@/stores/useManagedOrchestrationStore';
import { useProviderRecoveryStore } from '@/stores/useProviderRecoveryStore';
import { useI18n } from '@/lib/i18n';
import { resolveEffectivePlanIndicatorState, type PlanIndicatorState } from '@/sync/plan-indicator';
import { useNotificationStore } from '@/sync/notification-store';
import { hasWorkingDescendantSession, resolveLeadingRailLayout, resolveSidebarIndicator, resolveSidebarWorkingStatus, resolveSubtaskSidebarIndicator } from './sessionIndicator';
import type { SessionIndicator } from './sessionIndicator';
import { useSessionLifecycleStatus } from '@/hooks/useSessionLifecycleStatus';
import { SidebarSpinner } from './SidebarSpinner';
import {
  resolveMobileSessionSwipeAction,
  resolveSessionRowInteractionClasses,
} from './sessionRowInteractionClasses';
import { resolveSessionRowAuxAction } from './sessionRowAuxAction';
import { hasTreeExpansionStateChange } from './sessionNodeMemo';
import { SessionSidebarMotionRow } from './SessionSidebarMotionRow';
import { getAgentIconColor } from '@/lib/agentColors';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { resolveSubtaskIconAgent } from './subtaskAgentIdentity';

type Folder = { id: string; name: string; sessionIds: string[] };

const EMPTY_SESSION_IDS: string[] = [];

type SecondaryMeta = {
  projectLabel?: string | null;
  branchLabel?: string | null;
};

class EmptySessionExportError extends Error {}

type Props = {
  node: SessionNode;
  depth?: number;
  groupDirectory?: string | null;
  projectId?: string | null;
  archivedBucket?: boolean;
  userActivityTimestamp?: number;
  directoryStatus: Map<string, 'unknown' | 'exists' | 'missing'>;
  currentSessionId: string | null;
  pinnedSessionIds: Set<string>;
  expandedParents: Set<string>;
  hasSessionSearchQuery: boolean;
  normalizedSessionSearchQuery: string;
  notifyOnSubtasks: boolean;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  editTitle: string;
  setEditTitle: (value: string) => void;
  handleSaveEdit: () => void;
  handleCancelEdit: () => void;
  toggleParent: (sessionId: string) => void;
  handleSessionSelect: (sessionId: string, sessionDirectory: string | null, isMissingDirectory: boolean, projectId?: string | null) => void;
  prepareSession: (sessionId: string, sessionDirectory: string) => void;
  scheduleSessionPrefetch: (sessionId: string, sessionDirectory: string | null, delayMs?: number) => void;
  cancelSessionPrefetch: (sessionId: string) => void;
  handleSessionDoubleClick: () => void;
  togglePinnedSession: (sessionId: string) => void;
  copiedSessionId: string | null;
  handleCopyShareUrl: (url: string, sessionId: string) => void;
  handleUnshareSession: (sessionId: string) => void;
  handleUnarchiveSession: (session: Session) => void;
  handleArchiveSession: (session: Session) => void;
  openSidebarMenuKey: string | null;
  setOpenSidebarMenuKey: (key: string | null) => void;
  renamingFolderId: string | null;
  getFoldersForScope: (scopeKey: string) => Folder[];
  getSessionFolderId: (scopeKey: string, sessionId: string) => string | null;
  removeSessionFromFolder: (scopeKey: string, sessionId: string) => void;
  addSessionToFolder: (scopeKey: string, folderId: string, sessionId: string) => void;
  createFolderAndStartRename: (scopeKey: string, parentId?: string | null) => { id: string } | null;
  openContextPanelTab: (directory: string, options: { mode: 'chat'; dedupeKey: string; label: string }) => void;
  handleDeleteSession: (session: Session, source?: { archivedBucket?: boolean }) => void;
  mobileVariant: boolean;
  alwaysShowActions: boolean;
  renderSessionNode: (node: SessionNode, depth?: number, groupDirectory?: string | null, projectId?: string | null, archivedBucket?: boolean, secondaryMeta?: SecondaryMeta | null, renderContext?: 'project' | 'recent') => React.ReactNode;
  secondaryMeta?: SecondaryMeta | null;
  renderContext?: 'project' | 'recent';
};

const getNodeChildSignature = (node: SessionNode): string => {
  if (node.children.length === 0) {
    return '';
  }

  return node.children
    .map((child) => `${child.session.id}:${child.children.length}`)
    .join('|');
};

const getSessionRenderSignature = (session: Session): string => {
  const record = session as Session & {
    agent?: string | null;
    directory?: string | null;
    parentID?: string | null;
    project?: { worktree?: string | null } | null;
  };
  return [
    session.id,
    session.title ?? '',
    session.time?.created ?? 0,
    session.time?.updated ?? 0,
    session.time?.archived ?? 0,
    record.directory ?? '',
    record.project?.worktree ?? '',
    record.parentID ?? '',
    record.agent ?? '',
    session.share?.url ?? '',
  ].join('|');
};

const treeContainsSessionId = (node: SessionNode, sessionId: string | null): boolean => {
  if (!sessionId) {
    return false;
  }

  if (node.session.id === sessionId) {
    return true;
  }

  for (const child of node.children) {
    if (treeContainsSessionId(child, sessionId)) {
      return true;
    }
  }

  return false;
};

const treeContainsMenuKey = (
  node: SessionNode,
  menuKey: string | null,
  renderContext: 'project' | 'recent',
  archivedBucket: boolean,
): boolean => {
  if (!menuKey) {
    return false;
  }

  const nodeMenuKey = `${renderContext}:${archivedBucket ? 'archived' : 'active'}:${node.session.id}`;
  if (nodeMenuKey === menuKey) {
    return true;
  }

  for (const child of node.children) {
    if (treeContainsMenuKey(child, menuKey, renderContext, archivedBucket)) {
      return true;
    }
  }

  return false;
};

const areEqual = (prev: Props, next: Props): boolean => {
  const prevSession = prev.node.session;
  const nextSession = next.node.session;
  const prevSessionId = prevSession.id;
  const nextSessionId = nextSession.id;

  if (prevSessionId !== nextSessionId) return false;
  if (prev.node.isArchiveAncestorOnly !== next.node.isArchiveAncestorOnly) return false;
  if (getSessionRenderSignature(prevSession) !== getSessionRenderSignature(nextSession)) return false;
  if (getNodeChildSignature(prev.node) !== getNodeChildSignature(next.node)) return false;
  if (prev.depth !== next.depth) return false;
  if (prev.groupDirectory !== next.groupDirectory) return false;
  if (prev.projectId !== next.projectId) return false;
  if (prev.archivedBucket !== next.archivedBucket) return false;
  if (prev.userActivityTimestamp !== next.userActivityTimestamp) return false;
  if (prev.currentSessionId !== next.currentSessionId) {
    const prevActiveInTree = treeContainsSessionId(prev.node, prev.currentSessionId);
    const nextActiveInTree = treeContainsSessionId(next.node, next.currentSessionId);
    if (prevActiveInTree || nextActiveInTree) {
      return false;
    }
  }
  if (prev.pinnedSessionIds.has(prevSessionId) !== next.pinnedSessionIds.has(nextSessionId)) return false;
  if (hasTreeExpansionStateChange(prev.node, next.node, prev.expandedParents, next.expandedParents)) return false;
  if (prev.hasSessionSearchQuery !== next.hasSessionSearchQuery) return false;
  if (prev.normalizedSessionSearchQuery !== next.normalizedSessionSearchQuery) return false;
  if (prev.notifyOnSubtasks !== next.notifyOnSubtasks) return false;
  if (prev.editingId !== next.editingId) {
    const prevEditingInTree = treeContainsSessionId(prev.node, prev.editingId);
    const nextEditingInTree = treeContainsSessionId(next.node, next.editingId);
    if (prevEditingInTree || nextEditingInTree) {
      return false;
    }
  }
  if (prev.editTitle !== next.editTitle) {
    const prevEditingInTree = treeContainsSessionId(prev.node, prev.editingId);
    const nextEditingInTree = treeContainsSessionId(next.node, next.editingId);
    if (prevEditingInTree || nextEditingInTree) {
      return false;
    }
  }
  if ((prev.copiedSessionId === prevSessionId) !== (next.copiedSessionId === nextSessionId)) return false;

  const prevMenuInTree = treeContainsMenuKey(prev.node, prev.openSidebarMenuKey, prev.renderContext ?? 'project', prev.archivedBucket ?? false);
  const nextMenuInTree = treeContainsMenuKey(next.node, next.openSidebarMenuKey, next.renderContext ?? 'project', next.archivedBucket ?? false);
  if (prevMenuInTree !== nextMenuInTree) return false;

  const prevDirectory = normalizePath((prevSession as Session & { directory?: string | null }).directory ?? null)
    ?? normalizePath(prev.groupDirectory ?? null);
  const nextDirectory = normalizePath((nextSession as Session & { directory?: string | null }).directory ?? null)
    ?? normalizePath(next.groupDirectory ?? null);
  if (prevDirectory !== nextDirectory) return false;
  if ((prevDirectory ? prev.directoryStatus.get(prevDirectory) : null) !== (nextDirectory ? next.directoryStatus.get(nextDirectory) : null)) return false;

  if ((prev.secondaryMeta?.projectLabel ?? null) !== (next.secondaryMeta?.projectLabel ?? null)) return false;
  if ((prev.secondaryMeta?.branchLabel ?? null) !== (next.secondaryMeta?.branchLabel ?? null)) return false;
  if (prev.mobileVariant !== next.mobileVariant) return false;
  if (prev.alwaysShowActions !== next.alwaysShowActions) return false;
  if ((prev.renderContext ?? 'project') !== (next.renderContext ?? 'project')) return false;
  if (prev.renamingFolderId !== next.renamingFolderId) return false;

  return true;
};

function SessionNodeItemComponent(props: Props): React.ReactNode {
  const { t } = useI18n();
  const {
    node,
    depth = 0,
    groupDirectory,
    projectId,
    archivedBucket = false,
    userActivityTimestamp,
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
    scheduleSessionPrefetch,
    cancelSessionPrefetch,
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
    handleDeleteSession,
    mobileVariant,
    alwaysShowActions,
    renderSessionNode,
    renderContext = 'project',
  } = props;
  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);
  const isElectron = React.useMemo(() => canUseElectronDesktopIPC(), []);
  const session = node.session;
  const isArchiveAncestorOnly = archivedBucket && node.isArchiveAncestorOnly === true;
  const canRevealMobileActions = mobileVariant && !archivedBucket && !isArchiveAncestorOnly;
  const showQuickPinAction = !archivedBucket && !mobileVariant;
  const showQuickArchiveAction = !archivedBucket && !mobileVariant;
  const showQuickUnarchiveAction = archivedBucket && !isArchiveAncestorOnly && !mobileVariant;
  const showQuickDeleteAction = archivedBucket && !isArchiveAncestorOnly && !mobileVariant;
  const {
    revealOnHoverClass,
    hideOnHoverClass,
    revealPaddingClass,
  } = resolveSessionRowInteractionClasses();
  const alwaysActionPaddingClass = 'pr-10';
  const suppressNextSelectRef = React.useRef(false);
  const mobileSwipeRef = React.useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    didTrigger: boolean;
  } | null>(null);
  const [isTouchPressed, setIsTouchPressed] = React.useState(false);
  const [mobileActionsRevealed, setMobileActionsRevealed] = React.useState(false);
  const liveSession = useSession(session.id);
  const resolvedSession = liveSession ?? session;
  const sessionDirectoryHint = useSessionUIStore(
    React.useCallback(
      (state) => state.sessionDirectoryHints.get(session.id) ?? null,
      [session.id],
    ),
  );

  const sessionDirectory = resolveSessionRoutingDirectory(
    sessionDirectoryHint,
    (session as Session & { directory?: string | null }).directory ?? null,
    groupDirectory,
  );
  const directoryStore = useDirectoryStore(sessionDirectory ?? undefined);
  const sync = useSync();
  const { diagnostics } = useRuntimeAPIs();

  const selectionModeEnabled = useSessionMultiSelectStore((state) => state.enabled);
  const isRowSelected = useSessionMultiSelectStore(
    React.useCallback((state) => state.selectedIds.has(session.id), [session.id]),
  );
  const toggleRowSelected = useSessionMultiSelectStore((state) => state.toggleSelected);
  const setRowRange = useSessionMultiSelectStore((state) => state.setRange);

  const collectNodeDescendantIds = React.useCallback((root: SessionNode): string[] => {
    const out: string[] = [];
    const walk = (n: SessionNode) => {
      n.children.forEach((child) => {
        out.push(child.session.id);
        walk(child);
      });
    };
    walk(root);
    return out;
  }, []);

  const [exportDialogOpen, setExportDialogOpen] = React.useState(false);
  const [exportIncludeSubtasks, setExportIncludeSubtasks] = React.useState(true);
  const exportInFlightRef = React.useRef(false);

  const menuInstanceKey = `${renderContext}:${archivedBucket ? 'archived' : 'active'}:${session.id}`;
  const isZombie = useViewportStore(
    React.useCallback((state) => Boolean(state.sessionMemoryState.get(session.id)?.isZombie), [session.id]),
  );
  const sessionPermissions = useSessionPermissions(session.id, sessionDirectory ?? undefined);
  const isSessionWorking = useIsSessionWorking(session.id, sessionDirectory ?? undefined);
  const sessionParentId = (session as Session & { parentID?: string | null }).parentID ?? null;
  const isRootSession = !sessionParentId;
  const descendantSessionIds = React.useMemo(
    () => isRootSession ? collectNodeDescendantIds(node) : EMPTY_SESSION_IDS,
    [collectNodeDescendantIds, isRootSession, node],
  );
  const hasWorkingDescendant = useDirectorySync(
    React.useCallback(
      (state) => hasWorkingDescendantSession(descendantSessionIds, state),
      [descendantSessionIds],
    ),
    sessionDirectory ?? undefined,
  );
  const managedSubtaskAgent = useManagedOrchestrationStore(React.useMemo(
    () => managedOrchestrationSelectors.latestTaskAgentForChildSession(
      isRootSession ? '' : session.id,
    ),
    [isRootSession, session.id],
  ));
  const subagentName = !isRootSession
    ? resolveSubtaskIconAgent({
      managedTaskAgent: managedSubtaskAgent,
      sessionAgent: (resolvedSession as Session & { agent?: unknown }).agent,
    })
    : undefined;
  const questionScopeSessionIds = React.useMemo(() => {
    if (!isRootSession) return EMPTY_SESSION_IDS;

    // Parent chats surface pending subagent questions inline; keep the sidebar
    // indicator on the parent/root row only instead of showing child-row dots.
    return [session.id, ...descendantSessionIds];
  }, [descendantSessionIds, isRootSession, session.id]);
  const hasUnreadError = useNotificationStore(
    React.useCallback((state) => {
      if (questionScopeSessionIds.length === 0) return false;
      return questionScopeSessionIds.some((sessionId) => (
        state.index.session.unseenHasError[sessionId] ?? false
      ));
    }, [questionScopeSessionIds]),
  );
  const pendingQuestionCount = useDirectorySync(
    React.useCallback((state) => {
      if (questionScopeSessionIds.length === 0) return 0;

      let count = 0;
      for (const sessionId of questionScopeSessionIds) {
        count += state.question[sessionId]?.length ?? 0;
      }
      return count;
    }, [questionScopeSessionIds]),
    sessionDirectory ?? undefined,
  );
  const planIndicatorState = useSessionUIStore(
    React.useCallback((state) => {
      if (!isRootSession) return null;
      return resolveEffectivePlanIndicatorState(
        state.sessionPlanIndicator.get(session.id),
        state.planModeUserMessagesBySession.get(session.id),
      );
    }, [isRootSession, session.id]),
  );
  const hasPrimaryRecovery = useProviderRecoveryStore(
    React.useCallback((state) => (
      isRootSession && Boolean(state.recoveriesBySessionId[session.id])
    ), [isRootSession, session.id]),
  );
  const hasManagedRecovery = useManagedOrchestrationStore(React.useMemo(
    () => managedOrchestrationSelectors.hasManualRecoveryForRoot(
      isRootSession ? session.id : '',
    ),
    [isRootSession, session.id],
  ));
  const hasActiveManagedSubtask = useManagedOrchestrationStore(React.useMemo(
    () => managedOrchestrationSelectors.hasActiveTasksForRoot(
      isRootSession ? session.id : '',
    ),
    [isRootSession, session.id],
  ));
  const parentOwnedRecoveryTaskId = useManagedOrchestrationStore(React.useMemo(
    () => managedOrchestrationSelectors.manualRecoveryTaskIdForChildSession(
      isRootSession ? '' : session.id,
    ),
    [isRootSession, session.id],
  ));
  const sidebarIsWorking = resolveSidebarWorkingStatus({
    isWorking: (isSessionWorking || hasWorkingDescendant || hasActiveManagedSubtask) && !hasPrimaryRecovery,
    pendingQuestionCount,
    planState: planIndicatorState,
  });
  const directoryState = sessionDirectory ? directoryStatus.get(sessionDirectory) : null;
  const isMissingDirectory = directoryState === 'missing';
  const isActive = currentSessionId === session.id;
  const sessionTitle = resolveDisplaySessionTitle({
    title: resolvedSession.title,
    fallback: t('sessions.sidebar.session.untitled'),
  });
  const hasChildren = node.children.length > 0;
  const isPinnedSession = pinnedSessionIds.has(session.id);
  const isExpanded = hasSessionSearchQuery ? true : expandedParents.has(session.id);
  const hasCompletedStatus = useSessionUIStore(
    React.useCallback((state) => {
      if (!isRootSession) return false;
      return state.sessionCompletionIndicator.has(session.id);
    }, [isRootSession, session.id]),
  );
  // Plan-proposed transitions are owned by the sync layer (sync-context.tsx
  // → detectAndMarkPlanProposed on session.idle). This component only reads
  // the indicator state; it does not trigger transitions.
  const effectivePlanIndicatorState: PlanIndicatorState | null = planIndicatorState;
  // Consolidated per-session lifecycle status. Used for accessible status text;
  // the spinner stays neutral gray across lifecycle variants by design.
  const lifecycleStatus = useSessionLifecycleStatus(
    isRootSession ? session.id : null,
    sessionDirectory ?? undefined,
  );
  const sessionHasUnreadCompletion = useNotificationStore(
    React.useCallback((state) => state.index.session.unseenHasCompletion[session.id] ?? false, [session.id]),
  );
  const sessionHasUnreadError = useNotificationStore(
    React.useCallback((state) => state.index.session.unseenHasError[session.id] ?? false, [session.id]),
  );
  const sessionTimestamp = userActivityTimestamp ?? resolvedSession.time?.updated ?? resolvedSession.time?.created ?? Date.now();
  const sessionCompactUpdatedLabel = formatSessionCompactDateLabel(sessionTimestamp);
  const isMenuOpen = openSidebarMenuKey === menuInstanceKey;
  const workingStatusPaddingClass = sidebarIsWorking ? 'pr-6' : '';

  const descendantCount = React.useMemo(() => collectNodeDescendantIds(node).length, [collectNodeDescendantIds, node]);

  const collectChildExports = React.useCallback(async (children: SessionNode[]): Promise<{ children: ChildSessionExport[]; skipped: number }> => {
    const results: ChildSessionExport[] = [];
    let skipped = 0;
    for (const child of children) {
      try {
        await sync.ensureSessionRenderable(child.session.id);
        const childRecords = buildSessionMessageRecordsSnapshot(directoryStore.getState(), child.session.id).list;
        const childTitle = resolveDisplaySessionTitle({
          title: child.session.title,
          fallback: t('sessions.sidebar.session.export.untitledSubagent'),
        });
        const childAgent = (child.session as Session & { agent?: string }).agent;
        const grandChildren = await collectChildExports(child.children);
        skipped += grandChildren.skipped;
        results.push({
          title: childTitle,
          agent: childAgent,
          records: childRecords,
          children: grandChildren.children,
        });
      } catch {
        skipped += collectNodeDescendantIds(child).length + 1;
      }
    }
    return { children: results, skipped };
  }, [collectNodeDescendantIds, directoryStore, sync, t]);

  const showSkippedSubtasksWarning = React.useCallback((count: number) => {
    if (count <= 0) return;
    toast.warning(count === 1
      ? t('sessions.sidebar.session.export.skippedSubtaskSingle', { count })
      : t('sessions.sidebar.session.export.skippedSubtaskMany', { count }));
  }, [t]);

  const doExportSession = React.useCallback(async (includeSubtasks: boolean) => {
    if (exportInFlightRef.current) return;

    if (!sessionDirectory) {
      toast.error(t('sessions.sidebar.session.export.nothingToExport'));
      return;
    }

    exportInFlightRef.current = true;
    const preparingToastId = `session-export-preparing-${session.id}`;
    toast.loading(t('sessions.sidebar.session.export.preparing'), { id: preparingToastId });

    try {
      const preparedExportPromise = (async () => {
        await sync.ensureSessionRenderable(session.id);

        const records = buildSessionMessageRecordsSnapshot(directoryStore.getState(), session.id).list;
        if (records.length === 0) {
          throw new EmptySessionExportError();
        }

        let childExports: ChildSessionExport[] | undefined;
        let skippedSubtaskCount = 0;
        if (includeSubtasks && node.children.length > 0) {
          const collected = await collectChildExports(node.children);
          childExports = collected.children;
          skippedSubtaskCount = collected.skipped;
        }

        return {
          markdown: formatSessionAsMarkdown(records, resolvedSession.title ?? null, childExports),
          skippedSubtaskCount,
        };
      })();

      const filename = buildExportFilename(resolvedSession.title ?? null);
      const saveResult = await saveSessionExportMarkdown(
        preparedExportPromise.then((prepared) => prepared.markdown),
        filename,
      );

      if (saveResult.status === 'canceled') {
        return;
      }

      const preparedExport = await preparedExportPromise;

      if (saveResult.status === 'downloaded') {
        toast.success(t('sessions.sidebar.session.export.downloaded'));
        showSkippedSubtasksWarning(preparedExport.skippedSubtaskCount);
        return;
      }

      if (saveResult.status === 'saved' && saveResult.path) {
        const savedPath = saveResult.path;
        toast.success(t('sessions.sidebar.session.export.success'), {
          action: {
            label: t(getExportRevealLabelKey()),
            onClick: () => {
              void revealExportedMarkdown(savedPath).then((revealed) => {
                if (!revealed) {
                  toast.error(t('sessions.sidebar.session.export.failedRevealPath'));
                }
              });
            },
          },
        });
        showSkippedSubtasksWarning(preparedExport.skippedSubtaskCount);
        return;
      }

      toast.success(t('sessions.sidebar.session.export.success'));
      showSkippedSubtasksWarning(preparedExport.skippedSubtaskCount);
    } catch (error) {
      if (error instanceof EmptySessionExportError) {
        toast.error(t('sessions.sidebar.session.export.nothingToExport'));
        return;
      }
      toast.error(t('sessions.sidebar.session.export.failed'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      toast.dismiss(preparingToastId);
      exportInFlightRef.current = false;
    }
  }, [collectChildExports, directoryStore, node.children, resolvedSession.title, session.id, sessionDirectory, showSkippedSubtasksWarning, sync, t]);
  const handleExportSession = React.useCallback(async () => {
    if (node.children.length > 0) {
      setExportIncludeSubtasks(true);
      setExportDialogOpen(true);
      return;
    }
    await doExportSession(false);
  }, [doExportSession, node.children.length]);
  const handleExportDiagnostics = React.useCallback(async () => {
    if (!diagnostics) {
      toast.error(t('sessions.sidebar.session.exportDiagnostics.unavailable'));
      return;
    }
    try {
      const result = await diagnostics.export({
        scope: 'task',
        sessionID: session.id,
        directory: sessionDirectory || undefined,
      });
      if (!result.cancelled) {
        toast.success(t('sessions.sidebar.session.exportDiagnostics.success', { fileName: result.fileName }));
      }
    } catch (error) {
      toast.error(t('sessions.sidebar.session.exportDiagnostics.failed'), {
        description: error instanceof Error ? error.message : undefined,
      });
    }
  }, [diagnostics, session.id, sessionDirectory, t]);

  const handleOpenMiniChatWindow = React.useCallback(() => {
    if (!sessionDirectory) return;
    void invokeDesktop('desktop_open_session_mini_chat_window', {
      sessionId: session.id,
      directory: sessionDirectory,
    }).catch((error) => {
      console.warn('[session-sidebar] failed to open mini chat window', error);
    });
  }, [session.id, sessionDirectory]);

  if (editingId === session.id) {
    return (
      <div
        key={session.id}
        className={cn('group relative flex items-center rounded-sm px-1.5 py-1', depth > 0 && 'pl-[20px]')}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-0">
          <form
            className="flex w-full items-center gap-2"

            onSubmit={(event) => {
              event.preventDefault();
              handleSaveEdit();
            }}
          >
            <input
              value={editTitle}
              onChange={(event) => setEditTitle(event.target.value)}
              className="flex-1 min-w-0 bg-transparent typography-ui-label outline-none placeholder:text-muted-foreground"
              autoFocus
              placeholder={t('sessions.sidebar.session.menu.rename')}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation();
                  handleCancelEdit();
                  return;
                }
                if (event.key === ' ' || event.key === 'Enter') {
                  event.stopPropagation();
                }
              }}
            />
            <button type="submit" className="shrink-0 text-muted-foreground hover:text-foreground"><RiCheckLine className="size-4" /></button>
            <button type="button" onClick={handleCancelEdit} className="shrink-0 text-muted-foreground hover:text-foreground"><RiCloseLine className="size-4" /></button>
          </form>
        </div>
      </div>
    );
  }

  const pendingPermissionCount = sessionPermissions.length;
  const sidebarStatusIndicator = resolveSidebarIndicator({
    isRootSession,
    isWorking: sidebarIsWorking,
    isActive,
    hasUnreadCompletion: sessionHasUnreadCompletion,
    hasCompletedStatus,
    hasErrorStatus: hasUnreadError || hasPrimaryRecovery || hasManagedRecovery,
    pendingQuestionCount,
    planState: effectivePlanIndicatorState,
  });
  const subtaskStatusIndicator: SessionIndicator | null = resolveSubtaskSidebarIndicator({
    isRootSession,
    notifyOnSubtasks,
    isWorking: isSessionWorking,
    isActive,
    hasUnreadCompletion: sessionHasUnreadCompletion,
    hasUnreadError: sessionHasUnreadError,
    hasParentOwnedRecovery: Boolean(parentOwnedRecoveryTaskId),
  });
  const effectiveSidebarStatusIndicator = sidebarStatusIndicator ?? subtaskStatusIndicator;
  const showLeadingStatus = Boolean(effectiveSidebarStatusIndicator);
  const leadingRailLayout = resolveLeadingRailLayout({
    hasChildren,
    showLeadingStatus,
    isPinnedSession,
  });
  const leadingStatusMarker = effectiveSidebarStatusIndicator ? (
    <span
      className={cn('h-1.5 w-1.5 rounded-full', effectiveSidebarStatusIndicator.className)}
      aria-label={t(effectiveSidebarStatusIndicator.labelKey)}
      title={t(effectiveSidebarStatusIndicator.labelKey)}
    />
  ) : null;
  // Generic unread attention intentionally has no dot here: session status colors
  // are reserved for explicit question/plan lifecycle signals, so success never
  // degrades into a neutral/gray marker when unread state changes.
  const isImplementingPlan = lifecycleStatus.kind === 'plan-executing';
  const activeStatusMarker = sidebarIsWorking ? (
    <SidebarSpinner
      aria-label={t(isImplementingPlan
        ? 'sessions.sidebar.session.status.planExecuting'
        : 'sessions.sidebar.session.status.active')}
      title={t(isImplementingPlan
        ? 'sessions.sidebar.session.status.planExecuting'
        : 'sessions.sidebar.session.status.active')}
    />
  ) : null;
  const handleSubsessionChevronPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const handleSubsessionChevronMouseDown = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const subsessionChevron = hasChildren ? (
    <button
      type="button"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleParent(session.id);
      }}
      onPointerDown={handleSubsessionChevronPointerDown}
      onMouseDown={handleSubsessionChevronMouseDown}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          toggleParent(session.id);
        }
      }}
      className="inline-flex h-3.5 w-full max-w-3.5 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
      aria-label={isExpanded
        ? t('sessions.sidebar.session.subsessions.collapse')
        : t('sessions.sidebar.session.subsessions.expand')}
    >
      <RiArrowDownSLine className={cn('h-3 w-3 transition-transform duration-150 ease-[cubic-bezier(0.33,1,0.68,1)]', isExpanded ? 'rotate-0' : '-rotate-90')} />
    </button>
  ) : null;
  const leadingPinMarker = (
    <RiPushpinLine
      className="h-3 w-3 flex-shrink-0 text-primary"
      aria-label={t('sessions.sidebar.session.status.pinned')}
    />
  );
  const leadingRailSlotContent = {
    status: leadingStatusMarker,
    pin: leadingPinMarker,
    chevron: subsessionChevron,
  };
  const leadingRail = (
    <span
      data-session-leading-rail
      className="absolute right-full top-1/2 mr-0.5 grid h-4 w-9 flex-shrink-0 -translate-y-1/2 grid-cols-[minmax(0,4fr)_minmax(0,7fr)_2px_minmax(0,7fr)_1px] items-center justify-items-center"
    >
      {leadingRailLayout.slots.map((slot, index) => (
        <span
          key={index}
          className={cn(
            'inline-flex items-center justify-center',
            index === 1 && 'justify-self-end',
            index === 2 && 'col-start-4',
            slot === 'status' ? 'h-2 w-2' : 'h-3.5 w-full max-w-3.5',
            slot !== 'chevron' && 'pointer-events-none',
          )}
        >
          {slot ? leadingRailSlotContent[slot] : null}
        </span>
      ))}
    </span>
  );

  const streamingIndicator = isZombie
    ? <RiErrorWarningLine className="h-4 w-4 text-status-warning" />
    : null;

  const handleMenuOpenChange = (open: boolean) => {
    setOpenSidebarMenuKey(open ? menuInstanceKey : null);
  };

  const handleQuickArchivePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const handleQuickArchiveMouseDown = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const handleQuickArchiveClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setOpenSidebarMenuKey(null);
    setMobileActionsRevealed(false);
    handleArchiveSession(session);
  };

  const handleQuickPinClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setOpenSidebarMenuKey(null);
    setMobileActionsRevealed(false);
    togglePinnedSession(session.id);
  };

  const handleQuickUnarchiveClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setOpenSidebarMenuKey(null);
    handleUnarchiveSession(session);
  };

  const handleQuickDeleteClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setOpenSidebarMenuKey(null);
    handleDeleteSession(session, { archivedBucket: true });
  };

  const quickActionButtonClass = cn(
    'inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 transition-opacity',
    !alwaysShowActions ? 'h-5 w-5' : 'h-6 w-6',
  );

  const handleRowSelect = (event?: React.MouseEvent<HTMLButtonElement>) => {
    if (suppressNextSelectRef.current) {
      suppressNextSelectRef.current = false;
      return;
    }
    if (selectionModeEnabled && !isArchiveAncestorOnly) {
      event?.preventDefault();
      event?.stopPropagation();
      if (event?.shiftKey) {
        const rows = typeof document !== 'undefined'
          ? Array.from(document.querySelectorAll<HTMLElement>('[data-session-row]'))
          : [];
        const orderedIds = rows
          .map((el) => el.getAttribute('data-session-row'))
          .filter((id): id is string => typeof id === 'string' && id.length > 0);
        const currentAnchor = useSessionMultiSelectStore.getState().anchorId;
        const descendantsById = new Map<string, string[]>();
        descendantsById.set(session.id, collectNodeDescendantIds(node));
        setRowRange(currentAnchor, session.id, orderedIds, sessionDirectory ?? null, descendantsById);
        return;
      }
      toggleRowSelected(session.id, sessionDirectory ?? null, collectNodeDescendantIds(node));
      return;
    }
    handleSessionSelect(session.id, sessionDirectory, isMissingDirectory, projectId);
  };

  const handleRowMouseDown = (event: React.MouseEvent<HTMLButtonElement>) => {
    const auxAction = resolveSessionRowAuxAction(event.button, archivedBucket, isArchiveAncestorOnly);
    if (auxAction) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.button === 2 || (event.button === 0 && event.ctrlKey && !selectionModeEnabled)) {
      suppressNextSelectRef.current = true;
      return;
    }
    if (event.button === 0 && !selectionModeEnabled && sessionDirectory && !isMissingDirectory) {
      prepareSession(session.id, sessionDirectory);
    }
  };

  const handleRowContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    // Context-menu opens the existing session actions without allowing the
    // preceding right-click/ctrl-click mouse down to suppress the next normal select.
    suppressNextSelectRef.current = false;
    setOpenSidebarMenuKey(menuInstanceKey);
  };

  const handleRowAuxClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    const auxAction = resolveSessionRowAuxAction(event.button, archivedBucket, isArchiveAncestorOnly);
    if (!auxAction) return;
    event.preventDefault();
    event.stopPropagation();
    setOpenSidebarMenuKey(null);
    if (auxAction === 'delete') {
      handleDeleteSession(session, { archivedBucket: true });
      return;
    }
    handleArchiveSession(session);
  };

  const handleRowPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (mobileVariant && event.pointerType === 'touch') {
      setIsTouchPressed(true);
    }
    if (!canRevealMobileActions || event.button !== 0) return;
    event.stopPropagation();
    mobileSwipeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      didTrigger: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleRowPointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const gesture = mobileSwipeRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const action = resolveMobileSessionSwipeAction(
      event.clientX - gesture.startX,
      event.clientY - gesture.startY,
    );
    if (!action) return;

    gesture.didTrigger = true;
    suppressNextSelectRef.current = true;
    setIsTouchPressed(false);
    setMobileActionsRevealed(action === 'reveal');
    event.preventDefault();
    event.stopPropagation();
  };

  const handleRowPointerEnd = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (mobileVariant && event.pointerType === 'touch') {
      setIsTouchPressed(false);
    }
    const gesture = mobileSwipeRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    mobileSwipeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!gesture.didTrigger) return;

    suppressNextSelectRef.current = true;
    event.preventDefault();
    event.stopPropagation();
    window.setTimeout(() => {
      suppressNextSelectRef.current = false;
    }, 0);
  };

  const sessionMenuContent = (
    <DropdownMenuContent align="end" className="min-w-[180px]" onCloseAutoFocus={(event) => { if (renamingFolderId) event.preventDefault(); }}>
      {archivedBucket && !isArchiveAncestorOnly ? (
        <>
          <DropdownMenuItem onClick={() => handleUnarchiveSession(session)} className="[&>svg]:mr-1">
            <RiArchiveLine className="mr-1 h-4 w-4" />
            {t('sessions.sidebar.session.menu.unarchive')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
        </>
      ) : null}
      <DropdownMenuItem
        onClick={() => {
          setEditingId(session.id);
          setEditTitle(sessionTitle);
        }}
        className="[&>svg]:mr-1"
      >
        <RiPencilAiLine className="mr-1 h-4 w-4" />
        {t('sessions.sidebar.session.menu.rename')}
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => togglePinnedSession(session.id)} className="[&>svg]:mr-1">
        {isPinnedSession ? <RiUnpinLine className="mr-1 h-4 w-4" /> : <RiPushpinLine className="mr-1 h-4 w-4" />}
        {isPinnedSession ? t('sessions.sidebar.session.menu.unpin') : t('sessions.sidebar.session.menu.pin')}
      </DropdownMenuItem>
      {resolvedSession.share ? (
        <>
          <DropdownMenuItem onClick={() => { if (resolvedSession.share?.url) handleCopyShareUrl(resolvedSession.share.url, session.id); }} className="[&>svg]:mr-1">
            {copiedSessionId === session.id
              ? <><RiCheckLine className="mr-1 h-4 w-4" style={{ color: 'var(--status-success)' }} />{t('sessions.sidebar.session.menu.copied')}</>
              : <><RiFileCopyLine className="mr-1 h-4 w-4" />{t('sessions.sidebar.session.menu.copyLink')}</>}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleUnshareSession(session.id)} className="[&>svg]:mr-1">
            <RiLinkUnlinkM className="mr-1 h-4 w-4" />
            {t('sessions.sidebar.session.menu.unshare')}
          </DropdownMenuItem>
        </>
      ) : null}
      <DropdownMenuItem onClick={() => { void handleExportSession(); }} className="[&>svg]:mr-1">
        <RiDownloadLine className="mr-1 h-4 w-4" />
        {t('sessions.sidebar.session.menu.exportMarkdown')}
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => { void handleExportDiagnostics(); }} className="[&>svg]:mr-1">
        <RiShieldLine className="mr-1 h-4 w-4" />
        {t('sessions.sidebar.session.menu.exportDiagnostics')}
      </DropdownMenuItem>

      {sessionDirectory && !archivedBucket ? (() => {
        const scopeFolders = getFoldersForScope(sessionDirectory);
        const currentFolderId = getSessionFolderId(sessionDirectory, session.id);
        return (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="[&>svg]:mr-1"><RiFolderLine className="h-4 w-4" />{t('sessions.sidebar.folders.moveToFolder')}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-[180px]">
                {scopeFolders.length === 0 ? (
                  <DropdownMenuItem disabled className="text-muted-foreground">{t('sessions.sidebar.folders.none')}</DropdownMenuItem>
                ) : (
                  scopeFolders.map((folder) => (
                    <DropdownMenuItem key={folder.id} onClick={() => { if (currentFolderId === folder.id) removeSessionFromFolder(sessionDirectory, session.id); else addSessionToFolder(sessionDirectory, folder.id, session.id); }}>
                      <span className="flex-1 truncate">{folder.name}</span>
                      {currentFolderId === folder.id ? <RiCheckLine className="ml-2 h-3.5 w-3.5 text-primary flex-shrink-0" /> : null}
                    </DropdownMenuItem>
                  ))
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => { const newFolder = createFolderAndStartRename(sessionDirectory); if (!newFolder) return; addSessionToFolder(sessionDirectory, newFolder.id, session.id); }}>
                  <RiAddLine className="mr-1 h-4 w-4" />
                  {t('sessions.sidebar.folders.newFolderEllipsis')}
                </DropdownMenuItem>
                {currentFolderId ? (
                  <DropdownMenuItem onClick={() => { removeSessionFromFolder(sessionDirectory, session.id); }} className="text-destructive focus:text-destructive">
                    <RiCloseLine className="mr-1 h-4 w-4" />
                    {t('sessions.sidebar.folders.removeFromFolder')}
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        );
      })() : null}

      {isElectron ? (
        <DropdownMenuItem
          disabled={!sessionDirectory}
          onClick={handleOpenMiniChatWindow}
          className="[&>svg]:mr-1"
        >
          <RiWindowLine className="mr-1 h-4 w-4" />
          <span className="truncate">{t('sessions.sidebar.session.menu.openMiniChatWindow')}</span>
        </DropdownMenuItem>
      ) : null}

      {!isArchiveAncestorOnly ? (
        <>
          <DropdownMenuSeparator />
          {archivedBucket ? (
            <DropdownMenuItem variant="destructive" className="[&>svg]:mr-1" onClick={() => handleDeleteSession(session, { archivedBucket: true })}>
              <RiDeleteBinLine className="mr-1 h-4 w-4" />
              {t('sessions.sidebar.bulkActions.delete')}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem className="[&>svg]:mr-1" onClick={() => handleArchiveSession(session)}>
              <RiArchiveLine className="mr-1 h-4 w-4" />
              {t('sessions.sidebar.bulkActions.archive')}
            </DropdownMenuItem>
          )}
        </>
      ) : null}
    </DropdownMenuContent>
  );

  return (
    <React.Fragment key={session.id}>
      <SessionSidebarMotionRow>
        <DraggableSessionRow sessionId={session.id} sessionDirectory={sessionDirectory ?? null} sessionTitle={sessionTitle}>
          <div
            data-session-row={session.id}
            data-session-scope={sessionDirectory ?? ''}
            data-session-archived={archivedBucket ? '1' : '0'}
            data-session-archive-ancestor={isArchiveAncestorOnly ? '1' : '0'}
            data-mobile-drawer-drag-lock={mobileVariant ? 'true' : undefined}
            onContextMenu={handleRowContextMenu}
            className={cn(
              'group @container/session-sidebar-row relative my-0.5 flex items-center rounded-sm px-1.5 py-1',
              isMissingDirectory ? 'opacity-75' : '',
              depth > 0 && 'pl-[20px]',
              isRowSelected && 'bg-primary/15',
            )}
          >
            <div className="relative -ml-px flex min-w-0 flex-1 items-center">
              {leadingRail}
              <button
                type="button"
                disabled={isMissingDirectory}
                onPointerDown={handleRowPointerDown}
                onPointerMove={handleRowPointerMove}
                onPointerUp={handleRowPointerEnd}
                onPointerCancel={handleRowPointerEnd}
                onMouseDown={handleRowMouseDown}
                onMouseEnter={() => scheduleSessionPrefetch(session.id, sessionDirectory)}
                onMouseLeave={() => cancelSessionPrefetch(session.id)}
                onFocus={() => scheduleSessionPrefetch(session.id, sessionDirectory, 0)}
                onAuxClick={handleRowAuxClick}
                onClick={(event) => handleRowSelect(event)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  handleSessionDoubleClick();
                }}
                className={cn(
                  'flex min-w-0 flex-1 cursor-pointer flex-col gap-0 overflow-hidden rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 text-foreground select-none disabled:cursor-not-allowed transition-[padding]',
                  mobileVariant && 'touch-pan-y',
                  isTouchPressed && 'bg-interactive-hover/70',
                  alwaysShowActions
                    ? (isVSCode ? revealPaddingClass : alwaysActionPaddingClass)
                    : revealPaddingClass,
                  alwaysShowActions && !isVSCode ? '' : workingStatusPaddingClass,
                )}
              >
                <div className="flex w-full items-center min-w-0 flex-1 overflow-hidden gap-1">
                  <div className={cn('flex min-w-0 flex-1 items-center gap-1.5 typography-ui-label font-normal', isActive ? 'text-primary' : 'text-foreground')}>
                    {!isRootSession ? (
                      <RiAiAgentLine
                        className="h-3.5 w-3.5 flex-shrink-0"
                        style={{ color: `var(${getAgentIconColor(subagentName).var})` }}
                        aria-hidden="true"
                      />
                    ) : null}
                    <span className="min-w-0 flex-1 truncate">
                      {renderHighlightedText(sessionTitle, normalizedSessionSearchQuery)}
                    </span>
                  </div>
                  {alwaysShowActions ? <span className="session-sidebar-row__compact-time ml-2 flex-shrink-0 text-[0.72rem] text-muted-foreground/75">{sessionCompactUpdatedLabel}</span> : null}
                  {!alwaysShowActions ? (
                    <div className="relative ml-1 flex h-4 min-w-4 flex-shrink-0 items-center justify-end">
                      <span className={cn(
                        'session-sidebar-row__compact-time whitespace-nowrap text-right text-[0.72rem] text-muted-foreground/75 transition-opacity duration-150',
                        isMenuOpen
                          ? 'opacity-0'
                          : hideOnHoverClass,
                      )}>
                        {sessionCompactUpdatedLabel}
                      </span>
                    </div>
                  ) : null}
                  {pendingPermissionCount > 0 ? (
                    <span className="inline-flex items-center gap-1 rounded bg-destructive/10 px-1 py-0.5 text-[0.7rem] text-destructive flex-shrink-0" title={t('sessions.sidebar.session.status.permissionRequired')} aria-label={t('sessions.sidebar.session.status.permissionRequired')}>
                      <RiShieldLine className="h-3 w-3" />
                      <span className="leading-none">{pendingPermissionCount}</span>
                    </span>
                  ) : null}
                </div>
              </button>
            </div>

            {canRevealMobileActions ? (
              <div
                data-mobile-session-actions
                aria-hidden={!mobileActionsRevealed}
                className={cn(
                  'absolute right-0 top-1/2 z-30 flex -translate-y-1/2 items-center gap-1 rounded-md bg-sidebar p-0.5 shadow-sm ring-1 ring-border/50 transition-[opacity,transform] duration-150',
                  mobileActionsRevealed
                    ? 'translate-x-0 opacity-100'
                    : 'pointer-events-none translate-x-2 opacity-0',
                )}
              >
                <button
                  type="button"
                  disabled={!mobileActionsRevealed}
                  className="inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-md px-2 typography-micro font-medium text-primary hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                  aria-label={isPinnedSession
                    ? t('sessions.sidebar.session.menu.unpin')
                    : t('sessions.sidebar.session.menu.pin')}
                  onClick={handleQuickPinClick}
                >
                  {isPinnedSession
                    ? <RiUnpinLine className="h-3.5 w-3.5" />
                    : <RiPushpinLine className="h-3.5 w-3.5" />}
                  <span>
                    {isPinnedSession
                      ? t('sessions.sidebar.session.mobileAction.unpin')
                      : t('sessions.sidebar.session.mobileAction.pin')}
                  </span>
                </button>
                <button
                  type="button"
                  disabled={!mobileActionsRevealed}
                  className="inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-md px-2 typography-micro font-medium text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                  aria-label={t('sessions.sidebar.bulkActions.archive')}
                  onClick={handleQuickArchiveClick}
                >
                  <RiArchiveLine className="h-3.5 w-3.5" />
                  <span>{t('sessions.sidebar.bulkActions.archive')}</span>
                </button>
              </div>
            ) : null}

            {streamingIndicator && !mobileVariant ? (
              <div className="absolute top-1/2 -translate-y-1/2 z-10 right-0">
                {streamingIndicator}
              </div>
            ) : null}

            {activeStatusMarker ? (
              <div className={cn(
                'pointer-events-none absolute right-0 top-1/2 z-20 flex h-6 w-6 -translate-y-1/2 items-center justify-center transition-opacity',
                isMenuOpen ? 'opacity-0' : 'opacity-100 group-hover:opacity-0 group-focus-within:opacity-0',
              )}>
                {activeStatusMarker}
              </div>
            ) : null}

            <div className={cn(
              'absolute right-0 top-1/2 z-10 flex -translate-y-1/2 items-center gap-0.5 transition-opacity',
              isMenuOpen
                ? 'opacity-100'
                : (alwaysShowActions && !isVSCode)
                  ? 'opacity-100'
                  : cn('opacity-0', revealOnHoverClass),
            )}>
              {showQuickPinAction ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className={quickActionButtonClass}
                      aria-label={isPinnedSession
                        ? t('sessions.sidebar.session.menu.unpin')
                        : t('sessions.sidebar.session.menu.pin')}
                      onPointerDown={handleQuickArchivePointerDown}
                      onMouseDown={handleQuickArchiveMouseDown}
                      onClick={handleQuickPinClick}
                      onKeyDown={(event) => event.stopPropagation()}
                    >
                      {isPinnedSession
                        ? <RiUnpinLine className="h-3.5 w-3.5" />
                        : <RiPushpinLine className="h-3.5 w-3.5" />}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="left" sideOffset={8}>
                    {isPinnedSession
                      ? t('sessions.sidebar.session.menu.unpin')
                      : t('sessions.sidebar.session.menu.pin')}
                  </TooltipContent>
                </Tooltip>
              ) : null}
              {showQuickArchiveAction ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className={quickActionButtonClass}
                      aria-label={t('sessions.sidebar.bulkActions.archive')}
                      onPointerDown={handleQuickArchivePointerDown}
                      onMouseDown={handleQuickArchiveMouseDown}
                      onClick={handleQuickArchiveClick}
                      onKeyDown={(event) => event.stopPropagation()}
                    >
                      <RiArchiveLine className="h-3.5 w-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="left" sideOffset={8}>
                    {t('sessions.sidebar.bulkActions.archive')}
                  </TooltipContent>
                </Tooltip>
              ) : null}
              {showQuickUnarchiveAction ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className={quickActionButtonClass}
                      aria-label={t('sessions.sidebar.session.menu.unarchive')}
                      onPointerDown={handleQuickArchivePointerDown}
                      onMouseDown={handleQuickArchiveMouseDown}
                      onClick={handleQuickUnarchiveClick}
                      onKeyDown={(event) => event.stopPropagation()}
                    >
                      <RiArrowGoBackLine className="h-3.5 w-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="left" sideOffset={8}>
                    {t('sessions.sidebar.session.menu.unarchive')}
                  </TooltipContent>
                </Tooltip>
              ) : null}
              {showQuickDeleteAction ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className={quickActionButtonClass}
                      aria-label={t('sessions.sidebar.bulkActions.delete')}
                      onPointerDown={handleQuickArchivePointerDown}
                      onMouseDown={handleQuickArchiveMouseDown}
                      onClick={handleQuickDeleteClick}
                      onKeyDown={(event) => event.stopPropagation()}
                    >
                      <RiDeleteBinLine className="h-3.5 w-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="left" sideOffset={8}>
                    {t('sessions.sidebar.bulkActions.delete')}
                  </TooltipContent>
                </Tooltip>
              ) : null}
              <DropdownMenu open={isMenuOpen} onOpenChange={handleMenuOpenChange}>
                <DropdownMenuTrigger asChild nativeButton={false}>
                  {/* Keep an invisible anchor so the controlled context menu opens
                      where the former hover trigger lived, without exposing a
                      three-dots button on hover. */}
                  <span aria-hidden="true" className="pointer-events-none block h-0 w-0" />
                </DropdownMenuTrigger>
                {sessionMenuContent}
              </DropdownMenu>
            </div>
          </div>
        </DraggableSessionRow>
        {/*
          Children live INSIDE the SessionSidebarMotionRow so the entire
          subtree (parent row + descendants) collapses as a single animated
          unit on archive/unarchive. Keeping children outside caused the
          parent row to collapse while children stayed visible, then snapped
          out instantly at the end of the parent's exit — visibly janky for
          sessions with many sub-agent children. Each child still owns its
          own SessionSidebarMotionRow for per-child enter/exit (e.g. when
          a single child is archived or the parent is collapsed/expended).
        */}
        {hasChildren ? (
          <AnimatePresence initial={false}>
            {isExpanded
              ? node.children.map((child) => renderSessionNode(child, depth + 1, sessionDirectory ?? groupDirectory, projectId, archivedBucket, undefined, renderContext))
              : null}
          </AnimatePresence>
        ) : null}
      </SessionSidebarMotionRow>
      <Dialog open={exportDialogOpen} onOpenChange={setExportDialogOpen}>
        <DialogContent showCloseButton={false} className="max-w-sm gap-5">
          <DialogHeader>
            <DialogTitle>{t('sessions.sidebar.session.export.dialog.title')}</DialogTitle>
            <DialogDescription>
              {descendantCount === 1
                ? t('sessions.sidebar.session.export.dialog.descriptionSingle', { count: descendantCount })
                : t('sessions.sidebar.session.export.dialog.descriptionMany', { count: descendantCount })}
            </DialogDescription>
          </DialogHeader>
          <label className="flex items-center gap-2 typography-ui-label cursor-pointer">
            <input
              type="checkbox"
              checked={exportIncludeSubtasks}
              onChange={(e) => setExportIncludeSubtasks(e.target.checked)}
              className="h-4 w-4 rounded border-border accent-primary"
            />
            {t('sessions.sidebar.session.export.dialog.includeSubtasks')}
          </label>
          <DialogFooter>
            <Button
              type="button"
              onClick={() => setExportDialogOpen(false)}
              variant="outline"
              size="sm"
            >
              {t('sessions.sidebar.dialogs.cancel')}
            </Button>
            <Button
              type="button"
              onClick={() => {
                setExportDialogOpen(false);
                void doExportSession(exportIncludeSubtasks);
              }}
              size="sm"
            >
              {t('sessions.sidebar.session.export.dialog.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </React.Fragment>
  );
}

export const SessionNodeItem = React.memo(SessionNodeItemComponent, areEqual);
