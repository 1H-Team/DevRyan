import * as React from 'react';
import { RiLoaderLine, RiRefreshLine } from '@remixicon/react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { resolveOpenCodeVersionViewStatus } from './openCodeVersionState';

type SupportStatus = 'supported' | 'older' | 'newer' | 'unknown';

type OpenCodeVersionState = {
  currentVersion: string | null;
  latestVersion: string | null;
  supportedVersion: string | null;
  updateAvailable: boolean | null;
  supportStatus: SupportStatus;
  checked: boolean;
  checking: boolean;
  error: string | null;
};

type OpenCodeUpdateResponse = {
  currentVersion: string | null;
  latestVersion: string;
  supportedVersion: string;
  updateAvailable: boolean | null;
  supportStatus: SupportStatus;
};

const SUPPORT_STATUSES = new Set<SupportStatus>(['supported', 'older', 'newer', 'unknown']);

const initialState: OpenCodeVersionState = {
  currentVersion: null,
  latestVersion: null,
  supportedVersion: null,
  updateAvailable: null,
  supportStatus: 'unknown',
  checked: false,
  checking: false,
  error: null,
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const versionOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const parseUpdateResponse = (value: unknown): OpenCodeUpdateResponse | null => {
  const data = asRecord(value);
  const latestVersion = versionOrNull(data?.latestVersion);
  const supportedVersion = versionOrNull(data?.supportedVersion);
  const supportStatus = data?.supportStatus;
  const updateAvailable = data?.updateAvailable;

  if (
    !data
    || !latestVersion
    || !supportedVersion
    || typeof supportStatus !== 'string'
    || !SUPPORT_STATUSES.has(supportStatus as SupportStatus)
    || (typeof updateAvailable !== 'boolean' && updateAvailable !== null)
  ) {
    return null;
  }

  return {
    currentVersion: versionOrNull(data.currentVersion),
    latestVersion,
    supportedVersion,
    updateAvailable,
    supportStatus: supportStatus as SupportStatus,
  };
};

const VersionDatum: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="min-w-0">
    <dt className="typography-micro text-muted-foreground">{label}</dt>
    <dd className="mt-0.5 truncate font-mono typography-meta text-foreground" title={value}>
      {value}
    </dd>
  </div>
);

export const OpenCodeVersionSection: React.FC<{ compact?: boolean }> = ({ compact = false }) => {
  const { t } = useI18n();
  const [state, setState] = React.useState<OpenCodeVersionState>(initialState);

  React.useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch('/api/config/opencode-resolution', {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error('resolution_failed');
        }
        const data = asRecord(await response.json().catch(() => null));
        if (!data) {
          throw new Error('resolution_failed');
        }

        setState((current) => ({
          ...current,
          currentVersion: versionOrNull(data.detectedVersion),
          supportedVersion: versionOrNull(data.targetVersion),
          error: null,
        }));
      } catch {
        if (controller.signal.aborted) return;
        setState((current) => ({
          ...current,
          error: t('settings.openchamber.about.opencode.error.loadFailed'),
        }));
      }
    })();

    return () => controller.abort();
  }, [t]);

  const checkForUpdates = React.useCallback(async () => {
    if (state.checking) return;
    setState((current) => ({ ...current, checking: true, error: null }));

    try {
      const response = await fetch('/api/opencode/update-check', {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      const raw = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error('update_check_failed');
      }
      const updateInfo = parseUpdateResponse(raw);
      if (!updateInfo) {
        throw new Error('invalid_update_response');
      }

      setState({
        ...updateInfo,
        checked: true,
        checking: false,
        error: null,
      });
    } catch {
      setState((current) => ({
        ...current,
        checked: true,
        checking: false,
        error: t('settings.openchamber.about.opencode.error.checkFailed'),
      }));
    }
  }, [state.checking, t]);

  const viewStatus = resolveOpenCodeVersionViewStatus(state);
  const statusText = (() => {
    switch (viewStatus) {
      case 'checking':
        return t('settings.openchamber.about.opencode.state.checking');
      case 'updateAvailable':
        return t('settings.openchamber.about.opencode.state.updateAvailable', {
          version: state.latestVersion || t('settings.openchamber.about.opencode.state.unknown'),
        });
      case 'upToDate':
        return t('settings.openchamber.about.opencode.state.upToDate');
      case 'newerThanLatest':
        return t('settings.openchamber.about.opencode.state.newerThanLatest');
      case 'currentUnavailable':
        return t('settings.openchamber.about.opencode.state.currentUnavailable');
      case 'error':
        return state.error || t('settings.openchamber.about.opencode.error.checkFailed');
      default:
        return t('settings.openchamber.about.opencode.state.notChecked');
    }
  })();

  const supportText = state.checked
    ? t(`settings.openchamber.about.opencode.support.${state.supportStatus}`)
    : null;
  const unknown = t('settings.openchamber.about.opencode.state.unknown');
  const notChecked = t('settings.openchamber.about.opencode.state.notChecked');

  return (
    <section
      className={cn(
        'border-t border-[var(--surface-subtle)]',
        compact ? 'mt-3 pt-3' : 'px-4 py-4',
      )}
      aria-labelledby="about-opencode-version-title"
    >
      <div
        className={cn(
          'flex gap-3',
          compact
            ? 'items-center justify-between'
            : 'flex-col items-start sm:flex-row sm:items-center sm:justify-between',
        )}
      >
        <div className="min-w-0">
          <h4
            id="about-opencode-version-title"
            className={cn('text-foreground', compact ? 'typography-meta font-medium' : 'typography-ui-label')}
          >
            {t('settings.openchamber.about.opencode.title')}
          </h4>
          {!compact && (
            <p className="mt-0.5 typography-micro text-muted-foreground">
              {t('settings.openchamber.about.opencode.description')}
            </p>
          )}
        </div>
        <Button
          type="button"
          variant="outline"
          size={compact ? 'xs' : 'sm'}
          onClick={() => { void checkForUpdates(); }}
          disabled={state.checking}
          aria-describedby="about-opencode-version-status"
          className="shrink-0 !font-normal"
        >
          {state.checking
            ? <RiLoaderLine className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            : <RiRefreshLine className="mr-1 h-3.5 w-3.5" aria-hidden="true" />}
          {state.error
            ? t('settings.openchamber.about.opencode.actions.retry')
            : t('settings.openchamber.about.opencode.actions.check')}
        </Button>
      </div>

      <dl className={cn('grid gap-3', compact ? 'mt-2 grid-cols-3' : 'mt-3 grid-cols-1 sm:grid-cols-3')}>
        <VersionDatum
          label={t('settings.openchamber.about.opencode.field.current')}
          value={state.currentVersion || unknown}
        />
        <VersionDatum
          label={t('settings.openchamber.about.opencode.field.latest')}
          value={state.latestVersion || notChecked}
        />
        <VersionDatum
          label={t('settings.openchamber.about.opencode.field.supported')}
          value={state.supportedVersion || unknown}
        />
      </dl>

      <div className="mt-2 flex flex-col gap-0.5">
        <p
          id="about-opencode-version-status"
          aria-live="polite"
          className={cn(
            'typography-micro',
            viewStatus === 'error' ? 'text-[var(--status-error)]' : 'text-muted-foreground',
          )}
        >
          {statusText}
        </p>
        {supportText && (
          <p className="typography-micro text-muted-foreground/80">{supportText}</p>
        )}
      </div>
    </section>
  );
};
