import React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import { useSessions, useAllSessionStatuses } from '@/sync/sync-context';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import type { Session } from '@opencode-ai/sdk/v2';
import { cn, formatDirectoryName } from '@/lib/utils';
import { resolveDisplaySessionTitle } from '@/lib/sessionTitles';
import { filterUserVisibleSessions } from '@/lib/sessionVisibility';
import { getAgentColor } from '@/lib/agentColors';
import { RiAddLine, RiFolderLine, RiLoader4Line } from '@remixicon/react';
import { PROJECT_COLOR_MAP, PROJECT_ICON_MAP, getProjectIconImageUrl } from '@/lib/projectMeta';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useDrawerSwipe } from '@/hooks/useDrawerSwipe';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useNotificationStore } from '@/sync/notification-store';
import { useI18n } from '@/lib/i18n';

interface MobileSessionStatusBarProps {
  onSessionSwitch?: (sessionId: string) => void;
}

interface SessionWithStatus extends Session {
  _statusType?: 'busy' | 'retry' | 'idle';
  _hasRunningChildren?: boolean;
  _runningChildrenCount?: number;
  _childIndicators?: Array<{ session: Session; isRunning: boolean }>;
}

const normalize = (value: string): string => {
  if (!value) return '';
  const replaced = value.replace(/\\/g, '/');
  return replaced === '/' ? '/' : replaced.replace(/\/+$/, '');
};

const truncateLabel = (value: string, maxChars: number): string => {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  if (maxChars <= 3) {
    return '.'.repeat(Math.max(0, maxChars));
  }
  return `${trimmed.slice(0, maxChars - 3).trimEnd()}...`;
};

function useSessionGrouping(
  sessions: Session[],
  sessionStatus: Record<string, { type: string }> | undefined,
) {
  const unseenCounts = useNotificationStore((s) => s.index.session.unseenCount);

  const parentChildMap = React.useMemo(() => {
    const map = new Map<string, Session[]>();
    const allIds = new Set(sessions.map((s) => s.id));

    sessions.forEach((session) => {
      const parentID = (session as { parentID?: string }).parentID;
      if (parentID && allIds.has(parentID)) {
        map.set(parentID, [...(map.get(parentID) || []), session]);
      }
    });
    return map;
  }, [sessions]);

  const getStatusType = React.useCallback((sessionId: string): 'busy' | 'retry' | 'idle' => {
    const status = sessionStatus?.[sessionId];
    if (status?.type === 'busy' || status?.type === 'retry') return status.type;
    return 'idle';
  }, [sessionStatus]);

  const hasRunningChildren = React.useCallback((sessionId: string): boolean => {
    const children = parentChildMap.get(sessionId) || [];
    return children.some((child) => getStatusType(child.id) !== 'idle');
  }, [parentChildMap, getStatusType]);

  const getRunningChildrenCount = React.useCallback((sessionId: string): number => {
    const children = parentChildMap.get(sessionId) || [];
    return children.filter((child) => getStatusType(child.id) !== 'idle').length;
  }, [parentChildMap, getStatusType]);

  const getChildIndicators = React.useCallback((sessionId: string): Array<{ session: Session; isRunning: boolean }> => {
    const children = parentChildMap.get(sessionId) || [];
    return children
      .filter((child) => getStatusType(child.id) !== 'idle')
      .map((child) => ({ session: child, isRunning: true }))
      .slice(0, 3);
  }, [parentChildMap, getStatusType]);

  const processedSessions = React.useMemo(() => {
    const sessionIds = new Set(sessions.map((s) => s.id));
    const topLevel = sessions.filter((session) => {
      const parentID = (session as { parentID?: string }).parentID;
      return !parentID || !sessionIds.has(parentID);
    });

    const running: SessionWithStatus[] = [];
    const viewed: SessionWithStatus[] = [];

    topLevel.forEach((session) => {
      const statusType = getStatusType(session.id);
      const hasRunning = hasRunningChildren(session.id);
      const attention = (unseenCounts[session.id] ?? 0) > 0;

      const enriched: SessionWithStatus = {
        ...session,
        _statusType: statusType,
        _hasRunningChildren: hasRunning,
        _runningChildrenCount: getRunningChildrenCount(session.id),
        _childIndicators: getChildIndicators(session.id),
      };

      if (statusType !== 'idle' || hasRunning || attention) {
        running.push(enriched);
      } else {
        viewed.push(enriched);
      }
    });

    const sortByUpdated = (a: Session, b: Session) => {
      const aTime = (a as unknown as { time?: { updated?: number } }).time?.updated ?? 0;
      const bTime = (b as unknown as { time?: { updated?: number } }).time?.updated ?? 0;
      return bTime - aTime;
    };

    running.sort(sortByUpdated);
    viewed.sort(sortByUpdated);

    return [...running, ...viewed];
  }, [sessions, getStatusType, hasRunningChildren, getRunningChildrenCount, getChildIndicators, unseenCounts]);

  return { sessions: processedSessions, totalCount: processedSessions.length };
}

