import React from 'react';
import { RiRefreshLine } from '@remixicon/react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Switch } from '@/components/ui/switch';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { cn, formatDirectoryName } from '@/lib/utils';
import { useDeviceInfo } from '@/lib/device';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useMcpConfigStore } from '@/stores/useMcpConfigStore';
import { computeMcpHealth, useMcpStore } from '@/stores/useMcpStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { McpIcon } from '@/components/icons/McpIcon';
import { useI18n } from '@/lib/i18n';
import { formatMcpServerDisplayName } from '@/components/sections/mcp/McpSidebar.utils';
import { toggleMcpServerEnabled } from './McpDropdown.actions';
import {
  getMcpIndicatorState,
  getVisibleMcpServerNames,
  getVisibleMcpStatus,
  type McpIndicatorState,
} from './McpDropdown.utils';

const statusTooltip = (
  indicator: McpIndicatorState,
  t: (key:
    | 'mcpDropdown.status.unknown'
    | 'mcpDropdown.status.connected'
    | 'mcpDropdown.status.failed'
    | 'mcpDropdown.status.unknownError'
    | 'mcpDropdown.status.needsAuth'
    | 'mcpDropdown.status.needsRegistration'
    | 'mcpDropdown.status.needsRegistrationShort'
    | 'mcpDropdown.status.lastIssue'
    | 'mcpDropdown.status.disabled', params?: { error?: string }) => string
): string => {
  if (indicator.remembered) {
    if (indicator.status === 'needs_auth') return t('mcpDropdown.status.needsAuth');
    if (indicator.status === 'needs_client_registration') return t('mcpDropdown.status.needsRegistrationShort');
    return t('mcpDropdown.status.lastIssue');
  }

  switch (indicator.status) {
    case 'connected':
      return t('mcpDropdown.status.connected');
    case 'failed':
      return t('mcpDropdown.status.failed', { error: indicator.error || t('mcpDropdown.status.unknownError') });
    case 'needs_auth':
      return t('mcpDropdown.status.needsAuth');
    case 'needs_client_registration':
      return indicator.error
        ? t('mcpDropdown.status.needsRegistration', { error: indicator.error })
        : t('mcpDropdown.status.needsRegistrationShort');
    case 'disabled':
      return t('mcpDropdown.status.disabled');
    default:
      return t('mcpDropdown.status.unknown');
  }
};

const normalizeDirectory = (directory: string | null | undefined): string | null => {
  if (typeof directory !== 'string') return null;
  const trimmed = directory.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\\/g, '/');
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
};

const getProjectDisplayLabel = (project: { label?: string | null; path: string }): string => {
  const label = project.label?.trim();
  if (label) return label;
  return formatDirectoryName(project.path);
};

const useMcpProjectContext = (): { directory: string | null; label: string | null } => {
  const effectiveDirectory = useEffectiveDirectory();
  const projects = useProjectsStore((state) => state.projects);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const draftOpen = useSessionUIStore((state) => Boolean(state.currentDraftId && state.newSessionDraft?.open));
  const selectedProjectId = useSessionUIStore((state) => state.newSessionDraft?.selectedProjectId ?? null);
  const draftBootstrapDirectory = useSessionUIStore((state) => state.newSessionDraft?.bootstrapPendingDirectory ?? null);
  const draftDirectoryOverride = useSessionUIStore((state) => state.newSessionDraft?.directoryOverride ?? null);

  return React.useMemo(() => {
    const selectedDraftProject = selectedProjectId
      ? projects.find((project) => project.id === selectedProjectId) ?? null
      : null;
    const activeProject = activeProjectId
      ? projects.find((project) => project.id === activeProjectId) ?? null
      : null;

    // Keep MCP scoped to the chat target without mutating the global directory store.
    const directory = normalizeDirectory(
      draftOpen
        ? draftBootstrapDirectory ?? draftDirectoryOverride ?? selectedDraftProject?.path ?? effectiveDirectory
        : effectiveDirectory
    );

    const matchingProject = directory
      ? projects.find((project) => normalizeDirectory(project.path) === directory) ?? null
      : null;
    const labelProject = draftOpen
      ? selectedDraftProject ?? matchingProject ?? activeProject
      : matchingProject ?? activeProject;

    return {
      directory,
      label: labelProject
        ? getProjectDisplayLabel(labelProject)
        : directory
          ? formatDirectoryName(directory)
          : null,
    };
  }, [activeProjectId, draftBootstrapDirectory, draftDirectoryOverride, draftOpen, effectiveDirectory, projects, selectedProjectId]);
};

