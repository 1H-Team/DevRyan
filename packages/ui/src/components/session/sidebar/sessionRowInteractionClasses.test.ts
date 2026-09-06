import { describe, expect, test } from 'bun:test';
import {
  resolveMobileSessionSwipeAction,
  resolveSessionRowInteractionClasses,
} from './sessionRowInteractionClasses';

describe('resolveSessionRowInteractionClasses', () => {
  test('reserves hover space for both quick actions', () => {
    const classes = resolveSessionRowInteractionClasses();

    expect(classes.revealOnHoverClass).toContain('group-hover:opacity-100');
    expect(classes.revealOnHoverClass).toContain('group-hover:pointer-events-auto');
    expect(classes.revealOnHoverClass).not.toContain('group-focus-within');
    expect(classes.hideOnHoverClass).toBe('group-hover:opacity-0');
    expect(classes.revealPaddingClass).toBe('group-hover:pr-[var(--session-row-action-padding,3rem)]');
    expect(classes.revealPaddingClass).not.toContain('group-focus-within');
  });
});

describe('resolveMobileSessionSwipeAction', () => {
  test('reveals actions after a decisive left swipe', () => {
    expect(resolveMobileSessionSwipeAction(-52, 4)).toBe('reveal');
  });

  test('hides actions after a decisive right swipe', () => {
    expect(resolveMobileSessionSwipeAction(52, 4)).toBe('hide');
  });

  test('ignores short and vertically ambiguous gestures', () => {
    expect(resolveMobileSessionSwipeAction(-30, 2)).toBeNull();
    expect(resolveMobileSessionSwipeAction(-52, 48)).toBeNull();
  });
});
