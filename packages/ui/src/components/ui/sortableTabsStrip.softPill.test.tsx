import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { RiFileLine } from '@remixicon/react';

import { I18nProvider } from '@/lib/i18n';
import { SortableTabsStrip, type SortableTabsStripItem } from './sortable-tabs-strip';

type Variant = 'default' | 'active-pill' | 'animated' | 'soft-pill';

const items: SortableTabsStripItem[] = [
  { id: 'a', label: 'Alpha', icon: <RiFileLine className="h-4 w-4" /> },
  { id: 'b', label: 'Beta', icon: <RiFileLine className="h-4 w-4" /> },
];

const render = (variant: Variant, extra: { activePillLowercase?: boolean } = {}) => renderToStaticMarkup(
  <I18nProvider>
    <SortableTabsStrip
      items={items}
      activeId="a"
      onSelect={() => {}}
      onClose={() => {}}
      variant={variant}
      layoutMode="scrollable"
      {...extra}
    />
  </I18nProvider>,
);

const openingTagOf = (markup: string, needle: string): string => {
  const index = markup.indexOf(needle);
  expect(index).toBeGreaterThan(-1);
  const start = markup.lastIndexOf('<', index);
  return markup.slice(start, markup.indexOf('>', index) + 1);
};
const classOf = (tag: string) => /class="([^"]*)"/.exec(tag)?.[1] ?? '';
const trackClass = (markup: string) => classOf(openingTagOf(markup, 'role="tablist"'));
const tabButtonClass = (markup: string, label: string) => classOf(openingTagOf(markup, `title="${label}"`));
const tabRowClass = (markup: string, id: string) => {
  const tag = openingTagOf(markup, `data-sortable-tab-id="${id}"`);
  const rowStart = markup.indexOf(tag) + tag.length;
  return classOf(markup.slice(rowStart, markup.indexOf('>', rowStart) + 1));
};
const closeControlTag = (markup: string, label: string) => openingTagOf(markup, `aria-label="Close ${label} tab"`);

describe('soft-pill tabs variant', () => {
  test('exposes soft-pill as its own variant on the pill indicator machinery', () => {
    const soft = render('soft-pill');
    expect(trackClass(soft)).toContain('soft-tabs__track');
    expect(tabButtonClass(soft, 'Alpha')).toContain('soft-tabs__button');
    // Pill machinery is shared: the soft variant is not the plain underline/default strip.
    expect(trackClass(render('default'))).not.toContain('soft-tabs__track');
  });

  test('floats the active pill with no recessed track behind the strip', () => {
    expect(trackClass(render('active-pill'))).toContain('bg-[color-mix(in_srgb,var(--foreground)_2%,transparent)]');
    expect(trackClass(render('soft-pill'))).not.toContain('bg-[color-mix');
  });

  test('hovers the whole row so the fill covers the trailing close control', () => {
    // The close button is a sibling of the tab button, so a fill on the button alone
    // stops short of the X and disappears when the pointer moves onto it.
    const markup = render('soft-pill');
    expect(tabRowClass(markup, 'b')).toContain('hover:bg-[color-mix(in_srgb,var(--foreground)_3.5%,transparent)]');
    expect(tabRowClass(markup, 'a')).not.toContain('hover:bg-');
    expect(tabRowClass(markup, 'b')).toContain('rounded-[10px]');
    expect(tabButtonClass(markup, 'Beta')).toContain('text-muted-foreground group-hover:text-foreground');
    expect(tabButtonClass(markup, 'Alpha')).toContain('text-foreground');
  });

  test('keeps the icon and the close control visible together instead of swapping them', () => {
    const soft = render('soft-pill');
    // Soft pill renders the close control as a sibling button of the tab, never over the icon.
    expect(closeControlTag(soft, 'Alpha').startsWith('<button')).toBe(true);
    expect(closeControlTag(soft, 'Alpha')).not.toContain('absolute inset-0');
    expect(soft).not.toContain('group-hover:opacity-0');
    // Other variants overlay the close control on the icon and fade the icon out.
    const pill = render('active-pill');
    expect(closeControlTag(pill, 'Alpha')).toContain('absolute inset-0');
    expect(pill).toContain('group-hover:opacity-0');
  });

  test('reveals the close control on hover only, including on the active tab', () => {
    const soft = render('soft-pill');
    for (const label of ['Alpha', 'Beta']) {
      const className = classOf(closeControlTag(soft, label));
      expect(className).toContain('opacity-0 group-hover:opacity-100 focus-visible:opacity-100');
    }
  });

  test('scopes its own container queries so pill-tabs rules do not leak in', () => {
    const soft = trackClass(render('soft-pill'));
    expect(soft).toContain('@container/soft-tabs');
    expect(soft).not.toContain('pill-tabs');
    const pill = trackClass(render('active-pill'));
    expect(pill).toContain('@container/pill-tabs');
    expect(pill).toContain('pill-tabs__track');
    expect(pill).not.toContain('soft-tabs');
  });

  test('declares the soft-tabs container breakpoints and label rule in the stylesheet', () => {
    // Generated-asset contract: the markup's container names must match real CSS rules.
    const styles = readFileSync(new URL('../../index.css', import.meta.url), 'utf8');
    expect(styles).toContain('@container soft-tabs (max-width: 20rem)');
    expect(styles).toContain('@container soft-tabs (max-width: 12rem)');
    expect(styles).toContain('.soft-tabs__label');
  });

  // The sliding indicator only exists after the strip measures its active tab in a
  // browser (offsetLeft/offsetWidth), so it cannot be rendered statically; its fill
  // classes are the only source pins kept in this file.
  test('fills the active pill with a themeable neutral instead of an elevated surface and border', () => {
    const source = readFileSync(new URL('./sortable-tabs-strip.tsx', import.meta.url), 'utf8');
    expect(source).toContain("'rounded-[10px] bg-[color-mix(in_srgb,var(--foreground)_6%,transparent)]'");
    expect(source).toContain("'rounded-[9px] bg-[var(--surface-elevated)] border border-border/60'");
  });
});
