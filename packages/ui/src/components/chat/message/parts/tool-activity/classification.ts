const EXPANDABLE_TOOL_NAMES = new Set<string>([
    'edit', 'multiedit', 'apply_patch', 'str_replace', 'str_replace_based_edit_tool',
    'bash', 'shell', 'cmd', 'terminal',
    'write', 'create', 'file_write',
    'question', 'task',
]);

const STANDALONE_TOOL_NAMES = new Set<string>(['task']);
// `create_plan` is rendered as the rich Implementation Plan card (driven by the
// plan-text sentinel), so its generic tool-activity row would be a redundant
// "Create Plan" line below the card — hide it.
const HIDDEN_TOOL_NAMES = new Set<string>(['mkdir', 'create_plan', 'devryan_task']);
const SHELL_TOOL_NAMES = new Set<string>(['bash', 'shell', 'cmd', 'terminal']);
const QUESTION_TOOL_NAMES = new Set<string>(['question']);

const SEARCH_TOOL_NAMES = new Set<string>(['grep', 'search', 'find', 'ripgrep', 'glob']);
const READ_TOOL_NAMES = new Set<string>(['read', 'view', 'file_read', 'cat']);
const PATCH_TOOL_NAMES = new Set<string>(['apply_patch']);
const EDIT_TOOL_NAMES = new Set<string>([
    'edit', 'multiedit', 'str_replace', 'str_replace_based_edit_tool',
    'write', 'create', 'file_write',
]);
const FETCH_TOOL_NAMES = new Set<string>([
    'webfetch', 'fetch', 'curl', 'wget',
    'websearch', 'web-search', 'search_web', 'codesearch',
]);

const TOOL_NAME_ALIASES = new Map<string, string>([
    ['applypatch', 'apply_patch'],
    ['apply_patch_tool', 'apply_patch'],
    ['patch', 'apply_patch'],
    ['file_patch', 'apply_patch'],
    ['patch_file', 'apply_patch'],
    ['apply_diff', 'apply_patch'],
    ['edit_file', 'edit'],
    ['file_edit', 'edit'],
    ['write_file', 'write'],
    ['file_write', 'file_write'],
    ['create_file', 'create'],
    ['read_file', 'read'],
    ['file_read', 'file_read'],
    ['view_file', 'view'],
    ['shell_command', 'bash'],
    ['terminal_command', 'bash'],
    ['run_command', 'bash'],
    ['execute_command', 'bash'],
    ['exec_command', 'bash'],
    ['command', 'bash'],
    ['shell', 'bash'],
    ['cmd', 'bash'],
    ['list', 'glob'],
    ['list_directory', 'glob'],
    ['ls', 'glob'],
    ['web_fetch', 'webfetch'],
    ['web_search', 'websearch'],
]);

export type ToolActivityGroupKind = 'search' | 'read' | 'edit' | 'fetch' | 'patch' | 'shell';

const PASSIVE_ROLLUP_GROUP_KINDS = new Set<ToolActivityGroupKind>(['search', 'read', 'fetch', 'edit', 'patch']);

export interface ToolActivityGroupInfo {
    key: string;
    kind: ToolActivityGroupKind;
    representativeToolName: string;
}

export type ToolActivityAggregation<T> =
    | { type: 'group'; groupInfo: ToolActivityGroupInfo; items: T[] }
    | { type: 'item'; item: T };

export const getToolActivityGroupLabelKey = (kind: ToolActivityGroupKind, count: number) => {
    if (kind === 'search') {
        return count === 1 ? 'chat.toolGroup.searchedFileSingle' : 'chat.toolGroup.searchedFilePlural';
    }
    if (kind === 'patch') {
        return count === 1 ? 'chat.toolGroup.appliedPatchSingle' : 'chat.toolGroup.appliedPatchPlural';
    }
    if (kind === 'edit') {
        return count === 1 ? 'chat.toolGroup.editedFileSingle' : 'chat.toolGroup.editedFilePlural';
    }
    if (kind === 'read') {
        return count === 1 ? 'chat.toolGroup.readFileSingle' : 'chat.toolGroup.readFilePlural';
    }
    if (kind === 'shell') {
        return count === 1 ? 'chat.toolGroup.ranCommandSingle' : 'chat.toolGroup.ranCommandPlural';
    }
    return count === 1 ? 'chat.toolGroup.fetchedUrlSingle' : 'chat.toolGroup.fetchedUrlPlural';
};

