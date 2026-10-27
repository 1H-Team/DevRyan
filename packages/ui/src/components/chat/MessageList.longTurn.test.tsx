import React, { act } from 'react';
import { expect, mock, test } from 'bun:test';
import { HostElement, withDom } from '@/test/mountedDom';
Object.defineProperty(HostElement.prototype, 'closest', { value: () => null, configurable: true });
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';
import type { ChatMessageEntry } from './lib/turns/types';

mock.module('@/hooks/useProviderLogo', () => ({ useProviderLogo: () => ({ hasLogo: false, src: null, onError: () => {} }) }));
const sync = await import('@/sync/sync-context');
mock.module('@/sync/sync-context', () => ({ ...sync, useEnsureSessionChildren: () => ({ isLoading: false, hasFetched: true }), useSessionChildren: () => [] }));
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string, values?: { count: number }) => values ? `Show ${values.count} older` : key }) }));
mock.module('@/components/ui/button', () => ({ Button: React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>((props, ref) => <button {...props} ref={ref} />) }));
mock.module('./ObjectiveVerification', () => ({ ObjectiveVerification: () => null }));
mock.module('./ChatMessage', () => ({ default: ({ message }: { message: ChatMessageEntry }) => <div data-message-id={message.info.id}>{message.parts.map(part => <span key={part.id}>{part.id}</span>)}</div> }));
const { default: MessageList } = await import('./MessageList');
const user = { info: { id: 'u1', sessionID: 's', role: 'user', time: { created: 1 } }, parts: [] } as unknown as ChatMessageEntry;
const assistant = (i: number, status: 'completed' | 'running' = 'completed'): ChatMessageEntry => ({ info: { id: `a${i}`, sessionID: 's', role: 'assistant', parentID: 'u1', agent: 'build', modelID: 'm', providerID: 'p', mode: 'build', path: { cwd: '/', root: '/' }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: i + 2, ...(status === 'completed' ? { completed: i + 3 } : {}) }, finish: status === 'completed' ? 'tool-calls' : undefined }, parts: [{ id: `p${i}`, sessionID: 's', messageID: `a${i}`, type: 'tool', callID: `c${i}`, tool: 'bash', state: { status, input: { command: 'true' }, ...(status === 'completed' ? { output: 'ok', title: 'done', metadata: {}, time: { start: i + 2, end: i + 3 } } : { time: { start: i + 2 } }) } }] } as unknown as ChatMessageEntry);
const props = (messages: ChatMessageEntry[]) => ({ sessionKey: 's', turnStart: 0, messages, sessionIsWorking: true, activeStreamingMessageId: 'a100', activeStreamingPhase: 'streaming' as const, getAnimationHandlers: () => ({}) as never, hasMoreAbove: false, isLoadingOlder: false, onLoadOlder: () => {}, onMessageContentChange: () => {} });

test('windows a growing active turn, retains the running tool and reveals older rows without remounting the tail', async () => {
  useFeatureFlagsStore.getState().setLongTurnActivityWindowingEnabled(true);
  await withDom(async container => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    const messages = [user, ...Array.from({ length: 100 }, (_, i) => assistant(i)), assistant(100, 'running')];
    try {
      await act(async () => root.render(<MessageList {...props(messages)} />));
      expect(container.find(node => node.attributes['data-message-id'] === 'a0')).toBeNull();
      expect(container.find(node => node.attributes['data-message-id'] === 'a99')).not.toBeNull();
      expect(container.find(node => node.attributes['data-message-id'] === 'a100')).not.toBeNull();
      const button = container.find(node => node.tagName === 'BUTTON' && node.textContent.includes('Show 40 older'));
      expect(button).not.toBeNull();
      await act(async () => button?.click());
      expect(container.find(node => node.attributes['data-message-id'] === 'a20')).not.toBeNull();
      expect(container.find(node => node.attributes['data-message-id'] === 'a0')).toBeNull();
      const grown = [...messages, assistant(101)];
      await act(async () => root.render(<MessageList {...props(grown)} />));
      expect(container.find(node => node.attributes['data-message-id'] === 'a20')).not.toBeNull();
      const next = container.find(node => node.tagName === 'BUTTON' && node.textContent.includes('older'));
      await act(async () => next?.click());
      expect(container.find(node => node.attributes['data-message-id'] === 'a0')).not.toBeNull();
    } finally { await act(async () => root.unmount()); }
  });
  useFeatureFlagsStore.getState().setLongTurnActivityWindowingEnabled(false);
});

