import React from 'react';
import { RiAiAgentLine, RiArrowRightSLine, RiChatHistoryLine } from '@remixicon/react';
import type { Agent } from '@opencode-ai/sdk/v2';
import { AgentSelector } from '@/components/sections/commands/AgentSelector';
import { SessionCleanupSettings } from '@/components/sections/openchamber/SessionRetentionSettings';
import {
  SettingsBadge,
  SettingsDetailHeader,
  SettingsDetailSection,
  SettingsPageLayout,
} from '@/components/sections/shared';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { resolveAgentDefaultSelection, type ResolvedAgentDefault } from '@/lib/agentDefaultResolution';
import { getAgentIconColor } from '@/lib/agentColors';
import { formatAgentDisplayName } from '@/lib/agentDisplay';
import {
  compareAgentOptions,
  isHiddenBuiltinAgentOption,
  isPrimaryAgentMode,
  isSelectablePrimaryAgentOption,
  resolveDefaultAgentName,
  resolveSelectableAgentOptions,
} from '@/lib/agentSelection';
import { canAccessSettingsPage, canEditPersonalAgentModels, useAuthPrincipal } from '@/lib/authSession';
import { useI18n } from '@/lib/i18n';
import { updateDesktopSettings } from '@/lib/persistence';
import { getModelDisplayName } from '@/lib/providers/modelIdentity';
import { filterVisibleAgentSelectorOptions, filterVisibleSettingsAgents, useAgentsStore } from '@/stores/useAgentsStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';

