import { canAccessSettingsPage, hasAuthCapability, type AuthPrincipal } from '@/lib/authSession';
import { getSettingsPageMeta, type SettingsPageSlug } from '@/lib/settings/metadata';
import { isDesktopShell, isWebRuntime } from '@/lib/desktop';

export const usesManagedSettings = (principal: AuthPrincipal): boolean => (
  principal.scope === 'managed' && principal.role !== 'admin'
);

const managedSettingsPages: ReadonlySet<SettingsPageSlug> = new Set([
  'home', 'appearance', 'chat', 'shortcuts', 'sessions', 'notifications', 'bots',
  'agents', 'skills.installed', 'plugins', 'providers', 'usage', 'mcp', 'bug-reports',
]);

export const isBotCapabilitySettingsSlug = (slug: SettingsPageSlug): boolean => (
  slug === 'skills.installed' || slug === 'mcp'
);

export const canAccessSettingsDestination = (
  principal: AuthPrincipal,
  slug: SettingsPageSlug,
): boolean => (
  slug === 'bots'
    ? hasAuthCapability(principal, 'bots') && canAccessSettingsPage(principal, slug)
    : canAccessSettingsPage(principal, slug)
);

/** Check live policy and runtime availability before importing or displaying a section. */
export const canPrepareSettingsSection = (principal: AuthPrincipal, slug: SettingsPageSlug): boolean => {
  if (principal.scope === 'tunnel-bot') return false;
  if (usesManagedSettings(principal) && !managedSettingsPages.has(slug)) return false;
  if (slug === 'home') return true;
  if (!canAccessSettingsDestination(principal, slug)) return false;
  const page = getSettingsPageMeta(slug);
  if (!page) return false;
  const isDesktop = isDesktopShell();
  return !page.isAvailable || page.isAvailable({
    isDesktop, isWeb: !isDesktop && isWebRuntime(), isManaged: principal.scope === 'managed',
  });
};
