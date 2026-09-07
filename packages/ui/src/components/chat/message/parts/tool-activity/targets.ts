import { getPatchText, isToolDiffPreviewOversized } from '../toolDiffPreview';
import type { ToolPart } from '@opencode-ai/sdk/v2';
import {
    isEditToolName,
    isFetchToolName,
    isPatchToolName,
    isReadToolName,
    isSearchToolName,
} from './classification';

interface ToolPartStateWithData {
    input?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    output?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null;
};

const getToolPartState = (part: ToolPart | undefined): ToolPartStateWithData | undefined => {
    if (!part || (!isRecord(part.state) && !isRecord((part as { input?: unknown }).input) && !isRecord((part as { metadata?: unknown }).metadata) && !Object.prototype.hasOwnProperty.call(part, 'output'))) {
        return undefined;
    }

    const state = isRecord(part.state) ? part.state as ToolPartStateWithData : {};
    const partRecord = part as { input?: unknown; metadata?: unknown; output?: unknown };
    return {
        ...state,
        input: isRecord(state.input)
            ? state.input
            : isRecord(partRecord.input)
                ? partRecord.input
                : state.input,
        metadata: isRecord(state.metadata)
            ? state.metadata
            : isRecord(partRecord.metadata)
                ? partRecord.metadata
                : state.metadata,
        output: Object.prototype.hasOwnProperty.call(state, 'output') ? state.output : partRecord.output,
    };
};

const getToolPartOutputString = (part: ToolPart | undefined): string => {
    const output = getToolPartState(part)?.output;
    return typeof output === 'string' ? output.trim() : '';
};

export interface PatchFileSummary {
    path: string;
    additions?: number;
    deletions?: number;
    patch?: string;
    partId?: string;
    messageID?: string;
}

export interface ToolPartDiffStats {
    additions: number;
    deletions: number;
}

