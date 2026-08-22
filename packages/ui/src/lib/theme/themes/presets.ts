import type { Theme } from '@/types/theme';
import { withPrColors } from './prColors';

// Active OpenChamber presets pinned at fdeb5606c483630237d233581b86598d69d00119.

import jetbrainsDarkRaw from './jetbrains-dark.json';
import jetbrainsLightRaw from './jetbrains-light.json';
import nordDarkRaw from './nord-dark.json';
import nordLightRaw from './nord-light.json';
import monoPlusDarkRaw from './mono-plus-dark.json';
import monoPlusLightRaw from './mono-plus-light.json';

export const presetThemes: Theme[] = [
  jetbrainsDarkRaw as Theme,
  jetbrainsLightRaw as Theme,
  nordDarkRaw as Theme,
  nordLightRaw as Theme,
  monoPlusDarkRaw as Theme,
  monoPlusLightRaw as Theme,
].map((theme) => withPrColors(theme));
