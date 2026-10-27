import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { HostElement, withDom } from '@/test/mountedDom';
import type { QuestionRequest } from '@/types/question';

// Typed inputs, links and MCP elicitation on the real card. Only the network
// boundary (session-actions), the sync provider and the URL opener are replaced.
const syncModule = await import('@/sync/sync-context');
mock.module('@/sync/sync-context', () => ({
  ...syncModule,
  useSession: () => undefined,
  useSyncChildStores: () => ({ subscribeAll: () => () => {}, children: new Map() }),
}));
let respondCalls: Array<{ sessionID: string; requestID: string; answers: string[][] }> = [];
let rejectCalls: Array<{ sessionID: string; requestID: string }> = [];
const actionsModule = await import('@/sync/session-actions');
mock.module('@/sync/session-actions', () => ({
  ...actionsModule,
  respondToQuestion: async (sessionID: string, requestID: string, answers: string[][]) => { respondCalls.push({ sessionID, requestID, answers }); },
  rejectQuestion: async (sessionID: string, requestID: string) => { rejectCalls.push({ sessionID, requestID }); },
}));
let opened: string[] = [];
const urlModule = await import('@/lib/url');
mock.module('@/lib/url', () => ({ ...urlModule, openExternalUrl: async (url: string) => { opened.push(url); return true; } }));

const { I18nProvider } = await import('@/lib/i18n');
const { QuestionCard } = await import('./QuestionCard');

const elicitation = (questions: QuestionRequest['questions'], id = 'frm_mcp'): QuestionRequest => ({
  id, sessionID: 'ses_1', questions, tool: { messageID: 'msg_1', callID: 'call_1' },
  source: { type: 'mcp-elicitation', server: 'linear', message: 'Linear needs a few details.' },
});
const count = { question: 'How many?', header: 'Count', options: [], custom: true, required: true,
  input: { kind: 'integer' as const, minimum: 1, maximum: 5 } };
const link = (url: string) => ({ question: 'Sign in to Linear', header: 'Sign in', options: [], custom: false, required: true,
  external: { url } });

const card = (requests: QuestionRequest[]) => <I18nProvider><QuestionCard requests={requests} /></I18nProvider>;

type ChangeWatcher = (event: { propertyName: string; target: object; type: string }) => void;
const watchers = new WeakMap<object, ChangeWatcher>();
const rafDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
beforeEach(() => {
  Object.defineProperty(HostElement.prototype, 'attachEvent', {
    configurable: true,
    value(this: HostElement, _name: string, watcher: ChangeWatcher) { watchers.set(this, watcher); },
  });
  Object.defineProperty(HostElement.prototype, 'detachEvent', { configurable: true, value() {} });
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: () => 0 });
  respondCalls = []; rejectCalls = []; opened = [];
});
afterEach(() => {
  mock.restore();
  Reflect.deleteProperty(HostElement.prototype, 'attachEvent');
  Reflect.deleteProperty(HostElement.prototype, 'detachEvent');
  if (rafDescriptor) Object.defineProperty(globalThis, 'requestAnimationFrame', rafDescriptor);
  else Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
});

const mountCard = async (requests: QuestionRequest[], run: (container: HostElement) => Promise<void>) => withDom(async (container) => {
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(card(requests)));
    await run(container);
  } finally {
    await act(async () => root.unmount());
  }
});

const button = (container: HostElement, text: string) => container.find((node) => node.tagName === 'BUTTON' && node.textContent.trim().startsWith(text));
const field = (container: HostElement) => container.find((node) => node.tagName === 'INPUT');
const typeInto = async (container: HostElement, value: string) => {
  const input = field(container)!;
  await act(async () => {
    const event = { type: 'focusin', target: input, bubbles: true, preventDefault() {}, stopPropagation() {} };
    for (const listener of container.listeners.get('focusin') ?? []) listener(event);
  });
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!.call(input, value);
    watchers.get(input)?.({ propertyName: 'value', target: input, type: 'propertychange' });
  });
};
const alertText = (container: HostElement) => container.find((node) => node.getAttribute('role') === 'alert')?.textContent ?? null;

