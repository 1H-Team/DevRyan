import React from 'react';
import { RiLoaderLine, RiRefreshLine, RiStopCircleLine } from '@remixicon/react';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { ManagedProcessCategory, ManagedProcessInfo, OrphanedOpenCodeServerInfo } from '@/lib/api/types';
import { useSessions } from '@/sync/sync-context';
import {
  PROCESSES_POLL_INTERVAL_MS,
  formatProcessAge,
  groupProcessesBySession,
  useProcessesStore,
} from '@/stores/useProcessesStore';

type StopTarget = {
  pid: number;
  startedAt: number | null;
  command: string;
  category: ManagedProcessCategory | 'orphan_server';
};

const CATEGORY_KEYS: Record<ManagedProcessCategory, 'terminalView.processes.category.dev_server' | 'terminalView.processes.category.agent_cli' | 'terminalView.processes.category.lsp' | 'terminalView.processes.category.mcp' | 'terminalView.processes.category.other'> = {
  dev_server: 'terminalView.processes.category.dev_server',
  agent_cli: 'terminalView.processes.category.agent_cli',
  lsp: 'terminalView.processes.category.lsp',
  mcp: 'terminalView.processes.category.mcp',
  other: 'terminalView.processes.category.other',
};

const ROW_GRID = 'grid grid-cols-[minmax(0,1fr)_auto_auto_auto_auto] items-center gap-x-3';

