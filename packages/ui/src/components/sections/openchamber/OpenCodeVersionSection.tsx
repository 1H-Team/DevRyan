import * as React from 'react';
import { RiRefreshLine } from '@remixicon/react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { parseBundledRuntimeVersion, type BundledRuntimeVersion } from './openCodeVersionState';

export const OpenCodeVersionSection: React.FC<{ compact?: boolean }> = ({ compact = false }) => {
  const { t } = useI18n();
  const [runtime, setRuntime] = React.useState<BundledRuntimeVersion | null>(null);
  const [checking, setChecking] = React.useState(false);
  const [error, setError] = React.useState(false);
  const current = React.useRef<AbortController | null>(null);
  const refresh = React.useCallback(async () => {
    current.current?.abort();
    const controller = new AbortController(); current.current = controller;
    setChecking(true); setError(false);
    try {
      const response = await fetch('/api/config/opencode-resolution', { headers: { Accept: 'application/json' }, signal: controller.signal });
      const value = response.ok ? parseBundledRuntimeVersion(await response.json()) : null;
      if (controller.signal.aborted) return;
      setRuntime(value); setError(!value);
    } catch { if (!controller.signal.aborted) { setRuntime(null); setError(true); } }
    finally { if (!controller.signal.aborted) setChecking(false); }
  }, []);
  React.useEffect(() => { void refresh(); return () => current.current?.abort(); }, [refresh]);
  return (
    <section className={cn('border-t border-[var(--surface-subtle)]', compact ? 'mt-3 pt-3' : 'px-4 py-4')} aria-labelledby="about-opencode-version-title">
      <div className="flex items-center justify-between gap-3">
        <h4 id="about-opencode-version-title" className={compact ? 'typography-meta font-medium' : 'typography-ui-label'}>{t('settings.openchamber.about.opencode.title')}</h4>
        <Button type="button" variant="outline" size="xs" disabled={checking} onClick={() => { void refresh(); }}>
          <RiRefreshLine className={cn('mr-1 h-3.5 w-3.5', checking && 'animate-spin')} aria-hidden="true" />{t('settings.openchamber.about.opencode.actions.retry')}
        </Button>
      </div>
      <p className="mt-2 font-mono typography-meta">{runtime?.version ?? t('settings.openchamber.about.opencode.state.unknown')}</p>
      <p className="mt-1 typography-micro text-muted-foreground" role="status">{error ? t('settings.openchamber.about.opencode.error.loadFailed') : runtime?.ready ? t('settings.openchamber.about.opencode.state.ready') : t('settings.openchamber.about.opencode.state.unavailable')}</p>
      <p className="mt-1 typography-micro text-muted-foreground">{t('settings.openchamber.about.opencode.bundledUpdates')}</p>
    </section>
  );
};
