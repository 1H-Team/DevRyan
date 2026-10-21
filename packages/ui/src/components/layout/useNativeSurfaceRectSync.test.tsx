import React, { act } from 'react';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { HostElement, withDom } from '@/components/bots/chat/botMountedDom';
import { useNativeSurfaceRectSync, type NativeSurfaceRect } from './useNativeSurfaceRectSync';

type Frame = () => void;

// Deterministic browser: manual animation frames, timers and intervals, with
// real EventTargets so listener registration and removal are observable.
const createBrowser = () => {
  const windowTarget = new EventTarget();
  const documentTarget = new EventTarget();
  const frames = new Map<number, Frame>();
  const timers = new Map<number, { callback: () => void; due: number }>();
  const intervals = new Map<number, { callback: () => void; every: number }>();
  const resizeObservers: Array<{ callback: () => void; targets: unknown[]; disconnected: boolean }> = [];
  let nextId = 1;
  let now = 0;
  let rect = { left: 10, top: 20, width: 300, height: 200, bottom: 220 };
  const listenerCounts = new Map<string, number>();
  const track = (target: EventTarget, prefix: string) => ({
    addEventListener: (type: string, listener: EventListener, options?: unknown) => {
      listenerCounts.set(`${prefix}:${type}`, (listenerCounts.get(`${prefix}:${type}`) ?? 0) + 1);
      target.addEventListener(type, listener, options as boolean);
    },
    removeEventListener: (type: string, listener: EventListener, options?: unknown) => {
      listenerCounts.set(`${prefix}:${type}`, (listenerCounts.get(`${prefix}:${type}`) ?? 0) - 1);
      target.removeEventListener(type, listener, options as boolean);
    },
  });

  return {
    windowTarget,
    documentTarget,
    resizeObservers,
    listenerCounts,
    setRect: (next: Partial<typeof rect>) => { rect = { ...rect, ...next }; },
    getRect: () => rect,
    pendingFrames: () => frames.size,
    pendingTimers: () => timers.size,
    intervalPeriods: () => [...intervals.values()].map((entry) => entry.every),
    track,
    api: {
      requestAnimationFrame: (callback: Frame) => { const id = nextId++; frames.set(id, callback); return id; },
      cancelAnimationFrame: (id: number) => { frames.delete(id); },
      setInterval: (callback: () => void, every: number) => { const id = nextId++; intervals.set(id, { callback, every }); return id; },
      clearInterval: (id: number) => { intervals.delete(id); },
      setTimeout: (callback: () => void, delay: number) => { const id = nextId++; timers.set(id, { callback, due: now + delay }); return id; },
      clearTimeout: (id: number) => { timers.delete(id); },
    },
    runFrame: () => {
      const pending = [...frames.entries()];
      frames.clear();
      for (const [, callback] of pending) callback();
    },
    tickInterval: () => { for (const entry of [...intervals.values()]) entry.callback(); },
    advance: (milliseconds: number) => {
      now += milliseconds;
      for (const [id, timer] of [...timers.entries()]) {
        if (timer.due <= now) { timers.delete(id); timer.callback(); }
      }
    },
  };
};

class FakeTransitionEvent extends Event {
  propertyName: string;
  constructor(type: string, init: { propertyName: string }) { super(type); this.propertyName = init.propertyName; }
}
class FakePointerEvent extends Event {
  constructor(type: string, private readonly pointerTarget: unknown) { super(type); }
  override get target() { return this.pointerTarget as EventTarget; }
}
class FakeElement extends EventTarget {
  constructor(private readonly insideResizeHandle: boolean) { super(); }
  closest(selector: string) { return selector === '[data-panel-resize-handle]' && this.insideResizeHandle ? this : null; }
}

const Probe: React.FC<{ onRect: (rect: NativeSurfaceRect) => void }> = ({ onRect }) => {
  const ref = React.useRef<HTMLDivElement | null>(null);
  useNativeSurfaceRectSync(ref, onRect);
  return <div ref={ref} />;
};

