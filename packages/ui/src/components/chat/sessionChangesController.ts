import React from 'react';
import type { Session, SessionStatus } from '@opencode-ai/sdk/v2/client';
import { toast } from '@/components/ui';

import { useI18n } from '@/lib/i18n';
import { opencodeClient, ScopedRevertError, type SessionTreeChangedFile } from '@/lib/opencode/client';
import {
    getSessionTreeChangesKey,
    refreshSessionTreeChanges,
    observeSessionTreeActivity,
    observeSessionTreeMembers,
    subscribeSessionTreeChanges,
    useSessionTreeChangesStore,
    type SessionTreeChangesEntry,
} from '@/stores/useSessionTreeChangesStore';
import { useUIStore } from '@/stores/useUIStore';
import { useAuthPrincipal } from '@/lib/authSession';

import { type ChangedFileEntry, type GitChangedFile, toRelativePath } from './changedFiles';
import { useSessionChangesFooterSources } from './sessionChangesFooterSources';

// ---------------------------------------------------------------------------
// Pure helpers (exported for focused regression tests)
// ---------------------------------------------------------------------------

type SessionWithParent = Session & { parentID?: string | null };

/** Root plus every descendant, in discovery order. */
export const resolveSessionTreeIds = (sessions: readonly Session[], rootSessionId: string): string[] => {
    const childrenByParent = new Map<string, string[]>();
    for (const session of sessions) {
        const parentID = (session as SessionWithParent).parentID;
        if (!parentID) continue;
        const children = childrenByParent.get(parentID) ?? [];
        children.push(session.id);
        childrenByParent.set(parentID, children);
    }
    const ids: string[] = [];
    const seen = new Set<string>();
    const visit = (id: string) => {
        if (seen.has(id)) return;
        seen.add(id);
        ids.push(id);
        for (const child of childrenByParent.get(id) ?? []) visit(child);
    };
    visit(rootSessionId);
    return ids;
};

const isStatusWorking = (status: SessionStatus | undefined): boolean =>
    status?.type === 'busy' || status?.type === 'retry';

export type SessionChangesMode = 'changes' | 'undone';

export type SessionChangesFooterState = {
    visible: boolean;
    mode: SessionChangesMode;
    undoDisabled: boolean;
    disabledReason: 'busy-sibling' | null;
};

/**
 * Visibility matrix for the session changed-files card. Hidden when the
 * latest submitted turn is not a settled implementation, there are no changes (except Undo),
 * the directory is not a git repo,
 * a revert is pending, or the tree is still working. Disabled (with a reason) while a session outside the tree is working in the same project.
 */
export const resolveSessionChangesFooterState = ({
    isGitRepo,
    fileCount,
    isRevertPending,
    isTreeWorking,
    isSiblingWorking,
    isUndone,
    isImplementationSettled,
}: {
    isGitRepo: boolean | null;
    fileCount: number;
    isRevertPending: boolean;
    isTreeWorking: boolean;
    isSiblingWorking: boolean;
    isUndone: boolean;
    isImplementationSettled: boolean;
}): SessionChangesFooterState => {
    const mode: SessionChangesMode = isUndone ? 'undone' : 'changes';
    const hidden = isGitRepo !== true
        || !isImplementationSettled
        || isRevertPending
        || isTreeWorking
        || (fileCount === 0 && !isUndone);
    return {
        visible: !hidden,
        mode,
        undoDisabled: isSiblingWorking,
        disabledReason: isSiblingWorking ? 'busy-sibling' : null,
    };
};

/**
 * Split the changed files into the rows shown before "Show N more files" and
 * the count still folded away. Collapsing never hides fewer than
 * `initialVisible` rows, so a card that just fits never shows the strip.
 */
export const resolveVisibleChangedFiles = <T,>(
    files: readonly T[],
    isExpanded: boolean,
    initialVisible: number,
): { visibleFiles: readonly T[]; hiddenCount: number } => {
    const limit = Math.max(0, Math.floor(initialVisible));
    if (isExpanded || files.length <= limit) {
        return { visibleFiles: files, hiddenCount: 0 };
    }
    return { visibleFiles: files.slice(0, limit), hiddenCount: files.length - limit };
};

