import type { BotMjpegFrame } from './mjpegStream';

export type FrameGeometry = Pick<BotMjpegFrame, 'width' | 'height' | 'deviceScaleFactor'>;

export const pointInFrame = (
  canvas: HTMLCanvasElement,
  geometry: FrameGeometry,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null => {
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const scale = Math.min(rect.width / geometry.width, rect.height / geometry.height);
  const width = geometry.width * scale;
  const height = geometry.height * scale;
  const left = rect.left + (rect.width - width) / 2;
  const top = rect.top + (rect.height - height) / 2;
  if (clientX < left || clientX > left + width || clientY < top || clientY > top + height) {
    return null;
  }
  return {
    x: Math.min(geometry.width, Math.max(0, (clientX - left) / scale)),
    y: Math.min(geometry.height, Math.max(0, (clientY - top) / scale)),
  };
};
