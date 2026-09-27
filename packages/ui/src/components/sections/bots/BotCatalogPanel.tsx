import React from 'react';
import {
  RiDatabase2Line,
  RiLoader4Line,
  RiRefreshLine,
} from '@remixicon/react';

import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  BOT_CATALOG_RESTORE_CONFIRMATION,
  BOT_CATALOG_START_EMPTY_CONFIRMATION,
  BotsApiError,
  botsApi,
  type BotCatalogBackup,
  type BotCatalogStatus,
  type BotsApi,
} from '@/lib/botsApi';
import { cn } from '@/lib/utils';
import {
  botCatalogBackupLabel,
  botCatalogImportPhaseLabel,
  formatBotCatalogBytes,
  resolveBotCatalogAction,
  type BotCatalogAction,
} from './botCatalogPresentation';

const POLL_MS = 2_000;

const errorText = (error: unknown): string => (
  error instanceof Error && error.message ? error.message : 'The local Bot catalog operation failed.'
);

const formatTime = (value: string): string => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
};

type ConfirmKind = 'restore' | 'start_empty' | 'import' | null;

export type BotCatalogPanelProps = {
  /** Compact: only the single recovery control for the current state. */
  variant?: 'compact' | 'full';
  api?: BotsApi;
  /** Capability state the parent observed; a change triggers a status reload. */
  capabilityState?: string | null;
  /** Called after Restore, Start Empty, Resume or a completed import. */
  onCatalogChanged?: () => void;
  className?: string;
};

