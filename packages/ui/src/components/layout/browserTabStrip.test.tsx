import React, { act } from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { withDom, type HostElement } from '@/test/mountedDom';
import { BrowserTabStrip, type BrowserTabStripItem } from './BrowserTabStrip';

const noop = () => {};
const items: BrowserTabStripItem[] = [
  { id: 'one', label: 'One' },
  { id: 'two', label: 'Two' },
];

const strip = (props: { items?: BrowserTabStripItem[]; activeId?: string | null; trailingActions?: React.ReactNode } = {}) => (
  <BrowserTabStrip
    items={props.items ?? items}
    activeId={props.activeId === undefined ? 'one' : props.activeId}
    onSelect={noop}
    onClose={noop}
    onReorder={noop}
    onAdd={noop}
    trailingActions={props.trailingActions}
  />
);
const render = (props?: Parameters<typeof strip>[0]) => renderToStaticMarkup(strip(props));

const tagContaining = (markup: string, needle: string) => {
  const index = markup.indexOf(needle);
  expect(index).toBeGreaterThan(-1);
  return markup.slice(markup.lastIndexOf('<', index), markup.indexOf('>', index) + 1);
};
const classOf = (tag: string) => / class="([^"]*)"/.exec(tag)?.[1] ?? '';
const tabWrapper = (markup: string, id: string) => {
  const start = markup.indexOf(`data-browser-tab-id="${id}"`);
  expect(start).toBeGreaterThan(-1);
  const next = markup.indexOf('data-browser-tab-id=', start + 1);
  return markup.slice(start, next === -1 ? undefined : next);
};

describe('Chrome-style browser tab strip', () => {
  test('keeps the active close control visible and reveals inactive ones on hover or focus', () => {
    const markup = render();

    expect(classOf(tagContaining(tabWrapper(markup, 'one'), 'aria-label="Close One tab"'))).toContain('opacity-100');
    expect(classOf(tagContaining(tabWrapper(markup, 'one'), 'aria-label="Close One tab"'))).not.toContain('opacity-0');
    const inactive = classOf(tagContaining(tabWrapper(markup, 'two'), 'aria-label="Close Two tab"'));
    expect(inactive).toContain('opacity-0');
    expect(inactive).toContain('group-hover:opacity-100');
    expect(inactive).toContain('group-focus-within:opacity-100');
  });

  test('keeps the add button inline after the last tab, followed by a flexible spacer', () => {
    const markup = render();
    const add = markup.indexOf('aria-label="New Browser Tab"');

    expect(add).toBeGreaterThan(markup.indexOf('data-browser-tab-id="two"'));
    expect(markup.indexOf('<span class="min-w-2 flex-1" aria-hidden="true"></span>')).toBeGreaterThan(add);
    expect(markup).not.toContain('Close Browser Tabs');
  });

  test('omits the close control for tabs that are not closable', () => {
    const markup = render({ items: [{ id: 'one', label: 'One', closable: false }, { id: 'two', label: 'Two' }] });

    expect(markup).not.toContain('Close One tab');
    expect(markup).toContain('Close Two tab');
  });

  test('renders trailing actions outside the tab list', () => {
    const markup = render({ trailingActions: <button type="button">Extra</button> });

    expect(markup.indexOf('>Extra<')).toBeGreaterThan(markup.indexOf('aria-label="New Browser Tab"'));
  });

  test('renders favicons without a referrer, a globe fallback, a loading spinner and a lease dot', () => {
    const withFavicon = render({ items: [{ id: 'one', label: 'One', faviconUrl: 'https://example.test/icon.png' }] });
    const img = tagContaining(withFavicon, '<img');
    expect(img).toContain('src="https://example.test/icon.png"');
    expect(img).toContain('referrerPolicy="no-referrer"');

    const bare = render({ items: [{ id: 'one', label: 'One' }] });
    expect(bare).not.toContain('<img');
    expect(bare).toContain('class="remixicon size-4"');

    const loading = render({ items: [{ id: 'one', label: 'One', loading: true, faviconUrl: 'https://example.test/icon.png' }] });
    expect(loading).toContain('animate-spin');
    expect(loading).not.toContain('<img');

    expect(render({ items: [{ id: 'one', label: 'One', leaseDot: true }] })).toContain('ring-[var(--surface-background)]');
    expect(bare).not.toContain('ring-[var(--surface-background)]');
  });

  test('falls back to the globe when the favicon fails to load', async () => {
    await withDom(async (container) => {
      const { createRoot } = await import('react-dom/client');
      const root = createRoot(container as unknown as Element);
      try {
        await act(async () => {
          root.render(strip({ items: [{ id: 'one', label: 'One', faviconUrl: 'https://example.test/broken.png' }] }));
        });
        const image = container.find((node: HostElement) => node.tagName === 'IMG');
        expect(image).not.toBeNull();
        await act(async () => { image?.dispatch('error'); });
        expect(container.find((node: HostElement) => node.tagName === 'IMG')).toBeNull();
        expect(container.find((node: HostElement) => (node.getAttribute('class') ?? '').includes('remixicon'))).not.toBeNull();
      } finally {
        await act(async () => { root.unmount(); });
      }
    });
  });

  test('makes only sortable tabs draggable', () => {
    const markup = render({ items: [{ id: 'one', label: 'One', sortable: false }, { id: 'two', label: 'Two' }] });

    expect(tabWrapper(markup, 'two')).toContain('aria-roledescription="sortable"');
    expect(tabWrapper(markup, 'one').split('<button')[0]).not.toContain('aria-roledescription');
  });

  test('merges the active tab into the toolbar with Chrome corner geometry', () => {
    const markup = render();
    const active = tabWrapper(markup, 'one');
    const inactive = tabWrapper(markup, 'two');

    expect(active).toContain('rounded-t-[8px] bg-[var(--surface-background)]');
    expect(active).toContain('radial-gradient(circle at 0 0');
    expect(active).toContain('radial-gradient(circle at 100% 0');
    expect(active).toContain('aria-selected="true"');
    expect(inactive).not.toContain('radial-gradient');
    expect(inactive).not.toContain('rounded-t-[8px]');
    expect(classOf(tagContaining(markup, 'data-browser-tab-id="one"'))).toContain('min-w-[72px] max-w-[240px] flex-1 basis-0');
  });

  test('hides the separator next to the active tab and keeps it between inactive ones', () => {
    const three: BrowserTabStripItem[] = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }];
    const markup = render({ items: three, activeId: 'a' });

    expect(tabWrapper(markup, 'a')).not.toContain('w-px');
    expect(tabWrapper(markup, 'b')).not.toContain('w-px');
    expect(tabWrapper(markup, 'c')).toContain('w-px');
  });
});
