import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./BrowserTabStrip.tsx', import.meta.url), 'utf8');

describe('Chrome-style browser tab strip', () => {
  test('keeps the active close control visible and the add button inline', () => {
    expect(source).toContain("active ? 'opacity-100'");
    expect(source).toContain('aria-label="New Browser Tab"');
    expect(source.indexOf('items.map((item, index)')).toBeLessThan(source.indexOf('aria-label="New Browser Tab"'));
    expect(source).toContain("<span className=\"min-w-2 flex-1\"");
  });

  test('renders favicons with a safe globe fallback and lease dot', () => {
    expect(source).toContain('referrerPolicy="no-referrer"');
    expect(source).toContain('onError={() => setFailed(true)}');
    expect(source).toContain('<RiGlobalLine');
    expect(source).toContain('leaseDot ? (');
  });

  test('uses horizontal dnd only for sortable manual tabs', () => {
    expect(source).toContain('<DndContext');
    expect(source).toContain('<SortableContext');
    expect(source).toContain('horizontalListSortingStrategy');
    expect(source).toContain('restrictToXAxis');
    expect(source).toContain('item.sortable === false ? StaticBrowserTab : SortableBrowserTab');
    expect(source).toContain('handleClosableTabAuxClick');
  });

  test('merges the active tab into the toolbar with Chrome corner geometry', () => {
    expect(source).toContain('rounded-t-[8px] bg-[var(--surface-background)]');
    expect(source).toContain('radial-gradient(circle at 0 0');
    expect(source).toContain('radial-gradient(circle at 100% 0');
    expect(source).toContain('min-w-[72px] max-w-[240px] flex-1 basis-0');
  });
});