export const BotCatalogPanel: React.FC<BotCatalogPanelProps> = ({
  variant = 'compact',
  api = botsApi,
  capabilityState = null,
  onCatalogChanged,
  className,
}) => {
  const [status, setStatus] = React.useState<BotCatalogStatus | null>(null);
  const [backups, setBackups] = React.useState<readonly BotCatalogBackup[] | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [statusError, setStatusError] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState<ConfirmKind>(null);
  const [restoreTarget, setRestoreTarget] = React.useState<BotCatalogBackup | null>(null);
  const [typed, setTyped] = React.useState('');
  const [writersStopped, setWritersStopped] = React.useState(false);
  const request = React.useRef(0);
  const lastImportPhase = React.useRef<string | null>(null);
  const onChangedRef = React.useRef(onCatalogChanged);
  onChangedRef.current = onCatalogChanged;

  const load = React.useCallback(async () => {
    const current = ++request.current;
    try {
      const next = await api.getCatalogStatus();
      if (current !== request.current) return;
      setStatus(next);
      setStatusError(null);
      const wantsBackups = next.viewerIsOwner && (variant === 'full' || next.state === 'recovery_required');
      if (wantsBackups) {
        const listed = await api.listCatalogBackups().catch(() => null);
        if (current === request.current && listed) setBackups(listed.backups);
      }
      const phase = next.import?.import?.phase ?? null;
      if (lastImportPhase.current && lastImportPhase.current !== phase && phase === 'completed') {
        onChangedRef.current?.();
      }
      lastImportPhase.current = phase;
    } catch (loadError) {
      if (current !== request.current) return;
      // The standalone web host has no local catalog; show nothing there.
      if (loadError instanceof BotsApiError && loadError.status === 404) {
        setStatus(null);
        setStatusError(null);
      } else {
        setStatusError(`${errorText(loadError)}${loadError instanceof BotsApiError ? ` (${loadError.code})` : ''}`);
      }
    }
  }, [api, variant]);

  React.useEffect(() => {
    void load();
    return () => { request.current += 1; };
  }, [load, capabilityState]);

  const running = Boolean(status?.import?.import?.running || status?.maintenance || status?.backups?.running);
  const polling = running || status?.import?.checking === true;
  React.useEffect(() => {
    if (!polling) return undefined;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load, polling]);

  const run = async (operation: () => Promise<unknown>, success: string, changed = true) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
      toast.success(success);
      setConfirm(null);
      setTyped('');
      if (changed) onChangedRef.current?.();
    } catch (operationError) {
      const message = errorText(operationError);
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
      await load();
    }
  };

  const action = resolveBotCatalogAction(status, backups);
  if (!status) return statusError ? (
    <div className="p-4 typography-ui text-muted-foreground" role="alert">
      {statusError}
      <Button type="button" size="xs" variant="outline" className="ml-2" onClick={() => void load()}>Retry Bot Storage</Button>
    </div>
  ) : null;
  if (variant === 'compact' && !action && !statusError) return null;

  const openRestore = (backup: BotCatalogBackup) => {
    setRestoreTarget(backup);
    setTyped('');
    setConfirm('restore');
  };

  const actionView = (current: BotCatalogAction | null): { title: string; detail: string; control: React.ReactNode } | null => {
    if (!current) return null;
    switch (current.kind) {
      case 'maintenance':
        return {
          title: 'Bot Storage Maintenance',
          detail: 'Bots are paused while their storage is backed up, restored or imported. They resume automatically.',
          control: <RiLoader4Line className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden />,
        };
      case 'import_running':
        return {
          title: 'Importing Hosted Bots',
          detail: botCatalogImportPhaseLabel(status.import?.import?.phase),
          control: (
            <Button type="button" size="xs" variant="outline" disabled={busy}
              onClick={() => void run(() => api.cancelCatalogImport(), 'Import cancelled.', false)}>
              Cancel Import
            </Button>
          ),
        };
      case 'restore':
        return {
          title: 'Bot Storage Needs Recovery',
          detail: `This computer's Bot storage could not be opened safely. Restore the latest verified backup from ${formatTime(current.backup.createdAt)}.`,
          control: (
            <Button type="button" size="xs" disabled={busy} onClick={() => openRestore(current.backup)}>
              Restore Backup
            </Button>
          ),
        };
      case 'start_empty':
        return {
          title: 'Bot Storage Needs Recovery',
          detail: 'No verified backup is available. Start with empty Bot storage; the unreadable storage is kept for diagnosis.',
          control: (
            <Button type="button" size="xs" variant="destructive" disabled={busy}
              onClick={() => { setTyped(''); setConfirm('start_empty'); }}>
              Start Empty
            </Button>
          ),
        };
      case 'owner_required':
        return {
          title: 'Bot Storage Needs Recovery',
          detail: 'Only this computer\'s owner can restore Bot storage.',
          control: null,
        };
      case 'resume_activation':
        return {
          title: 'Bots Are Paused',
          detail: 'Restored or imported Bots stay paused until you resume them, so nothing runs or sends before you have checked them.',
          control: (
            <Button type="button" size="xs" disabled={busy}
              onClick={() => void run(() => api.resumeBotActivation(), 'Bots resumed.')}>
              Resume Bots
            </Button>
          ),
        };
      case 'import_blocked':
        return {
          title: 'Import Is Waiting',
          detail: 'The hosted service refused more reads (quota). Progress is saved; resume when it is available again.',
          control: (
            <Button type="button" size="xs" disabled={busy}
              onClick={() => { setWritersStopped(false); setConfirm('import'); }}>
              Resume Import
            </Button>
          ),
        };
      case 'import_failed':
        return {
          title: 'Import Did Not Complete',
          detail: `${current.message} Your Bots on this computer were not changed.`,
          control: current.retry ? (
            <Button type="button" size="xs" disabled={busy}
              onClick={() => { setWritersStopped(false); setConfirm('import'); }}>
              Try Again
            </Button>
          ) : (
            <Button type="button" size="xs" variant="outline" disabled={busy}
              onClick={() => void run(() => api.dismissCatalogImport(), 'Import notice dismissed.', false)}>
              Dismiss
            </Button>
          ),
        };
      case 'discovery_checking':
        return {
          title: 'Checking for Hosted Bots…',
          detail: 'Bots already on this computer remain available.',
          control: <RiLoader4Line className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden />,
        };
      case 'discovery_failed':
        return {
          title: 'Could Not Check Hosted Bots',
          detail: `The hosted source could not be checked (${current.code}). Bots already on this computer remain available.`,
          control: null,
        };
      case 'import_pending':
        return {
          title: 'Hosted Bots Can Be Imported',
          detail: 'Bots from your hosted workspace are not on this computer yet. Importing keeps the Bots already here.',
          control: (
            <div className="flex items-center gap-2">
              <Button type="button" size="xs" variant="ghost" disabled={busy}
                onClick={() => void run(() => api.dismissCatalogImport(), 'Hosted Bots stay in the cloud.', false)}>
                Not Now
              </Button>
              <Button type="button" size="xs" disabled={busy}
                onClick={() => { setWritersStopped(false); setConfirm('import'); }}>
                Import Bots
              </Button>
            </div>
          ),
        };
      default:
        return null;
    }
  };

  const view = actionView(action);

  return (
    <>
      <section
        className={cn(variant === 'full' ? 'shrink-0 border-b px-4 py-3' : 'w-full', className)}
        aria-labelledby="bot-catalog-heading"
        data-bot-catalog-state={status.state}
      >
        <div className={cn('flex flex-col gap-2', variant === 'full' && 'mx-auto max-w-6xl')}>
          {variant === 'full' ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <h2 id="bot-catalog-heading" className="typography-ui-label font-semibold text-foreground">Bot Storage</h2>
                <p className="typography-micro text-muted-foreground">
                  Bots and their files are stored on this computer and backed up daily.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button type="button" size="xs" variant="ghost" aria-label="Refresh Bot Storage Status" disabled={busy}
                  onClick={() => void load()}>
                  <RiRefreshLine className="h-4 w-4" aria-hidden />
                </Button>
                {status.viewerIsOwner && status.backups?.backupsAvailable ? (
                  <Button type="button" size="xs" variant="outline" disabled={busy || running}
                    onClick={() => void run(() => api.backupCatalog(), 'Backup created and verified.', false)}>
                    Back Up Now
                  </Button>
                ) : null}
              </div>
            </div>
          ) : (
            <h2 id="bot-catalog-heading" className="sr-only">Bot Storage</h2>
          )}
          {statusError ? <p role="alert" className="typography-micro text-[var(--status-error)]">{statusError}</p> : null}
          {view ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2" role="status">
              <div className="flex min-w-0 items-start gap-3">
                <RiDatabase2Line className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0">
                  <p className="typography-ui-label font-semibold text-foreground">{view.title}</p>
                  <p className="typography-micro text-muted-foreground">{view.detail}</p>
                  {error ? <p role="alert" className="mt-1 typography-micro text-[var(--status-error)]">{error}</p> : null}
                </div>
              </div>
              {view.control ? <div className="flex shrink-0 items-center gap-2">{view.control}</div> : null}
            </div>
          ) : error ? (
            <p role="alert" className="typography-micro text-[var(--status-error)]">{error}</p>
          ) : null}
          {variant === 'full' && status.viewerIsOwner && backups && backups.length > 0 ? (
            <ul className="divide-y rounded-md border" aria-label="Verified Bot Backups">
              {backups.slice(0, 8).map((backup) => (
                <li key={backup.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <p className="typography-ui-label text-foreground">
                      {botCatalogBackupLabel(backup)} · {formatTime(backup.createdAt)}
                    </p>
                    <p className="typography-micro text-muted-foreground">
                      {backup.objectCount} files · {formatBotCatalogBytes(backup.bytes)}
                    </p>
                  </div>
                  <Button type="button" size="xs" variant="outline" disabled={busy || running}
                    onClick={() => openRestore(backup)}>
                    Restore
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </section>

      <Dialog open={confirm === 'restore'} onOpenChange={(open) => { if (!open) setConfirm(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restore Bot Storage?</DialogTitle>
            <DialogDescription>
              Bots on this computer are replaced with the backup from {restoreTarget ? formatTime(restoreTarget.createdAt) : ''}.
              The current storage is backed up first, and restored Bots stay paused until you resume them.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setConfirm(null)}>Cancel</Button>
            <Button type="button" disabled={busy || !restoreTarget}
              onClick={() => restoreTarget && void run(
                () => api.restoreCatalog(restoreTarget.id, BOT_CATALOG_RESTORE_CONFIRMATION),
                'Bot storage restored. Resume Bots when you are ready.',
              )}>
              {busy ? 'Restoring…' : 'Restore'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirm === 'start_empty'} onOpenChange={(open) => { if (!open) setConfirm(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Start With Empty Bot Storage?</DialogTitle>
            <DialogDescription>
              This computer starts without Bots. The unreadable storage is kept for diagnosis, not deleted.
              Type {BOT_CATALOG_START_EMPTY_CONFIRMATION} to continue.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={typed}
            aria-label="Confirmation"
            autoComplete="off"
            onChange={(event) => setTyped(event.target.value)}
          />
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setConfirm(null)}>Cancel</Button>
            <Button type="button" variant="destructive"
              disabled={busy || typed.trim() !== BOT_CATALOG_START_EMPTY_CONFIRMATION}
              onClick={() => void run(
                () => api.startEmptyCatalog(BOT_CATALOG_START_EMPTY_CONFIRMATION),
                'Bot storage started empty.',
              )}>
              {busy ? 'Starting…' : 'Start Empty'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirm === 'import'} onOpenChange={(open) => { if (!open) setConfirm(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import Hosted Bots?</DialogTitle>
            <DialogDescription>
              Hosted Bots are copied to this computer and keep their history. Bots already here are kept; if any
              Bot exists in both places the import stops without changing anything. Imported Bots stay paused until
              you resume them.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-start gap-2">
            <Checkbox
              checked={writersStopped}
              onChange={setWritersStopped}
              ariaLabel="Other Computers Are Stopped"
            />
            <p className="typography-micro text-foreground">
              I have quit DevRyan on every other computer that uses these hosted Bots, so nothing changes them
              during the import.
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setConfirm(null)}>Cancel</Button>
            <Button type="button" disabled={busy || !writersStopped}
              onClick={() => void run(
                () => api.startCatalogImport({ mode: status.import?.import?.mode ?? 'merge', writersStopped: true }),
                'Import started.',
                false,
              )}>
              Import
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
