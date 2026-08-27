import { canAccessSettingsPage, hasAuthCapability, type AuthPrincipal } from '@/lib/authSession';
import type { SettingsPageSlug } from '@/lib/settings/metadata';

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
