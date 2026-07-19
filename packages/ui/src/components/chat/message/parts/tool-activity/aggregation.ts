import type { ToolPart } from '@opencode-ai/sdk/v2';
import {
    getToolActivityGroupInfo,
    isHiddenTool,
    isPassiveRollupGroupKind,
    isToolActivityGroupingBoundary,
    type ToolActivityAggregation,
    type ToolActivityGroupInfo,
    type ToolActivityGroupKind,
} from './classification';
import {
    extractEditedFilePathsFromToolPart,
    extractFetchedUrlsFromToolPart,
    extractPatchFileSummariesFromToolPart,
    extractReadFilePathsFromToolPart,
    extractSearchedFilePathsFromToolPart,
    normalizePathCandidate,
} from './targets';

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null;
};

const getToolPartStateRecord = (part: ToolPart | undefined): Record<string, unknown> | undefined => {
    if (!part || !isRecord(part.state)) {
        return undefined;
    }
    return part.state;
};

const normalizeScalarKeyPart = (value: unknown): string => {
    if (typeof value === 'string') {
        return value.trim();
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return String(value);
    }
    if (typeof value === 'boolean') {
        return String(value);
    }
    return '';
};

const getReadRangeKey = (part: ToolPart | undefined): string => {
    const state = getToolPartStateRecord(part);
    const input = isRecord(state?.input) ? state.input : undefined;
    const metadata = isRecord(state?.metadata) ? state.metadata : undefined;
    const offset = normalizeScalarKeyPart(input?.offset ?? input?.line ?? metadata?.offset ?? metadata?.line);
    const limit = normalizeScalarKeyPart(input?.limit ?? metadata?.limit);
    return `${offset}:${limit}`;
};

const getToolPartStatusKey = (part: ToolPart | undefined): string => {
    const status = getToolPartStateRecord(part)?.status;
    return typeof status === 'string' ? status.trim().toLowerCase() : '';
};

const getDuplicateReadKey = <T>(item: T, getToolPart?: (item: T) => ToolPart | undefined): string => {
    const part = getToolPart?.(item);
    const paths = extractReadFilePathsFromToolPart(part)
        .map(normalizePathCandidate)
        .filter(Boolean)
        .sort();
    if (paths.length === 0) {
        return '';
    }

    // Decision: dedupe only identical read-file rows with the same path, range,
    // and status. Different offsets/limits or status transitions remain visible.
    return `${paths.join('\u0000')}|${getReadRangeKey(part)}|${getToolPartStatusKey(part)}`;
};

const dedupeDuplicateReadItems = <T>(items: readonly T[], getToolPart?: (item: T) => ToolPart | undefined): T[] => {
    if (!getToolPart || items.length < 2) {
        return [...items];
    }

    const seen = new Set<string>();
    const deduped: T[] = [];

    for (const item of items) {
        const duplicateKey = getDuplicateReadKey(item, getToolPart);
        if (duplicateKey && seen.has(duplicateKey)) {
            continue;
        }
        if (duplicateKey) {
            seen.add(duplicateKey);
        }
        deduped.push(item);
    }

    return deduped;
};

const normalizeToolActivityGroupItems = <T>(
    groupInfo: ToolActivityGroupInfo,
    items: readonly T[],
    getToolPart?: (item: T) => ToolPart | undefined,
): T[] => {
    if (groupInfo.kind === 'read') {
        return dedupeDuplicateReadItems(items, getToolPart);
    }

    return [...items];
};

const collectPatchCoveredPaths = <T>(
    items: readonly T[],
    getToolPart?: (item: T) => ToolPart | undefined,
): string[] => {
    if (!getToolPart) {
        return [];
    }

    const seen = new Set<string>();
    const paths: string[] = [];
    for (const item of items) {
        const summaries = extractPatchFileSummariesFromToolPart(getToolPart(item));
        for (const summary of summaries) {
            const normalized = normalizePathCandidate(summary.path);
            if (!normalized || normalized.toLowerCase() === 'patch' || seen.has(normalized)) {
                continue;
            }
            seen.add(normalized);
            paths.push(normalized);
        }
    }
    return paths;
};

const doPathsReferToSameFile = (left: string, right: string): boolean => {
    const normalizedLeft = normalizePathCandidate(left);
    const normalizedRight = normalizePathCandidate(right);
    if (!normalizedLeft || !normalizedRight) {
        return false;
    }
    return normalizedLeft === normalizedRight
        || normalizedLeft.endsWith(`/${normalizedRight}`)
        || normalizedRight.endsWith(`/${normalizedLeft}`);
};

const isEditGroupCoveredByPatch = <T>(
    groupInfo: ToolActivityGroupInfo,
    items: readonly T[],
    patchCoveredPaths: readonly string[],
    getToolPart?: (item: T) => ToolPart | undefined,
): boolean => {
    if (groupInfo.kind !== 'edit' || !getToolPart || patchCoveredPaths.length === 0) {
        return false;
    }

    const editedPaths = items
        .flatMap((item) => extractEditedFilePathsFromToolPart(getToolPart(item)))
        .map(normalizePathCandidate)
        .filter(Boolean);
    if (editedPaths.length === 0) {
        return false;
    }

    return editedPaths.every((editedPath) => {
        return patchCoveredPaths.some((patchPath) => doPathsReferToSameFile(editedPath, patchPath));
    });
};

