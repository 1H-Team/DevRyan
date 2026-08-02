import type { Theme } from '@/types/theme';
import { withPrColors } from './prColors';

// Active OpenChamber presets pinned at fdeb5606c483630237d233581b86598d69d00119.

import carbonfoxDarkRaw from './carbonfox-dark.json';
import carbonfoxLightRaw from './carbonfox-light.json';
import jetbrainsDarkRaw from './jetbrains-dark.json';
import jetbrainsLightRaw from './jetbrains-light.json';
import nordDarkRaw from './nord-dark.json';
import nordLightRaw from './nord-light.json';
import oneDarkProDarkRaw from './onedarkpro-dark.json';
import oneDarkProLightRaw from './onedarkpro-light.json';
import monoPlusDarkRaw from './mono-plus-dark.json';
import monoPlusLightRaw from './mono-plus-light.json';

export const presetThemes: Theme[] = [
  carbonfoxDarkRaw as Theme,
  carbonfoxLightRaw as Theme,
  jetbrainsDarkRaw as Theme,
  jetbrainsLightRaw as Theme,
  nordDarkRaw as Theme,
  nordLightRaw as Theme,
  oneDarkProDarkRaw as Theme,
  oneDarkProLightRaw as Theme,
  monoPlusDarkRaw as Theme,
  monoPlusLightRaw as Theme,
].map((theme) => withPrColors(theme));
