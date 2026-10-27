import React, { act } from 'react';
import { afterEach, describe, expect, test } from 'bun:test';
import { HostElement, withDom } from '@/test/mountedDom';
import { useChatAutoFollow, type UseChatAutoFollowResult } from './useChatAutoFollow';

type ObserverRecord = { instance: object; targets: unknown[]; options: unknown[]; disconnected: boolean };

const installObservers = (includeResizeObserver: boolean) => {
  const resize: ObserverRecord[] = [];
  const mutation: ObserverRecord[] = [];
  const previous = {
    resize: Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver'),
    mutation: Object.getOwnPropertyDescriptor(globalThis, 'MutationObserver'),
  };
  const make = (records: ObserverRecord[]) => class {
    record: ObserverRecord = { instance: this, targets: [], options: [], disconnected: false };
    constructor() { records.push(this.record); }
    observe(target: unknown, options?: unknown) { this.record.targets.push(target); this.record.options.push(options); }
    disconnect() { this.record.disconnected = true; }
  };
  Object.defineProperty(globalThis, 'MutationObserver', { value: make(mutation), writable: true, configurable: true });
  if (includeResizeObserver) {
    Object.defineProperty(globalThis, 'ResizeObserver', { value: make(resize), writable: true, configurable: true });
  } else {
    Object.defineProperty(globalThis, 'ResizeObserver', { value: undefined, writable: true, configurable: true });
  }
  return {
    resize,
    mutation,
    restore: () => {
      for (const [key, descriptor] of [['ResizeObserver', previous.resize], ['MutationObserver', previous.mutation]] as const) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
};

let latest: UseChatAutoFollowResult | null = null;
const onActiveTurn = () => {};

const Harness: React.FC<{ withTurns?: boolean }> = ({ withTurns = false }) => {
  const follow = useChatAutoFollow({
    currentSessionId: 'session-a',
    sessionMessageCount: 1,
    sessionIsWorking: false,
    isMobile: false,
    onActiveTurnChange: withTurns ? onActiveTurn : undefined,
  });
  latest = follow;
  return (
    <div ref={follow.scrollRef}>
      <div data-testid="transcript" />
    </div>
  );
};

const mountHarness = async (includeResizeObserver: boolean, withTurns: boolean, run: (ctx: {
  observers: ReturnType<typeof installObservers>;
  scroller: HostElement;
  transcript: HostElement;
}) => Promise<void>) => withDom(async (container) => {
  const observers = installObservers(includeResizeObserver);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  try {
    // The host DOM has no element-children accessor the hook relies on.
    Object.defineProperty(HostElement.prototype, 'firstElementChild', {
      configurable: true,
      get(this: HostElement) { return this.childNodes.find((child) => child instanceof HostElement) ?? null; },
    });
    await act(async () => { root.render(<Harness withTurns={withTurns} />); });
    const scroller = container.childNodes[0] as HostElement;
    await run({ observers, scroller, transcript: scroller.childNodes[0] as HostElement });
  } finally {
    await act(async () => { root.unmount(); });
    Reflect.deleteProperty(HostElement.prototype, 'firstElementChild');
    observers.restore();
    latest = null;
  }
});

afterEach(() => { latest = null; });

describe('chat automatic-follow ownership', () => {
  test('uses transcript resize as the only DOM-driven automatic-follow signal', async () => {
    await mountHarness(true, false, async ({ observers, transcript }) => {
      expect(observers.resize).toHaveLength(1);
      // Identity comparison keeps failure output small (host nodes are cyclic).
      expect(observers.resize[0].targets.map((target) => target === transcript)).toEqual([true]);
    });
  });

  test('observes only turn insertion and removal for mutations, never text or attributes', async () => {
    const globals = globalThis as Record<string, unknown>;
    const saved = { raf: globals.requestAnimationFrame, caf: globals.cancelAnimationFrame, io: globals.IntersectionObserver };
    globals.requestAnimationFrame = () => 0;
    globals.cancelAnimationFrame = () => {};
    globals.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
    try {
      await mountHarness(true, true, async ({ observers, scroller }) => {
        const observed = observers.mutation.flatMap((record) => record.targets.map((target, index) => ({ target, options: record.options[index] })));
        expect(observed.length).toBeGreaterThan(0);
        for (const entry of observed) {
          expect(entry.target === scroller).toBe(true);
          expect(entry.options).toEqual({ subtree: true, childList: true });
        }
      });
    } finally {
      globals.requestAnimationFrame = saved.raf;
      globals.cancelAnimationFrame = saved.caf;
      globals.IntersectionObserver = saved.io;
    }
  });

  test('releases the resize observer when the transcript unmounts', async () => {
    let record: ObserverRecord | undefined;
    await mountHarness(true, false, async ({ observers }) => { record = observers.resize[0]; });
    expect(record?.disconnected).toBe(true);
  });

  test('keeps explicit content notifications as a ResizeObserver fallback only', async () => {
    let writes = 0;
    await mountHarness(false, false, async ({ observers, scroller }) => {
      expect(observers.resize).toHaveLength(0);
      Object.defineProperty(scroller, 'scrollTop', {
        configurable: true,
        get: () => 0,
        set: () => { writes += 1; },
      });
      scroller.scrollHeight = 5000;
      await act(async () => {
        latest?.notifyContentChange('text');
        await new Promise((resolve) => setTimeout(resolve, 80));
      });
    });
    expect(writes).toBeGreaterThan(0);
  });

  test('does not follow content notifications while a ResizeObserver owns growth', async () => {
    let writes = 0;
    await mountHarness(true, false, async ({ scroller }) => {
      Object.defineProperty(scroller, 'scrollTop', {
        configurable: true,
        get: () => 0,
        set: () => { writes += 1; },
      });
      scroller.scrollHeight = 5000;
      await act(async () => {
        latest?.notifyContentChange('text');
        await new Promise((resolve) => setTimeout(resolve, 80));
      });
    });
    expect(writes).toBe(0);
  });
});
