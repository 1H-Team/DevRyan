import React from 'react';
import { RiArrowDownSLine, RiArrowRightSLine, RiCheckLine, RiExternalLinkLine } from '@remixicon/react';
import type { ToolPart as ToolPartType } from '@opencode-ai/sdk/v2';
import { SimpleMarkdownRenderer } from '../../MarkdownRenderer';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Text } from '@/components/ui/text';
import { AnimatedCounter } from '@/components/ui/AnimatedCounter';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { getToolMetadata } from '@/lib/toolHelpers';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import type { ToolPopupContent } from '../types';
import { ToolRevealOnMount } from './ToolRevealOnMount';
import { ToolScrollableSection } from './ToolScrollableSection';
import { getToolIcon } from './toolPresentation';
import { getRelativePathFromDirectory, normalizePathValue } from './activityPathUtils';
import {
    collectToolActivityRowsFromToolParts,
    extractFetchedUrlsFromToolPart,
    extractReadFilePathsFromToolPart,
    extractSearchedFilePathsFromToolPart,
    getToolActivityGroupLabelKey,
    getToolActivityGroupSummaryCount,
    normalizeToolName,
    type ToolActivityGroupInfo,
} from './toolRenderUtils';
import {
    getTaskSummaryLabel,
    formatTaskErrorText,
    formatTaskModelLabel,
    formatSpecialistTaskOutputForMarkdown,
    shouldRenderGitPathLabel,
    stripTaskMetadataFromOutput,
    taskSummaryEntryToToolPart,
    type TaskToolSummaryEntry,
} from './taskToolUtils';

const normalizeDisplayPath = (value: string): string => {
    const trimmed = normalizePathValue(value);
    if (!trimmed || trimmed === '/') {
        return trimmed;
    }
    return trimmed.replace(/\/+$/, '');
};

const renderTaskPathWithIcon = (path: string, _animate = true, grow = true, showFileIcons = true) => {
    void _animate;
    const lastSlash = path.lastIndexOf('/');

    if (lastSlash === -1) {
        return (
            <span className={cn('min-w-0 inline-flex items-center gap-1 overflow-hidden', grow && 'flex-1')} title={path}>
                {showFileIcons ? <FileTypeIcon filePath={path} className="h-3.5 w-3.5 flex-shrink-0" /> : null}
                <span
                    className={cn('min-w-0 truncate whitespace-nowrap typography-meta', grow && 'flex-1')}
                    style={{ color: 'var(--tools-title)' }}
                >
                    {path}
                </span>
            </span>
        );
    }

    const dir = path.slice(0, lastSlash);
    const name = path.slice(lastSlash + 1);
    const hasAbsoluteRoot = dir.startsWith('/');
    const displayDir = hasAbsoluteRoot ? dir.slice(1) : dir;

    return (
        <span className={cn('min-w-0 inline-flex items-center gap-1 overflow-hidden', grow && 'flex-1')} title={path}>
            {showFileIcons ? <FileTypeIcon filePath={path} className="h-3.5 w-3.5 flex-shrink-0" /> : null}
            <span className={cn('min-w-0 inline-flex max-w-full items-baseline overflow-hidden typography-meta', grow && 'flex-1')}>
                {hasAbsoluteRoot ? <span className="flex-shrink-0" style={{ color: 'var(--tools-description)' }}>/</span> : null}
                <span
                    className="min-w-0 shrink truncate whitespace-nowrap"
                    style={{
                        color: 'var(--tools-description)',
                        direction: 'rtl',
                        textAlign: 'left',
                        unicodeBidi: 'plaintext',
                    }}
                >
                    {displayDir}
                </span>
                <span className="flex-shrink-0" style={{ color: 'var(--tools-description)' }}>/</span>
                <span className="flex-shrink-0" style={{ color: 'var(--tools-title)' }}>
                    {name}
                </span>
            </span>
        </span>
    );
};