test('bounds settled parts within one message while retaining active and question tools', async () => {
  useFeatureFlagsStore.getState().setLongTurnActivityWindowingEnabled(true);
  const base = assistant(200);
  const parts = Array.from({ length: 100 }, (_, i) => ({ ...assistant(i).parts[0], messageID: 'a200' }));
  const question = { ...assistant(100, 'running').parts[0], id: 'question', messageID: 'a200', tool: 'question' };
  const running = { ...assistant(101, 'running').parts[0], id: 'active', messageID: 'a200' };
  const message = { ...base, parts: [...parts, question, running] } as ChatMessageEntry;
  await withDom(async container => {
    const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<MessageList {...props([user, message])} />));
      expect(container.textContent).not.toContain('p0');
      expect(container.textContent).toContain('p99');
      expect(container.textContent).toContain('question');
      expect(container.textContent).toContain('active');
      const button = container.find(node => node.tagName === 'BUTTON' && node.textContent.includes('older'));
      await act(async () => button?.click());
      expect(container.textContent).toContain('p20');
      const grown = { ...message, parts: [...message.parts, { ...assistant(102).parts[0], messageID: 'a200' }] } as ChatMessageEntry;
      await act(async () => root.render(<MessageList {...props([user, grown])} />));
      expect(container.textContent).toContain('p20');
      expect(container.textContent).toContain('p102');
      expect(container.textContent).toContain('active');
    } finally { await act(async () => root.unmount()); }
  });
  useFeatureFlagsStore.getState().setLongTurnActivityWindowingEnabled(false);
});

if (process.env.DEVRYAN_LONG_TURN_BENCH === '1') test('matched growing-turn render benchmark', async () => {
  const { createRoot } = await import('react-dom/client');
  const all = Array.from({ length: 800 }, (_, index) => assistant(index));
  const samples: { baseline: number; candidate: number }[] = [];
  const measure = async (enabled: boolean) => {
    useFeatureFlagsStore.getState().setLongTurnActivityWindowingEnabled(enabled);
    let elapsed = 0;
    await withDom(async container => {
      const root = createRoot(container as unknown as Element);
      try {
        for (const count of [200, 400, 800]) {
          const messages = [user, ...all.slice(0, count), assistant(1000, 'running')];
          const started = performance.now();
          await act(async () => root.render(<MessageList {...props(messages)} activeStreamingMessageId="a1000" />));
          elapsed += performance.now() - started;
        }
      } finally { await act(async () => root.unmount()); }
    });
    return elapsed;
  };
  await measure(false); await measure(true);
  for (let i = 0; i < 10; i++) {
    const first = i % 2 === 0 ? false : true;
    const a = await measure(first), b = await measure(!first);
    samples.push(first ? { baseline: b, candidate: a } : { baseline: a, candidate: b });
  }
  useFeatureFlagsStore.getState().setLongTurnActivityWindowingEnabled(false);
  process.stdout.write(`DEVRYAN_LONG_TURN_SAMPLES ${JSON.stringify(samples)}\n`);
}, 60_000);

test('search navigation reveals an older message in the mounted active turn', async () => {
  useFeatureFlagsStore.getState().setLongTurnActivityWindowingEnabled(true);
  await withDom(async container => {
    const handlers = new Map<string, Set<EventListener>>();
    const target = window as unknown as { addEventListener: (type: string, listener: EventListener) => void; removeEventListener: (type: string, listener: EventListener) => void; dispatchEvent: (event: Event) => boolean };
    target.addEventListener = (type, listener) => { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type)?.add(listener); };
    target.removeEventListener = (type, listener) => { handlers.get(type)?.delete(listener); };
    target.dispatchEvent = event => { handlers.get(event.type)?.forEach(listener => listener(event)); return true; };
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'CustomEvent');
    class LocalEvent { type: string; detail: unknown; constructor(type: string, options: { detail: unknown }) { this.type = type; this.detail = options.detail; } }
    Object.defineProperty(globalThis, 'CustomEvent', { value: LocalEvent, configurable: true });
    const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
    const ref = React.createRef<import('./MessageList').MessageListHandle>();
    try {
      const messages = [user, ...Array.from({ length: 100 }, (_, i) => assistant(i)), assistant(100, 'running')];
      await act(async () => root.render(<MessageList {...props(messages)} ref={ref} scrollRef={{ current: container as unknown as HTMLDivElement }} />));
      expect(container.find(node => node.attributes['data-message-id'] === 'a0')).toBeNull();
      await act(async () => { expect(ref.current?.scrollToMessageId('a0')).toBe(true); await new Promise(resolve => setTimeout(resolve, 5)); });
      expect(container.find(node => node.attributes['data-message-id'] === 'a0')).not.toBeNull();
      await act(async () => root.render(null));
      await act(async () => root.render(<MessageList {...props(messages)} ref={ref} scrollRef={{ current: container as unknown as HTMLDivElement }} />));
      expect(container.find(node => node.attributes['data-message-id'] === 'a0')).toBeNull();
      await act(async () => { expect(ref.current?.restoreViewportAnchor({ messageId: 'a0', offsetTop: 20 })).toBe(true); await new Promise(resolve => setTimeout(resolve, 5)); });
      expect(container.find(node => node.attributes['data-message-id'] === 'a0')).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      if (previous) Object.defineProperty(globalThis, 'CustomEvent', previous); else Reflect.deleteProperty(globalThis, 'CustomEvent');
    }
  });
  useFeatureFlagsStore.getState().setLongTurnActivityWindowingEnabled(false);
});

