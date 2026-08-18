import { describe, expect, test } from 'bun:test';

import {
  BROWSER_VIEWPORT_PRESETS,
  CONTEXT_PANEL_RESIZE_GUTTER_PX,
  resolveBrowserViewportLayout,
  sanitizeBrowserViewportMode,
} from './browserViewport';

describe('browser viewport layout', () => {
  test('fills the available canvas in responsive mode', () => {
    expect(resolveBrowserViewportLayout(600, 700, 'responsive')).toEqual({
      mode: 'responsive',
      cssWidth: 600,
      cssHeight: 700,
      renderedWidth: 600,
      renderedHeight: 700,
      offsetX: 0,
      offsetY: 0,
      scale: 1,
    });
  });

  test('scales the desktop preset down uniformly and centers it', () => {
    const layout = resolveBrowserViewportLayout(720, 700, 'desktop');
    expect(BROWSER_VIEWPORT_PRESETS.desktop).toEqual({ width: 1440, height: 900 });
    expect(layout.scale).toBe(0.5);
    expect(layout.renderedWidth).toBe(720);
    expect(layout.renderedHeight).toBe(450);
    expect(layout.offsetX).toBe(0);
    expect(layout.offsetY).toBe(125);
  });

  test('never scales the mobile preset above its native size', () => {
    const layout = resolveBrowserViewportLayout(1000, 1000, 'mobile');
    expect(BROWSER_VIEWPORT_PRESETS.mobile).toEqual({ width: 390, height: 844 });
    expect(layout.scale).toBe(1);
    expect(layout.renderedWidth).toBe(390);
    expect(layout.renderedHeight).toBe(844);
    expect(layout.offsetX).toBe(305);
    expect(layout.offsetY).toBe(78);
  });

  test('defaults persisted and unknown values to responsive', () => {
    expect(sanitizeBrowserViewportMode('desktop')).toBe('desktop');
    expect(sanitizeBrowserViewportMode('mobile')).toBe('mobile');
    expect(sanitizeBrowserViewportMode('tablet')).toBe('responsive');
    expect(sanitizeBrowserViewportMode(undefined)).toBe('responsive');
  });

  test('keeps degenerate panel canvases renderable and reserves an 8px resize gutter', () => {
    const layout = resolveBrowserViewportLayout(0, Number.NaN, 'responsive');
    expect(layout.cssWidth).toBe(1);
    expect(layout.cssHeight).toBe(1);
    expect(CONTEXT_PANEL_RESIZE_GUTTER_PX).toBe(8);
  });
});