const NewSessionDefaults: React.FC = () => {
  const { t } = useI18n();
  const setAgent = useConfigStore((state) => state.setAgent);
  const settingsDefaultAgent = useConfigStore((state) => state.settingsDefaultAgent);
  const settingsDefaultPlanMode = useConfigStore((state) => state.settingsDefaultPlanMode);
  const setSettingsDefaultAgent = useConfigStore((state) => state.setSettingsDefaultAgent);
  const setSettingsDefaultPlanMode = useConfigStore((state) => state.setSettingsDefaultPlanMode);
  const settingsOverrideKeys = useConfigStore((state) => state.settingsOverrideKeys);
  const resetPersonalSettingsOverride = useConfigStore((state) => state.resetPersonalSettingsOverride);
  const configAgents = useConfigStore((state) => state.agents);
  const agentsStoreAgents = useAgentsStore((state) => state.agents);
  const principal = useAuthPrincipal();

  const [defaultAgent, setDefaultAgent] = React.useState<string | undefined>();
  const [isLoading, setIsLoading] = React.useState(true);
  const isManagedPersonal = principal.scope === 'managed' && principal.role !== 'admin';
  const defaultAgentIsPersonal = settingsOverrideKeys.includes('defaultAgent');
  const defaultPlanModeIsPersonal = settingsOverrideKeys.includes('defaultPlanMode');
  const selectableDefaultAgents = React.useMemo(
    () => resolveSelectableAgentOptions(configAgents, agentsStoreAgents),
    [agentsStoreAgents, configAgents],
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
        console.warn('Failed to load session defaults:', error);
      } finally {
        setIsLoading(false);
      }
    };
    void loadSettings();
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
    [isManagedPersonal, selectableDefaultAgents, setAgent, setSettingsDefaultAgent],
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
      toast.success(t('settings.sessionDefaults.toast.defaultAgentReset'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settings.sessionDefaults.toast.defaultAgentResetFailed'));
    }
  }, [resetPersonalSettingsOverride, selectableDefaultAgents, setAgent, t]);

  const handleResetDefaultPlanMode = React.useCallback(async () => {
    try {
      await resetPersonalSettingsOverride('defaultPlanMode');
      toast.success(t('settings.sessionDefaults.toast.planModeReset'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settings.sessionDefaults.toast.planModeResetFailed'));
    }
  }, [resetPersonalSettingsOverride, t]);

  const renderScope = (isPersonal: boolean, onReset: () => void) => (isManagedPersonal ? (
    <>
      <SettingsBadge tone={isPersonal ? 'accent' : 'neutral'}>
        {isPersonal ? t('settings.sessionDefaults.badge.personal') : t('settings.sessionDefaults.badge.inherited')}
      </SettingsBadge>
      <Button size="xs" variant="outline" onClick={onReset} disabled={!isPersonal}>
        {t('settings.common.actions.reset')}
      </Button>
    </>
  ) : null);

  return (
    <SettingsDetailSection
      title={t('settings.sessionDefaults.section.newSessions')}
      meta={isLoading ? null : (
        <>
          {t('settings.openchamber.defaults.summaryPrefix')}
          {' '}
          <span className="text-foreground">
            {resolvedDefaultAgent ? formatAgentDisplayName(resolvedDefaultAgent) : t('settings.commands.agentSelector.notSelected')}
          </span>
        </>
      )}
    >
      {isLoading ? (
        <div className="h-20" aria-busy="true" />
      ) : (
        <div className="divide-y divide-[var(--interactive-border)]/60">
          <div className="flex flex-col gap-2 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="typography-ui-label text-foreground">{t('settings.openchamber.defaults.field.defaultAgent')}</span>
              <span className="typography-meta text-muted-foreground">{t('settings.sessionDefaults.field.defaultAgentDescription')}</span>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {renderScope(defaultAgentIsPersonal, () => { void handleResetDefaultAgent(); })}
              <AgentSelector agentName={resolvedDefaultAgent} onChange={handleAgentChange} filter={isSelectablePrimaryAgentOption} />
            </div>
          </div>

          <div className="flex items-start justify-between gap-6 py-2">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="typography-ui-label text-foreground">{t('settings.openchamber.defaults.field.defaultPlanMode')}</span>
              <span className="typography-meta text-muted-foreground">{t('settings.sessionDefaults.field.planModeDescription')}</span>
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 pt-0.5">
              {renderScope(defaultPlanModeIsPersonal, () => { void handleResetDefaultPlanMode(); })}
              <Switch
                checked={settingsDefaultPlanMode}
                onCheckedChange={(checked) => handlePlanModeChange(checked)}
                aria-label={t('settings.openchamber.defaults.field.defaultPlanModeAria')}
              />
            </div>
          </div>
        </div>
      )}
    </SettingsDetailSection>
  );
};

type AgentModelRow = {
  agent: Agent;
  selection: ResolvedAgentDefault | null;
  modelLabel: string | null;
};

const AgentModelsSummary: React.FC = () => {
  const { t } = useI18n();
  const principal = useAuthPrincipal();
  const configAgents = useConfigStore((state) => state.agents);
  const providers = useConfigStore((state) => state.providers);
  const personalSelections = useConfigStore((state) => state.agentModelSelections);
  const setSelectedAgent = useAgentsStore((state) => state.setSelectedAgent);
  const isPersonalEditor = canEditPersonalAgentModels(principal);

  const rows = React.useMemo<AgentModelRow[]>(() => {
    // Same agents as the Agents sidebar, so every row opens an editor.
    const visible = filterVisibleSettingsAgents(filterVisibleAgentSelectorOptions(configAgents));
    const primary = visible.filter((agent) => isPrimaryAgentMode(agent.mode)).sort(compareAgentOptions);
    const subagents = visible
      .filter((agent) => !isPrimaryAgentMode(agent.mode))
      .sort((a, b) => formatAgentDisplayName(a.name).localeCompare(formatAgentDisplayName(b.name)));
    return [...primary, ...subagents].map((agent) => {
      const selection = resolveAgentDefaultSelection({
        agentName: agent.name,
        agents: [agent],
        providers,
        personalSelections,
      });
      const model = selection
        ? providers.find((provider) => provider.id === selection.providerId)?.models.find((entry) => entry.id === selection.modelId)
        : undefined;
      const modelName = selection ? (model ? getModelDisplayName(model) : selection.modelId) : null;
      return {
        agent,
        selection,
        modelLabel: modelName ? [modelName, selection?.variant].filter(Boolean).join(' · ') : null,
      };
    });
  }, [configAgents, personalSelections, providers]);

  const openAgent = React.useCallback((agentName: string) => {
    setSelectedAgent(agentName);
    useUIStore.getState().setSettingsPage('agents');
  }, [setSelectedAgent]);

  if (rows.length === 0) return null;

  const renderSourceBadge = (selection: ResolvedAgentDefault | null) => {
    switch (selection?.source) {
      case 'personal':
        return <SettingsBadge tone="accent">{t('settings.sessionDefaults.badge.personal')}</SettingsBadge>;
      case 'availability-fallback':
        return <SettingsBadge tone="warning">{t('settings.sessionDefaults.agentModels.badge.fallback')}</SettingsBadge>;
      case 'host-managed':
        return <SettingsBadge>{t('settings.sessionDefaults.agentModels.badge.hostManaged')}</SettingsBadge>;
      default:
        return null;
    }
  };

  return (
    <SettingsDetailSection
      title={t('settings.sessionDefaults.section.agentModels')}
      count={rows.length}
      description={isPersonalEditor
        ? t('settings.sessionDefaults.agentModels.personalDescription')
        : t('settings.sessionDefaults.agentModels.description')}
      variant="card"
      bodyClassName="px-0 py-1"
    >
      <ul className="divide-y divide-[var(--interactive-border)]/60">
        {rows.map(({ agent, selection, modelLabel }) => {
          const label = formatAgentDisplayName(agent.name);
          return (
            <li key={agent.name}>
              <button
                type="button"
                onClick={() => openAgent(agent.name)}
                aria-label={t('settings.sessionDefaults.agentModels.openAria', { agent: label })}
                className="group flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/50"
              >
                <RiAiAgentLine
                  className="h-3.5 w-3.5 shrink-0"
                  style={{ color: `var(${getAgentIconColor(agent.name).var})` }}
                />
                <span className="w-32 shrink-0 truncate typography-ui-label text-foreground sm:w-40">{label}</span>
                <span className="min-w-0 flex-1 truncate typography-meta text-muted-foreground">
                  {modelLabel ?? t('settings.sessionDefaults.agentModels.defaultModel')}
                </span>
                {renderSourceBadge(selection)}
                <RiArrowRightSLine className="h-4 w-4 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-foreground" />
              </button>
            </li>
          );
        })}
      </ul>
    </SettingsDetailSection>
  );
};

export const SessionDefaultsPage: React.FC = () => {
  const { t } = useI18n();
  const principal = useAuthPrincipal();
  const canReadAgents = canAccessSettingsPage(principal, 'agents');

  return (
    <SettingsPageLayout>
      <SettingsDetailHeader
        icon={<RiChatHistoryLine />}
        title={t('settings.page.sessions.title')}
        subtitle={t('settings.sessionDefaults.page.subtitle')}
      />
      <NewSessionDefaults />
      {canReadAgents ? <AgentModelsSummary /> : null}
      <SettingsDetailSection title={t('settings.sessionDefaults.section.cleanup')}>
        <SessionCleanupSettings />
      </SettingsDetailSection>
    </SettingsPageLayout>
  );
};