interface McpDropdownProps {
  headerIconButtonClass: string;
}

interface McpDropdownContentProps {
  active: boolean;
  className?: string;
}

export const McpDropdownContent: React.FC<McpDropdownContentProps> = ({ active, className }) => {
  const { t } = useI18n();
  const { directory, label } = useMcpProjectContext();
  const status = useMcpStore((state) => state.getStatusForDirectory(directory));
  const issueKinds = useMcpStore((state) => state.getIssueKindsForDirectory(directory));
  const refresh = useMcpStore((state) => state.refresh);
  const connect = useMcpStore((state) => state.connect);
  const disconnect = useMcpStore((state) => state.disconnect);
  const mcpServers = useMcpConfigStore((state) => state.mcpServers);
  const loadMcpConfigs = useMcpConfigStore((state) => state.loadMcpConfigs);
  const updateMcp = useMcpConfigStore((state) => state.updateMcp);
  const [isSpinning, setIsSpinning] = React.useState(false);
  const [busyName, setBusyName] = React.useState<string | null>(null);

  React.useEffect(() => {
    void refresh({ directory, silent: true });
  }, [refresh, directory]);

  React.useEffect(() => {
    void loadMcpConfigs({ force: true, directory });
  }, [directory, loadMcpConfigs]);

  React.useEffect(() => {
    if (!active) return;
    void Promise.all([
      refresh({ directory, silent: true }),
      loadMcpConfigs({ force: true, directory }),
    ]);
  }, [active, refresh, directory, loadMcpConfigs]);

  const sortedNames = React.useMemo(() => {
    return getVisibleMcpServerNames(status, mcpServers);
  }, [mcpServers, status]);

  const mcpServerByName = React.useMemo(() => {
    return new Map(mcpServers.map((server) => [server.name, server]));
  }, [mcpServers]);

  const handleRefresh = React.useCallback((e?: React.MouseEvent) => {
    e?.preventDefault();
    if (isSpinning) return;
    setIsSpinning(true);
    const minSpinPromise = new Promise(resolve => setTimeout(resolve, 500));
    Promise.all([
      refresh({ directory }),
      loadMcpConfigs({ force: true, directory }),
      minSpinPromise,
    ]).finally(() => {
      setIsSpinning(false);
    });
  }, [directory, isSpinning, loadMcpConfigs, refresh]);

  return (
    <div className={cn('w-full', className)}>
      <div className="border-b border-[var(--interactive-border)]">
        <div className="flex items-center justify-between gap-3 px-4 py-2.5">
          <div className="min-w-0 flex items-baseline gap-2">
            <div className="typography-ui-header font-semibold text-foreground">{t('mcpDropdown.title')}</div>
            {label && (
              <div className="truncate typography-micro text-muted-foreground">
                {label}
              </div>
            )}
          </div>
          <button
            type="button"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            disabled={isSpinning}
            onClick={handleRefresh}
            aria-label={t('mcpDropdown.actions.refreshAria')}
          >
            <RiRefreshLine className={cn('h-4 w-4', isSpinning && 'animate-spin')} />
          </button>
        </div>
      </div>

      <div className="max-h-64 overflow-y-auto py-2">
        {sortedNames.map((serverName) => {
          const serverStatus = status[serverName];
          const serverConfig = mcpServerByName.get(serverName);
          const isConnected = serverStatus?.status === 'connected';
          const isEnabled = serverConfig ? serverConfig.enabled !== false : isConnected;
          const indicator = getMcpIndicatorState({
            enabled: isEnabled,
            status: serverStatus,
            issueKind: issueKinds[serverName],
          });
          const isBusy = busyName === serverName;
          const tooltip = statusTooltip(indicator, t);

          return (
            <div
              key={serverName}
              className="flex items-center justify-between gap-2 px-4 py-1.5 rounded-lg hover:bg-interactive-hover/50"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 min-w-0">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        className={cn(
                          'h-2 w-2 rounded-full flex-shrink-0',
                          indicator.tone === 'success' && 'bg-status-success',
                          indicator.tone === 'warning' && 'bg-status-warning',
                          indicator.tone === 'idle' && 'bg-muted-foreground/40'
                        )}
                        aria-label={tooltip}
                      />
                    </TooltipTrigger>
                    <TooltipContent side="left">
                      <p>{tooltip}</p>
                    </TooltipContent>
                  </Tooltip>
                  <span className="typography-ui-label truncate" title={serverName}>{formatMcpServerDisplayName(serverName)}</span>
                </div>
              </div>

              <Switch
                checked={isEnabled}
                disabled={isBusy}
                className="data-[checked]:bg-status-info"
                onCheckedChange={async (checked) => {
                  setBusyName(serverName);
                  try {
                    await toggleMcpServerEnabled({
                      name: serverName,
                      enabled: checked,
                      directory,
                      isConnected,
                      updateMcp,
                      loadMcpConfigs,
                      refresh,
                      connect,
                      disconnect,
                    });
                  } finally {
                    setBusyName(null);
                  }
                }}
              />
            </div>
          );
        })}

        {sortedNames.length === 0 && (
          <div className="px-4 py-5 typography-ui-label text-muted-foreground text-center">
            {t('mcpDropdown.empty.configureInConfig')}
          </div>
        )}
      </div>
    </div>
  );
};