export const ProcessesPanel: React.FC<{ directory: string | null; visible: boolean }> = ({ directory, visible }) => {
  const { t } = useI18n();
  const snapshot = useProcessesStore((state) => state.snapshot);
  const isLoading = useProcessesStore((state) => state.isLoading);
  const error = useProcessesStore((state) => state.error);
  const stoppingPids = useProcessesStore((state) => state.stoppingPids);
  const refresh = useProcessesStore((state) => state.refresh);
  const stop = useProcessesStore((state) => state.stop);
  const startPolling = useProcessesStore((state) => state.startPolling);
  const sessions = useSessions();
  const [pendingStop, setPendingStop] = React.useState<StopTarget | null>(null);

  React.useEffect(() => {
    if (!visible) return undefined;
    return startPolling(directory, PROCESSES_POLL_INTERVAL_MS);
  }, [directory, startPolling, visible]);

  const sessionTitle = React.useCallback((sessionId: string | null) => {
    if (!sessionId) return t('terminalView.processes.unknownSession');
    const session = sessions.find((entry) => entry.id === sessionId);
    return session?.title?.trim() || t('terminalView.processes.sessionFallback', { id: sessionId.slice(-8) });
  }, [sessions, t]);

  const runStop = React.useCallback(async (target: StopTarget) => {
    try {
      await stop(target.pid, target.startedAt);
      toast.success(t('terminalView.processes.stopped', { pid: target.pid }));
    } catch (stopError) {
      toast.error(t('terminalView.processes.stopFailed'), {
        description: stopError instanceof Error ? stopError.message : undefined,
      });
    }
  }, [stop, t]);

  const requestStop = React.useCallback((target: StopTarget) => {
    // Dev servers are the expected leftovers; anything else asks first.
    if (target.category === 'dev_server') {
      void runStop(target);
      return;
    }
    setPendingStop(target);
  }, [runStop]);

  const confirmStop = React.useCallback(() => {
    if (!pendingStop) return;
    const target = pendingStop;
    setPendingStop(null);
    void runStop(target);
  }, [pendingStop, runStop]);

  const groups = React.useMemo(() => groupProcessesBySession(snapshot?.processes ?? []), [snapshot?.processes]);
  const orphanServers = snapshot?.orphanServers ?? [];
  const runningCount = (snapshot?.processes.length ?? 0) + orphanServers.length;

  const renderStopButton = (target: StopTarget) => {
    const stopping = stoppingPids.includes(target.pid);
    return (
      <Button
        type="button"
        size="xs"
        variant="outline"
        className="h-6 gap-1 px-2"
        onClick={() => requestStop(target)}
        disabled={stopping}
        title={t('terminalView.processes.stopTitle')}
      >
        {stopping ? <RiLoaderLine className="h-3.5 w-3.5 animate-spin" /> : <RiStopCircleLine className="h-3.5 w-3.5" />}
        <span>{stopping ? t('terminalView.processes.stopping') : t('terminalView.processes.stop')}</span>
      </Button>
    );
  };

  const renderProcessRow = (process: ManagedProcessInfo) => (
    <div key={process.pid} className={cn(ROW_GRID, 'py-1')}>
      <div className="min-w-0 truncate font-mono text-[0.8em] text-foreground" title={process.command}>
        {process.command}
      </div>
      <span className="typography-micro rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
        {t(CATEGORY_KEYS[process.category])}
      </span>
      <span className="typography-micro tabular-nums text-muted-foreground">{formatProcessAge(process.ageMs)}</span>
      <span className="typography-micro tabular-nums text-muted-foreground">
        {process.ports.length > 0 ? process.ports.join(', ') : '—'}
      </span>
      {renderStopButton({ pid: process.pid, startedAt: process.startedAt, command: process.command, category: process.category })}
    </div>
  );

  const renderOrphanRow = (server: OrphanedOpenCodeServerInfo) => (
    <div key={server.pid} className={cn(ROW_GRID, 'py-1')}>
      <div className="min-w-0 truncate font-mono text-[0.8em] text-foreground" title={server.command}>
        {server.command}
      </div>
      <span className="typography-micro rounded bg-muted px-1.5 py-0.5 text-muted-foreground">pid {server.pid}</span>
      <span className="typography-micro tabular-nums text-muted-foreground">{formatProcessAge(server.ageMs)}</span>
      <span className="typography-micro tabular-nums text-muted-foreground">
        {server.port ? t('terminalView.processes.orphans.port', { port: server.port }) : '—'}
      </span>
      {renderStopButton({ pid: server.pid, startedAt: server.startedAt, command: server.command, category: 'orphan_server' })}
    </div>
  );

  return (
    <div className="absolute inset-0 flex flex-col overflow-hidden bg-[var(--surface-background)] text-xs">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/40 px-3 py-1.5">
        <span className="typography-meta text-muted-foreground">
          {t('terminalView.processes.summary', { count: runningCount })}
        </span>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="h-6 w-6 p-0"
          onClick={() => { void refresh(directory); }}
          disabled={isLoading}
          title={t('terminalView.processes.refresh')}
          aria-label={t('terminalView.processes.refresh')}
        >
          <RiRefreshLine className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
        {error ? (
          <p className="mb-2 typography-meta text-[var(--status-error-foreground)]">
            {t('terminalView.processes.loadFailed')}: {error}
          </p>
        ) : null}

        {snapshot && !snapshot.supported ? (
          <p className="typography-meta text-muted-foreground">{t('terminalView.processes.unsupported')}</p>
        ) : null}

        {snapshot?.supported && groups.length === 0 && orphanServers.length === 0 ? (
          <p className="typography-meta text-muted-foreground">{t('terminalView.processes.empty')}</p>
        ) : null}

        {groups.length > 0 ? (
          <div className={cn(ROW_GRID, 'border-b border-border/40 pb-1 typography-micro uppercase tracking-wide text-muted-foreground/80')}>
            <span>{t('terminalView.processes.columns.command')}</span>
            <span>{t('terminalView.processes.columns.type')}</span>
            <span>{t('terminalView.processes.columns.age')}</span>
            <span>{t('terminalView.processes.columns.ports')}</span>
            <span />
          </div>
        ) : null}

        {groups.map((group) => (
          <section key={group.sessionId ?? '__unattributed__'} className="mt-2">
            <h4 className="typography-meta truncate font-medium text-foreground" title={group.sessionId ?? undefined}>
              {sessionTitle(group.sessionId)}
            </h4>
            <div className="mt-0.5 divide-y divide-border/30">
              {group.processes.map(renderProcessRow)}
            </div>
          </section>
        ))}

        {orphanServers.length > 0 ? (
          <section className="mt-4">
            <h4 className="typography-meta font-medium text-foreground">{t('terminalView.processes.orphans.title')}</h4>
            <p className="typography-micro text-muted-foreground">{t('terminalView.processes.orphans.description')}</p>
            <div className="mt-0.5 divide-y divide-border/30">
              {orphanServers.map(renderOrphanRow)}
            </div>
          </section>
        ) : null}
      </div>

      <Dialog open={pendingStop !== null} onOpenChange={(open) => { if (!open) setPendingStop(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('terminalView.processes.confirm.title')}</DialogTitle>
            <DialogDescription className="break-all">
              {pendingStop
                ? t('terminalView.processes.confirm.description', { pid: pendingStop.pid, command: pendingStop.command })
                : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingStop(null)}>
              {t('settings.common.actions.cancel')}
            </Button>
            <Button variant="destructive" onClick={confirmStop}>
              {t('terminalView.processes.stop')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
