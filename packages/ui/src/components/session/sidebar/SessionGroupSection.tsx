import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  RiAddLine,
  RiArchiveLine,
  RiArrowDownSLine,
  RiDeleteBinLine,
  RiGitBranchLine,
} from '@remixicon/react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { sessionEvents } from '@/lib/sessionEvents';
import type { MainTab } from '@/stores/useUIStore';
import { SessionFolderItem } from '../SessionFolderItem';
import { DroppableFolderWrapper, SessionFolderDndScope } from './sessionFolderDnd';
import { SessionSidebarMotionRow } from './SessionSidebarMotionRow';
import type { SortableDragHandleProps } from './sortableItems';
import type { GroupSearchData, SessionGroup, SessionNode } from './types';
import { collectArchivedActionSessions, compareArchivedSessionsByParentAssistantActivity, compareSessionsByPinnedAndTime, normalizePath, renderHighlightedText, resolveArchivedFolderDisplayNodes } from './utils';
import type { SessionAssistantActivity } from '@/sync/session-assistant-activity';
import type { SessionFolder } from '@/stores/useSessionFoldersStore';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { useI18n } from '@/lib/i18n';
import { resolveBranchGroupLabel } from './branchSessionCleanup';

type DeleteFolderConfirm = {
  scopeKey: string;
  folderId: string;
  folderName: string;
  subFolderCount: number;
  sessionCount: number;
} | null;

const emptyStateEase = [0.33, 1, 0.68, 1] as const;

const emptyStateTransition = {
  gridTemplateRows: {
    type: 'tween',
    duration: 0.17,
    ease: emptyStateEase,
  },
  opacity: {
    type: 'tween',
    duration: 0.12,
    ease: emptyStateEase,
  },
  y: {
    type: 'tween',
    duration: 0.17,
    ease: emptyStateEase,
  },
} as const;

type Props = {
  group: SessionGroup;
  groupKey: string;
  projectId?: string | null;
  hideGroupLabel?: boolean;
  hasSessionSearchQuery: boolean;
  normalizedSessionSearchQuery: string;
  groupSearchDataByGroup: WeakMap<SessionGroup, GroupSearchData>;
  expandedSessionGroups: Set<string>;
  collapsedGroups: Set<string>;
  hideDirectoryControls: boolean;
  collapsedFolderIds: Set<string>;
  toggleFolderCollapse: (folderId: string) => void;
  renameFolder: (scopeKey: string, folderId: string, name: string) => void;
  deleteFolder: (scopeKey: string, folderId: string) => void;
  showDeletionDialog: boolean;
  setDeleteFolderConfirm: React.Dispatch<React.SetStateAction<DeleteFolderConfirm>>;
  renderSessionNode: (node: SessionNode, depth?: number, groupDirectory?: string | null, projectId?: string | null, archivedBucket?: boolean, secondaryMeta?: { projectLabel?: string | null; branchLabel?: string | null } | null) => React.ReactNode;
  toggleGroupSessionLimit: (groupKey: string) => void;
  mobileVariant: boolean;
  alwaysShowActions: boolean;
  activeProjectId: string | null;
  setActiveProjectIdOnly: (id: string) => void;
  setActiveMainTab: (tab: MainTab) => void;
  setSessionSwitcherOpen: (open: boolean) => void;
  openNewSessionDraft: (options?: { directoryOverride?: string | null; targetFolderId?: string }) => void;
  addSessionToFolder: (scopeKey: string, folderId: string, sessionId: string) => void;
  createFolderAndStartRename: (scopeKey: string, parentId?: string | null) => { id: string } | null;
  renamingFolderId: string | null;
  renameFolderDraft: string;
  setRenameFolderDraft: React.Dispatch<React.SetStateAction<string>>;
  setRenamingFolderId: React.Dispatch<React.SetStateAction<string | null>>;
  pinnedSessionIds: Set<string>;
  sessionOrderIndex: Map<string, number>;
  archivedAssistantActivity: SessionAssistantActivity;
  onArchiveGroupSessions: (group: SessionGroup, sessions: Session[]) => void;
  onToggleCollapsedGroup: (groupKey: string) => void;
  dragHandleProps?: SortableDragHandleProps | null;
  compactBodyPadding?: boolean;
  draftItems?: React.ReactNode;
  draftCount?: number;
};

