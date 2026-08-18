export const DEFAULT_CHAT_WIDTH = 640;
export const WIDE_CHAT_WIDTH = 1024;
export const MIN_CHAT_WIDTH = 640;
export const MAX_CHAT_WIDTH = 1408;
export const CHAT_WIDTH_STEP = 16;

export const clampChatWidth = (value: number): number => {
  if (!Number.isFinite(value)) {
    return DEFAULT_CHAT_WIDTH;
  }

  const clamped = Math.max(MIN_CHAT_WIDTH, Math.min(MAX_CHAT_WIDTH, value));
  return MIN_CHAT_WIDTH + Math.round((clamped - MIN_CHAT_WIDTH) / CHAT_WIDTH_STEP) * CHAT_WIDTH_STEP;
};

export const applyChatWidth = (root: HTMLElement, width: number): void => {
  if (width === DEFAULT_CHAT_WIDTH) {
    root.style.removeProperty('--chat-column-width');
    return;
  }

  root.style.setProperty('--chat-column-width', `${width}px`);
};
