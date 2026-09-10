import React, { act } from 'react';
import { expect, test } from 'bun:test';

import { I18nProvider } from '@/lib/i18n';
import { createBotChannelStore } from '@/stores/useBotChannelStore';
import { createBotOperationsStore } from '@/stores/useBotOperationsStore';
import { createBotsStore } from '@/stores/useBotsStore';
import { withDom } from '../chat/botMountedDom';
import { BotSidebarSection } from './BotSidebarSection';

test('mounted sidebar delays brief outages and keeps a prolonged outage steady through retries and navigation', async () => withDom(async (container) => {
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  const originalNow = Date.now;
  const originalTimeout = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  let now = 10_000;
  let timerId = 0;
  const timers = new Map<ReturnType<typeof setTimeout>, { at: number; run: () => void }>();
  Date.now = () => now;
  globalThis.setTimeout = ((run: () => void, delay?: number) => {
    if (!delay || delay > 3_000) return originalTimeout(run, delay);
    const id = ++timerId as unknown as ReturnType<typeof setTimeout>;
    timers.set(id, { at: now + delay, run });
    return id;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
    if (!timers.delete(id)) originalClear(id);
  }) as typeof clearTimeout;
  const stores = {
    botsStore: createBotsStore(),
    channelStore: createBotChannelStore(),
    operationsStore: createBotOperationsStore({ now: () => now }),
  };
  stores.botsStore.getState().replaceSnapshot({ bots: [], memberships: [], revisions: [] });
  const state = (connection: 'connected' | 'connecting' | 'reconnecting', code: string | null = null) =>
    act(async () => { stores.operationsStore.getState().setConnectionState(connection, code); });
  const advance = (ms: number) => act(async () => {
    now += ms;
    for (const [id, timer] of timers) {
      if (timer.at > now) continue;
      timers.delete(id);
      timer.run();
    }
  });
  const render = (visible = true) => act(async () => {
    root.render(<I18nProvider>{visible ? <BotSidebarSection {...stores} /> : null}</I18nProvider>);
  });
  const warning = () => container.textContent.includes('Live updates are unavailable');
  try {
    await render();
    await state('reconnecting', 'bot_event_connection_lost');
    expect(warning()).toBe(false);
    await advance(2_000);
    await state('connected');
    await advance(2_000);
    expect(warning()).toBe(false);
    expect(timers.size).toBe(0);

    await state('reconnecting', 'bot_event_connection_lost');
    await advance(2_000);
    await render(false);
    expect(timers.size).toBe(0);
    await render();
    await advance(999);
    expect(warning()).toBe(false);
    await state('connecting', 'bot_event_connection_lost');
    await advance(1);
    expect(warning()).toBe(true);
    await state('reconnecting', 'bot_event_json_invalid');
    expect(warning()).toBe(true);
    await render(false);
    await render();
    expect(warning()).toBe(true);
    await state('connected');
    expect(warning()).toBe(false);

    await state('reconnecting', 'bot_event_connection_lost');
    await act(async () => { stores.operationsStore.getState().resetPrincipal('new-principal'); });
    await advance(3_000);
    expect(warning()).toBe(false);
    expect(timers.size).toBe(0);
  } finally {
    await act(async () => root.unmount());
    globalThis.setTimeout = originalTimeout;
    globalThis.clearTimeout = originalClear;
    Date.now = originalNow;
  }
}));
