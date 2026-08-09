import React from 'react';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { renderToString } from 'react-dom/server';
import { fileURLToPath } from 'node:url';

import { DeferredSessionDialog } from './lazySessionDialogs';

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

  test('declares recovery-aware lazy imports for unopened sidebar dialogs', () => {
    const source = readSource('lazySessionDialogs.tsx');

    expect(source).toContain("import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery'");
    expect(source).toContain("import('@/components/layout/ProjectEditDialog')");
    expect(source).toContain("import('@/components/session/NewWorktreeDialog')");
    expect(source).toContain("import('@/components/session/ScheduledTasksDialog')");
    expect(source).toContain("import('@/components/session/sidebar/SessionSearchDialog')");

    for (const dialogName of [
      'ProjectEditDialog',
      'NewWorktreeDialog',
      'ScheduledTasksDialog',
      'SessionSearchDialog',
      'SessionDeleteConfirmDialog',
      'FolderDeleteConfirmDialog',
      'BulkSessionDeleteConfirmDialog',
      'BranchSessionArchiveConfirmDialog',
    ]) {
      expect(source).toContain(`export const Lazy${dialogName} = /* @__PURE__ */ lazyWithChunkRecovery`);
    }

    expect((source.match(/import\('@\/components\/session\/sidebar\/ConfirmDialogs'\)/g)?.length ?? 0)).toBe(4);
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
      'active={isScheduledTasksDialogOpen}',
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
