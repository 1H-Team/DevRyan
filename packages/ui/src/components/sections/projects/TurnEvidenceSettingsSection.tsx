import React from 'react';
import { RiDeleteBinLine, RiLoaderLine } from '@remixicon/react';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';

export const TurnEvidenceSettingsSection: React.FC<{ directory: string }> = ({ directory }) => {
  const { t } = useI18n();
  const { evidence } = useRuntimeAPIs();
  const [enabled, setEnabled] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [clearOpen, setClearOpen] = React.useState(false);
  const [clearing, setClearing] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    if (!evidence) {
      setLoading(false);
      return;
    }
    void evidence.getProjectSetting(directory)
      .then((setting) => {
        if (!cancelled) setEnabled(setting.enabled);
      })
      .catch((error) => {
        if (!cancelled) {
          toast.error(t('settings.projects.evidence.loadFailed'), {
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
  }, [directory, evidence, t]);

  const changeEnabled = React.useCallback(async (next: boolean) => {
    if (!evidence || saving) return;
    const previous = enabled;
    setEnabled(next);
    setSaving(true);
    try {
      const result = await evidence.setProjectSetting(directory, next);
      setEnabled(result.enabled);
    } catch (error) {
      setEnabled(previous);
      toast.error(t('settings.projects.evidence.saveFailed'), {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  }, [directory, enabled, evidence, saving, t]);

  const clearEvidence = React.useCallback(async () => {
    if (!evidence || clearing) return;
    setClearing(true);
    try {
      const result = await evidence.clearProject(directory);
      toast.success(t('settings.projects.evidence.cleared', { count: result.removed }));
      setClearOpen(false);
    } catch (error) {
      toast.error(t('settings.projects.evidence.clearFailed'), {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setClearing(false);
    }
  }, [clearing, directory, evidence, t]);

  if (!evidence) return null;

  return (
    <>
      <div className="mb-8">
        <div className="mb-1 px-1">
          <h3 className="typography-ui-header font-medium text-foreground">
            {t('settings.projects.evidence.title')}
          </h3>
        </div>
        <section className="rounded-lg border border-border/50 bg-[var(--surface-elevated)]/45 px-3 py-3">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="typography-ui-label text-foreground">
                {t('settings.projects.evidence.toggle')}
              </div>
              <p className="mt-1 max-w-2xl typography-meta text-muted-foreground">
                {t('settings.projects.evidence.description')}
              </p>
              <p className="mt-1 typography-micro text-muted-foreground/80">
                {t('settings.projects.evidence.cursorNote')}
              </p>
            </div>
            {loading ? (
              <RiLoaderLine className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
            ) : (
              <Switch
                checked={enabled}
                onCheckedChange={(checked) => { void changeEnabled(checked); }}
                disabled={saving}
                aria-label={t('settings.projects.evidence.toggle')}
              />
            )}
          </div>
          <div className="mt-3 border-t border-border/40 pt-3">
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => setClearOpen(true)}
            >
              <RiDeleteBinLine className="mr-1 h-3.5 w-3.5" />
              {t('settings.projects.evidence.clear')}
            </Button>
          </div>
        </section>
      </div>

      <Dialog open={clearOpen} onOpenChange={setClearOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.projects.evidence.clearDialog.title')}</DialogTitle>
            <DialogDescription>
              {t('settings.projects.evidence.clearDialog.description')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setClearOpen(false)} disabled={clearing}>
              {t('settings.common.actions.cancel')}
            </Button>
            <Button variant="destructive" onClick={() => { void clearEvidence(); }} disabled={clearing}>
              {clearing ? t('settings.projects.evidence.clearing') : t('settings.projects.evidence.clear')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
