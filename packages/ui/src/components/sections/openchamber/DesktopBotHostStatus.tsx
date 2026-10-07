import React from 'react';
import { Button } from '@/components/ui/button';
import { resolveBotRuntimeMessageKey } from '@/components/bots/botPresentation';
import { botsApi, type BotCapabilities } from '@/lib/botsApi';
import { botsDesktopApi, type RuntimeServiceStatus } from '@/lib/botsDesktopApi';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';

export const DesktopBotHostStatus: React.FC = () => {
  const { t } = useI18n();
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const [mode, setMode] = React.useState<RuntimeServiceStatus['configuredMode'] | null>(null);
  const [capabilities, setCapabilities] = React.useState<BotCapabilities | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [revision, setRevision] = React.useState(0);
  const local = botsDesktopApi.isAvailable();

  React.useEffect(() => {
    if (!local) return;
    let cancelled = false;
    setLoading(true);
    void Promise.allSettled([
      botsDesktopApi.runtimeServiceStatus?.(),
      botsApi.getCapabilities(),
    ]).then(([service, runtime]) => {
      if (cancelled) return;
      setMode(service.status === 'fulfilled' ? service.value?.configuredMode ?? null : null);
      setCapabilities(runtime.status === 'fulfilled' ? runtime.value : null);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [local, revision]);

  if (!local) return null;
  const runtimeMessage = capabilities?.available ? null
    : resolveBotRuntimeMessageKey(capabilities?.state ?? 'unavailable', capabilities?.code);
  return (
    <section className="mb-8 px-2" aria-labelledby="desktop-bot-host-heading">
      <h3 id="desktop-bot-host-heading" className="typography-ui-header font-medium">
        {t('settings.openchamber.botHost.title')}
      </h3>
      <p className="typography-ui-label mt-2" role="status">
        {loading ? t('settings.openchamber.botHost.checking')
          : mode === 'service' ? t('settings.openchamber.botHost.service')
            : mode === 'app_bound' ? t('settings.openchamber.botHost.appBound')
              : mode === 'disabled' ? t('settings.openchamber.botHost.disabled')
                : t('settings.openchamber.botHost.unavailable')}
      </p>
      {!loading && mode !== 'disabled' && (
        <p className="typography-micro text-muted-foreground">
          {runtimeMessage ? t(runtimeMessage) : t('settings.openchamber.botHost.ready')}
        </p>
      )}
      <div className="mt-2 flex gap-2">
        <Button size="xs" variant="outline" onClick={() => setSettingsPage('bots')}>
          {t('settings.openchamber.botHost.settings')}
        </Button>
        <Button size="xs" variant="ghost" disabled={loading} onClick={() => setRevision((value) => value + 1)}>
          {t('settings.openchamber.botHost.refresh')}
        </Button>
      </div>
    </section>
  );
};
