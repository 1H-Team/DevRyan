import React from 'react';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Message, Session, SessionStatus } from '@opencode-ai/sdk/v2/client';

import { opencodeClient, type SessionTreeChanges } from '@/lib/opencode/client';
import { sessionEvents } from '@/lib/sessionEvents';
import type { SessionChangesController } from './sessionChangesController';
import { I18nProvider } from '@/lib/i18n';
import { dict } from '@/lib/i18n/messages/en';
import type { RevertTransaction } from '@/sync/revert-transactions';
import type { SessionChangesFooterSources } from './sessionChangesFooterSources';

// The card reads its live inputs through one leaf module so these tests can
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
  isImplementationSettled: true,
};
let rootMessages: Record<string, Message[]> = { ses_root: [userMessage('msg_1', 'ses_root')] };

mock.module('./sessionChangesFooterSources', () => ({
  useSessionChangesFooterSources: () => sources,
  useSessionRootMessages: (rootSessionId: string | null) => (rootSessionId ? rootMessages[rootSessionId] : undefined),
}));

// zustand's hook serves `getInitialState()` to the server renderer, so the
// connected card would never see seeded entries. Swap the hook for a static
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
  useSessionChangesController,
  resolveSessionChangesFooterState,
  resolveSessionTreeIds,
  resolveVisibleChangedFiles,
  resolveSessionChangesStatusKey,
  canRetrySessionChanges,
} = await import('./sessionChangesController');
const {
  SESSION_CHANGES_INITIAL_VISIBLE_FILES,
  SessionChangesCard,
  SessionChangesCardView,
} = await import('./SessionChangesCard');

const testDirectory = dirname(fileURLToPath(import.meta.url));
const readSource = (relativePath: string): string => readFileSync(resolve(testDirectory, relativePath), 'utf8');

type SeededEntry = ReturnType<typeof storeModule.useSessionTreeChangesStore.getState>['entries'] extends Map<string, infer V> ? V : never;