describe('QuestionCard typed inputs', () => {
  test('a number field renders a native bounded input instead of the free-text editor', () => {
    const html = renderToStaticMarkup(card([elicitation([count])]));
    const input = html.match(/<input[^>]*>/)?.[0] ?? '';
    for (const attribute of ['type="number"', 'min="1"', 'max="5"', 'step="1"', 'inputMode="numeric"', 'aria-required="true"']) {
      expect(input).toContain(attribute);
    }
    expect(html).not.toContain('<textarea');
    expect(html).toContain('Required');
  });

  test('validates bounds before submit and sends the typed number', async () => {
    await mountCard([elicitation([count])], async (container) => {
      const submit = () => button(container, 'Submit')!;
      expect(submit().hasAttribute('disabled')).toBe(true);
      await typeInto(container, '9');
      expect(alertText(container)).toBe('Must be at most 5');
      expect(submit().hasAttribute('disabled')).toBe(true);
      await typeInto(container, '2.5');
      expect(alertText(container)).toBe('Enter a whole number');
      await typeInto(container, '3');
      expect(alertText(container)).toBeNull();
      await act(async () => { submit().click(); });
      expect(respondCalls).toEqual([{ sessionID: 'ses_1', requestID: 'frm_mcp', answers: [['3']] }]);
    });
  });

  test('prefills a declared default and lets an optional field submit empty', async () => {
    const email = { question: 'Contact email', header: 'Email', options: [], custom: true, required: false,
      input: { kind: 'email' as const, placeholder: 'you@example.com' } };
    const defaulted = { ...count, input: { ...count.input, default: 2 } };
    expect(renderToStaticMarkup(card([elicitation([email])]))).toContain('placeholder="you@example.com"');
    await mountCard([elicitation([defaulted, email])], async (container) => {
      expect(field(container)!.value).toBe('2');
      await act(async () => { button(container, 'Next')!.click(); });
      expect(button(container, 'Submit')!.hasAttribute('disabled')).toBe(false);
      await typeInto(container, 'nope');
      expect(alertText(container)).toBe('Enter an email address');
      await typeInto(container, '');
      await act(async () => { button(container, 'Submit')!.click(); });
      expect(respondCalls).toEqual([{ sessionID: 'ses_1', requestID: 'frm_mcp', answers: [['2'], []] }]);
    });
  });
});

describe('QuestionCard MCP elicitation', () => {
  test('names the asking server, shows its message and declines instead of skipping', async () => {
    const html = renderToStaticMarkup(card([elicitation([count])]));
    expect(html).toContain('linear is requesting input');
    expect(html).toContain('Linear needs a few details.');
    await mountCard([elicitation([count])], async (container) => {
      expect(button(container, 'Skip')).toBeNull();
      await act(async () => { button(container, 'Decline')!.click(); });
      expect(rejectCalls).toEqual([{ sessionID: 'ses_1', requestID: 'frm_mcp' }]);
      expect(respondCalls).toEqual([]);
    });
  });

  test('a link is shown, opened only on click, and confirmed before it can be submitted', async () => {
    const request = elicitation([link('https://linear.app/oauth?state=x')]);
    const html = renderToStaticMarkup(card([request]));
    expect(html).toContain('<span class="font-semibold text-foreground">linear.app</span>');
    expect(html).not.toContain('<textarea');
    await mountCard([request], async (container) => {
      expect(opened).toEqual([]);
      const submit = () => button(container, 'Submit')!;
      expect(submit().hasAttribute('disabled')).toBe(true);
      await act(async () => { button(container, 'Open Link')!.click(); });
      expect(opened).toEqual(['https://linear.app/oauth?state=x']);
      expect(submit().hasAttribute('disabled')).toBe(true);
      await act(async () => { button(container, "I've Completed This")!.click(); });
      expect(button(container, "I've Completed This")!.getAttribute('aria-pressed')).toBe('true');
      await act(async () => { submit().click(); });
      expect(respondCalls).toEqual([{ sessionID: 'ses_1', requestID: 'frm_mcp', answers: [['Completed']] }]);
    });
  });

  test('never renders or opens a non-http(s) link', async () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd']) {
      const html = renderToStaticMarkup(card([elicitation([link(url)])]));
      expect(html).not.toContain(url);
      expect(html).not.toContain('Open Link');
    }
    await mountCard([elicitation([link('javascript:alert(1)')])], async (container) => {
      expect(button(container, 'Submit')!.hasAttribute('disabled')).toBe(true);
      expect(opened).toEqual([]);
    });
  });
});
