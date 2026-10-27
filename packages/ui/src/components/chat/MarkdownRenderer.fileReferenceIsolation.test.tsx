import React from 'react';
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withDom } from '@/test/mountedDom';
import { beforeEach, describe, expect, mock, test } from 'bun:test';

let directoryReads = 0;
let runtimeReads = 0;
mock.module('@/hooks/useEffectiveDirectory', () => ({
  useEffectiveDirectory: () => {
    directoryReads += 1;
    return '/repo';
  },
}));
mock.module('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => {
    runtimeReads += 1;
    return { files: null, editor: null };
  } }));
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

const { MarkdownRenderer, SimpleMarkdownRenderer } = await import('./MarkdownRendererImpl');

beforeEach(() => {
  directoryReads = 0;
  runtimeReads = 0;
});

describe('Markdown rendering without file references', () => {
  test('MarkdownRenderer with file references off never reads the OpenCode directory', () => {
    const markup = renderToStaticMarkup(<MarkdownRenderer messageId="msg_plain" content="hello **world**" enableFileReferences={false} />);

    expect(markup).toContain('<strong>world</strong>');
    expect(directoryReads).toBe(0);
  });

  test('SimpleMarkdownRenderer with file references off never reads the OpenCode directory', () => {
    const markup = renderToStaticMarkup(<SimpleMarkdownRenderer content="hello **world**" enableFileReferences={false} />);

    expect(markup).toContain('<strong>world</strong>');
    expect(directoryReads).toBe(0);
  });

  test('both renderers resolve the directory when file references are on', () => {
    renderToStaticMarkup(<MarkdownRenderer messageId="msg_plain" content="see `src/a.ts`" />);
    expect(directoryReads).toBe(1);
    renderToStaticMarkup(<SimpleMarkdownRenderer content="see `src/a.ts`" />);
    expect(directoryReads).toBe(2);
  });

  test('toggling file references re-renders instead of being swallowed by the memo comparator', async () => {
    await withDom(async (container) => {
      const { createRoot } = await import('react-dom/client');
      const root = createRoot(container as unknown as Element);
      try {
        for (const Renderer of [MarkdownRenderer, SimpleMarkdownRenderer]) {
          await act(async () => root.render(<Renderer messageId="msg_plain" content="x" enableFileReferences />));
          expect(container.textContent).toContain('x');
          const readsBefore = directoryReads;
          const runtimeBefore = runtimeReads;
          await act(async () => root.render(<Renderer messageId="msg_plain" content="x" enableFileReferences={false} />));
          expect(runtimeReads).toBeGreaterThan(runtimeBefore);
          expect(directoryReads).toBe(readsBefore);
        }
      } finally { await act(async () => root.unmount()); }
    });
  });
});
