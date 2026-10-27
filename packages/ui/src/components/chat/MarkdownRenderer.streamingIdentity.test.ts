import { describe, expect, test } from 'bun:test';

import { splitMarkdownSections, streamMarkdownBlocks } from './markdownStreamingBlocks';

describe('streaming Markdown identity', () => {
  test('keeps the rendered block mounted while streaming content grows', () => {
    const first = streamMarkdownBlocks('A response', true, 'message-1');
    const next = streamMarkdownBlocks('A response with more text', true, 'message-1');

    expect(first[0]?.key).toBe(next[0]?.key);
    expect(first[0]?.src).not.toBe(next[0]?.src);
  });

  test('keeps the rendered block mounted when streaming becomes terminal', () => {
    const streaming = streamMarkdownBlocks('```ts\nconst answer = 42;\n```', true, 'message-1');
    const terminal = streamMarkdownBlocks('```ts\nconst answer = 42;\n```', false, 'message-1');

    expect(streaming[0]?.key).toBe(terminal[0]?.key);
    expect(streaming[0]?.mode).toBe('live');
    expect(terminal[0]?.mode).toBe('full');
  });

  test('does not share identity across messages', () => {
    const first = streamMarkdownBlocks('Same text', true, 'message-1');
    const second = streamMarkdownBlocks('Same text', true, 'message-2');

    expect(first[0]?.key).not.toBe(second[0]?.key);
  });
});

describe('streaming Markdown sections', () => {
  const sections = (text: string) => splitMarkdownSections(text);

  test('splits top-level blocks and concatenates back to the source', () => {
    const text = '# Title\n\nFirst paragraph.\n\n- a\n- b\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nDone';
    const parts = sections(text);
    expect(parts).toEqual([
      '# Title\n\n',
      'First paragraph.\n\n',
      '- a\n- b\n\n',
      '```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n',
      '| a | b |\n| - | - |\n| 1 | 2 |\n\n',
      'Done',
    ]);
    expect(parts.join('')).toBe(text);
  });

  test('keeps loose lists, indented continuations, open fences and display math together', () => {
    expect(sections('1. one\n\n2. two\n\n   more\n\nAfter')).toEqual(['1. one\n\n2. two\n\n   more\n\n', 'After']);
    expect(sections('Para\n\n```\nopen\n\nstill code')).toEqual(['Para\n\n', '```\nopen\n\nstill code']);
    expect(sections('$$\na\n\nb\n$$\n\nNext')).toEqual(['$$\na\n\nb\n$$\n\n', 'Next']);
    expect(sections('```inline``` text\n\nnext')).toEqual(['```inline``` text\n\n', 'next']);
    expect(sections('\n\nHello')).toEqual(['\n\nHello']);
  });

  test('keeps the whole text in one block for references, footnotes and raw HTML outside code', () => {
    expect(sections('See [x].\n\n[x]: https://example.com')).toHaveLength(1);
    expect(sections('Text[^1].\n\n[^1]: note')).toHaveLength(1);
    expect(sections('<details>\n\nbody\n\n</details>')).toHaveLength(1);
    expect(sections('Code:\n\n```html\n<div>\n\n</div>\n```\n\nAfter')).toHaveLength(3);
  });

  test('earlier sections keep their key and source while the tail grows', () => {
    const first = streamMarkdownBlocks('Intro.\n\n```ts\nconst a', true, 'message-1');
    const next = streamMarkdownBlocks('Intro.\n\n```ts\nconst a = 1;\n```\n\nAnd', true, 'message-1');
    const terminal = streamMarkdownBlocks('Intro.\n\n```ts\nconst a = 1;\n```\n\nAnd done.', false, 'message-1');

    expect(next[0]).toEqual({ ...first[0] });
    expect(next[1]?.key).toBe(first[1]?.key);
    expect(terminal.map((block) => block.key)).toEqual(next.map((block) => block.key));
    expect(terminal[1]?.src).toBe(next[1]?.src);
  });
});
