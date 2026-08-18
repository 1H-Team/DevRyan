import React from 'react';
import { RiArrowDownSLine, RiArrowRightSLine, RiStackLine } from '@remixicon/react';
import type { TurnActivityRecord as TurnActivityPart } from '../../lib/turns/types';
import type { ToolPart as ToolPartType } from '@opencode-ai/sdk/v2';
import type { StreamPhase } from '../types';
import type { ContentChangeReason } from '@/hooks/useChatAutoFollow';
import type { ResponseStyleLevel } from '@/lib/responseStyle';
import type { ToolPopupContent } from '../types';
import ToolPart from './ToolPart';
import { MinDurationShineText } from './MinDurationShineText';
import { ToolRevealOnMount } from './ToolRevealOnMount';
import { FadeInOnReveal } from '../FadeInOnReveal';
import { getToolIcon } from './toolPresentation';
import {
    collectToolActivityRows,
    extractFetchedUrlsFromToolPart,
    extractReadFilePathsFromToolPart,
    extractSearchedFilePathsFromToolPart,
    getToolActivityGroupDescription,
    getToolActivityGroupLabelKey,
    getToolActivityGroupSummaryCount,
    isExpandableTool,
    isPatchToolName,
    isStandaloneTool,
    isStaticTool,
    normalizeToolName,
    type ToolActivityGroupInfo,
} from './toolRenderUtils';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import ReasoningPart from './ReasoningPart';
import ReasoningGroup from './ReasoningGroup';
import JustificationBlock from './JustificationBlock';
import { areRenderRelevantPartsEqual } from '../renderCompare';
import { sessionEvents } from '@/lib/sessionEvents';
import {
    extractChangedFiles,
    isGitFile,
    toRelativePath,
    type ChangedFile,
    type ChangedFileEntry,
} from '../../changedFiles';
import { PatchFilesList, ToolPathList, ToolUrlList, type ToolPathEntry } from './ActivityTargetLists';
import { StaticToolRow } from './StaticToolRow';
import { areActivityListsEqual, getToolReadOffset } from './activityRowUtils';
import { AnimatedCounter } from '@/components/ui/AnimatedCounter';
import {
    getContextDirectoryForPath,
    getRelativePathFromDirectory,
    resolveAbsolutePath,
} from './activityPathUtils';
import {
    getActivityToolName,
    getActivityToolPart,
    getToolStateStatus,
    isActivityRunning,
    isPatchActivityFinalized,
} from './activityTools';
import {
    coalesceConsecutiveReasoningRows,
    type ReasoningGroupRow,
} from '../reasoningGrouping';

interface ProgressiveGroupProps {
    parts: TurnActivityPart[];
    isExpanded: boolean;
    collapsedPreviewCount?: number;
    onToggle: () => void;
    syntaxTheme: Record<string, React.CSSProperties>;
    isMobile: boolean;
    expandedTools: Set<string>;
    onToggleTool: (toolId: string) => void;
    onShowPopup: (content: ToolPopupContent) => void;
    onContentChange?: (reason?: ContentChangeReason) => void;
    streamPhase: StreamPhase;
    showHeader: boolean;
    animateRows?: boolean;
    animatedToolIds?: Set<string>;
    renderJustificationActions?: (activity: TurnActivityPart) => React.ReactNode;
    providerID?: string | null;
    responseStyleLevel?: ResponseStyleLevel;
}

/**
 * Parts arrive in correct chronological order:
 * messages in sequence, parts within each message in their natural LLM
 * production order. No re-sorting needed — time-based sorting breaks this
 * because text parts get time.end = message completion time (later than
 * tools), pushing text after tools within the same message.
 */
const sortPartsByTime = (parts: TurnActivityPart[]): TurnActivityPart[] => parts;

const getSearchFileEntries = (activities: TurnActivityPart[], currentDirectory: string): ToolPathEntry[] => {
    const entries: ToolPathEntry[] = [];
    const seen = new Set<string>();

    for (const activity of activities) {
        const paths = extractSearchedFilePathsFromToolPart(getActivityToolPart(activity));
        for (const path of paths) {
            const displayPath = getRelativePathFromDirectory(path, currentDirectory);
            const key = displayPath || path;
            if (!key || seen.has(key)) {
                continue;
            }
            seen.add(key);
            entries.push({ path, displayPath: key });
        }
    }

    return entries;
};

