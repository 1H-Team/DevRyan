export const THEME_CATALOG_VERSION = 2 as const;

export const DEFAULT_LIGHT_THEME_ID = 'devryan-default-light' as const;
export const DEFAULT_DARK_THEME_ID = 'devryan-default-dark' as const;

const LEGACY_DEFAULT_THEME_IDS: Readonly<Record<string, string>> = {
  'onedarkpro-light': DEFAULT_LIGHT_THEME_ID,
  'carbonfox-dark': DEFAULT_DARK_THEME_ID,
};

export type ThemeCatalogSettings = {
  themeId?: string;
  lightThemeId?: string;
  darkThemeId?: string;
  themeCatalogVersion?: number;
};

export const migrateThemeCatalogSettings = <T extends ThemeCatalogSettings>(settings: T): {
  settings: T & { themeCatalogVersion: number };
  changed: boolean;
} => {
  if (typeof settings.themeCatalogVersion === 'number' && settings.themeCatalogVersion >= THEME_CATALOG_VERSION) {
    return {
      settings: settings as T & { themeCatalogVersion: number },
      changed: false,
    };
  }

  const migrateId = (themeId: string | undefined): string | undefined =>
    themeId ? (LEGACY_DEFAULT_THEME_IDS[themeId] ?? themeId) : undefined;

  return {
    settings: {
      ...settings,
      themeId: migrateId(settings.themeId),
      lightThemeId: migrateId(settings.lightThemeId),
      darkThemeId: migrateId(settings.darkThemeId),
      themeCatalogVersion: THEME_CATALOG_VERSION,
    },
    changed: true,
  };
};

export const migrateThemeCatalogLocalStorage = (storage: Storage): void => {
  const rawVersion = storage.getItem('themeCatalogVersion');
  const themeCatalogVersion = rawVersion === null ? undefined : Number(rawVersion);
  const migration = migrateThemeCatalogSettings({
    themeId: storage.getItem('selectedThemeId') ?? undefined,
    lightThemeId: storage.getItem('lightThemeId') ?? undefined,
    darkThemeId: storage.getItem('darkThemeId') ?? undefined,
    themeCatalogVersion,
  });

  if (!migration.changed) {
    return;
  }

  if (migration.settings.themeId) {
    storage.setItem('selectedThemeId', migration.settings.themeId);
  }
  if (migration.settings.lightThemeId) {
    storage.setItem('lightThemeId', migration.settings.lightThemeId);
  }
  if (migration.settings.darkThemeId) {
    storage.setItem('darkThemeId', migration.settings.darkThemeId);
  }
  storage.setItem('themeCatalogVersion', String(THEME_CATALOG_VERSION));
};
