import * as React from 'react';

import { Checkbox } from '@/components/ui/checkbox';
import { toast } from '@/components/ui';
import { isDesktopLocalOriginActive, isDesktopShell, setDesktopKeepAwake } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { saveDesktopSettingsNow } from '@/lib/persistence';

export const DesktopKeepAwakeSettings: React.FC = () => {
  const { t } = useI18n();
  const isLocalDesktop = isDesktopShell() && isDesktopLocalOriginActive();
  const [enabled, setEnabled] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(true);
  const [isSaving, setIsSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

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
          throw new Error(t('settings.openchamber.desktopKeepAwake.error.loadFailed'));
        }

        const data = (await response.json().catch(() => null)) as null | { desktopKeepAwakeEnabled?: unknown };
        if (cancelled) return;
        setEnabled(data?.desktopKeepAwakeEnabled === true);
        setError(null);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : t('settings.openchamber.desktopKeepAwake.error.loadFailed'));
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

  const handleChange = React.useCallback(async (nextEnabled: boolean) => {
    if (isLoading || isSaving) return;

    const previous = enabled;
    setEnabled(nextEnabled);
    setIsSaving(true);
    setError(null);

    try {
      const updated = await saveDesktopSettingsNow({ desktopKeepAwakeEnabled: nextEnabled });
      if (!updated) {
        throw new Error(t('settings.openchamber.desktopKeepAwake.error.saveFailed'));
      }

      const persisted = updated.desktopKeepAwakeEnabled === true;
      setEnabled(persisted);

      try {
        const result = await setDesktopKeepAwake(persisted);
        if (!result || result.enabled !== persisted || result.active !== persisted) {
          throw new Error(t('settings.openchamber.desktopKeepAwake.toast.applyFailed'));
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : t('settings.openchamber.desktopKeepAwake.toast.applyFailed');
        toast.warning(t('settings.openchamber.desktopKeepAwake.toast.applyFailed'), {
          description: message,
        });
      }
    } catch (cause) {
      setEnabled(previous);
      setError(cause instanceof Error ? cause.message : t('settings.openchamber.desktopKeepAwake.error.saveFailed'));
    } finally {
      setIsSaving(false);
    }
  }, [enabled, isLoading, isSaving, t]);

  const handleToggle = React.useCallback(() => {
    void handleChange(!enabled);
  }, [enabled, handleChange]);

  if (!isLocalDesktop) {
    return null;
  }

  return (
    <div className="mb-8">
      <div className="mb-1 px-1">
        <h3 className="typography-ui-header font-medium text-foreground">{t('settings.openchamber.desktopKeepAwake.title')}</h3>
      </div>

      <section className="space-y-2 px-2 pb-2 pt-0">
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
              ariaLabel={t('settings.openchamber.desktopKeepAwake.field.enabledAria')}
              disabled={isLoading || isSaving}
            />
          </span>
          <div className="min-w-0 flex-1">
            <div className="typography-ui-label text-foreground">{t('settings.openchamber.desktopKeepAwake.field.enabled')}</div>
            <div className="typography-micro text-muted-foreground/70">
              {t('settings.openchamber.desktopKeepAwake.field.description')}
            </div>
          </div>
        </div>

        {error ? (
          <div className="px-2 typography-micro text-[var(--status-error)]">{error}</div>
        ) : null}
      </section>
    </div>
  );
};