export const getToolActivityGroupSummaryCount = <T>(
    kind: ToolActivityGroupKind,
    items: readonly T[],
    getToolPart?: (item: T) => ToolPart | undefined,
): number => {
    if (kind === 'shell') {
        return Math.max(1, items.length);
    }

    if (!getToolPart) {
        return Math.max(1, items.length);
    }

    const unique = new Set<string>();
    const addPathValues = (values: readonly string[]) => {
        values.forEach((value) => {
            const normalized = normalizePathCandidate(value);
            if (normalized) unique.add(normalized);
        });
    };
    const addExactValues = (values: readonly string[]) => {
        values.forEach((value) => {
            const normalized = typeof value === 'string' ? value.trim() : '';
            if (normalized) unique.add(normalized);
        });
    };

    for (const item of items) {
        const part = getToolPart(item);
        if (kind === 'patch') {
            const summaries = extractPatchFileSummariesFromToolPart(part);
            summaries.forEach((summary) => {
                const normalized = normalizePathCandidate(summary.path);
                if (normalized) unique.add(normalized);
            });
            continue;
        }
        if (kind === 'edit') {
            addPathValues(extractEditedFilePathsFromToolPart(part));
            continue;
        }
        if (kind === 'search') {
            addPathValues(extractSearchedFilePathsFromToolPart(part));
            continue;
        }
        if (kind === 'read') {
            addPathValues(extractReadFilePathsFromToolPart(part));
            continue;
        }
        if (kind === 'fetch') {
            addExactValues(extractFetchedUrlsFromToolPart(part));
        }
    }

    if (unique.size > 0) {
        return unique.size;
    }

    return Math.max(1, items.length);
};

export const shouldCollapseToolActivityGroup = <T>(
    groupInfo: ToolActivityGroupInfo,
    items: readonly T[],
    getToolPart?: (item: T) => ToolPart | undefined,
): boolean => {
    if (items.length > 1) {
        return true;
    }
    if (groupInfo.kind === 'search'
        || groupInfo.kind === 'read'
        || groupInfo.kind === 'fetch'
        || groupInfo.kind === 'edit'
        || groupInfo.kind === 'patch'
        || groupInfo.kind === 'shell') {
        return getToolActivityGroupSummaryCount(groupInfo.kind, items, getToolPart) > 0;
    }
    return false;
};

export const collectToolActivityBurst = <T>(
    items: readonly T[],
    startIndex: number,
    getToolName: (item: T) => unknown,
    options?: {
        getToolPart?: (item: T) => ToolPart | undefined;
        isBoundary?: (item: T) => boolean;
    },
): { rows: ToolActivityAggregation<T>[]; endIndex: number } | null => {
    const firstItem = items[startIndex];
    if (firstItem === undefined || options?.isBoundary?.(firstItem)) {
        return null;
    }

    const firstInfo = getToolActivityGroupInfo(getToolName(firstItem), options?.getToolPart?.(firstItem));
    if (!firstInfo) {
        return null;
    }

    const orderedKeys: string[] = [];
    const groups = new Map<string, { groupInfo: ToolActivityGroupInfo; items: T[] }>();
    let index = startIndex;

    while (index < items.length) {
        const item = items[index];
        if (item === undefined || options?.isBoundary?.(item)) {
            break;
        }

        const toolName = getToolName(item);
        if (isHiddenTool(toolName)) {
            index += 1;
            continue;
        }

        if (isToolActivityGroupingBoundary(toolName)) {
            break;
        }

        const info = getToolActivityGroupInfo(toolName, options?.getToolPart?.(item));
        if (!info) {
            break;
        }

        const group = groups.get(info.key);
        if (group) {
            group.items.push(item);
        } else {
            orderedKeys.push(info.key);
            groups.set(info.key, { groupInfo: info, items: [item] });
        }
        index += 1;
    }

    const burstItems = items.slice(startIndex, index);
    const patchCoveredPaths = collectPatchCoveredPaths(burstItems, options?.getToolPart);
    const rows: ToolActivityAggregation<T>[] = [];
    for (const key of orderedKeys) {
        const group = groups.get(key);
        if (!group) {
            continue;
        }

        const normalizedItems = normalizeToolActivityGroupItems(group.groupInfo, group.items, options?.getToolPart);
        if (isEditGroupCoveredByPatch(group.groupInfo, normalizedItems, patchCoveredPaths, options?.getToolPart)) {
            continue;
        }
        if (shouldCollapseToolActivityGroup(group.groupInfo, normalizedItems, options?.getToolPart)) {
            rows.push({ type: 'group', groupInfo: group.groupInfo, items: normalizedItems });
            continue;
        }

        normalizedItems.forEach((item) => rows.push({ type: 'item', item }));
    }

    return rows.length > 0 ? { rows, endIndex: index } : null;
};