export const normalizeToolName = (toolName: unknown): string => {
    if (typeof toolName !== 'string') return '';
    const trimmed = toolName.trim();
    if (!trimmed) return '';

    let normalized = trimmed.replace(/:\d+$/, '');
    if (normalized.includes('.')) {
        const parts = normalized.split('.').filter(Boolean);
        normalized = parts[parts.length - 1] ?? normalized;
    }

    normalized = normalized
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/[-\s]+/g, '_')
        .toLowerCase()
        .replace(/_?tool_?call$/, '');

    return TOOL_NAME_ALIASES.get(normalized) ?? normalized;
};

export const isShellToolName = (toolName: unknown): boolean => {
    return SHELL_TOOL_NAMES.has(normalizeToolName(toolName));
};

export const isExpandableTool = (toolName: unknown): boolean => {
    return EXPANDABLE_TOOL_NAMES.has(normalizeToolName(toolName));
};

export const isStandaloneTool = (toolName: unknown): boolean => {
    return STANDALONE_TOOL_NAMES.has(normalizeToolName(toolName));
};

export const isHiddenTool = (toolName: unknown): boolean => {
    return HIDDEN_TOOL_NAMES.has(normalizeToolName(toolName));
};

export const isManagedTaskToolName = (toolName: unknown): boolean => {
    return normalizeToolName(toolName) === 'devryan_task';
};

export const isStaticTool = (toolName: unknown): boolean => {
    if (typeof toolName !== 'string') return false;
    return !isExpandableTool(toolName) && !isStandaloneTool(toolName) && !isHiddenTool(toolName);
};

export const isToolActivityGroupingBoundary = (toolName: unknown): boolean => {
    const normalized = normalizeToolName(toolName);
    return QUESTION_TOOL_NAMES.has(normalized)
        || STANDALONE_TOOL_NAMES.has(normalized);
};

export const isPassiveRollupGroupKind = (kind: ToolActivityGroupKind): boolean => {
    return PASSIVE_ROLLUP_GROUP_KINDS.has(kind);
};


export const isSearchToolName = (toolName: unknown): boolean => {
    return SEARCH_TOOL_NAMES.has(normalizeToolName(toolName));
};

export const isReadToolName = (toolName: unknown): boolean => {
    return READ_TOOL_NAMES.has(normalizeToolName(toolName));
};

export const isPatchToolName = (toolName: unknown): boolean => {
    return PATCH_TOOL_NAMES.has(normalizeToolName(toolName));
};

export const isEditToolName = (toolName: unknown): boolean => {
    return EDIT_TOOL_NAMES.has(normalizeToolName(toolName));
};

export const isFetchToolName = (toolName: unknown): boolean => {
    return FETCH_TOOL_NAMES.has(normalizeToolName(toolName));
};

export const getStaticGroupToolName = (toolName: string): string => {
    const normalized = normalizeToolName(toolName);
    if (SEARCH_TOOL_NAMES.has(normalized)) {
        return 'grep';
    }
    return normalized;
};

export const getToolActivityGroupInfo = (toolName: unknown): ToolActivityGroupInfo | null => {
    const normalized = normalizeToolName(toolName);
    if (!normalized || isStandaloneTool(normalized)) {
        return null;
    }

    if (PATCH_TOOL_NAMES.has(normalized)) {
        return { key: 'patch', kind: 'patch', representativeToolName: 'apply_patch' };
    }

    if (SHELL_TOOL_NAMES.has(normalized)) {
        return { key: 'shell', kind: 'shell', representativeToolName: 'bash' };
    }

    if (SEARCH_TOOL_NAMES.has(normalized)) {
        return { key: 'search', kind: 'search', representativeToolName: 'grep' };
    }

    if (READ_TOOL_NAMES.has(normalized)) {
        return { key: 'read', kind: 'read', representativeToolName: 'read' };
    }

    if (EDIT_TOOL_NAMES.has(normalized)) {
        return { key: 'edit', kind: 'edit', representativeToolName: 'edit' };
    }

    if (FETCH_TOOL_NAMES.has(normalized)) {
        return { key: 'fetch', kind: 'fetch', representativeToolName: 'webfetch' };
    }

    return null;
};
