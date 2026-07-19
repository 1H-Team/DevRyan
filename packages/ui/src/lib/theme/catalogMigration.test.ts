import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_DARK_THEME_ID,
  DEFAULT_LIGHT_THEME_ID,
  migrateThemeCatalogLocalStorage,
  migrateThemeCatalogSettings,
  THEME_CATALOG_VERSION,
} from './catalogMigration';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe('theme catalog migration', () => {
  test('moves legacy Default selections to dedicated DevRyan IDs', () => {
    const result = migrateThemeCatalogSettings({
      themeId: 'onedarkpro-light',
      lightThemeId: 'onedarkpro-light',
      darkThemeId: 'carbonfox-dark',
    });

    expect(result).toEqual({
      changed: true,
      settings: {
        themeId: DEFAULT_LIGHT_THEME_ID,
        lightThemeId: DEFAULT_LIGHT_THEME_ID,
        darkThemeId: DEFAULT_DARK_THEME_ID,
        themeCatalogVersion: THEME_CATALOG_VERSION,
      },
    });
  });

  test('migrates only legacy Default IDs in mixed selections', () => {
    const result = migrateThemeCatalogSettings({
      lightThemeId: 'custom-light',
      darkThemeId: 'carbonfox-dark',
    });

    expect(result.settings.lightThemeId).toBe('custom-light');
    expect(result.settings.darkThemeId).toBe(DEFAULT_DARK_THEME_ID);
  });

  test('does not reinterpret intentional upstream selections after version 2', () => {
    const settings = {
      lightThemeId: 'onedarkpro-light',
      darkThemeId: 'carbonfox-dark',
      themeCatalogVersion: THEME_CATALOG_VERSION,
    };

    expect(migrateThemeCatalogSettings(settings)).toEqual({ settings, changed: false });
  });

  test('updates browser-local theme IDs and records the migration version', () => {
    const storage = new MemoryStorage();
    storage.setItem('selectedThemeId', 'carbonfox-dark');
    storage.setItem('lightThemeId', 'onedarkpro-light');
    storage.setItem('darkThemeId', 'carbonfox-dark');

    migrateThemeCatalogLocalStorage(storage);

    expect(storage.getItem('selectedThemeId')).toBe(DEFAULT_DARK_THEME_ID);
    expect(storage.getItem('lightThemeId')).toBe(DEFAULT_LIGHT_THEME_ID);
    expect(storage.getItem('darkThemeId')).toBe(DEFAULT_DARK_THEME_ID);
    expect(storage.getItem('themeCatalogVersion')).toBe(String(THEME_CATALOG_VERSION));
  });
});
