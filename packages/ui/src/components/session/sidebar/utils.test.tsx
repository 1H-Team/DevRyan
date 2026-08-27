import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { buildArchivedSessionTree } from './hooks/useSessionGrouping';
import { addMissingCollapsedGroupKeys, collectArchivedActionSessions, compareArchivedSessionsByParentAssistantActivity, compareSessionsByPinnedAndTime, discardPendingArchiveRevealSessionIds, getArchivedGroupKeys, reconcileArchivedGroupCollapse, removeExpandedSessionIds, resolveArchivedFolderName, resolveSessionDiffStats, resolveSessionRoutingDirectory, selectVisibleChatDrafts } from './utils';
import type { SessionNode } from './types';

const session = (id: string, created: number, updated = created, parentID?: string): Session => ({
  id,
  title: id,
  time: { created, updated },
  ...(parentID ? { parentID } : {}),
} as Session);

const archivedSession = (id: string, created: number, updated = created, parentID?: string): Session => ({
  ...session(id, created, updated, parentID),
  time: { created, updated, archived: updated + 1 },
} as Session);

const node = (id: string, children: SessionNode[] = []): SessionNode => ({
  session: session(id, 1),
  children,
  worktree: null,
});

const sortByCreated = (a: Session, b: Session) => Number(a.time?.created ?? 0) - Number(b.time?.created ?? 0);

const draft = (id: string, text: string, createdAt: number) => ({
  id,
  text,
  createdAt,
  updatedAt: createdAt,
  selectedProjectId: null,
  directoryOverride: null,
  parentID: null,
});

describe('resolveSessionRoutingDirectory', () => {
  test('prefers the per-session routing hint over a server-returned path alias', () => {
    expect(resolveSessionRoutingDirectory(
      '/tmp/test-project',
      '/private/tmp/test-project',
      '/private/tmp/test-project',
    )).toBe('/tmp/test-project');
  });

  test('preserves server and group-directory fallbacks when no hint is available', () => {
    expect(resolveSessionRoutingDirectory(null, '/private/tmp/test-project/', '/group')).toBe('/private/tmp/test-project');
    expect(resolveSessionRoutingDirectory(null, null, '/group/')).toBe('/group');
    expect(resolveSessionRoutingDirectory(null, null, null)).toBeNull();
  });
});

describe('removeExpandedSessionIds', () => {
  test('removes only successfully archived session trees', () => {
    const expanded = new Set(['parent', 'failed-parent', 'unrelated']);

    expect(Array.from(removeExpandedSessionIds(expanded, ['parent', 'child']))).toEqual([
      'failed-parent',
      'unrelated',
    ]);
  });

  test('preserves the original set when no expanded session was archived', () => {
    const expanded = new Set(['failed-parent']);

    expect(removeExpandedSessionIds(expanded, ['other'])).toBe(expanded);
  });
});

describe('selectVisibleChatDrafts', () => {
  test('hides the active newest draft while it is being edited', () => {
    const result = selectVisibleChatDrafts([
      draft('draft-active', 'typing now', 20),
    ], 'draft-active');

    expect(result).toEqual([]);
  });

  test('keeps older unsent drafts visible and sorts newest first', () => {
    const result = selectVisibleChatDrafts([
      draft('draft-active', 'typing now', 30),
      draft('draft-oldest', 'old text', 10),
      draft('draft-middle', 'middle text', 20),
    ], 'draft-active');

    expect(result.map((item) => item.id)).toEqual(['draft-middle', 'draft-oldest']);
  });

  test('hides empty and promoted drafts', () => {
    const result = selectVisibleChatDrafts([
      draft('draft-empty', '   ', 30),
      draft('draft-promoted', 'sent text', 20),
      draft('draft-unsent', 'keep text', 10),
    ], null, new Set(['draft-promoted']));

    expect(result.map((item) => item.id)).toEqual(['draft-unsent']);
  });
});