const withBrowser = async (
  options: { resizeObserver?: boolean },
  run: (ctx: {
    browser: ReturnType<typeof createBrowser>;
    rects: NativeSurfaceRect[];
    visibility: { state: 'visible' | 'hidden' };
    unmount: () => Promise<void>;
  }) => Promise<void>,
) => withDom(async (container) => {
  const browser = createBrowser();
  const host = globalThis as unknown as Record<string, unknown> & { window: Record<string, unknown>; document: Record<string, unknown> };
  const visibility = { state: 'visible' as 'visible' | 'hidden' };
  const savedGlobals = ['TransitionEvent', 'Element', 'ResizeObserver'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const savedRect = HostElement.prototype.getBoundingClientRect;
  Object.assign(host.window, browser.api, browser.track(browser.windowTarget, 'window'));
  Object.assign(host.document, browser.track(browser.documentTarget, 'document'));
  Object.defineProperty(host.document, 'visibilityState', { configurable: true, get: () => visibility.state });
  Object.defineProperty(globalThis, 'TransitionEvent', { configurable: true, writable: true, value: FakeTransitionEvent });
  Object.defineProperty(globalThis, 'Element', { configurable: true, writable: true, value: FakeElement });
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: options.resizeObserver === false ? undefined : class {
      record: { callback: () => void; targets: unknown[]; disconnected: boolean };
      constructor(callback: () => void) { this.record = { callback, targets: [], disconnected: false }; browser.resizeObservers.push(this.record); }
      observe(target: unknown) { this.record.targets.push(target); }
      disconnect() { this.record.disconnected = true; }
    },
  });
  HostElement.prototype.getBoundingClientRect = function getBoundingClientRect() { return browser.getRect() as never; };
  const originalTimers = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  const rects: NativeSurfaceRect[] = [];
  const onRect = (rect: NativeSurfaceRect) => rects.push(rect);
  let mounted = true;
  const unmount = async () => { if (!mounted) return; mounted = false; await act(async () => { root.unmount(); }); };
  try {
    await act(async () => { root.render(<Probe onRect={onRect} />); });
    // Only the hook's timers are faked: React and the test runner keep real ones.
    globalThis.setTimeout = browser.api.setTimeout as never;
    globalThis.clearTimeout = browser.api.clearTimeout as never;
    await run({ browser, rects, visibility, unmount });
  } finally {
    globalThis.setTimeout = originalTimers.setTimeout;
    globalThis.clearTimeout = originalTimers.clearTimeout;
    await unmount();
    HostElement.prototype.getBoundingClientRect = savedRect;
    for (const [key, descriptor] of savedGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});

const widthTransition = (type: string, propertyName = 'width') => new FakeTransitionEvent(type, { propertyName });

describe('native browser surface rect synchronization', () => {
  test('reports the rounded rectangle once on mount and only again when it changes', async () => {
    await withBrowser({}, async ({ browser, rects }) => {
      expect(rects).toEqual([{ x: 10, y: 20, width: 300, height: 200, bottom: 220 }]);

      await act(async () => { browser.tickInterval(); });
      expect(rects).toHaveLength(1);

      browser.setRect({ left: 10.4, width: 300.4 });
      await act(async () => { browser.tickInterval(); });
      expect(rects).toHaveLength(1);

      browser.setRect({ left: 10.6, width: 340 });
      await act(async () => { browser.tickInterval(); });
      expect(rects).toHaveLength(2);
      expect(rects[1]).toEqual({ x: 11, y: 20, width: 340, height: 200, bottom: 220 });
    });
  });

  test('never reports a negative size', async () => {
    await withBrowser({}, async ({ browser, rects }) => {
      browser.setRect({ width: -5, height: -1 });
      await act(async () => { browser.tickInterval(); });
      expect(rects.at(-1)).toMatchObject({ width: 0, height: 0 });
    });
  });

  test('observes the element for resizes and coalesces bursts into one frame', async () => {
    await withBrowser({}, async ({ browser, rects }) => {
      expect(browser.resizeObservers).toHaveLength(1);
      expect(browser.resizeObservers[0].targets).toHaveLength(1);
      expect(browser.pendingFrames()).toBe(0);

      browser.setRect({ width: 500 });
      browser.resizeObservers[0].callback();
      browser.resizeObservers[0].callback();
      browser.windowTarget.dispatchEvent(new Event('resize'));
      expect(browser.pendingFrames()).toBe(1);
      expect(rects).toHaveLength(1);

      await act(async () => { browser.runFrame(); });
      expect(rects).toHaveLength(2);
      expect(rects[1].width).toBe(500);
      expect(browser.pendingFrames()).toBe(0);
    });
  });

  test('still follows window resizes when ResizeObserver is unavailable', async () => {
    await withBrowser({ resizeObserver: false }, async ({ browser, rects }) => {
      expect(browser.resizeObservers).toHaveLength(0);
      browser.setRect({ height: 400, bottom: 420 });
      browser.windowTarget.dispatchEvent(new Event('resize'));
      await act(async () => { browser.runFrame(); });
      expect(rects.at(-1)).toMatchObject({ height: 400 });
    });
  });

  test('tracks width transitions with a per-frame loop that settles after the transition ends', async () => {
    await withBrowser({}, async ({ browser, rects }) => {
      browser.documentTarget.dispatchEvent(widthTransition('transitionrun'));
      expect(browser.pendingFrames()).toBe(1);

      for (const width of [320, 360, 400]) {
        browser.setRect({ width });
        await act(async () => { browser.runFrame(); });
      }
      expect(rects.map((rect) => rect.width)).toEqual([300, 320, 360, 400]);
      expect(browser.pendingFrames()).toBe(1);

      browser.documentTarget.dispatchEvent(widthTransition('transitionend'));
      browser.setRect({ width: 420 });
      await act(async () => { browser.advance(80); });
      // The settle timer takes one last measurement and ends the loop.
      expect(rects.at(-1)?.width).toBe(420);
      expect(browser.pendingFrames()).toBe(0);
      expect(browser.pendingTimers()).toBe(0);
    });
  });

  test('ignores transitions of other properties', async () => {
    await withBrowser({}, async ({ browser }) => {
      for (const type of ['transitionrun', 'transitionstart']) {
        browser.documentTarget.dispatchEvent(widthTransition(type, 'opacity'));
      }
      expect(browser.pendingFrames()).toBe(0);
      expect(browser.pendingTimers()).toBe(0);
    });
  });

  test('bounds the loop with a hard stop even if no transition end ever arrives', async () => {
    await withBrowser({}, async ({ browser }) => {
      browser.documentTarget.dispatchEvent(widthTransition('transitionstart'));
      expect(browser.pendingFrames()).toBe(1);

      await act(async () => { browser.advance(999); });
      expect(browser.pendingFrames()).toBe(1);
      await act(async () => { browser.advance(1); });
      expect(browser.pendingFrames()).toBe(0);
      expect(browser.pendingTimers()).toBe(0);
    });
  });

  test('tracks imperative panel drags only when the pointer goes down on a resize handle', async () => {
    await withBrowser({}, async ({ browser, rects }) => {
      const elsewhere = new FakePointerEvent('pointerdown', new FakeElement(false));
      browser.documentTarget.dispatchEvent(elsewhere);
      expect(browser.pendingFrames()).toBe(0);

      const onHandle = new FakePointerEvent('pointerdown', new FakeElement(true));
      browser.documentTarget.dispatchEvent(onHandle);
      expect(browser.pendingFrames()).toBe(1);

      browser.setRect({ width: 280 });
      await act(async () => { browser.runFrame(); });
      expect(rects.at(-1)?.width).toBe(280);

      browser.documentTarget.dispatchEvent(new Event('pointerup'));
      await act(async () => { browser.advance(80); });
      expect(browser.pendingFrames()).toBe(0);
    });
  });

  test('polls on a quarter-second safety interval and skips measuring while the page is hidden', async () => {
    await withBrowser({}, async ({ browser, rects, visibility }) => {
      expect(browser.intervalPeriods()).toEqual([250]);

      visibility.state = 'hidden';
      browser.setRect({ width: 123 });
      await act(async () => { browser.tickInterval(); });
      expect(rects).toHaveLength(1);

      visibility.state = 'visible';
      await act(async () => { browser.tickInterval(); });
      expect(rects.at(-1)?.width).toBe(123);
    });
  });

  test('releases every listener, frame, timer, interval and observer on unmount', async () => {
    await withBrowser({}, async ({ browser, unmount }) => {
      browser.documentTarget.dispatchEvent(widthTransition('transitionrun'));
      browser.resizeObservers[0].callback();
      expect(browser.pendingFrames()).toBeGreaterThan(0);

      await unmount();

      expect(browser.pendingFrames()).toBe(0);
      expect(browser.pendingTimers()).toBe(0);
      expect(browser.intervalPeriods()).toEqual([]);
      expect(browser.resizeObservers[0].disconnected).toBe(true);
      const leaked = [...browser.listenerCounts.entries()].filter(([key, count]) => /^(window:resize|document:(transition|pointer))/.test(key) && count !== 0);
      expect(leaked).toEqual([]);
    });
  });
});

// DesktopBrowserPane owns native-surface layout through this hook, but it cannot be
// rendered without the desktop bridge, so the single wiring line stays a source pin.
describe('native surface rect sync wiring', () => {
  test('is used by the Electron browser pane', () => {
    const browserPane = readFileSync(new URL('./DesktopBrowserPane.tsx', import.meta.url), 'utf8');

    expect(browserPane).toContain('useNativeSurfaceRectSync(contentRef, syncLayout);');
  });
});
