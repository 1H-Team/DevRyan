import { createElement } from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import { ChangeRow } from './ChangeRow';

const render = (path: string): string => renderToStaticMarkup(
  createElement(I18nProvider, null, createElement(ChangeRow, {
    file: { path, index: ' ', working_dir: 'M' },
    onViewDiff: () => {},
    onRevert: () => {},
    isReverting: false,
  })),
);

const labelSpan = (html: string, path: string): string => {
  const match = html.match(new RegExp(`<span class="([^"]*)" title="${path.replace(/[/.]/g, '\\$&')}">([^<]*)</span>`));
  expect(match).not.toBeNull();
  return `${match![1]}|${match![2]}`;
};

describe('ChangeRow responsive presentation', () => {
  test('shows only the filename in a consistently aligned, truncating label', () => {
    const [classes, text] = labelSpan(render('packages/ui/src/deep/App.tsx'), 'packages/ui/src/deep/App.tsx').split('|');
    for (const name of ['min-w-0', 'flex-1', 'truncate', 'typography-ui-label', 'text-foreground']) {
      expect(classes?.split(' ')).toContain(name);
    }
    expect(text).toBe('App.tsx');
    expect(render('packages/ui/src/deep/App.tsx')).not.toContain('flex-row-reverse');
  });

  test('keeps the complete path available when the visible label truncates', () => {
    expect(render('a/b/c.ts')).toContain('title="a/b/c.ts"');
  });
});
