export type OverlayScrollbarThumbMetrics = {
  length: number;
  offset: number;
};

const EMPTY_THUMB: OverlayScrollbarThumbMetrics = { length: 0, offset: 0 };

export const calculateOverlayScrollbarThumb = ({
  scrollLength,
  clientLength,
  scrollOffset,
  minThumbSize,
  trackInset = 8,
}: {
  scrollLength: number;
  clientLength: number;
  scrollOffset: number;
  minThumbSize: number;
  trackInset?: number;
}): OverlayScrollbarThumbMetrics => {
  if (scrollLength <= clientLength) return EMPTY_THUMB;
  const trackLength = Math.max(clientLength - trackInset * 2, 0);
  const rawThumb = (clientLength / scrollLength) * trackLength;
  const length = Math.max(minThumbSize, Math.min(trackLength, rawThumb));
  const maxOffset = Math.max(trackLength - length, 0);
  const maxScroll = Math.max(scrollLength - clientLength, 1);
  return { length, offset: (scrollOffset / maxScroll) * maxOffset };
};

export const isPersistentDesktopOverlayScrollbar = (
  userIntentOnly: boolean,
  rootClassList: Pick<DOMTokenList, 'contains'> | undefined = typeof document !== 'undefined'
    ? document.documentElement.classList
    : undefined,
): boolean => !userIntentOnly && rootClassList?.contains('desktop-runtime') === true;

export const scheduleOverlayScrollbarAutoHide = (
  persistentVisibility: boolean,
  hideDelayMs: number,
  hide: () => void,
  setTimer: typeof setTimeout = setTimeout,
): ReturnType<typeof setTimeout> | null => {
  if (persistentVisibility) return null;
  return setTimer(hide, hideDelayMs);
};

export const resolvePersistentOverlayScrollbarVisibility = (
  persistentVisibility: boolean,
  suppressVisibility: boolean,
  hasOverflow: boolean,
): boolean => persistentVisibility && !suppressVisibility && hasOverflow;
