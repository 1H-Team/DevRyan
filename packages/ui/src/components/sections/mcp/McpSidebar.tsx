import React from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { RiDeleteBinLine, RiMore2Line, RiPlugLine, RiRefreshLine, RiServerLine, RiGlobalLine } from '@remixicon/react';
import { useMcpConfigStore, type McpDraft, type McpServerConfig } from '@/stores/useMcpConfigStore';
import { useShallow } from 'zustand/react/shallow';
import { useMcpStore } from '@/stores/useMcpStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { isMobileDeviceViaCSS } from '@/lib/device';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui';
import { SettingsEmptyState } from '@/components/sections/shared/SettingsEmptyState';
import { SettingsProjectSelector } from '@/components/sections/shared/SettingsProjectSelector';
import { SettingsSidebarHeader } from '@/components/sections/shared/SettingsSidebarHeader';
import { SettingsSidebarLayout } from '@/components/sections/shared/SettingsSidebarLayout';
import { SidebarGroup } from '@/components/sections/shared/SidebarGroup';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useI18n } from '@/lib/i18n';
import { formatMcpServerDisplayName, sortMcpServersAlphabetically } from './McpSidebar.utils';

interface McpSidebarProps {
  onItemSelect?: () => void;
}

// ---- Status dot ----
type StatusTone = 'success' | 'error' | 'warning' | 'idle';

const statusToneFromMcp = (status: string | undefined): StatusTone => {
  switch (status) {
    case 'connected': return 'success';
    case 'failed': return 'error';
    case 'needs_auth':
    case 'needs_client_registration': return 'warning';
    default: return 'idle';
  }
};

const StatusDot: React.FC<{ tone: StatusTone; enabled: boolean }> = ({ tone, enabled }) => {
  if (!enabled) {
    return (
      <span className="inline-block h-2 w-2 rounded-full bg-muted-foreground/30 flex-shrink-0" />
    );
  }
  const classes: Record<StatusTone, string> = {
    success: 'bg-[var(--status-success)]',
    error: 'bg-[var(--status-error)]',
    warning: 'bg-[var(--status-warning)]',
    idle: 'bg-muted-foreground/40',
  };
  return (
    <span className={cn('inline-block h-2 w-2 rounded-full flex-shrink-0', classes[tone])} />
  );
};

