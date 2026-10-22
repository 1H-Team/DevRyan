import { readFileSync } from 'node:fs';
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { withDom, type HostElement } from '../../../bots/chat/botMountedDom';
import PlanCardSkeleton from './PlanCardSkeleton';
import { WorkingPlaceholder } from './WorkingPlaceholder';
import { SHARED_BLINK_ATTRIBUTE, useDurationTickerNow, useSharedBlink } from './useDurationTicker';
import {
  formatRetryCountdown,
  getRetryCountdownBoundaryDelayMs,
  getRetryCountdownSeconds,
} from './workingPlaceholderTiming';

const mountElement = async (
  element: () => React.ReactElement,
  run: (container: HostElement) => Promise<void>,
  options: { hidden?: boolean } = {},
) => {
  await withDom(async (container) => {
    const doc = globalThis.document;
    Reflect.set(doc, 'visibilityState', options.hidden ? 'hidden' : 'visible');
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(element()));
      await run(container);
    } finally {
      await act(async () => root.unmount());
    }
  });
};

const originalSetTimeout = globalThis.setTimeout;
let scheduledDelays: number[] = [];

beforeEach(() => {
  scheduledDelays = [];
  // Records every timer a component schedules, then runs the real implementation.
  globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (typeof delay === 'number') scheduledDelays.push(delay);
    return originalSetTimeout(handler as () => void, delay, ...args);
  }) as typeof setTimeout;
});

afterEach(() => {
  globalThis.setTimeout = originalSetTimeout;
});

