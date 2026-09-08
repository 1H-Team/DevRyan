import { describe, expect, test } from 'bun:test';
import { shouldPreserveWorkingStatus } from './workingPlaceholderStatus';

describe('authoritative working-status transitions', () => {
  test('replaces a completed or failed tool label with generic work', () => {
    expect(shouldPreserveWorkingStatus(
      { text: 'using Context Mode: Index', permission: false, generic: false },
      { text: 'working', permission: false, generic: true },
    )).toBe(false);
  });
  test('suppresses generic wording churn once generic work is actually displayed', () => {
    expect(shouldPreserveWorkingStatus(
      { text: 'working', permission: false, generic: true },
      { text: 'processing', permission: false, generic: true },
    )).toBe(true);
  });
  test('does not keep a cleared permission wait or hide a newly active tool', () => {
    expect(shouldPreserveWorkingStatus(
      { text: 'waiting for permission', permission: true, generic: false },
      { text: 'working', permission: false, generic: true },
    )).toBe(false);
    expect(shouldPreserveWorkingStatus(
      { text: 'working', permission: false, generic: true },
      { text: 'using Context Mode: Search', permission: false, generic: false },
    )).toBe(false);
  });
  test('retains identical live labels without rescheduling their minimum duration', () => {
    const status = { text: 'using Context Mode: Index', permission: false, generic: false };
    expect(shouldPreserveWorkingStatus(status, status)).toBe(true);
  });
});