describe('compareSessionsByPinnedAndTime', () => {
  test('sorts numbered counsellor child sessions by counsellor number', () => {
    const parent = session('parent', 1, 1);
    const counsellor4 = { ...session('c4', 4, 400, parent.id), title: 'Counsellor 4: anthropic/claude' } as Session;
    const counsellor3 = { ...session('c3', 3, 300, parent.id), title: 'Counsellor 3: opencode-go/glm-5.1' } as Session;
    const counsellor2 = { ...session('c2', 2, 200, parent.id), title: 'Counsellor 2: google/antigravity' } as Session;
    const counsellor1 = { ...session('c1', 1, 100, parent.id), title: 'Counsellor 1: openai/gpt-5.5' } as Session;

    const sorted = [counsellor4, counsellor3, counsellor2, counsellor1].sort((a, b) =>
      compareSessionsByPinnedAndTime(a, b, new Set()),
    );

    expect(sorted.map((item) => item.title)).toEqual([
      'Counsellor 1: openai/gpt-5.5',
      'Counsellor 2: google/antigravity',
      'Counsellor 3: opencode-go/glm-5.1',
      'Counsellor 4: anthropic/claude',
    ]);
  });

  test('sorts sessions by canonical updated time', () => {
    const older = session('older', 100, 200);
    const newer = session('newer', 1, 300);

    const sorted = [older, newer].sort((a, b) =>
      compareSessionsByPinnedAndTime(a, b, new Set()),
    );

    expect(sorted.map((item) => item.id)).toEqual(['newer', 'older']);
  });

  test('falls back to creation time when canonical updated time is unavailable', () => {
    const older = { ...session('older', 100), time: { created: 100 } } as Session;
    const newer = { ...session('newer', 200), time: { created: 200 } } as Session;

    const sorted = [older, newer].sort((a, b) =>
      compareSessionsByPinnedAndTime(a, b, new Set()),
    );

    expect(sorted.map((item) => item.id)).toEqual(['newer', 'older']);
  });

  test('keeps pinned sessions above unpinned sessions and sorts pinned by updated time', () => {
    const pinnedOlder = session('pinned-older', 30, 100);
    const pinnedNewer = session('pinned-newer', 10, 200);
    const unpinned = session('unpinned', 40, 300);

    const sorted = [unpinned, pinnedOlder, pinnedNewer].sort((a, b) =>
      compareSessionsByPinnedAndTime(a, b, new Set([pinnedOlder.id, pinnedNewer.id])),
    );

    expect(sorted.map((item) => item.id)).toEqual(['pinned-newer', 'pinned-older', 'unpinned']);
  });
});

describe('resolveSessionDiffStats', () => {
  test('ignores direct additions and deletions from session summary', () => {
    expect(resolveSessionDiffStats({ additions: '118', deletions: 22864 })).toBeNull();
  });

  test('aggregates additions and deletions from trusted summary diffs', () => {
    expect(resolveSessionDiffStats({
      additions: 999,
      deletions: 999,
      diffs: [
        { additions: 10, deletions: '2' },
        { additions: '5', deletions: 3 },
      ],
    })).toEqual({ additions: 15, deletions: 5 });
  });

  test('returns null for missing or zero summary stats', () => {
    expect(resolveSessionDiffStats()).toBeNull();
    expect(resolveSessionDiffStats({ additions: 0, deletions: 0 })).toBeNull();
    expect(resolveSessionDiffStats({ diffs: [{ additions: 0, deletions: 0 }] })).toBeNull();
  });

  test('clamps invalid and negative counts while preserving valid counts', () => {
    expect(resolveSessionDiffStats({ additions: -4, deletions: '6' })).toBeNull();
    expect(resolveSessionDiffStats({ diffs: [{ additions: 'nope', deletions: -2 }, { additions: '3', deletions: 1 }] })).toEqual({ additions: 3, deletions: 1 });
  });
});

describe('compareArchivedSessionsByParentAssistantActivity', () => {
  test('sorts archived sessions by latest parent assistant response timestamp', () => {
    const older = { ...session('older', 1, 10), time: { created: 1, updated: 10, archived: 100 } } as Session;
    const newer = { ...session('newer', 2, 20), time: { created: 2, updated: 20, archived: 90 } } as Session;

    const sorted = [older, newer].sort((a, b) =>
      compareArchivedSessionsByParentAssistantActivity(a, b, {
        [older.id]: 1_000,
        [newer.id]: 2_000,
      }),
    );

    expect(sorted.map((item) => item.id)).toEqual(['newer', 'older']);
  });

  test('resolves child archived sessions through their parent session id', () => {
    const parentNewer = session('parent-newer', 1, 1);
    const parentOlder = session('parent-older', 2, 2);
    const childNewer = { ...session('child-newer', 3, 3, parentNewer.id), time: { created: 3, updated: 3, archived: 10 } } as Session;
    const childOlder = { ...session('child-older', 4, 4, parentOlder.id), time: { created: 4, updated: 4, archived: 20 } } as Session;

    const sorted = [childOlder, childNewer].sort((a, b) =>
      compareArchivedSessionsByParentAssistantActivity(a, b, {
        [parentNewer.id]: 2_000,
        [parentOlder.id]: 1_000,
      }),
    );

    expect(sorted.map((item) => item.id)).toEqual(['child-newer', 'child-older']);
  });

  test('places sessions with known assistant activity before missing activity and falls back deterministically', () => {
    const known = { ...session('known', 1, 1), time: { created: 1, updated: 1, archived: 1 } } as Session;
    const missingNewerArchive = { ...session('missing-newer-archive', 2, 2), time: { created: 2, updated: 2, archived: 20 } } as Session;
    const missingOlderArchive = { ...session('missing-older-archive', 3, 3), time: { created: 30, updated: 3, archived: 10 } } as Session;

    const sorted = [missingOlderArchive, known, missingNewerArchive].sort((a, b) =>
      compareArchivedSessionsByParentAssistantActivity(a, b, { [known.id]: 100 }),
    );

    expect(sorted.map((item) => item.id)).toEqual(['known', 'missing-newer-archive', 'missing-older-archive']);
  });
});

