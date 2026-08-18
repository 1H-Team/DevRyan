import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { rangeToMarkdown, wrapSelectionMarkdownForComposer } from './selectionMarkdown';

const originalNode = globalThis.Node;
const originalHTMLElement = globalThis.HTMLElement;

class FixtureElement {
  readonly nodeType = 1;
  readonly childNodes: Array<FixtureElement | FixtureText>;
  readonly children: FixtureElement[];
  readonly tagName: string;
  readonly className: string;
  readonly textContent: string;
  private readonly attributes: Record<string, string>;

  constructor(
    tagName: string,
    children: Array<FixtureElement | FixtureText> = [],
    attributes: Record<string, string> = {},
  ) {
    this.tagName = tagName.toUpperCase();
    this.childNodes = children;
    this.children = children.filter((child): child is FixtureElement => child instanceof FixtureElement);
    this.attributes = attributes;
    this.className = attributes.class ?? '';
    this.textContent = children.map((child) => child.textContent).join('');
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  querySelector(selector: string): FixtureElement | null {
    if (selector === 'code') {
      return this.children.find((child) => child.tagName === 'CODE') ?? null;
    }
    return null;
  }
}

class FixtureText {
  readonly nodeType = 3;
  constructor(readonly textContent: string) {}
}

const text = (value: string) => new FixtureText(value);
const element = (
  tag: string,
  children: Array<FixtureElement | FixtureText>,
  attributes: Record<string, string> = {},
) => new FixtureElement(tag, children, attributes);
const range = (children: Array<FixtureElement | FixtureText>): Range => ({
  cloneContents: () => ({ childNodes: children }),
} as unknown as Range);

beforeEach(() => {
  Object.defineProperty(globalThis, 'Node', {
    configurable: true,
    value: class { static readonly ELEMENT_NODE = 1; static readonly TEXT_NODE = 3; },
  });
  Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: FixtureElement });
});

afterEach(() => {
  Object.defineProperty(globalThis, 'Node', { configurable: true, value: originalNode });
  Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: originalHTMLElement });
});

describe('selection markdown conversion', () => {
  test('converts plain and inline Markdown selections', () => {
    expect(rangeToMarkdown(range([text(' plain text ')]), 'plain text')).toBe('plain text');
    expect(rangeToMarkdown(range([
      text('Use '),
      element('strong', [text('bold')]),
      text(' now'),
    ]), 'Use bold now')).toBe('Use**bold**now');
  });

  test('converts fenced code and list selections', () => {
    const code = element('pre', [element('code', [text('const value = 1;\n')], { class: 'language-ts' })]);
    expect(rangeToMarkdown(range([code]), 'const value = 1;')).toBe(
      '```ts\nconst value = 1;\n```',
    );

    const list = element('ul', [
      element('li', [text('One')]),
      element('li', [text('Two')]),
    ]);
    expect(rangeToMarkdown(range([list]), 'One Two')).toBe('- One\n- Two');
  });

  test('uses the exact composer fence shared by the menu and shortcut', () => {
    expect(wrapSelectionMarkdownForComposer('hello')).toBe('```md\nhello\n```');
  });
});
