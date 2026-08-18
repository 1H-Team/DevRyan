import { describe, expect, test } from 'bun:test';

import {
  TOOL_OUTPUT_FOLLOW_THRESHOLD_PX,
  isWithinToolOutputBottomThreshold,
} from './toolScrollFollow';

describe('tool output follow threshold', () => {
  test('re-enters follow mode only within 24 pixels of the bottom', () => {
    expect(TOOL_OUTPUT_FOLLOW_THRESHOLD_PX).toBe(24);
    expect(isWithinToolOutputBottomThreshold(1_000, 576, 400)).toBe(true);
    expect(isWithinToolOutputBottomThreshold(1_000, 575, 400)).toBe(false);
  });

  test('treats exact and overscrolled bottoms as pinned', () => {
    expect(isWithinToolOutputBottomThreshold(500, 300, 200)).toBe(true);
    expect(isWithinToolOutputBottomThreshold(500, 310, 200)).toBe(true);
  });
});
