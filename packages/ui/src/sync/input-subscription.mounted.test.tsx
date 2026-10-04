import React, { act, useEffect } from 'react';
import { expect, test } from 'bun:test';
import type { OpencodeClient } from '@opencode-ai/sdk/v2/client';
import { withDom } from '@/components/bots/chat/botMountedDom';


// Initialize the original client under the disposable browser origin, as in client.send tests.
const initialEvents = new EventTarget();
globalThis.window = { addEventListener: initialEvents.addEventListener.bind(initialEvents), removeEventListener: initialEvents.removeEventListener.bind(initialEvents), dispatchEvent: initialEvents.dispatchEvent.bind(initialEvents), location: { href: 'http://127.0.0.1:5180/', origin: 'http://127.0.0.1:5180' } } as unknown as Window & typeof globalThis;
const { opencodeClient } = await import('@/lib/opencode/client');
const { createEventPipeline } = await import('./event-pipeline');
const { useConfigStore } = await import('@/stores/useConfigStore');

type Frame = { id?: unknown; event?: unknown; data?: unknown };
const controlledStream = () => {
  let observe: (frame: Frame) => void = () => { throw Error('Stream not attached'); };
  let fail: (error: unknown) => void = () => {};
  let attached: () => void = () => {};
  const attachment = new Promise<void>(resolve => { attached = resolve; });
  let headers: Record<string, string> = {};
  const sdk = { global: { event: async (options: {
    signal: AbortSignal; headers: Record<string, string>; onSseEvent: (frame: Frame) => void; onSseError: (error: unknown) => void;
  }) => {
    observe = options.onSseEvent; fail = options.onSseError; headers = options.headers; attached();
    return { stream: (async function* () {
      await new Promise<void>(resolve => {
        if (options.signal.aborted) resolve();
        else options.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      yield* [];
    })() };
  } } } as unknown as OpencodeClient;
  return { sdk, attachment, ready: () => observe({ event: 'devryan.subscription-ready', id: 'inherited-id', data: { type: 'ready', scope: 'global' } }),
    frame: (frame: Frame) => observe(frame), fail: () => fail(Error('Disconnected')), headers: () => headers };
};
const Harness = ({ sdk }: { sdk: OpencodeClient }) => {
  useEffect(() => createEventPipeline({ sdk, transport: 'sse', onEvent: () => {} }).cleanup, [sdk]);
  return null;
};
const mounted = async (run: (stream: ReturnType<typeof controlledStream>, replace: () => Promise<ReturnType<typeof controlledStream>>) => Promise<void>) => withDom(async container => {
  const browserEvents = new EventTarget();
  window.dispatchEvent = browserEvents.dispatchEvent.bind(browserEvents);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  let stream = controlledStream();
  opencodeClient.setDirectory(undefined);
  try {
    await act(async () => { root.render(<Harness sdk={stream.sdk} />); });
    await stream.attachment;
    await run(stream, async () => {
      stream = controlledStream();
      await act(async () => { root.render(<Harness sdk={stream.sdk} />); });
      await stream.attachment;
      return stream;
    });
  } finally { await act(async () => { root.unmount(); }); }
});

test('mounted quiet SSE waits for subscription ACK, not health or headers, and sends captured input exactly once', async () => {
  const originalFetch = globalThis.fetch;
  const calls: RequestInit[] = [];
  globalThis.fetch = async (url, init) => { if (String(url).includes("/prompt_async")) calls.push(init ?? {}); return new Response(null, { status: 204 }); };
  try { await mounted(async stream => {
    useConfigStore.setState({ isConnected: true }); // A successful health probe is insufficient.
    const sending = opencodeClient.sendMessage({ id: 'ses_readiness', messageId: 'msg_same', text: 'captured',
      providerID: 'fixture', modelID: 'exact', agent: 'builder', variant: 'high', delivery: 'queue' });
    await Promise.resolve(); await Promise.resolve();
    expect(calls).toHaveLength(0);
    expect(stream.headers()['X-DevRyan-Subscription-Ready']).toBe('1');
    stream.frame({ event: 'heartbeat' });
    stream.frame({ event: 'devryan.subscription-ready', data: { type: 'ready', scope: 'directory' } });
    await Promise.resolve(); expect(calls).toHaveLength(0);
    stream.ready(); await sending;
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0].body))).toMatchObject({ messageID: 'msg_same', model: { providerID: 'fixture', modelID: 'exact' },
      agent: 'builder', variant: 'high', delivery: 'queue', parts: [{ type: 'text', text: 'captured' }] });
  }); } finally { globalThis.fetch = originalFetch; }
});

test('consumer abort and timeout leave the mounted subscription usable; Stop is independent', async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async input => { const url = input instanceof Request ? input.url : String(input); if (/\/(abort|command)$/.test(url)) urls.push(url); return Response.json(true); };
  try { await mounted(async stream => {
    const controller = new AbortController();
    const cancelled = opencodeClient.sendCommand({ id: 'ses_readiness', messageId: 'msg_cancelled', command: 'check',
      providerID: 'fixture', modelID: 'exact', signal: controller.signal });
    const cancellation = cancelled.then(() => null, (error: unknown) => error);
    await Promise.resolve(); controller.abort();
    expect(await cancellation).toMatchObject({ code: 'EVENT_SUBSCRIPTION_UNAVAILABLE', name: 'AbortError' });
    await expect(opencodeClient.awaitInputSubscription(undefined, 5)).rejects.toMatchObject({ code: 'EVENT_SUBSCRIPTION_UNAVAILABLE' });
    expect(urls).toHaveLength(0);
    await opencodeClient.getSdkClient().session.abort({ sessionID: 'ses_readiness' });
    expect(urls).toHaveLength(1); expect(urls[0]).toContain('/abort');
    stream.ready(); (await opencodeClient.awaitInputSubscription())();
  }); } finally { globalThis.fetch = originalFetch; }
});

test('disconnect and replacement invalidate captured readiness; only the current subscription releases a new input', async () => {
  const originalFetch = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = async url => { if (String(url).endsWith("/prompt")) posts++; return new Response(null, { status: 204 }); };
  const originalError = console.error; console.error = () => {};
  try { await mounted(async (stream, replace) => {
    stream.ready();
    const check = await opencodeClient.awaitInputSubscription();
    stream.fail(); expect(check).toThrow('subscription');
    const current = await replace();
    const sending = opencodeClient.sendImmediateSubtaskPrompt({ id: 'ses_child', text: 'follow up' });
    await Promise.resolve(); await Promise.resolve(); expect(posts).toBe(0);
    stream.ready(); await Promise.resolve(); expect(posts).toBe(0);
    current.ready(); await sending; expect(posts).toBe(1);
  }); } finally { globalThis.fetch = originalFetch; console.error = originalError; }
});
