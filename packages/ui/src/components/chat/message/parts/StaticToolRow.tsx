import React from 'react';
import type { ToolPart as ToolPartType } from '@opencode-ai/sdk/v2';
import type { TurnActivityRecord as TurnActivityPart } from '../../lib/turns/types';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Text } from '@/components/ui/text';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { getToolMetadata } from '@/lib/toolHelpers';
import { cn } from '@/lib/utils';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useUIStore } from '@/stores/useUIStore';
import { MinDurationShineText } from './MinDurationShineText';
import { getToolIcon } from './toolPresentation';
import {
    getContextDirectoryForPath,
    getRelativePathFromDirectory,
    renderReadFilePath,
    resolveAbsolutePath,
} from './activityPathUtils';
import { areActivityListsEqual, getToolReadOffset } from './activityRowUtils';
import { isActivityRunning } from './activityTools';
import { normalizeToolName } from './toolRenderUtils';
import { buildTodoSummary, formatCompactTodoTotal } from '../../lib/todoSummary';

const getFirstToolPath = (...records: Array<Record<string, unknown> | undefined>): string | null => {
    for (const record of records) {
        const value = [
            record?.filePath,
            record?.file_path,
            record?.targetFile,
            record?.target_file,
            record?.relativePath,
            record?.movePath,
            record?.path,
            record?.file,
            record?.filename,
        ].find((candidate) => typeof candidate === 'string' && candidate.trim().length > 0);
        if (typeof value === 'string' && value.trim().length > 0) {
            return value;
        }
    }
    return null;
};

const getToolFileName = (activity: TurnActivityPart): string | null => {
    const part = activity.part as ToolPartType;
    const state = part.state as { input?: Record<string, unknown>; metadata?: Record<string, unknown> } | undefined;
    const input = state?.input;
    const metadata = state?.metadata;

    const filePath = getFirstToolPath(input, metadata);

    if (typeof filePath === 'string' && filePath.trim().length > 0) {
        const lastSlash = filePath.lastIndexOf('/');
        return lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
    }

    return null;
};

const getToolFilePath = (activity: TurnActivityPart): string | null => {
    const part = activity.part as ToolPartType;
    const state = part.state as { input?: Record<string, unknown>; metadata?: Record<string, unknown> } | undefined;
    const input = state?.input;
    const metadata = state?.metadata;

    const filePath = getFirstToolPath(input, metadata);

    return typeof filePath === 'string' && filePath.trim().length > 0 ? filePath : null;
};

const formatTodoSummary = (todos: unknown[]): string | null => {
    return formatCompactTodoTotal(buildTodoSummary(todos).total);
};

const getTodoSummaryFromActivity = (activity: TurnActivityPart): string | null => {
    const part = activity.part as ToolPartType;
    const state = part.state as { input?: Record<string, unknown>; output?: unknown } | undefined;
    const input = state?.input;
    const output = state?.output;

    if (Array.isArray(input?.todos)) {
        const summary = formatTodoSummary(input.todos);
        if (summary) return summary;
    }

    if (Array.isArray(output)) {
        const summary = formatTodoSummary(output);
        if (summary) return summary;
    }

    if (output && typeof output === 'object' && Array.isArray((output as { todos?: unknown }).todos)) {
        const summary = formatTodoSummary((output as { todos: unknown[] }).todos);
        if (summary) return summary;
    }

    if (typeof output === 'string' && output.trim().length > 0) {
        try {
            const parsed = JSON.parse(output) as unknown;
            if (Array.isArray(parsed)) {
                const summary = formatTodoSummary(parsed);
                if (summary) return summary;
            }
            if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { todos?: unknown }).todos)) {
                const summary = formatTodoSummary((parsed as { todos: unknown[] }).todos);
                if (summary) return summary;
            }
        } catch {
            // Ignore non-JSON output.
        }
    }

    return null;
};

const getToolShortDescription = (activity: TurnActivityPart): string | null => {
    const part = activity.part as ToolPartType;
    const toolName = normalizeToolName(part.tool);
    const state = part.state as { input?: Record<string, unknown>; metadata?: Record<string, unknown> } | undefined;
    const input = state?.input;
    const metadata = state?.metadata;

    if (toolName === 'grep' || toolName === 'search' || toolName === 'find' || toolName === 'ripgrep') {
        const pattern = input?.pattern;
        if (typeof pattern === 'string' && pattern.trim().length > 0) {
            return pattern.length > 40 ? pattern.slice(0, 40) + '...' : pattern;
        }
    }

    if (toolName === 'glob') {
        const pattern = input?.pattern;
        if (typeof pattern === 'string' && pattern.trim().length > 0) {
            return pattern.length > 40 ? pattern.slice(0, 40) + '...' : pattern;
        }
    }

    if (toolName === 'websearch' || toolName === 'web-search' || toolName === 'search_web' || toolName === 'codesearch' || toolName === 'perplexity') {
        const query = input?.query;
        if (typeof query === 'string' && query.trim().length > 0) {
            return query.length > 50 ? query.slice(0, 50) + '...' : query;
        }
    }

    if (toolName === 'skill') {
        const name = input?.name;
        if (typeof name === 'string' && name.trim().length > 0) {
            return name;
        }
    }

    if (toolName === 'webfetch' || toolName === 'fetch' || toolName === 'curl' || toolName === 'wget') {
        const url =
            (typeof input?.url === 'string' && input.url) ||
            (typeof input?.URL === 'string' && input.URL) ||
            (typeof metadata?.url === 'string' && metadata.url) ||
            (typeof metadata?.URL === 'string' && metadata.URL) ||
            '';

        if (typeof url === 'string' && url.trim().length > 0) {
            return url.trim();
        }
    }

    if (toolName === 'todowrite' || toolName === 'todoread') {
        return getTodoSummaryFromActivity(activity);
    }

    return getToolFileName(activity);
};

