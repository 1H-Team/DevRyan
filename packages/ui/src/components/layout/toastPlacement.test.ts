import { describe, expect, test } from 'bun:test';

import { resolveAdaptiveToastPlacement } from './toastPlacement';

describe('native-surface-aware toast placement', () => {
  test('keeps the default bottom-right placement without a native surface', () => {
    const placement = resolveAdaptiveToastPlacement(1280, null);
    expect(placement.position).toBe('bottom-right');
    expect(placement.width).toBe(356);
    expect(placement.edge).toBe('default');
  });

  test('uses the larger renderer-only edge to the left of Browser', () => {
    expect(resolveAdaptiveToastPlacement(1632, {
      x: 582,
      y: 90,
      width: 750,
      height: 700,
      right: 1332,
      bottom: 790,
    })).toEqual({
      position: 'bottom-right',
      offset: { right: 1066, bottom: 16 },
      width: 356,
      edge: 'left',
    });
  });

  test('uses a sufficiently wide right edge', () => {
    expect(resolveAdaptiveToastPlacement(1200, {
      x: 100,
      y: 90,
      width: 700,
      height: 600,
      right: 800,
      bottom: 690,
    }).edge).toBe('right');
  });

  test('falls back to one toast in top chrome when neither side is usable', () => {
    const placement = resolveAdaptiveToastPlacement(800, {
      x: 180,
      y: 100,
      width: 500,
      height: 600,
      right: 680,
      bottom: 700,
    });
    expect(placement.position).toBe('top-center');
    expect(placement.visibleToasts).toBe(1);
    expect(placement.edge).toBe('top');
  });
});
