export const MAX_VISIBLE_COMPOSER_LINES = 8;

const FALLBACK_LINE_HEIGHT = 22;
const FALLBACK_VERTICAL_PADDING = 16;

type ComposerTextareaMetrics = {
  scrollHeight: number;
  offsetHeight: number;
  lineHeight: number;
  paddingTop: number;
  paddingBottom: number;
};

export type ComposerTextareaSize = {
  height: number;
  maxHeight: number;
};

export const resolveComposerTextareaSize = (
  metrics: ComposerTextareaMetrics,
): ComposerTextareaSize => {
  const lineHeight = Number.isFinite(metrics.lineHeight)
    ? metrics.lineHeight
    : FALLBACK_LINE_HEIGHT;
  const paddingTotal = Number.isFinite(metrics.paddingTop) && Number.isFinite(metrics.paddingBottom)
    ? metrics.paddingTop + metrics.paddingBottom
    : FALLBACK_VERTICAL_PADDING;
  const maxHeight = lineHeight * MAX_VISIBLE_COMPOSER_LINES + paddingTotal;
  const contentHeight = metrics.scrollHeight || metrics.offsetHeight;

  return {
    height: Math.min(contentHeight, maxHeight),
    maxHeight,
  };
};
