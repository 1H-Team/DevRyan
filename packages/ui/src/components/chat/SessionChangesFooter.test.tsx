import React from 'react';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Message, Session, SessionStatus } from '@opencode-ai/sdk/v2/client';

import { I18nProvider } from '@/lib/i18n';
import { dict } from '@/lib/i18n/messages/en';
import type { RevertTransaction } from '@/sync/revert-transactions';
import type { SessionChangesFooterSources } from './sessionChangesFooterSources';

// The footer reads its live inputs through one leaf module so these tests can
// seed them without mocking the sync layer for every later suite in this process.
const session = (id: string, parentID?: string, revert?: { messageID: string }): Session => ({
  id,
  parentID,
  title: id,
  time: { created: 1, updated: 2 },
  ...(revert ? { revert } : {}),
} as unknown as Session);

const userMessage = (id: string, sessionID: string): Message => ({
  id,
  sessionID,
  role: 'user',
  time: { created: 1 },
} as unknown as Message);

let sources: SessionChangesFooterSources = {
  currentSessionId: 'ses_root',
  directory: '/repo',
  sessions: [session('ses_root'), session('ses_child', 'ses_root')],
  statuses: {},
  revertTransactions: {},
  isGitRepo: true,
};
let rootMessages: Record<string, Message[]> = { ses_root: [userMessage('msg_1', 'ses_root')] };

mock.module('./sessionChangesFooterSources', () => ({
  useSessionChangesFooterSources: () => sources,
  useSessionRootMessages: (rootSessionId: string | null) => (rootSessionId ? rootMessages[rootSessionId] : undefined),
}));

// zustand's hook serves `getInitialState()` to the server renderer, so the
// connected footer would never see seeded entries. Swap the hook for a static
// selector over the real store instance; `getState()` and friends stay real.
const storeModule = { ...(await import('@/stores/useSessionTreeChangesStore')) };
mock.module('@/stores/useSessionTreeChangesStore', () => ({
  ...storeModule,
  useSessionTreeChangesStore: Object.assign(
    <T,>(selector: (state: ReturnType<typeof storeModule.useSessionTreeChangesStore.getState>) => T) =>
      selector(storeModule.useSessionTreeChangesStore.getState()),
    storeModule.useSessionTreeChangesStore,
  ),
}));

const {
  SessionChangesFooter,
  SessionChangesFooterView,
  resolveRootSessionIdFromList,
  resolveSessionChangesFooterState,
  resolveSessionTreeIds,
} = await import('./SessionChangesFooter');

const seedEntry = (
  rootSessionID: string,
  overrides: Partial<ReturnType<typeof storeModule.useSessionTreeChangesStore.getState>['entries'] extends Map<string, infer V> ? V : never> = {},
) => {
  const key = storeModule.getSessionTreeChangesKey('/repo', rootSessionID);
  storeModule.useSessionTreeChangesStore.setState({
    entries: new Map([[key, {
      files: [
        { path: 'src/a.ts', status: 'modified', additions: 3, deletions: 1, sessions: ['ses_root'] },
        { path: 'src/b.ts', status: 'added', additions: 10, deletions: 0, sessions: ['ses_child'] },
      ],
      sessionCount: 2,
      hasUnattributedMutations: false,
      firstUserMessageID: 'msg_1',
      fetchedAt: 10,
      loading: false,
      error: null,
      ...overrides,
    }]]),
  });
};

const render = (element: React.ReactElement) => renderToStaticMarkup(
  React.createElement(I18nProvider, null, element),
);

const renderConnected = () => render(React.createElement(SessionChangesFooter));

// The project's bun:test typings omit `toMatch`; keep the regex checks explicit.
const DISABLED_UNDO = /<button[^>]*disabled=""[^>]*data-session-changes-action="undo"/;
const hasDisabledUndo = (markup: string): boolean => DISABLED_UNDO.test(markup);

const busy: SessionStatus = { type: 'busy' } as SessionStatus;
const pendingRevert: RevertTransaction = {
  messageID: 'msg_1',
  version: 1,
  status: 'pending',
  startedAt: 1,
};

describe('resolveSessionChangesFooterState', () => {
  const base = {
    isGitRepo: true as boolean | null,
    fileCount: 2,
    isRevertPending: false,
    isTreeWorking: false,
    isSiblingWorking: false,
    isUndone: false,
  };

  test('visibility matrix', () => {
    expect(resolveSessionChangesFooterState(base)).toEqual({
      visible: true, mode: 'changes', undoDisabled: false, disabledReason: null,
    });
    expect(resolveSessionChangesFooterState({ ...base, isGitRepo: false }).visible).toBe(false);
    expect(resolveSessionChangesFooterState({ ...base, isGitRepo: null }).visible).toBe(false);
    expect(resolveSessionChangesFooterState({ ...base, fileCount: 0 }).visible).toBe(false);
    expect(resolveSessionChangesFooterState({ ...base, isRevertPending: true }).visible).toBe(false);
    expect(resolveSessionChangesFooterState({ ...base, isTreeWorking: true }).visible).toBe(false);
  });

  test('a busy sibling session disables Undo with a reason instead of hiding the footer', () => {
    expect(resolveSessionChangesFooterState({ ...base, isSiblingWorking: true })).toEqual({
      visible: true, mode: 'changes', undoDisabled: true, disabledReason: 'busy-sibling',
    });
  });

  test('an undone session stays visible with zero files so Redo is reachable', () => {
    expect(resolveSessionChangesFooterState({ ...base, fileCount: 0, isUndone: true })).toEqual({
      visible: true, mode: 'undone', undoDisabled: false, disabledReason: null,
    });
  });
});

