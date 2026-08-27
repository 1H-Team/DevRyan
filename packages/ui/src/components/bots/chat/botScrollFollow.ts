export const BOT_AUTO_FOLLOW_THRESHOLD_PX = 96;

export const isWithinBotAutoFollowThreshold = (
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  threshold = BOT_AUTO_FOLLOW_THRESHOLD_PX,
): boolean => scrollHeight - scrollTop - clientHeight <= threshold;

export const restoreBotPrependScrollTop = ({
  previousScrollHeight,
  previousScrollTop,
  nextScrollHeight,
}: {
  previousScrollHeight: number;
  previousScrollTop: number;
  nextScrollHeight: number;
}): number => previousScrollTop + Math.max(0, nextScrollHeight - previousScrollHeight);
