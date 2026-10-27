import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Message, Part } from '@opencode-ai/sdk/v2/client';

import { HostElement, withDom } from '@/test/mountedDom';
import type { QuestionRequest } from '@/types/question';

// Behavioural replacement for the QuestionCard source-text contracts. The real
// card, option rows, submission lock and orphan detection run; only the
// network boundary (session-actions) and the sync provider are replaced.
const noopUnsubscribe = () => () => {};
let childStates: Array<{ question: Record<string, QuestionRequest[]>; part: Record<string, Part[]>; message: Record<string, Message[]> }> = [];
const childStores = {
  subscribeAll: noopUnsubscribe,
  get children() {
    return new Map(childStates.map((state, index) => [String(index), { getState: () => state }]));
  },
};
const syncModule = await import('@/sync/sync-context');
mock.module('@/sync/sync-context', () => ({
  ...syncModule,
  useSession: () => undefined,
  useSyncChildStores: () => childStores,
}));

type Deferred = { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void };
const deferred = (): Deferred => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
let respondCalls: Array<{ sessionID: string; requestID: string; answers: string[][] }> = [];
let rejectCalls: Array<{ sessionID: string; requestID: string }> = [];
let pendingNetwork: Deferred | null = null;
const actionsModule = await import('@/sync/session-actions');
mock.module('@/sync/session-actions', () => ({
  ...actionsModule,
  respondToQuestion: async (sessionID: string, requestID: string, answers: string[][]) => {
    respondCalls.push({ sessionID, requestID, answers });
    await pendingNetwork?.promise;
  },
  rejectQuestion: async (sessionID: string, requestID: string) => {
    rejectCalls.push({ sessionID, requestID });
    await pendingNetwork?.promise;
  },
}));

const { I18nProvider } = await import('@/lib/i18n');
const { toast } = await import('@/components/ui/toast');
const { QuestionCard } = await import('./QuestionCard');
const { QuestionOptionRow } = await import('./QuestionOptionRow');

const request = (overrides: Partial<QuestionRequest> = {}): QuestionRequest => ({
  id: 'que_1',
  sessionID: 'ses_1',
  questions: [{
    header: 'Pick',
    question: 'Which theme?\nWhy: the audit asked for it.',
    multiple: false,
    options: [{ label: 'Dark', description: 'Dark mode' }, { label: 'Light (Recommended)', description: '' }],
  }],
  ...overrides,
} as QuestionRequest);

const card = (requests: QuestionRequest[]) => (
  <I18nProvider><QuestionCard requests={requests} /></I18nProvider>
);

const rafDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
beforeEach(() => {
  Object.defineProperty(HostElement.prototype, 'attachEvent', {
    configurable: true,
    value(this: HostElement, _name: string, watcher: ChangeWatcher) { watchers.set(this, watcher); },
  });
  Object.defineProperty(HostElement.prototype, 'detachEvent', { configurable: true, value() {} });
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: () => 0 });
  respondCalls = [];
  rejectCalls = [];
  pendingNetwork = null;
  childStates = [];
});
afterEach(() => {
  mock.restore();
  Reflect.deleteProperty(HostElement.prototype, 'attachEvent');
  Reflect.deleteProperty(HostElement.prototype, 'detachEvent');
  if (rafDescriptor) Object.defineProperty(globalThis, 'requestAnimationFrame', rafDescriptor);
  else Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
});

const mountCard = async (
  requests: QuestionRequest[],
  run: (container: HostElement, rerender: (next: QuestionRequest[]) => Promise<void>, unmount: () => Promise<void>) => Promise<void>,
) => withDom(async (container) => {
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  let mounted = true;
  const unmount = async () => { if (mounted) { mounted = false; await act(async () => root.unmount()); } };
  try {
    await act(async () => root.render(card(requests)));
    await run(container, (next) => act(async () => root.render(card(next))), unmount);
  } finally {
    await unmount();
  }
});

