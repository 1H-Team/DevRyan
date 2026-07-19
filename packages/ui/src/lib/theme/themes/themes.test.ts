import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_DARK_THEME_ID,
  DEFAULT_LIGHT_THEME_ID,
  getDefaultTheme,
  getThemeById,
  themes,
} from './index';
import { CSSVariableGenerator } from '../cssGenerator';

const UPSTREAM_THEME_IDS = [
  'flexoki',
  'carbonfox',
  'gruvbox',
  'jetbrains',
  'nightowl',
  'nord',
  'onedarkpro',
  'solarized',
  'vesper',
  'mono-plus',
] as const;

const expectedIds = [
  DEFAULT_LIGHT_THEME_ID,
  DEFAULT_DARK_THEME_ID,
  ...UPSTREAM_THEME_IDS.flatMap((id) => [`${id}-dark`, `${id}-light`]),
];

describe('built-in theme catalog', () => {
  test('contains Default plus the exact active upstream catalog', () => {
    expect(themes).toHaveLength(22);
    expect(themes.filter((theme) => theme.metadata.variant === 'light')).toHaveLength(11);
    expect(themes.filter((theme) => theme.metadata.variant === 'dark')).toHaveLength(11);
    expect(new Set(themes.map((theme) => theme.metadata.id)).size).toBe(themes.length);
    expect(themes.map((theme) => theme.metadata.id).sort()).toEqual([...expectedIds].sort());
  });

  test('keeps the dedicated DevRyan themes as the light and dark defaults', () => {
    expect({
      id: getDefaultTheme(false).metadata.id,
      name: getDefaultTheme(false).metadata.name,
      variant: getDefaultTheme(false).metadata.variant,
    }).toEqual({
      id: DEFAULT_LIGHT_THEME_ID,
      name: 'Default',
      variant: 'light',
    });
    expect({
      id: getDefaultTheme(true).metadata.id,
      name: getDefaultTheme(true).metadata.name,
      variant: getDefaultTheme(true).metadata.variant,
    }).toEqual({
      id: DEFAULT_DARK_THEME_ID,
      name: 'Default',
      variant: 'dark',
    });
  });

  test('uses the JetBrains presentation for Default dark and the former Default presentation for JetBrains dark', () => {
    const defaultDark = getThemeById(DEFAULT_DARK_THEME_ID);
    const jetBrainsDark = getThemeById('jetbrains-dark');

    expect({
      name: defaultDark?.metadata.name,
      background: defaultDark?.colors.surface.background,
      primary: defaultDark?.colors.primary.base,
      font: defaultDark?.config?.fonts?.sans,
    }).toEqual({
      name: 'Default',
      background: '#1E1F22',
      primary: '#6796f5',
      font: '"JetBrains Mono", ui-monospace, "SFMono-Regular", "Menlo", "Cascadia Mono", "Segoe UI Mono", monospace',
    });
    expect({
      name: jetBrainsDark?.metadata.name,
      background: jetBrainsDark?.colors.surface.background,
      primary: jetBrainsDark?.colors.primary.base,
      font: jetBrainsDark?.config?.fonts?.sans,
    }).toEqual({
      name: 'JetBrains',
      background: '#161616',
      primary: '#33B1FF',
      font: '"IBM Plex Mono", monospace',
    });
  });

  test('provides the core semantic tokens required by the theme engine', () => {
    const generator = new CSSVariableGenerator();

    for (const theme of themes) {
      expect(theme.metadata.id.length).toBeGreaterThan(0);
      expect(['light', 'dark']).toContain(theme.metadata.variant);
      expect(theme.colors.primary.base.length).toBeGreaterThan(0);
      expect(theme.colors.primary.foreground?.length).toBeGreaterThan(0);
      expect(theme.colors.surface.background.length).toBeGreaterThan(0);
      expect(theme.colors.surface.foreground.length).toBeGreaterThan(0);
      expect(theme.colors.interactive.border.length).toBeGreaterThan(0);
      expect(theme.colors.status.error.length).toBeGreaterThan(0);
      expect(theme.colors.syntax.base.foreground.length).toBeGreaterThan(0);
      expect(theme.colors.syntax.highlights?.diffAdded?.length).toBeGreaterThan(0);
      expect(theme.colors.pr).toBeTruthy();
      expect(generator.generate(theme)).toContain(`--background: ${theme.colors.surface.background}`);
    }
  });
});