export const toGitChangedFile = (file: SessionTreeChangedFile, directory: string): GitChangedFile => {
    const absolute = file.path.startsWith('/')
        ? file.path
        : `${directory.endsWith('/') ? directory : `${directory}/`}${file.path}`;
    return {
        path: absolute,
        relativePath: toRelativePath(absolute, directory),
        insertions: file.additions ?? 0,
        deletions: file.deletions ?? 0,
        binary: file.additions === null || file.deletions === null,
        oldPath: file.oldPath,
        reviewMode: file.reviewMode,
        segmentCount: file.segmentCount,
        status: file.status === 'added' ? 'A' : file.status === 'deleted' ? 'D' : file.status === 'renamed' ? 'R' : 'M',
    };
};

// ---------------------------------------------------------------------------
// Connected controller
// ---------------------------------------------------------------------------

export type SessionChangesBusy = 'undo' | 'redo' | null;

export const resolveSessionChangesStatusKey = (entry?: Pick<SessionTreeChangesEntry, 'loading' | 'error' | 'coverage' | 'reasons' | 'reconciliationState'>) => {
    if (entry?.loading) return 'chat.sessionChanges.loading';
    if (entry?.error) return 'chat.sessionChanges.loadFailed';
    if (entry?.reconciliationState === 'pending'
        || entry?.reasons?.some((reason) => ['history_pending', 'capture_pending', 'receipts_pending'].includes(reason))) return 'chat.sessionChanges.loading';
    if (entry?.coverage !== 'partial') return null;
    const reasons = entry.reasons ?? [];
    if (reasons.includes('storage_unavailable')) return 'chat.sessionChanges.storageUnavailable';
    if (reasons.includes('capture_timeout')) return 'chat.sessionChanges.captureTimeout';
    if (reasons.includes('capture_interrupted')) return 'chat.sessionChanges.captureInterrupted';
    if (reasons.includes('receipt_conflict') || reasons.includes('capture_identity_reused')) return 'chat.sessionChanges.receiptConflict';
    if (reasons.includes('invalid_change_receipt')) return 'chat.sessionChanges.invalidReceipt';
    if (reasons.includes('execution_delivery_failed')) return 'chat.sessionChanges.deliveryFailed';
    if (reasons.some((reason) => ['missing_capture', 'unverified_tool_changes', 'execution_receipt_unavailable', 'tool_changes_incomplete'].includes(reason))) return 'chat.sessionChanges.executionUnavailable';
    if (reasons.some((reason) => ['storage_limit', 'capture_limit', 'historical_capture_unavailable'].includes(reason))) return 'chat.sessionChanges.legacyCapture';
    if (reasons.includes('native_revert_active')) return 'chat.sessionChanges.rewound';
    return 'chat.sessionChanges.incomplete';
};

export const canRetrySessionChanges = (entry?: Pick<SessionTreeChangesEntry, 'loading' | 'error' | 'reasons' | 'reconciliationState'>): boolean => {
    if (!entry || entry.loading) return false;
    if (entry.error) return true;
    if (entry.reconciliationState === 'pending') return false;
    return Boolean(entry.reasons?.some((reason) => [
        'missing_capture', 'capture_unavailable', 'capture_interrupted', 'capture_timeout', 'storage_unavailable',
        'execution_delivery_failed', 'invalid_change_receipt', 'session_observation_unavailable', 'historical_capture_unavailable',
    ].includes(reason)));
};

export type SessionChangesController = {
    rootSessionId: string | null;
    directory: string;
    files: GitChangedFile[];
    fileCount: number;
    totalsMode: 'net' | 'recorded';
    pageIndex: number;
    pageLoading: boolean;
    nextPage?: () => void;
    previousPage?: () => void;
    subagentCount: number;
    statusMessage: string | null;
    revision: string | null;
    reviewFile: string | null;
    closeReview: () => void;
    retry: (() => void) | undefined;
    openRepository: () => void;
    state: SessionChangesFooterState;
    /** Localised reason while Undo is disabled, `null` when it is enabled. */
    disabledReason: string | null;
    busy: SessionChangesBusy;
    undo: () => void;
    redo: () => void;
    openFile: (file: ChangedFileEntry) => void;
};

/**
 * Live inputs and actions for the current session's changed-files card. Undo
 * reverts the root session (and every sub-agent session that worked for it)
 * back to its first user message; other sessions' work is never touched.
 * `resolveSessionChangesFooterState` stays the only visibility gate.
 */
