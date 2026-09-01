import React, { act } from 'react';
import { describe, expect, test } from 'bun:test';

import { I18nProvider } from '@/lib/i18n';
import type { BotComputerStatus, BotsApi } from '@/lib/botsApi';
import { createBotOperationsStore } from '@/stores/useBotOperationsStore';
import { HostElement, HostNode, withDom } from '../chat/botMountedDom';
import { BotBrowserDiagnostic } from './BotBrowserDiagnostic';

const BOT_ID = 'teardown-bot';
const CHANNEL_ID = 'teardown-channel';
const PRINCIPAL_ID = 'teardown-member';

const dispatchText = (target: HostElement, text: string) => {
  const event = { type: 'paste', target, clipboardData: { getData: () => text }, bubbles: true,
    preventDefault() {}, stopPropagation() {} };
  for (let node: HostNode | null = target; node; node = node.parentNode) {
    if (node instanceof HostElement) for (const listener of node.listeners.get('paste') ?? []) listener(event);
  }
};

const frame = () => {
  const header = new TextEncoder().encode('--test\r\nContent-Type: image/jpeg\r\nContent-Length: 4\r\n'
    + 'X-DevRyan-Width: 1280\r\nX-DevRyan-Height: 720\r\nX-DevRyan-Device-Scale-Factor: 1\r\n'
    + 'X-DevRyan-Captured-At: 1\r\n\r\n');
  return new Uint8Array([...header, 0xff, 0xd8, 0xff, 0xd9, 13, 10]);
};