const button = (container: HostElement, text: string) => container.find((node) => node.tagName === 'BUTTON' && node.textContent.trim().startsWith(text));
const statusText = (container: HostElement) => container.find((node) => node.getAttribute('role') === 'status')?.textContent ?? null;
const textarea = (container: HostElement) => container.find((node) => node.tagName === 'TEXTAREA');
// The host DOM cannot detect native input events, so React falls back to its
// IE-era change polyfill: focusin registers the watcher, a property change fires it.
type ChangeWatcher = (event: { propertyName: string; target: object; type: string }) => void;
const watchers = new WeakMap<object, ChangeWatcher>();
const focusField = async (container: HostElement) => {
  const field = textarea(container)!;
  await act(async () => {
    const event = { type: 'focusin', target: field, bubbles: true, preventDefault() {}, stopPropagation() {} };
    for (const listener of container.listeners.get('focusin') ?? []) listener(event);
  });
};
const type = async (container: HostElement, value: string) => {
  const field = textarea(container)!;
  await focusField(container);
  await act(async () => {
    // Bypass React's value tracker so the change reads as a real edit.
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')!.set!.call(field, value);
    watchers.get(field)?.({ propertyName: 'value', target: field, type: 'propertychange' });
  });
};
const press = async (container: HostElement, key: string, init: Record<string, unknown> = {}) => {
  const field = textarea(container)!;
  await act(async () => {
    const event = { type: 'keydown', target: field, key, bubbles: true, preventDefault() {}, stopPropagation() {}, ...init };
    for (const listener of container.listeners.get('keydown') ?? []) listener(event);
  });
};

describe('QuestionCard option interaction ownership', () => {
  test('renders options as single buttons with radio or checkbox roles and no nested form controls', () => {
    const single = renderToStaticMarkup(card([request()]));
    expect(single.match(/<button[^>]*role="radio"/g)).toHaveLength(2);
    expect(single).not.toContain('role="checkbox"');
    expect(single).not.toContain('<input');

    const multiple = renderToStaticMarkup(card([request({
      questions: [{ header: 'Pick', question: 'Which?', multiple: true, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }],
    } as Partial<QuestionRequest>)]));
    expect(multiple.match(/<button[^>]*role="checkbox"/g)).toHaveLength(2);
    expect(multiple).not.toContain('role="radio"');
    expect(multiple).not.toContain('<input');
  });

  test('selecting an option toggles aria-checked on that row only', async () => {
    await mountCard([request()], async (container) => {
      const rows = () => container.find((node) => node.getAttribute('role') === 'radiogroup')!;
      await act(async () => { button(container, 'Dark')!.click(); });
      const checked = (label: string) => rows().find((node) => node.tagName === 'BUTTON' && node.textContent.startsWith(label))?.getAttribute('aria-checked');
      expect(checked('Dark')).toBe('true');
      expect(checked('Light')).toBe('false');
    });
  });

  test('labels rejection as Skip and skipping rejects the request without answering it', async () => {
    await mountCard([request()], async (container) => {
      expect(button(container, 'Dismiss')).toBeNull();
      await act(async () => { button(container, 'Skip')!.click(); });
      expect(rejectCalls).toEqual([{ sessionID: 'ses_1', requestID: 'que_1' }]);
      expect(respondCalls).toEqual([]);
    });
  });

  test('uses an expanding multiline custom-answer editor that enables Submit only for typed text', async () => {
    const html = renderToStaticMarkup(card([request()]));
    const field = html.match(/<textarea[^>]*>/)?.[0] ?? '';
    expect(field).toContain('rows="1"');
    for (const cls of ['field-sizing-content', 'max-h-[min(40vh,18rem)]', 'whitespace-pre-wrap']) {
      expect(field).toContain(cls);
    }
    // Actions live in their own row below the text so they never take answer width.
    expect(html.indexOf('border-t border-border/30')).toBeGreaterThan(html.indexOf('<textarea'));

    await mountCard([request()], async (container) => {
      const submit = () => button(container, 'Submit')!;
      expect(submit().hasAttribute('disabled')).toBe(true);
      await type(container, 'Use neither');
      expect(submit().hasAttribute('disabled')).toBe(false);
    });
  });

  test('Enter submits the typed custom answer while Shift+Enter does not', async () => {
    await mountCard([request()], async (container) => {
      await type(container, 'Use neither');
      await press(container, 'Enter', { shiftKey: true });
      expect(respondCalls).toEqual([]);
      await press(container, 'Enter');
      expect(respondCalls).toEqual([{ sessionID: 'ses_1', requestID: 'que_1', answers: [['Use neither']] }]);
    });
  });

  test('collapses a submitted request to a status row before the network round trip settles', async () => {
    pendingNetwork = deferred();
    await mountCard([request()], async (container) => {
      await act(async () => { button(container, 'Dark')!.click(); });
      await act(async () => { button(container, 'Submit')!.click(); });
      // The reply is still in flight, yet the card already acknowledged it.
      expect(respondCalls).toHaveLength(1);
      expect(statusText(container)).toBe('Sending response…');
      expect(container.find((node) => node.getAttribute('data-question-card') === 'true')).toBeNull();
      expect(container.find((node) => node.hasAttribute('data-question-submission-state'))).toBeNull();
      expect(container.find((node) => node.getAttribute('aria-live') === 'polite')).not.toBeNull();
      await act(async () => { pendingNetwork!.resolve(); });
    });
  });

  test('collapses a skipped request optimistically', async () => {
    pendingNetwork = deferred();
    await mountCard([request()], async (container) => {
      await act(async () => { button(container, 'Skip')!.click(); });
      expect(rejectCalls).toHaveLength(1);
      expect(statusText(container)).toBe('Sending response…');
      await act(async () => { pendingNetwork!.resolve(); });
    });
  });

  test('restores the card with the failure message when the reply is rejected', async () => {
    pendingNetwork = deferred();
    await mountCard([request()], async (container) => {
      await act(async () => { button(container, 'Dark')!.click(); });
      await act(async () => { button(container, 'Submit')!.click(); });
      expect(statusText(container)).toBe('Sending response…');
      await act(async () => { pendingNetwork!.reject(new Error('Gateway unavailable')); });
      expect(container.find((node) => node.getAttribute('data-question-card') === 'true')).not.toBeNull();
      expect(container.find((node) => node.getAttribute('role') === 'alert')?.textContent).toContain('Gateway unavailable');
    });
  });

  test('reports a failure through a toast when the card is already gone', async () => {
    const errors = spyOn(toast, 'error').mockImplementation(() => 'toast');
    pendingNetwork = deferred();
    await mountCard([request()], async (container, _rerender, unmount) => {
      await act(async () => { button(container, 'Dark')!.click(); });
      await act(async () => { button(container, 'Submit')!.click(); });
      await unmount();
      await act(async () => { pendingNetwork!.reject(new Error('Gateway unavailable')); });
      expect(errors).toHaveBeenCalledTimes(1);
      expect(String(errors.mock.calls[0]?.[0])).toBe('Question response failed to send');
    });
  });
});

