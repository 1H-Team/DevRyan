import type { ToolPart } from '@opencode-ai/sdk/v2';
import {
    extractPatchFileSummariesFromToolPart,
    isPatchToolName,
    normalizeToolName,
} from './message/parts/toolRenderUtils';
import { isFinalToolStatus } from '@/lib/toolStatus';

export interface ChangedFile {
    path: string;
    tool: string;
    partId: string;
    messageID: string;
    additions?: number;
    deletions?: number;
    patch?: string;
}

export interface GitChangedFile {
    path: string;
    relativePath: string;
    insertions: number;
    deletions: number;
    binary?: boolean;
    oldPath?: string | null;
    status: string;
}

export type ChangedFileEntry = ChangedFile | GitChangedFile;

export const FILE_EDIT_TOOLS = new Set(['edit', 'multiedit', 'write', 'apply_patch', 'create', 'file_write']);
export const isFileEditToolName = (toolName: unknown): boolean => FILE_EDIT_TOOLS.has(normalizeToolName(toolName));

export const isGitFile = (file: ChangedFileEntry): file is GitChangedFile => 'insertions' in file;

const parseCount = (value: unknown): number | undefined => {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
    return undefined;
};

const parsePatchStats = (patch: string): { added: number; removed: number } => {
    let added = 0;
    let removed = 0;
    for (const line of patch.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) added++;
        if (line.startsWith('-') && !line.startsWith('---')) removed++;
    }
    return { added, removed };
};

