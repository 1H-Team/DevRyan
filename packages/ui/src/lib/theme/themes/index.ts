import type { Theme } from '@/types/theme';
import { presetThemes } from './presets';
import { withPrColors } from './prColors';
import defaultLightRaw from './devryan-default-light.json';
import defaultDarkRaw from './devryan-default-dark.json';
import {
  DEFAULT_DARK_THEME_ID,
  DEFAULT_LIGHT_THEME_ID,
} from '../catalogMigration';

export { DEFAULT_DARK_THEME_ID, DEFAULT_LIGHT_THEME_ID } from '../catalogMigration';

const defaultLight = withPrColors(defaultLightRaw as Theme);
const formerDefaultDark = withPrColors(defaultDarkRaw as Theme);
const jetBrainsDark = presetThemes.find((theme) => theme.metadata.id === 'jetbrains-dark');

const applyPresentation = (identity: Theme, presentation: Theme): Theme => ({
  ...identity,
  colors: presentation.colors,
  config: presentation.config,
});

export const themes: Theme[] = [
  defaultLight,
  jetBrainsDark ? applyPresentation(formerDefaultDark, jetBrainsDark) : formerDefaultDark,
  ...presetThemes.map((theme) => (
    theme.metadata.id === 'jetbrains-dark'
      ? applyPresentation(theme, formerDefaultDark)
      : theme
  )),
];

export function getThemeById(id: string): Theme | undefined {
  return themes.find(theme => theme.metadata.id === id);
}

export function getDefaultTheme(prefersDark: boolean): Theme {
  const variant: Theme['metadata']['variant'] = prefersDark ? 'dark' : 'light';

  const defaultId = prefersDark ? DEFAULT_DARK_THEME_ID : DEFAULT_LIGHT_THEME_ID;
  const defaultTheme = getThemeById(defaultId);
  if (defaultTheme && defaultTheme.metadata.variant === variant) {
    return defaultTheme;
  }

  return themes.find((theme) => theme.metadata.variant === variant) ?? themes[0];
}
