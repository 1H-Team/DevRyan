import type { I18nKey } from '@/lib/i18n';
import type { SettingsPageSlug } from './metadata';

export type SettingsNavSection = {
  labelKey: I18nKey;
  pages: readonly SettingsPageSlug[];
};

// Display-only sidebar grouping; metadata groups are left unchanged because they
// are used for page/search ownership rather than the visual settings nav order.
export const SETTINGS_NAV_SECTIONS = [
  {
    labelKey: 'settings.view.nav.group.general',
    pages: ['appearance', 'notifications', 'shortcuts', 'voice', 'about'],
  },
  {
    labelKey: 'settings.view.nav.group.workflow',
    pages: [
      'chat',
      'sessions',
      'agents',
      'skills.installed',
      'plugins',
      'magic-prompts',
    ],
  },
  {
    labelKey: 'settings.view.nav.group.connections',
    pages: ['providers', 'usage', 'mcp', 'remote-instances', 'tunnel'],
  },
  {
    labelKey: 'settings.view.nav.group.development',
    pages: ['users', 'bug-reports', 'git', 'projects', 'commands'],
  },
] satisfies readonly SettingsNavSection[];
