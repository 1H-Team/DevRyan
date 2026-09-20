import React from 'react';
import { useAuthPrincipal } from '@/lib/authSession';
import { resolveSettingsSlug } from '@/lib/settings/metadata';
import { useUIStore } from '@/stores/useUIStore';
import { preloadSettingsSection, preloadSettingsSectionsWhenIdle } from './settingsSectionLoaders';

export function preloadCurrentSettingsDestination(): Promise<void> {
  return preloadSettingsSection(resolveSettingsSlug(useUIStore.getState().settingsPage));
}

/** MainLayout mounts only after authentication and StartupReadinessGate complete. */
export function useSettingsEntryPreload(): void {
  const principal = useAuthPrincipal();
  const settingsPage = useUIStore((state) => state.settingsPage);
  React.useEffect(() => (
    preloadSettingsSectionsWhenIdle([resolveSettingsSlug(settingsPage)])
  ), [principal, settingsPage]);
}