describe('mounted presentation work', () => {
  test('the plan skeleton steps on the shared tick and owns no animation', async () => {
    // CSS has no runtime in bun:test; the stylesheet text is the contract.
    const styles = readFileSync(new URL('../../../../index.css', import.meta.url), 'utf8');
    const skeletonRules = styles.slice(
      styles.indexOf('.oc-plan-skeleton-lines {'),
      styles.indexOf('.oc-plan-skeleton-line:nth-child'),
    );

    expect(skeletonRules).toContain('html[data-tick-blink="off"] .oc-plan-skeleton-lines[data-animation-state="running"] {');
    expect(skeletonRules).not.toMatch(/\banimation(-[a-z]+)?:/);
    expect(styles).not.toContain('@keyframes oc-plan-skeleton-pulse');

    await mountElement(() => React.createElement(PlanCardSkeleton, { lineCount: 3 }), async (container) => {
      const lines = container.find((node) => node.getAttribute('data-animation-state') !== null);
      expect(lines?.getAttribute('data-animation-state')).toBe('running');
      expect(container.childNodes[0]?.childNodes).toHaveLength(3);
    });
    await mountElement(() => React.createElement(PlanCardSkeleton), async (container) => {
      const lines = container.find((node) => node.getAttribute('data-animation-state') !== null);
      expect(lines?.getAttribute('data-animation-state')).toBe('paused');
    }, { hidden: true });
  });

  test('retry countdown aligns to the next second boundary and stops at zero', () => {
    expect(getRetryCountdownSeconds(2_500, 0)).toBe(3);
    expect(getRetryCountdownBoundaryDelayMs(2_500, 0)).toBe(500);
    expect(getRetryCountdownSeconds(2_500, 500)).toBe(2);
    expect(getRetryCountdownBoundaryDelayMs(2_500, 500)).toBe(1_000);
    expect(getRetryCountdownSeconds(2_500, 2_500)).toBe(0);
    expect(getRetryCountdownBoundaryDelayMs(2_500, 2_500)).toBeNull();
    expect(formatRetryCountdown(61)).toBe('1m 1s');
  });

  test('visibility-gates shimmers and retry countdowns', async () => {
    const retrying = () => React.createElement(WorkingPlaceholder, {
      isWorking: true,
      statusText: null,
      retryInfo: { attempt: 1, next: 5_000 },
    });

    await mountElement(retrying, async (container) => {
      expect(container.textContent).toMatch(/^Retrying in [45]s$/);
      expect(container.find((node) => node.getAttribute('data-animation-state') === 'running')).not.toBeNull();
      // A visible countdown re-arms itself at the next second boundary.
      expect(scheduledDelays.some((delay) => delay >= 1 && delay <= 1_000)).toBe(true);
    });

    scheduledDelays = [];
    await mountElement(retrying, async (container) => {
      expect(container.textContent).toMatch(/^Retrying in [45]s$/);
      expect(container.find((node) => node.getAttribute('data-animation-state') === 'paused')).not.toBeNull();
      expect(container.find((node) => node.getAttribute('data-animation-state') === 'running')).toBeNull();
      // A hidden document renders the countdown once and schedules no ticks.
      expect(scheduledDelays.filter((delay) => delay <= 1_000)).toEqual([]);
    }, { hidden: true });
  });

  test('visibility-gates duration tickers', async () => {
    const intervals: number[] = [];
    const Probe = ({ active }: { active: boolean }) => {
      useDurationTickerNow(active, 123);
      return null;
    };
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    const patchWindow = () => {
      globalThis.setInterval = ((_handler: unknown, ms: number) => {
        intervals.push(ms);
        return 1;
      }) as unknown as typeof setInterval;
      globalThis.clearInterval = (() => {}) as typeof clearInterval;
    };
    const restoreTimers = () => {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    };

    await withDom(async (container) => {
      patchWindow();
      Reflect.set(globalThis.document, 'visibilityState', 'visible');
      const { createRoot } = await import('react-dom/client');
      const root = createRoot(container as unknown as Element);
      await act(async () => root.render(React.createElement(Probe, { active: true })));
      expect(intervals).toEqual([123]);
      await act(async () => root.unmount());
    });
    // Inactive or hidden tickers never start an interval (patchWindow would record it).
    for (const [active, hidden] of [[false, false], [true, true]] as const) {
      await withDom(async (container) => {
        patchWindow();
        intervals.length = 0;
        Reflect.set(globalThis.document, 'visibilityState', hidden ? 'hidden' : 'visible');
        const { createRoot } = await import('react-dom/client');
        const root = createRoot(container as unknown as Element);
        await act(async () => root.render(React.createElement(Probe, { active })));
        expect(intervals).toEqual([]);
        await act(async () => root.unmount());
      });
    }
    restoreTimers();
  });

  test('working indicators share one blink tick that stops with the last holder', async () => {
    const intervals: Array<{ ms: number; tick: () => void; cleared: boolean }> = [];
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    globalThis.setInterval = ((handler: () => void, ms: number) => {
      intervals.push({ ms, tick: handler, cleared: false });
      return intervals.length;
    }) as unknown as typeof setInterval;
    globalThis.clearInterval = ((id: number) => {
      const interval = intervals[id - 1];
      if (interval) interval.cleared = true;
    }) as unknown as typeof clearInterval;
    const Holder = ({ active }: { active: boolean }) => {
      useSharedBlink(active);
      return null;
    };
    const Holders = ({ count }: { count: number }) => React.createElement(React.Fragment, null,
      ...Array.from({ length: count }, (_, index) => React.createElement(Holder, { key: index, active: true })));

    try {
      await withDom(async (container) => {
        Reflect.set(globalThis.document, 'visibilityState', 'visible');
        const html = globalThis.document.documentElement;
        const { createRoot } = await import('react-dom/client');
        const root = createRoot(container as unknown as Element);
        await act(async () => root.render(React.createElement(Holders, { count: 12 })));
        // Twelve working indicators, one one-second interval, no per-indicator work.
        expect(intervals.map(({ ms }) => ms)).toEqual([1_000]);
        expect(html.getAttribute(SHARED_BLINK_ATTRIBUTE)).toBe('on');
        await act(async () => intervals[0]!.tick());
        expect(html.getAttribute(SHARED_BLINK_ATTRIBUTE)).toBe('off');
        await act(async () => intervals[0]!.tick());
        expect(html.getAttribute(SHARED_BLINK_ATTRIBUTE)).toBe('on');

        await act(async () => root.render(React.createElement(Holders, { count: 1 })));
        expect(intervals[0]!.cleared).toBe(false);
        await act(async () => root.render(React.createElement(Holders, { count: 0 })));
        // The last holder stops the tick and leaves the indicators at rest.
        expect(intervals[0]!.cleared).toBe(true);
        expect(html.getAttribute(SHARED_BLINK_ATTRIBUTE)).toBeNull();
        await act(async () => root.unmount());
      });

      intervals.length = 0;
      await withDom(async (container) => {
        Reflect.set(globalThis.document, 'visibilityState', 'hidden');
        const { createRoot } = await import('react-dom/client');
        const root = createRoot(container as unknown as Element);
        await act(async () => root.render(React.createElement(Holders, { count: 3 })));
        // A hidden document never starts the tick.
        expect(intervals).toEqual([]);
        expect(globalThis.document.documentElement.getAttribute(SHARED_BLINK_ATTRIBUTE)).toBeNull();
        await act(async () => root.unmount());
      });
    } finally {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  });
});
