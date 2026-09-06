import React from 'react';
import type { Session, SessionStatus } from '@opencode-ai/sdk/v2/client';
import { toast } from '@/components/ui';

import { useI18n } from '@/lib/i18n';
import { opencodeClient, ScopedRevertError, type SessionTreeChangedFile } from '@/lib/opencode/client';
import {
    getSessionTreeChangesKey,
    refreshSessionTreeChanges,
    observeSessionTreeActivity,
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

/** Walk `parentID` up through the given list until the root. */
export const resolveRootSessionIdFromList = (sessions: readonly Session[], sessionId: string): string => {
    const parentById = new Map<string, string>();
    for (const session of sessions) {
        const parentID = (session as SessionWithParent).parentID;
        if (parentID) parentById.set(session.id, parentID);
    }
    const visited = new Set<string>([sessionId]);
    let current = sessionId;
    for (;;) {
        const parentID = parentById.get(current);
        if (!parentID || visited.has(parentID)) return current;
        visited.add(parentID);
        current = parentID;
    }
};

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
 * directory is not a git repo, nothing changed (unless the session was just
 * undone), a revert is pending, or the tree is still working. Disabled (with a
 * reason) while a session outside the tree is working in the same project.
 */
export const resolveSessionChangesFooterState = ({
    isGitRepo,
    fileCount,
    isRevertPending,
    isTreeWorking,
    isSiblingWorking,
    isUndone,
}: {
    isGitRepo: boolean | null;
    fileCount: number;
    isRevertPending: boolean;
    isTreeWorking: boolean;
    isSiblingWorking: boolean;
    isUndone: boolean;
}): SessionChangesFooterState => {
    const mode: SessionChangesMode = isUndone ? 'undone' : 'changes';
    const hidden = isGitRepo !== true
        || isRevertPending
        || isTreeWorking
        || fileCount === 0;
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
        status: file.status === 'added' ? 'A' : file.status === 'deleted' ? 'D' : file.status === 'renamed' ? 'R' : 'M',
    };
};

// ---------------------------------------------------------------------------
// Connected controller
// ---------------------------------------------------------------------------

export type SessionChangesBusy = 'undo' | 'redo' | null;

export type SessionChangesController = {
    rootSessionId: string | null;
    directory: string;
    files: GitChangedFile[];
    subagentCount: number;
    statusMessage: string | null;
    revision: string | null;
    reviewFile: string | null;
    closeReview: () => void;
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
    } = useSessionChangesFooterSources();
    useAuthPrincipal();
    const [reviewSelection, setReviewSelection] = React.useState<{ key: string; file: string; revision: string } | null>(null);
    const [busySelection, setBusySelection] = React.useState<{ key: string; action: SessionChangesBusy } | null>(null);

    const rootSessionId = React.useMemo(
        () => (currentSessionId ? resolveRootSessionIdFromList(sessions, currentSessionId) : null),
        [currentSessionId, sessions],
    );
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
        observeSessionTreeActivity(directory, rootSessionId, isTreeWorking || isRevertPending);
    }, [directory, isRevertPending, isTreeWorking, rootSessionId]);

    const files = React.useMemo(
        () => (entry?.files ?? []).map((file) => toGitChangedFile(file, entry?.worktreeDirectory ?? directory)),
        [directory, entry?.files, entry?.worktreeDirectory],
    );

    const state = resolveSessionChangesFooterState({
        isGitRepo,
        fileCount: files.length,
        isRevertPending,
        isTreeWorking,
        isSiblingWorking,
        isUndone,
    });

    let statusMessage: string | null = null;
    if (entry?.error) statusMessage = t('chat.sessionChanges.loadFailed');
    else if (entry?.loading) statusMessage = t('chat.sessionChanges.loading');
    else if (entry?.coverage === 'partial') {
        const reasons = entry.reasons ?? [];
        if (reasons.some((reason) => ['overlapping_operations', 'interleaved_file_changes'].includes(reason))) statusMessage = t('chat.sessionChanges.overlap');
        else if (reasons.some((reason) => ['storage_limit', 'capture_limit'].includes(reason))) statusMessage = t('chat.sessionChanges.limit');
        else if (reasons.includes('native_revert_active')) statusMessage = t('chat.sessionChanges.rewound');
        else statusMessage = t('chat.sessionChanges.incomplete');
    }
    state.undoDisabled = state.undoDisabled || Boolean(entry?.loading || entry?.error) || entry?.coverage !== 'complete' || !entry?.revision;

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
        subagentCount: Math.max(0, (entry?.sessionCount ?? treeIds.length) - 1),
        statusMessage,
        revision: reviewSelection?.key === entryKey ? reviewSelection.revision : entry?.revision ?? null,
        reviewFile: reviewSelection?.key === entryKey ? reviewSelection.file : null,
        closeReview,
        openRepository,
        state,
        disabledReason: state.disabledReason === 'busy-sibling'
            ? t('chat.sessionChanges.footer.undoBlockedTooltip')
            : state.undoDisabled ? statusMessage ?? t('chat.sessionChanges.incomplete') : null,
        busy,
        undo,
        redo,
        openFile,
    };
};
