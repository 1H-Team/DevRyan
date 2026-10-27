import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { withDom } from '@/test/mountedDom';
import { I18nProvider } from '@/lib/i18n';
import { getAuthPrincipal, setAuthOfflineGrace, setAuthPrincipal } from '@/lib/authSession';
import { setStoragePrincipal } from '@/stores/utils/safeStorage';

const { SessionAuthGate } = await import('./SessionAuthGate');

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

type Timer = { id: number; callback: () => void; delay: number };

// Deterministic clock for the gate's retry scheduling; React keeps its own scheduling.
const installClock = () => {
  const timers = new Map<number, Timer>();
  let nextId = 1000;
  const originals = { setTimeout: realSetTimeout, clearTimeout: realClearTimeout };
  globalThis.setTimeout = ((callback: () => void, delay = 0) => {
    const id = nextId++;
    timers.set(id, { id, callback, delay });
    return id;
  }) as never;
  globalThis.clearTimeout = ((id: number) => { timers.delete(id); }) as never;
  return {
    pending: () => [...timers.values()],
    /** Delays of the retry timers the gate scheduled (everything else in this file is sub-5s). */
    retryDelays: () => [...timers.values()].map((timer) => timer.delay).filter((delay) => delay >= 5_000),
    fire: async (delay: number) => {
      const timer = [...timers.values()].find((candidate) => candidate.delay === delay);
      expect(timer).toBeDefined();
      timers.delete(timer!.id);
      await act(async () => { timer!.callback(); await settle(); });
    },
    restore: () => { globalThis.setTimeout = originals.setTimeout; globalThis.clearTimeout = originals.clearTimeout; },
  };
};

const settle = () => new Promise((resolve) => realSetTimeout(resolve, 0));
const flush = () => act(async () => { await settle(); });

describe('SessionAuthGate offline-grace recovery', () => {
  const originalPrincipal = getAuthPrincipal();
  const stashed = new Map<string, PropertyDescriptor | undefined>();
  let sessionPolls = 0;
  let offlineGraceResponses: boolean[] = [];

  beforeEach(() => {
    sessionPolls = 0;
    offlineGraceResponses = [];
    for (const key of ['window', 'fetch', 'document']) stashed.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    setStoragePrincipal(originalPrincipal.id);
  });
  afterEach(() => {
    for (const [key, descriptor] of stashed) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
    setAuthPrincipal(originalPrincipal);
    setAuthOfflineGrace(false);
  });

  const mountGate = async (run: (ctx: { clock: ReturnType<typeof installClock>; documentTarget: EventTarget; text: () => string }) => Promise<void>) => withDom(async (container) => {
    const host = globalThis as unknown as { window: Record<string, unknown>; document: Record<string, unknown> };
    const documentTarget = new EventTarget();
    host.document.addEventListener = documentTarget.addEventListener.bind(documentTarget);
    host.document.removeEventListener = documentTarget.removeEventListener.bind(documentTarget);
    host.document.visibilityState = 'visible';
    Object.assign(host.window, {
      isSecureContext: false,
      location: { href: 'https://app.example/', origin: 'https://app.example', search: '', pathname: '/', reload() { throw new Error('unexpected reload'); } },
      history: { replaceState() {} },
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => true,
    });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/auth/session') {
        sessionPolls += 1;
        const offlineGrace = offlineGraceResponses.shift() ?? false;
        return Response.json({ authenticated: true, mode: 'local', principal: originalPrincipal, ...(offlineGrace ? { offlineGrace: true } : {}) });
      }
      return Response.json({});
    }) as typeof fetch;
    // Unrelated app stores start loading project data once authenticated; their failures are noise here.
    const quiet = [spyOn(console, 'warn').mockImplementation(() => {}), spyOn(console, 'error').mockImplementation(() => {})];
    const clock = installClock();
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => {
        root.render(<I18nProvider><SessionAuthGate><span>app ready</span></SessionAuthGate></I18nProvider>);
      });
      await flush();
      await run({ clock, documentTarget, text: () => container.textContent });
    } finally {
      await act(async () => { root.unmount(); });
      clock.restore();
      for (const spy of quiet) spy.mockRestore();
    }
  });

  test('keeps the app available while the host is only reachable through offline grace', async () => {
    offlineGraceResponses = [true];
    await mountGate(async ({ text }) => {
      expect(text()).toContain('app ready');
    });
  });

  test('retries with bounded exponential backoff until the host is reachable again', async () => {
    offlineGraceResponses = [true, true, true, true, true, true, true, false];
    await mountGate(async ({ clock }) => {
      expect(sessionPolls).toBe(1);
      const delays: number[] = [];
      for (let step = 0; step < 7; step += 1) {
        const [delay] = clock.retryDelays();
        expect(clock.retryDelays()).toHaveLength(1);
        delays.push(delay);
        await clock.fire(delay);
      }
      expect(delays).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
      expect(sessionPolls).toBe(8);
      // The last poll found the host reachable: polling stops.
      expect(clock.retryDelays()).toEqual([]);
    });
  });

  test('re-checks immediately when the tab becomes visible and restarts the backoff', async () => {
    offlineGraceResponses = [true, true, true, true, true, true];
    await mountGate(async ({ clock, documentTarget }) => {
      await clock.fire(clock.retryDelays()[0]);
      await clock.fire(clock.retryDelays()[0]);
      expect(clock.retryDelays()).toEqual([20_000]);
      const pollsBefore = sessionPolls;

      await act(async () => {
        documentTarget.dispatchEvent(new Event('visibilitychange'));
        await settle();
      });
      expect(sessionPolls).toBe(pollsBefore + 1);

      // The backoff starts over instead of continuing from 40 seconds.
      await clock.fire(20_000);
      expect(clock.retryDelays()).toEqual([5_000]);
    });
  });

  test('does not poll when the session is not in offline grace', async () => {
    await mountGate(async ({ clock }) => {
      expect(sessionPolls).toBe(1);
      expect(clock.retryDelays()).toEqual([]);
    });
  });
});