const McpServerListItem: React.FC<{
  server: McpServerConfig;
  status: string | undefined;
  selected: boolean;
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  onSelect: () => void;
  onDelete: () => void;
}> = ({ server, status, selected, menuOpen, onMenuOpenChange, onSelect, onDelete }) => {
  const { t } = useI18n();
  const isMobile = isMobileDeviceViaCSS();
  const displayName = formatMcpServerDisplayName(server.name);

  return (
    <div
      className={cn(
        'group relative flex items-center rounded-md px-1.5 py-0.5 transition-all duration-200 select-none',
        selected ? 'bg-interactive-selection' : 'hover:bg-interactive-hover',
      )}
      onContextMenu={!isMobile ? (e) => {
        e.preventDefault();
        onMenuOpenChange(true);
      } : undefined}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 flex-col gap-0 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
      >
        <div className="flex items-center gap-1.5">
          <StatusDot tone={statusToneFromMcp(status)} enabled={server.enabled} />
          <span className="typography-ui-label font-normal truncate text-foreground" title={server.name}>
            {displayName}
          </span>
          <span title={server.type === 'local'
            ? t('settings.mcp.sidebar.serverType.localTitle')
            : t('settings.mcp.sidebar.serverType.remoteTitle')}
          >
            {server.type === 'local' ? (
              <RiServerLine className="h-3 w-3 text-muted-foreground/60 flex-shrink-0" />
            ) : (
              <RiGlobalLine className="h-3 w-3 text-muted-foreground/60 flex-shrink-0" />
            )}
          </span>
        </div>
        <div className="typography-micro text-muted-foreground/60 truncate leading-tight pl-3.5">
          {server.type === 'local'
            ? (server as { command?: string[] }).command?.join(' ') ?? ''
            : (server as { url?: string }).url ?? ''}
        </div>
      </button>

      <DropdownMenu open={menuOpen} onOpenChange={onMenuOpenChange}>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6 flex-shrink-0 -mr-1 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
            aria-label={t('settings.mcp.sidebar.actions.serverMenuAria', { name: displayName })}
          >
            <RiMore2Line className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-fit min-w-20">
          <DropdownMenuItem
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="text-destructive focus:text-destructive"
          >
            <RiDeleteBinLine className="h-4 w-4 mr-px" />
            {t('settings.common.actions.delete')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};

export const McpSidebar: React.FC<McpSidebarProps> = ({ onItemSelect }) => {
  const { t } = useI18n();

  const { mcpServers, selectedMcpName, setSelectedMcp, setMcpDraft, loadMcpConfigs, deleteMcp } =
    useMcpConfigStore(useShallow((s) => ({
      mcpServers: s.mcpServers,
      selectedMcpName: s.selectedMcpName,
      setSelectedMcp: s.setSelectedMcp,
      setMcpDraft: s.setMcpDraft,
      loadMcpConfigs: s.loadMcpConfigs,
      deleteMcp: s.deleteMcp,
    })));

  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const mcpStatus = useMcpStore((state) => state.getStatusForDirectory(currentDirectory ?? null));
  const refreshStatus = useMcpStore((state) => state.refresh);
  const getErrorForDirectory = useMcpStore((state) => state.getErrorForDirectory);

  const [deleteTarget, setDeleteTarget] = React.useState<McpServerConfig | null>(null);
  const [isDeleting, setIsDeleting] = React.useState(false);
  const [openMenuMcp, setOpenMenuMcp] = React.useState<string | null>(null);
  const [isRefreshingStatus, setIsRefreshingStatus] = React.useState(false);

  const projectServers = React.useMemo(
    () => sortMcpServersAlphabetically(mcpServers.filter((server) => server.scope === 'project')),
    [mcpServers]
  );
  const userServers = React.useMemo(
    () => sortMcpServersAlphabetically(mcpServers.filter((server) => server.scope !== 'project')),
    [mcpServers]
  );

  React.useEffect(() => {
    void loadMcpConfigs({ force: true, directory: currentDirectory });
    void refreshStatus({ directory: currentDirectory, silent: true });
  }, [currentDirectory, loadMcpConfigs, refreshStatus]);

  const handleRefresh = React.useCallback(() => {
    if (isRefreshingStatus) return;

    setIsRefreshingStatus(true);
    const minSpinPromise = new Promise((resolve) => setTimeout(resolve, 500));

    Promise.all([
      loadMcpConfigs({ force: true, directory: currentDirectory }),
      refreshStatus({ directory: currentDirectory, silent: true }),
      minSpinPromise,
    ]).then(() => {
      const error = getErrorForDirectory(currentDirectory);
      if (error) {
        toast.error(error);
      }
    }).finally(() => {
      setIsRefreshingStatus(false);
    });
  }, [currentDirectory, getErrorForDirectory, isRefreshingStatus, loadMcpConfigs, refreshStatus]);

  const handleCreateNew = () => {
    const baseName = 'new-mcp-server';
    let newName = baseName;
    let counter = 1;
    while (mcpServers.some((s) => s.name === newName)) {
      newName = `${baseName}-${counter}`;
      counter++;
    }

    const draft: McpDraft = {
      name: newName,
      scope: 'user',
      type: 'local',
      command: [],
      url: '',
      environment: [],
      headers: [],
      oauthEnabled: true,
      oauthClientId: '',
      oauthClientSecret: '',
      oauthScope: '',
      oauthRedirectUri: '',
      timeout: '',
      enabled: true,
    };
    setMcpDraft(draft);
    setSelectedMcp(newName);
    onItemSelect?.();
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    const result = await deleteMcp(deleteTarget.name);
    if (result.ok) {
      if (result.reloadFailed) {
        toast.warning(result.message || `MCP server "${deleteTarget.name}" deleted, but OpenCode reload failed`, {
          description: result.warning || t('settings.mcp.sidebar.toast.refreshListIfStale'),
        });
      } else {
        toast.success(result.message || t('settings.mcp.sidebar.toast.serverDeleted', { name: formatMcpServerDisplayName(deleteTarget.name) }));
      }
    } else {
      toast.error(t('settings.mcp.sidebar.toast.deleteFailed'));
    }
    setDeleteTarget(null);
    setIsDeleting(false);
  };

  const renderServerGroup = (label: string, servers: McpServerConfig[]) => (
    <SidebarGroup label={label} count={servers.length} storageKey="mcp">
      {servers.map((server) => (
        <McpServerListItem
          key={server.name}
          server={server}
          status={mcpStatus[server.name]?.status}
          selected={selectedMcpName === server.name}
          menuOpen={openMenuMcp === server.name}
          onMenuOpenChange={(open) => setOpenMenuMcp(open ? server.name : null)}
          onSelect={() => {
            setSelectedMcp(server.name);
            setMcpDraft(null);
            onItemSelect?.();
          }}
          onDelete={() => setDeleteTarget(server)}
        />
      ))}
    </SidebarGroup>
  );

  return (
    <>
      <SettingsSidebarLayout
        variant="background"
        header={(
          <SettingsSidebarHeader
            title={t('settings.mcp.sidebar.title')}
            titleActions={(
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground"
                disabled={isRefreshingStatus}
                onClick={handleRefresh}
                aria-label={t('settings.mcp.sidebar.actions.refreshStatusAria')}
                title={t('settings.mcp.sidebar.actions.refreshStatusTitle')}
              >
                <RiRefreshLine className={cn('h-4 w-4', isRefreshingStatus && 'animate-spin')} />
              </Button>
            )}
            countLabel={t('settings.mcp.sidebar.total', { count: mcpServers.length })}
            onAdd={handleCreateNew}
            addButtonLabel={t('settings.mcp.sidebar.actions.addServerTitle')}
            addButtonTitle={t('settings.mcp.sidebar.actions.addServerTitle')}
          >
            <SettingsProjectSelector />
          </SettingsSidebarHeader>
        )}
      >
        {mcpServers.length === 0 ? (
          <SettingsEmptyState
            icon={RiPlugLine}
            title={t('settings.mcp.sidebar.empty.title')}
            description={t('settings.mcp.sidebar.empty.description')}
          />
        ) : (
          <>
            {projectServers.length > 0 ? renderServerGroup(t('settings.mcp.sidebar.group.projectServers'), projectServers) : null}
            {userServers.length > 0 ? renderServerGroup(t('settings.mcp.sidebar.group.userServers'), userServers) : null}
          </>
        )}
      </SettingsSidebarLayout>

      {/* Delete confirm dialog */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open && !isDeleting) setDeleteTarget(null); }}
      >
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{t('settings.mcp.sidebar.deleteDialog.title')}</DialogTitle>
              <DialogDescription>
                {t('settings.mcp.sidebar.deleteDialog.descriptionPrefix', { name: deleteTarget ? formatMcpServerDisplayName(deleteTarget.name) : '' })}{' '}
                <code className="text-foreground">opencode.json</code>.
              </DialogDescription>
            </DialogHeader>
          <DialogFooter>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setDeleteTarget(null)}
              disabled={isDeleting}
            >
              {t('settings.common.actions.cancel')}
            </Button>
            <Button size="sm" onClick={handleDelete} disabled={isDeleting}>
              {isDeleting ? t('settings.mcp.sidebar.actions.deleting') : t('settings.common.actions.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

// Re-export for easy sidebar icon usage
export { McpIcon } from '@/components/icons/McpIcon';