const normalizeChangedFilePath = (path: string): string => {
    const normalized = path.trim()
        .replace(/\\/g, '/')
        .replace(/\/{2,}/g, '/')
        .replace(/^\.\//, '');
    return normalized === '/' ? normalized : normalized.replace(/\/+$/, '');
};

const mergePatchText = (current: string | undefined, incoming: string | undefined): string | undefined => {
    if (!incoming) return current;
    if (!current) return incoming;
    if (current.includes(incoming)) return current;
    return `${current.trimEnd()}\n\n${incoming.trimStart()}`;
};

const mergeChangedFile = (existing: ChangedFile, incoming: ChangedFile): ChangedFile => ({
    ...existing,
    additions: (existing.additions ?? 0) + (incoming.additions ?? 0),
    deletions: (existing.deletions ?? 0) + (incoming.deletions ?? 0),
    patch: mergePatchText(existing.patch, incoming.patch),
});

const getFirstPathCandidate = (record: Record<string, unknown> | undefined): string | undefined => {
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
    const value = candidates.find((candidate) => typeof candidate === 'string' && candidate.trim().length > 0);
    return typeof value === 'string' ? value : undefined;
};

export const extractChangedFiles = (parts: ToolPart[]): ChangedFile[] => {
    const files: ChangedFile[] = [];
    const fileIndexByPath = new Map<string, number>();

    const addFile = (file: ChangedFile) => {
        const normalizedPath = normalizeChangedFilePath(file.path);
        if (!normalizedPath) {
            return;
        }
        const existingIndex = fileIndexByPath.get(normalizedPath);
        const normalizedFile = { ...file, path: normalizedPath };
        if (existingIndex !== undefined) {
            files[existingIndex] = mergeChangedFile(files[existingIndex], normalizedFile);
            return;
        }
        fileIndexByPath.set(normalizedPath, files.length);
        files.push(normalizedFile);
    };

    for (const part of parts) {
        if (part.type !== 'tool') continue;
        const normalizedTool = normalizeToolName(part.tool);
        if (!FILE_EDIT_TOOLS.has(normalizedTool)) continue;

        const state = part.state as { metadata?: Record<string, unknown>; input?: Record<string, unknown>; status?: string };
        if (state.status && !isFinalToolStatus(state.status)) continue;

        const sizeBeforeThisPart = files.length;
        const metadata = state.metadata;

        if (isPatchToolName(normalizedTool)) {
            const summaries = extractPatchFileSummariesFromToolPart(
                normalizedTool === part.tool ? part : ({ ...part, tool: normalizedTool } as ToolPart),
            );
            for (const summary of summaries) {
                addFile({
                    path: summary.path,
                    tool: normalizedTool,
                    partId: part.id,
                    messageID: part.messageID,
                    additions: summary.additions,
                    deletions: summary.deletions,
                    patch: summary.patch,
                });
            }
            if (summaries.length > 0) {
                continue;
            }
        }

        const metaFiles = Array.isArray(metadata?.files) ? metadata.files : [];
        for (const file of metaFiles) {
            if (!file || typeof file !== 'object') continue;
            const record = file as Record<string, unknown>;
            const rawPath = getFirstPathCandidate(record);
            if (!rawPath) continue;
            addFile({
                path: rawPath,
                tool: normalizedTool,
                partId: part.id,
                messageID: part.messageID,
                additions: parseCount(record.additions) ?? undefined,
                deletions: parseCount(record.deletions) ?? undefined,
                patch: typeof record.patch === 'string' ? record.patch : typeof record.diff === 'string' ? record.diff : undefined,
            });
        }

        if (metaFiles.length === 0 && metadata?.filediff && typeof metadata.filediff === 'object') {
            const fd = metadata.filediff as { file?: string; additions?: unknown; deletions?: unknown; patch?: unknown };
            const rawPath = typeof fd.file === 'string' ? fd.file : '';
            if (rawPath) {
                addFile({
                    path: rawPath,
                    tool: normalizedTool,
                    partId: part.id,
                    messageID: part.messageID,
                    additions: parseCount(fd.additions) ?? undefined,
                    deletions: parseCount(fd.deletions) ?? undefined,
                    patch: typeof fd.patch === 'string' ? fd.patch : undefined,
                });
            }
        }

        if (metaFiles.length === 0 && Array.isArray(metadata?.results)) {
            for (const result of metadata.results) {
                if (!result || typeof result !== 'object') continue;
                const fd = (result as { filediff?: { file?: string; additions?: unknown; deletions?: unknown; patch?: unknown } }).filediff;
                if (!fd || typeof fd !== 'object') continue;
                const rawPath = typeof fd.file === 'string' ? fd.file : '';
                if (!rawPath) continue;
                addFile({
                    path: rawPath,
                    tool: normalizedTool,
                    partId: part.id,
                    messageID: part.messageID,
                    additions: parseCount(fd.additions) ?? undefined,
                    deletions: parseCount(fd.deletions) ?? undefined,
                    patch: typeof fd.patch === 'string' ? fd.patch : undefined,
                });
            }
        }

        if (files.length === sizeBeforeThisPart) {
            const input = state.input;
            const filePath = getFirstPathCandidate(input) ?? getFirstPathCandidate(metadata);
            if (filePath) {
                addFile({
                    path: filePath,
                    tool: normalizedTool,
                    partId: part.id,
                    messageID: part.messageID,
                });
            }
        }

        if (files.length === sizeBeforeThisPart) {
            const patchText = typeof metadata?.patch === 'string' ? metadata.patch.trim()
                : typeof metadata?.patchText === 'string' ? metadata.patchText.trim()
                    : typeof metadata?.diff === 'string' ? metadata.diff.trim()
                        : typeof metadata?.changes === 'string' ? metadata.changes.trim()
                            : typeof state.input?.patch === 'string' ? state.input.patch.trim()
                                : typeof state.input?.patchText === 'string' ? state.input.patchText.trim()
                                    : typeof state.input?.diff === 'string' ? state.input.diff.trim()
                                        : typeof state.input?.changes === 'string' ? state.input.changes.trim()
                                            : '';
            if (patchText) {
                const parsed = parsePatchStats(patchText);
                addFile({
                    path: 'Diff',
                    tool: normalizedTool,
                    partId: part.id,
                    messageID: part.messageID,
                    additions: parsed.added,
                    deletions: parsed.removed,
                });
            }
        }
    }

    return files;
};

export const extractGitChangedFiles = (
    files: Array<{ path: string; index: string; working_dir: string }>,
    diffStats: Record<string, { insertions: number; deletions: number }> | undefined,
    directory: string,
): GitChangedFile[] => {
    const result: GitChangedFile[] = [];
    for (const file of files) {
        const code = file.working_dir !== ' ' ? file.working_dir : file.index;
        if (code === '!' || code === ' ') continue;
        const stats = diffStats?.[file.path];
        result.push({
            path: file.path.startsWith('/') ? file.path : (directory.endsWith('/') ? directory : directory + '/') + file.path,
            relativePath: file.path,
            insertions: stats?.insertions ?? 0,
            deletions: stats?.deletions ?? 0,
            status: code,
        });
    }
    return result;
};

export const toRelativePath = (absolutePath: string, baseDirectory: string): string => {
    const norm = (p: string) => p.split('\\').join('/').replace(/\/+$/, '');
    const base = norm(baseDirectory);
    const absPath = norm(absolutePath);
    if (absPath.startsWith(base + '/')) {
        return absPath.slice(base.length + 1);
    }
    if (absPath.startsWith(base)) {
        return absPath.slice(base.length) || absPath;
    }
    return absPath;
};

export const getDisplayPath = (file: ChangedFileEntry, currentDirectory: string): { fileName: string; dirPart: string } => {
    const relativePath = isGitFile(file) && file.relativePath
        ? file.relativePath
        : toRelativePath(file.path, currentDirectory);
    const fileName = relativePath.split('/').pop() ?? relativePath;
    const dirPart = relativePath.includes('/') ? relativePath.slice(0, relativePath.lastIndexOf('/')) : '';
    return { fileName, dirPart };
};

export const getFileStats = (file: ChangedFileEntry): { additions: number; deletions: number } => {
    if (isGitFile(file)) return { additions: file.insertions, deletions: file.deletions };
    return { additions: file.additions ?? 0, deletions: file.deletions ?? 0 };
};
