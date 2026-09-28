import type { I18nKey } from '@/lib/i18n';
import type { SettingsPageMeta, SettingsPageSlug } from './metadata';

export type SettingsNavSection = {
  labelKey: I18nKey;
  destinations: readonly SettingsNavDestination[];
};

export type SettingsNavDestination = {
  id: string;
  labelKey?: I18nKey;
  /** Accessible name for the tab strip when the destination shows more than one page. */
  tabsAriaLabelKey?: I18nKey;
  iconSlug: SettingsPageSlug;
  /** Pages rendered as tabs, in display order. */
  slugs: readonly SettingsPageSlug[];
  /** Sub-pages opened from within a tab; they keep that tab and the nav item active. */
  aliasSlugs?: Readonly<Partial<Record<SettingsPageSlug, SettingsPageSlug>>>;
  /** Pages shown only when none of `slugs` are visible to the principal. */
  fallbackSlugs?: readonly SettingsPageSlug[];
};

const singlePageDestination = (slug: SettingsPageSlug): SettingsNavDestination => ({
  id: slug,
  iconSlug: slug,
  slugs: [slug],
});

const singlePageDestinations = (...slugs: SettingsPageSlug[]): SettingsNavDestination[] => (
  slugs.map(singlePageDestination)
);

export const PLUGINS_SETTINGS_DESTINATION = {
  id: 'plugins',
  labelKey: 'settings.page.plugins.title',
  tabsAriaLabelKey: 'settings.plugins.tabs.aria',
  iconSlug: 'plugins',
  slugs: ['plugins', 'skills.installed', 'mcp'],
  aliasSlugs: { 'skills.catalog': 'skills.installed' },
} as const satisfies SettingsNavDestination;

// Usage is shown inside each provider's page. The standalone Usage page remains
// only for principals who may read usage but not providers.
export const PROVIDERS_SETTINGS_DESTINATION = {
  id: 'providers',
  labelKey: 'settings.page.providers.title',
  tabsAriaLabelKey: 'settings.providers.tabs.aria',
  iconSlug: 'providers',
  slugs: ['providers'],
  fallbackSlugs: ['usage'],
} as const satisfies SettingsNavDestination;

// Session Defaults is an entry in the Agents sidebar rather than a tab. It keeps
// its own `sessions` page and permission identity, and stands alone for
// principals who may read session defaults but not agents.
export const AGENTS_SETTINGS_DESTINATION = {
  id: 'agents',
  labelKey: 'settings.page.agents.title',
  iconSlug: 'agents',
  slugs: ['agents'],
  aliasSlugs: { sessions: 'agents' },
  fallbackSlugs: ['sessions'],
} as const satisfies SettingsNavDestination;

export const REMOTE_CONNECTIONS_SETTINGS_DESTINATION = {
  id: 'remote-connections',
  labelKey: 'settings.page.remoteConnections.title',
  tabsAriaLabelKey: 'settings.remoteConnections.tabs.aria',
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
    destinations: [
      AGENTS_SETTINGS_DESTINATION,
      ...singlePageDestinations('bots', 'magic-prompts'),
    ],
  },
  {
    labelKey: 'settings.view.nav.group.connections',
    destinations: [
      PLUGINS_SETTINGS_DESTINATION,
      PROVIDERS_SETTINGS_DESTINATION,
      REMOTE_CONNECTIONS_SETTINGS_DESTINATION,
    ],
  },
  {
    labelKey: 'settings.view.nav.group.development',
    destinations: singlePageDestinations('users', 'bug-reports', 'git', 'projects', 'about'),
  },
];

export function getSettingsDestinationMemberSlugs(destination: SettingsNavDestination): SettingsPageSlug[] {
  return [
    ...destination.slugs,
    ...(Object.keys(destination.aliasSlugs ?? {}) as SettingsPageSlug[]),
    ...(destination.fallbackSlugs ?? []),
  ];
}

export function getSettingsNavDestination(slug: SettingsPageSlug): SettingsNavDestination | null {
  for (const section of SETTINGS_NAV_SECTIONS) {
    const destination = section.destinations.find((item) => getSettingsDestinationMemberSlugs(item).includes(slug));
    if (destination) return destination;
  }
  return null;
}

/** Maps a sub-page to the tab that owns it; other slugs map to themselves. */
export function resolveSettingsTabSlug(slug: SettingsPageSlug): SettingsPageSlug {
  return getSettingsNavDestination(slug)?.aliasSlugs?.[slug] ?? slug;
}

/** Pages a destination currently presents: its visible tabs, or else its visible fallbacks. */
export function getSettingsDestinationVisibleSlugs(
  destination: SettingsNavDestination,
  visibleSlugs: ReadonlySet<string>,
): SettingsPageSlug[] {
  const tabs = destination.slugs.filter((slug) => visibleSlugs.has(slug));
  if (tabs.length > 0) return tabs;
  return (destination.fallbackSlugs ?? []).filter((slug) => visibleSlugs.has(slug));
}

export function getSettingsDestinationFallbackSlug(
  slug: SettingsPageSlug,
  visibleSlugs: ReadonlySet<string>,
): SettingsPageSlug | null {
  const destination = getSettingsNavDestination(slug);
  return destination ? getSettingsDestinationVisibleSlugs(destination, visibleSlugs)[0] ?? null : null;
}

/**
 * A fallback page is superseded once one of its destination's primary pages is
 * visible (for example Usage folds into Providers). Returns the page to show
 * instead, or null when the requested page should stay. A fallback that is also
 * an alias sub-page (Session Defaults) stays reachable from inside its tab.
 */
export function getSettingsSupersedingSlug(
  slug: SettingsPageSlug,
  visibleSlugs: ReadonlySet<string>,
): SettingsPageSlug | null {
  const destination = getSettingsNavDestination(slug);
  if (!destination?.fallbackSlugs?.includes(slug)) return null;
  if (destination.aliasSlugs?.[slug]) return null;
  return destination.slugs.find((candidate) => visibleSlugs.has(candidate)) ?? null;
}

/**
 * A page that borrows another page's sidebar renders on its own when that
 * sidebar's page is hidden from the principal.
 */
export function getSettingsPageLayoutKind(
  page: Pick<SettingsPageMeta, 'kind' | 'sidebarSlug'>,
  visibleSlugs: ReadonlySet<string>,
): SettingsPageMeta['kind'] {
  if (page.sidebarSlug && !visibleSlugs.has(page.sidebarSlug)) return 'single';
  return page.kind;
}