const getTaskToolReadOffset = (part: ToolPartType): number | undefined => {
    const state = part.state as { input?: Record<string, unknown>; metadata?: Record<string, unknown> } | undefined;
    const input = state?.input;
    const metadata = state?.metadata;

    const rawOffset =
        (typeof input?.offset === 'number' && Number.isFinite(input.offset) ? input.offset : undefined)
        ?? (typeof input?.line === 'number' && Number.isFinite(input.line) ? input.line : undefined)
        ?? (typeof metadata?.offset === 'number' && Number.isFinite(metadata.offset) ? metadata.offset : undefined)
        ?? (typeof metadata?.line === 'number' && Number.isFinite(metadata.line) ? metadata.line : undefined);

    if (typeof rawOffset !== 'number' || rawOffset <= 0) {
        return undefined;
    }

    return Math.floor(rawOffset);
};

type TaskToolPathEntry = {
    path: string;
    displayPath: string;
    offset?: number;
};

const getTaskToolPathEntries = (
    parts: readonly ToolPartType[],
    currentDirectory: string,
    kind: ToolActivityGroupInfo['kind'],
): TaskToolPathEntry[] => {
    const entries: TaskToolPathEntry[] = [];
    const seen = new Set<string>();

    for (const part of parts) {
        const paths = kind === 'read'
            ? extractReadFilePathsFromToolPart(part)
            : kind === 'search'
                ? extractSearchedFilePathsFromToolPart(part)
                : [];
        const offset = kind === 'read' ? getTaskToolReadOffset(part) : undefined;
        for (const path of paths) {
            const displayPath = getRelativePathFromDirectory(path, currentDirectory);
            const key = displayPath || path;
            if (!key || seen.has(key)) {
                continue;
            }
            seen.add(key);
            entries.push({ path, displayPath: key, offset });
        }
    }

    return entries;
};

const getTaskToolUrlEntries = (parts: readonly ToolPartType[]): string[] => {
    const urls: string[] = [];
    const seen = new Set<string>();

    for (const part of parts) {
        for (const url of extractFetchedUrlsFromToolPart(part)) {
            if (!url || seen.has(url)) {
                continue;
            }
            seen.add(url);
            urls.push(url);
        }
    }

    return urls;
};

const TaskToolSummaryEntryRow: React.FC<{
    entry: TaskToolSummaryEntry;
    isMobile: boolean;
    animateTailText: boolean;
}> = ({ entry, isMobile, animateTailText }) => {
    const showToolFileIcons = useUIStore((state) => state.showToolFileIcons);
    const normalizedToolName = normalizeToolName(entry.tool);
    const toolName = normalizedToolName.length > 0 ? normalizedToolName : 'tool';
    const label = getTaskSummaryLabel(entry);
    const hasLabel = label.trim().length > 0;
    const status = entry.state?.status;

    const displayName = getToolMetadata(toolName).displayName;

    return (
        <ToolRevealOnMount animate={animateTailText} wipe>
            <div className={cn("flex gap-2 min-w-0 w-full", isMobile ? 'items-start' : 'items-center')}>
                <span className="flex-shrink-0 text-foreground/80">{getToolIcon(toolName)}</span>
                <span
                    className="typography-meta text-foreground/80 flex-shrink-0"
                    style={{ color: 'var(--tools-title)' }}
                    title={displayName}
                >
                    {displayName}
                </span>
                {hasLabel ? (
                    status !== 'error' && shouldRenderGitPathLabel(toolName, label) ? (
                        renderTaskPathWithIcon(label, animateTailText, true, showToolFileIcons)
                    ) : (
                        status === 'error' ? (
                            <span className={cn(
                                'typography-meta flex-1 min-w-0 text-[var(--status-error)]',
                                isMobile ? 'whitespace-normal break-words' : 'truncate'
                            )}>
                                {label}
                            </span>
                        ) : (
                            <Text
                                variant={animateTailText ? 'generate-effect' : 'static'}
                                className={cn(
                                    'typography-meta flex-1 min-w-0 text-muted-foreground/70',
                                    isMobile ? 'whitespace-normal break-words' : 'truncate'
                                )}
                                style={{ color: 'var(--tools-description)' }}
                                title={label}
                            >
                                {label}
                            </Text>
                        )
                    )
                ) : null}
            </div>
        </ToolRevealOnMount>
    );
};

