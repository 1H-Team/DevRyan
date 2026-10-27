import React, { act } from 'react';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { withDom } from '@/test/mountedDom';

type Toast = { title: string; description?: string };
const toasts = { success: [] as Toast[], error: [] as Toast[] };
mock.module('@/components/ui', () => ({ toast: {
  success: (title: string, options?: { description?: string }) => toasts.success.push({ title, description: options?.description }),
  error: (title: string, options?: { description?: string }) => toasts.error.push({ title, description: options?.description }),
} }));
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
const capability = { share: false };
mock.module('@/lib/opencode/runtime-capabilities', () => ({ useRuntimeCapability: () => capability.share }));
mock.module('@/lib/clipboard', () => ({ copyTextToClipboard: async () => ({ ok: true, method: 'clipboard' }) }));
const { useSessionActions } = await import('./useSessionActions');

const session = (id: string): Session => ({
  id, slug: id, projectID: 'project', directory: '/fixture', title: id, version: '1', time: { created: 1, updated: 1 },
});
const parent = session('ses_parent');
const childA = session('ses_child_a');
const childB = session('ses_child_b');

type Args = Parameters<typeof useSessionActions>[0];

const withActions = async (
  overrides: Partial<Args>,
  run: (actions: ReturnType<typeof useSessionActions>) => Promise<void>,
) => withDom(async (container) => {
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  const noop = () => {};
  let actions: ReturnType<typeof useSessionActions> | undefined;
  function Fixture() {
    const [deleteSessionConfirm, setDeleteSessionConfirm] = React.useState<Args['deleteSessionConfirm']>(null);
    actions = useSessionActions({
      activeProjectId: null, currentDirectory: '/fixture', currentSessionId: parent.id,
      mobileVariant: false, allowReselect: false, isSessionSearchOpen: false, sessionSearchQuery: '',
      setSessionSearchQuery: noop, setIsSessionSearchOpen: noop, setActiveProjectIdOnly: noop,
      setActiveMainTab: noop, setSessionSwitcherOpen: noop, setCurrentSession: noop,
      updateSessionTitle: async () => {}, shareSession: async () => null, unshareSession: async () => null,
      deleteSession: async () => true,
      deleteSessions: async () => ({ deletedIds: [], failedIds: [], failures: [] }),
      archiveSessions: async (ids) => ({ archivedIds: ids, failedIds: [], failures: [] }),
      unarchiveSession: async () => true,
      unarchiveSessions: async (ids) => ({ unarchivedIds: ids, failedIds: [], failures: [] }),
      childrenMap: new Map(), showDeletionDialog: false, deleteSessionConfirm, setDeleteSessionConfirm,
      setEditingId: noop, setEditTitle: noop, editingId: null, editTitle: '',
      ...overrides,
    });
    return null;
  }
  try {
    await act(async () => root.render(React.createElement(Fixture)));
    await run(actions as ReturnType<typeof useSessionActions>);
  } finally {
    await act(async () => root.unmount());
  }
});

beforeEach(() => {
  toasts.success.length = 0;
  toasts.error.length = 0;
  capability.share = false;
});

describe('session archive toast behavior', () => {
  test('archiving a session shows no success toast', async () => {
    await withActions({}, async (actions) => {
      await act(async () => { actions.handleArchiveSession(parent); });
    });
    expect(toasts.success).toEqual([]);
    expect(toasts.error).toEqual([]);
  });

  test('archiving a session with children shows no success toast', async () => {
    await withActions({ childrenMap: new Map([[parent.id, [childA, childB]]]) }, async (actions) => {
      await act(async () => { actions.handleArchiveSession(parent); });
    });
    expect(toasts.success).toEqual([]);
  });

  test('unarchiving a session or a family shows no success toast', async () => {
    await withActions({ childrenMap: new Map([[parent.id, [childA]]]) }, async (actions) => {
      await act(async () => { await actions.handleUnarchiveSession(parent); });
      await act(async () => { await actions.handleUnarchiveSession(childA); });
    });
    expect(toasts.success).toEqual([]);
    expect(toasts.error).toEqual([]);
  });

  test('failed unarchive still reports the error', async () => {
    await withActions({ unarchiveSession: async () => false }, async (actions) => {
      await act(async () => { await actions.handleUnarchiveSession(childA); });
    });
    expect(toasts.error).toEqual([{ title: 'sessions.sidebar.session.unarchive.error', description: undefined }]);
  });
});