export const collectToolActivityRows = <T>(
    items: readonly T[],
    options: {
        getToolName: (item: T) => unknown;
        getToolPart?: (item: T) => ToolPart | undefined;
        isReasoningOrJustification?: (item: T) => boolean;
        isStandalone?: (item: T) => boolean;
    },
): ToolActivityAggregation<T>[] => {
    const rows: ToolActivityAggregation<T>[] = [];
    const passiveRollups = new Map<string, { groupInfo: ToolActivityGroupInfo; items: T[] }>();
    const burstGroups = new Map<string, { groupInfo: ToolActivityGroupInfo; items: T[] }>();
    const patchCoveredPaths = collectPatchCoveredPaths(items, options.getToolPart);

    const closeBurstGroups = () => {
        burstGroups.clear();
    };

    const pushItem = (item: T) => {
        rows.push({ type: 'item', item });
    };

    const appendToGroup = (groupInfo: ToolActivityGroupInfo, item: T, groups: Map<string, { groupInfo: ToolActivityGroupInfo; items: T[] }>) => {
        const existing = groups.get(groupInfo.key);
        if (existing) {
            existing.items.push(item);
            return;
        }

        const group = { groupInfo, items: [item] };
        groups.set(groupInfo.key, group);
            rows.push({ type: 'group', groupInfo, items: group.items });
    };

    for (const item of items) {
        if (options.isReasoningOrJustification?.(item)) {
            closeBurstGroups();
            pushItem(item);
            continue;
        }

        const toolName = options.getToolName(item);
        if (isHiddenTool(toolName)) {
            continue;
        }

        const isStandalone = options.isStandalone?.(item) === true;
        if (isToolActivityGroupingBoundary(toolName) || isStandalone) {
            closeBurstGroups();
            if (!isStandalone) {
                pushItem(item);
            }
            continue;
        }

        const groupInfo = getToolActivityGroupInfo(toolName, options.getToolPart?.(item));
        if (!groupInfo) {
            closeBurstGroups();
            pushItem(item);
            continue;
        }

        if (isPassiveRollupGroupKind(groupInfo.kind)) {
            appendToGroup(groupInfo, item, passiveRollups);
            continue;
        }

        appendToGroup(groupInfo, item, burstGroups);
    }

    return rows.flatMap((row): ToolActivityAggregation<T>[] => {
        if (row.type === 'item') {
            return [row];
        }

        const normalizedItems = normalizeToolActivityGroupItems(row.groupInfo, row.items, options.getToolPart);
        if (isEditGroupCoveredByPatch(row.groupInfo, normalizedItems, patchCoveredPaths, options.getToolPart)) {
            return [];
        }
        if (shouldCollapseToolActivityGroup(row.groupInfo, normalizedItems, options.getToolPart)) {
            return [{ type: 'group', groupInfo: row.groupInfo, items: normalizedItems }];
        }

        return normalizedItems.map((item) => ({ type: 'item', item }));
    });
};

export const collectCrossMessageFileActivityGroups = <T>(
    items: readonly T[],
    options: {
        getToolName: (item: T) => unknown;
        getToolPart?: (item: T) => ToolPart | undefined;
        getMessageId: (item: T) => string;
        isReasoningOrJustification?: (item: T) => boolean;
        isStandalone?: (item: T) => boolean;
    },
): Array<{ groupInfo: ToolActivityGroupInfo; items: T[] }> => {
    return collectToolActivityRows(items, options).flatMap((row) => {
        if (row.type !== 'group' || (row.groupInfo.kind !== 'edit' && row.groupInfo.kind !== 'read')) {
            return [];
        }

        const messageIds = new Set(row.items.map(options.getMessageId));
        if (messageIds.size < 2) {
            return [];
        }

        return [{ groupInfo: row.groupInfo, items: row.items }];
    });
};

export const collectToolActivityRowsFromToolParts = (
    parts: readonly ToolPart[],
): ToolActivityAggregation<ToolPart>[] => {
    return collectToolActivityRows(parts, {
        getToolName: (part) => part.tool,
        getToolPart: (part) => part,
    });
};

export const collectConsecutiveToolActivityGroup = <T>(
    items: readonly T[],
    startIndex: number,
    getToolName: (item: T) => unknown,
    getToolPart?: (item: T) => ToolPart | undefined,
): { groupInfo: ToolActivityGroupInfo; items: T[]; endIndex: number } | null => {
    const firstItem = items[startIndex];
    const firstInfo = firstItem === undefined
        ? null
        : getToolActivityGroupInfo(getToolName(firstItem), getToolPart?.(firstItem));
    if (!firstInfo) {
        return null;
    }

    const grouped: T[] = [];
    let index = startIndex;
    while (index < items.length) {
        const item = items[index];
        const info = getToolActivityGroupInfo(getToolName(item), getToolPart?.(item));
        if (!info || info.key !== firstInfo.key) {
            break;
        }
        grouped.push(item);
        index += 1;
    }

    if (grouped.length < 2) {
        return null;
    }

    return {
        groupInfo: firstInfo,
        items: grouped,
        endIndex: index,
    };
};