const StaticToolRowInner: React.FC<{
    toolName: string;
    activities: TurnActivityPart[];
    animateTailText: boolean;
}> = ({ toolName, activities, animateTailText }) => {
    const showToolFileIcons = useUIStore((state) => state.showToolFileIcons);
    const displayName = getToolMetadata(toolName).displayName;
    const icon = getToolIcon(toolName);
    const isReadGroup = toolName.toLowerCase() === 'read';
    const runtime = React.useContext(RuntimeAPIContext);
    const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
    const hasRunningActivity = React.useMemo(() => activities.some((activity) => isActivityRunning(activity)), [activities]);

    const descriptions = React.useMemo(() => {
        const descs: string[] = [];
        for (const activity of activities) {
            const desc = getToolShortDescription(activity);
            if (desc && !descs.includes(desc)) {
                descs.push(desc);
            }
        }
        return descs;
    }, [activities]);

    const readFileEntries = React.useMemo(() => {
        if (!isReadGroup) return [] as Array<{ path: string; displayPath: string; offset?: number }>;

        const entries: Array<{ path: string; displayPath: string; offset?: number }> = [];
        for (const activity of activities) {
            const filePath = getToolFilePath(activity);
            const offset = getToolReadOffset(activity);
            if (!filePath) continue;
            if (entries.some((entry) => entry.path === filePath)) continue;
            const displayPath = getRelativePathFromDirectory(filePath, currentDirectory);
            if (!displayPath) continue;
            entries.push({ path: filePath, displayPath, offset });
        }
        return entries;
    }, [activities, currentDirectory, isReadGroup]);

    const handleReadFileClick = React.useCallback((filePath: string, offset?: number) => {
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

    const normalizedToolName = normalizeToolName(toolName);
    const isSearchGroup = normalizedToolName === 'grep'
        || normalizedToolName === 'search'
        || normalizedToolName === 'find'
        || normalizedToolName === 'ripgrep'
        || normalizedToolName === 'glob';
    const isFetchGroup = normalizedToolName === 'webfetch' || normalizedToolName === 'fetch' || normalizedToolName === 'curl' || normalizedToolName === 'wget';
    return (
        <div className="w-full min-w-0">
          <div className={cn('flex w-full items-center gap-x-1.5 pr-2 pl-px py-1.5 rounded-xl min-w-0')}>
            <div className="inline-flex h-5 items-center flex-shrink-0" style={{ color: 'var(--tools-icon)' }}>
                {icon}
            </div>
            <MinDurationShineText
                active={hasRunningActivity}
                minDurationMs={1000}
                className="typography-meta leading-5 font-medium inline-flex h-5 items-center flex-shrink-0 opacity-85"
                style={{ color: 'var(--tools-title)' }}
                title={displayName}
            >
                {displayName}
            </MinDurationShineText>
            {isReadGroup && readFileEntries.length > 0
                ? readFileEntries.map((entry) => (
                    <button
                        key={entry.path}
                        type="button"
                        onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            handleReadFileClick(entry.path, entry.offset);
                        }}
                        className="inline-flex items-center justify-start gap-1 min-w-0 flex-1 text-left typography-meta leading-5 hover:opacity-90"
                        style={{ color: 'var(--tools-description)' }}
                        title={entry.offset ? `${entry.displayPath}:${entry.offset}` : entry.displayPath}
                    >
                        {showToolFileIcons ? <FileTypeIcon filePath={entry.path} className="h-3.5 w-3.5" /> : null}
                        {renderReadFilePath(entry.displayPath)}
                    </button>
                ))
                : null}
            {isSearchGroup && descriptions.length > 0
                ? descriptions.map((desc, index) => (
                    <span key={`${desc}-${index}`} className="inline-flex min-w-0 flex-1">
                        <Text
                            variant={animateTailText ? 'generate-effect' : 'static'}
                            className="min-w-0 flex-1 truncate whitespace-nowrap typography-meta leading-5"
                            style={{ color: 'var(--tools-description)' }}
                            title={desc}
                        >
                            "{desc}"
                        </Text>
                    </span>
                ))
                : null}
            {isFetchGroup && descriptions.length > 0
                ? descriptions.map((url, index) => (
                    <a
                        key={`${url}-${index}`}
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={cn(
                            'min-w-0 flex-1 underline decoration-[color:var(--status-info)] underline-offset-2 hover:opacity-90',
                            'truncate whitespace-nowrap typography-meta'
                        )}
                        style={{ color: 'var(--status-info)' }}
                        title={url}
                    >
                        {url}
                    </a>
                ))
                : null}
            {!isReadGroup && !isSearchGroup && !isFetchGroup && descriptions.length > 0 ? (
                <Text
                    variant={animateTailText ? 'generate-effect' : 'static'}
                    className="min-w-0 flex-1 truncate whitespace-nowrap typography-meta leading-5"
                    style={{ color: 'var(--tools-description)' }}
                >
                    {descriptions.join(' ')}
                </Text>
            ) : null}
          </div>
        </div>
    );
};

export const StaticToolRow = React.memo(StaticToolRowInner, (prev, next) => {
    return prev.toolName === next.toolName
        && prev.animateTailText === next.animateTailText
        && areActivityListsEqual(prev.activities, next.activities);
});