function useSessionHelpers(
  agents: Array<{ name: string }>,
  sessionStatus: Record<string, { type: string }> | undefined,
) {
  const getSessionAgentName = React.useCallback((session: Session): string => {
    const agent = (session as { agent?: string }).agent;
    if (agent) return agent;

    const sessionAgentSelection = useSelectionStore.getState().getSessionAgentSelection(session.id);
    if (sessionAgentSelection) return sessionAgentSelection;

    return agents[0]?.name ?? 'agent';
  }, [agents]);

  const getSessionTitle = React.useCallback((session: Session): string => {
    return resolveDisplaySessionTitle({
      title: session.title,
      fallback: 'New session',
    });
  }, []);

  const unseenCounts = useNotificationStore((s) => s.index.session.unseenCount);
  const needsAttention = React.useCallback((sessionId: string): boolean => {
    return (unseenCounts[sessionId] ?? 0) > 0;
  }, [unseenCounts]);

  const isRunning = React.useCallback((sessionId: string): boolean => {
    const status = sessionStatus?.[sessionId];
    return status?.type === 'busy' || status?.type === 'retry';
  }, [sessionStatus]);

  return { getSessionAgentName, getSessionTitle, isRunning, needsAttention };
}

function StatusIndicator({ isRunning, needsAttention }: { isRunning: boolean; needsAttention: boolean }) {
  if (isRunning) {
    return <RiLoader4Line className="h-2.5 w-2.5 animate-spin text-[var(--status-info)]" />;
  }
  if (needsAttention) {
    return <div className="h-1.5 w-1.5 rounded-full bg-[var(--status-error)]" />;
  }
  return <div className="h-1.5 w-1.5 rounded-full border border-[var(--surface-mutedForeground)]" />;
}

function SessionItem({
  session,
  isCurrent,
  getSessionAgentName,
  getSessionTitle,
  onClick,
  onDoubleClick,
  needsAttention,
}: {
  session: SessionWithStatus;
  isCurrent: boolean;
  getSessionAgentName: (s: Session) => string;
  getSessionTitle: (s: Session) => string;
  onClick: () => void;
  onDoubleClick?: () => void;
  needsAttention: (sessionId: string) => boolean;
}) {
  const agentName = getSessionAgentName(session);
  const agentColor = getAgentColor(agentName);
  const extraCount =
    (session._runningChildrenCount || 0)
    + (session._statusType !== 'idle' ? 1 : 0)
    - 1
    - (session._childIndicators?.length || 0);

  return (
    <button
      type="button"
      onClick={onClick}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onDoubleClick?.();
      }}
      className={cn(
        'flex items-center gap-0.5 px-1.5 py-px text-left transition-colors',
        'hover:bg-[var(--interactive-hover)] active:bg-[var(--interactive-selection)]',
        isCurrent && 'bg-[var(--interactive-selection)]/30',
      )}
    >
      <div className="flex-shrink-0 w-3 flex items-center justify-center">
        <StatusIndicator
          isRunning={session._statusType !== 'idle'}
          needsAttention={needsAttention(session.id)}
        />
      </div>

      <div
        className="flex-shrink-0 h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: `var(${agentColor.var})` }}
      />

      <span className={cn(
        'text-[13px] truncate leading-tight',
        isCurrent ? 'text-[var(--interactive-selection-foreground)] font-medium' : 'text-[var(--surface-foreground)]',
      )}>
        {getSessionTitle(session)}
      </span>

      {(session._childIndicators?.length || 0) > 0 && (
        <div className="flex items-center gap-0.5 text-[var(--surface-mutedForeground)]">
          <span className="text-[10px]">[</span>
          <div className="flex items-center gap-0.5">
            {session._childIndicators!.map(({ session: child }) => {
              const childColor = getAgentColor(getSessionAgentName(child));
              return (
                <div
                  key={child.id}
                  className="flex-shrink-0"
                  title={`Sub-session: ${getSessionTitle(child)}`}
                >
                  <RiLoader4Line
                    className="h-2.5 w-2.5 animate-spin"
                    style={{ color: `var(${childColor.var})` }}
                  />
                </div>
              );
            })}
            {extraCount > 0 && (
              <span className="text-[10px] text-[var(--surface-mutedForeground)]">
                +{extraCount}
              </span>
            )}
          </div>
          <span className="text-[10px]">]</span>
        </div>
      )}
    </button>
  );
}