describe('QuestionCard question body', () => {
  test('keeps line 1 as the label and aria-label and renders the rest as explanation', () => {
    const html = renderToStaticMarkup(card([request()]));
    expect(html).toContain('aria-label="Which theme?"');
    expect(html).toContain('>Which theme?</div>');
    expect(html).toContain('<span class="font-medium text-foreground">Why:</span>');
    expect(html).toContain('the audit asked for it.');
    expect(html).not.toContain('aria-label="Which theme?\nWhy');
  });
});

describe('QuestionCard stopped-turn handling', () => {
  test('marks its root so global Escape never aborts the turn waiting on it', () => {
    expect(renderToStaticMarkup(card([request()]))).toContain('data-question-card="true"');
  });

  test('explains a stopped turn and still answers through the responder', async () => {
    const orphan = request({ tool: { messageID: 'msg_a', callID: 'call_1' } } as Partial<QuestionRequest>);
    childStates = [{
      question: { ses_1: [orphan] },
      message: {},
      part: { msg_a: [{ type: 'tool', callID: 'call_1', state: { status: 'completed' } } as unknown as Part] },
    }];
    await mountCard([orphan], async (container) => {
      expect(container.textContent).toContain('The turn that asked this has stopped.');
    });
    childStates = [];
    await mountCard([orphan], async (container) => {
      expect(container.textContent).not.toContain('The turn that asked this has stopped.');
    });
  });
});

describe('QuestionOptionRow presentation', () => {
  const row = (props: Partial<React.ComponentProps<typeof QuestionOptionRow>> = {}) => renderToStaticMarkup(
    <QuestionOptionRow label="Dark" description="" selected={false} multiple={false} disabled={false}
      recommended={false} recommendedLabel="Recommended" onSelect={() => {}} {...props} />,
  );

  test('wraps narrow labels, keeps a constant label weight and renders an unnumbered empty badge', () => {
    const unselected = row();
    const selected = row({ selected: true });
    expect(unselected).toContain('flex flex-wrap items-baseline');
    expect(unselected).toContain('typography-meta font-medium break-words');
    expect(selected).toContain('typography-meta font-medium break-words');
    expect(unselected).not.toContain('break-all');
    expect(unselected).not.toContain('text-primary/80');
    // The badge holds no option number (and no check mark until selected).
    expect(unselected.match(/<span aria-hidden="true"[^>]*><\/span>/)).not.toBeNull();
    expect(/>\d+</.test(unselected)).toBe(false);
  });

  test('shows the recommended pill as a muted rounded badge only when recommended', () => {
    expect(row()).not.toContain('Recommended');
    const html = row({ recommended: true });
    expect(html).toContain('rounded-full bg-muted/60');
    expect(html).toContain('>Recommended<');
  });
});