export const normalizePathCandidate = (value: unknown): string => {
    if (typeof value !== 'string') {
        return '';
    }
    const normalized = value.trim()
        .replace(/^['"]|['"]$/g, '')
        .replace(/\\/g, '/')
        .replace(/\/{2,}/g, '/')
        .replace(/^\.\//, '');
    return normalized === '/' ? normalized : normalized.replace(/\/+$/, '');
};

const appendUnique = (values: string[], value: string) => {
    const normalized = normalizePathCandidate(value);
    if (!normalized || values.includes(normalized)) {
        return;
    }
    values.push(normalized);
};

const appendUniqueStringPath = (values: string[], value: unknown) => {
    if (typeof value !== 'string') {
        return;
    }
    appendUnique(values, value);
};

const appendFirstStringPath = (values: string[], ...candidates: unknown[]) => {
    for (const candidate of candidates) {
        if (typeof candidate !== 'string' || !candidate.trim()) {
            continue;
        }
        appendUnique(values, candidate);
        return;
    }
};

const getFirstPathCandidate = (record: Record<string, unknown> | undefined): unknown => {
    const candidates = [
        record?.filePath,
        record?.file_path,
        record?.targetFile,
        record?.target_file,
        record?.relativePath,
        record?.movePath,
        record?.path,
        record?.file,
        record?.filename,
    ];
    return candidates.find((candidate) => typeof candidate === 'string' && candidate.trim().length > 0);
};

const parseCount = (value: unknown): number | undefined => {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.max(0, Math.trunc(value));
    }
    if (typeof value === 'string') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : undefined;
    }
    return undefined;
};

const getPatchTextFromRecord = (record: Record<string, unknown> | undefined): string | undefined => {
    if (!record) {
        return undefined;
    }
    return getPatchText(record.patch)
        ?? getPatchText(record.patchText)
        ?? getPatchText(record.diff)
        ?? getPatchText(record.changes);
};

const parsePatchStats = (patch: string): { additions: number; deletions: number } | undefined => {
    if (isToolDiffPreviewOversized(patch)) return undefined;
    let additions = 0;
    let deletions = 0;
    for (const line of patch.trim().split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
        if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
    }
    return { additions, deletions };
};

const normalizeDiffPath = (value: string | undefined): string => {
    if (!value) {
        return '';
    }
    const first = value.trim().split(/\s+/)[0] ?? '';
    if (!first || first === '/dev/null') {
        return '';
    }
    return first.replace(/^(?:a|b)\//, '');
};

const parsePatchFileSummaries = (patch: string): Array<{ path: string; additions: number; deletions: number; patch: string }> => {
    if (isToolDiffPreviewOversized(patch)) return [];
    const lines = patch.trim().split('\n');
    const summaries: Array<{ path: string; additions: number; deletions: number; patch: string }> = [];
    let current: { oldPath: string; newPath: string; additions: number; deletions: number; lines: string[] } | null = null;

    const flush = () => {
        if (!current) {
            return;
        }
        const path = normalizePathCandidate(current.newPath || current.oldPath);
        if (path) {
            summaries.push({
                path,
                additions: current.additions,
                deletions: current.deletions,
                patch: current.lines.join('\n').trim(),
            });
        }
        current = null;
    };

    for (const line of lines) {
        const diffMatch = line.match(/^diff --git\s+(?:a\/)?(.+?)\s+(?:b\/)?(.+)$/);
        if (diffMatch) {
            flush();
            current = {
                oldPath: normalizeDiffPath(diffMatch[1]),
                newPath: normalizeDiffPath(diffMatch[2]),
                additions: 0,
                deletions: 0,
                lines: [line],
            };
            continue;
        }

        if (line.startsWith('--- ')) {
            if (!current) {
                current = { oldPath: '', newPath: '', additions: 0, deletions: 0, lines: [] };
            }
            current.oldPath = normalizeDiffPath(line.slice(4));
            current.lines.push(line);
            continue;
        }

        if (line.startsWith('+++ ')) {
            if (!current) {
                current = { oldPath: '', newPath: '', additions: 0, deletions: 0, lines: [] };
            }
            current.newPath = normalizeDiffPath(line.slice(4));
            current.lines.push(line);
            continue;
        }

        if (current) {
            current.lines.push(line);
            if (line.startsWith('+') && !line.startsWith('+++')) {
                current.additions += 1;
            } else if (line.startsWith('-') && !line.startsWith('---')) {
                current.deletions += 1;
            }
        }
    }

    flush();
    return summaries;
};

const mergePatchText = (current: string | undefined, incoming: string | undefined): string | undefined => {
    if (!incoming) {
        return current;
    }
    if (!current) {
        return incoming;
    }
    if (current.includes(incoming)) {
        return current;
    }
    return `${current.trimEnd()}\n\n${incoming.trimStart()}`;
};

const isSearchSnippetLine = (line: string): boolean => {
    return /^line\s+\d+(?:-\d+)?\s*:/i.test(line);
};

const hasCodeLikeSyntax = (candidate: string): boolean => {
    return /['"`;{}]/.test(candidate)
        || /\s(?:===|!==|==|!=|=>|=)\s/.test(candidate)
        || /^\s*(?:import|export|const|let|var|return|if|for|while|function|class|type|interface)\b/.test(candidate);
};

const looksLikeFilePath = (candidate: string, options: { allowCodeSyntax?: boolean } = {}): boolean => {
    if (!candidate || candidate.startsWith('<') || candidate.startsWith('(')) {
        return false;
    }
    if (!options.allowCodeSyntax && hasCodeLikeSyntax(candidate)) {
        return false;
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
        return false;
    }
    const lower = candidate.toLowerCase();
    if (lower.startsWith('found ') || lower.startsWith('no files') || lower.startsWith('no matches')) {
        return false;
    }
    const fileName = candidate.split('/').pop() ?? candidate;
    const hasExtension = /\.[a-z0-9][a-z0-9_-]*$/i.test(fileName);
    return candidate.includes('/') || (candidate.startsWith('.') && candidate.length > 1) || hasExtension;
};

const extractSearchPathFromLine = (line: string): string => {
    if (isSearchSnippetLine(line)) {
        return '';
    }

    const grepMatch = line.match(/^(.+?):(\d+)(?::\d+)?(?::|$)/);
    if (grepMatch?.[1] && looksLikeFilePath(grepMatch[1], { allowCodeSyntax: true })) {
        return grepMatch[1];
    }

    const fileHeaderMatch = line.match(/^(.+):$/);
    if (fileHeaderMatch?.[1] && looksLikeFilePath(fileHeaderMatch[1], { allowCodeSyntax: true })) {
        return fileHeaderMatch[1];
    }

    const colonMatch = line.match(/^(.+?):\s+.+$/);
    if (colonMatch?.[1] && looksLikeFilePath(colonMatch[1], { allowCodeSyntax: true })) {
        return colonMatch[1];
    }

    return looksLikeFilePath(line) ? line : '';
};

export const extractReadFilePathsFromToolPart = (part: ToolPart | undefined): string[] => {
    if (!isReadToolName(part?.tool)) {
        return [];
    }
    const state = getToolPartState(part);
    const input = state?.input;
    const metadata = state?.metadata;
    const path = input?.filePath
        ?? input?.file_path
        ?? input?.targetFile
        ?? input?.target_file
        ?? input?.path
        ?? input?.file
        ?? input?.filename
        ?? metadata?.filePath
        ?? metadata?.file_path
        ?? metadata?.targetFile
        ?? metadata?.target_file
        ?? metadata?.path
        ?? metadata?.file
        ?? metadata?.filename;
    const normalized = normalizePathCandidate(path);
    return normalized ? [normalized] : [];
};

export const extractEditedFilePathsFromToolPart = (part: ToolPart | undefined): string[] => {
    if (!isEditToolName(part?.tool)) {
        return [];
    }

    const state = getToolPartState(part);
    const input = state?.input;
    const metadata = state?.metadata;
    const paths: string[] = [];

    appendFirstStringPath(paths, getFirstPathCandidate(input));
    appendFirstStringPath(paths, getFirstPathCandidate(metadata));

    const files = Array.isArray(metadata?.files) ? metadata.files : [];
    for (const file of files) {
        if (!isRecord(file)) {
            continue;
        }
        appendFirstStringPath(paths, getFirstPathCandidate(file));
    }

    return paths;
};

export const extractFetchedUrlsFromToolPart = (part: ToolPart | undefined): string[] => {
    if (!isFetchToolName(part?.tool)) {
        return [];
    }
    const state = getToolPartState(part);
    const input = state?.input;
    const metadata = state?.metadata;
    const url = input?.url
        ?? input?.URL
        ?? metadata?.url
        ?? metadata?.URL;
    return typeof url === 'string' && url.trim().length > 0 ? [url.trim()] : [];
};

export const extractSearchedFilePathsFromToolPart = (part: ToolPart | undefined): string[] => {
    if (!isSearchToolName(part?.tool)) {
        return [];
    }

    const output = getToolPartOutputString(part);
    if (!output) {
        return [];
    }

    const paths: string[] = [];
    const lines = output
        .replace(/^<file>\s*\n?/i, '')
        .replace(/\n?<\/file>\s*$/i, '')
        .split('\n');

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
            continue;
        }

        appendUniqueStringPath(paths, extractSearchPathFromLine(line));
    }

    return paths;
};

export const extractPatchFileSummariesFromToolPart = (part: ToolPart | undefined): PatchFileSummary[] => {
    if (!isPatchToolName(part?.tool)) {
        return [];
    }

    const state = getToolPartState(part);
    const metadata = state?.metadata;
    const input = state?.input;
    const summaries: PatchFileSummary[] = [];
    const seen = new Set<string>();

    const addSummary = (path: unknown, additions?: unknown, deletions?: unknown, patchValue?: unknown) => {
        const normalizedPath = normalizePathCandidate(path);
        if (!normalizedPath || seen.has(normalizedPath)) {
            return;
        }
        seen.add(normalizedPath);
        const patch = getPatchText(patchValue);
        const parsed = patch ? parsePatchStats(patch) : undefined;
        summaries.push({
            path: normalizedPath,
            additions: parseCount(additions) ?? parsed?.additions,
            deletions: parseCount(deletions) ?? parsed?.deletions,
            patch,
            partId: part?.id,
            messageID: part?.messageID,
        });
    };

    const files = Array.isArray(metadata?.files) ? metadata.files : [];
    for (const file of files) {
        if (!isRecord(file)) {
            continue;
        }
        const fileRecord = file;
        addSummary(
            getFirstPathCandidate(fileRecord),
            file.additions,
            file.deletions,
            getPatchTextFromRecord(fileRecord),
        );
    }

    if (summaries.length === 0 && isRecord(metadata?.filediff)) {
        const fileDiff = metadata.filediff;
        addSummary(getFirstPathCandidate(fileDiff), fileDiff.additions, fileDiff.deletions, getPatchTextFromRecord(fileDiff));
    }

    if (summaries.length === 0 && Array.isArray(metadata?.results)) {
        for (const result of metadata.results) {
            if (!isRecord(result) || !isRecord(result.filediff)) {
                continue;
            }
            const fileDiff = result.filediff;
            addSummary(getFirstPathCandidate(fileDiff), fileDiff.additions, fileDiff.deletions, getPatchTextFromRecord(fileDiff));
        }
    }

    if (summaries.length === 0) {
        const patch = getPatchTextFromRecord(metadata) ?? getPatchTextFromRecord(input);
        addSummary(getFirstPathCandidate(input) ?? getFirstPathCandidate(metadata), undefined, undefined, patch);
    }

    if (summaries.length === 0) {
        const patch = getPatchTextFromRecord(metadata) ?? getPatchTextFromRecord(input);
        if (patch) {
            parsePatchFileSummaries(patch).forEach((summary) => {
                addSummary(summary.path, summary.additions, summary.deletions, summary.patch);
            });
        }
    }

    if (summaries.length === 0) {
        const patch = getPatchTextFromRecord(metadata) ?? getPatchTextFromRecord(input);
        const parsed = patch ? parsePatchStats(patch) : undefined;
        summaries.push({
            path: 'Patch',
            additions: parsed?.additions,
            deletions: parsed?.deletions,
            patch,
            partId: part?.id,
            messageID: part?.messageID,
        });
    }

    return summaries;
};

export const mergePatchFileSummaries = (summaries: readonly PatchFileSummary[]): PatchFileSummary[] => {
    const mergedByPath = new Map<string, PatchFileSummary>();
    const order: string[] = [];

    for (const summary of summaries) {
        const normalizedPath = normalizePathCandidate(summary.path);
        if (!normalizedPath) {
            continue;
        }

        const existing = mergedByPath.get(normalizedPath);
        if (!existing) {
            order.push(normalizedPath);
            mergedByPath.set(normalizedPath, {
                ...summary,
                path: normalizedPath,
                additions: summary.additions,
                deletions: summary.deletions,
                patch: summary.patch,
            });
            continue;
        }

        mergedByPath.set(normalizedPath, {
            ...existing,
            additions: (existing.additions ?? 0) + (summary.additions ?? 0),
            deletions: (existing.deletions ?? 0) + (summary.deletions ?? 0),
            patch: mergePatchText(existing.patch, summary.patch),
        });
    }

    return order
        .map((path) => mergedByPath.get(path))
        .filter((summary): summary is PatchFileSummary => Boolean(summary));
};

export const mergePatchFileSummariesFromToolParts = (parts: readonly ToolPart[]): PatchFileSummary[] => {
    return mergePatchFileSummaries(parts.flatMap((part) => extractPatchFileSummariesFromToolPart(part)));
};

const getSummariesDiffStats = (summaries: readonly PatchFileSummary[]): ToolPartDiffStats | null => {
    let additions = 0;
    let deletions = 0;

    for (const summary of summaries) {
        additions += summary.additions ?? 0;
        deletions += summary.deletions ?? 0;
    }

    return additions === 0 && deletions === 0 ? null : { additions, deletions };
};

export const getToolPartDiffStatsFromToolPart = (part: ToolPart | undefined): ToolPartDiffStats | null => {
    if (isPatchToolName(part?.tool)) {
        const state = getToolPartState(part);
        const metadata = state?.metadata;
        const hasStructuredPatchAnchor = Array.isArray(metadata?.files)
            || isRecord(metadata?.filediff)
            || Array.isArray(metadata?.results)
            || Boolean(normalizePathCandidate(getFirstPathCandidate(state?.input)))
            || Boolean(normalizePathCandidate(getFirstPathCandidate(metadata)));
        if (!hasStructuredPatchAnchor) {
            return null;
        }
        // Decision: the anonymous `Patch` fallback has no file/input anchor and
        // can reflect failed or historical raw patch text. Tool badges should be
        // scoped to concrete file summaries only.
        return getSummariesDiffStats(extractPatchFileSummariesFromToolPart(part)
            .filter((summary) => normalizePathCandidate(summary.path) !== 'Patch'));
    }

    if (!isEditToolName(part?.tool)) {
        return null;
    }

    const state = getToolPartState(part);
    const metadata = state?.metadata;
    const files = Array.isArray(metadata?.files) ? metadata.files : [];
    const summaries: PatchFileSummary[] = [];

    for (const file of files) {
        if (!isRecord(file)) {
            continue;
        }
        const path = normalizePathCandidate(getFirstPathCandidate(file));
        if (!path) {
            continue;
        }
        const patch = getPatchTextFromRecord(file);
        const parsed = patch ? parsePatchStats(patch) : undefined;
        summaries.push({
            path,
            additions: parseCount(file.additions) ?? parsed?.additions,
            deletions: parseCount(file.deletions) ?? parsed?.deletions,
            patch,
            partId: part?.id,
            messageID: part?.messageID,
        });
    }

    if (summaries.length > 0) {
        return getSummariesDiffStats(summaries);
    }

    const paths = extractEditedFilePathsFromToolPart(part);
    const patch = getPatchTextFromRecord(metadata) ?? getPatchTextFromRecord(state?.input);
    const parsed = patch ? parsePatchStats(patch) : undefined;
    if (paths.length === 0 || !parsed) {
        return null;
    }

    return getSummariesDiffStats([{ path: paths[0] ?? '', additions: parsed.additions, deletions: parsed.deletions, patch }]);
};
