import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

import {
  calculateOverlayScrollbarThumb,
  isPersistentDesktopOverlayScrollbar,
  resolvePersistentOverlayScrollbarVisibility,
  scheduleOverlayScrollbarAutoHide,
} from './overlayScrollbarBehavior';

const classList = (...names: string[]): Pick<DOMTokenList, 'contains'> => ({
  contains: (name) => names.includes(name),
});

const createFakeTimers = () => {
  const pending: Array<{ callback: () => void; delay: number }> = [];
  const setTimer = ((callback: TimerHandler, delay?: number) => {
    pending.push({ callback: callback as () => void, delay: Number(delay) || 0 });
    return pending.length;
  }) as typeof setTimeout;
  return {
    setTimer,
    advanceBy(milliseconds: number) {
      const ready = pending.filter((timer) => timer.delay <= milliseconds);
      pending.splice(0, ready.length);
      for (const timer of ready) timer.callback();
    },
    count: () => pending.length,
  };
};

describe('overlay scrollbar desktop persistence', () => {
  test('keeps a standard desktop scrollbar visible beyond the hide delay', () => {
    const timers = createFakeTimers();
    let visible = true;
    const persistent = isPersistentDesktopOverlayScrollbar(false, classList('desktop-runtime'));

    const timer = scheduleOverlayScrollbarAutoHide(
      persistent,
      1000,
      () => { visible = false; },
      timers.setTimer,
    );
    timers.advanceBy(10_000);

    expect(timer).toBeNull();
    expect(timers.count()).toBe(0);
    expect(visible).toBe(true);
  });

  test('auto-hides web/mobile and desktop user-intent-only scrollbars', () => {
    for (const persistent of [
      isPersistentDesktopOverlayScrollbar(false, classList()),
      isPersistentDesktopOverlayScrollbar(false, classList('mobile-runtime')),
      isPersistentDesktopOverlayScrollbar(true, classList('desktop-runtime')),
    ]) {
      const timers = createFakeTimers();
      let visible = true;
      scheduleOverlayScrollbarAutoHide(persistent, 1000, () => { visible = false; }, timers.setTimer);
      timers.advanceBy(1000);
      expect(persistent).toBe(false);
      expect(visible).toBe(false);
    }
  });

  test('programmatic suppression wins and no-overflow metrics stay hidden', () => {
    expect(resolvePersistentOverlayScrollbarVisibility(true, true, true)).toBe(false);
    expect(resolvePersistentOverlayScrollbarVisibility(true, false, false)).toBe(false);
    expect(resolvePersistentOverlayScrollbarVisibility(true, false, true)).toBe(true);
    expect(calculateOverlayScrollbarThumb({
      scrollLength: 400,
      clientLength: 400,
      scrollOffset: 0,
      minThumbSize: 32,
    })).toEqual({ length: 0, offset: 0 });
  });

  test('preserves horizontal thumb metrics', () => {
    const horizontal = calculateOverlayScrollbarThumb({
      scrollLength: 1000,
      clientLength: 400,
      scrollOffset: 300,
      minThumbSize: 32,
    });
    expect(horizontal.length > 0).toBe(true);
    expect(horizontal.offset > 0).toBe(true);
  });

  // Dragging, pointer capture, mutation observation and intent gating are exercised by
  // OverlayScrollbar.mounted.test.tsx. The call sites below live in surfaces that cannot be
  // rendered in isolation, so their wiring stays a source pin.
  test('is wired into the chat, terminal and changes scroll surfaces', () => {
    const chat = readFileSync('src/components/chat/ChatContainer.tsx', 'utf8');
    const terminal = readFileSync('src/components/terminal/TerminalViewport.tsx', 'utf8');
    const changes = readFileSync('src/components/views/git/ChangesSection.tsx', 'utf8');
    expect(chat).toContain('suppressVisibility={isProgrammaticFollowActive} userIntentOnly');
    expect(terminal).toContain('<OverlayScrollbar');
    expect(changes).toContain('<OverlayScrollbar');
  });

  test('hides settings overlay scrollbars only outside desktop', () => {
    const css = readFileSync('src/index.css', 'utf8');
    expect(css).toContain(':root:not(.desktop-runtime)\n  [data-settings-view="true"]\n  .overlay-scrollbar');
    expect(css).not.toContain('\n[data-settings-view="true"] .overlay-scrollbar');
  });
});
