import React from 'react';
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { withDom } from '../bots/chat/botMountedDom';
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

describe('Bot markdown independence from the OpenCode directory provider', () => {
  test('MarkdownRenderer with file references off never reads the OpenCode directory', () => {
    const markup = renderToStaticMarkup(<MarkdownRenderer messageId="msg_bot" content="hello **bot**" enableFileReferences={false} />);

    expect(markup).toContain('<strong>bot</strong>');
    expect(directoryReads).toBe(0);
  });

  test('SimpleMarkdownRenderer with file references off never reads the OpenCode directory', () => {
    const markup = renderToStaticMarkup(<SimpleMarkdownRenderer content="hello **bot**" enableFileReferences={false} />);

    expect(markup).toContain('<strong>bot</strong>');
    expect(directoryReads).toBe(0);
  });

  test('both renderers resolve the directory when file references are on', () => {
    renderToStaticMarkup(<MarkdownRenderer messageId="msg_bot" content="see `src/a.ts`" />);
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
          await act(async () => root.render(<Renderer messageId="msg_bot" content="x" enableFileReferences />));
          expect(container.textContent).toContain('x');
          const readsBefore = directoryReads;
          const runtimeBefore = runtimeReads;
          await act(async () => root.render(<Renderer messageId="msg_bot" content="x" enableFileReferences={false} />));
          expect(runtimeReads).toBeGreaterThan(runtimeBefore);
          expect(directoryReads).toBe(readsBefore);
        }
      } finally { await act(async () => root.unmount()); }
    });
  });
});