describe('session tree helpers', () => {
  const sessions = [
    session('ses_root'),
    session('ses_child', 'ses_root'),
    session('ses_grandchild', 'ses_child'),
    session('ses_other'),
  ];

  test('resolves the root by walking parentID and collects the whole tree', () => {
    expect(resolveRootSessionIdFromList(sessions, 'ses_grandchild')).toBe('ses_root');
    expect(resolveRootSessionIdFromList(sessions, 'ses_other')).toBe('ses_other');
    expect(resolveSessionTreeIds(sessions, 'ses_root')).toEqual(['ses_root', 'ses_child', 'ses_grandchild']);
    expect(resolveSessionTreeIds(sessions, 'ses_other')).toEqual(['ses_other']);
  });
});

describe('SessionChangesFooterView', () => {
  const viewProps = {
    directory: '/repo',
    files: [
      { path: '/repo/src/a.ts', relativePath: 'src/a.ts', insertions: 3, deletions: 1, status: 'M' },
      { path: '/repo/src/b.ts', relativePath: 'src/b.ts', insertions: 10, deletions: 0, status: 'A' },
    ],
    subagentCount: 1,
    hasUnattributedMutations: false,
    mode: 'changes' as const,
    undoDisabled: false,
    disabledReason: null,
    busy: null,
    onUndo: () => {},
    onRedo: () => {},
    onOpenFile: () => {},
  };

  test('renders the file summary and an enabled Undo control', () => {
    const markup = render(React.createElement(SessionChangesFooterView, viewProps));
    expect(markup).toContain('2 files changed in this session');
    expect(markup).toContain('data-session-changes-action="undo"');
    expect(hasDisabledUndo(markup)).toBe(false);
    expect(markup).toContain(dict['chat.sessionChanges.footer.actions.undo']);
    expect(markup).not.toContain('data-session-changes-action="redo"');
  });

  test('disables Undo while another session works in the project', () => {
    const markup = render(React.createElement(SessionChangesFooterView, {
      ...viewProps,
      undoDisabled: true,
      disabledReason: dict['chat.sessionChanges.footer.undoBlockedTooltip'],
    }));
    expect(hasDisabledUndo(markup)).toBe(true);
    expect(dict['chat.sessionChanges.footer.undoBlockedTooltip'])
      .toBe('Undo is unavailable while another session is working in this project');
  });

  test('mentions shell-command changes in the summary title when the server flags them', () => {
    const markup = render(React.createElement(SessionChangesFooterView, { ...viewProps, hasUnattributedMutations: true }));
    expect(markup).toContain('(some changes made by shell commands may not be listed)');
  });

  test('shows "Undone · Redo" after a successful Undo', () => {
    const markup = render(React.createElement(SessionChangesFooterView, { ...viewProps, files: [], mode: 'undone' }));
    expect(markup).toContain(dict['chat.sessionChanges.footer.undone']);
    expect(markup).toContain('data-session-changes-action="redo"');
    expect(markup).toContain(dict['chat.sessionChanges.footer.actions.redo']);
    expect(markup).not.toContain('data-session-changes-action="undo"');
  });
});

describe('SessionChangesFooter (connected)', () => {
  beforeEach(() => {
    sources = {
      currentSessionId: 'ses_root',
      directory: '/repo',
      sessions: [session('ses_root'), session('ses_child', 'ses_root'), session('ses_other')],
      statuses: {},
      revertTransactions: {},
      isGitRepo: true,
    };
    rootMessages = { ses_root: [userMessage('msg_1', 'ses_root')] };
    storeModule.resetSessionTreeChangesForTests();
    seedEntry('ses_root');
  });

  test('renders the tree summary for the current session', () => {
    const markup = renderConnected();
    expect(markup).toContain('2 files changed in this session');
    expect(markup).toContain('data-session-changes-action="undo"');
  });

  test('renders from a child session by resolving the root tree', () => {
    sources = { ...sources, currentSessionId: 'ses_child' };
    expect(renderConnected()).toContain('2 files changed in this session');
  });

  test('hides outside git repos', () => {
    sources = { ...sources, isGitRepo: false };
    expect(renderConnected()).toBe('');
  });

  test('hides with zero files', () => {
    seedEntry('ses_root', { files: [] });
    expect(renderConnected()).toBe('');
  });

  test('hides while a revert is pending anywhere in the tree', () => {
    sources = { ...sources, revertTransactions: { ses_child: pendingRevert } };
    expect(renderConnected()).toBe('');
  });

  test('hides while the tree is working', () => {
    sources = { ...sources, statuses: { ses_child: busy } };
    expect(renderConnected()).toBe('');
  });

  test('disables Undo while a session outside the tree is working', () => {
    sources = { ...sources, statuses: { ses_other: busy } };
    const markup = renderConnected();
    expect(markup).toContain('2 files changed in this session');
    expect(hasDisabledUndo(markup)).toBe(true);
  });

  test('shows Undone · Redo once the root is reverted to its first user message', () => {
    sources = {
      ...sources,
      sessions: [session('ses_root', undefined, { messageID: 'msg_1' }), session('ses_child', 'ses_root')],
    };
    seedEntry('ses_root', { files: [] });
    rootMessages = { ses_root: [] };
    const markup = renderConnected();
    expect(markup).toContain(dict['chat.sessionChanges.footer.undone']);
    expect(markup).toContain('data-session-changes-action="redo"');
  });
});