describe('archived group collapse helpers', () => {
  test('builds keys only for archived groups', () => {
    const archivedGroupKeys = getArchivedGroupKeys([
      {
        project: { id: 'project-a' },
        groups: [
          { id: 'main', isArchivedBucket: false },
          { id: 'archived', isArchivedBucket: true },
        ],
      },
      {
        project: { id: 'project-b' },
        groups: [{ id: 'main' }],
      },
    ]);

    expect(archivedGroupKeys).toEqual(['project-a:archived']);
  });

  test('adds newly visible archived groups without changing an already complete collapse set', () => {
    const collapsedGroups = new Set(['project-a:main']);
    const withArchived = addMissingCollapsedGroupKeys(collapsedGroups, ['project-a:archived']);

    expect(Array.from(withArchived)).toEqual(['project-a:main', 'project-a:archived']);
    expect(addMissingCollapsedGroupKeys(withArchived, ['project-a:archived'])).toBe(withArchived);
  });

  test('keeps newly visible archived groups collapsed without a pending user archive', () => {
    const result = reconcileArchivedGroupCollapse({
      sections: [{
        project: { id: 'project-a' },
        groups: [{
          id: 'archived',
          isArchivedBucket: true,
          sessions: [node('archived-session')],
        }],
      }],
      previousVisibleArchivedGroupKeys: new Set(),
      collapsedGroups: new Set(),
      pendingRevealSessionIds: new Set(),
    });

    expect(Array.from(result.collapsedGroups)).toEqual(['project-a:archived']);
    expect(Array.from(result.revealedSessionIds)).toEqual([]);
  });

  test('keeps newly visible archived groups collapsed when they contain a pending archived session', () => {
    const result = reconcileArchivedGroupCollapse({
      sections: [{
        project: { id: 'project-a' },
        groups: [{
          id: 'archived',
          isArchivedBucket: true,
          sessions: [node('archived-session')],
        }],
      }],
      previousVisibleArchivedGroupKeys: new Set(),
      collapsedGroups: new Set(),
      pendingRevealSessionIds: new Set(['archived-session']),
    });

    expect(Array.from(result.collapsedGroups)).toEqual(['project-a:archived']);
    expect(Array.from(result.revealedSessionIds)).toEqual(['archived-session']);
  });

  test('keeps already collapsed archived groups collapsed when another session is archived into them', () => {
    const result = reconcileArchivedGroupCollapse({
      sections: [{
        project: { id: 'project-a' },
        groups: [{
          id: 'archived',
          isArchivedBucket: true,
          sessions: [node('existing-session'), node('newly-archived-session')],
        }],
      }],
      previousVisibleArchivedGroupKeys: new Set(['project-a:archived']),
      collapsedGroups: new Set(['project-a:archived']),
      pendingRevealSessionIds: new Set(['newly-archived-session']),
    });

    expect(Array.from(result.collapsedGroups)).toEqual(['project-a:archived']);
    expect(Array.from(result.revealedSessionIds)).toEqual(['newly-archived-session']);
  });

  test('keeps collapsed archived groups collapsed when a pending archive is nested under a parent row', () => {
    const result = reconcileArchivedGroupCollapse({
      sections: [{
        project: { id: 'project-a' },
        groups: [{
          id: 'archived',
          isArchivedBucket: true,
          sessions: [node('parent', [node('archived-child')])],
        }],
      }],
      previousVisibleArchivedGroupKeys: new Set(['project-a:archived']),
      collapsedGroups: new Set(['project-a:archived']),
      pendingRevealSessionIds: new Set(['archived-child']),
    });

    expect(Array.from(result.collapsedGroups)).toEqual(['project-a:archived']);
    expect(Array.from(result.revealedSessionIds)).toEqual(['archived-child']);
  });

  test('removes failed archive ids from the pending reveal set', () => {
    const pending = new Set(['failed-session', 'successful-session']);
    const next = discardPendingArchiveRevealSessionIds(pending, ['failed-session']);

    expect(Array.from(next)).toEqual(['successful-session']);
    expect(Array.from(pending)).toEqual(['failed-session', 'successful-session']);
    expect(discardPendingArchiveRevealSessionIds(next, ['missing-session'])).toBe(next);
  });
});

