import React from 'react';
import { canAccessSettingsPage, useAuthPrincipal } from '@/lib/authSession';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSkillsStore } from '@/stores/useSkillsStore';
import { useSkillsCatalogStore } from '@/stores/useSkillsCatalogStore';
import { usePluginsStore } from '@/stores/usePluginsStore';
import type { SettingsDataBoundaryProps } from './SettingsDataBoundary';

/** The managed entrypoint intentionally does not import administrator data effects. */
export const ManagedSettingsDataBoundary: React.FC<SettingsDataBoundaryProps> = ({ slug, children }) => {
  const principal = useAuthPrincipal();
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);

  React.useEffect(() => {
    if (!canAccessSettingsPage(principal, slug)) return;
    if (slug === 'skills.installed') {
      void useSkillsStore.getState().loadSkills();
      void useSkillsCatalogStore.getState().loadCatalog();
    } else if (slug === 'plugins') {
      void usePluginsStore.getState().loadPlugins();
      void usePluginsStore.getState().loadSlimStatus();
    }
  }, [activeProjectId, principal, slug]);

  return children;
};
