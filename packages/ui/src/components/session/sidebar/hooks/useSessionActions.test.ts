import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));

describe('session archive toast behavior', () => {
  test('keeps archive and unarchive success toasts out of session actions', () => {
    const source = readFileSync(join(testDir, 'useSessionActions.ts'), 'utf8');

    expect(source).not.toContain("toast[success ? 'success' : 'error']");
    expect(source).not.toContain("toast.success(unarchivedIds.length === 1");
    expect(source).not.toContain('sessions.sidebar.session.unarchive.success');
    expect(source).not.toContain('sessions.sidebar.bulkActions.unarchivedSingle');
    expect(source).not.toContain('sessions.sidebar.bulkActions.unarchivedPlural');
  });

  test('keeps archive success toasts out of the session dialog archive path', () => {
    const source = readFileSync(join(testDir, '..', '..', 'SessionDialogs.tsx'), 'utf8');

    expect(source).not.toContain('sessions.sidebar.session.archive.success');
    expect(source).not.toContain('sessions.sidebar.bulkActions.archivedSingle');
    expect(source).not.toContain('sessions.sidebar.bulkActions.archivedPlural');
  });
});

describe('session archive expansion lifecycle', () => {
  test('collapses only confirmed archive successes', () => {
    const source = readFileSync(join(testDir, 'useSessionActions.ts'), 'utf8');

    expect(source).toContain('onArchiveSucceeded?: (ids: string[]) => void;');
    expect(source).toContain('args.onArchiveSucceeded?.([session.id]);');
    expect(source).toContain('const { archivedIds, failedIds } = await args.archiveSessions(ids);');
    expect(source).toContain('args.onArchiveSucceeded?.(archivedIds);');
  });
});