export function SessionGroupSection(props: Props): React.ReactNode {
  const { t } = useI18n();
  const shouldReduceMotion = useReducedMotion();
  const {
    group,
    groupKey,
    projectId,
    hideGroupLabel,
    hasSessionSearchQuery,
    normalizedSessionSearchQuery,
    groupSearchDataByGroup,
    expandedSessionGroups,
    collapsedGroups,
    collapsedFolderIds,
    toggleFolderCollapse,
    renameFolder,
    deleteFolder,
    showDeletionDialog,
    setDeleteFolderConfirm,
    renderSessionNode,
    toggleGroupSessionLimit,
    mobileVariant,
    alwaysShowActions,
    activeProjectId,
    setActiveProjectIdOnly,
    setActiveMainTab,
    setSessionSwitcherOpen,
    openNewSessionDraft,
    addSessionToFolder,
    createFolderAndStartRename,
    renamingFolderId,
    renameFolderDraft,
    setRenameFolderDraft,
    setRenamingFolderId,
    pinnedSessionIds,
    sessionOrderIndex,
    archivedAssistantActivity,
    onArchiveGroupSessions,
    onToggleCollapsedGroup,
    dragHandleProps,
    compactBodyPadding = false,
    draftItems,
    draftCount = 0,
  } = props;

  // Tracks whether a session row is currently animating out (collapsing via
  // SessionSidebarMotionRow's grid-track exit). While true, the empty-state
  // "No chats" block is suppressed so it doesn't slide upward to fill the
  // gap left by the exiting row — it should appear in place only after the
  // collapse finishes.
  const [isExitAnimating, setIsExitAnimating] = React.useState(false);
  const prevVisibleCountRef = React.useRef(0);

  const compareSessionNodes = React.useCallback((a: SessionNode, b: SessionNode) => {
    if (group.isArchivedBucket) {
      return compareArchivedSessionsByParentAssistantActivity(a.session, b.session, archivedAssistantActivity);
    }
    const aIndex = sessionOrderIndex.get(a.session.id);
    const bIndex = sessionOrderIndex.get(b.session.id);
    if (aIndex !== undefined || bIndex !== undefined) {
      if (aIndex === undefined) return 1;
      if (bIndex === undefined) return -1;
      if (aIndex !== bIndex) return aIndex - bIndex;
    }
    return compareSessionsByPinnedAndTime(a.session, b.session, pinnedSessionIds);
  }, [archivedAssistantActivity, group.isArchivedBucket, pinnedSessionIds, sessionOrderIndex]);

  const searchData = hasSessionSearchQuery ? groupSearchDataByGroup.get(group) : null;
  const foldersMap = useSessionFoldersStore((state) => state.foldersMap);
  const isExpanded = expandedSessionGroups.has(groupKey);
  const isCollapsed = hasSessionSearchQuery ? false : collapsedGroups.has(groupKey);
  const maxVisible = 10;
  const groupMatchesSearch = hasSessionSearchQuery ? searchData?.groupMatches === true : false;
  const shouldFilterGroupContents = hasSessionSearchQuery;
  const sourceGroupNodes = React.useMemo(
    () => [...(shouldFilterGroupContents ? (searchData?.filteredNodes ?? []) : group.sessions)]
      .sort(compareSessionNodes),
    [compareSessionNodes, group.sessions, searchData?.filteredNodes, shouldFilterGroupContents],
  );
  const folderScopeKey = group.folderScopeKey ?? normalizePath(group.directory ?? null);
  const scopeFolders = React.useMemo(
    () => folderScopeKey ? (foldersMap[folderScopeKey] ?? []) : [],
    [folderScopeKey, foldersMap]
  );

  const nodeBySessionId = React.useMemo(() => {
    const map = new Map<string, SessionNode>();
    const collectNodeLookup = (nodes: SessionNode[]) => {
      nodes.forEach((node) => {
        map.set(node.session.id, node);
        if (node.children.length > 0) {
          collectNodeLookup(node.children);
        }
      });
    };
    collectNodeLookup(sourceGroupNodes);
    return map;
  }, [sourceGroupNodes]);

  const allFoldersForGroupBase = React.useMemo(() => scopeFolders.map((folder) => {
    const nodes = group.isArchivedBucket
      ? resolveArchivedFolderDisplayNodes(sourceGroupNodes, folder.sessionIds).sort(compareSessionNodes)
      : folder.sessionIds
        .map((sid) => nodeBySessionId.get(sid))
        .filter((n): n is SessionNode => Boolean(n))
        .sort(compareSessionNodes);
    return { folder, nodes };
  }), [scopeFolders, group.isArchivedBucket, sourceGroupNodes, compareSessionNodes, nodeBySessionId]);

  const allFoldersForGroup = React.useMemo(() => {
    const folderMapById = new Map(allFoldersForGroupBase.map((entry) => [entry.folder.id, entry]));
    const childFolderIdsByParentId = new Map<string, string[]>();
    for (const { folder } of allFoldersForGroupBase) {
      if (!folder.parentId) continue;
      const existing = childFolderIdsByParentId.get(folder.parentId);
      if (existing) {
        existing.push(folder.id);
      } else {
        childFolderIdsByParentId.set(folder.parentId, [folder.id]);
      }
    }

    const keepByFolderId = new Map<string, boolean>();
    const shouldKeepFolder = (folderId: string): boolean => {
      const cached = keepByFolderId.get(folderId);
      if (cached !== undefined) return cached;

      const entry = folderMapById.get(folderId);
      if (!entry) {
        keepByFolderId.set(folderId, false);
        return false;
      }

      const childFolderIds = childFolderIdsByParentId.get(folderId) ?? [];

      // For archived buckets, hide folders with no sessions unless descendants have content.
      if (group.isArchivedBucket && entry.nodes.length === 0) {
        const hasContentInChildren = childFolderIds.some((childId) => shouldKeepFolder(childId));
        keepByFolderId.set(folderId, hasContentInChildren);
        return hasContentInChildren;
      }

      if (!hasSessionSearchQuery) {
        keepByFolderId.set(folderId, true);
        return true;
      }

      const folderMatches = entry.folder.name.toLowerCase().includes(normalizedSessionSearchQuery);
      if (folderMatches || entry.nodes.length > 0) {
        keepByFolderId.set(folderId, true);
        return true;
      }

      const hasMatchingChildren = childFolderIds.some((childId) => shouldKeepFolder(childId));
      keepByFolderId.set(folderId, hasMatchingChildren);
      return hasMatchingChildren;
    };

    return allFoldersForGroupBase.filter(({ folder }) => shouldKeepFolder(folder.id));
  }, [allFoldersForGroupBase, group.isArchivedBucket, hasSessionSearchQuery, normalizedSessionSearchQuery]);

  const sessionIdsInFolders = React.useMemo(() => {
    if (group.isArchivedBucket) {
      return new Set(allFoldersForGroup.flatMap((entry) => entry.nodes.map((node) => node.session.id)));
    }
    return new Set(allFoldersForGroup.flatMap((f) => f.folder.sessionIds));
  }, [allFoldersForGroup, group.isArchivedBucket]);
  const ungroupedSessions = React.useMemo(() => sourceGroupNodes.filter((node) => !sessionIdsInFolders.has(node.session.id)), [sourceGroupNodes, sessionIdsInFolders]);
  const rootFolders = React.useMemo(() => allFoldersForGroup.filter(({ folder }) => !folder.parentId), [allFoldersForGroup]);

  const totalSessions = ungroupedSessions.length;
  const visibleSessions = group.isArchivedBucket
    ? ungroupedSessions
    : hasSessionSearchQuery
      ? ungroupedSessions
      : (isExpanded ? ungroupedSessions : ungroupedSessions.slice(0, maxVisible));
  const remainingCount = totalSessions - visibleSessions.length;
  const isVisibleSessionCountDropping = visibleSessions.length < prevVisibleCountRef.current;
  const shouldDeferNoChats = !group.isArchivedBucket && isVisibleSessionCountDropping;

  // Detect when a session was removed from this group (count dropped) so we
  // can gate the empty-state render until the exit animation finishes. Only
  // count drops trigger the gate; additions and initial mount do not.
  React.useEffect(() => {
    const prev = prevVisibleCountRef.current;
    if (visibleSessions.length < prev) {
      setIsExitAnimating(true);
    }
    prevVisibleCountRef.current = visibleSessions.length;
  }, [visibleSessions.length]);

  if (hasSessionSearchQuery && !groupMatchesSearch && rootFolders.length === 0 && ungroupedSessions.length === 0 && draftCount === 0) {
    return null;
  }

  const collectGroupSessions = (nodes: SessionNode[]): Session[] => {
    if (group.isArchivedBucket) {
      return collectArchivedActionSessions(nodes);
    }

    const collected: Session[] = [];
    const visit = (list: SessionNode[]) => {
      list.forEach((node) => {
        collected.push(node.session);
        if (node.children.length > 0) visit(node.children);
      });
    };
    visit(nodes);
    return collected;
  };

  const allGroupSessions = collectGroupSessions(sourceGroupNodes);

  const renderOneFolderItem = (folder: SessionFolder, nodes: SessionNode[], depth: number): React.ReactNode => {
    const directSubFolders = allFoldersForGroup.filter(({ folder: f }) => f.parentId === folder.id);
    const subFolderItems = directSubFolders.length > 0
      ? <>{directSubFolders.map(({ folder: sf, nodes: sn }) => renderOneFolderItem(sf, sn, depth + 1))}</>
      : undefined;
    const collectFolderSessions = (targetFolderId: string): Session[] => {
      const directNodes = allFoldersForGroup.find(({ folder: candidate }) => candidate.id === targetFolderId)?.nodes ?? [];
      const childFolders = allFoldersForGroup.filter(({ folder: candidate }) => candidate.parentId === targetFolderId);
      return [
        ...collectGroupSessions(directNodes),
        ...childFolders.flatMap(({ folder: child }) => collectFolderSessions(child.id)),
      ];
    };
    const folderSessionsForDelete = group.isArchivedBucket ? collectFolderSessions(folder.id) : [];

    return (
      <DroppableFolderWrapper key={folder.id} folderId={folder.id}>
        {(droppableRef, isDropTarget) => (
          <SessionFolderItem
            folder={folder}
            sessions={nodes}
            subFolderItems={subFolderItems}
            isCollapsed={hasSessionSearchQuery ? false : collapsedFolderIds.has(folder.id)}
            onToggle={() => toggleFolderCollapse(folder.id)}
            onRename={(name) => {
              if (folderScopeKey) renameFolder(folderScopeKey, folder.id, name);
            }}
            onDelete={() => {
              if (group.isArchivedBucket) {
                // Delete sessions in the folder
                // Empty folders are auto-hidden by useArchivedAutoFolders
                sessionEvents.requestDelete({
                  sessions: folderSessionsForDelete,
                  mode: 'session',
                  suppressSuccessToast: true,
                });
                return;
              }
              if (!folderScopeKey) return;
              if (!showDeletionDialog) {
                deleteFolder(folderScopeKey, folder.id);
                return;
              }
              const subFolderCount = allFoldersForGroup.filter(({ folder: f }) => f.parentId === folder.id).length;
              const sessionCount = nodes.length;
              setDeleteFolderConfirm({
                scopeKey: folderScopeKey,
                folderId: folder.id,
                folderName: folder.name,
                subFolderCount,
                sessionCount,
              });
            }}
            renderSessionNode={renderSessionNode}
            groupDirectory={group.directory}
            projectId={projectId}
            mobileVariant={mobileVariant}
            alwaysShowActions={alwaysShowActions}
            isRenaming={renamingFolderId === folder.id}
            renameDraft={renamingFolderId === folder.id ? renameFolderDraft : undefined}
            onRenameDraftChange={(value) => setRenameFolderDraft(value)}
            onRenameSave={() => {
              const trimmed = renameFolderDraft.trim();
              if (trimmed && folderScopeKey) {
                renameFolder(folderScopeKey, folder.id, trimmed);
              }
              setRenamingFolderId(null);
              setRenameFolderDraft('');
            }}
            onRenameCancel={() => {
              setRenamingFolderId(null);
              setRenameFolderDraft('');
            }}
            droppableRef={droppableRef}
            isDropTarget={isDropTarget}
            depth={depth}
            onNewSession={() => {
              if (projectId && projectId !== activeProjectId) setActiveProjectIdOnly(projectId);
              setActiveMainTab('chat');
              if (mobileVariant) setSessionSwitcherOpen(false);
              openNewSessionDraft({ directoryOverride: group.directory, targetFolderId: folder.id });
            }}
            onNewSubFolder={depth === 0 ? () => {
              if (!folderScopeKey) return;
              createFolderAndStartRename(folderScopeKey, folder.id);
            } : undefined}
            hideActions={false}
            archivedBucket={group.isArchivedBucket === true}
          />
        )}
      </DroppableFolderWrapper>
    );
  };

  const renderFolderItems = () => rootFolders.map(({ folder, nodes }) => renderOneFolderItem(folder, nodes, 0));
  const hasWorktreeArchiveAction = Boolean(!group.isMain && group.worktree && allGroupSessions.length > 0);
  const groupHeaderRightPadding = alwaysShowActions
    ? (hasWorktreeArchiveAction ? 'pr-14' : 'pr-7')
    : (hasWorktreeArchiveAction
        ? 'pr-2 group-hover/gh:pr-14 group-focus-within/gh:pr-14'
        : 'pr-2');
  const emptyStateContent = (
    <div className="py-1 text-left typography-micro text-muted-foreground">
      {group.isArchivedBucket
        ? t('sessions.sidebar.group.empty.noArchivedSessions')
        : t('sessions.sidebar.group.empty.noSessionsInWorkspace')}
    </div>
  );
  const emptyState = shouldReduceMotion ? emptyStateContent : (
    <motion.div
      key="group-empty-state"
      initial={group.isArchivedBucket ? { gridTemplateRows: '0fr', opacity: 0, y: -2 } : false}
      animate={{ gridTemplateRows: '1fr', opacity: 1, y: 0 }}
      exit={{ gridTemplateRows: '0fr', opacity: 0, y: -2 }}
      transition={emptyStateTransition}
      style={{ display: 'grid', overflow: 'hidden' }}
    >
      <div style={{ minHeight: 0 }}>{emptyStateContent}</div>
    </motion.div>
  );

  const body = (
    <SessionFolderDndScope
      scopeKey={folderScopeKey}
      hasFolders={allFoldersForGroup.length > 0}
      onSessionDroppedOnFolder={(sessionId, folderId) => {
        if (folderScopeKey) addSessionToFolder(folderScopeKey, folderId, sessionId);
      }}
    >
      {draftItems}
      {group.isArchivedBucket ? null : renderFolderItems()}
      <AnimatePresence initial={false} onExitComplete={() => setIsExitAnimating(false)}>
        {visibleSessions.map((node) => (
          <React.Fragment key={node.session.id}>
            {renderSessionNode(node, 0, group.directory, projectId, group.isArchivedBucket === true)}
          </React.Fragment>
        ))}
      </AnimatePresence>
      {group.isArchivedBucket ? renderFolderItems() : null}
      <AnimatePresence initial={false}>
        {totalSessions === 0 && allFoldersForGroup.length === 0 && draftCount === 0 && !isExitAnimating && !shouldDeferNoChats ? (
          <React.Fragment key="group-empty-state-presence">
            {emptyState}
          </React.Fragment>
        ) : null}
      </AnimatePresence>
      {remainingCount > 0 && !isExpanded ? (
        <button
          type="button"
          onClick={() => toggleGroupSessionLimit(groupKey)}
          className="mt-0.5 flex items-center justify-start rounded-md px-1.5 py-0.5 text-left text-xs text-muted-foreground/70 leading-tight hover:text-foreground hover:underline"
        >
          {remainingCount === 1
            ? t('sessions.sidebar.group.showMoreSingle', { count: remainingCount })
            : t('sessions.sidebar.group.showMorePlural', { count: remainingCount })}
        </button>
      ) : null}
      {isExpanded && totalSessions > maxVisible ? (
        <button
          type="button"
          onClick={() => toggleGroupSessionLimit(groupKey)}
          className="mt-0.5 flex items-center justify-start rounded-md px-1.5 py-0.5 text-left text-xs text-muted-foreground/70 leading-tight hover:text-foreground hover:underline"
        >
          {t('sessions.sidebar.group.showFewer')}
        </button>
      ) : null}
    </SessionFolderDndScope>
  );

  const groupBodyPaddingClass = compactBodyPadding ? 'pb-2 pl-1' : 'pb-3 pl-3.5';
  const groupBody = <div className={cn('oc-group-body', groupBodyPaddingClass)}>{body}</div>;

  if (hideGroupLabel) {
    return <div className="oc-group"><div className={cn('oc-group-body', groupBodyPaddingClass)}>{body}</div></div>;
  }

  return (
    <div className="oc-group">
      <div
        className={cn('group/gh relative flex items-start justify-between gap-1 py-1 min-w-0 rounded-md', 'cursor-pointer')}
        onClick={() => onToggleCollapsedGroup(groupKey)}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onToggleCollapsedGroup(groupKey);
          }
        }}
        aria-label={isCollapsed
          ? t('sessions.sidebar.group.expandAria', { label: group.label })
          : t('sessions.sidebar.group.collapseAria', { label: group.label })}
        aria-expanded={!isCollapsed}
      >
        <div
          ref={dragHandleProps?.setActivatorNodeRef}
          className={cn(
            'min-w-0 flex flex-1 items-start gap-1 overflow-hidden pl-0.5 transition-[padding]',
            // Only sortable group headers should advertise drag affordance; non-draggable buckets inherit the click cursor.
            dragHandleProps && !group.isArchivedBucket && 'cursor-grab active:cursor-grabbing',
            groupHeaderRightPadding,
          )}
          {...(dragHandleProps?.listeners ?? {})}
        >
          <div className="min-w-0 flex flex-1 flex-col justify-center gap-0.5 overflow-hidden">
            <p className="text-[length:calc(var(--text-ui-label)*1.08)] font-normal truncate text-foreground/92">
              {group.isArchivedBucket ? (
                <span className="inline-flex min-w-0 max-w-full items-center gap-1">
                  <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                    <RiArchiveLine className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground', alwaysShowActions ? 'hidden' : 'group-hover/gh:hidden')} />
                    <span className={cn(
                      'text-muted-foreground h-3.5 w-3.5 items-center justify-center',
                      alwaysShowActions ? 'inline-flex' : 'hidden group-hover/gh:inline-flex',
                    )}>
                      <RiArrowDownSLine className={cn('h-3.5 w-3.5 transition-transform duration-150 ease-[cubic-bezier(0.33,1,0.68,1)]', isCollapsed ? '-rotate-90' : 'rotate-0')} />
                    </span>
                  </span>
                  <span className="min-w-0 flex-1 truncate">{renderHighlightedText(group.label, normalizedSessionSearchQuery)}</span>
                </span>
              ) : (!group.isMain || group.worktree) ? (
                <span className="inline-flex min-w-0 max-w-full items-center gap-1">
                  <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                    <RiGitBranchLine
                      className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground', alwaysShowActions ? 'hidden' : 'group-hover/gh:hidden')}
                    />
                    <span className={cn(
                      'text-muted-foreground h-3.5 w-3.5 items-center justify-center',
                      alwaysShowActions ? 'inline-flex' : 'hidden group-hover/gh:inline-flex',
                    )}>
                      <RiArrowDownSLine className={cn('h-3.5 w-3.5 transition-transform duration-150 ease-[cubic-bezier(0.33,1,0.68,1)]', isCollapsed ? '-rotate-90' : 'rotate-0')} />
                    </span>
                  </span>
                  <span className="min-w-0 flex-1 truncate">{renderHighlightedText(resolveBranchGroupLabel(group), normalizedSessionSearchQuery)}</span>
                </span>
              ) : (
                renderHighlightedText(group.label, normalizedSessionSearchQuery)
              )}
            </p>
          </div>
        </div>
        {group.isArchivedBucket && allGroupSessions.length > 0 ? (
          <div className={cn('absolute right-0.5 top-1/2 -translate-y-1/2 z-10 transition-opacity', alwaysShowActions ? 'opacity-100' : 'opacity-0 group-hover/gh:opacity-100 group-focus-within/gh:opacity-100')}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onPointerDown={(event) => event.stopPropagation()}
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    sessionEvents.requestDelete({
                      sessions: allGroupSessions,
                      mode: 'session',
                      suppressSuccessToast: true,
                    });
                  }}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-destructive hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                  aria-label={t('sessions.sidebar.group.actions.deleteArchivedInGroupAria', { label: group.label })}
                >
                  <RiDeleteBinLine className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}><p>{t('sessions.sidebar.group.actions.deleteArchivedSessions')}</p></TooltipContent>
            </Tooltip>
          </div>
        ) : null}
        {group.directory && !group.isMain && group.worktree && allGroupSessions.length > 0 ? (
          <div className={cn('absolute right-7 top-1/2 -translate-y-1/2 z-10 transition-opacity', alwaysShowActions ? 'opacity-100' : 'opacity-0 group-hover/gh:opacity-100 group-focus-within/gh:opacity-100')}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onPointerDown={(event) => event.stopPropagation()}
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onArchiveGroupSessions(group, allGroupSessions);
                  }}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                  aria-label={t('sessions.sidebar.group.actions.archiveSessionsAria', { label: resolveBranchGroupLabel(group) })}
                >
                  <RiArchiveLine className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}><p>{t('sessions.sidebar.group.actions.archiveSessions')}</p></TooltipContent>
            </Tooltip>
          </div>
        ) : null}
        {group.directory ? (
          <div className={cn('absolute right-0.5 top-1/2 -translate-y-1/2 z-10 transition-opacity', alwaysShowActions ? 'opacity-100' : 'opacity-0 group-hover/gh:opacity-100 group-focus-within/gh:opacity-100')}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    if (projectId && projectId !== activeProjectId) setActiveProjectIdOnly(projectId);
                    setActiveMainTab('chat');
                    if (mobileVariant) setSessionSwitcherOpen(false);
                    openNewSessionDraft({ directoryOverride: group.directory });
                  }}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                  aria-label={t('sessions.sidebar.group.actions.newDraftInGroupAria', { label: group.label })}
                 >
                   <RiAddLine className="h-4 w-4" />
                 </button>
               </TooltipTrigger>
               <TooltipContent side="bottom" sideOffset={4}><p>{t('sessions.sidebar.project.actions.newDraftSession')}</p></TooltipContent>
             </Tooltip>
           </div>
         ) : null}
      </div>
      {group.isArchivedBucket ? (
        <AnimatePresence initial={false}>
          {!isCollapsed ? (
            <SessionSidebarMotionRow
              key={`archived-group-body:${groupKey}`}
            >
              {groupBody}
            </SessionSidebarMotionRow>
          ) : null}
        </AnimatePresence>
      ) : (!isCollapsed ? groupBody : null)}
    </div>
  );
}
