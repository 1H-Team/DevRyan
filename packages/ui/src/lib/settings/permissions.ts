import type { SettingsPageSlug } from './metadata';

export const SETTINGS_PERMISSION_SECTIONS = [
  {
    id: 'general',
    label: 'General',
    pages: [
      ['appearance', 'Appearance'],
      ['notifications', 'Notifications'],
      ['shortcuts', 'Shortcuts'],
      ['voice', 'Voice'],
      ['about', 'About'],
    ],
  },
  {
    id: 'workflow',
    label: 'Workflow',
    pages: [
      ['chat', 'Chat'],
      ['sessions', 'Sessions'],
      ['agents', 'Agents'],
      ['skills.installed', 'Skills'],
      ['skills.catalog', 'Skills Catalog'],
      ['plugins', 'Plugins'],
      ['magic-prompts', 'Magic Prompts'],
    ],
  },
  {
    id: 'connections',
    label: 'Connections',
    pages: [
      ['providers', 'Providers'],
      ['usage', 'Usage'],
      ['mcp', 'MCP'],
      ['remote-instances', 'Remote Instances'],
      ['tunnel', 'Remote Tunnel'],
    ],
  },
  {
    id: 'development',
    label: 'Development',
    pages: [
      ['users', 'User Management'],
      ['git', 'Git'],
      ['projects', 'Projects'],
      ['commands', 'Commands'],
    ],
  },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  pages: ReadonlyArray<readonly [Exclude<SettingsPageSlug, 'home' | 'behavior'>, string]>;
}>;

export const SETTINGS_PERMISSION_SLUGS = SETTINGS_PERMISSION_SECTIONS.flatMap(
  (section) => section.pages.map(([slug]) => slug),
);

export type SettingsPermissionSlug = (typeof SETTINGS_PERMISSION_SLUGS)[number];
export interface SettingsPagePermission {
  read: boolean;
  edit: boolean;
}
export type SettingsPermissions = Record<SettingsPermissionSlug, SettingsPagePermission>;
export type SettingsPermissionOverride = Partial<SettingsPagePermission>;
export type SettingsPermissionOverrides = Partial<Record<SettingsPermissionSlug, SettingsPermissionOverride>>;

export const canonicalSettingsPermissionSlug = (slug: string): SettingsPermissionSlug | null => {
  const normalized = slug === 'behavior' ? 'agents' : slug;
  return SETTINGS_PERMISSION_SLUGS.includes(normalized as SettingsPermissionSlug)
    ? normalized as SettingsPermissionSlug
    : null;
};

export const createSettingsPermissions = (
  resolve: (slug: SettingsPermissionSlug) => SettingsPagePermission,
): SettingsPermissions => Object.fromEntries(
  SETTINGS_PERMISSION_SLUGS.map((slug) => [slug, resolve(slug)]),
) as SettingsPermissions;

export const fullSettingsPermissions = (): SettingsPermissions => createSettingsPermissions(() => ({
  read: true,
  edit: true,
}));

const PERSONAL_EDIT_PAGES = new Set<SettingsPermissionSlug>([
  'appearance', 'notifications', 'shortcuts', 'voice', 'chat', 'sessions', 'usage',
]);

export const permissionsFromLegacyPages = (pages: readonly string[]): SettingsPermissions => {
  const all = pages.includes('*');
  return createSettingsPermissions((slug) => {
    const read = all || pages.includes(slug);
    return { read, edit: read && PERSONAL_EDIT_PAGES.has(slug) };
  });
};

export const mergeSettingsPermissionOverrides = (
  inherited: SettingsPermissions,
  overrides: SettingsPermissionOverrides,
): SettingsPermissions => createSettingsPermissions((slug) => {
  const override = overrides[slug];
  const read = override?.read ?? inherited[slug].read;
  return {
    read,
    edit: read && (override?.edit ?? inherited[slug].edit),
  };
});

export const cycleSettingsPermissionOverride = (value: boolean | undefined): boolean | undefined => {
  if (value === undefined) return true;
  if (value) return false;
  return undefined;
};
