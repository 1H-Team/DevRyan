import React from 'react';
import type { Session, SessionStatus } from '@opencode-ai/sdk/v2/client';
import { RiArrowDownSLine, RiArrowUpSLine, RiArrowGoBackLine, RiArrowGoForwardLine, RiFileEditLine } from '@remixicon/react';
import { Popover } from '@base-ui/react/popover';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { useI18n } from '@/lib/i18n';
import type { SessionTreeChangedFile } from '@/lib/opencode/client';
import { cn } from '@/lib/utils';
import {
    getSessionTreeChangesKey,
    observeSessionTreeActivity,
    subscribeSessionTreeChanges,
    useSessionTreeChangesStore,
    type SessionTreeChangesEntry,
} from '@/stores/useSessionTreeChangesStore';
import { useUIStore } from '@/stores/useUIStore';

import { type ChangedFileEntry, type GitChangedFile, toRelativePath } from './changedFiles';
import { ChangedFilesList } from './ChangedFilesList';
import { changedFilesPopoverClassName, changedFilesPopoverStyle } from './changedFilesPopover';
import { useSessionChangesFooterSources, useSessionRootMessages } from './sessionChangesFooterSources';

// ---------------------------------------------------------------------------
// Pure helpers (exported for focused regression tests)
// ---------------------------------------------------------------------------

type SessionWithParent = Session & { parentID?: string | null };

/** Walk `parentID` up through the given list until the root. */
// eslint-disable-next-line react-refresh/only-export-components
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
// eslint-disable-next-line react-refresh/only-export-components
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

export type SessionChangesFooterMode = 'changes' | 'undone';

export type SessionChangesFooterState = {
    visible: boolean;
    mode: SessionChangesFooterMode;
    undoDisabled: boolean;
    disabledReason: 'busy-sibling' | null;
};

/**
 * Visibility matrix. Hidden when the directory is not a git repo, nothing
 * changed (unless the session was just undone), a revert is pending, or the
 * tree is still working. Disabled (with a reason) while a session outside the
 * tree is working in the same project.
 */
// eslint-disable-next-line react-refresh/only-export-components
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
    const mode: SessionChangesFooterMode = isUndone ? 'undone' : 'changes';
    const hidden = isGitRepo !== true
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

const toGitChangedFile = (file: SessionTreeChangedFile, directory: string): GitChangedFile => {
    const absolute = file.path.startsWith('/')
        ? file.path
        : `${directory.endsWith('/') ? directory : `${directory}/`}${file.path}`;
    return {
        path: absolute,
        relativePath: toRelativePath(absolute, directory),
        insertions: file.additions,
        deletions: file.deletions,
        status: file.status === 'added' ? 'A' : file.status === 'deleted' ? 'D' : 'M',
    };
};

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export interface SessionChangesFooterViewProps {
    directory: string;
    files: GitChangedFile[];
    subagentCount: number;
    hasUnattributedMutations: boolean;
    mode: SessionChangesFooterMode;
    undoDisabled: boolean;
    disabledReason: string | null;
    busy: 'undo' | 'redo' | null;
    onUndo: () => void;
    onRedo: () => void;
    onOpenFile: (file: ChangedFileEntry) => void;
}

