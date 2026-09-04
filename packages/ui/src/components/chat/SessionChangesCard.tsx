import React from 'react';
import {
    RiArrowDownSLine,
    RiArrowGoBackLine,
    RiArrowGoForwardLine,
    RiArrowRightUpLine,
    RiArrowUpSLine,
    RiFileEditLine,
} from '@remixicon/react';
import { Popover } from '@base-ui/react/popover';

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
import type { ContentChangeReason } from '@/hooks/useChatAutoFollow';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

import type { ChangedFileEntry, GitChangedFile } from './changedFiles';
import { SessionChangesDiffDialog } from './SessionChangesDiffDialog';
import { ChangedFileRow, ChangedFilesList } from './ChangedFilesList';
import { changedFilesPopoverClassName, changedFilesPopoverStyle } from './changedFilesPopover';
import {
    resolveVisibleChangedFiles,
    useSessionChangesController,
    type SessionChangesBusy,
    type SessionChangesMode,
} from './sessionChangesController';

// Copied from the Agent Dispatch card (ManagedTaskList.tsx) so both end-of-chat
// cards share one border, tint and column treatment; those tokens are pinned by
// ManagedTaskList.test.tsx, so they are duplicated here rather than exported.
const SESSION_CHANGES_CARD_STYLE: React.CSSProperties & Record<'--managed-task-card-border', string> = {
    '--managed-task-card-border': 'color-mix(in srgb, var(--primary-base) 16%, var(--border))',
};
const SESSION_CHANGES_CARD_CLASS = 'relative isolate overflow-hidden rounded-xl border border-[color:var(--managed-task-card-border)] bg-[color-mix(in_srgb,var(--primary-base)_3%,var(--surface-background))]';

/** Rows shown before "Show N more files". */
export const SESSION_CHANGES_INITIAL_VISIBLE_FILES = 3;

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export interface SessionChangesCardViewProps {
    directory: string;
    files: GitChangedFile[];
    subagentCount: number;
    statusMessage?: string | null;
    onOpenRepository?: () => void;
    mode: SessionChangesMode;
    undoDisabled: boolean;
    disabledReason: string | null;
    busy: SessionChangesBusy;
    isMobile?: boolean;
    /** Rows visible while collapsed; the rest fold behind "Show N more files". */
    initialVisible?: number;
    /** The card lives outside the virtualised list: structural changes must reach the auto-follow controller. */
    onContentChange?: (reason?: ContentChangeReason) => void;
    onUndo: () => void;
    onRedo: () => void;
    onOpenFile: (file: ChangedFileEntry) => void;
}

