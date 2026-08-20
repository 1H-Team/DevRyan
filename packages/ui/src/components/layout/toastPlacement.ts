import type { NativeSurfaceOccupancyRect } from './nativeSurfaceOccupancy';

export type AdaptiveToastPlacement = {
  position: 'bottom-right' | 'top-center';
  offset: { top?: number; right?: number; bottom?: number };
  width: number;
  visibleToasts?: number;
  edge: 'default' | 'left' | 'right' | 'top';
};

const TOAST_WIDTH = 356;
const TOAST_MARGIN = 16;
const MIN_SIDE_WIDTH = 240;

export const resolveAdaptiveToastPlacement = (
  viewportWidth: number,
  surface: NativeSurfaceOccupancyRect | null,
): AdaptiveToastPlacement => {
  const width = Number.isFinite(viewportWidth) ? Math.max(1, viewportWidth) : TOAST_WIDTH + TOAST_MARGIN * 2;
  const defaultWidth = Math.min(TOAST_WIDTH, Math.max(1, width - TOAST_MARGIN * 2));
  if (!surface) {
    return {
      position: 'bottom-right',
      offset: { right: TOAST_MARGIN, bottom: TOAST_MARGIN },
      width: defaultWidth,
      edge: 'default',
    };
  }

  const leftSpace = Math.max(0, surface.x);
  const rightSpace = Math.max(0, width - surface.right);
  const useLeft = leftSpace >= MIN_SIDE_WIDTH && leftSpace >= rightSpace;
  const useRight = rightSpace >= MIN_SIDE_WIDTH && rightSpace > leftSpace;

  if (useLeft) {
    return {
      position: 'bottom-right',
      offset: { right: Math.max(TOAST_MARGIN, width - surface.x + TOAST_MARGIN), bottom: TOAST_MARGIN },
      width: Math.min(TOAST_WIDTH, Math.max(1, leftSpace - TOAST_MARGIN * 2)),
      edge: 'left',
    };
  }
  if (useRight) {
    return {
      position: 'bottom-right',
      offset: { right: TOAST_MARGIN, bottom: TOAST_MARGIN },
      width: Math.min(TOAST_WIDTH, Math.max(1, rightSpace - TOAST_MARGIN * 2)),
      edge: 'right',
    };
  }

  return {
    position: 'top-center',
    offset: { top: TOAST_MARGIN },
    width: defaultWidth,
    visibleToasts: 1,
    edge: 'top',
  };
};