function ProjectIconBadge({
  icon,
  iconImageUrl,
  iconBackground,
  color,
}: {
  icon?: string | null;
  iconImageUrl?: string | null;
  iconBackground?: string | null;
  color?: string | null;
}) {
  const [imageFailed, setImageFailed] = React.useState(false);
  const ProjectIcon = icon ? PROJECT_ICON_MAP[icon] : null;
  const imageUrl = !imageFailed ? iconImageUrl : null;
  const projectColor = color ? (PROJECT_COLOR_MAP[color] ?? null) : null;

  React.useEffect(() => {
    setImageFailed(false);
  }, [iconImageUrl]);

  return (
    <span className="inline-flex h-4 w-4 flex-shrink-0 items-center justify-center">
      {imageUrl ? (
        <span
          className="inline-flex h-4 w-4 items-center justify-center overflow-hidden rounded-[2px]"
          style={iconBackground ? { backgroundColor: iconBackground } : undefined}
        >
          <img
            src={imageUrl}
            alt=""
            className="h-full w-full object-contain"
            draggable={false}
            onError={() => setImageFailed(true)}
          />
        </span>
      ) : ProjectIcon ? (
        <ProjectIcon
          className="h-4 w-4"
          style={projectColor ? { color: projectColor } : undefined}
        />
      ) : (
        <RiFolderLine
          className="h-4 w-4 text-[var(--surface-mutedForeground)]"
          style={projectColor ? { color: projectColor } : undefined}
        />
      )}
    </span>
  );
}

function MobileStatusShell({ children }: { children: React.ReactNode }) {
  const { handleTouchStart, handleTouchMove, handleTouchEnd } = useDrawerSwipe();

  return (
    <div
      className="w-full border-b border-[var(--interactive-border)] bg-[var(--surface-muted)] order-first overflow-hidden"
      style={{
        borderTopLeftRadius: 'var(--radius-lg)',
        borderTopRightRadius: 'var(--radius-lg)',
      }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {children}
    </div>
  );
}

function SwipeHintRow({ onToggle }: { onToggle: () => void }) {
  const { t } = useI18n();

  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex h-8 w-full items-center justify-center px-3 text-center text-[12px] font-medium text-[var(--surface-mutedForeground)] transition-colors hover:bg-[var(--interactive-hover)]"
    >
      {t('chat.mobileStatus.swipeHint')}
    </button>
  );
}

function ProjectChatSummaryRow({
  projectName,
  chatName,
  projectIcon,
  projectIconImageUrl,
  projectIconBackground,
  projectColor,
  onNewSession,
}: {
  projectName: string;
  chatName: string;
  projectIcon?: string | null;
  projectIconImageUrl?: string | null;
  projectIconBackground?: string | null;
  projectColor?: string | null;
  onNewSession: () => void;
}) {
  const { t } = useI18n();
  const projectLabel = truncateLabel(projectName, 18);
  const chatLabel = truncateLabel(chatName, 28);
  const newSessionLabel = t('sessions.sidebar.project.actions.newDraftSession');

  return (
    <div className="flex min-h-8 items-center gap-2 border-t border-[var(--interactive-border)] px-2 py-1">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <ProjectIconBadge
          icon={projectIcon}
          iconImageUrl={projectIconImageUrl}
          iconBackground={projectIconBackground}
          color={projectColor}
        />
        <span
          title={projectName}
          className="max-w-[42%] truncate text-[12px] font-medium leading-none text-[var(--surface-foreground)]"
        >
          {projectLabel}
        </span>
        <span
          title={chatName}
          className="min-w-0 flex-1 truncate text-[12px] leading-none text-[var(--surface-mutedForeground)]"
        >
          {chatLabel}
        </span>
      </div>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onNewSession();
        }}
        className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md border border-[var(--primary-base)]/50 bg-[var(--primary-base)]/5 text-[var(--primary-base)]/80 transition-colors hover:bg-[var(--primary-base)]/10 hover:text-[var(--primary-base)]"
        aria-label={newSessionLabel}
        title={newSessionLabel}
      >
        <RiAddLine className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function CollapsedView({
  projectName,
  chatName,
  projectIcon,
  projectIconImageUrl,
  projectIconBackground,
  projectColor,
  onToggle,
  onNewSession,
}: {
  projectName: string;
  chatName: string;
  projectIcon?: string | null;
  projectIconImageUrl?: string | null;
  projectIconBackground?: string | null;
  projectColor?: string | null;
  onToggle: () => void;
  onNewSession: () => void;
}) {
  return (
    <MobileStatusShell>
      <SwipeHintRow onToggle={onToggle} />
      <ProjectChatSummaryRow
        projectName={projectName}
        chatName={chatName}
        projectIcon={projectIcon}
        projectIconImageUrl={projectIconImageUrl}
        projectIconBackground={projectIconBackground}
        projectColor={projectColor}
        onNewSession={onNewSession}
      />
    </MobileStatusShell>
  );
}

