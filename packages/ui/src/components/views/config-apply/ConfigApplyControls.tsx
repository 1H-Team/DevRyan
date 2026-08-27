import * as React from 'react';
import {
  RiErrorWarningLine,
  RiRestartLine,
  RiTimeLine,
} from '@remixicon/react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { useConfigApplyStore } from '@/stores/useConfigApplyStore';
import { getConfigApplyStatusText } from './configApplyPresentation';

const scopeLabel = (scope: string): string => {
  if (scope === 'mcp') return 'MCP Servers';
  return scope.charAt(0).toUpperCase() + scope.slice(1);
};

interface ConfigApplyControlsProps {
  variant?: 'sidebar' | 'mobile';
}

export const ConfigApplyControls: React.FC<ConfigApplyControlsProps> = ({ variant = 'sidebar' }) => {
  const status = useConfigApplyStore((state) => state.status);
  const isRequesting = useConfigApplyStore((state) => state.isRequesting);
  const requestError = useConfigApplyStore((state) => state.requestError);
  const refresh = useConfigApplyStore((state) => state.refresh);
  const applyWhenIdle = useConfigApplyStore((state) => state.applyWhenIdle);
  const forceRestart = useConfigApplyStore((state) => state.forceRestart);
  const acknowledgeExternalRestart = useConfigApplyStore((state) => state.acknowledgeExternalRestart);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [confirmedActiveCount, setConfirmedActiveCount] = React.useState(0);

  if (!status || status.state === 'clean') return null;

  const compact = variant === 'sidebar';
  const statusText = getConfigApplyStatusText(status);
  const scopeText = status.scopes.map(scopeLabel).join(', ');
  const activeChats = status.activeSessionCount > 0;

  const handlePrepareForce = async () => {
    const fresh = await refresh();
    if (!fresh?.pending || !fresh.canForceRestart) return;
    setConfirmedActiveCount(fresh.activeSessionCount);
    setConfirmOpen(true);
  };

  const handleForce = async () => {
    try {
      await forceRestart();
      setConfirmOpen(false);
    } catch {
      // The store keeps the sanitized error and fresh status visible.
    }
  };

  const handleSafeApply = async () => {
    try {
      await applyWhenIdle();
    } catch {
      // The store keeps the sanitized error and fresh status visible.
    }
  };

  const handleAcknowledge = async () => {
    try {
      await acknowledgeExternalRestart();
    } catch {
      // The store keeps the sanitized error and fresh status visible.
    }
  };

  return (
    <>
      <section
        aria-live="polite"
        className={cn(
          'border-border/70 bg-[var(--surface-subtle)]/55',
          compact ? 'rounded-md border px-2 py-2' : 'border-t px-3 py-2',
        )}
      >
        <div className="flex items-start gap-2">
          {status.state === 'failed' ? (
            <RiErrorWarningLine className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          ) : status.state === 'waiting_for_idle' ? (
            <RiTimeLine className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          ) : (
            <RiRestartLine className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          )}
          <div className="min-w-0 flex-1">
            <p className="typography-micro font-medium text-foreground">{statusText}</p>
            {scopeText ? (
              <p className="typography-micro truncate text-muted-foreground/75">{scopeText}</p>
            ) : null}
          </div>
        </div>

        {status.state === 'external_restart_required' ? (
          <div className="mt-2 space-y-2">
            <p className="typography-micro text-muted-foreground">
              Stop and start the OpenCode process you connected to. When it is healthy again, confirm below so DevRyan can refresh the affected catalogs.
            </p>
            <Button size="xs" variant="outline" disabled={isRequesting} onClick={() => void handleAcknowledge()}>
              I Restarted It
            </Button>
          </div>
        ) : status.state !== 'applying' ? (
          <div className={cn('mt-2 flex flex-wrap gap-1.5', compact && 'flex-col')}>
            <Button size="xs" disabled={isRequesting} onClick={() => void handleSafeApply()}>
              {activeChats ? 'Apply When Idle' : status.state === 'failed' ? 'Retry Apply' : 'Apply & Restart'}
            </Button>
            {activeChats ? (
              status.canForceRestart ? (
                <Button size="xs" variant="destructive" disabled={isRequesting} onClick={() => void handlePrepareForce()}>
                  Restart Now
                </Button>
              ) : (
                <Button size="xs" variant="outline" disabled title="An Administrator Must Restart OpenCode While Chats Are Active.">
                  Ask an Administrator
                </Button>
              )
            ) : null}
          </div>
        ) : null}

        {requestError ? (
          <p role="alert" className="mt-2 typography-micro text-destructive">{requestError}</p>
        ) : null}
      </section>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restart OpenCode now?</DialogTitle>
            <DialogDescription>
              {confirmedActiveCount === 1
                ? '1 active chat will be stopped for all users.'
                : `${confirmedActiveCount} active chats will be stopped for all users.`}{' '}
              Saved configuration changes will remain pending if the restart fails.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-destructive/25 bg-destructive/5 p-3 typography-ui-label text-foreground">
            This can interrupt streaming responses and running tools. DevRyan will first attempt a bounded graceful abort, then restart the managed runtime.
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button variant="destructive" disabled={isRequesting} onClick={() => void handleForce()}>
              Restart Now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
