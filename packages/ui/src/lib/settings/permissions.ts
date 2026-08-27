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
      ['bots', 'Bots'],
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
      ['mcp', 'MCP Servers'],
      ['remote-instances', 'Remote Instances'],
      ['tunnel', 'Remote Tunnel'],
    ],
  },
  {
    id: 'development',
    label: 'Development',
    pages: [
      ['users', 'User Management'],
      ['bug-reports', 'Bug Reports'],
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

const isPermissionRecord = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const normalizePermissionCell = (value: unknown): SettingsPagePermission => {
  if (!isPermissionRecord(value)) return { read: false, edit: false };
  const read = value.read === true;
  return {
    read,
    edit: read && value.edit === true,
  };
};

/**
 * Converts an untrusted or version-skewed API matrix into the complete UI
 * catalog. Missing cells may inherit an explicitly supplied compatibility
 * matrix; malformed cells always fail closed.
 */
export const normalizeSettingsPermissions = (
  value: unknown,
  fallback?: SettingsPermissions,
): SettingsPermissions => {
  const source = isPermissionRecord(value) ? value : null;
  return createSettingsPermissions((slug) => {
    if (source && Object.prototype.hasOwnProperty.call(source, slug)) {
      return normalizePermissionCell(source[slug]);
    }
    return normalizePermissionCell(fallback?.[slug]);
  });
};

const PERSONAL_EDIT_PAGES = new Set<SettingsPermissionSlug>([
  'appearance', 'notifications', 'shortcuts', 'voice', 'chat', 'sessions', 'usage', 'bug-reports',
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
): SettingsPermissions => {
  const safeInherited = normalizeSettingsPermissions(inherited);
  const safeOverrides = isPermissionRecord(overrides) ? overrides : {};
  return createSettingsPermissions((slug) => {
    const rawOverride = safeOverrides[slug];
    const override = isPermissionRecord(rawOverride) ? rawOverride : {};
    const read = typeof override.read === 'boolean' ? override.read : safeInherited[slug].read;
    const requestedEdit = typeof override.edit === 'boolean' ? override.edit : safeInherited[slug].edit;
    return {
      read,
      edit: read && requestedEdit,
    };
  });
};

export const cycleSettingsPermissionOverride = (value: boolean | undefined): boolean | undefined => {
  if (value === undefined) return true;
  if (value) return false;
  return undefined;
};