const TaskToolSummaryGroupRow: React.FC<{
    groupInfo: ToolActivityGroupInfo;
    parts: ToolPartType[];
    entriesById: Map<string, TaskToolSummaryEntry>;
    isMobile: boolean;
    animateTailText: boolean;
}> = ({ groupInfo, parts, entriesById, isMobile, animateTailText }) => {
    const { t } = useI18n();
    const [isExpanded, setIsExpanded] = React.useState(false);
    const runtime = React.useContext(RuntimeAPIContext);
    const currentDirectory = useEffectiveDirectory() ?? '';
    const showToolFileIcons = useUIStore((state) => state.showToolFileIcons);
    const summaryCount = React.useMemo(
        () => getToolActivityGroupSummaryCount(groupInfo.kind, parts, (part) => part),
        [groupInfo.kind, parts]
    );
    const label = t(getToolActivityGroupLabelKey(groupInfo.kind, summaryCount), { count: summaryCount });
    const icon = getToolIcon(groupInfo.representativeToolName);

    const pathEntries = React.useMemo(
        () => getTaskToolPathEntries(parts, currentDirectory, groupInfo.kind),
        [currentDirectory, groupInfo.kind, parts]
    );
    const urlEntries = React.useMemo(
        () => groupInfo.kind === 'fetch' ? getTaskToolUrlEntries(parts) : [],
        [groupInfo.kind, parts]
    );

    const openPath = React.useCallback((filePath: string, offset?: number) => {
        const normalizedPath = normalizeDisplayPath(filePath);
        if (!normalizedPath) {
            return;
        }
        const absolutePath = normalizedPath.startsWith('/')
            ? normalizedPath
            : `${normalizeDisplayPath(currentDirectory)}/${normalizedPath}`.replace(/\/+/g, '/');

        if (runtime?.editor) {
            void runtime.editor.openFile(absolutePath, offset);
            return;
        }

        const uiStore = useUIStore.getState();
        if (offset && Number.isFinite(offset)) {
            uiStore.openContextFileAtLine(currentDirectory, absolutePath, Math.max(1, Math.trunc(offset)), 1);
            return;
        }
        uiStore.openContextFile(currentDirectory, absolutePath);
    }, [currentDirectory, runtime]);

    const fallbackRows = React.useMemo(() => {
        return parts
            .map((part, index) => {
                const entry = entriesById.get(part.id);
                if (!entry) {
                    return null;
                }
                return (
                    <TaskToolSummaryEntryRow
                        key={entry.id ?? `${part.id}-${index}`}
                        entry={entry}
                        isMobile={isMobile}
                        animateTailText={animateTailText}
                    />
                );
            })
            .filter((row): row is React.ReactElement => row !== null);
    }, [animateTailText, entriesById, isMobile, parts]);

    return (
        <div className="w-full min-w-0">
            <button
                type="button"
                className="group/tool flex w-full items-center gap-x-1.5 rounded-xl py-1 text-left min-w-0"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                    event.stopPropagation();
                    setIsExpanded((current) => !current);
                }}
                aria-expanded={isExpanded}
            >
                <span className="inline-flex h-5 items-center flex-shrink-0" style={{ color: 'var(--tools-icon)' }}>
                    {isExpanded ? <RiArrowDownSLine className="h-3.5 w-3.5" /> : <RiArrowRightSLine className="h-3.5 w-3.5" />}
                </span>
                <span className="inline-flex h-5 items-center flex-shrink-0" style={{ color: 'var(--tools-icon)' }}>
                    {icon}
                </span>
                <AnimatedCounter
                    label={label}
                    animate={animateTailText}
                    className="typography-meta leading-5 font-medium h-5 min-w-0 truncate opacity-85"
                    style={{ color: 'var(--tools-title)' }}
                    title={label}
                />
            </button>
            {isExpanded ? (
                <div className="relative ml-2 mt-1 space-y-0.5 pl-3">
                    <span
                        aria-hidden="true"
                        className="pointer-events-none absolute left-0 top-px bottom-0 w-px"
                        style={{ backgroundColor: 'var(--tools-border)' }}
                    />
                    {(groupInfo.kind === 'read' || groupInfo.kind === 'search') && pathEntries.length > 0 ? (
                        pathEntries.map((entry) => (
                            <button
                                key={entry.displayPath}
                                type="button"
                                className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-left hover:bg-[var(--interactive-hover)]"
                                title={entry.offset ? `${entry.displayPath}:${entry.offset}` : entry.displayPath}
                                onPointerDown={(event) => event.stopPropagation()}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    openPath(entry.path, entry.offset);
                                }}
                            >
                                {showToolFileIcons ? <FileTypeIcon filePath={entry.path} className="h-3.5 w-3.5 flex-shrink-0" /> : null}
                                {renderTaskPathWithIcon(entry.displayPath, animateTailText, true, false)}
                            </button>
                        ))
                    ) : groupInfo.kind === 'fetch' && urlEntries.length > 0 ? (
                        urlEntries.map((url) => (
                            <a
                                key={url}
                                href={url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-left hover:bg-[var(--interactive-hover)]"
                                title={url}
                                onPointerDown={(event) => event.stopPropagation()}
                                onClick={(event) => event.stopPropagation()}
                            >
                                <span
                                    className="min-w-0 flex-1 truncate whitespace-nowrap typography-meta leading-5 underline underline-offset-2"
                                    style={{ color: 'var(--status-info)' }}
                                >
                                    {url}
                                </span>
                            </a>
                        ))
                    ) : fallbackRows}
                </div>
            ) : null}
        </div>
    );
};