describe('resolveArchivedFolderName', () => {
  test('does not create a project root folder for root archived sessions', () => {
    const root = '/repo/project';
    const archivedRootSession = {
      ...archivedSession('root-session', 1),
      directory: root,
    } as Session;

    expect(resolveArchivedFolderName(archivedRootSession, root)).toBeNull();
  });

  test('uses matching worktree branch as the archived group label', () => {
    const root = '/repo/project';
    const worktreePath = '/repo/project-feature';
    const branchSession = {
      ...archivedSession('branch-session', 1),
      directory: worktreePath,
    } as Session;

    expect(resolveArchivedFolderName(branchSession, root, [{
      path: worktreePath,
      projectDirectory: root,
      branch: 'feature/sidebar-archive',
      label: 'Sidebar Archive',
    }])).toBe('feature/sidebar-archive');
  });

  test('falls back to directory basename for unknown archived directories', () => {
    const unknownDirectorySession = {
      ...archivedSession('unknown-session', 1),
      directory: '/repo/project/experiments',
    } as Session;

    expect(resolveArchivedFolderName(unknownDirectorySession, '/repo/project')).toBe('experiments');
  });
});

describe('buildArchivedSessionTree', () => {
  test('nests archived child sessions under an active structural parent', () => {
    const parent = session('parent', 1);
    const child = archivedSession('child', 2, 2, parent.id);

    const tree = buildArchivedSessionTree([child, parent], sortByCreated);

    expect(tree).toHaveLength(1);
    expect(tree[0].session.id).toBe(parent.id);
    expect(tree[0].isArchiveAncestorOnly).toBe(true);
    expect(tree[0].children.map((node) => node.session.id)).toEqual([child.id]);
    expect(tree[0].children[0].isArchiveAncestorOnly).toBe(false);
  });

  test('keeps archived parent and archived child nested without scaffold markers', () => {
    const parent = archivedSession('parent', 1);
    const child = archivedSession('child', 2, 2, parent.id);

    const tree = buildArchivedSessionTree([child, parent], sortByCreated);

    expect(tree.map((node) => node.session.id)).toEqual([parent.id]);
    expect(tree[0].isArchiveAncestorOnly).toBe(false);
    expect(tree[0].children[0].session.id).toBe(child.id);
    expect(tree[0].children[0].isArchiveAncestorOnly).toBe(false);
  });

  test('leaves archived child as root when its parent is unavailable', () => {
    const child = archivedSession('child', 2, 2, 'missing-parent');

    const tree = buildArchivedSessionTree([child], sortByCreated);

    expect(tree.map((node) => node.session.id)).toEqual([child.id]);
    expect(tree[0].children).toEqual([]);
    expect(tree[0].isArchiveAncestorOnly).toBe(false);
  });

  test('includes the full active ancestor chain for nested archived descendants', () => {
    const parent = session('parent', 1);
    const subagent = session('subagent', 2, 2, parent.id);
    const archivedGrandchild = archivedSession('archived-grandchild', 3, 3, subagent.id);

    const tree = buildArchivedSessionTree([archivedGrandchild, subagent, parent], sortByCreated);

    expect(tree[0].session.id).toBe(parent.id);
    expect(tree[0].isArchiveAncestorOnly).toBe(true);
    expect(tree[0].children[0].session.id).toBe(subagent.id);
    expect(tree[0].children[0].isArchiveAncestorOnly).toBe(true);
    expect(tree[0].children[0].children[0].session.id).toBe(archivedGrandchild.id);
    expect(tree[0].children[0].children[0].isArchiveAncestorOnly).toBe(false);
  });

  test('can include non-archived bucket members without marking them as ancestor-only', () => {
    const unassigned = session('unassigned', 1);

    const tree = buildArchivedSessionTree([unassigned], sortByCreated, () => null, (candidate) => candidate.id === unassigned.id);

    expect(tree.map((node) => node.session.id)).toEqual([unassigned.id]);
    expect(tree[0].isArchiveAncestorOnly).toBe(false);
  });
});

describe('collectArchivedActionSessions', () => {
  test('excludes active structural ancestors from archived destructive actions', () => {
    const parent = session('parent', 1);
    const child = archivedSession('child', 2, 2, parent.id);
    const tree = buildArchivedSessionTree([parent, child], sortByCreated);

    expect(collectArchivedActionSessions(tree).map((item) => item.id)).toEqual([child.id]);
  });
});
