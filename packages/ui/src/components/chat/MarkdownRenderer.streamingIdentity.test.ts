import { describe, expect, test } from 'bun:test';

import { streamMarkdownBlocks } from './markdownStreamingBlocks';

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