describe('mounted shared-computer teardown', () => {
  for (const mode of ['stop', 'hide', 'return', 'expired', 'duplicate', 'retained'] as const) test(`${mode} safely releases control without reviving stale input`, async () => withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    const previousFetch = globalThis.fetch;
    const previousBitmap = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
    const previousBlur = Object.getOwnPropertyDescriptor(HostElement.prototype, 'blur');
    const previousContext = Object.getOwnPropertyDescriptor(HostElement.prototype, 'getContext');
    Object.assign(window, { setInterval, clearInterval, queueMicrotask });
    const pollingTimers = new Map<number, { callback: () => void; delay: number }>();
    let timerId = 0;
    if (mode === 'expired') Object.assign(window, {
      setInterval(callback: () => void, delay: number) { const id = ++timerId; pollingTimers.set(id, { callback, delay }); return id; },
      clearInterval(id: number) { pollingTimers.delete(id); },
    });
    Object.defineProperty(HostElement.prototype, 'blur', { configurable: true, value(this: HostElement) { this.ownerDocument.activeElement = this.ownerDocument.body; } });
    Object.defineProperty(HostElement.prototype, 'getContext', { configurable: true, value: () => ({ drawImage() {} }) });
    Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: async () => ({ width: 1280, height: 720, close() {} }) });
    let streamStopped = false;
    let inputCalls = 0;
    let controlReturns = 0;
    let viewStops = 0;
    let heartbeats = 0;
    let statusReads = 0;
    let inputSignal: AbortSignal | undefined;
    let resolveInput!: () => void;
    let resolveReturn!: () => void;
    const pendingInput = new Promise<void>((resolve) => { resolveInput = resolve; });
    const pendingReturn = new Promise<void>((resolve) => { resolveReturn = resolve; });
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(frame());
        init?.signal?.addEventListener('abort', () => { streamStopped = true; controller.close(); }, { once: true });
      },
    }), { headers: { 'content-type': 'multipart/x-mixed-replace; boundary=test' } })) as typeof fetch;
    const status: BotComputerStatus = { botId: BOT_ID, browser: { running: true },
      control: { leaseId: 'lease', actorId: PRINCIPAL_ID, actorType: 'user', takenAt: Date.now(), expiresAt: Date.now() + (mode === 'expired' ? -1_000 : 60_000) },
      screencast: { subscribers: 1, lastFrameAt: 1, retainedFrames: 0 }, framesRecorded: false, arbitraryWebsiteExactlyOnce: false };
    let authoritativeStatus = status;
    const api = {
      startComputerView: async () => ({ view: { id: 'view', botId: BOT_ID, channelId: CHANNEL_ID, streamUrl: '/fixture-stream', startedAt: '' } }),
      getComputerStatus: async () => { statusReads += 1; return authoritativeStatus; },
      heartbeatComputerControl: async () => { heartbeats += 1; return { botId: BOT_ID, control: authoritativeStatus.control }; },
      sendHumanComputerCommand: async (_botId: string, _request: unknown, signal?: AbortSignal) => { inputCalls += 1; inputSignal = signal; await pendingInput; return { result: {} }; },
      returnComputerControl: async () => {
        controlReturns += 1;
        if (mode === 'duplicate' || mode === 'retained') throw new Error('Control already returned');
        if (mode === 'expired' && controlReturns === 1) throw new Error('Release failed');
        await pendingReturn;
        return { botId: BOT_ID, control: null };
      },
      stopComputerView: async () => {
        viewStops += 1;
        if (mode === 'duplicate') authoritativeStatus = { ...status, control: null };
        return { stopped: true };
      },
    } as unknown as BotsApi;
    const store = createBotOperationsStore({ api });
    store.getState().resetPrincipal(PRINCIPAL_ID);
    store.getState().upsertComputer(status);
    await store.getState().startComputerView(BOT_ID, CHANNEL_ID);
    const render = (active: boolean) => root.render(<I18nProvider><BotBrowserDiagnostic botId={BOT_ID} channelId={CHANNEL_ID} principalId={PRINCIPAL_ID} active={active} botActive canControl operationsStore={store} /></I18nProvider>);
    try {
      await act(async () => { render(true); });
      if (mode === 'duplicate' || mode === 'retained') {
        const before = statusReads;
        const stop = container.find((node) => node.tagName === 'BUTTON' && node.textContent === 'Stop Screen Viewing');
        expect(stop).not.toBeNull();
        await act(async () => { stop!.click(); });
        expect(streamStopped).toBe(true);
        expect(statusReads).toBeGreaterThan(before);
        if (mode === 'duplicate') {
          expect(container.textContent).not.toContain('Browser control did not change.');
          expect(store.getState().computersByBotId[BOT_ID]?.control).toBeNull();
        } else {
          expect(container.textContent).toContain('Browser control did not change.');
          await act(async () => { store.getState().updateComputerControl(BOT_ID, null); });
          expect(container.textContent).not.toContain('Browser control did not change.');
        }
        return;
      }
      if (mode === 'expired') {
        expect(container.find((node) => node.getAttribute('data-bot-computer-input') === 'enabled')).toBeNull();
        expect(container.textContent).toContain('Control expired, but the computer has not confirmed input release.');
        expect(container.textContent).not.toContain('The agent can interact with the browser.');
        expect([...pollingTimers.values()].map(({ delay }) => delay)).toEqual([2_000]);
        const retry = container.find((node) => node.tagName === 'BUTTON' && node.textContent === 'Return Control');
        expect(retry).not.toBeNull();
        await act(async () => { retry!.click(); });
        expect(controlReturns).toBe(1);
        expect(container.textContent).toContain('Browser control did not change.');
        await act(async () => { retry!.click(); });
        expect(controlReturns).toBe(2);
        authoritativeStatus = { ...status, control: null };
        await act(async () => { for (const timer of pollingTimers.values()) timer.callback(); });
        expect(container.find((node) => node.hasAttribute('data-bot-control-release-pending'))).toBeNull();
        expect(store.getState().computersByBotId[BOT_ID]?.control).toBeNull();
        expect(pollingTimers.size).toBe(0);
        expect(heartbeats).toBe(0);
        expect(inputCalls).toBe(0);
        return;
      }
      expect(container.find((node) => node.getAttribute('data-bot-computer-input') === 'enabled')).not.toBeNull();
      const keyboard = container.find((node) => node.hasAttribute('data-bot-computer-keyboard'));
      expect(keyboard).not.toBeNull();
      await act(async () => { dispatchText(keyboard!, 'a'); dispatchText(keyboard!, 'b'); });
      expect(inputCalls).toBe(1);
      await act(async () => {
        if (mode === 'hide') render(false);
        else {
          const label = mode === 'stop' ? 'Stop Screen Viewing' : 'Return Control';
          const button = container.find((node) => node.tagName === 'BUTTON' && node.textContent === label);
          expect(button).not.toBeNull();
          button!.click();
        }
        await new Promise((resolve) => setTimeout(resolve, mode === 'return' ? 300 : 25));
      });
      expect(inputSignal?.aborted).toBe(true);
      expect(streamStopped).toBe(mode !== 'return');
      expect(controlReturns).toBeGreaterThan(0);
      expect(viewStops).toBe(mode === 'return' ? 0 : 1);
      if (mode !== 'return') expect(store.getState().computerViewsByBotId[BOT_ID]).toBeUndefined();
      const newControl = { ...status.control!, leaseId: 'new-lease' };
      await act(async () => { store.getState().updateComputerControl(BOT_ID, newControl); resolveReturn(); });
      expect(store.getState().computersByBotId[BOT_ID]?.control).toBe(newControl);
      await act(async () => { resolveInput(); });
      expect(inputCalls).toBe(1);
    } finally {
      resolveInput();
      resolveReturn();
      await act(async () => { root.unmount(); });
      globalThis.fetch = previousFetch;
      for (const [target, key, descriptor] of [
        [globalThis, 'createImageBitmap', previousBitmap],
        [HostElement.prototype, 'blur', previousBlur],
        [HostElement.prototype, 'getContext', previousContext],
      ] as const) {
        if (descriptor) Object.defineProperty(target, key, descriptor); else Reflect.deleteProperty(target, key);
      }
    }
  }), 30_000);

  test('clicking the screen keeps focus on the keyboard target and forwards key strokes', async () => withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    const previousFetch = globalThis.fetch;
    const previousBitmap = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
    const previousBlur = Object.getOwnPropertyDescriptor(HostElement.prototype, 'blur');
    const previousContext = Object.getOwnPropertyDescriptor(HostElement.prototype, 'getContext');
    const previousCapture = Object.getOwnPropertyDescriptor(HostElement.prototype, 'setPointerCapture');
    const previousAttach = Object.getOwnPropertyDescriptor(HostElement.prototype, 'attachEvent');
    const previousDetach = Object.getOwnPropertyDescriptor(HostElement.prototype, 'detachEvent');
    Object.assign(window, { setInterval, clearInterval, queueMicrotask });
    // React's change-event polyfill (input events are undetectable in this
    // host DOM) watches the focused control through these IE-era hooks.
    Object.defineProperty(HostElement.prototype, 'attachEvent', { configurable: true, value() {} });
    Object.defineProperty(HostElement.prototype, 'detachEvent', { configurable: true, value() {} });
    Object.defineProperty(HostElement.prototype, 'blur', { configurable: true, value(this: HostElement) { this.ownerDocument.activeElement = this.ownerDocument.body; } });
    Object.defineProperty(HostElement.prototype, 'getContext', { configurable: true, value: () => ({ drawImage() {} }) });
    Object.defineProperty(HostElement.prototype, 'setPointerCapture', { configurable: true, value() {} });
    Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: async () => ({ width: 1280, height: 720, close() {} }) });
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(frame());
        init?.signal?.addEventListener('abort', () => { controller.close(); }, { once: true });
      },
    }), { headers: { 'content-type': 'multipart/x-mixed-replace; boundary=test' } })) as typeof fetch;
    const received: Array<{ type?: string; phase?: string; key?: string }> = [];
    const status: BotComputerStatus = { botId: BOT_ID, browser: { running: true },
      control: { leaseId: 'lease', actorId: PRINCIPAL_ID, actorType: 'user', takenAt: Date.now(), expiresAt: Date.now() + 60_000 },
      screencast: { subscribers: 1, lastFrameAt: 1, retainedFrames: 0 }, framesRecorded: false, arbitraryWebsiteExactlyOnce: false };
    const api = {
      startComputerView: async () => ({ view: { id: 'view', botId: BOT_ID, channelId: CHANNEL_ID, streamUrl: '/fixture-stream', startedAt: '' } }),
      getComputerStatus: async () => status,
      heartbeatComputerControl: async () => ({ botId: BOT_ID, control: status.control }),
      sendHumanComputerCommand: async (_botId: string, request: { args?: { events?: Array<{ type?: string }> } }) => {
        received.push(...(request.args?.events ?? []));
        return { result: {} };
      },
      returnComputerControl: async () => ({ botId: BOT_ID, control: null }),
      stopComputerView: async () => ({ stopped: true }),
    } as unknown as BotsApi;
    const store = createBotOperationsStore({ api });
    store.getState().resetPrincipal(PRINCIPAL_ID);
    store.getState().upsertComputer(status);
    await store.getState().startComputerView(BOT_ID, CHANNEL_ID);
    const dispatchThroughReact = (target: HostElement, event: Record<string, unknown>) => {
      for (let node: HostNode | null = target; node; node = node.parentNode) {
        if (node instanceof HostElement) for (const listener of node.listeners.get(event.type as string) ?? []) listener(event);
      }
    };
    try {
      await act(async () => { root.render(<I18nProvider><BotBrowserDiagnostic botId={BOT_ID} channelId={CHANNEL_ID} principalId={PRINCIPAL_ID} active botActive canControl operationsStore={store} /></I18nProvider>); });
      expect(container.find((node) => node.getAttribute('data-bot-computer-input') === 'enabled')).not.toBeNull();
      const canvas = container.find((node) => node.getAttribute('data-bot-computer-canvas') === 'true');
      const keyboard = container.find((node) => node.hasAttribute('data-bot-computer-keyboard'));
      expect(canvas).not.toBeNull();
      expect(keyboard).not.toBeNull();
      let defaultPrevented = false;
      await act(async () => {
        dispatchThroughReact(canvas!, {
          type: 'pointerdown', target: canvas, bubbles: true,
          clientX: 380, clientY: 60, button: 0, buttons: 1, detail: 1, pointerId: 7,
          preventDefault() { defaultPrevented = true; }, stopPropagation() {},
        });
      });
      expect(defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(keyboard as unknown as Element);
      // React's change-event fallback (active in this host DOM) tracks the
      // focused input via focusin; register it before key events.
      await act(async () => {
        dispatchThroughReact(keyboard!, { type: 'focusin', target: keyboard, bubbles: true, preventDefault() {}, stopPropagation() {} });
      });
      const keyStroke = (type: 'keydown' | 'keyup') => ({
        type, target: keyboard, bubbles: true, key: 'a', code: 'KeyA', location: 0, repeat: false,
        preventDefault() {}, stopPropagation() {},
      });
      await act(async () => {
        dispatchThroughReact(keyboard!, keyStroke('keydown'));
        dispatchThroughReact(keyboard!, keyStroke('keyup'));
      });
      const keyEvents = received.filter((event) => event.type === 'key');
      expect(keyEvents.some((event) => event.phase === 'down' && event.key === 'a')).toBe(true);
      expect(keyEvents.some((event) => event.phase === 'up' && event.key === 'a')).toBe(true);
    } finally {
      await act(async () => { root.unmount(); });
      globalThis.fetch = previousFetch;
      for (const [target, key, descriptor] of [
        [globalThis, 'createImageBitmap', previousBitmap],
        [HostElement.prototype, 'blur', previousBlur],
        [HostElement.prototype, 'getContext', previousContext],
        [HostElement.prototype, 'setPointerCapture', previousCapture],
        [HostElement.prototype, 'attachEvent', previousAttach],
        [HostElement.prototype, 'detachEvent', previousDetach],
      ] as const) {
        if (descriptor) Object.defineProperty(target, key, descriptor); else Reflect.deleteProperty(target, key);
      }
    }
  }), 30_000);
});