function ExpandedView({
  sessions,
  currentSessionId,
  activeProjectPath,
  projectName,
  chatName,
  projectIcon,
  projectIconImageUrl,
  projectIconBackground,
  projectColor,
  onToggleCollapse,
  onNewSession,
  onSessionClick,
  onSessionDoubleClick,
  getSessionAgentName,
  getSessionTitle,
  needsAttention,
}: {
  sessions: SessionWithStatus[];
  currentSessionId: string;
  activeProjectPath: string | null;
  projectName: string;
  chatName: string;
  projectIcon?: string | null;
  projectIconImageUrl?: string | null;
  projectIconBackground?: string | null;
  projectColor?: string | null;
  onToggleCollapse: () => void;
  onNewSession: () => void;
  onSessionClick: (id: string) => void;
  onSessionDoubleClick?: () => void;
  getSessionAgentName: (s: Session) => string;
  getSessionTitle: (s: Session) => string;
  needsAttention: (sessionId: string) => boolean;
}) {
  const { t } = useI18n();
  const availableWorktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);

  const filteredSessions = React.useMemo(() => {
    const projectRoot = normalize(activeProjectPath ?? '');
    if (!projectRoot) {
      return sessions;
    }

    const projectDirs = new Set<string>([projectRoot]);
    const worktrees = availableWorktreesByProject.get(projectRoot) ?? [];
    for (const meta of worktrees) {
      const path = (meta && typeof meta === 'object' && 'path' in meta)
        ? (meta as { path?: unknown }).path
        : null;
      if (typeof path === 'string' && path.trim()) {
        const normalized = normalize(path);
        if (normalized) projectDirs.add(normalized);
      }
    }

    return sessions.filter((session) => {
      const sessionDir = normalize((session as { directory?: string | null }).directory ?? '');
      return projectDirs.has(sessionDir);
    });
  }, [sessions, activeProjectPath, availableWorktreesByProject]);

  const displaySessions = filteredSessions.filter((session) => session.id !== currentSessionId);

  return (
    <MobileStatusShell>
      <SwipeHintRow onToggle={onToggleCollapse} />
      <ProjectChatSummaryRow
        projectName={projectName}
        chatName={chatName}
        projectIcon={projectIcon}
        projectIconImageUrl={projectIconImageUrl}
        projectIconBackground={projectIconBackground}
        projectColor={projectColor}
        onNewSession={onNewSession}
      />

      <div className="flex max-h-[60vh] flex-col overflow-y-auto border-t border-[var(--interactive-border)]">
        {displaySessions.length === 0 ? (
          <div className="flex items-center justify-center py-3 text-[11px] text-[var(--surface-mutedForeground)]">
            <span>{t('chat.mobileStatus.noSessionsInProject')}</span>
          </div>
        ) : (
          displaySessions.map((session) => (
            <SessionItem
              key={session.id}
              session={session}
              isCurrent={session.id === currentSessionId}
              getSessionAgentName={getSessionAgentName}
              getSessionTitle={getSessionTitle}
              onClick={() => onSessionClick(session.id)}
              onDoubleClick={onSessionDoubleClick}
              needsAttention={needsAttention}
            />
          ))
        )}
      </div>
    </MobileStatusShell>
  );
}