const seedEntry = (rootSessionID: string, overrides: Partial<SeededEntry> = {}) => {
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
      revision: 'rev_1',
      coverage: 'complete',
      restoreAvailable: true,
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

const renderConnected = (isMobile = false) => render(React.createElement(SessionChangesCard, {
  isMobile,
  onContentChange: () => {},
}));

// The project's bun:test typings omit `toMatch`; keep the regex checks explicit.
const DISABLED_UNDO = /<button[^>]*disabled=""[^>]*data-session-changes-action="undo"/;
const hasDisabledUndo = (markup: string): boolean => DISABLED_UNDO.test(markup);
const countRows = (markup: string): number => (markup.match(/title="Open [^"]+"/g) ?? []).length;
/** A stand-alone "Review" control (as opposed to the "Review changes" subtitle) must never render. */
const REVIEW_BUTTON = /<button[^>]*>(?:<[^>]+>)*\s*Review\s*(?:<[^>]+>)*<\/button>/;

const busy: SessionStatus = { type: 'busy' } as SessionStatus;
const pendingRevert: RevertTransaction = {
  messageID: 'msg_1',
  version: 1,
  status: 'pending',
  startedAt: 1,
};

const gitFile = (name: string, insertions: number, deletions: number, status: 'A' | 'M' | 'D' = 'M') => ({
  path: `/repo/src/${name}`,
  relativePath: `src/${name}`,
  insertions,
  deletions,
  status,
});

describe('resolveSessionChangesFooterState', () => {
  const base = {
    isGitRepo: true as boolean | null,
    fileCount: 2,
    isRevertPending: false,
    isTreeWorking: false,
    isSiblingWorking: false,
    isUndone: false,
    isImplementationSettled: true,
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
    expect(resolveSessionChangesFooterState({ ...base, isImplementationSettled: false }).visible).toBe(false);
  });

  test('a busy sibling session disables Undo with a reason instead of hiding the card', () => {
    expect(resolveSessionChangesFooterState({ ...base, isSiblingWorking: true })).toEqual({
      visible: true, mode: 'changes', undoDisabled: true, disabledReason: 'busy-sibling',
    });
  });

  test('an undone session retains Redo with zero files', () => {
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

  test('collects descendants only from the selected session', () => {
    expect(resolveSessionTreeIds(sessions, 'ses_child')).toEqual(['ses_child', 'ses_grandchild']);
    expect(resolveSessionTreeIds(sessions, 'ses_root')).toEqual(['ses_root', 'ses_child', 'ses_grandchild']);
    expect(resolveSessionTreeIds(sessions, 'ses_other')).toEqual(['ses_other']);
  });
});

describe('resolveVisibleChangedFiles', () => {
  const files = ['a', 'b', 'c', 'd', 'e', 'f'];

  test('folds everything past the initial rows until expanded', () => {
    expect(resolveVisibleChangedFiles(files, false, 3)).toEqual({ visibleFiles: ['a', 'b', 'c'], hiddenCount: 3 });
    expect(resolveVisibleChangedFiles(files, true, 3)).toEqual({ visibleFiles: files, hiddenCount: 0 });
  });

  test('never shows a strip when the list already fits', () => {
    expect(resolveVisibleChangedFiles(['a', 'b', 'c'], false, 3)).toEqual({ visibleFiles: ['a', 'b', 'c'], hiddenCount: 0 });
    expect(resolveVisibleChangedFiles([], false, 3)).toEqual({ visibleFiles: [], hiddenCount: 0 });
  });

  test('the card defaults to three visible rows', () => {
    expect(SESSION_CHANGES_INITIAL_VISIBLE_FILES).toBe(3);
  });
});

describe('SessionChangesCardView', () => {
  const viewProps = {
    directory: '/repo',
    files: [gitFile('a.ts', 2, 1), gitFile('b.ts', 10, 0, 'A')],
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

  test('renders the card header with the edit count, the Review changes subtitle and an enabled Undo', () => {
    const markup = render(React.createElement(SessionChangesCardView, viewProps));
    expect(markup).toContain('data-session-changes-card="changes"');
    expect(markup).toContain('<h3 class="truncate typography-ui-label font-semibold text-foreground">Edited 2 files</h3>');
    expect(markup).toContain('data-session-changes-action="review"');
    expect(markup).toContain(dict['chat.sessionChanges.card.reviewChanges']);
    expect(dict['chat.sessionChanges.card.reviewChanges']).toBe('Review changes');
    expect(markup).toContain('data-session-changes-action="undo"');
    expect(hasDisabledUndo(markup)).toBe(false);
    expect(markup).toContain(dict['chat.sessionChanges.footer.actions.undo']);
    expect(markup).not.toContain('data-session-changes-action="redo"');
  });

  test('segmented files count once without a Recorded Edits subtitle and keep restore disabled', () => {
    const markup = render(React.createElement(SessionChangesCardView, { ...viewProps,
      files: [{ ...gitFile('shared.ts', 4, 2), reviewMode: 'segments', segmentCount: 2 }],
      totalsMode: 'recorded', undoDisabled: true, disabledReason: dict['chat.sessionChanges.segmentedRestore'],
    }));
    expect(countRows(markup)).toBe(1);
    expect(markup).toContain('Edited 1 file');
    const header = markup.match(/<header\b[^>]*>([\s\S]*?)<\/header>/)?.[1];
    expect(header).toBeDefined();
    expect(header).not.toContain('Recorded Edits');
    expect(markup).not.toContain('>Recorded Edits<');
    expect(markup).toContain('2 edits');
    expect(hasDisabledUndo(markup)).toBe(true);
    expect(markup).not.toContain('overlapping owners');
  });

  test('has no stand-alone Review button', () => {
    const markup = render(React.createElement(SessionChangesCardView, viewProps));
    expect(REVIEW_BUTTON.test(markup)).toBe(false);
    expect(markup).not.toContain('>Review<');
  });

  test('renders one row per file with directory, file name and coloured counts', () => {
    const markup = render(React.createElement(SessionChangesCardView, viewProps));
    expect(countRows(markup)).toBe(2);
    expect(markup).toContain('<span class="text-muted-foreground">/</span><span class="text-foreground">a.ts</span>');
    expect(markup).toContain('>src<');
    expect(markup).toContain('tabular-nums');
    expect(markup).toContain('<span style="color:var(--status-success)">+2</span>');
    expect(markup).toContain('<span style="color:var(--status-error)">-1</span>');
    expect(markup).toContain('<span style="color:var(--status-success)">+10</span>');
    expect(markup).not.toContain('data-session-changes-action="show-more"');
  });

  test('shows three rows and a "Show N more files" strip for six files', () => {
    const files = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => gitFile(`${name}.ts`, 1, 0));
    const markup = render(React.createElement(SessionChangesCardView, { ...viewProps, files }));
    expect(markup).toContain('Edited 6 files');
    expect(countRows(markup)).toBe(3);
    expect(markup).toContain('data-session-changes-action="show-more"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('Show 3 more files');
    expect(markup).not.toContain('Show less');
  });

  test('expanding reveals every row and offers Show less', () => {
    // The static renderer cannot click; the expanded state is the same view
    // with the fold lifted, which `initialVisible` exercises directly.
    const files = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => gitFile(`${name}.ts`, 1, 0));
    const expanded = render(React.createElement(SessionChangesCardView, { ...viewProps, files, initialVisible: 6 }));
    expect(countRows(expanded)).toBe(6);
    expect(expanded).not.toContain('data-session-changes-action="show-more"');
    expect(resolveVisibleChangedFiles(files, true, 3).visibleFiles).toHaveLength(6);
    expect(dict['chat.sessionChanges.card.showLess']).toBe('Show less');
    expect(dict['chat.sessionChanges.card.showMore']).toBe('Show {count} more files');
  });

  test('disables Undo while another session works in the project', () => {
    const markup = render(React.createElement(SessionChangesCardView, {
      ...viewProps,
      undoDisabled: true,
      disabledReason: dict['chat.sessionChanges.footer.undoBlockedTooltip'],
    }));
    expect(hasDisabledUndo(markup)).toBe(true);
    expect(dict['chat.sessionChanges.footer.undoBlockedTooltip'])
      .toBe('Undo is unavailable while another session is working in this project');
  });

  test('shows specific missing execution evidence and distinguishes pending recovery from a settled failure', () => {
    const partial = { loading: false, error: null, coverage: 'partial' as const, reasons: ['unverified_tool_changes'] };
    expect(resolveSessionChangesStatusKey(partial)).toBe('chat.sessionChanges.executionUnavailable');
    const markup = render(React.createElement(SessionChangesCardView, { ...viewProps, statusMessage: dict['chat.sessionChanges.executionUnavailable'] }));
    expect(markup).toContain(dict['chat.sessionChanges.executionUnavailable']);
    expect(resolveSessionChangesStatusKey({ ...partial, reconciliationState: 'pending' })).toBe('chat.sessionChanges.loading');
    expect(resolveSessionChangesStatusKey({ ...partial, coverage: 'complete', reasons: [], reconciliationState: 'settled' })).toBeNull();
    expect(resolveSessionChangesStatusKey({ ...partial, reasons: ['receipt_conflict'] })).toBe('chat.sessionChanges.receiptConflict');
    expect(resolveSessionChangesStatusKey({ ...partial, reasons: ['storage_unavailable'] })).toBe('chat.sessionChanges.storageUnavailable');
    expect(canRetrySessionChanges({ ...partial, reasons: ['capture_interrupted'] })).toBe(true);
    expect(canRetrySessionChanges({ ...partial, reasons: ['receipt_conflict'] })).toBe(false);
    const failedRetry = { ...partial, reconciliationState: 'pending' as const, error: 'offline' };
    expect(resolveSessionChangesStatusKey(failedRetry)).toBe('chat.sessionChanges.loadFailed');
    expect(canRetrySessionChanges(failedRetry)).toBe(true);
  });

  test('shows "Undone" + Redo and no rows after a successful Undo', () => {
    const markup = render(React.createElement(SessionChangesCardView, { ...viewProps, files: [], mode: 'undone' }));
    expect(markup).toContain('data-session-changes-card="undone"');
    expect(markup).toContain(`>${dict['chat.sessionChanges.footer.undone']}</h3>`);
    expect(markup).toContain('data-session-changes-action="redo"');
    expect(markup).toContain(dict['chat.sessionChanges.footer.actions.redo']);
    expect(markup).not.toContain('data-session-changes-action="undo"');
    expect(markup).not.toContain('data-session-changes-action="review"');
    expect(countRows(markup)).toBe(0);
  });

  test('uses the full column width on mobile and the padded message column on desktop', () => {
    const mobile = render(React.createElement(SessionChangesCardView, { ...viewProps, isMobile: true }));
    expect(mobile).toContain('class="mt-3 chat-message-column"');
    expect(mobile).toContain('class="w-full px-0"');
    const desktop = render(React.createElement(SessionChangesCardView, { ...viewProps, isMobile: false }));
    expect(desktop).toContain('class="mt-4"');
    expect(desktop).toContain('class="chat-message-column px-4"');
  });

  test('borrows the Agent Dispatch card border and tint tokens', () => {
    const markup = render(React.createElement(SessionChangesCardView, viewProps));
    expect(markup).toContain('relative isolate overflow-hidden rounded-xl border border-[color:var(--managed-task-card-border)]');
    expect(markup).toContain('--managed-task-card-border:color-mix(in srgb, var(--primary-base) 16%, var(--border))');
  });
});

describe('SessionChangesCard (connected)', () => {
  beforeEach(() => {
    sources = {
      currentSessionId: 'ses_root',
      directory: '/repo',
      sessions: [session('ses_root'), session('ses_child', 'ses_root'), session('ses_other')],
      statuses: {},
      revertTransactions: {},
      isGitRepo: true,
      isImplementationSettled: true,
    };
    rootMessages = { ses_root: [userMessage('msg_1', 'ses_root')] };
    storeModule.resetSessionTreeChangesForTests();
    seedEntry('ses_root');
  });

  test('renders the tree summary for the current session', () => {
    const markup = renderConnected();
    expect(markup).toContain('Edited 2 files');
    expect(markup).toContain('data-session-changes-action="undo"');
    expect(countRows(markup)).toBe(2);
    expect(markup).toContain('<span style="color:var(--status-success)">+3</span>');
    expect(markup).toContain('<span style="color:var(--status-error)">-1</span>');
  });

  test('hides earlier changes while planning or unresolved, then restores them after implementation', () => {
    sources = { ...sources, isImplementationSettled: false };
    expect(renderConnected()).toBe('');
    seedEntry('ses_root', { files: [], undone: true });
    expect(renderConnected()).toBe('');
    sources = { ...sources, isImplementationSettled: true, statuses: { ses_child: busy } };
    seedEntry('ses_root');
    expect(renderConnected()).toBe('');
    sources = { ...sources, statuses: {} };
    expect(renderConnected()).toContain('Edited 2 files');
    sources = { ...sources, currentSessionId: 'ses_other', isImplementationSettled: false };
    expect(renderConnected()).toBe('');
  });

  test('a child never displays cached parent or sibling changes', () => {
    sources = { ...sources, currentSessionId: 'ses_child' };
    expect(renderConnected()).toBe('');
    seedEntry('ses_child', { sessionCount: 1, files: [{ path: 'child-only.ts', status: 'added', additions: 1, deletions: 0, sessions: ['ses_child'] }] });
    const markup = renderConnected();
    expect(markup).toContain('Edited 1 file'); expect(markup).toContain('child-only.ts');
    expect(markup).not.toContain('src/a.ts');
  });

  test('folds a long tree list behind Show N more files', () => {
    seedEntry('ses_root', {
      files: ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => ({
        path: `src/${name}.ts`, status: 'modified' as const, additions: 1, deletions: 0, sessions: ['ses_root'],
      })),
    });
    const markup = renderConnected();
    expect(markup).toContain('Edited 6 files');
    expect(countRows(markup)).toBe(3);
    expect(markup).toContain('Show 3 more files');
  });

  test('hides outside git repos', () => {
    sources = { ...sources, isGitRepo: false };
    expect(renderConnected()).toBe('');
  });

  test('hides complete read-only and net-zero summaries', () => {
    seedEntry('ses_root', { files: [], coverage: 'complete' });
    expect(renderConnected()).toBe('');
  });

  test('hides empty loading, failed and incomplete summaries but preserves status with recorded files', () => {
    for (const [overrides, label] of [
      [{ loading: true }, 'chat.sessionChanges.loading'],
      [{ error: 'Failed to load' }, 'chat.sessionChanges.loadFailed'],
      [{ coverage: 'partial' }, 'chat.sessionChanges.incomplete'],
    ] as const) {
      seedEntry('ses_root', { files: [], ...overrides });
      expect(renderConnected()).toBe('');
      seedEntry('ses_root', overrides);
      const markup = renderConnected();
      expect(markup).toContain(dict[label]);
      expect(hasDisabledUndo(markup)).toBe(true);
      expect(markup.includes('data-session-changes-action="retry"')).toBe('error' in overrides);
    }
  });

  test('shows an empty undone result and restores the files after Redo', () => {
    seedEntry('ses_root', { files: [], undone: true });
    expect(renderConnected()).toContain('data-session-changes-action="redo"');
    seedEntry('ses_root', { undone: false });
    expect(renderConnected()).toContain('Edited 2 files');
  });

  afterEach(() => {
    storeModule.resetSessionTreeChangesForTests();
    storeModule.setSessionTreeChangesFetcher(null);
    storeModule.setSessionTreeChangesDebounceForTests(null);
  });

  const controller = (): SessionChangesController => {
    let value: SessionChangesController | undefined;
    function Probe() { value = useSessionChangesController(); return null; }
    render(React.createElement(Probe));
    if (!value) throw new Error('Controller did not render');
    return value;
  };
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
  const result = (overrides: Partial<SessionTreeChanges> = {}): SessionTreeChanges => ({
    rootSessionID: 'ses_root', directory: '/repo', revision: 'rev_2',
    coverage: 'complete', restoreAvailable: true, files: [], sessionCount: 2,
    hasUnattributedMutations: false, firstUserMessageID: 'msg_1', ...overrides,
  });

  test('idle refresh and a later capture notification reveal the completed changes', async () => {
    storeModule.resetSessionTreeChangesForTests();
    storeModule.setSessionTreeChangesDebounceForTests(0);
    let response = result({ coverage: 'partial' });
    storeModule.setSessionTreeChangesFetcher(async () => response);
    const release = storeModule.subscribeSessionTreeChanges('/repo', 'ses_root');
    sources = { ...sources, statuses: { ses_child: busy } };
    storeModule.observeSessionTreeActivity('/repo', 'ses_root', true);
    await settle();
    expect(renderConnected()).toBe('');
    sources = { ...sources, statuses: { ses_child: { type: 'idle' } } };
    storeModule.observeSessionTreeActivity('/repo', 'ses_root', false);
    await settle();
    expect(renderConnected()).toBe('');
    response = result({ files: [{ path: 'late.ts', status: 'modified', additions: 2, deletions: 1, sessions: ['ses_child'] }] });
    sessionEvents.requestGitRefresh({ directory: '/repo', sessionChanges: true });
    await settle();
    expect(renderConnected()).toContain('Edited 1 file');
    expect(renderConnected()).toContain('late.ts');
    release();
  });

  test('Retry refreshes the selected root and clears the failure on success', async () => {
    seedEntry('ses_child', { error: 'offline', sessionCount: 1 });
    sources = { ...sources, currentSessionId: 'ses_child' };
    const calls: string[] = [];
    let finish!: (value: SessionTreeChanges) => void;
    storeModule.setSessionTreeChangesFetcher((root, directory) => {
      calls.push(`${directory}:${root}`);
      return new Promise((resolve) => { finish = resolve; });
    });
    controller().retry?.();
    expect(calls).toEqual(['/repo:ses_child']);
    expect(renderConnected()).toContain(dict['chat.sessionChanges.loading']);
    expect(controller().retry).toBeUndefined();
    finish(result({ rootSessionID: 'ses_child', files: [{ path: 'recovered.ts', status: 'added', additions: 1, deletions: 0, sessions: ['ses_root'] }] }));
    await settle();
    expect(renderConnected()).toContain('recovered.ts');
    expect(renderConnected()).not.toContain(dict['chat.sessionChanges.loadFailed']);
  });

  test('Undo and Redo refresh the revision and keep the empty undone card actionable', async () => {
    const original = opencodeClient.sessionChangesAction;
    const actions: string[] = [];
    let undone = false;
    opencodeClient.sessionChangesAction = async (_root, _directory, _revision, action) => {
      actions.push(action);
      undone = action === 'undo';
    };
    storeModule.setSessionTreeChangesFetcher(async () => result({ undone, files: undone ? [] : [
      { path: 'restored.ts', status: 'added', additions: 1, deletions: 0, sessions: ['ses_root'] },
    ] }));
    try {
      controller().undo();
      await settle();
      expect(renderConnected()).toContain('data-session-changes-action="redo"');
      expect(controller().state.undoDisabled).toBe(false);
      controller().redo();
      await settle();
      expect(renderConnected()).toContain('restored.ts');
      expect(actions).toEqual(['undo', 'redo']);
    } finally { opencodeClient.sessionChangesAction = original; }
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
    expect(markup).toContain('Edited 2 files');
    expect(hasDisabledUndo(markup)).toBe(true);
  });

  test('shows Undone + Redo once the root is reverted to its first user message', () => {
    sources = {
      ...sources,
      sessions: [session('ses_root', undefined, { messageID: 'msg_1' }), session('ses_child', 'ses_root')],
    };
    seedEntry('ses_root', { undone: true });
    rootMessages = { ses_root: [] };
    const markup = renderConnected();
    expect(markup).toContain('data-session-changes-card="undone"');
    expect(markup).toContain(dict['chat.sessionChanges.footer.undone']);
    expect(markup).toContain('data-session-changes-action="redo"');
  });
});

describe('mount points', () => {
  test('ChatContainer mounts the card after the compaction continuity card and before the status row', () => {
    const source = readSource('./ChatContainer.tsx');
    const continuity = source.indexOf('<ManagedTaskCompactionContinuity');
    const card = source.indexOf('<SessionChangesCard');
    const statusRow = source.indexOf('<StatusRowContainer />');
    expect(continuity).toBeGreaterThan(-1);
    expect(card).toBeGreaterThan(continuity);
    expect(statusRow).toBeGreaterThan(card);
    expect(source.slice(card, statusRow)).toContain('onContentChange={handleMessageContentChange}');
  });

  test('the status row no longer hosts the session changes footer', () => {
    const source = readSource('./StatusRowContainer.tsx');
    expect(source).not.toContain('SessionChangesFooter');
    expect(source).not.toContain('shouldRenderSessionChangesFooter');
    expect(source).not.toContain('leftAccessory=');
  });

  test('the card reports structural changes to the auto-follow controller', () => {
    // Static rendering never runs layout effects, so pin the contract at the source.
    const source = readSource('./SessionChangesCard.tsx');
    expect(source).toContain("onContentChange?.('structural');");
    expect(source).toContain('React.useLayoutEffect(() => {\n        onContentChange?.(\'structural\');');
  });
});

test('large summaries retain the total count while the card renders a bounded page', () => {
  seedEntry('ses_root', { fileCount: 513, pageIndex: 0, nextCursor: 'revision:1' });
  const markup = renderConnected();
  expect(markup).toContain('513');
  expect(markup).toContain('Changed file pages');
  expect(markup).toContain('Next');
  expect(countRows(markup) <= 3).toBe(true);
});
