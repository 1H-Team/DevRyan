export type BrowserViewportMode = 'responsive' | 'desktop' | 'mobile';

export type BrowserViewportPreset = {
  width: number;
  height: number;
};

export type BrowserViewportLayout = {
  mode: BrowserViewportMode;
  cssWidth: number;
  cssHeight: number;
  renderedWidth: number;
  renderedHeight: number;
  offsetX: number;
  offsetY: number;
  scale: number;
};

export const CONTEXT_PANEL_RESIZE_GUTTER_PX = 8;

export const BROWSER_VIEWPORT_PRESETS: Readonly<Record<Exclude<BrowserViewportMode, 'responsive'>, BrowserViewportPreset>> = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};

export const sanitizeBrowserViewportMode = (value: unknown): BrowserViewportMode => (
  value === 'desktop' || value === 'mobile' ? value : 'responsive'
);

const finiteDimension = (value: number): number => (
  Number.isFinite(value) ? Math.max(1, value) : 1
);

export const resolveBrowserViewportLayout = (
  availableWidth: number,
  availableHeight: number,
  mode: BrowserViewportMode,
): BrowserViewportLayout => {
  const width = finiteDimension(availableWidth);
  const height = finiteDimension(availableHeight);

  if (mode === 'responsive') {
    return {
      mode,
      cssWidth: width,
      cssHeight: height,
      renderedWidth: width,
      renderedHeight: height,
      offsetX: 0,
      offsetY: 0,
      scale: 1,
    };
  }

  const preset = BROWSER_VIEWPORT_PRESETS[mode];
  const scale = Math.min(1, width / preset.width, height / preset.height);
  const renderedWidth = preset.width * scale;
  const renderedHeight = preset.height * scale;

  return {
    mode,
    cssWidth: preset.width,
    cssHeight: preset.height,
    renderedWidth,
    renderedHeight,
    offsetX: Math.max(0, (width - renderedWidth) / 2),
    offsetY: Math.max(0, (height - renderedHeight) / 2),
    scale,
  };
};
