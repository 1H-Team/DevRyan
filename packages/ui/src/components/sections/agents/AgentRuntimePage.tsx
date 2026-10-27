import React from 'react';
import { RiCpuLine } from '@remixicon/react';
import { AgentBrowserControlSettings } from '@/components/sections/devryan/AgentBrowserControlSettings';
import { OpenCodeCliSettings } from '@/components/sections/devryan/OpenCodeCliSettings';
import { SettingsDetailHeader, SettingsPageLayout } from '@/components/sections/shared';
import { useAuthPrincipal } from '@/lib/authSession';
import { useI18n } from '@/lib/i18n';
import { PackagedAgentPrompts } from './PackagedAgentPrompts';
import { canViewAgentRuntime } from './useAgentsSettingsEntries';

/**
 * Host-wide runtime that every agent session shares: packaged agent prompts,
 * the OpenCode binary, and (local Electron only) agent browser control.
 */
export const AgentRuntimePage: React.FC = () => {
  const { t } = useI18n();
  const principal = useAuthPrincipal();

  return (
    <SettingsPageLayout>
      <SettingsDetailHeader
        icon={<RiCpuLine />}
        title={t('settings.agents.sidebar.runtime')}
        subtitle={t('settings.agents.runtimePage.subtitle')}
      />
      {canViewAgentRuntime(principal) ? <PackagedAgentPrompts /> : null}
      <OpenCodeCliSettings />
      <AgentBrowserControlSettings />
    </SettingsPageLayout>
  );
};
