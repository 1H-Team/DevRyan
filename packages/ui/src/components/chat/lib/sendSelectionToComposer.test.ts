import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { sendSelectionToComposer } from './sendSelectionToComposer';

const originalElement = globalThis.Element;
const originalHTMLElement = globalThis.HTMLElement;
const originalNode = globalThis.Node;

class FixtureElement {
  readonly nodeType = 1;
  readonly childNodes: Array<FixtureElement | FixtureText> = [];
  readonly children: FixtureElement[] = [];
  readonly tagName: string;
  parentElement: FixtureElement | null = null;
  disabled = false;
  value = 'draft';
  focused = false;
  selectionRangeCalls = 0;
  visible = true;
  readonly attributes = new Map<string, string>();

  constructor(tagName: string, attributes: Record<string, string> = {}) {
    this.tagName = tagName.toUpperCase();
    Object.entries(attributes).forEach(([key, value]) => this.attributes.set(key, value));
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join('');
  }

  append(...children: Array<FixtureElement | FixtureText>): this {
    for (const child of children) {
      child.parentElement = this;
      this.childNodes.push(child);
      if (child instanceof FixtureElement) this.children.push(child);
    }
    return this;
  }

  matches(selector: string): boolean {
    if (selector.includes('input') && this.tagName === 'INPUT') return true;
    if (selector.includes('textarea') && this.tagName === 'TEXTAREA') return true;
    if (selector.includes('select') && this.tagName === 'SELECT') return true;
    if (selector.includes('button') && this.tagName === 'BUTTON') return true;
    if (selector.includes('contenteditable') && this.attributes.has('contenteditable')) return true;
    return false;
  }

  closest(selector: string): FixtureElement | null {
    if (selector === '[data-chat-message="true"]' && this.attributes.get('data-chat-message') === 'true') {
      return this;
    }
    if (selector.includes('.terminal-viewport-container') && this.attributes.get('fixture-kind') === 'terminal') {
      return this;
    }
    if (selector.includes('[role="dialog"]') && this.attributes.get('role') === 'dialog') {
      return this;
    }
    if (selector.includes('[contenteditable') && this.attributes.has('contenteditable')) {
      return this;
    }
    return this.parentElement?.closest(selector) ?? null;
  }

  contains(candidate: FixtureElement | FixtureText): boolean {
    let current: FixtureElement | null = candidate instanceof FixtureElement ? candidate : candidate.parentElement;
    while (current) {
      if (current === this) return true;
      current = current.parentElement;
    }
    return false;
  }

  querySelector(selector: string): FixtureElement | null {
    if (selector === 'textarea[data-chat-input="true"]') {
      return this.children.find((child) => child.attributes.get('data-chat-input') === 'true') ?? null;
    }
    return null;
  }

  getClientRects(): Array<Record<string, never>> {
    return this.visible ? [{}] : [];
  }

  focus(): void {
    this.focused = true;
  }

  setSelectionRange(): void {
    this.selectionRangeCalls += 1;
  }
}

class FixtureText {
  readonly nodeType = 3;
  parentElement: FixtureElement | null = null;
  constructor(readonly textContent: string) {}
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'Node', {
    configurable: true,
    value: class { static readonly ELEMENT_NODE = 1; static readonly TEXT_NODE = 3; },
  });
  Object.defineProperty(globalThis, 'Element', { configurable: true, value: FixtureElement });
  Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: FixtureElement });
});

afterEach(() => {
  Object.defineProperty(globalThis, 'Node', { configurable: true, value: originalNode });
  Object.defineProperty(globalThis, 'Element', { configurable: true, value: originalElement });
  Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: originalHTMLElement });
});

const fixture = (selection?: {
  text: string;
  ancestor: FixtureElement | FixtureText;
  contents?: Array<FixtureElement | FixtureText>;
}) => {
  const composer = new FixtureElement('textarea', { 'data-chat-input': 'true' });
  const surface = new FixtureElement('main', { 'data-chat-surface': 'true' }).append(composer);
  const body = new FixtureElement('body');
  const doc = {
    body,
    documentElement: new FixtureElement('html'),
    querySelector: (selector: string) => selector === '[data-chat-surface="true"]' ? surface : null,
  } as unknown as Document;
  const selected = selection ? {
    rangeCount: 1,
    isCollapsed: false,
    toString: () => selection.text,
    getRangeAt: () => ({
      commonAncestorContainer: selection.ancestor,
      cloneContents: () => ({ childNodes: selection.contents ?? [new FixtureText(selection.text)] }),
    }),
    removeAllRangesCalls: 0,
    removeAllRanges() { this.removeAllRangesCalls += 1; },
  } : {
    rangeCount: 0,
    isCollapsed: true,
    toString: () => '',
    removeAllRangesCalls: 0,
  };
  const win = {
    getSelection: () => selected,
    requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 1; },
  } as unknown as Window;
  return { body, composer, doc, selected, surface, win };
};