export const TaskToolSummary: React.FC<{
    entries: TaskToolSummaryEntry[];
    isExpanded: boolean;
    isMobile: boolean;
    output?: string;
    error?: unknown;
    sessionId?: string;
    sessionAgent?: string;
    onShowPopup?: (content: ToolPopupContent) => void;
    input?: Record<string, unknown>;
    animateTailText?: boolean;
    isActive?: boolean;
}> = ({ entries, isExpanded, isMobile, output, error, sessionId, sessionAgent, onShowPopup, input, animateTailText = true, isActive = false }) => {
    const { t } = useI18n();
    const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);

    const trimmedOutput = typeof output === 'string'
        ? stripTaskMetadataFromOutput(output)
        : '';
    const displayOutput = React.useMemo(
        () => formatSpecialistTaskOutputForMarkdown(trimmedOutput),
        [trimmedOutput]
    );
    const hasOutput = trimmedOutput.length > 0;
    const errorText = formatTaskErrorText(error);
    const taskModelLabel = formatTaskModelLabel(input?.model);
    const [isOutputExpanded, setIsOutputExpanded] = React.useState(false);
    const summaryRowsState = React.useMemo(() => {
        const toolParts = entries.map(taskSummaryEntryToToolPart);
        const entriesById = new Map<string, TaskToolSummaryEntry>();
        toolParts.forEach((part, index) => {
            entriesById.set(part.id, entries[index] as TaskToolSummaryEntry);
        });

        return {
            entriesById,
            rows: collectToolActivityRowsFromToolParts(toolParts),
        };
    }, [entries]);

    const handleOpenSession = (event: React.MouseEvent) => {
        event.stopPropagation();
        if (sessionId) {
            setCurrentSession(sessionId);
        }
    };

    const agentType = typeof sessionAgent === 'string' && sessionAgent.trim().length > 0
        ? sessionAgent.trim()
        : typeof input?.subagent_type === 'string'
        ? input.subagent_type
        : 'subagent';

    if (entries.length === 0 && !hasOutput && !sessionId) {
        return (
            <div className="relative pr-2 pb-2 pt-2 space-y-2 pl-[1.4375rem]">
                {taskModelLabel ? (
                    <div className="typography-micro font-mono text-muted-foreground/60" title={taskModelLabel}>
                        {taskModelLabel}
                    </div>
                ) : null}
                <div className="typography-meta text-muted-foreground/70">
                    {errorText || (isActive ? 'Waiting for subagent activity...' : 'Subtask activity is unavailable.')}
                </div>
            </div>
        );
    }

    const visibleRows = isExpanded ? summaryRowsState.rows : summaryRowsState.rows.slice(-6);
    const hiddenCount = Math.max(0, summaryRowsState.rows.length - visibleRows.length);
    const hasActivityContent = summaryRowsState.rows.length > 0 || Boolean(sessionId);

    return (
        <div className="relative pr-2 pb-2 pt-2 space-y-2">
            {taskModelLabel ? (
                <div className="pl-[1.4375rem] typography-micro font-mono text-muted-foreground/60" title={taskModelLabel}>
                    {taskModelLabel}
                </div>
            ) : null}
            {hasActivityContent ? (
                <div
                    className={cn(
                        'relative space-y-2 pl-[1.4375rem]',
                        'before:absolute before:left-[0.4375rem] before:w-px before:bg-border/80 before:content-[""]',
                        'before:top-[-0.25rem] before:bottom-0'
                    )}
                >
                    {summaryRowsState.rows.length > 0 ? (
                        <ToolScrollableSection maxHeightClass={isExpanded ? 'max-h-[40vh]' : 'max-h-56'} disableHorizontal>
                            <div className="w-full min-w-0 space-y-1">
                                {hiddenCount > 0 ? (
                                    <div className="typography-micro text-muted-foreground/70">+{hiddenCount} more...</div>
                                ) : null}

                                {visibleRows.map((row, idx) => {
                                    if (row.type === 'group') {
                                        return (
                                            <TaskToolSummaryGroupRow
                                                key={`task-group-${row.groupInfo.key}-${row.items[0]?.id ?? idx}`}
                                                groupInfo={row.groupInfo}
                                                parts={row.items}
                                                entriesById={summaryRowsState.entriesById}
                                                isMobile={isMobile}
                                                animateTailText={animateTailText}
                                            />
                                        );
                                    }

                                    const entry = summaryRowsState.entriesById.get(row.item.id);
                                    if (!entry) {
                                        return null;
                                    }
                                    return (
                                        <TaskToolSummaryEntryRow
                                            key={entry.id ?? `${row.item.tool}-${idx}`}
                                            entry={entry}
                                            isMobile={isMobile}
                                            animateTailText={animateTailText}
                                        />
                                    );
                                })}
                            </div>
                        </ToolScrollableSection>
                    ) : null}

                    {sessionId && (
                        <button
                            type="button"
                            className="flex items-center gap-2 typography-meta text-primary hover:text-primary/80 w-full"
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={handleOpenSession}
                        >
                            <RiExternalLinkLine className="h-3.5 w-3.5 flex-shrink-0" />
                            <span className="typography-meta text-primary font-medium">{t('chat.toolPart.openSubtask', { type: agentType.charAt(0).toUpperCase() + agentType.slice(1) })}</span>
                        </button>
                    )}
                </div>
            ) : null}

            {hasOutput ? (
                <div className={cn('space-y-1', hasActivityContent && 'pt-1')}>
                    <button
                        type="button"
                        className="inline-flex items-center gap-1.5 rounded-sm py-1 text-left typography-meta focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--interactive-focus-ring)]"
                        style={{ color: 'var(--tools-title)' }}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                            event.stopPropagation();
                            setIsOutputExpanded((prev) => !prev);
                        }}
                        aria-expanded={isOutputExpanded}
                    >
                        <RiCheckLine className="h-3.5 w-3.5 flex-shrink-0" style={{ color: 'var(--status-success)' }} />
                        <span className="typography-meta font-medium">{t('chat.toolPart.output')}</span>
                    </button>
                    {isOutputExpanded ? (
                        <div className="pl-[1.4375rem]">
                            <ToolScrollableSection maxHeightClass="max-h-[50vh]">
                                <div className="w-full min-w-0">
                                    <SimpleMarkdownRenderer content={displayOutput} variant="tool" onShowPopup={onShowPopup} />
                                </div>
                            </ToolScrollableSection>
                        </div>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
};