export const SessionChangesCardView: React.FC<SessionChangesCardViewProps> = ({
    directory,
    files,
    subagentCount,
    statusMessage,
    onOpenRepository,
    mode,
    undoDisabled,
    disabledReason,
    busy,
    isMobile = false,
    initialVisible = SESSION_CHANGES_INITIAL_VISIBLE_FILES,
    onContentChange,
    onUndo,
    onRedo,
    onOpenFile,
}) => {
    const { t } = useI18n();
    const [isReviewOpen, setIsReviewOpen] = React.useState(false);
    const [isExpanded, setIsExpanded] = React.useState(false);
    const [confirmOpen, setConfirmOpen] = React.useState(false);

    const fileCount = files.length;
    const filesLabel = t(fileCount === 1 ? 'chat.sessionChanges.count.fileSingle' : 'chat.sessionChanges.count.filePlural', { count: fileCount });
    const title = mode === 'undone'
        ? t('chat.sessionChanges.footer.undone')
        : fileCount === 0 && statusMessage ? t('chat.sessionChanges.unavailableTitle') : t('chat.sessionChanges.card.title', { files: filesLabel });
    const subagentsLabel = t(
        subagentCount === 1 ? 'chat.sessionChanges.count.subagentSingle' : 'chat.sessionChanges.count.subagentPlural',
        { count: subagentCount },
    );
    const confirmDescription = subagentCount > 0
        ? t('chat.sessionChanges.footer.confirm.description', { files: filesLabel, sessions: subagentsLabel })
        : t('chat.sessionChanges.footer.confirm.descriptionNoSubagents', { files: filesLabel });
    const undoTooltip = disabledReason ?? t('chat.sessionChanges.footer.undoTooltip');

    const { visibleFiles, hiddenCount } = resolveVisibleChangedFiles(files, isExpanded, initialVisible);
    const canCollapse = isExpanded && fileCount > Math.max(0, initialVisible);
    const showToggle = mode === 'changes' && (hiddenCount > 0 || canCollapse);

    // Mount, undo/redo flips and expand/collapse all change the height below the
    // last message; stick-to-bottom only stays correct when it hears about them.
    React.useLayoutEffect(() => {
        onContentChange?.('structural');
    }, [mode, onContentChange, visibleFiles.length, showToggle, statusMessage]);

    const handleToggleExpanded = React.useCallback(() => {
        setIsExpanded((previous) => !previous);
    }, []);

    const handleOpenFile = React.useCallback((file: ChangedFileEntry) => {
        setIsReviewOpen(false);
        onOpenFile(file);
    }, [onOpenFile]);

    const handleConfirmUndo = React.useCallback(() => {
        setConfirmOpen(false);
        onUndo();
    }, [onUndo]);

    const undoButton = (
        <Tooltip>
            <TooltipTrigger asChild>
                <span className="shrink-0" tabIndex={undoDisabled ? 0 : undefined}>
                    <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        className="text-muted-foreground hover:text-foreground"
                        disabled={undoDisabled || busy !== null}
                        aria-disabled={undoDisabled || busy !== null}
                        onClick={() => setConfirmOpen(true)}
                        data-session-changes-action="undo"
                    >
                        {busy === 'undo'
                            ? t('chat.sessionChanges.footer.undoing')
                            : t('chat.sessionChanges.footer.actions.undo')}
                        <RiArrowGoBackLine className="size-3" aria-hidden="true" />
                    </Button>
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
                    <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        className="text-muted-foreground hover:text-foreground"
                        disabled={undoDisabled || busy !== null}
                        onClick={onRedo}
                        data-session-changes-action="redo"
                    >
                        {busy === 'redo'
                            ? t('chat.sessionChanges.footer.redoing')
                            : t('chat.sessionChanges.footer.actions.redo')}
                        <RiArrowGoForwardLine className="size-3" aria-hidden="true" />
                    </Button>
                </span>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>
                {t('chat.sessionChanges.footer.redoTooltip')}
            </TooltipContent>
        </Tooltip>
    );

    const hasRows = mode === 'changes' && visibleFiles.length > 0;

    return (
        <div
            data-session-changes-card-root="true"
            className={cn(isMobile ? 'mt-3 chat-message-column' : 'mt-4')}
        >
            <section
                aria-label={title}
                className={cn(isMobile ? 'w-full px-0' : 'chat-message-column px-4')}
            >
                <div
                    data-session-changes-card={mode}
                    className={SESSION_CHANGES_CARD_CLASS}
                    style={SESSION_CHANGES_CARD_STYLE}
                >
                    <header
                        className={cn(
                            'flex items-start gap-2 px-3 py-2',
                            (hasRows || showToggle || (mode === 'changes' && statusMessage)) && 'border-b border-border/70',
                        )}
                    >
                        <RiFileEditLine className="mt-0.5 size-3.5 shrink-0 text-[var(--primary-base)]" aria-hidden="true" />
                        <div className="flex min-w-0 flex-1 flex-col">
                            <h3 className="truncate typography-ui-label font-semibold text-foreground">{title}</h3>
                            {mode === 'changes' ? (
                                <Popover.Root open={isReviewOpen} onOpenChange={setIsReviewOpen}>
                                    <Popover.Trigger
                                        render={
                                            <button
                                                type="button"
                                                className="inline-flex w-fit items-center gap-0.5 typography-meta text-muted-foreground transition-colors hover:text-foreground"
                                                data-session-changes-action="review"
                                            >
                                                {t('chat.sessionChanges.card.reviewChanges')}
                                                <RiArrowRightUpLine className="size-3 shrink-0" aria-hidden="true" />
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
                                                {statusMessage ? (
                                                    <div className="px-2 py-1 typography-meta text-muted-foreground">
                                                        {statusMessage}
                                                    </div>
                                                ) : null}
                                            </Popover.Popup>
                                        </Popover.Positioner>
                                    </Popover.Portal>
                                </Popover.Root>
                            ) : null}
                        </div>
                        {mode === 'undone' ? redoButton : undoButton}
                    </header>
                    {hasRows ? (
                        <div className="divide-y divide-border/70" data-session-changes-rows="true">
                            {visibleFiles.map((file, index) => (
                                <ChangedFileRow
                                    key={`${file.path}:${index}`}
                                    file={file}
                                    currentDirectory={directory}
                                    onOpenFile={onOpenFile}
                                    className="px-3 py-1.5"
                                />
                            ))}
                        </div>
                    ) : null}
                    {showToggle ? (
                        <div className="border-t border-border/70 px-3 py-1.5">
                            <Button
                                type="button"
                                size="xs"
                                variant="ghost"
                                aria-expanded={isExpanded}
                                onClick={handleToggleExpanded}
                                data-session-changes-action={isExpanded ? 'show-less' : 'show-more'}
                            >
                                {isExpanded
                                    ? t('chat.sessionChanges.card.showLess')
                                    : t('chat.sessionChanges.card.showMore', { count: hiddenCount })}
                                {isExpanded ? (
                                    <RiArrowUpSLine className="size-3.5" aria-hidden="true" />
                                ) : (
                                    <RiArrowDownSLine className="size-3.5" aria-hidden="true" />
                                )}
                            </Button>
                        </div>
                    ) : null}
                    {mode === 'changes' && statusMessage ? (
                        <p className="border-t border-border/70 px-3 py-1.5 typography-meta text-muted-foreground">
                            {statusMessage}
                            {onOpenRepository ? <button type="button" className="ml-2 underline" onClick={onOpenRepository}>{t('chat.sessionChanges.repositoryReview')}</button> : null}
                        </p>
                    ) : null}
                </div>
            </section>
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

SessionChangesCardView.displayName = 'SessionChangesCardView';

// ---------------------------------------------------------------------------
// Connected card
// ---------------------------------------------------------------------------

export interface SessionChangesCardProps {
    isMobile: boolean;
    onContentChange: (reason?: ContentChangeReason) => void;
}

/**
 * "Edited N files · Review changes · Undo" — the end-of-conversation card for
 * the current session's tree, mounted by `ChatContainer` after the compaction
 * continuity card and before the status row. Visibility is decided solely by
 * `resolveSessionChangesFooterState` inside the controller.
 */
export const SessionChangesCard: React.FC<SessionChangesCardProps> = React.memo(({ isMobile, onContentChange }) => {
    const controller = useSessionChangesController();

    if (!controller.state.visible || !controller.rootSessionId) {
        return null;
    }

    return (
        <>
        <SessionChangesCardView
            key={`${controller.rootSessionId}:${controller.directory}`}
            directory={controller.directory}
            files={controller.files}
            subagentCount={controller.subagentCount}
            statusMessage={controller.statusMessage}
            onOpenRepository={controller.openRepository}
            mode={controller.state.mode}
            undoDisabled={controller.state.undoDisabled}
            disabledReason={controller.disabledReason}
            busy={controller.busy}
            isMobile={isMobile}
            onContentChange={onContentChange}
            onUndo={controller.undo}
            onRedo={controller.redo}
            onOpenFile={controller.openFile}
        />
        {controller.reviewFile && controller.revision ? <SessionChangesDiffDialog
            key={`${controller.rootSessionId}:${controller.directory}:${controller.revision}:${controller.reviewFile}`}
            rootSessionID={controller.rootSessionId}
            directory={controller.directory}
            revision={controller.revision}
            file={controller.reviewFile}
            onClose={controller.closeReview}
        /> : null}
        </>
    );
});

SessionChangesCard.displayName = 'SessionChangesCard';
