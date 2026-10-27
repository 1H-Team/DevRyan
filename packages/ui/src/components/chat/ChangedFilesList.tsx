import React from 'react';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { cn } from '@/lib/utils';
import { type ChangedFileEntry, getDisplayPath, getFileStats, isGitFile } from './changedFiles';
import { useI18n } from '@/lib/i18n';

const CHANGED_FILE_ROW_BASE_CLASS = 'relative flex w-full cursor-pointer items-center gap-2 typography-ui-label outline-hidden select-none text-left hover:bg-interactive-hover focus-visible:bg-interactive-hover focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring';
const CHANGED_FILE_ROW_DEFAULT_SPACING_CLASS = 'rounded-lg px-2 py-1';

export interface ChangedFileRowProps {
    file: ChangedFileEntry;
    currentDirectory: string;
    onOpenFile: (file: ChangedFileEntry) => void;
    /** Replaces the default popover spacing (`rounded-lg px-2 py-1`); the row body is unchanged. */
    className?: string;
    showVerification?: boolean;
}

/**
 * One changed-file row: file-type icon, muted RTL-truncated directory, the
 * emphasised file name, then right-aligned `+n` / `-n` counts in tabular numbers.
 * Shared by the changed-files popover list and the session changed-files card.
 */
export const ChangedFileRow: React.FC<ChangedFileRowProps> = ({ file, currentDirectory, onOpenFile, className, showVerification = true }) => {
    const { t } = useI18n();
    const { fileName, dirPart } = getDisplayPath(file, currentDirectory);
    const stats = getFileStats(file);
    const verification = isGitFile(file) ? file.verification : undefined;
    const verificationLabel = verification ? t(verification.state === 'verified' ? 'chat.sessionChanges.file.verified'
        : verification.state === 'restored' ? 'chat.sessionChanges.file.restored'
            : verification.reason === 'current_content_diverged' ? 'chat.sessionChanges.file.diverged'
                : verification.reason === 'current_read_limit' ? 'chat.sessionChanges.file.limit'
                    : verification.reason === 'current_file_changed' ? 'chat.sessionChanges.file.changedDuringRead'
                        : verification.reason === 'current_path_unavailable' ? 'chat.sessionChanges.file.pathUnavailable'
                            : verification.reason === 'current_evidence_unavailable' ? 'chat.sessionChanges.file.evidenceUnavailable'
                                : verification.reason === 'unsupported_file_type' ? 'chat.sessionChanges.file.unsupported'
                                    : 'chat.sessionChanges.file.unavailable') : null;

    return (
        <button
            type="button"
            className={cn(CHANGED_FILE_ROW_BASE_CLASS, className ?? CHANGED_FILE_ROW_DEFAULT_SPACING_CLASS)}
            title={t('chat.changedFiles.actions.openFileTitle', { path: file.path })}
            onClick={() => onOpenFile(file)}
        >
            <FileTypeIcon filePath={file.path} className="h-3.5 w-3.5 flex-shrink-0" />
            <span className="min-w-0 flex-1">
                <span className="flex items-baseline overflow-hidden" title={file.path}>
                    {dirPart ? (
                        <>
                            <span
                                className="min-w-0 truncate text-muted-foreground"
                                style={{ direction: 'rtl', textAlign: 'left', unicodeBidi: 'plaintext' }}
                            >
                                {dirPart}
                            </span>
                            <span className="max-w-full shrink-0 truncate">
                                <span className="text-muted-foreground">/</span>
                                <span className="text-foreground">{fileName}</span>
                            </span>
                        </>
                    ) : (
                        <span className="truncate text-foreground">{fileName}</span>
                    )}
                </span>
                {showVerification && verification ? (
                    <span className="block truncate typography-meta text-muted-foreground" title={verificationLabel ?? undefined} data-file-verification={verification.state}>
                        {verificationLabel}
                    </span>
                ) : null}
            </span>
            {isGitFile(file) && file.binary ? <span className="typography-meta text-muted-foreground">{t('chat.sessionChanges.binary')}</span> : null}
            {isGitFile(file) && file.reviewMode === 'segments' ? <span className="shrink-0 typography-meta text-muted-foreground" title={t('chat.sessionChanges.recordedEdits')}>{t((file.segmentCount ?? 1) === 1 ? 'chat.sessionChanges.oneEdit' : 'chat.sessionChanges.editCount', { count: file.segmentCount ?? 1 })}</span> : null}
            {isGitFile(file) && file.oldPath ? <span className="max-w-[40%] truncate typography-meta text-muted-foreground" title={file.oldPath}>← {file.oldPath}</span> : null}
            {(stats.additions > 0 || stats.deletions > 0) ? (
                <span className="flex-shrink-0 inline-flex items-baseline gap-1 text-[0.75rem] tabular-nums">
                    {stats.additions > 0 ? <span style={{ color: 'var(--status-success)' }}>+{stats.additions}</span> : null}
                    {stats.deletions > 0 ? <span style={{ color: 'var(--status-error)' }}>-{stats.deletions}</span> : null}
                </span>
            ) : null}
        </button>
    );
};

interface ChangedFilesListProps {
    files: ChangedFileEntry[];
    currentDirectory: string;
    onOpenFile: (file: ChangedFileEntry) => void;
}

export const ChangedFilesList: React.FC<ChangedFilesListProps> = ({ files, currentDirectory, onOpenFile }) => {
    const { t } = useI18n();
    return (
        <>
            <div className="flex items-center gap-1.5 px-2 py-1 typography-ui-label font-medium text-muted-foreground">
                <span>{t('chat.changedFiles.title')}</span>
                <span className="typography-meta tabular-nums">{files.length}</span>
            </div>

            <div className="max-h-[260px] overflow-y-auto">
                {files.map((file, index) => (
                    <ChangedFileRow
                        key={`${file.path}:${index}`}
                        file={file}
                        currentDirectory={currentDirectory}
                        onOpenFile={onOpenFile}
                    />
                ))}
            </div>
        </>
    );
};
