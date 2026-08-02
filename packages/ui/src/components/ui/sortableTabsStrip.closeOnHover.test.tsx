import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { RiFileLine } from '@remixicon/react';

import { I18nProvider } from '@/lib/i18n';
import { SortableTabsStrip, type SortableTabsStripItem } from './sortable-tabs-strip';

const items: SortableTabsStripItem[] = [
  { id: 'plan', label: 'Plan', icon: <RiFileLine className="h-4 w-4" /> },
  { id: 'file', label: 'index.ts', icon: <RiFileLine className="h-4 w-4" /> },
];

const renderStrip = (variant: 'soft-pill' | 'default') => renderToStaticMarkup(
  <I18nProvider>
    <SortableTabsStrip
      items={items}
      activeId="plan"
      onSelect={() => {}}
      onClose={() => {}}
      variant={variant}
      layoutMode="scrollable"
    />
  </I18nProvider>
);

// Close controls render as an element carrying aria-label="Close <label> tab".
const closeControlClassFor = (markup: string, label: string) => {
  const index = markup.indexOf(`aria-label="Close ${label} tab"`);
  expect(index).toBeGreaterThan(-1);
  const tagStart = markup.lastIndexOf('<', index);
  const tag = markup.slice(tagStart, markup.indexOf('>', index) + 1);
  return /class="([^"]*)"/.exec(tag)?.[1] ?? '';
};

describe('tab close control visibility', () => {
  test('hides the soft-pill close control until the tab row is hovered, active tab included', () => {
    const markup = renderStrip('soft-pill');

    for (const label of ['Plan', 'index.ts']) {
      const className = closeControlClassFor(markup, label);
      expect(className).toContain('opacity-0');
      expect(className).toContain('group-hover:opacity-100');
    }
  });

  test('reveals the close control on keyboard focus so it is reachable without a pointer', () => {
    const className = closeControlClassFor(renderStrip('soft-pill'), 'Plan');
    expect(className).toContain('focus-visible:opacity-100');
  });

  test('applies the same hover-only rule to the icon-swapping variants', () => {
    const className = closeControlClassFor(renderStrip('default'), 'Plan');
    expect(className).toContain('opacity-0');
    expect(className).toContain('group-hover:opacity-100');
  });
});