describe('send selection to composer', () => {
  test('does not consume the browser shortcut without an active composer', () => {
    const { body, doc, win } = fixture();
    expect(sendSelectionToComposer({
      activeMainTab: 'git', eventTarget: body as unknown as EventTarget, append: () => undefined,
      documentRef: doc, windowRef: win,
    })).toBe(false);
  });

  test('focuses without changing content or selection when nothing is selected', () => {
    const { body, composer, doc, win } = fixture();
    expect(sendSelectionToComposer({
      activeMainTab: 'chat', eventTarget: body as unknown as EventTarget, append: () => undefined,
      documentRef: doc, windowRef: win,
    })).toBe(true);
    expect(composer.focused).toBe(true);
    expect(composer.value).toBe('draft');
    expect(composer.selectionRangeCalls).toBe(0);
  });

  test('preserves a selection already inside the composer', () => {
    const { composer, doc, win } = fixture();
    expect(sendSelectionToComposer({
      activeMainTab: 'chat', eventTarget: composer as unknown as EventTarget, append: () => undefined,
      documentRef: doc, windowRef: win,
    })).toBe(true);
    expect(composer.selectionRangeCalls).toBe(0);
  });

  test('ignores terminal and dialog targets', () => {
    for (const target of [
      new FixtureElement('div', { 'fixture-kind': 'terminal' }),
      new FixtureElement('div', { role: 'dialog' }),
    ]) {
      const { doc, surface, win } = fixture();
      surface.append(target);
      expect(sendSelectionToComposer({
        activeMainTab: 'chat', eventTarget: target as unknown as EventTarget, append: () => undefined,
        documentRef: doc, windowRef: win,
      })).toBe(false);
    }
  });

  test('ignores unrelated textareas and editable selections', () => {
    for (const target of [
      new FixtureElement('textarea'),
      new FixtureElement('div', { contenteditable: 'true' }),
    ]) {
      const selectedText = new FixtureText('do not append');
      target.append(selectedText);
      const { doc, surface, win } = fixture({
        text: 'do not append',
        ancestor: selectedText,
      });
      surface.append(target);
      expect(sendSelectionToComposer({
        activeMainTab: 'chat', eventTarget: target as unknown as EventTarget, append: () => undefined,
        documentRef: doc, windowRef: win,
      })).toBe(false);
    }
  });

  test('ignores an editable selection even when the shortcut target is the chat surface', () => {
    const editable = new FixtureElement('div', { contenteditable: 'true' });
    const selectedText = new FixtureText('do not append');
    editable.append(selectedText);
    const { doc, surface, win } = fixture({ text: 'do not append', ancestor: selectedText });
    surface.append(editable);
    expect(sendSelectionToComposer({
      activeMainTab: 'chat', eventTarget: surface as unknown as EventTarget, append: () => undefined,
      documentRef: doc, windowRef: win,
    })).toBe(false);
  });

  test('appends a message selection, clears it, and moves the caret to the end', () => {
    const message = new FixtureElement('article', { 'data-chat-message': 'true' });
    const selectedText = new FixtureText('hello');
    message.append(selectedText);
    const { composer, doc, selected, surface, win } = fixture({
      text: 'hello', ancestor: selectedText, contents: [new FixtureText('hello')],
    });
    surface.append(message);
    const appended: string[] = [];
    expect(sendSelectionToComposer({
      activeMainTab: 'chat', eventTarget: message as unknown as EventTarget, append: (value) => appended.push(value),
      documentRef: doc, windowRef: win,
    })).toBe(true);
    expect(appended).toEqual(['```md\nhello\n```']);
    expect(selected.removeAllRangesCalls).toBe(1);
    expect(composer.selectionRangeCalls).toBe(1);
  });
});
