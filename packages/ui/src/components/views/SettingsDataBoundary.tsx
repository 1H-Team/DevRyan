import React from 'react';
import { canAccessSettingsPage, useAuthPrincipal } from '@/lib/authSession';
import type { SettingsPageSlug } from '@/lib/settings/metadata';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useAgentsStore } from '@/stores/useAgentsStore';
import { useCommandsStore } from '@/stores/useCommandsStore';
import { useMcpConfigStore } from '@/stores/useMcpConfigStore';
import { useSkillsStore } from '@/stores/useSkillsStore';
import { useSkillsCatalogStore } from '@/stores/useSkillsCatalogStore';
import { usePluginsStore } from '@/stores/usePluginsStore';

export type SettingsDataBoundaryProps = React.PropsWithChildren<{
  slug: SettingsPageSlug;
  resetSelectedAgent?: boolean;
}>;

/** Loaded alongside the destination code; importing it never fetches settings data. */
export const SettingsDataBoundary: React.FC<SettingsDataBoundaryProps> = ({ slug, resetSelectedAgent, children }) => {
  const principal = useAuthPrincipal();
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);

  React.useEffect(() => {
    if (slug !== 'agents' || !resetSelectedAgent || !canAccessSettingsPage(principal, slug)) return;
    useAgentsStore.getState().setSelectedAgent(null);
    useUIStore.getState().setSettingsPage('agents');
  }, [principal, resetSelectedAgent, slug]);

  React.useEffect(() => {
    if (!canAccessSettingsPage(principal, slug)) return;
    if (slug === 'agents') {
      void useAgentsStore.getState().loadAgents();
    } else if (slug === 'commands') {
      void useCommandsStore.getState().loadCommands();
    } else if (slug === 'mcp') {
      void useMcpConfigStore.getState().loadMcpConfigs();
    } else if (slug === 'skills.installed' || slug === 'skills.catalog') {
      void useSkillsStore.getState().loadSkills();
      void useSkillsCatalogStore.getState().loadCatalog();
    } else if (slug === 'plugins') {
      void usePluginsStore.getState().loadPlugins();
      void usePluginsStore.getState().loadSlimStatus();
    }
  }, [activeProjectId, principal, slug]);

  return children;
};
