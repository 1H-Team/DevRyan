import React from 'react';
import { AgentSelector } from '@/components/sections/commands/AgentSelector';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { updateDesktopSettings } from '@/lib/persistence';
import { useConfigStore } from '@/stores/useConfigStore';
import { useAgentsStore } from '@/stores/useAgentsStore';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useI18n } from '@/lib/i18n';
import { formatAgentDisplayName } from '@/lib/agentDisplay';
import { getAuthPrincipal } from '@/lib/authSession';
import {
  isHiddenBuiltinAgentOption,
  isSelectablePrimaryAgentOption,
  resolveDefaultAgentName,
  resolveSelectableAgentOptions,
} from '@/lib/agentSelection';

export const DefaultsSettings: React.FC = () => {
  const { t } = useI18n();
  const setAgent = useConfigStore((state) => state.setAgent);
  const settingsDefaultAgent = useConfigStore((state) => state.settingsDefaultAgent);
  const settingsDefaultPlanMode = useConfigStore((state) => state.settingsDefaultPlanMode);
  const setSettingsDefaultAgent = useConfigStore((state) => state.setSettingsDefaultAgent);
  const setSettingsDefaultPlanMode = useConfigStore((state) => state.setSettingsDefaultPlanMode);
  const setSettingsDefaultFileViewerPreview = useConfigStore((state) => state.setSettingsDefaultFileViewerPreview);
  const settingsDefaultFileViewerPreview = useConfigStore((state) => state.settingsDefaultFileViewerPreview);
  const settingsOverrideKeys = useConfigStore((state) => state.settingsOverrideKeys);
  const resetPersonalSettingsOverride = useConfigStore((state) => state.resetPersonalSettingsOverride);
  const configAgents = useConfigStore((state) => state.agents);
  const agentsStoreAgents = useAgentsStore((state) => state.agents);

  const [defaultAgent, setDefaultAgent] = React.useState<string | undefined>();
  const [isLoading, setIsLoading] = React.useState(true);
  const principal = getAuthPrincipal();
  const isManagedPersonal = principal.scope === 'managed' && principal.role !== 'admin';
  const defaultAgentIsPersonal = settingsOverrideKeys.includes('defaultAgent');
  const defaultPlanModeIsPersonal = settingsOverrideKeys.includes('defaultPlanMode');
  const selectableDefaultAgents = React.useMemo(
    () => resolveSelectableAgentOptions(configAgents, agentsStoreAgents),
    [agentsStoreAgents, configAgents]
  );
  const savedDefaultAgent = defaultAgent ?? settingsDefaultAgent;
  const resolvedDefaultAgent = React.useMemo(() => {
    if (savedDefaultAgent && selectableDefaultAgents.length === 0 && !isHiddenBuiltinAgentOption(savedDefaultAgent)) {
      return savedDefaultAgent;
    }
    return resolveDefaultAgentName(savedDefaultAgent, selectableDefaultAgents);
  }, [savedDefaultAgent, selectableDefaultAgents]);

  React.useEffect(() => {
    const loadSettings = async () => {
      try {
        let data: {
          defaultAgent?: string;
          defaultPlanMode?: boolean;
        } | null = null;

        if (!data) {
          const runtimeSettings = getRegisteredRuntimeAPIs()?.settings;
          if (runtimeSettings) {
            try {
              const result = await runtimeSettings.load();
              const settings = result?.settings;
              if (settings) {
                data = {
                  defaultAgent: typeof settings.defaultAgent === 'string' ? settings.defaultAgent : undefined,
                  defaultPlanMode: typeof settings.defaultPlanMode === 'boolean' ? settings.defaultPlanMode : undefined,
                };
              }
            } catch {
              // fall through
            }
          }
        }

        if (!data) {
          const response = await fetch('/api/config/settings', {
            method: 'GET',
            headers: { Accept: 'application/json' },
          });
          if (response.ok) {
            data = await response.json();
          }
        }

        if (data) {
          const agent =
            typeof data.defaultAgent === 'string' && data.defaultAgent.trim().length > 0
              ? data.defaultAgent.trim()
              : undefined;

          if (agent !== undefined) setDefaultAgent(agent);
          setSettingsDefaultPlanMode(data.defaultPlanMode ?? false);
        }
      } catch (error) {
        console.warn('Failed to load defaults settings:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadSettings();
  }, [setSettingsDefaultPlanMode]);

  const handleAgentChange = React.useCallback(
    async (agentName: string) => {
      const newValue = agentName || undefined;
      setDefaultAgent(newValue);
      setSettingsDefaultAgent(newValue);

      if (agentName) {
        setAgent(agentName, { agents: selectableDefaultAgents });
      }

      try {
        await updateDesktopSettings({ defaultAgent: newValue ?? '' });
        if (isManagedPersonal) {
          useConfigStore.setState((state) => ({
            settingsOverrideKeys: [...new Set([...state.settingsOverrideKeys, 'defaultAgent'])].sort(),
          }));
        }
      } catch (error) {
        console.warn('Failed to save default agent:', error);
      }
    },
    [isManagedPersonal, selectableDefaultAgents, setAgent, setSettingsDefaultAgent]
  );

  const handlePlanModeChange = React.useCallback((next: boolean) => {
    setSettingsDefaultPlanMode(next);
    updateDesktopSettings({ defaultPlanMode: next }).then(() => {
      if (isManagedPersonal) {
        useConfigStore.setState((state) => ({
          settingsOverrideKeys: [...new Set([...state.settingsOverrideKeys, 'defaultPlanMode'])].sort(),
        }));
      }
    }).catch(console.warn);
  }, [isManagedPersonal, setSettingsDefaultPlanMode]);

  const handleResetDefaultAgent = React.useCallback(async () => {
    try {
      await resetPersonalSettingsOverride('defaultAgent');
      const inheritedAgent = useConfigStore.getState().settingsDefaultAgent;
      setDefaultAgent(inheritedAgent);
      if (inheritedAgent) setAgent(inheritedAgent, { agents: selectableDefaultAgents });
      toast.success('Default agent now follows the host setting');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to reset the default agent');
    }
  }, [resetPersonalSettingsOverride, selectableDefaultAgents, setAgent]);

  const handleResetDefaultPlanMode = React.useCallback(async () => {
    try {
      await resetPersonalSettingsOverride('defaultPlanMode');
      toast.success('Plan mode now follows the host setting');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to reset plan mode');
    }
  }, [resetPersonalSettingsOverride]);

  const handleTogglePlanMode = React.useCallback(() => {
    handlePlanModeChange(!settingsDefaultPlanMode);
  }, [handlePlanModeChange, settingsDefaultPlanMode]);

  const handleFileViewerPreviewChange = React.useCallback((next: boolean) => {
    setSettingsDefaultFileViewerPreview(next);
    updateDesktopSettings({ defaultFileViewerPreview: next }).catch(console.warn);
  }, [setSettingsDefaultFileViewerPreview]);

  const handleToggleFileViewerPreview = React.useCallback(() => {
    handleFileViewerPreviewChange(!settingsDefaultFileViewerPreview);
  }, [handleFileViewerPreviewChange, settingsDefaultFileViewerPreview]);

  if (isLoading) {
    return null;
  }

  return (
    <div className="mb-6">
      <div className="mb-0.5 px-1">
        <div className="flex items-center gap-2">
          <h3 className="typography-ui-header font-medium text-foreground">{t('settings.openchamber.defaults.title')}</h3>
        </div>
      </div>

      <section className="px-2 pb-2 pt-0 space-y-0">
        <div className="mt-0 mb-1 typography-meta text-muted-foreground">
          {t('settings.openchamber.defaults.summaryPrefix')}
          {' '}
          <span className="text-foreground">{resolvedDefaultAgent ? formatAgentDisplayName(resolvedDefaultAgent) : t('settings.commands.agentSelector.notSelected')}</span>
        </div>

        <div className="flex flex-col gap-2 py-1 sm:flex-row sm:items-center sm:gap-8">
          <div className="flex min-w-0 flex-col sm:w-56 shrink-0">
            <span className="typography-ui-label text-foreground">{t('settings.openchamber.defaults.field.defaultAgent')}</span>
          </div>
          <div className="flex min-w-0 flex-1 items-center gap-2 sm:w-fit sm:flex-initial">
            <AgentSelector agentName={resolvedDefaultAgent} onChange={handleAgentChange} filter={isSelectablePrimaryAgentOption} />
            {isManagedPersonal ? (
              <>
                <span className="typography-micro text-muted-foreground">
                  {defaultAgentIsPersonal ? 'Personal' : 'Inherited'}
                </span>
                <Button size="xs" variant="outline" onClick={handleResetDefaultAgent} disabled={!defaultAgentIsPersonal}>
                  Reset
                </Button>
              </>
            ) : null}
          </div>
        </div>

        <div className="flex items-center gap-2 py-1">
          <div
            className="group flex min-w-0 cursor-pointer items-center gap-2"
            role="button"
            tabIndex={0}
            aria-pressed={settingsDefaultPlanMode}
            onClick={handleTogglePlanMode}
            onKeyDown={(event) => {
              if (event.key === ' ' || event.key === 'Enter') {
                event.preventDefault();
                handleTogglePlanMode();
              }
            }}
          >
            <Checkbox checked={settingsDefaultPlanMode} onChange={handlePlanModeChange} ariaLabel={t('settings.openchamber.defaults.field.defaultPlanModeAria')} />
            <span className="typography-ui-label text-foreground">{t('settings.openchamber.defaults.field.defaultPlanMode')}</span>
          </div>
          {isManagedPersonal ? (
            <>
              <span className="typography-micro text-muted-foreground">
                {defaultPlanModeIsPersonal ? 'Personal' : 'Inherited'}
              </span>
              <Button
                size="xs"
                variant="outline"
                onClick={() => void handleResetDefaultPlanMode()}
                disabled={!defaultPlanModeIsPersonal}
              >
                Reset
              </Button>
            </>
          ) : null}
        </div>

        <div
          className="group flex cursor-pointer items-center gap-2 py-1"
          role="button"
          tabIndex={0}
          aria-pressed={settingsDefaultFileViewerPreview}
          onClick={handleToggleFileViewerPreview}
          onKeyDown={(event) => {
            if (event.key === ' ' || event.key === 'Enter') {
              event.preventDefault();
              handleToggleFileViewerPreview();
            }
          }}
        >
          <Checkbox checked={settingsDefaultFileViewerPreview} onChange={handleFileViewerPreviewChange} ariaLabel={t('settings.openchamber.defaults.field.openFilesPreviewAria')} />
          <span className="typography-ui-label text-foreground">{t('settings.openchamber.defaults.field.openFilesPreview')}</span>
        </div>

      </section>
    </div>
  );
};