test('keeps short turns and the disabled path fully mounted, and reconnect can reveal retained history', async () => {
  await withDom(async container => {
    const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
    const render = async (messages: ChatMessageEntry[]) => act(async () => root.render(<MessageList {...props(messages)} />));
    try {
      useFeatureFlagsStore.getState().setLongTurnActivityWindowingEnabled(true);
      await render([user, ...Array.from({ length: 59 }, (_, i) => assistant(i))]);
      expect(container.find(node => node.attributes['data-message-id'] === 'a0')).not.toBeNull();
      const large = [user, ...Array.from({ length: 100 }, (_, i) => assistant(i))];
      await render(large);
      expect(container.find(node => node.attributes['data-message-id'] === 'a0')).toBeNull();
      // Reconnecting with cloned canonical messages never destroys older parts.
      await render(large.map(message => ({ ...message, parts: [...message.parts] })));
      for (let i = 0; i < 2; i++) {
        const button = container.find(node => node.tagName === 'BUTTON' && node.textContent.includes('older'));
        if (button) await act(async () => button.click());
      }
      expect(container.find(node => node.attributes['data-message-id'] === 'a0')).not.toBeNull();
      await act(async () => useFeatureFlagsStore.getState().setLongTurnActivityWindowingEnabled(false));
      await render(large);
      expect(container.find(node => node.attributes['data-message-id'] === 'a0')).not.toBeNull();
    } finally { await act(async () => root.unmount()); }
  });
  useFeatureFlagsStore.getState().setLongTurnActivityWindowingEnabled(false);
});

test('revealing older activity keeps the existing viewport message at its prior offset', async () => {
  useFeatureFlagsStore.getState().setLongTurnActivityWindowingEnabled(true);
  await withDom(async container => {
    const original = Object.getOwnPropertyDescriptor(HostElement.prototype, 'closest');
    Object.defineProperty(HostElement.prototype, 'closest', { configurable: true, value: () => container });
    const viewport = container as unknown as HTMLDivElement;
    viewport.scrollTop = 10;
    viewport.getBoundingClientRect = () => ({ top: 0, bottom: 500, left: 0, right: 760, width: 760, height: 500, x: 0, y: 0, toJSON: () => ({}) });
    const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
    try {
      const messages = [user, ...Array.from({ length: 100 }, (_, i) => assistant(i)), assistant(100, 'running')];
      await act(async () => root.render(<MessageList {...props(messages)} />));
      const target = container.find(node => node.attributes['data-message-id'] === 'a60');
      expect(target).not.toBeNull();
      if (!target) throw new Error('viewport message missing');
      Object.defineProperty(target, 'dataset', { value: { messageId: 'a60' }, configurable: true });
      target.getBoundingClientRect = () => ({ top: container.textContent.includes('p20') ? 200 : 100, bottom: 220, left: 0, right: 760, width: 760, height: 20 });
      Object.defineProperty(container, 'querySelectorAll', { value: () => [target], configurable: true });
      const button = container.find(node => node.tagName === 'BUTTON' && node.textContent.includes('older'));
      await act(async () => button?.click());
      expect(viewport.scrollTop).toBe(110);
    } finally {
      await act(async () => root.unmount());
      if (original) Object.defineProperty(HostElement.prototype, 'closest', original);
    }
  });
  useFeatureFlagsStore.getState().setLongTurnActivityWindowingEnabled(false);
});
