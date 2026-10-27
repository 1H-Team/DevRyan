import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/lib/i18n';
import { buttonVariants } from './button';
import { SortableTabsStrip } from './sortable-tabs-strip';

const renderPillTabs = (activePillLowercase?: boolean) => renderToStaticMarkup(
  createElement(I18nProvider, null, createElement(SortableTabsStrip, {
    items: [{ id: 'a', label: 'Alpha' }],
    activeId: 'a',
    onSelect: () => {},
    variant: 'active-pill',
    ...(activePillLowercase === undefined ? {} : { activePillLowercase }),
  })),
);

describe('button casing', () => {
  test('preserves the authored casing for control labels', () => {
    const classNames = buttonVariants().split(/\s+/);

    expect(classNames).toContain('normal-case');
    expect(classNames).not.toContain('lowercase');
  });

  test('does not lowercase active-pill tab labels by default', () => {
    const tabClasses = /<button[^>]*role="tab"[^>]*class="([^"]*)"/.exec(renderPillTabs())?.[1].split(/\s+/) ?? [];

    expect(tabClasses).toContain('animated-tabs__button');
    expect(tabClasses).not.toContain('lowercase');
  });

  test('lowercases active-pill tab labels only when asked', () => {
    const tabClasses = /<button[^>]*role="tab"[^>]*class="([^"]*)"/.exec(renderPillTabs(true))?.[1].split(/\s+/) ?? [];

    expect(tabClasses).toContain('lowercase');
  });
});
