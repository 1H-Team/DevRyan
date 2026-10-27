import React from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { renderToString } from 'react-dom/server';
import { fileURLToPath } from 'node:url';

const loads = { projectEdit: 0, newWorktree: 0, scheduledTasks: 0, sessionSearch: 0, confirm: 0 };
let recoveryWrapped = 0;
const named = (name: string) => () => <i>{name}</i>;
mock.module('@/lib/chunkLoadRecovery', () => ({
  lazyWithChunkRecovery: (load: Parameters<typeof React.lazy>[0]) => { recoveryWrapped += 1; return React.lazy(load); },
}));
mock.module('@/components/layout/ProjectEditDialog', () => { loads.projectEdit += 1; return { ProjectEditDialog: named('ProjectEditDialog') }; });
mock.module('@/components/session/NewWorktreeDialog', () => { loads.newWorktree += 1; return { NewWorktreeDialog: named('NewWorktreeDialog') }; });
mock.module('@/components/session/ScheduledTasksDialog', () => { loads.scheduledTasks += 1; return { ScheduledTasksDialog: named('ScheduledTasksDialog') }; });
mock.module('@/components/session/sidebar/SessionSearchDialog', () => { loads.sessionSearch += 1; return { SessionSearchDialog: named('SessionSearchDialog') }; });
mock.module('@/components/session/sidebar/ConfirmDialogs', () => {
  loads.confirm += 1;
  return {
    SessionDeleteConfirmDialog: named('SessionDeleteConfirmDialog'),
    FolderDeleteConfirmDialog: named('FolderDeleteConfirmDialog'),
    BulkSessionDeleteConfirmDialog: named('BulkSessionDeleteConfirmDialog'),
    BranchSessionArchiveConfirmDialog: named('BranchSessionArchiveConfirmDialog'),
  };
});
const { DeferredSessionDialog } = await import('./lazySessionDialogs');

const testDir = dirname(fileURLToPath(import.meta.url));

const readSource = (relativePath: string): string => {
  try {
    return readFileSync(resolve(testDir, relativePath), 'utf8');
  } catch {
    return '';
  }
};

describe('lazy session sidebar dialogs', () => {
  test('does not initialize a lazy dialog until its authoritative state is active', () => {
    let loadCount = 0;
    const LazyProbe = React.lazy(async () => {
      loadCount += 1;
      return { default: () => <span>loaded</span> };
    });

    const renderProbe = (active: boolean) => renderToString(
      <React.Suspense fallback={<span>loading</span>}>
        <DeferredSessionDialog active={active}>
          <LazyProbe />
        </DeferredSessionDialog>
      </React.Suspense>,
    );

    expect(renderProbe(false)).not.toContain('loading');
    expect(loadCount).toBe(0);

    expect(renderProbe(true)).toContain('loading');
    expect(loadCount).toBe(1);

    expect(renderProbe(false)).not.toContain('loading');
    expect(loadCount).toBe(1);
  });

  test('loads each unopened dialog chunk only when first rendered, through chunk recovery', async () => {
    const dialogs = await import('./lazySessionDialogs');
    // Importing the module must not pull any dialog implementation in.
    expect(loads).toEqual({ projectEdit: 0, newWorktree: 0, scheduledTasks: 0, sessionSearch: 0, confirm: 0 });
    expect(recoveryWrapped).toBe(8);

    const probe = (Lazy: React.ComponentType) => renderToString(
      <React.Suspense fallback={<span>loading</span>}><Lazy /></React.Suspense>,
    );
    const expectations: Array<[React.ComponentType, keyof typeof loads, string]> = [
      [dialogs.LazyProjectEditDialog as unknown as React.ComponentType, 'projectEdit', 'ProjectEditDialog'],
      [dialogs.LazyNewWorktreeDialog as unknown as React.ComponentType, 'newWorktree', 'NewWorktreeDialog'],
      [dialogs.LazyScheduledTasksDialog as unknown as React.ComponentType, 'scheduledTasks', 'ScheduledTasksDialog'],
      [dialogs.LazySessionSearchDialog as unknown as React.ComponentType, 'sessionSearch', 'SessionSearchDialog'],
      [dialogs.LazySessionDeleteConfirmDialog as unknown as React.ComponentType, 'confirm', 'SessionDeleteConfirmDialog'],
      [dialogs.LazyFolderDeleteConfirmDialog as unknown as React.ComponentType, 'confirm', 'FolderDeleteConfirmDialog'],
      [dialogs.LazyBulkSessionDeleteConfirmDialog as unknown as React.ComponentType, 'confirm', 'BulkSessionDeleteConfirmDialog'],
      [dialogs.LazyBranchSessionArchiveConfirmDialog as unknown as React.ComponentType, 'confirm', 'BranchSessionArchiveConfirmDialog'],
    ];
    for (const [Lazy, key, exportName] of expectations) {
      expect(probe(Lazy)).toContain('loading');
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(loads[key]).toBeGreaterThan(0);
      // Each lazy export resolves to its own named export of the module.
      expect(probe(Lazy)).toContain(`<i>${exportName}</i>`);
    }
    expect(loads.projectEdit).toBe(1);
    expect(loads.newWorktree).toBe(1);
    expect(loads.scheduledTasks).toBe(1);
    expect(loads.sessionSearch).toBe(1);
  });

  test('mounts each dialog only for its authoritative open or value state', () => {
    const source = readSource('../SessionSidebar.tsx');

    for (const staticImport of [
      "import { ProjectEditDialog } from '@/components/layout/ProjectEditDialog'",
      "import { NewWorktreeDialog } from './NewWorktreeDialog'",
      "import { ScheduledTasksDialog } from './ScheduledTasksDialog'",
      "import { SessionSearchDialog, type SessionSearchDialogItem } from './sidebar/SessionSearchDialog'",
    ]) {
      expect(source).not.toContain(staticImport);
    }

    expect(source).toContain("import type { SessionSearchDialogItem } from './sidebar/SessionSearchDialog'");
    expect(source).toContain("from './sidebar/lazySessionDialogs'");
    expect(source).toContain('const isScheduledTasksDialogOpen = useUIStore((state) => state.isScheduledTasksDialogOpen)');

    for (const activeCondition of [
      'active={isSessionSearchOpen}',
      'active={Boolean(editingProject)}',
      'active={canCreateWorktrees && newWorktreeDialogOpen}',
      'active={isScheduledTasksDialogOpen && managedChildTasks}',
      'active={Boolean(deleteSessionConfirm)}',
      'active={Boolean(deleteFolderConfirm)}',
      'active={Boolean(bulkDeleteConfirm)}',
    ]) {
      expect(source).toContain(activeCondition);
    }
  });

  test('pins a completed worktree draft to its authoritative project and directory', () => {
    const source = readSource('../SessionSidebar.tsx');

    expect(source).toContain('selectedProjectId: options?.projectId');
    expect(source).toContain('directoryOverride: worktreePath');
    expect(source).toContain('preserveDirectoryOverride: true');
  });
});
