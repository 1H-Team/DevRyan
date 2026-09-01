import React from 'react';
import {
  RiRefreshLine,
  RiSettings3Line,
} from '@remixicon/react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  botsDesktopApi,
  type BotsDesktopApi,
  type RuntimeServiceStatus,
} from '@/lib/botsDesktopApi';
import { cn } from '@/lib/utils';
import { runtimeServicePresentation } from './botRuntimeServicePresentation';

export type BotRuntimeServicePanelProps = {
  canManage: boolean;
  desktopApi?: BotsDesktopApi;
  initialStatus?: RuntimeServiceStatus | null;
};

export const BotRuntimeServicePanel: React.FC<BotRuntimeServicePanelProps> = ({
  canManage,
  desktopApi = botsDesktopApi,
  initialStatus = null,
}) => {
  const [status, setStatus] = React.useState<RuntimeServiceStatus | null>(initialStatus);
  const [loading, setLoading] = React.useState(initialStatus === null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [legacyConsentOpen, setLegacyConsentOpen] = React.useState(false);

  const refresh = React.useCallback(async () => {
    if (!desktopApi.runtimeServiceStatus) return;
    setLoading(true);
    try {
      setStatus(await desktopApi.runtimeServiceStatus());
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to inspect the background runtime.');
    } finally {
      setLoading(false);
    }
  }, [desktopApi]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const enable = async (allowLegacy: boolean) => {
    if (!desktopApi.enableRuntimeService) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(await desktopApi.enableRuntimeService(allowLegacy));
      setLegacyConsentOpen(false);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to enable background Bots.');
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    if (!desktopApi.disableRuntimeService) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(await desktopApi.disableRuntimeService());
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Unable to disable background Bots.');
    } finally {
      setBusy(false);
    }
  };

  if (!desktopApi.isAvailable() || !desktopApi.runtimeServiceStatus) return null;
  const view = runtimeServicePresentation(status, loading);
  const StatusIcon = view.Icon;
  const connected = status?.connected === true;
  const canOpenSettings = status?.settingsUrl && desktopApi.openRuntimeServiceSettings;

  return (
    <>
      <section className={cn('shrink-0 border-b px-4 py-3', view.tone)} aria-labelledby="bot-runtime-service-heading">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <StatusIcon className={cn('mt-0.5 h-5 w-5 shrink-0', view.spin && 'animate-spin')} aria-hidden />
            <div className="min-w-0">
              <h2 id="bot-runtime-service-heading" className="typography-ui-label font-semibold text-foreground">{view.label}</h2>
              <p className="typography-micro text-muted-foreground">{view.detail}</p>
              {error ? <p role="alert" className="mt-1 typography-micro text-[var(--status-error)]">{error}</p> : null}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button type="button" size="xs" variant="ghost" aria-label="Refresh Background Runtime Status" disabled={busy || loading} onClick={() => void refresh()}>
              <RiRefreshLine className={cn('h-4 w-4', loading && 'animate-spin')} aria-hidden />
            </Button>
            {status?.registration.state === 'requires_approval' && canOpenSettings ? (
              <Button type="button" size="xs" variant="outline" onClick={() => void desktopApi.openRuntimeServiceSettings?.()}>
                <RiSettings3Line className="mr-1.5 h-4 w-4" aria-hidden />
                Open Settings
              </Button>
            ) : null}
            {canManage && !connected && status?.canEnable === true ? (
              <Button
                type="button"
                size="xs"
                disabled={busy}
                onClick={() => {
                  if (status?.registrationMode === 'legacy') setLegacyConsentOpen(true);
                  else void enable(false);
                }}
              >
                {busy ? 'Starting…' : 'Enable Background Bots'}
              </Button>
            ) : null}
            {canManage && connected ? (
              <Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => void disable()}>
                Disable Background Bots
              </Button>
            ) : null}
          </div>
        </div>
      </section>

      <Dialog open={legacyConsentOpen} onOpenChange={setLegacyConsentOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Enable background Bots?</DialogTitle>
            <DialogDescription>
              This DevRyan build uses a private per-user LaunchAgent with strict file permissions. It runs the installed DevRyan executable and keeps Bot routines, memory, and computer supervision active after the window closes.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setLegacyConsentOpen(false)}>Cancel</Button>
            <Button type="button" disabled={busy} onClick={() => void enable(true)}>Enable</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
