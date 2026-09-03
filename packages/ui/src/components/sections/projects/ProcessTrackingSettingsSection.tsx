import React from 'react';
import { RiLoaderLine } from '@remixicon/react';
import { toast } from '@/components/ui';
import { Switch } from '@/components/ui/switch';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';

// Opt-in per project: agent shell commands carry a session marker so the
// Processes tab can group them and session delete can stop matched dev servers.
export const ProcessTrackingSettingsSection: React.FC<{ directory: string }> = ({ directory }) => {
  const { t } = useI18n();
  const { processes } = useRuntimeAPIs();
  const [enabled, setEnabled] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    if (!processes) {
      setLoading(false);
      return;
    }
    void processes.getProjectSetting(directory)
      .then((setting) => {
        if (!cancelled) setEnabled(setting.trackAgentProcesses);
      })
      .catch((error) => {
        if (!cancelled) {
          toast.error(t('settings.projects.processes.loadFailed'), {
            description: error instanceof Error ? error.message : undefined,
          });
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [directory, processes, t]);

  const changeEnabled = React.useCallback(async (next: boolean) => {
    if (!processes || saving) return;
    const previous = enabled;
    setEnabled(next);
    setSaving(true);
    try {
      const result = await processes.setProjectSetting(directory, { trackAgentProcesses: next });
      setEnabled(result.trackAgentProcesses);
    } catch (error) {
      setEnabled(previous);
      toast.error(t('settings.projects.processes.saveFailed'), {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  }, [directory, enabled, processes, saving, t]);

  if (!processes) return null;

  return (
    <div className="mb-8">
      <div className="mb-1 px-1">
        <h3 className="typography-ui-header font-medium text-foreground">
          {t('settings.projects.processes.title')}
        </h3>
      </div>
      <section className="rounded-lg border border-border/50 bg-[var(--surface-elevated)]/45 px-3 py-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="typography-ui-label text-foreground">
              {t('settings.projects.processes.toggle')}
            </div>
            <p className="mt-1 max-w-2xl typography-meta text-muted-foreground">
              {t('settings.projects.processes.description')}
            </p>
            <p className="mt-1 typography-micro text-muted-foreground/80">
              {t('settings.projects.processes.note')}
            </p>
          </div>
          {loading ? (
            <RiLoaderLine className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
          ) : (
            <Switch
              checked={enabled}
              onCheckedChange={(checked) => { void changeEnabled(checked); }}
              disabled={saving}
              aria-label={t('settings.projects.processes.toggle')}
            />
          )}
        </div>
      </section>
    </div>
  );
};
