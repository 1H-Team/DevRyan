import * as React from 'react';
import { RiLoader4Line, RiRefreshLine } from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from '@/components/ui';
import {
  getAgentBrowserInstallerStatus,
  isDesktopLocalOriginActive,
  isElectronShell,
  repairAgentBrowserInstaller,
  setAgentBrowserControlEnabled,
  type AgentBrowserInstallerStatus,
} from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';

const INSTALLER_PENDING_POLL_MS = 500;

const readActiveLeaseCount = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
};

export const AgentBrowserControlSettings: React.FC = () => {
  const { t } = useI18n();
  const isLocalDesktop = isElectronShell() && isDesktopLocalOriginActive();
  // Defaults to on: the setting is only persisted as `false` when the user opts out.
  const [enabled, setEnabled] = React.useState(true);
  const [isLoading, setIsLoading] = React.useState(true);
  const [isSaving, setIsSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [installerStatus, setInstallerStatus] = React.useState<AgentBrowserInstallerStatus | null>(null);
  const [isInstallerLoading, setIsInstallerLoading] = React.useState(true);
  const [isRepairing, setIsRepairing] = React.useState(false);
  const [installerError, setInstallerError] = React.useState<string | null>(null);
  const activeLeaseCount = installerStatus?.activeLeaseCount ?? 0;
  const skillWarnings = React.useMemo(() => {
    const skill = installerStatus?.skill;
    if (!skill) return [];

    const messages = [...(skill.conflicts ?? []), ...(skill.issues ?? [])]
      .map((issue) => issue.message.trim())
      .filter(Boolean);
    if (messages.length > 0) return messages;
    if (skill.state === 'conflict') {
      return [t('settings.openchamber.agentBrowserControl.installer.skillConflict')];
    }
    if (skill.state === 'error') {
      return [t('settings.openchamber.agentBrowserControl.installer.skillError')];
    }
    return [];
  }, [installerStatus?.skill, t]);

  React.useEffect(() => {
    if (!isLocalDesktop) {
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/config/settings', {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) {
          throw new Error(t('settings.openchamber.agentBrowserControl.error.loadFailed'));
        }

        const data = (await response.json().catch(() => null)) as null | { agentBrowserControlEnabled?: unknown };
        if (cancelled) return;
        setEnabled(data?.agentBrowserControlEnabled !== false);
        setError(null);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : t('settings.openchamber.agentBrowserControl.error.loadFailed'));
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isLocalDesktop, t]);

  React.useEffect(() => {
    if (!isLocalDesktop) {
      setIsInstallerLoading(false);
      return undefined;
    }

    let cancelled = false;
    let pollTimer: number | undefined;

    const schedulePoll = () => {
      pollTimer = window.setTimeout(() => {
        void pollInstallerStatus(false, true);
      }, INSTALLER_PENDING_POLL_MS);
    };

    const pollInstallerStatus = async (showLoading: boolean, retryAfterFailure: boolean) => {
      if (showLoading) {
        setIsInstallerLoading(true);
      }
      setInstallerError(null);
      try {
        const status = await getAgentBrowserInstallerStatus();
        if (!status) {
          throw new Error(t('settings.openchamber.agentBrowserControl.installer.error.statusFailed'));
        }
        if (cancelled) return;
        setInstallerStatus(status);
        setIsInstallerLoading(false);
        if (status.state === 'pending') {
          schedulePoll();
        }
      } catch (cause) {
        if (cancelled) return;
        setInstallerError(cause instanceof Error
          ? cause.message
          : t('settings.openchamber.agentBrowserControl.installer.error.statusFailed'));
        setIsInstallerLoading(false);
        if (retryAfterFailure) {
          schedulePoll();
        }
      }
    };

    void pollInstallerStatus(true, false);
    return () => {
      cancelled = true;
      if (pollTimer !== undefined) {
        window.clearTimeout(pollTimer);
      }
    };
  }, [isLocalDesktop, t]);

  React.useEffect(() => {
    if (!isLocalDesktop) return undefined;

    const handleGlobalLeaseTotal = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (!detail || typeof detail !== 'object') return;
      const activeLeaseCount = readActiveLeaseCount(
        (detail as { activeLeaseCount?: unknown }).activeLeaseCount,
      );
      if (activeLeaseCount === null) return;
      setInstallerStatus((status) => {
        if (!status || status.activeLeaseCount === activeLeaseCount) return status;
        return { ...status, activeLeaseCount };
      });
    };

    window.addEventListener('browser-agent-lease-total', handleGlobalLeaseTotal);
    return () => window.removeEventListener('browser-agent-lease-total', handleGlobalLeaseTotal);
  }, [isLocalDesktop]);

  const handleChange = React.useCallback(async (nextEnabled: boolean) => {
    if (isLoading || isSaving) return;

    const previous = enabled;
    setEnabled(nextEnabled);
    setIsSaving(true);
    setError(null);

    try {
      // Electron main owns both persistence and immediate teardown. Keeping
      // those in one IPC transaction prevents a saved disabled state from
      // leaving already-active leases alive when a second call fails.
      const result = await setAgentBrowserControlEnabled(nextEnabled);
      if (!result || result.enabled !== nextEnabled) {
        throw new Error(t('settings.openchamber.agentBrowserControl.toast.applyFailed'));
      }
      setEnabled(result.enabled);
    } catch (cause) {
      setEnabled(previous);
      setError(cause instanceof Error ? cause.message : t('settings.openchamber.agentBrowserControl.error.saveFailed'));
    } finally {
      setIsSaving(false);
    }
  }, [enabled, isLoading, isSaving, t]);

  const handleToggle = React.useCallback(() => {
    void handleChange(!enabled);
  }, [enabled, handleChange]);

  const handleRepair = React.useCallback(async () => {
    if (isRepairing) return;
    setIsRepairing(true);
    setInstallerError(null);
    try {
      const status = await repairAgentBrowserInstaller();
      if (!status) {
        throw new Error(t('settings.openchamber.agentBrowserControl.installer.error.repairFailed'));
      }
      setInstallerStatus(status);
      if (status.ok && status.applied === true && status.restartSucceeded === true) {
        toast.success(t('settings.openchamber.agentBrowserControl.installer.toast.repaired'));
      } else {
        const failureMessage = status.issues
          ?.map((issue) => issue.message.trim())
          .find(Boolean)
          ?? t('settings.openchamber.agentBrowserControl.installer.error.repairFailed');
        setInstallerError(failureMessage);
        toast.error(failureMessage);
      }
    } catch (cause) {
      const failureMessage = cause instanceof Error
        ? cause.message
        : t('settings.openchamber.agentBrowserControl.installer.error.repairFailed');
      setInstallerError(failureMessage);
      toast.error(failureMessage);
    } finally {
      setIsRepairing(false);
    }
  }, [isRepairing, t]);

  if (!isLocalDesktop) {
    return null;
  }

  return (
    <div className="mb-8">
      <div className="mb-1 px-1">
        <h3 className="typography-ui-header font-medium text-foreground">{t('settings.openchamber.agentBrowserControl.title')}</h3>
      </div>

      <section className="space-y-4 px-2 pb-2 pt-0">
        <div
          className="group flex cursor-pointer items-start gap-2 py-1.5"
          role="button"
          tabIndex={0}
          onClick={handleToggle}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              handleToggle();
            }
          }}
        >
          <span onClick={(event) => event.stopPropagation()}>
            <Checkbox
              checked={enabled}
              onChange={handleChange}
              ariaLabel={t('settings.openchamber.agentBrowserControl.field.enabledAria')}
              disabled={isLoading || isSaving}
            />
          </span>
          <div className="min-w-0 flex-1">
            <div className="typography-ui-label text-foreground">{t('settings.openchamber.agentBrowserControl.field.enabled')}</div>
            <div className="typography-micro text-muted-foreground/70">
              {t('settings.openchamber.agentBrowserControl.field.description')}
            </div>
          </div>
        </div>

        {error ? (
          <div className="px-2 typography-micro text-[var(--status-error)]">{error}</div>
        ) : null}

        <div className="border-t border-border/60 pt-4">
          <div className="grid gap-x-5 gap-y-3 sm:grid-cols-2">
            <div>
              <div className="typography-meta text-muted-foreground">
                {t('settings.openchamber.agentBrowserControl.installer.expectedVersion')}
              </div>
              <div className="font-mono typography-meta text-foreground">
                {isInstallerLoading ? '—' : installerStatus?.expectedVersion || '—'}
              </div>
            </div>
            <div>
              <div className="typography-meta text-muted-foreground">
                {t('settings.openchamber.agentBrowserControl.installer.installedVersion')}
              </div>
              <div className="font-mono typography-meta text-foreground">
                {isInstallerLoading
                  ? '—'
                  : installerStatus?.installedVersion || t('settings.openchamber.agentBrowserControl.installer.missing')}
              </div>
            </div>
            <div>
              <div className="typography-meta text-muted-foreground">
                {t('settings.openchamber.agentBrowserControl.installer.activeLeases')}
              </div>
              <div className="typography-ui-label text-foreground">{activeLeaseCount}</div>
            </div>
            <div>
              <div className="typography-meta text-muted-foreground">
                {t('settings.openchamber.agentBrowserControl.installer.status')}
              </div>
              <div className="typography-ui-label text-foreground">
                {isInstallerLoading
                  ? t('settings.openchamber.agentBrowserControl.installer.loading')
                  : installerStatus?.state === 'pending'
                    ? t('settings.openchamber.agentBrowserControl.installer.preparing')
                    : installerStatus?.state === 'external-runtime'
                      ? t('settings.openchamber.agentBrowserControl.installer.external')
                      : installerStatus?.ok && installerStatus?.state !== 'restart-failed'
                        ? t('settings.openchamber.agentBrowserControl.installer.ready')
                        : t('settings.openchamber.agentBrowserControl.installer.needsRepair')}
              </div>
            </div>
          </div>

          {installerError || (installerStatus?.issues?.length ?? 0) > 0 || skillWarnings.length > 0 ? (
            <div className="mt-3 rounded-md border border-[color-mix(in_srgb,var(--status-warning)_35%,var(--border))] bg-[color-mix(in_srgb,var(--status-warning)_8%,var(--background))] p-3 text-[var(--status-warning)]">
              {installerError ? <div className="typography-meta">{installerError}</div> : null}
              {installerStatus?.issues?.map((issue, index) => (
                issue.message === installerError
                  ? null
                  : <div key={`${issue.code}:${index}`} className="typography-meta">{issue.message}</div>
              ))}
              {skillWarnings.map((message, index) => (
                <div key={`skill:${index}`} className="typography-meta">{message}</div>
              ))}
            </div>
          ) : null}

          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-3"
            onClick={() => { void handleRepair(); }}
            disabled={
              isInstallerLoading
              || isRepairing
              || installerStatus?.state === 'pending'
              || installerStatus?.state === 'external-runtime'
            }
          >
            {isRepairing
              ? <RiLoader4Line className="h-4 w-4 animate-spin" />
              : <RiRefreshLine className="h-4 w-4" />}
            {isRepairing
              ? t('settings.openchamber.agentBrowserControl.installer.repairing')
              : t('settings.openchamber.agentBrowserControl.installer.repair')}
          </Button>
        </div>
      </section>
    </div>
  );
};