const getReadFileEntries = (activities: TurnActivityPart[], currentDirectory: string): ToolPathEntry[] => {
    const entries: ToolPathEntry[] = [];
    const seen = new Set<string>();

    for (const activity of activities) {
        const paths = extractReadFilePathsFromToolPart(getActivityToolPart(activity));
        const offset = getToolReadOffset(activity);
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

const getFetchedUrlEntries = (activities: TurnActivityPart[]): string[] => {
    const urls: string[] = [];
    const seen = new Set<string>();

    for (const activity of activities) {
        const extractedUrls = extractFetchedUrlsFromToolPart(getActivityToolPart(activity));
        for (const url of extractedUrls) {
            if (!url || seen.has(url)) {
                continue;
            }
            seen.add(url);
            urls.push(url);
        }
    }

    return urls;
};

type AggregatedLeafRow =
    | { type: 'tool-expandable'; activity: TurnActivityPart }
    | { type: 'tool-static-group'; toolName: string; activities: TurnActivityPart[] }
    | { type: 'tool-activity-group'; groupInfo: ToolActivityGroupInfo; activities: TurnActivityPart[] }
    | { type: 'reasoning'; activity: TurnActivityPart }
    | { type: 'justification'; activity: TurnActivityPart }
    | { type: 'tool-fallback'; activity: TurnActivityPart };

type AggregatedRow = AggregatedLeafRow | ReasoningGroupRow<TurnActivityPart>;

interface ExpandableToolRowProps {
    activity: TurnActivityPart;
    isExpanded: boolean;
    syntaxTheme: Record<string, React.CSSProperties>;
    isMobile: boolean;
    onToggleTool: (toolId: string) => void;
    onShowPopup: (content: ToolPopupContent) => void;
    onContentChange?: (reason?: ContentChangeReason) => void;
    animateTailText: boolean;
    animateRows: boolean;
}

const ExpandableToolRow: React.FC<ExpandableToolRowProps> = ({
    activity,
    isExpanded,
    syntaxTheme,
    isMobile,
    onToggleTool,
    onShowPopup,
    onContentChange,
    animateTailText,
    animateRows,
}) => {
    const handleToggle = React.useCallback(() => {
        onToggleTool(activity.id);
    }, [activity.id, onToggleTool]);

    const content = (
        <ToolPart
            part={activity.part as ToolPartType}
            isExpanded={isExpanded}
            onToggle={handleToggle}
            syntaxTheme={syntaxTheme}
            isMobile={isMobile}
            onContentChange={onContentChange}
            onShowPopup={onShowPopup}
            animateTailText={animateTailText}
        />
    );

    const maybeWrapped = animateTailText ? (
        <ToolRevealOnMount animate={true} wipe>
            {content}
        </ToolRevealOnMount>
    ) : content;

    if (!animateRows) {
        return maybeWrapped;
    }

    return <FadeInOnReveal>{maybeWrapped}</FadeInOnReveal>;
};

const MemoExpandableToolRow = React.memo(ExpandableToolRow, (prev, next) => {
    return prev.isExpanded === next.isExpanded
        && prev.syntaxTheme === next.syntaxTheme
        && prev.isMobile === next.isMobile
        && prev.onToggleTool === next.onToggleTool
        && prev.onShowPopup === next.onShowPopup
        && prev.onContentChange === next.onContentChange
        && prev.animateTailText === next.animateTailText
        && prev.animateRows === next.animateRows
        && prev.activity.id === next.activity.id
        && prev.activity.kind === next.activity.kind
        && prev.activity.endedAt === next.activity.endedAt
        && areRenderRelevantPartsEqual([prev.activity.part], [next.activity.part]);
});

interface StaticGroupedToolRowProps {
    toolName: string;
    activities: TurnActivityPart[];
    animateTailText: boolean;
    animateRows: boolean;
}

const StaticGroupedToolRow: React.FC<StaticGroupedToolRowProps> = ({
    toolName,
    activities,
    animateTailText,
    animateRows,
}) => {
    const content = (
        <StaticToolRow
            toolName={toolName}
            activities={activities}
            animateTailText={animateTailText}
        />
    );

    const maybeWrapped = animateTailText ? (
        <ToolRevealOnMount animate={true} wipe>
            {content}
        </ToolRevealOnMount>
    ) : content;

    if (!animateRows) {
        return maybeWrapped;
    }

    return <FadeInOnReveal>{maybeWrapped}</FadeInOnReveal>;
};

const MemoStaticGroupedToolRow = React.memo(StaticGroupedToolRow, (prev, next) => {
    return prev.toolName === next.toolName
        && prev.animateTailText === next.animateTailText
        && prev.animateRows === next.animateRows
        && areActivityListsEqual(prev.activities, next.activities);
});

interface GroupedToolActivityRowProps {
    groupInfo: ToolActivityGroupInfo;
    activities: TurnActivityPart[];
    syntaxTheme: Record<string, React.CSSProperties>;
    isMobile: boolean;
    expandedTools: Set<string>;
    onToggleTool: (toolId: string) => void;
    onShowPopup: (content: ToolPopupContent) => void;
    onContentChange?: (reason?: ContentChangeReason) => void;
    animateTailText: boolean;
    animateRows: boolean;
}

const GroupedToolActivityRowInner: React.FC<GroupedToolActivityRowProps> = ({
    groupInfo,
    activities,
    syntaxTheme,
    isMobile,
    expandedTools,
    onToggleTool,
    onShowPopup,
    onContentChange,
    animateTailText,
    animateRows,
}) => {
    const { t } = useI18n();
    const [isExpanded, setIsExpanded] = React.useState(false);
    const runtime = React.useContext(RuntimeAPIContext);
    const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
    const lastPatchRefreshSignatureRef = React.useRef('');
    const hasRunningActivity = React.useMemo(() => activities.some((activity) => isActivityRunning(activity)), [activities]);
    const summaryCount = React.useMemo(() => {
        return getToolActivityGroupSummaryCount(groupInfo.kind, activities, getActivityToolPart);
    }, [activities, groupInfo.kind]);
    const label = t(getToolActivityGroupLabelKey(groupInfo, summaryCount), { count: summaryCount });
    const description = React.useMemo(() => {
        return getToolActivityGroupDescription(groupInfo.kind, activities.map(getActivityToolPart));
    }, [activities, groupInfo.kind]);
    const icon = getToolIcon(groupInfo.representativeToolName);

    const patchFiles = React.useMemo(() => {
        if (groupInfo.kind !== 'patch') {
            return [] as ChangedFile[];
        }
        return extractChangedFiles(
            activities
                .map(getActivityToolPart)
                .filter((part) => isPatchToolName(part.tool))
        );
    }, [activities, groupInfo.kind]);

    const searchFileEntries = React.useMemo(() => {
        if (groupInfo.kind !== 'search') {
            return [] as ToolPathEntry[];
        }
        return getSearchFileEntries(activities, currentDirectory);
    }, [activities, currentDirectory, groupInfo.kind]);

    const readFileEntries = React.useMemo(() => {
        if (groupInfo.kind !== 'read') {
            return [] as ToolPathEntry[];
        }
        return getReadFileEntries(activities, currentDirectory);
    }, [activities, currentDirectory, groupInfo.kind]);

    const fetchedUrlEntries = React.useMemo(() => {
        if (groupInfo.kind !== 'fetch') {
            return [] as string[];
        }
        return getFetchedUrlEntries(activities);
    }, [activities, groupInfo.kind]);

    React.useEffect(() => {
        if (groupInfo.kind !== 'patch' || !currentDirectory) {
            return;
        }
        if (!activities.some(isPatchActivityFinalized)) {
            return;
        }
        const signature = activities
            .map((activity) => {
                const part = getActivityToolPart(activity);
                return `${part.id}:${getToolStateStatus(part) ?? 'unknown'}:${activity.endedAt ?? ''}`;
            })
            .join('|');
        if (!signature || lastPatchRefreshSignatureRef.current === signature) {
            return;
        }
        lastPatchRefreshSignatureRef.current = signature;
        sessionEvents.requestGitRefresh({ directory: currentDirectory });
    }, [activities, currentDirectory, groupInfo.kind]);

    const handleOpenPath = React.useCallback((filePath: string, offset?: number) => {
        const absolutePath = resolveAbsolutePath(currentDirectory, filePath);
        if (!absolutePath) {
            return;
        }

        if (runtime?.editor) {
            void runtime.editor.openFile(absolutePath, offset);
            return;
        }

        const uiStore = useUIStore.getState();
        const contextDirectory = getContextDirectoryForPath(currentDirectory, absolutePath);
        if (offset && Number.isFinite(offset)) {
            uiStore.openContextFileAtLine(contextDirectory, absolutePath, Math.max(1, Math.trunc(offset)), 1);
            return;
        }
        uiStore.openContextFile(contextDirectory, absolutePath);
    }, [currentDirectory, runtime]);

    const handleOpenPatchFile = React.useCallback((file: ChangedFileEntry) => {
        if (!currentDirectory || isGitFile(file)) {
            return;
        }

        const absolutePath = resolveAbsolutePath(currentDirectory, file.path);
        if (!absolutePath) {
            return;
        }

        if (runtime?.editor) {
            if (runtime.runtime.isVSCode && file.patch) {
                const label = `${getRelativePathFromDirectory(absolutePath, currentDirectory)} (changes)`;
                void runtime.editor.openDiff('', absolutePath, label, { patch: file.patch });
                return;
            }
            void runtime.editor.openFile(absolutePath);
            return;
        }

        const uiStore = useUIStore.getState();
        if (!uiStore.isMobile) {
            const contextDirectory = getContextDirectoryForPath(currentDirectory, absolutePath);
            uiStore.openContextFile(contextDirectory, absolutePath);
            return;
        }
        uiStore.navigateToDiff(toRelativePath(file.path, currentDirectory));
        uiStore.setRightSidebarOpen(false);
    }, [currentDirectory, runtime]);

    const toggle = React.useCallback(() => {
        setIsExpanded((current) => !current);
    }, []);

    const defaultActivityRows = React.useMemo(() => {
        return activities.map((activity) => {
            const toolPart = getActivityToolPart(activity);
            const toolName = normalizeToolName(toolPart.tool) || groupInfo.representativeToolName;
            if (isExpandableTool(toolName)) {
                return (
                    <ToolPart
                        key={activity.id}
                        part={toolPart}
                        isExpanded={expandedTools.has(activity.id)}
                        onToggle={onToggleTool}
                        syntaxTheme={syntaxTheme}
                        isMobile={isMobile}
                        onContentChange={onContentChange}
                        onShowPopup={onShowPopup}
                        animateTailText={animateTailText}
                    />
                );
            }

            return (
                <StaticToolRow
                    key={activity.id}
                    toolName={toolName}
                    activities={[activity]}
                    animateTailText={animateTailText}
                />
            );
        });
    }, [activities, animateTailText, expandedTools, groupInfo.representativeToolName, isMobile, onContentChange, onShowPopup, onToggleTool, syntaxTheme]);

    const expandedDetails = React.useMemo(() => {
        if (groupInfo.kind === 'patch' && patchFiles.length > 0) {
            return <PatchFilesList files={patchFiles} currentDirectory={currentDirectory} onOpenFile={handleOpenPatchFile} />;
        }
        if (groupInfo.kind === 'search' && searchFileEntries.length > 0) {
            return <ToolPathList entries={searchFileEntries} onOpenPath={handleOpenPath} />;
        }
        if (groupInfo.kind === 'read' && readFileEntries.length > 0) {
            return <ToolPathList entries={readFileEntries} onOpenPath={handleOpenPath} />;
        }
        if (groupInfo.kind === 'fetch' && fetchedUrlEntries.length > 0) {
            return <ToolUrlList urls={fetchedUrlEntries} />;
        }
        return defaultActivityRows;
    }, [currentDirectory, defaultActivityRows, fetchedUrlEntries, groupInfo.kind, handleOpenPatchFile, handleOpenPath, patchFiles, readFileEntries, searchFileEntries]);

    const content = groupInfo.kind === 'browser' ? (
        <StaticToolRow
            toolName="devryan_browser"
            activities={activities}
            animateTailText={animateTailText}
        />
    ) : (
        <div className="w-full min-w-0">
            <button
                type="button"
                className="group/tool flex w-full items-center gap-x-1.5 pr-2 pl-px py-1.5 rounded-xl text-left min-w-0"
                onClick={toggle}
                aria-expanded={isExpanded}
            >
                <span className="inline-flex h-5 items-center flex-shrink-0" style={{ color: 'var(--tools-icon)' }}>
                    {isExpanded ? <RiArrowDownSLine className="h-3.5 w-3.5" /> : <RiArrowRightSLine className="h-3.5 w-3.5" />}
                </span>
                <span className="inline-flex h-5 items-center flex-shrink-0" style={{ color: 'var(--tools-icon)' }}>
                    {icon}
                </span>
                <MinDurationShineText
                    active={hasRunningActivity}
                    minDurationMs={1000}
                    className="typography-meta leading-5 font-medium inline-flex h-5 items-center min-w-0 truncate opacity-85"
                    style={{ color: 'var(--tools-title)' }}
                    title={label}
                >
                    <AnimatedCounter label={label} animate={hasRunningActivity} />
                </MinDurationShineText>
                {description ? (
                    <span
                        className="typography-meta leading-5 min-w-0 truncate"
                        style={{ color: 'var(--tools-description)' }}
                        title={description}
                    >
                        {description}
                    </span>
                ) : null}
            </button>
            {isExpanded ? (
                <div className="relative ml-2 pl-3 space-y-1.5">
                    <span
                        aria-hidden="true"
                        className="pointer-events-none absolute left-0 top-px bottom-0 w-px"
                        style={{ backgroundColor: 'var(--tools-border)' }}
                    />
                    {expandedDetails}
                </div>
            ) : null}
        </div>
    );

    const maybeWrapped = animateTailText ? (
        <ToolRevealOnMount animate={true} wipe>
            {content}
        </ToolRevealOnMount>
    ) : content;

    if (!animateRows) {
        return maybeWrapped;
    }

    return <FadeInOnReveal>{maybeWrapped}</FadeInOnReveal>;
};

export const GroupedToolActivityRow = React.memo(GroupedToolActivityRowInner, (prev, next) => {
    return prev.groupInfo.key === next.groupInfo.key
        && prev.groupInfo.kind === next.groupInfo.kind
        && prev.groupInfo.representativeToolName === next.groupInfo.representativeToolName
        && prev.syntaxTheme === next.syntaxTheme
        && prev.isMobile === next.isMobile
        && prev.expandedTools === next.expandedTools
        && prev.onToggleTool === next.onToggleTool
        && prev.onShowPopup === next.onShowPopup
        && prev.onContentChange === next.onContentChange
        && prev.animateTailText === next.animateTailText
        && prev.animateRows === next.animateRows
        && areActivityListsEqual(prev.activities, next.activities);
});

const toToolActivityRow = (activity: TurnActivityPart): AggregatedLeafRow => {
    const toolName = getActivityToolName(activity);
    if (isExpandableTool(toolName)) {
        return { type: 'tool-expandable', activity };
    }

    if (isStaticTool(toolName)) {
        return { type: 'tool-static-group', toolName, activities: [activity] };
    }

    return { type: 'tool-fallback', activity };
};

/**
 * Aggregate sorted activity parts into display rows.
 * Passive lookup and browser tools roll up across reasoning text until a hard tool boundary.
 * Edit/patch tools stay burst-scoped so output remains close to the narrative that produced it.
 * Ungrouped expandable tools (bash, question) stay as individual rows.
 * Unknown tools stay as individual expandable rows (fallback).
 */
const aggregateRows = (parts: TurnActivityPart[]): AggregatedRow[] => {
    const rows = collectToolActivityRows(parts, {
        getToolName: getActivityToolName,
        getToolPart: getActivityToolPart,
        isReasoningOrJustification: (activity) => activity.kind === 'reasoning' || activity.kind === 'justification',
        isStandalone: (activity) => activity.kind === 'tool' && isStandaloneTool(getActivityToolName(activity)),
    }).map((row): AggregatedLeafRow => {
        if (row.type === 'group') {
            return {
                type: 'tool-activity-group',
                groupInfo: row.groupInfo,
                activities: row.items,
            };
        }

        if (row.item.kind === 'reasoning') {
            return { type: 'reasoning', activity: row.item };
        }

        if (row.item.kind === 'justification') {
            return { type: 'justification', activity: row.item };
        }

        return toToolActivityRow(row.item);
    });

    return coalesceConsecutiveReasoningRows<TurnActivityPart, AggregatedLeafRow>(rows);
};

/**
 * Inline reasoning text block — rendered as dimmed italic markdown.
 */
const InlineReasoningBlock = React.memo(({ activity, onContentChange, providerID, responseStyleLevel, isMobile }: {
    activity: TurnActivityPart;
    onContentChange?: (reason?: ContentChangeReason) => void;
    providerID?: string | null;
    responseStyleLevel?: ResponseStyleLevel;
    isMobile: boolean;
}) => {
    return (
        <ReasoningPart
            part={activity.part}
            messageId={activity.messageId}
            providerID={activity.providerID ?? providerID}
            responseStyleLevel={responseStyleLevel}
            onContentChange={onContentChange}
            isMobile={isMobile}
        />
    );
});

/**
 * Inline justification text block — rendered as compact assistant activity between tools.
 */
const InlineJustificationBlock = React.memo(({ activity, onContentChange, actions, isMobile }: {
    activity: TurnActivityPart;
    onContentChange?: (reason?: ContentChangeReason) => void;
    actions?: React.ReactNode;
    isMobile: boolean;
}) => {
    return (
        <JustificationBlock
            part={activity.part}
            messageId={activity.messageId}
            onContentChange={onContentChange}
            actions={actions}
            isMobile={isMobile}
        />
    );
});

const ProgressiveGroup: React.FC<ProgressiveGroupProps> = ({
    parts,
    isExpanded,
    collapsedPreviewCount = 0,
    onToggle,
    syntaxTheme,
    isMobile,
    expandedTools,
    onToggleTool,
    onShowPopup,
    onContentChange,
    streamPhase: _streamPhase,
    showHeader,
    animateRows = true,
    animatedToolIds,
    renderJustificationActions,
    providerID,
    responseStyleLevel,
}) => {
    void _streamPhase;
    const previewCount = showHeader && !isExpanded
        ? Math.max(0, Math.floor(collapsedPreviewCount))
        : 0;
    const shouldRenderRows = !showHeader || isExpanded || previewCount > 0;

    const sortedParts = React.useMemo(() => {
        if (!shouldRenderRows) {
            return [] as TurnActivityPart[];
        }
        return sortPartsByTime(parts);
    }, [parts, shouldRenderRows]);

    const rows = React.useMemo(() => {
        if (!shouldRenderRows) {
            return [] as AggregatedRow[];
        }
        return aggregateRows(sortedParts);
    }, [shouldRenderRows, sortedParts]);

    const previewHiddenCount = React.useMemo(() => {
        if (isExpanded || previewCount === 0) {
            return 0;
        }
        return Math.max(0, rows.length - previewCount);
    }, [isExpanded, previewCount, rows.length]);

    const visibleRows = React.useMemo(() => {
        if (isExpanded || previewCount === 0) {
            return rows;
        }
        return rows.slice(-previewCount);
    }, [isExpanded, previewCount, rows]);

    if (shouldRenderRows && rows.length === 0) {
        return null;
    }

    const wrapRow = (key: string, content: React.ReactNode) => {
        if (!animateRows) {
            return <React.Fragment key={key}>{content}</React.Fragment>;
        }
        return <FadeInOnReveal key={key}>{content}</FadeInOnReveal>;
    };

    const renderedRows = shouldRenderRows
        ? visibleRows.map((row, index) => {
        switch (row.type) {
            case 'reasoning':
                return wrapRow(
                    row.activity.id,
                    <>
                        <InlineReasoningBlock
                            activity={row.activity}
                            onContentChange={onContentChange}
                            providerID={providerID}
                            responseStyleLevel={responseStyleLevel}
                            isMobile={isMobile}
                        />
                    </>
                );

            case 'reasoning-group':
                return wrapRow(
                    row.activities[0]?.id ?? `reasoning-group-${index}`,
                    <ReasoningGroup
                        entries={row.activities.map((activity) => ({
                            part: activity.part,
                            messageId: activity.messageId,
                        }))}
                        providerID={row.activities[row.activities.length - 1]?.providerID ?? providerID}
                        responseStyleLevel={responseStyleLevel}
                        onContentChange={onContentChange}
                        isMobile={isMobile}
                    />
                );

            case 'justification':
                return wrapRow(
                    row.activity.id,
                    <>
                        <InlineJustificationBlock
                            activity={row.activity}
                            onContentChange={onContentChange}
                            actions={renderJustificationActions?.(row.activity)}
                            isMobile={isMobile}
                        />
                    </>
                );

            case 'tool-expandable':
                return (
                    <MemoExpandableToolRow
                        key={row.activity.id}
                        activity={row.activity}
                        isExpanded={expandedTools.has(row.activity.id)}
                        syntaxTheme={syntaxTheme}
                        isMobile={isMobile}
                        onToggleTool={onToggleTool}
                        onShowPopup={onShowPopup}
                        onContentChange={onContentChange}
                        animateTailText={Boolean(animatedToolIds?.has(row.activity.id))}
                        animateRows={animateRows}
                    />
                );

            case 'tool-static-group':
                return (
                    <MemoStaticGroupedToolRow
                        key={`static-${row.toolName}-${row.activities[0]?.id ?? index}`}
                        toolName={row.toolName}
                        activities={row.activities}
                        animateTailText={row.activities.some((activity) => animatedToolIds?.has(activity.id))}
                        animateRows={animateRows}
                    />
                );

            case 'tool-activity-group':
                return (
                    <GroupedToolActivityRow
                        key={`tool-group-${row.groupInfo.key}-${row.activities[0]?.id ?? index}`}
                        groupInfo={row.groupInfo}
                        activities={row.activities}
                        syntaxTheme={syntaxTheme}
                        isMobile={isMobile}
                        expandedTools={expandedTools}
                        onToggleTool={onToggleTool}
                        onShowPopup={onShowPopup}
                        onContentChange={onContentChange}
                        animateTailText={row.activities.some((activity) => animatedToolIds?.has(activity.id))}
                        animateRows={animateRows}
                    />
                );

            case 'tool-fallback':
                return (
                    <MemoExpandableToolRow
                        key={row.activity.id}
                        activity={row.activity}
                        isExpanded={expandedTools.has(row.activity.id)}
                        syntaxTheme={syntaxTheme}
                        isMobile={isMobile}
                        onToggleTool={onToggleTool}
                        onShowPopup={onShowPopup}
                        onContentChange={onContentChange}
                        animateTailText={Boolean(animatedToolIds?.has(row.activity.id))}
                        animateRows={animateRows}
                    />
                );

            default:
                return null;
        }
    })
        : null;

    const shouldShowRowsContainer = isExpanded || visibleRows.length > 0;

    if (!showHeader) {
        return (
            <FadeInOnReveal>
                <div className="space-y-1.5">{renderedRows}</div>
            </FadeInOnReveal>
        );
    }

    return (
        <FadeInOnReveal>
            <div>
                <button
                    type="button"
                    className="group/tool flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 pr-2 pl-px py-1.5 rounded-xl text-left"
                    onClick={onToggle}
                >
                    <span className="inline-flex h-5 items-center flex-shrink-0" style={{ color: 'var(--tools-icon)' }}>
                        <RiStackLine className="h-3.5 w-3.5" />
                    </span>
                    <span
                        className="typography-meta leading-5 font-semibold inline-flex h-5 items-center flex-shrink-0"
                        style={{
                            color: 'var(--tools-title)',
                            letterSpacing: '0.005em',
                        }}
                    >
                        Activity
                    </span>
                </button>
                {shouldShowRowsContainer ? (
                    <div className="relative ml-2 pl-3">
                        <span
                            aria-hidden="true"
                            className="pointer-events-none absolute left-0 top-px bottom-0 w-px"
                            style={{ backgroundColor: 'var(--tools-border)' }}
                        />
                        {previewHiddenCount > 0 ? (
                            <button
                                type="button"
                                onClick={onToggle}
                                className="typography-meta leading-5 px-2 py-1 text-muted-foreground/45 hover:text-muted-foreground/65 text-left"
                            >
                                +{previewHiddenCount} More...
                            </button>
                        ) : null}
                        <div className="space-y-1.5">{renderedRows}</div>
                    </div>
                ) : null}
            </div>
        </FadeInOnReveal>
    );
};

export default React.memo(ProgressiveGroup);