export const MobileSessionStatusBar: React.FC<MobileSessionStatusBarProps> = ({
  onSessionSwitch,
}) => {
  const { currentTheme } = useThemeSystem();
  const allSessions = useSessions();
  const sessions = React.useMemo(
    () => filterUserVisibleSessions(allSessions),
    [allSessions],
  );
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const newSessionDraftOpen = useSessionUIStore((state) => Boolean(state.currentDraftId && state.newSessionDraft?.open));
  const sessionStatus = useAllSessionStatuses();
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const openNewSessionDraft = useSessionUIStore((state) => state.openNewSessionDraft);
  const agents = useConfigStore((state) => state.agents);
  const isMobile = useUIStore((state) => state.isMobile);
  const showMobileSessionStatusBar = useUIStore((state) => state.showMobileSessionStatusBar);
  const isMobileSessionStatusBarCollapsed = useUIStore((state) => state.isMobileSessionStatusBarCollapsed);
  const setIsMobileSessionStatusBarCollapsed = useUIStore((state) => state.setIsMobileSessionStatusBarCollapsed);
  const setActiveMainTab = useUIStore((state) => state.setActiveMainTab);
  const activeProject = useProjectsStore((state) => state.getActiveProject());
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);

  const { sessions: sortedSessions, totalCount } = useSessionGrouping(sessions, sessionStatus);
  const { getSessionAgentName, getSessionTitle, needsAttention } = useSessionHelpers(agents, sessionStatus);
  const currentSession = sessions.find((session) => session.id === currentSessionId);
  const currentSessionDirectory = (currentSession as { directory?: string | null } | undefined)?.directory ?? null;
  const currentSessionTitle = currentSession
    ? getSessionTitle(currentSession)
    : resolveDisplaySessionTitle({ title: undefined, fallback: 'New session' });

  const projectName = activeProject
    ? activeProject.label?.trim() || formatDirectoryName(activeProject.path, homeDirectory) || activeProject.path
    : formatDirectoryName(currentSessionDirectory ?? '', homeDirectory) || 'Project';
  const projectIcon = activeProject?.icon;
  const projectIconImageUrl = activeProject
    ? getProjectIconImageUrl(activeProject, {
      themeVariant: currentTheme.metadata.variant,
      iconColor: currentTheme.colors.surface.foreground,
    })
    : null;
  const projectIconBackground = activeProject?.iconBackground ?? null;
  const projectColor = activeProject?.color ?? null;

  if (
    !isMobile
    || !showMobileSessionStatusBar
    || (newSessionDraftOpen && !currentSessionId)
    || (!currentSessionId && totalCount === 0)
  ) {
    return null;
  }

  const handleSessionClick = (sessionId: string) => {
    setCurrentSession(sessionId);
    onSessionSwitch?.(sessionId);
    setIsMobileSessionStatusBarCollapsed(true);
  };

  const handleSessionDoubleClick = () => {
    setActiveMainTab('chat');
  };

  const handleCreateSession = () => {
    if (activeProject?.path) {
      openNewSessionDraft({ directoryOverride: activeProject.path });
      return;
    }
    openNewSessionDraft();
  };

  if (isMobileSessionStatusBarCollapsed) {
    return (
      <CollapsedView
        projectName={projectName}
        chatName={currentSessionTitle}
        projectIcon={projectIcon}
        projectIconImageUrl={projectIconImageUrl}
        projectIconBackground={projectIconBackground}
        projectColor={projectColor}
        onToggle={() => setIsMobileSessionStatusBarCollapsed(false)}
        onNewSession={handleCreateSession}
      />
    );
  }

  return (
    <ExpandedView
      sessions={sortedSessions}
      currentSessionId={currentSessionId ?? ''}
      activeProjectPath={activeProject?.path ?? null}
      projectName={projectName}
      chatName={currentSessionTitle}
      projectIcon={projectIcon}
      projectIconImageUrl={projectIconImageUrl}
      projectIconBackground={projectIconBackground}
      projectColor={projectColor}
      onToggleCollapse={() => setIsMobileSessionStatusBarCollapsed(true)}
      onNewSession={handleCreateSession}
      onSessionClick={handleSessionClick}
      onSessionDoubleClick={handleSessionDoubleClick}
      getSessionAgentName={getSessionAgentName}
      getSessionTitle={getSessionTitle}
      needsAttention={needsAttention}
    />
  );
};