describe('session archive expansion lifecycle', () => {
  test('collapses only confirmed archive successes', async () => {
    const succeeded: string[][] = [];
    const failed: string[][] = [];
    const requested: string[][] = [];
    await withActions({
      childrenMap: new Map([[parent.id, [childA, childB]]]),
      archiveSessions: async (ids) => ({
        archivedIds: ids.filter((id) => id !== childB.id),
        failedIds: [childB.id],
        failures: [{ sessionId: childB.id, status: 409, message: 'Still running' }],
      }),
      onArchiveRequested: (ids) => requested.push(ids),
      onArchiveSucceeded: (ids) => succeeded.push(ids),
      onArchiveFailed: (ids) => failed.push(ids),
    }, async (actions) => {
      await act(async () => { actions.handleArchiveSession(parent); });
    });

    expect(requested).toEqual([[parent.id, childA.id, childB.id]]);
    expect(succeeded).toEqual([[parent.id, childA.id]]);
    expect(failed).toEqual([[childB.id]]);
  });

  test('does not report success for a single archive that failed', async () => {
    const succeeded: string[][] = [];
    await withActions({
      archiveSessions: async (ids) => ({ archivedIds: [], failedIds: ids, failures: [] }),
      onArchiveSucceeded: (ids) => succeeded.push(ids),
    }, async (actions) => {
      await act(async () => { actions.handleArchiveSession(parent); });
    });
    expect(succeeded).toEqual([]);
  });

  test('reports a single confirmed archive success to collapse the row', async () => {
    const succeeded: string[][] = [];
    await withActions({ onArchiveSucceeded: (ids) => succeeded.push(ids) }, async (actions) => {
      await act(async () => { actions.handleArchiveSession(parent); });
    });
    expect(succeeded).toEqual([[parent.id]]);
  });

  test('surfaces the archive failure reason instead of only a count', async () => {
    await withActions({
      childrenMap: new Map([[parent.id, [childA]]]),
      archiveSessions: async (ids) => ({
        archivedIds: [], failedIds: ids,
        failures: [{ sessionId: parent.id, status: 403, message: 'Archive forbidden for this session' }],
      }),
    }, async (actions) => {
      await act(async () => { actions.handleArchiveSession(parent); });
    });

    expect(toasts.error).toHaveLength(1);
    expect(toasts.error[0].title).toBe('sessions.sidebar.bulkActions.failedArchivePlural');
    expect(toasts.error[0].description).toContain('Archive forbidden for this session');
  });
});

describe('session share capability gating', () => {
  test('share handlers refuse without a request when the runtime has no share route', async () => {
    let shareCalls = 0;
    let unshareCalls = 0;
    await withActions({
      shareSession: async () => { shareCalls += 1; return null; },
      unshareSession: async () => { unshareCalls += 1; return null; },
    }, async (actions) => {
      await act(async () => { await actions.handleShareSession(parent); });
      await act(async () => { await actions.handleUnshareSession(parent.id); });
    });

    expect(shareCalls).toBe(0);
    expect(unshareCalls).toBe(0);
    expect(toasts.error.map((entry) => entry.title)).toEqual([
      'sessions.sidebar.session.share.error',
      'sessions.sidebar.session.unshare.error',
    ]);
  });

  test('share handlers call the runtime when the share route exists', async () => {
    capability.share = true;
    let shareCalls = 0;
    let unshareCalls = 0;
    await withActions({
      shareSession: async () => { shareCalls += 1; return { ...parent, share: { url: 'https://share.example/x' } } as Session; },
      unshareSession: async () => { unshareCalls += 1; return parent; },
    }, async (actions) => {
      await act(async () => { await actions.handleShareSession(parent); });
      await act(async () => { await actions.handleUnshareSession(parent.id); });
    });

    expect(shareCalls).toBe(1);
    expect(unshareCalls).toBe(1);
    expect(toasts.error).toEqual([]);
    expect(toasts.success.map((entry) => entry.title)).toEqual([
      'sessions.sidebar.session.share.successTitle',
      'sessions.sidebar.session.unshare.success',
    ]);
  });
});

// The dialog component owns a store graph and portal rendering; its archive path is a pin.
describe('session dialog archive path', () => {
  test('keeps archive success toasts out of the session dialog archive path', () => {
    const source = readFileSync(new URL('../../SessionDialogs.tsx', import.meta.url), 'utf8');

    expect(source).not.toContain('sessions.sidebar.session.archive.success');
    expect(source).not.toContain('sessions.sidebar.bulkActions.archivedSingle');
    expect(source).not.toContain('sessions.sidebar.bulkActions.archivedPlural');
  });
});
