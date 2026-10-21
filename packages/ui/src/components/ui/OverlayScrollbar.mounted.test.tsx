import React, { act } from 'react';
import { describe, expect, test } from 'bun:test';
import { HostElement, withDom } from '@/components/bots/chat/botMountedDom';
import { OverlayScrollbar } from './OverlayScrollbar';

type Props = Partial<React.ComponentProps<typeof OverlayScrollbar>>;

type Frames = { run: () => void; cancelled: number };

const mountScrollbar = async (
  props: Props,
  geometry: { scrollHeight?: number; clientHeight?: number; scrollWidth?: number; clientWidth?: number },
  run: (ctx: {
    scroller: HostElement;
    mutationObservers: Array<{ targets: unknown[]; options: unknown[] }>;
    resizeTargets: unknown[];
    frames: Frames;
    captured: string[];
    thumb: (axis: 'vertical' | 'horizontal') => HostElement | null;
    root: HostElement;
    pointer: (target: HostElement, type: string, init: { clientX?: number; clientY?: number }) => Promise<void>;
  }) => Promise<void>,
) => withDom(async (container) => {
  const queued = new Map<number, () => void>();
  let nextFrame = 1;
  let cancelled = 0;
  const frames: Frames = {
    get cancelled() { return cancelled; },
    run: () => { const pending = [...queued.values()]; queued.clear(); for (const callback of pending) callback(); },
  } as Frames;
  const savedGlobals = ['requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver', 'ResizeObserver'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const mutationObservers: Array<{ targets: unknown[]; options: unknown[] }> = [];
  const resizeTargets: unknown[] = [];
  const captured: string[] = [];
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, writable: true, value: (callback: () => void) => { const id = nextFrame++; queued.set(id, callback); return id; } });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, writable: true, value: (id: number) => { if (queued.delete(id)) cancelled += 1; } });
  Object.defineProperty(globalThis, 'MutationObserver', {
    configurable: true,
    writable: true,
    value: class {
      record = { targets: [] as unknown[], options: [] as unknown[] };
      constructor() { mutationObservers.push(this.record); }
      observe(target: unknown, options: unknown) { this.record.targets.push(target); this.record.options.push(options); }
      disconnect() {}
    },
  });
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: class {
      observe(target: unknown) { resizeTargets.push(target); }
      unobserve() {}
      disconnect() {}
    },
  });
  (HostElement.prototype as unknown as Record<string, unknown>).setPointerCapture = function setPointerCapture(this: HostElement, id: number) { captured.push(`set:${id}`); };
  (HostElement.prototype as unknown as Record<string, unknown>).releasePointerCapture = function releasePointerCapture(this: HostElement, id: number) { captured.push(`release:${id}`); };
  Object.defineProperty(HostElement.prototype, 'children', { configurable: true, get(this: HostElement) { return this.childNodes.filter((child) => child instanceof HostElement); } });

  const Harness: React.FC = () => {
    const ref = React.useRef<HTMLDivElement | null>(null);
    return (
      <>
        <div ref={ref} data-scroller="true" />
        <OverlayScrollbar containerRef={ref} {...props} />
      </>
    );
  };
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  const apply = (node: HostElement) => Object.assign(node, geometry);
  try {
    await act(async () => { root.render(<Harness />); });
    const scroller = container.find((node) => node.getAttribute('data-scroller') === 'true') as HostElement;
    apply(scroller);
    // Measure again now that the container has its geometry.
    await act(async () => { scroller.dispatch('scroll'); frames.run(); });
    await act(async () => { frames.run(); });
    await run({
      scroller,
      mutationObservers,
      resizeTargets,
      frames,
      captured,
      thumb: (axis) => container.find((node) => node.getAttribute('data-overlay-scrollbar-thumb') === axis),
      root: container,
      pointer: async (target, type, init) => {
        await act(async () => {
          for (const listener of container.listeners.get(type) ?? []) {
            listener({ type, target, currentTarget: target, bubbles: true, pointerId: 5, button: 0, clientX: 0, clientY: 0, ...init, preventDefault() {}, stopPropagation() {} });
          }
        });
      },
    });
  } finally {
    await act(async () => { root.unmount(); });
    delete (HostElement.prototype as unknown as Record<string, unknown>).setPointerCapture;
    delete (HostElement.prototype as unknown as Record<string, unknown>).releasePointerCapture;
    Reflect.deleteProperty(HostElement.prototype, 'children');
    for (const [key, descriptor] of savedGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});