export const McpDropdown: React.FC<McpDropdownProps> = ({ headerIconButtonClass }) => {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const [tooltipOpen, setTooltipOpen] = React.useState(false);
  const blockTooltipRef = React.useRef(false);
  const { isMobile } = useDeviceInfo();
  const { directory, label } = useMcpProjectContext();

  const status = useMcpStore((state) => state.getStatusForDirectory(directory));
  const issueKinds = useMcpStore((state) => state.getIssueKindsForDirectory(directory));
  const refresh = useMcpStore((state) => state.refresh);
  const connect = useMcpStore((state) => state.connect);
  const disconnect = useMcpStore((state) => state.disconnect);
  const mcpServers = useMcpConfigStore((state) => state.mcpServers);
  const loadMcpConfigs = useMcpConfigStore((state) => state.loadMcpConfigs);
  const updateMcp = useMcpConfigStore((state) => state.updateMcp);

  const handleDropdownOpenChange = React.useCallback((isOpen: boolean) => {
    if (!isOpen) {
      blockTooltipRef.current = true;
      setTooltipOpen(false);
      setTimeout(() => {
        blockTooltipRef.current = false;
      }, 200);
    }
    setOpen(isOpen);
  }, []);

  const handleTooltipOpenChange = React.useCallback((isOpen: boolean) => {
    if (blockTooltipRef.current) return;
    setTooltipOpen(isOpen);
  }, []);

  const [isSpinning, setIsSpinning] = React.useState(false);

  const [busyName, setBusyName] = React.useState<string | null>(null);

  // Fetch on mount and when directory changes
  React.useEffect(() => {
    void refresh({ directory, silent: true });
    void loadMcpConfigs({ force: true, directory });
  }, [refresh, directory, loadMcpConfigs]);

  // Refresh when dropdown opens
  React.useEffect(() => {
    if (!open) return;
    void Promise.all([
      refresh({ directory, silent: true }),
      loadMcpConfigs({ force: true, directory }),
    ]);
  }, [open, refresh, directory, loadMcpConfigs]);

  const visibleStatus = React.useMemo(
    () => getVisibleMcpStatus(status, mcpServers),
    [mcpServers, status],
  );
  const health = React.useMemo(() => computeMcpHealth(visibleStatus), [visibleStatus]);

  const sortedNames = React.useMemo(() => {
    return getVisibleMcpServerNames(status, mcpServers);
  }, [mcpServers, status]);

  const hasVisibleRememberedIssue = React.useMemo(
    () => sortedNames.some((name) => status[name]?.status !== 'connected' && Boolean(issueKinds[name])),
    [issueKinds, sortedNames, status],
  );

  const mcpServerByName = React.useMemo(() => {
    return new Map(mcpServers.map((server) => [server.name, server]));
  }, [mcpServers]);

  const handleRefresh = React.useCallback((e?: React.MouseEvent) => {
    e?.preventDefault();
    if (isSpinning) return;
    setIsSpinning(true);
    const minSpinPromise = new Promise(resolve => setTimeout(resolve, 500));
    Promise.all([
      refresh({ directory }),
      loadMcpConfigs({ force: true, directory }),
      minSpinPromise,
    ]).finally(() => {
      setIsSpinning(false);
    });
  }, [directory, isSpinning, loadMcpConfigs, refresh]);

  const renderServerList = () => (
    <>
      {sortedNames.map((serverName) => {
        const serverStatus = status[serverName];
        const serverConfig = mcpServerByName.get(serverName);
        const isConnected = serverStatus?.status === 'connected';
        const isEnabled = serverConfig ? serverConfig.enabled !== false : isConnected;
        const indicator = getMcpIndicatorState({
          enabled: isEnabled,
          status: serverStatus,
          issueKind: issueKinds[serverName],
        });
        const isBusy = busyName === serverName;
        const tooltip = statusTooltip(indicator, t);

        return (
          <div
            key={serverName}
            className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg hover:bg-interactive-hover/50"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 min-w-0">
                {isMobile ? (
                  <span
                    className={cn(
                      'h-2 w-2 rounded-full flex-shrink-0',
                      indicator.tone === 'success' && 'bg-status-success',
                      indicator.tone === 'warning' && 'bg-status-warning',
                      indicator.tone === 'idle' && 'bg-muted-foreground/40'
                    )}
                    aria-label={tooltip}
                  />
                ) : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        className={cn(
                          'h-2 w-2 rounded-full flex-shrink-0',
                          indicator.tone === 'success' && 'bg-status-success',
                          indicator.tone === 'warning' && 'bg-status-warning',
                          indicator.tone === 'idle' && 'bg-muted-foreground/40'
                        )}
                        aria-label={tooltip}
                      />
                    </TooltipTrigger>
                    <TooltipContent side="left">
                      <p>{tooltip}</p>
                    </TooltipContent>
                  </Tooltip>
                )}
                <span className="typography-ui-label truncate" title={serverName}>{formatMcpServerDisplayName(serverName)}</span>
              </div>
            </div>

            <Switch
              checked={isEnabled}
              disabled={isBusy}
              className="data-[checked]:bg-status-info"
              onCheckedChange={async (checked) => {
                setBusyName(serverName);
                try {
                  await toggleMcpServerEnabled({
                    name: serverName,
                    enabled: checked,
                    directory,
                    isConnected,
                    updateMcp,
                    loadMcpConfigs,
                    refresh,
                    connect,
                    disconnect,
                  });
                } finally {
                  setBusyName(null);
                }
              }}
            />
          </div>
        );
      })}

      {sortedNames.length === 0 && (
        <div className="px-2 py-3 typography-ui-label text-muted-foreground text-center">
          {t('mcpDropdown.empty.configureInConfig')}
        </div>
      )}
    </>
  );

  const triggerButton = (
    <button
      type="button"
      aria-label={t('mcpDropdown.actions.openAria')}
      className={cn(headerIconButtonClass, 'relative')}
      onClick={isMobile ? () => setOpen(true) : undefined}
    >
      <McpIcon className="h-[1.0625rem] w-[1.0625rem]" />
      {sortedNames.length > 0 && (
        <span
          className={cn(
            'absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full',
            health.hasFailed || health.hasAuthRequired || hasVisibleRememberedIssue
              ? 'bg-status-warning'
              : health.connected > 0
                ? 'bg-status-success'
                : 'bg-muted-foreground/40'
          )}
          aria-label={t('mcpDropdown.statusAria')}
        />
      )}
    </button>
  );

  // Mobile: use MobileOverlayPanel
  if (isMobile) {
    return (
      <>
        {triggerButton}
        <MobileOverlayPanel
          open={open}
          title={t('mcpDropdown.title')}
          onClose={() => setOpen(false)}
          renderHeader={(closeButton) => (
            <div className="flex items-center justify-between px-3 py-2 border-b border-border/40">
              <h2 className="typography-ui-label font-semibold text-foreground">{t('mcpDropdown.title')}</h2>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-interactive-hover transition-colors"
                  disabled={isSpinning}
                  onClick={handleRefresh}
                  aria-label={t('mcpDropdown.actions.refreshAria')}
                >
                  <RiRefreshLine className={cn('h-4 w-4', isSpinning && 'animate-spin')} />
                </button>
                {closeButton}
              </div>
            </div>
          )}
        >
          <div className="py-1">
            {renderServerList()}
          </div>
          {label && (
            <div className="px-2 py-1 border-t border-border/40 mt-1">
              <span className="typography-meta text-muted-foreground truncate block">
                {label}
              </span>
            </div>
          )}
        </MobileOverlayPanel>
      </>
    );
  }

  // Desktop: use DropdownMenu
  return (
    <DropdownMenu open={open} onOpenChange={handleDropdownOpenChange}>
      <Tooltip open={open ? false : tooltipOpen} onOpenChange={handleTooltipOpenChange}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            {triggerButton}
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>
          <p>{t('mcpDropdown.title')}</p>
        </TooltipContent>
      </Tooltip>

      <DropdownMenuContent align="end" className="w-72">
        <McpDropdownContent active={open} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
