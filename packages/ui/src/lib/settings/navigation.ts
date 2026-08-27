import type { I18nKey } from '@/lib/i18n';
import type { SettingsPageSlug } from './metadata';

export type SettingsNavSection = {
  labelKey: I18nKey;
  destinations: readonly SettingsNavDestination[];
};

export type SettingsNavDestination = {
  id: string;
  labelKey?: I18nKey;
  iconSlug: SettingsPageSlug;
  slugs: readonly SettingsPageSlug[];
};

const singlePageDestination = (slug: SettingsPageSlug): SettingsNavDestination => ({
  id: slug,
  iconSlug: slug,
  slugs: [slug],
});

const singlePageDestinations = (...slugs: SettingsPageSlug[]): SettingsNavDestination[] => (
  slugs.map(singlePageDestination)
);

export const PROVIDERS_SETTINGS_DESTINATION = {
  id: 'providers',
  labelKey: 'settings.page.providers.title',
  iconSlug: 'providers',
  slugs: ['providers', 'usage'],
} as const satisfies SettingsNavDestination;

export const REMOTE_CONNECTIONS_SETTINGS_DESTINATION = {
  id: 'remote-connections',
  labelKey: 'settings.page.remoteConnections.title',
  iconSlug: 'tunnel',
  slugs: ['tunnel', 'remote-instances'],
} as const satisfies SettingsNavDestination;

// Display-only sidebar grouping; metadata groups are left unchanged because they
// are used for page/search ownership rather than the visual settings nav order.
export const SETTINGS_NAV_SECTIONS: readonly SettingsNavSection[] = [
  {
    labelKey: 'settings.view.nav.group.general',
    destinations: singlePageDestinations('appearance', 'notifications', 'shortcuts', 'commands', 'voice'),
  },
  {
    labelKey: 'settings.view.nav.group.workflow',
    destinations: singlePageDestinations(
      'sessions',
      'agents',
      'bots',
      'skills.installed',
      'plugins',
      'magic-prompts',
    ),
  },
  {
    labelKey: 'settings.view.nav.group.connections',
    destinations: [
      PROVIDERS_SETTINGS_DESTINATION,
      singlePageDestination('mcp'),
      REMOTE_CONNECTIONS_SETTINGS_DESTINATION,
    ],
  },
  {
    labelKey: 'settings.view.nav.group.development',
    destinations: singlePageDestinations('users', 'bug-reports', 'git', 'projects', 'about'),
  },
];

export function getSettingsNavDestination(slug: SettingsPageSlug): SettingsNavDestination | null {
  for (const section of SETTINGS_NAV_SECTIONS) {
    const destination = section.destinations.find((item) => item.slugs.includes(slug));
    if (destination) return destination;
  }
  return null;
}

export function getSettingsDestinationFallbackSlug(
  slug: SettingsPageSlug,
  visibleSlugs: ReadonlySet<string>,
): SettingsPageSlug | null {
  const destination = getSettingsNavDestination(slug);
  return destination?.slugs.find((candidate) => visibleSlugs.has(candidate)) ?? null;
}