export const SessionChangesFooterView: React.FC<SessionChangesFooterViewProps> = ({
    directory,
    files,
    subagentCount,
    hasUnattributedMutations,
    mode,
    undoDisabled,
    disabledReason,
    busy,
    onUndo,
    onRedo,
    onOpenFile,
}) => {
    const { t } = useI18n();
    const [isExpanded, setIsExpanded] = React.useState(false);
    const [confirmOpen, setConfirmOpen] = React.useState(false);

    const fileCount = files.length;
    const filesLabel = t(fileCount === 1 ? 'chat.sessionChanges.count.fileSingle' : 'chat.sessionChanges.count.filePlural', { count: fileCount });
    const summaryLabel = t('chat.sessionChanges.footer.summary', { files: filesLabel });
    const unattributedNote = t('chat.sessionChanges.footer.unattributedNote');
    const showFilesAriaLabel = t('chat.sessionChanges.footer.actions.showFilesAria');
    const subagentsLabel = t(
        subagentCount === 1 ? 'chat.sessionChanges.count.subagentSingle' : 'chat.sessionChanges.count.subagentPlural',
        { count: subagentCount },
    );
    const confirmDescription = subagentCount > 0
        ? t('chat.sessionChanges.footer.confirm.description', { files: filesLabel, sessions: subagentsLabel })
        : t('chat.sessionChanges.footer.confirm.descriptionNoSubagents', { files: filesLabel });
    const undoTooltip = disabledReason ?? t('chat.sessionChanges.footer.undoTooltip');

    const handleOpenFile = React.useCallback((file: ChangedFileEntry) => {
        setIsExpanded(false);
        onOpenFile(file);
    }, [onOpenFile]);

    const handleConfirmUndo = React.useCallback(() => {
        setConfirmOpen(false);
        onUndo();
    }, [onUndo]);

    const actionButtonClassName = 'typography-ui-label inline-flex shrink-0 items-center gap-1 text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50';

    const undoButton = (
        <Tooltip>
            <TooltipTrigger asChild>
                <span className="shrink-0" tabIndex={undoDisabled ? 0 : undefined}>
                    <button
                        type="button"
                        className={actionButtonClassName}
                        disabled={undoDisabled || busy !== null}
                        aria-disabled={undoDisabled || busy !== null}
                        onClick={() => setConfirmOpen(true)}
                        data-session-changes-action="undo"
                    >
                        <RiArrowGoBackLine className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        {busy === 'undo'
                            ? t('chat.sessionChanges.footer.undoing')
                            : t('chat.sessionChanges.footer.actions.undo')}
                    </button>
                </span>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>
                {undoTooltip}
            </TooltipContent>
        </Tooltip>
    );

    const redoButton = (
        <Tooltip>
            <TooltipTrigger asChild>
                <span className="shrink-0">
                    <button
                        type="button"
                        className={actionButtonClassName}
                        disabled={busy !== null}
                        onClick={onRedo}
                        data-session-changes-action="redo"
                    >
                        <RiArrowGoForwardLine className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        {busy === 'redo'
                            ? t('chat.sessionChanges.footer.redoing')
                            : t('chat.sessionChanges.footer.actions.redo')}
                    </button>
                </span>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>
                {t('chat.sessionChanges.footer.redoTooltip')}
            </TooltipContent>
        </Tooltip>
    );

    if (mode === 'undone') {
        return (
            <div
                className="flex min-w-0 items-center gap-2 pl-0.5 typography-ui-label text-muted-foreground"
                data-session-changes-footer="undone"
            >
                <span className="truncate">{t('chat.sessionChanges.footer.undone')}</span>
                <span aria-hidden="true">·</span>
                {redoButton}
            </div>
        );
    }

    return (
        <div
            className="flex min-w-0 items-center gap-2 pl-0.5 typography-ui-label text-muted-foreground"
            data-session-changes-footer="changes"
        >
            <Popover.Root open={isExpanded} onOpenChange={setIsExpanded}>
                <Popover.Trigger
                    render={
                        <button
                            type="button"
                            className="flex min-w-0 items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
                            aria-label={showFilesAriaLabel}
                            title={hasUnattributedMutations ? `${summaryLabel} ${unattributedNote}` : summaryLabel}
                        >
                            <RiFileEditLine className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                            <span className="truncate tabular-nums">{summaryLabel}</span>
                            {isExpanded ? (
                                <RiArrowUpSLine className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                            ) : (
                                <RiArrowDownSLine className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                            )}
                        </button>
                    }
                />
                <Popover.Portal>
                    <Popover.Positioner side="top" align="start" sideOffset={4} collisionPadding={8}>
                        <Popover.Popup
                            style={changedFilesPopoverStyle}
                            className={cn(
                                changedFilesPopoverClassName,
                                'transition-all duration-150 ease-out data-[starting-style]:opacity-0 data-[starting-style]:scale-95 data-[ending-style]:opacity-0 data-[ending-style]:scale-95',
                            )}
                        >
                            <ChangedFilesList
                                files={files}
                                currentDirectory={directory}
                                onOpenFile={handleOpenFile}
                            />
                            {hasUnattributedMutations ? (
                                <div className="px-2 py-1 typography-meta text-muted-foreground">
                                    {unattributedNote}
                                </div>
                            ) : null}
                        </Popover.Popup>
                    </Popover.Positioner>
                </Popover.Portal>
            </Popover.Root>
            <span aria-hidden="true">·</span>
            {undoButton}
            <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>{t('chat.sessionChanges.footer.confirm.title')}</DialogTitle>
                        <DialogDescription>{confirmDescription}</DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setConfirmOpen(false)}>
                            {t('chat.sessionChanges.footer.confirm.actions.cancel')}
                        </Button>
                        <Button variant="destructive" onClick={handleConfirmUndo}>
                            {t('chat.sessionChanges.footer.confirm.actions.confirm')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
};

SessionChangesFooterView.displayName = 'SessionChangesFooterView';

// ---------------------------------------------------------------------------
// Connected footer
// ---------------------------------------------------------------------------

/**
 * "N files changed in this session · Undo" — the idle-time footer for the
 * current session's tree. Undo reverts the root session (and every sub-agent
 * session that worked for it) back to its first user message; other sessions'
 * work is never touched.
 */
export const SessionChangesFooter: React.FC = () => {
    const { t } = useI18n();
    const {
        currentSessionId,
        directory,
        sessions,
        statuses,
        revertTransactions,
        isGitRepo,
    } = useSessionChangesFooterSources();
    const runtime = React.useContext(RuntimeAPIContext);
    const [busy, setBusy] = React.useState<'undo' | 'redo' | null>(null);

    const rootSessionId = React.useMemo(
        () => (currentSessionId ? resolveRootSessionIdFromList(sessions, currentSessionId) : null),
        [currentSessionId, sessions],
    );
    const treeIds = React.useMemo(
        () => (rootSessionId ? resolveSessionTreeIds(sessions, rootSessionId) : []),
        [rootSessionId, sessions],
    );
    const rootMessages = useSessionRootMessages(rootSessionId, directory);
    const entry = useSessionTreeChangesStore(React.useCallback(
        (state): SessionTreeChangesEntry | undefined => (
            rootSessionId && directory ? state.entries.get(getSessionTreeChangesKey(directory, rootSessionId)) : undefined
        ),
        [directory, rootSessionId],
    ));

    const treeIdSet = React.useMemo(() => new Set(treeIds), [treeIds]);
    const isTreeWorking = treeIds.some((id) => isStatusWorking(statuses[id]));
    const isSiblingWorking = Object.entries(statuses).some(([id, status]) => !treeIdSet.has(id) && isStatusWorking(status));
    const isRevertPending = treeIds.some((id) => revertTransactions[id]?.status === 'pending');

    const rootSession = rootSessionId ? sessions.find((session) => session.id === rootSessionId) : undefined;
    const rootRevertMessageID = (rootSession as (Session & { revert?: { messageID?: string } }) | undefined)?.revert?.messageID;
    const localFirstUserMessageID = rootMessages?.find((message) => message.role === 'user')?.id;
    const firstUserMessageID = entry?.firstUserMessageID ?? localFirstUserMessageID ?? null;
    const isUndone = Boolean(rootRevertMessageID) && (
        rootRevertMessageID === firstUserMessageID
        || (!firstUserMessageID && (rootMessages?.length ?? 0) === 0)
    );

    React.useEffect(() => {
        if (!directory || !rootSessionId) return undefined;
        return subscribeSessionTreeChanges(directory, rootSessionId);
    }, [directory, rootSessionId]);

    React.useEffect(() => {
        if (!directory || !rootSessionId) return;
        observeSessionTreeActivity(directory, rootSessionId, isTreeWorking || isRevertPending);
    }, [directory, isRevertPending, isTreeWorking, rootSessionId]);

    const files = React.useMemo(
        () => (entry?.files ?? []).map((file) => toGitChangedFile(file, directory)),
        [directory, entry?.files],
    );

    const footerState = resolveSessionChangesFooterState({
        isGitRepo,
        fileCount: files.length,
        isRevertPending,
        isTreeWorking,
        isSiblingWorking,
        isUndone,
    });

    const handleUndo = React.useCallback(async () => {
        if (!rootSessionId || busy) return;
        setBusy('undo');
        try {
            const { undoSession } = await import('@/sync/session-actions');
            await undoSession(rootSessionId);
        } catch (error) {
            toast.error(error instanceof Error && error.message
                ? error.message
                : t('chat.sessionChanges.error.undoFailed'));
        } finally {
            setBusy(null);
        }
    }, [busy, rootSessionId, t]);

    const handleRedo = React.useCallback(async () => {
        if (!rootSessionId || busy) return;
        setBusy('redo');
        try {
            const { unrevertSession } = await import('@/sync/session-actions');
            await unrevertSession(rootSessionId);
        } catch (error) {
            toast.error(error instanceof Error && error.message
                ? error.message
                : t('chat.sessionChanges.error.redoFailed'));
        } finally {
            setBusy(null);
        }
    }, [busy, rootSessionId, t]);

    const handleOpenFile = React.useCallback((file: ChangedFileEntry) => {
        if (!directory) return;
        const absolutePath = file.path.startsWith('/')
            ? file.path
            : `${directory.endsWith('/') ? directory : `${directory}/`}${file.path}`;

        const editor = runtime?.editor;
        if (editor) {
            void editor.openFile(absolutePath);
            return;
        }

        const uiStore = useUIStore.getState();
        if (!uiStore.isMobile) {
            uiStore.openContextFile(directory, absolutePath);
            return;
        }
        uiStore.navigateToDiff(toRelativePath(absolutePath, directory));
        uiStore.setRightSidebarOpen(false);
    }, [directory, runtime]);

    if (!footerState.visible || !rootSessionId) {
        return null;
    }

    return (
        <SessionChangesFooterView
            directory={directory}
            files={files}
            subagentCount={Math.max(0, treeIds.length - 1)}
            hasUnattributedMutations={entry?.hasUnattributedMutations ?? false}
            mode={footerState.mode}
            undoDisabled={footerState.undoDisabled}
            disabledReason={footerState.disabledReason === 'busy-sibling'
                ? t('chat.sessionChanges.footer.undoBlockedTooltip')
                : null}
            busy={busy}
            onUndo={handleUndo}
            onRedo={handleRedo}
            onOpenFile={handleOpenFile}
        />
    );
};

SessionChangesFooter.displayName = 'SessionChangesFooter';
