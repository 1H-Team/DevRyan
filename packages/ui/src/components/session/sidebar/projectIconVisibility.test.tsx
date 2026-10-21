import React from 'react';
import { readFileSync } from 'node:fs';
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { DndContext } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';
import { I18nProvider } from '@/lib/i18n';

mock.module('@/contexts/useThemeSystem', () => ({
  useThemeSystem: () => ({ currentTheme: { metadata: { variant: 'light' }, colors: { surface: { foreground: '#000' } } } }),
}));
const { SortableProjectItem } = await import('./sortableItems');

type Props = React.ComponentProps<typeof SortableProjectItem>;

const render = (overrides: Partial<Props> = {}) => renderToStaticMarkup(
  <I18nProvider>
    <DndContext>
      <SortableContext items={['project-1']}>
        <SortableProjectItem
          id="project-1"
          projectLabel="Project"
          projectDescription="/project"
          isCollapsed={false}
          isActiveProject
          isRepo
          isDesktopShell={false}
          isStuck={false}
          hideProjectAdminControls={false}
          hideWorktreeControls={false}
          mobileVariant={false}
          alwaysShowActions={false}
          onToggle={() => {}}
          onNewSession={() => {}}
          onNewWorktreeSession={() => {}}
          onRenameStart={() => {}}
          onClose={() => {}}
          sentinelRef={() => {}}
          openSidebarMenuKey={null}
          setOpenSidebarMenuKey={() => {}}
          {...overrides}
        />
      </SortableContext>
    </DndContext>
  </I18nProvider>,
);

const openingTag = (markup: string, needle: string) => {
  const index = markup.indexOf(needle);
  expect(index).toBeGreaterThan(-1);
  return markup.slice(markup.lastIndexOf('<', index), markup.indexOf('>', index) + 1);
};

describe('left sidebar project header icon', () => {
  test('keeps project icon visible when actions are always shown', () => {
    for (const alwaysShowActions of [true, false]) {
      const icon = openingTag(render({ alwaysShowActions }), 'data-project-header-icon');

      expect(icon).toContain('inline-flex');
      expect(icon).not.toContain('hidden');
    }
  });

  test('swaps the header padding, not the icon, for always-shown actions', () => {
    const always = openingTag(render({ alwaysShowActions: true }), 'aria-expanded="true"');
    const onHover = openingTag(render({ alwaysShowActions: false }), 'aria-expanded="true"');

    expect(always).toContain('pr-[var(--project-header-action-padding,5rem)]');
    expect(always).not.toContain('group-hover/project:pr-');
    expect(onHover).toContain('group-hover/project:pr-[var(--project-header-action-padding,5rem)]');
  });

  test('hides the new-worktree control and its header padding when worktree controls are hidden', () => {
    const shown = render();
    const hidden = render({ hideWorktreeControls: true });

    expect(shown).toContain('aria-label="New Worktree"');
    expect(shown).toContain('data-project-header-action-count="3"');
    expect(hidden).not.toContain('aria-label="New Worktree"');
    expect(hidden).toContain('data-project-header-action-count="2"');
    expect(hidden).toContain('group-hover/project:pr-[var(--project-header-action-padding,3.5rem)]');
  });
});

// SessionSidebar owns the capability store graph that feeds hideWorktreeControls.
describe('project worktree capability wiring', () => {
  test('hides project worktree controls when the capability is disabled', () => {
    const sidebarSource = readFileSync(new URL('../SessionSidebar.tsx', import.meta.url), 'utf8');

    expect(sidebarSource).toContain("hasAuthCapability(principal, 'createWorktrees')");
    expect(sidebarSource).toContain('hideWorktreeControls={hideDirectoryControls || !canCreateWorktrees}');
    expect(sidebarSource).toContain('active={canCreateWorktrees && newWorktreeDialogOpen}');
  });
});