describe('mounted overlay scrollbar', () => {
  test('draws vertical and horizontal thumbs only for overflowing axes', async () => {
    await mountScrollbar({}, { scrollHeight: 1200, clientHeight: 600, scrollWidth: 1600, clientWidth: 760 }, async ({ thumb }) => {
      expect(thumb('vertical')).not.toBeNull();
      expect(thumb('horizontal')).not.toBeNull();
    });
    await mountScrollbar({}, { scrollHeight: 1200, clientHeight: 600, scrollWidth: 760, clientWidth: 760 }, async ({ thumb }) => {
      expect(thumb('vertical')).not.toBeNull();
      expect(thumb('horizontal')).toBeNull();
    });
    await mountScrollbar({ disableHorizontal: true }, { scrollHeight: 1200, clientHeight: 600, scrollWidth: 1600, clientWidth: 760 }, async ({ thumb }) => {
      expect(thumb('horizontal')).toBeNull();
    });
    await mountScrollbar({}, { scrollHeight: 600, clientHeight: 600, scrollWidth: 760, clientWidth: 760 }, async ({ thumb, root }) => {
      expect(thumb('vertical')).toBeNull();
      expect(root.find((node) => (node.getAttribute('class') ?? '').includes('overlay-scrollbar'))).toBeNull();
    });
  }, 30_000);

  test('dragging a vertical thumb scrolls the container proportionally, with pointer capture', async () => {
    await mountScrollbar({}, { scrollHeight: 1200, clientHeight: 600, scrollWidth: 760, clientWidth: 760 }, async ({ scroller, thumb, pointer, captured }) => {
      const vertical = thumb('vertical') as HostElement;
      scroller.scrollTop = 0;

      await pointer(vertical, 'pointerdown', { clientY: 100 });
      expect(captured).toEqual(['set:5']);

      // Dragging 50px moves the thumb 50px along its track, scrolling the content by the same share.
      const thumbHeight = Number.parseFloat((vertical.style as unknown as Record<string, string>).height);
      expect(thumbHeight).toBeGreaterThan(0);
      await pointer(vertical, 'pointermove', { clientY: 150 });
      const expected = (50 / Math.max(600 - thumbHeight, 1)) * (1200 - 600);
      expect(Math.abs(scroller.scrollTop - expected)).toBeLessThan(1e-5);

      await pointer(vertical, 'pointerup', { clientY: 150 });
      expect(captured).toEqual(['set:5', 'release:5']);

      // After release, moves no longer scroll.
      const resting = scroller.scrollTop;
      await pointer(vertical, 'pointermove', { clientY: 400 });
      expect(scroller.scrollTop).toBe(resting);
    });
  }, 30_000);

  test('dragging a horizontal thumb scrolls horizontally', async () => {
    await mountScrollbar({}, { scrollHeight: 600, clientHeight: 600, scrollWidth: 1520, clientWidth: 760 }, async ({ scroller, thumb, pointer }) => {
      const horizontal = thumb('horizontal') as HostElement;
      const horizontalScroller = scroller as HostElement & { scrollLeft: number };
      horizontalScroller.scrollLeft = 0;
      scroller.scrollTop = 0;

      await pointer(horizontal, 'pointerdown', { clientX: 10 });
      await pointer(horizontal, 'pointermove', { clientX: 60 });

      expect(horizontalScroller.scrollLeft).toBeGreaterThan(0);
      expect(scroller.scrollTop).toBe(0);
    });
  }, 30_000);

  test('observes child list mutations only when asked', async () => {
    await mountScrollbar({}, { scrollHeight: 1200, clientHeight: 600, scrollWidth: 760, clientWidth: 760 }, async ({ mutationObservers, scroller }) => {
      expect(mutationObservers).toHaveLength(1);
      expect(mutationObservers[0].targets.map((target) => target === scroller)).toEqual([true]);
      expect(mutationObservers[0].options).toEqual([{ childList: true }]);
    });
    await mountScrollbar({ observeMutations: false }, { scrollHeight: 1200, clientHeight: 600, scrollWidth: 760, clientWidth: 760 }, async ({ mutationObservers }) => {
      expect(mutationObservers).toHaveLength(0);
    });
  }, 30_000);

  test('stays hidden for programmatic scrolling when only user intent should reveal it', async () => {
    await mountScrollbar({ userIntentOnly: true }, { scrollHeight: 1200, clientHeight: 600, scrollWidth: 760, clientWidth: 760 }, async ({ scroller, frames, root }) => {
      const opacity = () => {
        const bar = root.find((node) => (node.getAttribute('class') ?? '') === 'overlay-scrollbar');
        return String(bar ? (bar.style as unknown as Record<string, unknown>).opacity : 'missing');
      };
      // A scroll event with no wheel, touch or key intent does not reveal the scrollbar.
      await act(async () => { scroller.dispatch('scroll'); frames.run(); });
      expect(opacity()).toBe('0');

      // A wheel gesture marks intent, and the next scroll reveals it.
      await act(async () => { scroller.dispatch('wheel'); scroller.dispatch('scroll'); frames.run(); });
      expect(opacity()).toBe('1');
    });
  }, 30_000);
});
