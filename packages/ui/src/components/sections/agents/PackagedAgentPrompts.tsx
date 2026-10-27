import React from 'react';
import { Button } from '@/components/ui/button';
import { getPackagedAgentPrompts, restorePackagedAgentPrompt, type PackagedAgentPrompt } from '@/lib/api/packaged-agent-prompts';
import { useI18n } from '@/lib/i18n';

export const PackagedAgentPrompts: React.FC = () => {
  const { t } = useI18n();
  const [prompts, setPrompts] = React.useState<PackagedAgentPrompt[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [restoring, setRestoring] = React.useState<string | null>(null);
  const lifetime = React.useRef<AbortController | null>(null);
  const refresh = React.useCallback(async (signal: AbortSignal) => {
    try { const next = await getPackagedAgentPrompts(signal); if (!signal.aborted) { setPrompts(next); setError(null); } }
    catch (failure) { if (!signal.aborted) setError(failure instanceof Error ? failure.message : t('settings.agents.prompts.loadFailed')); }
  }, [t]);
  React.useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    void refresh(controller.signal);
    return () => { controller.abort(); lifetime.current = null; };
  }, [refresh]);
  const restore = async (prompt: PackagedAgentPrompt) => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || restoring) return;
    setRestoring(prompt.name);
    setNotice(null);
    try {
      const warning = await restorePackagedAgentPrompt(prompt, signal);
      if (!signal.aborted) setNotice(warning ?? t('settings.agents.prompts.restored'));
    } catch (failure) {
      if (!signal.aborted) setNotice(failure instanceof Error ? failure.message : t('settings.agents.prompts.restoreFailed'));
    } finally {
      await refresh(signal);
      if (!signal.aborted) setRestoring(null);
    }
  };
  const conflicts = prompts.filter((prompt) => prompt.state === 'modified');
  if (conflicts.length === 0 && !error && !notice) return null;
  return (
    <section className="space-y-2 px-2 py-2" aria-label={t('settings.agents.prompts.title')}>
      <h3 className="typography-ui-header font-medium text-foreground">{t('settings.agents.prompts.title')}</h3>
      {conflicts.length > 0 ? <p className="typography-meta text-muted-foreground">{t('settings.agents.prompts.conflict')}</p> : null}
      {conflicts.map((prompt) => (
        <div key={prompt.name} className="flex items-center justify-between gap-4">
          <span className="typography-ui-label text-foreground">{prompt.name}</span>
          <Button type="button" variant="outline" size="xs" disabled={restoring !== null} onClick={() => { void restore(prompt); }}>
            {t(restoring === prompt.name ? 'settings.agents.prompts.restoring' : 'settings.agents.prompts.restore')}
          </Button>
        </div>
      ))}
      {error ? <p role="alert" className="typography-meta text-muted-foreground">{error}</p> : null}
      {notice ? <p role="status" className="typography-meta text-muted-foreground">{notice}</p> : null}
    </section>
  );
};
