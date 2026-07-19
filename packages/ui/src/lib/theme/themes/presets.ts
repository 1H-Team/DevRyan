import type { Theme } from '@/types/theme';
import { withPrColors } from './prColors';

// Active OpenChamber presets pinned at fdeb5606c483630237d233581b86598d69d00119.

import flexokiDarkRaw from './flexoki-dark.json';
import flexokiLightRaw from './flexoki-light.json';
import carbonfoxDarkRaw from './carbonfox-dark.json';
import carbonfoxLightRaw from './carbonfox-light.json';
import gruvboxDarkRaw from './gruvbox-dark.json';
import gruvboxLightRaw from './gruvbox-light.json';
import jetbrainsDarkRaw from './jetbrains-dark.json';
import jetbrainsLightRaw from './jetbrains-light.json';
import nightOwlDarkRaw from './nightowl-dark.json';
import nightOwlLightRaw from './nightowl-light.json';
import nordDarkRaw from './nord-dark.json';
import nordLightRaw from './nord-light.json';
import oneDarkProDarkRaw from './onedarkpro-dark.json';
import oneDarkProLightRaw from './onedarkpro-light.json';
import solarizedDarkRaw from './solarized-dark.json';
import solarizedLightRaw from './solarized-light.json';
import vesperDarkRaw from './vesper-dark.json';
import vesperLightRaw from './vesper-light.json';
import monoPlusDarkRaw from './mono-plus-dark.json';
import monoPlusLightRaw from './mono-plus-light.json';

export const presetThemes: Theme[] = [
  flexokiDarkRaw as Theme,
  flexokiLightRaw as Theme,
  carbonfoxDarkRaw as Theme,
  carbonfoxLightRaw as Theme,
  gruvboxDarkRaw as Theme,
  gruvboxLightRaw as Theme,
  jetbrainsDarkRaw as Theme,
  jetbrainsLightRaw as Theme,
  nightOwlDarkRaw as Theme,
  nightOwlLightRaw as Theme,
  nordDarkRaw as Theme,
  nordLightRaw as Theme,
  oneDarkProDarkRaw as Theme,
  oneDarkProLightRaw as Theme,
  solarizedDarkRaw as Theme,
  solarizedLightRaw as Theme,
  vesperDarkRaw as Theme,
  vesperLightRaw as Theme,
  monoPlusDarkRaw as Theme,
  monoPlusLightRaw as Theme,
].map((theme) => withPrColors(theme));