export const useSessionChangesController = (): SessionChangesController => {
    const { t } = useI18n();
    const {
        currentSessionId,
        directory,
        sessions,
        statuses,
        revertTransactions,
        isGitRepo,
        isImplementationSettled,
    } = useSessionChangesFooterSources();
    useAuthPrincipal();
    const [reviewSelection, setReviewSelection] = React.useState<{ key: string; file: string; revision: string } | null>(null);
    const [busySelection, setBusySelection] = React.useState<{ key: string; action: SessionChangesBusy } | null>(null);

    // The selected session is the root of this card, including when it is a
    // child. Its ancestors and siblings are separate summaries.
    const rootSessionId = currentSessionId;
    const treeIds = React.useMemo(
        () => (rootSessionId ? resolveSessionTreeIds(sessions, rootSessionId) : []),
        [rootSessionId, sessions],
    );
    const entryKey = directory && rootSessionId ? getSessionTreeChangesKey(directory, rootSessionId) : '';
    const busy = busySelection?.key === entryKey ? busySelection.action : null;
    const entry = useSessionTreeChangesStore(React.useCallback(
        (state): SessionTreeChangesEntry | undefined => entryKey ? state.entries.get(entryKey) : undefined,
        [entryKey],
    ));

    const treeIdSet = React.useMemo(() => new Set(treeIds), [treeIds]);
    const isTreeWorking = treeIds.some((id) => isStatusWorking(statuses[id]));
    const isSiblingWorking = Object.entries(statuses).some(([id, status]) => !treeIdSet.has(id) && isStatusWorking(status));
    const isRevertPending = treeIds.some((id) => revertTransactions[id]?.status === 'pending');

    const isUndone = entry?.undone === true;

    React.useEffect(() => {
        if (!directory || !rootSessionId) return undefined;
        return subscribeSessionTreeChanges(directory, rootSessionId);
    }, [directory, entryKey, rootSessionId]);

    React.useEffect(() => {
        if (!directory || !rootSessionId) return;
        observeSessionTreeMembers(directory, rootSessionId, treeIds);
    }, [directory, rootSessionId, treeIds]);

    React.useEffect(() => {
        if (!directory || !rootSessionId) return;
        observeSessionTreeActivity(directory, rootSessionId, isTreeWorking || isRevertPending);
    }, [directory, isRevertPending, isTreeWorking, rootSessionId]);

    const [pageSelection, setPageSelection] = React.useState<{ key: string; revision: string; value: Awaited<ReturnType<typeof opencodeClient.getSessionChangesPage>> } | null>(null);
    const [pageRequest, setPageRequest] = React.useState<{ key: string; revision: string; cursor: string | null; sequence: number } | null>(null);
    const [pageLoading, setPageLoading] = React.useState(false);
    const visiblePage = pageSelection?.key === entryKey && pageSelection.revision === entry?.revision ? pageSelection.value : entry;
    React.useEffect(() => {
        if (!pageRequest || pageRequest.key !== entryKey || pageRequest.revision !== entry?.revision || !rootSessionId) return;
        const controller = new AbortController();
        setPageLoading(true);
        void opencodeClient.getSessionChangesPage(rootSessionId, directory, pageRequest.revision, pageRequest.cursor, controller.signal)
            .then((value) => { if (!controller.signal.aborted) setPageSelection({ key: entryKey, revision: pageRequest.revision, value }); })
            .catch(() => { if (!controller.signal.aborted) toast.error(t('chat.sessionChanges.loadFailed')); })
            .finally(() => { if (!controller.signal.aborted) setPageLoading(false); });
        return () => { controller.abort(); setPageLoading(false); };
    }, [directory, entry?.revision, entryKey, pageRequest, rootSessionId, t]);
    const requestPage = (cursor: string | null) => {
        const revision = entry?.revision;
        if (revision) setPageRequest((previous) => ({ key: entryKey, revision, cursor, sequence: (previous?.sequence ?? 0) + 1 }));
    };
    const files = React.useMemo(
        () => (visiblePage?.files ?? []).map((file) => toGitChangedFile(file, entry?.worktreeDirectory ?? directory)),
        [directory, visiblePage?.files, entry?.worktreeDirectory],
    );

    const state = resolveSessionChangesFooterState({
        isGitRepo,
        fileCount: files.length,
        isRevertPending,
        isTreeWorking,
        isSiblingWorking,
        isUndone,
        isImplementationSettled,
    });

    const statusKey = resolveSessionChangesStatusKey(entry);
    const statusMessage = statusKey ? t(statusKey) : null;
    state.undoDisabled = state.undoDisabled || Boolean(entry?.loading || entry?.error) || entry?.reconciliationState === 'pending'
        || entry?.coverage !== 'complete' || !entry?.revision || entry?.restoreAvailable !== true;

    const retry = React.useCallback(() => {
        if (!rootSessionId || !directory || entry?.loading) return;
        void refreshSessionTreeChanges(directory, rootSessionId);
    }, [directory, entry?.loading, rootSessionId]);

    const restore = React.useCallback((action: 'undo' | 'redo') => {
        const revision = entry?.revision;
        if (!rootSessionId || !revision || busy) return;
        setBusySelection({ key: entryKey, action });
        void (async () => {
            try {
                await opencodeClient.sessionChangesAction(rootSessionId, directory, revision, action);
                await refreshSessionTreeChanges(directory, rootSessionId);
            } catch (error) {
                const code = error instanceof ScopedRevertError ? error.code : null;
                if (code === 'working_tree_changed') toast.error(t('chat.sessionChanges.error.conflict'));
                else if (code === 'summary_revision_changed') toast.error(t('chat.sessionChanges.error.revisionChanged'));
                else if (code === 'directory_busy') toast.error(t('chat.sessionChanges.footer.undoBlockedTooltip'));
                else if (code === 'summary_incomplete') toast.error(t('chat.sessionChanges.incomplete'));
                else if (code === 'rollback_failed') toast.error(t('chat.sessionChanges.error.rollbackFailed'));
                else toast.error(t(action === 'redo' ? 'chat.sessionChanges.error.redoFailed' : 'chat.sessionChanges.error.undoFailed'));
            } finally { setBusySelection((current) => current?.key === entryKey ? null : current); }
        })();
    }, [busy, directory, entry?.revision, entryKey, rootSessionId, t]);
    const undo = React.useCallback(() => restore('undo'), [restore]);
    const redo = React.useCallback(() => restore('redo'), [restore]);
    const openFile = React.useCallback((file: ChangedFileEntry) => {
        if (!entry?.revision) return;
        setReviewSelection({ key: entryKey, file: toRelativePath(file.path, entry.worktreeDirectory ?? directory), revision: entry.revision });
    }, [directory, entry?.revision, entry?.worktreeDirectory, entryKey]);
    const closeReview = React.useCallback(() => setReviewSelection(null), []);
    const openRepository = React.useCallback(() => {
        const ui = useUIStore.getState();
        ui.navigateToDiff('');
        ui.setRightSidebarOpen(false);
    }, []);

    return {
        rootSessionId,
        directory,
        files,
        fileCount: entry?.fileCount ?? files.length,
        totalsMode: entry?.totalsMode ?? 'net',
        pageIndex: visiblePage?.pageIndex ?? 0,
        pageLoading,
        nextPage: visiblePage?.nextCursor ? () => requestPage(visiblePage.nextCursor ?? null) : undefined,
        previousPage: (visiblePage?.pageIndex ?? 0) > 0 ? () => requestPage(visiblePage?.previousCursor ?? null) : undefined,
        subagentCount: Math.max(0, (entry?.sessionCount ?? treeIds.length) - 1),
        statusMessage,
        revision: reviewSelection?.key === entryKey ? reviewSelection.revision : entry?.revision ?? null,
        reviewFile: reviewSelection?.key === entryKey ? reviewSelection.file : null,
        closeReview,
        retry: canRetrySessionChanges(entry) ? retry : undefined,
        openRepository,
        state,
        disabledReason: state.disabledReason === 'busy-sibling'
            ? t('chat.sessionChanges.footer.undoBlockedTooltip')
            : state.undoDisabled ? statusMessage ?? t(entry?.restoreReasons?.includes('segmented_changes')
                ? 'chat.sessionChanges.segmentedRestore' : 'chat.sessionChanges.restoreUnavailable') : null,
        busy,
        undo,
        redo,
        openFile,
    };
};
