import { describe, expect, test } from 'bun:test';

import { pointInFrame } from './botComputerCoordinates';

const canvas = (rect: { left: number; top: number; width: number; height: number }) => ({
  getBoundingClientRect: () => ({
    ...rect,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    x: rect.left,
    y: rect.top,
    toJSON: () => ({}),
  }),
}) as HTMLCanvasElement;

describe('Bot computer canvas coordinate translation', () => {
  test('maps through the object-contain rectangle and ignores letterboxing', () => {
    const target = canvas({ left: 10, top: 20, width: 1000, height: 1000 });
    const geometry = { width: 1280, height: 720, deviceScaleFactor: 1 };
    expect(pointInFrame(target, geometry, 510, 520)).toEqual({ x: 640, y: 360 });
    expect(pointInFrame(target, geometry, 510, 100)).toBeNull();
  });

  test('preserves fractional coordinates at device scale factor one', () => {
    const target = canvas({ left: 0, top: 0, width: 1280, height: 720 });
    expect(pointInFrame(
      target,
      { width: 1280, height: 720, deviceScaleFactor: 1 },
      12.5,
      25.25,
    )).toEqual({ x: 12.5, y: 25.25 });
  });
});
