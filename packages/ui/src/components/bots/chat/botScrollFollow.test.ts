import { describe, expect, test } from 'bun:test';

import {
  BOT_AUTO_FOLLOW_THRESHOLD_PX,
  isWithinBotAutoFollowThreshold,
  restoreBotPrependScrollTop,
} from './botScrollFollow';

describe('Bot transcript auto-follow policy', () => {
  test('follows only inside the bottom threshold', () => {
    expect(isWithinBotAutoFollowThreshold(1_000, 504, 400)).toBe(true);
    expect(isWithinBotAutoFollowThreshold(1_000, 503, 400)).toBe(false);
    expect(BOT_AUTO_FOLLOW_THRESHOLD_PX).toBe(96);
  });

  test('repins when the reader returns to the bottom', () => {
    expect(isWithinBotAutoFollowThreshold(1_000, 200, 400)).toBe(false);
    expect(isWithinBotAutoFollowThreshold(1_000, 600, 400)).toBe(true);
  });

  test('preserves the visible anchor when older content is prepended', () => {
    expect(restoreBotPrependScrollTop({
      previousScrollHeight: 1_000,
      previousScrollTop: 120,
      nextScrollHeight: 1_480,
    })).toBe(600);
    expect(restoreBotPrependScrollTop({
      previousScrollHeight: 1_000,
      previousScrollTop: 120,
      nextScrollHeight: 980,
    })).toBe(120);
  });
});
