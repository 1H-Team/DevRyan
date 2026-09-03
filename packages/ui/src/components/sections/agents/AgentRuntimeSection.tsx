import React from 'react';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { useAgentsStore, type AgentRuntimeSettingsInput } from '@/stores/useAgentsStore';

type AgentRuntimeSectionProps = {
  /** Host admins edit; everyone else who can reach the page reads the effective values. */
  canEdit: boolean;
};

/**
 * Switches for the managed agent runtime (today: OpenCode's language servers).
 * OpenCode reads them when its instance starts, so a changed value shows a
 * restart note and, where the host can restart the runtime, a button for it.
 * Renders nothing until the settings load, and stays hidden on hosts without the route.
 */
export const AgentRuntimeSection: React.FC<AgentRuntimeSectionProps> = ({ canEdit }) => {
  const { t } = useI18n();
  const apis = useRuntimeAPIs();
  // Web and VS Code hosts expose this (it posts the manual configuration
  // reload, which restarts OpenCode once active chats finish); others may not.
  const restartOpenCode = apis.settings.restartOpenCode;
  const settings = useAgentsStore((state) => state.agentRuntimeSettings);
  const getAgentRuntimeSettings = useAgentsStore((state) => state.getAgentRuntimeSettings);
  const saveAgentRuntimeSettings = useAgentsStore((state) => state.saveAgentRuntimeSettings);
  const markAgentRuntimeRestarted = useAgentsStore((state) => state.markAgentRuntimeRestarted);
  const [isRestarting, setIsRestarting] = React.useState(false);

  // The store applies the change optimistically; a rejected save reverts it and we toast.
  const save = React.useCallback((input: AgentRuntimeSettingsInput) => (
    saveAgentRuntimeSettings(input).catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : t('settings.agents.runtime.toast.saveFailed'));
    })
  ), [saveAgentRuntimeSettings, t]);

  React.useEffect(() => {
    let cancelled = false;
    getAgentRuntimeSettings().catch((error: unknown) => {
      if (cancelled) return;
      toast.error(error instanceof Error ? error.message : t('settings.agents.runtime.toast.loadFailed'));
    });
    return () => {
      cancelled = true;
    };
  }, [getAgentRuntimeSettings, t]);

  const handleRestart = React.useCallback(async () => {
    if (!restartOpenCode) return;
    setIsRestarting(true);
    try {
      await restartOpenCode();
      markAgentRuntimeRestarted();
      toast.success(t('settings.agents.runtime.toast.restartRequested'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settings.agents.runtime.toast.restartFailed'));
    } finally {
      setIsRestarting(false);
    }
  }, [markAgentRuntimeRestarted, restartOpenCode, t]);

  if (!settings) return null;

  return (
    <div>
      <div className="mb-1 px-1">
        <h3 className="typography-ui-header font-medium text-foreground">
          {t('settings.agents.runtime.title')}
        </h3>
      </div>

      <section className="px-2 pb-2 pt-0 space-y-0">
        <div className="flex items-start justify-between gap-4 py-1.5">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="typography-ui-label text-foreground">{t('settings.agents.runtime.lsp.label')}</span>
            <span className="typography-meta text-muted-foreground">{t('settings.agents.runtime.lsp.description')}</span>
          </div>
          <div className="shrink-0 pt-0.5">
            {canEdit ? (
              <Switch
                checked={settings.lsp}
                onCheckedChange={(checked) => { void save({ lsp: checked }); }}
                aria-label={t('settings.agents.runtime.lsp.label')}
              />
            ) : (
              <span className="typography-ui-label text-muted-foreground">
                {settings.lsp
                  ? t('settings.agents.runtime.readOnly.on')
                  : t('settings.agents.runtime.readOnly.off')}
              </span>
            )}
          </div>
        </div>

        {settings.restartRequired ? (
          <div className="flex items-center justify-between gap-4 pt-1" role="status">
            <p className="typography-meta text-muted-foreground">
              {t('settings.agents.runtime.restart.note')}
            </p>
            {canEdit && restartOpenCode ? (
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="shrink-0"
                onClick={() => { void handleRestart(); }}
                disabled={isRestarting}
              >
                {t('settings.agents.runtime.actions.restart')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
};
