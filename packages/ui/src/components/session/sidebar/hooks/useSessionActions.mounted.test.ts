import React, { act } from 'react';
import { expect, mock, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { withDom } from '@/test/mountedDom';

const errors: Array<{ title: string; description?: string }> = [];
mock.module('@/components/ui', () => ({ toast: {
  error: (title: string, options?: { description?: string }) => errors.push({ title, description: options?.description }),
} }));
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
mock.module('@/lib/opencode/runtime-capabilities', () => ({ useRuntimeCapability: () => false }));
mock.module('@/lib/clipboard', () => ({ copyTextToClipboard: async () => ({ ok: true, method: 'clipboard' }) }));
const { useSessionActions } = await import('./useSessionActions');

const session: Session = {
  id: 'ses_archive', slug: 'archive', projectID: 'project', directory: '/fixture',
  title: 'Archive fixture', version: '1', time: { created: 1, updated: 1 },
};

for (const confirmation of [false, true]) {
  test(`single-session archive preserves the failure explanation (${confirmation ? 'confirmed' : 'direct'})`, async () => {
    errors.length = 0;
    const archiveSessions = mock(async (ids: string[]) => ({
      archivedIds: [], failedIds: ids,
      failures: [{ sessionId: session.id, status: 403, message: 'Archive forbidden for this session' }],
    }));
    const requested = mock(() => {});
    const failed = mock(() => {});
    const succeeded = mock(() => {});
    const deleteSession = mock(async () => true);
    const noop = () => {};
    await withDom(async container => {
      const { createRoot } = await import('react-dom/client');
      const root = createRoot(container as unknown as Element);
      let actions: ReturnType<typeof useSessionActions> | undefined;
      function Fixture() {
        const [deleteSessionConfirm, setDeleteSessionConfirm] = React.useState<{
          session: Session; descendantCount: number; archivedBucket: boolean;
        } | null>(null);
        actions = useSessionActions({
          activeProjectId: null, currentDirectory: '/fixture', currentSessionId: session.id,
          mobileVariant: false, allowReselect: false, isSessionSearchOpen: false, sessionSearchQuery: '',
          setSessionSearchQuery: noop, setIsSessionSearchOpen: noop, setActiveProjectIdOnly: noop,
          setActiveMainTab: noop, setSessionSwitcherOpen: noop, setCurrentSession: noop,
          updateSessionTitle: async () => {}, shareSession: async () => null, unshareSession: async () => null,
          deleteSession, deleteSessions: async () => ({ deletedIds: [], failedIds: [], failures: [] }),
          archiveSessions, unarchiveSession: async () => true,
          unarchiveSessions: async () => ({ unarchivedIds: [], failedIds: [], failures: [] }),
          onArchiveRequested: requested, onArchiveSucceeded: succeeded, onArchiveFailed: failed,
          childrenMap: new Map(), showDeletionDialog: confirmation, deleteSessionConfirm, setDeleteSessionConfirm,
          setEditingId: noop, setEditTitle: noop, editingId: null, editTitle: '',
        });
        return null;
      }
      try {
        await act(async () => root.render(React.createElement(Fixture)));
        await act(async () => { actions?.handleArchiveSession(session); });
        if (confirmation) {
          expect(archiveSessions).toHaveBeenCalledTimes(0);
          await act(async () => { await actions?.confirmDeleteSession(); });
        }
        expect(archiveSessions).toHaveBeenCalledWith([session.id]);
        expect(errors).toEqual([{
          title: 'sessions.sidebar.session.archive.error', description: 'Archive forbidden for this session',
        }]);
        expect(requested).toHaveBeenCalledWith([session.id]);
        expect(failed).toHaveBeenCalledWith([session.id]);
        expect(succeeded).toHaveBeenCalledTimes(0);
        expect(deleteSession).toHaveBeenCalledTimes(0);
      } finally {
        await act(async () => root.unmount());
      }
    });
  });
}
