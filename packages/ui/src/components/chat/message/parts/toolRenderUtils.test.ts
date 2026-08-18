import { describe, expect, test } from 'bun:test';
import type { ToolPart } from '@opencode-ai/sdk/v2';
import { dict } from '@/lib/i18n/messages/en';

import {
    collectConsecutiveToolActivityGroup,
    collectCrossMessageFileActivityGroups,
    collectToolActivityBurst,
    collectToolActivityRowsFromToolParts,
    collectToolActivityRows,
    extractEditedFilePathsFromToolPart,
    extractFetchedUrlsFromToolPart,
    extractPatchFileSummariesFromToolPart,
    extractReadFilePathsFromToolPart,
    extractSearchedFilePathsFromToolPart,
    getToolActivityGroupLabelKey,
    getToolActivityGroupInfo,
    getToolActivityGroupDescription,
    getToolActivityGroupSummaryCount,
    getToolFileMutationAction,
    getToolDescriptionFallback,
    getToolPartDiffStatsFromToolPart,
    isExpandableTool,
    isHiddenTool,
    isManagedTaskToolName,
    isStandaloneTool,
    isStaticTool,
    mergePatchFileSummariesFromToolParts,
    normalizeToolName,
} from './toolRenderUtils';

type ToolItem = { kind: 'tool'; tool: string; part?: ToolPart } | { kind: 'reasoning' } | { kind: 'text' };

const toolPart = (tool: string, state: Record<string, unknown> = {}, id = tool): ToolPart => {
    return {
        id,
        type: 'tool',
        tool,
        state,
        messageID: 'message-1',
    } as ToolPart;
};

const collect = (items: readonly ToolItem[], startIndex = 0) => {
    return collectConsecutiveToolActivityGroup(items, startIndex, (item) => {
        return item.kind === 'tool' ? item.tool : null;
    }, (item) => item.kind === 'tool' ? item.part : undefined);
};

const collectBurst = (items: readonly ToolItem[], startIndex = 0) => {
    return collectToolActivityBurst(items, startIndex, (item) => {
        return item.kind === 'tool' ? item.tool : null;
    }, {
        getToolPart: (item) => item.kind === 'tool' ? item.part : undefined,
        isBoundary: (item) => item.kind !== 'tool',
    });
};

const collectRows = (items: readonly ToolItem[]) => {
    return collectToolActivityRows(items, {
        getToolName: (item) => item.kind === 'tool' ? item.tool : null,
        getToolPart: (item) => item.kind === 'tool' ? item.part : undefined,
        isReasoningOrJustification: (item) => item.kind === 'reasoning',
        isStandalone: (item) => item.kind === 'tool' && item.tool === 'task',
    });
};

describe('tool activity grouping', () => {
    test('uses glob patterns as the tool-description fallback', () => {
        expect(getToolDescriptionFallback('glob', {
            input: { pattern: 'packages/ui/src/**/*.tsx' },
        })).toBe('packages/ui/src/**/*.tsx');
    });

    test('preserves the generic tool-description fallback', () => {
        expect(getToolDescriptionFallback('custom_tool', {
            input: { description: 'Inspect the generated report' },
        })).toBe('Inspect the generated report');
    });

    test('keeps path-specific tool descriptions authoritative', () => {
        expect(getToolDescriptionFallback('read', {
            pathDescription: 'src/config.ts',
            input: { description: 'Read the config' },
        })).toBe('src/config.ts');
    });

    test('shows deduplicated glob patterns on grouped search rows', () => {
        expect(getToolActivityGroupDescription('search', [
            toolPart('glob', { input: { pattern: '**/*.md' } }, 'glob-1'),
            toolPart('glob', { input: { pattern: '**/*.md' } }, 'glob-2'),
            toolPart('grep', { input: { pattern: 'TODO' } }, 'grep-1'),
        ])).toBe('**/*.md');
        expect(getToolActivityGroupDescription('read', [
            toolPart('glob', { input: { pattern: '**/*.md' } }, 'glob-3'),
        ])).toBe('');
    });

    test('groups consecutive search tools under one search group', () => {
        const grouped = collect([
            { kind: 'tool', tool: 'grep' },
            { kind: 'tool', tool: 'glob' },
            { kind: 'tool', tool: 'ripgrep' },
        ]);

        expect(grouped?.groupInfo.kind).toBe('search');
        expect(grouped?.items).toHaveLength(3);
        expect(grouped?.endIndex).toBe(3);
    });

    test('groups explicit edits and writes to existing files under one edited group', () => {
        const grouped = collect([
            { kind: 'tool', tool: 'edit', part: toolPart('edit', { input: { path: 'a.sql' } }) },
            { kind: 'tool', tool: 'write', part: toolPart('write', { input: { path: 'b.sql' }, metadata: { exists: true } }) },
        ]);

        expect(grouped?.groupInfo.kind).toBe('edit');
        expect(grouped?.groupInfo.fileMutationAction).toBe('edited');
        expect(grouped?.items).toHaveLength(2);
    });

    test('classifies apply_patch as a patch group', () => {
        expect(getToolActivityGroupInfo('apply_patch')?.kind).toBe('patch');
    });

    test('normalizes Cursor ToolCall names into regular tool names', () => {
        expect(normalizeToolName('writeToolCall')).toBe('write');
        expect(normalizeToolName('editToolCall')).toBe('edit');
        expect(normalizeToolName('applyPatchToolCall')).toBe('apply_patch');
        expect(normalizeToolName('patchToolCall')).toBe('apply_patch');
        expect(normalizeToolName('filePatchToolCall')).toBe('apply_patch');
        expect(normalizeToolName('applyDiffToolCall')).toBe('apply_patch');
        expect(normalizeToolName('cursor.shellToolCall:0')).toBe('bash');
        expect(normalizeToolName('readToolCall')).toBe('read');
        expect(normalizeToolName('oc_write')).toBe('write');
        expect(normalizeToolName('oc_edit')).toBe('edit');
        expect(normalizeToolName('oc_read')).toBe('read');
        expect(normalizeToolName('oc_bash')).toBe('bash');
        expect(normalizeToolName('stat')).toBe('read');
    });

    test('defines presentation families while leaving new plugin tools on the safe fallback', () => {
        const families = [
            { tool: 'bash', expandable: true, standalone: false, hidden: false, static: false },
            { tool: 'cursor.shellToolCall:0', expandable: true, standalone: false, hidden: false, static: false },
            { tool: 'oc_write', expandable: true, standalone: false, hidden: false, static: false },
            { tool: 'task', expandable: true, standalone: true, hidden: false, static: false },
            { tool: 'question', expandable: true, standalone: false, hidden: false, static: false },
            { tool: 'devryan_task', expandable: false, standalone: false, hidden: true, static: false },
            { tool: 'create_plan', expandable: false, standalone: false, hidden: true, static: false },
            { tool: 'todowrite', expandable: false, standalone: false, hidden: false, static: true },
            { tool: 'structuredoutput', expandable: false, standalone: false, hidden: false, static: true },
            { tool: 'council', expandable: false, standalone: false, hidden: false, static: true },
            { tool: 'ctx_execute', expandable: false, standalone: false, hidden: false, static: true },
            { tool: 'mcp__future_plugin__inspect', expandable: false, standalone: false, hidden: false, static: true },
        ];

        for (const family of families) {
            expect({
                expandable: isExpandableTool(family.tool),
                standalone: isStandaloneTool(family.tool),
                hidden: isHiddenTool(family.tool),
                static: isStaticTool(family.tool),
            }).toEqual({
                expandable: family.expandable,
                standalone: family.standalone,
                hidden: family.hidden,
                static: family.static,
            });
        }
        expect(isManagedTaskToolName('devryan_task')).toBe(true);
        expect(isManagedTaskToolName('task')).toBe(false);
    });

    test('classifies Cursor ToolCall names into activity groups', () => {
        expect(getToolActivityGroupInfo('writeToolCall')?.kind).toBe('edit');
        expect(getToolActivityGroupInfo('editToolCall')?.kind).toBe('edit');
        expect(getToolActivityGroupInfo('applyPatchToolCall')?.kind).toBe('patch');
        expect(getToolActivityGroupInfo('patchToolCall')?.kind).toBe('patch');
        expect(getToolActivityGroupInfo('filePatchToolCall')?.kind).toBe('patch');
        expect(getToolActivityGroupInfo('applyDiffToolCall')?.kind).toBe('patch');
        expect(getToolActivityGroupInfo('readToolCall')?.kind).toBe('read');
        expect(getToolActivityGroupInfo('oc_read')?.kind).toBe('read');
        expect(getToolActivityGroupInfo('stat')?.kind).toBe('read');
    });

    test('maps the observed OpenAI, OpenCodeGo, and Anthropic tools into the shared row groups', () => {
        const providerTools = {
            openai: ['grep', 'read', 'apply_patch', 'bash'],
            opencodego: ['search', 'read', 'edit', 'bash'],
            anthropic: ['grep', 'read', 'write', 'bash'],
        } as const;

        expect(Object.fromEntries(
            Object.entries(providerTools).map(([provider, tools]) => [
                provider,
                tools.map((tool) => getToolActivityGroupInfo(tool)?.kind),
            ]),
        )).toEqual({
            openai: ['search', 'read', 'patch', 'shell'],
            opencodego: ['search', 'read', 'edit', 'shell'],
            anthropic: ['search', 'read', 'edit', 'shell'],
        });
    });

    test('classifies file mutations from authoritative pre-write existence metadata', () => {
        const created = toolPart('oc_write', { metadata: { exists: false } }, 'create');
        const edited = toolPart('oc_write', { metadata: { exists: true } }, 'edit');
        const unknown = toolPart('oc_write', {}, 'unknown');

        expect(getToolFileMutationAction('oc_write', created)).toBe('created');
        expect(getToolFileMutationAction('oc_write', edited)).toBe('edited');
        expect(getToolFileMutationAction('oc_write', unknown)).toBe('wrote');
        expect(getToolFileMutationAction('oc_edit', unknown)).toBe('edited');
        expect(getToolFileMutationAction('create', unknown)).toBe('created');
        expect(getToolActivityGroupInfo('oc_write', created)?.key).toBe('edit:created');
        expect(getToolActivityGroupInfo('oc_write', edited)?.key).toBe('edit:edited');
        expect(getToolActivityGroupInfo('oc_write', unknown)?.key).toBe('edit:wrote');
    });

    test('uses count-based file action labels for singular and plural groups', () => {
        const created = getToolActivityGroupInfo('create');
        const wrote = getToolActivityGroupInfo('write');

        expect(created && getToolActivityGroupLabelKey(created, 1)).toBe('chat.toolGroup.createdFileSingle');
        expect(created && getToolActivityGroupLabelKey(created, 2)).toBe('chat.toolGroup.createdFilePlural');
        expect(wrote && getToolActivityGroupLabelKey(wrote, 1)).toBe('chat.toolGroup.wroteFileSingle');
        expect(getToolActivityGroupLabelKey('edit', 1)).toBe('chat.toolGroup.editedFileSingle');
        expect(getToolActivityGroupLabelKey('read', 1)).toBe('chat.toolGroup.readFileSingle');
        expect(dict['chat.toolGroup.searchedFilePlural']).toBe('Searched {count} files');
        expect(dict['chat.toolGroup.createdFileSingle']).toBe('Created {count} file');
        expect(dict['chat.toolGroup.createdFilePlural']).toBe('Created {count} files');
        expect(dict['chat.toolGroup.editedFilePlural']).toBe('Edited {count} files');
        expect(dict['chat.toolGroup.wroteFilePlural']).toBe('Wrote {count} files');
        expect(dict['chat.toolGroup.readFileSingle']).toBe('Read {count} file');
        expect(dict['chat.toolGroup.readFilePlural']).toBe('Read {count} files');
    });

    test('groups consecutive patch tools under one patch group', () => {
        const grouped = collect([
            { kind: 'tool', tool: 'apply_patch' },
            { kind: 'tool', tool: 'apply_patch' },
        ]);

        expect(grouped?.groupInfo.kind).toBe('patch');
        expect(grouped?.items).toHaveLength(2);
    });

    test('groups consecutive read tools under one read group', () => {
        const grouped = collect([
            { kind: 'tool', tool: 'read' },
            { kind: 'tool', tool: 'view' },
            { kind: 'tool', tool: 'file_read' },
        ]);

        expect(grouped?.groupInfo.kind).toBe('read');
        expect(grouped?.items).toHaveLength(3);
    });

    test('stops at mixed tool group boundaries', () => {
        const grouped = collect([
            { kind: 'tool', tool: 'grep' },
            { kind: 'tool', tool: 'edit' },
            { kind: 'tool', tool: 'glob' },
        ]);

        expect(grouped).toBeNull();
    });

    test('does not merge across reasoning boundaries', () => {
        const grouped = collect([
            { kind: 'tool', tool: 'read' },
            { kind: 'reasoning' },
            { kind: 'tool', tool: 'view' },
        ]);

        expect(grouped).toBeNull();
    });

    test('excludes standalone task tools from file activity grouping', () => {
        expect(getToolActivityGroupInfo('task')).toBeNull();
    });

    test('groups repeated searches around reads inside one activity burst', () => {
        const firstSearch = toolPart('grep', { output: 'src/a.ts:1:alpha' }, 'grep-1');
        const read = toolPart('read', { input: { filePath: 'src/a.ts' } }, 'read-1');
        const secondSearch = toolPart('glob', { output: 'src/b.ts\nsrc/c.ts' }, 'glob-1');
        const burst = collectBurst([
            { kind: 'tool', tool: 'grep', part: firstSearch },
            { kind: 'tool', tool: 'read', part: read },
            { kind: 'tool', tool: 'glob', part: secondSearch },
        ]);

        expect(burst?.endIndex).toBe(3);
        expect(burst?.rows).toHaveLength(2);
        expect(burst?.rows[0]?.type).toBe('group');
        if (burst?.rows[0]?.type === 'group') {
            expect(burst.rows[0].groupInfo.kind).toBe('search');
            expect(burst.rows[0].items).toHaveLength(2);
            expect(getToolActivityGroupSummaryCount('search', burst.rows[0].items, (item) => item.kind === 'tool' ? item.part : undefined)).toBe(3);
        }
        expect(burst?.rows[1]?.type).toBe('group');
        if (burst?.rows[1]?.type === 'group') {
            expect(burst.rows[1].groupInfo.kind).toBe('read');
            expect(getToolActivityGroupSummaryCount('read', burst.rows[1].items, (item) => item.kind === 'tool' ? item.part : undefined)).toBe(1);
        }
    });

    test('groups shell commands without breaking surrounding file activity rollups', () => {
        const burst = collectBurst([
            { kind: 'tool', tool: 'grep', part: toolPart('grep', { output: 'src/a.ts:1:a' }, 'grep-1') },
            { kind: 'tool', tool: 'bash', part: toolPart('bash', { input: { command: 'pwd' } }, 'bash-1') },
            { kind: 'tool', tool: 'grep', part: toolPart('grep', { output: 'src/b.ts:1:b' }, 'grep-2') },
        ]);

        expect(burst?.endIndex).toBe(3);
        expect(burst?.rows).toHaveLength(2);
        expect(burst?.rows[0]?.type).toBe('group');
        expect(burst?.rows[1]?.type).toBe('group');
        if (burst?.rows[1]?.type === 'group') {
            expect(burst.rows[1].groupInfo.kind).toBe('shell');
            expect(burst.rows[1].items).toHaveLength(1);
        }
    });

    test('does not group across question or text boundaries', () => {
        const withQuestion = collectBurst([
            { kind: 'tool', tool: 'grep', part: toolPart('grep', { output: 'src/a.ts:1:a' }, 'grep-1') },
            { kind: 'tool', tool: 'question', part: toolPart('question', {}, 'question-1') },
            { kind: 'tool', tool: 'grep', part: toolPart('grep', { output: 'src/b.ts:1:b' }, 'grep-2') },
        ]);

        const withText = collectBurst([
            { kind: 'tool', tool: 'grep', part: toolPart('grep', { output: 'src/a.ts:1:a' }, 'grep-1') },
            { kind: 'text' },
            { kind: 'tool', tool: 'grep', part: toolPart('grep', { output: 'src/b.ts:1:b' }, 'grep-2') },
        ]);

        expect(withQuestion?.endIndex).toBe(1);
        expect(withText?.endIndex).toBe(1);
    });

    test('single and multi-file apply_patch calls collapse into patch groups', () => {
        const singlePatch = toolPart('apply_patch', {
            metadata: {
                files: [{ relativePath: 'src/a.ts', additions: 2, deletions: 1 }],
            },
        }, 'patch-1');
        const multiPatch = toolPart('apply_patch', {
            metadata: {
                files: [
                    { relativePath: 'src/a.ts', additions: 2, deletions: 1 },
                    { relativePath: 'src/b.ts', additions: 4, deletions: 0 },
                ],
            },
        }, 'patch-2');

        const single = collectBurst([{ kind: 'tool', tool: 'apply_patch', part: singlePatch }]);
        const multi = collectBurst([{ kind: 'tool', tool: 'apply_patch', part: multiPatch }]);

        expect(single?.rows[0]?.type).toBe('group');
        expect(multi?.rows[0]?.type).toBe('group');
        if (single?.rows[0]?.type === 'group') {
            expect(single.rows[0].groupInfo.kind).toBe('patch');
            expect(getToolActivityGroupSummaryCount('patch', single.rows[0].items, (item) => item.kind === 'tool' ? item.part : undefined)).toBe(1);
        }
        if (multi?.rows[0]?.type === 'group') {
            expect(getToolActivityGroupSummaryCount('patch', multi.rows[0].items, (item) => item.kind === 'tool' ? item.part : undefined)).toBe(2);
        }
    });

    test('suppresses edited file burst rows when an applied patch covers the same files', () => {
        const burst = collectBurst([
            { kind: 'tool', tool: 'edit', part: toolPart('edit', { input: { path: '/repo/src/a.ts' } }, 'edit-1') },
            { kind: 'tool', tool: 'write', part: toolPart('write', { input: { path: '/repo/src/b.ts' } }, 'write-1') },
            {
                kind: 'tool',
                tool: 'apply_patch',
                part: toolPart('apply_patch', {
                    metadata: {
                        files: [
                            { relativePath: 'src/a.ts', additions: 1, deletions: 0 },
                            { relativePath: 'src/b.ts', additions: 2, deletions: 1 },
                        ],
                    },
                }, 'patch-1'),
            },
        ]);

        expect(burst?.rows.map((row) => row.type === 'group' ? row.groupInfo.kind : 'item')).toEqual(['patch']);
    });

    test('keeps fetched urls grouped with url counts', () => {
        const burst = collectBurst([
            { kind: 'tool', tool: 'webfetch', part: toolPart('webfetch', { input: { url: 'https://example.com/a' } }, 'fetch-1') },
            { kind: 'tool', tool: 'fetch', part: toolPart('fetch', { metadata: { url: 'https://example.com/b' } }, 'fetch-2') },
        ]);

        expect(burst?.rows[0]?.type).toBe('group');
        if (burst?.rows[0]?.type === 'group') {
            expect(burst.rows[0].groupInfo.kind).toBe('fetch');
            expect(getToolActivityGroupSummaryCount('fetch', burst.rows[0].items, (item) => item.kind === 'tool' ? item.part : undefined)).toBe(2);
        }
    });

    test('rolls read tools across reasoning into one group', () => {
        const rows = collectRows([
            { kind: 'tool', tool: 'read', part: toolPart('read', { input: { filePath: 'src/a.ts' } }, 'read-1') },
            { kind: 'reasoning' },
            { kind: 'tool', tool: 'view', part: toolPart('view', { input: { path: 'src/b.ts' } }, 'read-2') },
        ]);

        expect(rows).toHaveLength(2);
        expect(rows[0]?.type).toBe('group');
        if (rows[0]?.type === 'group') {
            expect(rows[0].groupInfo.kind).toBe('read');
            expect(rows[0].items).toHaveLength(2);
        }
        expect(rows[1]?.type).toBe('item');
        if (rows[1]?.type === 'item') {
            expect(rows[1].item.kind).toBe('reasoning');
        }
    });

    test('rolls mixed search and read groups while preserving reasoning rows', () => {
        const rows = collectRows([
            { kind: 'tool', tool: 'grep', part: toolPart('grep', { output: 'src/a.ts:1:a' }, 'grep-1') },
            { kind: 'reasoning' },
            { kind: 'tool', tool: 'read', part: toolPart('read', { input: { filePath: 'src/a.ts' } }, 'read-1') },
            { kind: 'tool', tool: 'glob', part: toolPart('glob', { output: 'src/b.ts\nsrc/c.ts' }, 'glob-1') },
            { kind: 'tool', tool: 'view', part: toolPart('view', { input: { path: 'src/b.ts' } }, 'read-2') },
        ]);

        expect(rows).toHaveLength(3);
        expect(rows[0]?.type).toBe('group');
        if (rows[0]?.type === 'group') {
            expect(rows[0].groupInfo.kind).toBe('search');
            expect(rows[0].items).toHaveLength(2);
            expect(getToolActivityGroupSummaryCount('search', rows[0].items, (item) => item.kind === 'tool' ? item.part : undefined)).toBe(3);
        }
        expect(rows[1]?.type).toBe('item');
        if (rows[1]?.type === 'item') {
            expect(rows[1].item.kind).toBe('reasoning');
        }
        expect(rows[2]?.type).toBe('group');
        if (rows[2]?.type === 'group') {
            expect(rows[2].groupInfo.kind).toBe('read');
            expect(rows[2].items).toHaveLength(2);
        }
    });

    test('consolidates passive rollups across shell boundaries', () => {
        const rows = collectRows([
            { kind: 'tool', tool: 'read', part: toolPart('read', { input: { filePath: 'src/a.ts' } }, 'read-1') },
            { kind: 'tool', tool: 'view', part: toolPart('view', { input: { path: 'src/b.ts' } }, 'read-2') },
            { kind: 'tool', tool: 'bash', part: toolPart('bash', { input: { command: 'pwd' } }, 'bash-1') },
            { kind: 'tool', tool: 'read', part: toolPart('read', { input: { filePath: 'src/c.ts' } }, 'read-3') },
            { kind: 'tool', tool: 'view', part: toolPart('view', { input: { path: 'src/d.ts' } }, 'read-4') },
        ]);

        expect(rows).toHaveLength(2);
        expect(rows[0]?.type).toBe('group');
        expect(rows[1]?.type).toBe('group');
        if (rows[0]?.type === 'group') {
            expect(rows[0].groupInfo.kind).toBe('read');
            expect(rows[0].items).toHaveLength(4);
        }
        if (rows[1]?.type === 'group') {
            expect(rows[1].groupInfo.kind).toBe('shell');
            expect(rows[1].items).toHaveLength(1);
        }
    });

    test('keeps patch groups across shell boundaries (durable rollup)', () => {
        const rows = collectRows([
            { kind: 'tool', tool: 'apply_patch', part: toolPart('apply_patch', { metadata: { files: [{ relativePath: 'src/a.ts', additions: 1, deletions: 0 }] } }, 'patch-1') },
            { kind: 'tool', tool: 'bash', part: toolPart('bash', { input: { command: 'pwd' } }, 'bash-1') },
            { kind: 'tool', tool: 'apply_patch', part: toolPart('apply_patch', { metadata: { files: [{ relativePath: 'src/b.ts', additions: 2, deletions: 1 }] } }, 'patch-2') },
            { kind: 'tool', tool: 'bash', part: toolPart('bash', { input: { command: 'ls' } }, 'bash-2') },
            { kind: 'tool', tool: 'apply_patch', part: toolPart('apply_patch', { metadata: { files: [{ relativePath: 'src/c.ts', additions: 3, deletions: 0 }] } }, 'patch-3') },
        ]);

        const patchGroups = rows.filter((r) => r.type === 'group' && r.groupInfo.kind === 'patch');
        expect(patchGroups).toHaveLength(1);
        if (patchGroups[0]?.type === 'group') {
            expect(patchGroups[0].items).toHaveLength(3);
            expect(getToolActivityGroupSummaryCount('patch', patchGroups[0].items, (item) => item.kind === 'tool' ? item.part : undefined)).toBe(3);
        }
    });

    test('keeps edit groups across shell boundaries (durable rollup)', () => {
        const rows = collectRows([
            { kind: 'tool', tool: 'edit', part: toolPart('edit', { input: { filePath: 'src/a.ts' } }, 'edit-1') },
            { kind: 'tool', tool: 'bash', part: toolPart('bash', { input: { command: 'pwd' } }, 'bash-1') },
            { kind: 'tool', tool: 'write', part: toolPart('write', { input: { filePath: 'src/b.ts' }, metadata: { exists: true } }, 'write-1') },
        ]);

        const editGroups = rows.filter((r) => r.type === 'group' && r.groupInfo.kind === 'edit');
        expect(editGroups).toHaveLength(1);
        if (editGroups[0]?.type === 'group') {
            expect(editGroups[0].items).toHaveLength(2);
        }
    });

    test('suppresses edited file rollups when an applied patch covers the same files', () => {
        const rows = collectRows([
            { kind: 'tool', tool: 'edit', part: toolPart('edit', { input: { filePath: '/repo/src/a.ts' } }, 'edit-1') },
            { kind: 'tool', tool: 'bash', part: toolPart('bash', { input: { command: 'bun test' } }, 'bash-1') },
            {
                kind: 'tool',
                tool: 'apply_patch',
                part: toolPart('apply_patch', {
                    metadata: {
                        files: [{ relativePath: 'src/a.ts', additions: 2, deletions: 1 }],
                    },
                }, 'patch-1'),
            },
        ]);

        expect(rows.some((row) => row.type === 'group' && row.groupInfo.kind === 'edit')).toBe(false);
        expect(rows.some((row) => row.type === 'group' && row.groupInfo.kind === 'patch')).toBe(true);
    });

    test('keeps edited file rollups when applied patches do not cover every edited file', () => {
        const rows = collectRows([
            { kind: 'tool', tool: 'edit', part: toolPart('edit', { input: { filePath: 'src/a.ts' } }, 'edit-1') },
            { kind: 'tool', tool: 'write', part: toolPart('write', { input: { filePath: 'src/b.ts' } }, 'write-1') },
            {
                kind: 'tool',
                tool: 'apply_patch',
                part: toolPart('apply_patch', {
                    metadata: {
                        files: [{ relativePath: 'src/a.ts', additions: 2, deletions: 1 }],
                    },
                }, 'patch-1'),
            },
        ]);

        const editGroups = rows.filter((row) => row.type === 'group' && row.groupInfo.kind === 'edit');
        expect(editGroups).toHaveLength(1);
    });

    test('keeps single read tools as grouped rows for consistent labels', () => {
        const rows = collectRows([
            { kind: 'tool', tool: 'read', part: toolPart('read', { input: { filePath: 'src/a.ts' } }, 'read-1') },
        ]);

        expect(rows).toHaveLength(1);
        expect(rows[0]?.type).toBe('group');
        if (rows[0]?.type === 'group') {
            expect(rows[0].groupInfo.kind).toBe('read');
            expect(getToolActivityGroupSummaryCount('read', rows[0].items, (item) => item.kind === 'tool' ? item.part : undefined)).toBe(1);
        }
    });

    test('rolls edit groups across reasoning while preserving reasoning rows', () => {
        const rows = collectRows([
            { kind: 'tool', tool: 'edit', part: toolPart('edit', { input: { filePath: 'src/a.ts' } }, 'edit-1') },
            { kind: 'tool', tool: 'write', part: toolPart('write', { input: { filePath: 'src/b.ts' }, metadata: { exists: true } }, 'write-1') },
            { kind: 'reasoning' },
            { kind: 'tool', tool: 'edit', part: toolPart('edit', { input: { filePath: 'src/c.ts' } }, 'edit-2') },
            { kind: 'tool', tool: 'write', part: toolPart('write', { input: { filePath: 'src/d.ts' }, metadata: { exists: true } }, 'write-2') },
        ]);

        expect(rows).toHaveLength(2);
        expect(rows[0]?.type).toBe('group');
        expect(rows[1]?.type).toBe('item');
        if (rows[0]?.type === 'group') {
            expect(rows[0].groupInfo.kind).toBe('edit');
            expect(rows[0].items).toHaveLength(4);
            expect(getToolActivityGroupSummaryCount('edit', rows[0].items, (item) => item.kind === 'tool' ? item.part : undefined)).toBe(4);
        }
    });

    test('rolls patch groups across reasoning and suppresses covered edit duplicates', () => {
        const rows = collectRows([
            { kind: 'tool', tool: 'edit', part: toolPart('edit', { input: { filePath: 'src/a.ts' } }, 'edit-1') },
            { kind: 'reasoning' },
            { kind: 'tool', tool: 'write', part: toolPart('write', { input: { filePath: 'src/a.ts' } }, 'write-1') },
            { kind: 'tool', tool: 'apply_patch', part: toolPart('apply_patch', { metadata: { files: [{ relativePath: 'src/a.ts', additions: 1, deletions: 0 }] } }, 'patch-1') },
            { kind: 'tool', tool: 'apply_patch', part: toolPart('apply_patch', { metadata: { files: [{ relativePath: 'src/a.ts', additions: 2, deletions: 1 }] } }, 'patch-2') },
        ]);

        expect(rows).toHaveLength(2);
        expect(rows[0]?.type).toBe('item');
        expect(rows[1]?.type).toBe('group');
        if (rows[1]?.type === 'group') {
            expect(rows[1].groupInfo.kind).toBe('patch');
            expect(rows[1].items).toHaveLength(2);
            expect(getToolActivityGroupSummaryCount('patch', rows[1].items, (item) => item.kind === 'tool' ? item.part : undefined)).toBe(1);
        }
    });

    test('groups task preview reads by unique file path and hides duplicate rows', () => {
        const rows = collectToolActivityRowsFromToolParts([
            toolPart('read', { input: { filePath: 'src/a.ts' } }, 'read-1'),
            toolPart('view', { input: { path: 'src/a.ts' } }, 'read-2'),
            toolPart('file_read', { input: { file_path: 'src/b.ts' } }, 'read-3'),
        ]);

        expect(rows).toHaveLength(1);
        expect(rows[0]?.type).toBe('group');
        if (rows[0]?.type === 'group') {
            expect(rows[0].groupInfo.kind).toBe('read');
            expect(rows[0].items).toHaveLength(2);
            expect(getToolActivityGroupSummaryCount('read', rows[0].items, (part) => part)).toBe(2);
        }
    });

    test('deduplicates repeated identical read tool activity for one file', () => {
        const rows = collectToolActivityRowsFromToolParts([
            toolPart('read', { input: { filePath: 'src/a.ts' }, status: 'completed' }, 'read-1'),
            toolPart('view', { input: { path: './src/a.ts' }, status: 'completed' }, 'read-2'),
            toolPart('file_read', { input: { file_path: 'src/a.ts' }, status: 'completed' }, 'read-3'),
            toolPart('read', { metadata: { path: 'src/a.ts' }, status: 'completed' }, 'read-4'),
        ]);

        expect(rows).toHaveLength(1);
        expect(rows[0]?.type).toBe('group');
        if (rows[0]?.type === 'group') {
            expect(rows[0].groupInfo.kind).toBe('read');
            expect(rows[0].items).toHaveLength(1);
            expect(getToolActivityGroupSummaryCount('read', rows[0].items, (part) => part)).toBe(1);
        }
    });

    test('keeps read activity separate when status or range metadata differs', () => {
        const rows = collectToolActivityRowsFromToolParts([
            toolPart('read', { input: { filePath: 'src/a.ts' }, status: 'running' }, 'read-1'),
            toolPart('read', { input: { filePath: 'src/a.ts' }, status: 'completed' }, 'read-2'),
            toolPart('read', { input: { filePath: 'src/a.ts', offset: 50 }, status: 'completed' }, 'read-3'),
        ]);

        expect(rows).toHaveLength(1);
        expect(rows[0]?.type).toBe('group');
        if (rows[0]?.type === 'group') {
            expect(rows[0].groupInfo.kind).toBe('read');
            expect(rows[0].items).toHaveLength(3);
            expect(getToolActivityGroupSummaryCount('read', rows[0].items, (part) => part)).toBe(1);
        }
    });

    test('groups task preview searches by unique result file path', () => {
        const rows = collectToolActivityRowsFromToolParts([
            toolPart('grep', { output: 'src/a.ts:1:alpha\nsrc/b.ts:2:beta' }, 'grep-1'),
            toolPart('glob', { output: 'src/b.ts\nsrc/c.ts' }, 'glob-1'),
        ]);

        expect(rows).toHaveLength(1);
        expect(rows[0]?.type).toBe('group');
        if (rows[0]?.type === 'group') {
            expect(rows[0].groupInfo.kind).toBe('search');
            expect(rows[0].items).toHaveLength(2);
            expect(getToolActivityGroupSummaryCount('search', rows[0].items, (part) => part)).toBe(3);
        }
    });

    test('consolidates task preview reads across shell commands', () => {
        const rows = collectToolActivityRowsFromToolParts([
            toolPart('read', { input: { filePath: 'src/a.ts' } }, 'read-1'),
            toolPart('bash', { input: { command: 'pwd' } }, 'bash-1'),
            toolPart('read', { input: { filePath: 'src/b.ts' } }, 'read-2'),
            toolPart('shell', { input: { command: 'ls' } }, 'bash-2'),
        ]);

        expect(rows).toHaveLength(2);
        expect(rows[0]?.type).toBe('group');
        expect(rows[1]?.type).toBe('group');
        if (rows[0]?.type === 'group') {
            expect(rows[0].groupInfo.kind).toBe('read');
            expect(rows[0].items).toHaveLength(2);
        }
        if (rows[1]?.type === 'group') {
            expect(rows[1].groupInfo.kind).toBe('shell');
            expect(rows[1].items).toHaveLength(2);
            expect(getToolActivityGroupSummaryCount('shell', rows[1].items, (part) => part)).toBe(2);
        }
    });

    test('hides raw mkdir tool activity without hiding shell commands that create directories', () => {
        const rows = collectToolActivityRowsFromToolParts([
            toolPart('mkdir', { input: { path: '__tests__' } }, 'mkdir-1'),
            toolPart('bash', { input: { command: 'mkdir -p __tests__' } }, 'bash-1'),
            toolPart('read', { input: { filePath: 'src/a.ts' } }, 'read-1'),
        ]);

        expect(rows).toHaveLength(2);
        expect(rows.some((row) => row.type === 'item' && row.item.tool === 'mkdir')).toBe(false);
        expect(rows[0]?.type).toBe('group');
        if (rows[0]?.type === 'group') {
            expect(rows[0].groupInfo.kind).toBe('shell');
            expect(rows[0].items.map((part) => part.tool)).toEqual(['bash']);
        }
        expect(rows[1]?.type).toBe('group');
        if (rows[1]?.type === 'group') {
            expect(rows[1].groupInfo.kind).toBe('read');
        }
    });

    test('hides raw DevRyan managed-task tool activity', () => {
        const rows = collectToolActivityRowsFromToolParts([
            toolPart('devryan_task', { input: { action: 'start' } }, 'managed-task-1'),
        ]);

        expect(rows).toEqual([]);
    });

    test('labels shell rollups as command counts', () => {
        expect(getToolActivityGroupInfo('bash')?.kind).toBe('shell');
        expect(getToolActivityGroupInfo('oc_bash')?.kind).toBe('shell');
        expect(getToolActivityGroupInfo('shellCommandToolCall')?.kind).toBe('shell');
        expect(getToolActivityGroupLabelKey('shell', 1)).toBe('chat.toolGroup.ranCommandSingle');
        expect(getToolActivityGroupLabelKey('shell', 2)).toBe('chat.toolGroup.ranCommandPlural');
        expect(dict['chat.toolGroup.ranCommandSingle']).toBe('Ran {count} command');
        expect(dict['chat.toolGroup.ranCommandPlural']).toBe('Ran {count} commands');

        const rows = collectToolActivityRowsFromToolParts([
            toolPart('oc_bash', { input: { command: 'pwd' } }, 'oc-bash-1'),
        ]);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.type).toBe('group');
        if (rows[0]?.type === 'group') {
            expect(rows[0].groupInfo.kind).toBe('shell');
            expect(getToolActivityGroupSummaryCount('shell', rows[0].items, (part) => part)).toBe(1);
        }
    });

    test('keeps created, edited, and unclassified writes in separate count-based groups', () => {
        const rows = collectToolActivityRowsFromToolParts([
            toolPart('oc_write', { input: { path: 'db/a.sql' }, metadata: { exists: false } }, 'create-1'),
            toolPart('oc_write', { input: { path: 'db/a.sql' }, metadata: { exists: false } }, 'create-2'),
            toolPart('oc_edit', { input: { path: 'db/b.sql' } }, 'edit-1'),
            toolPart('oc_write', { input: { path: 'db/c.sql' } }, 'write-unknown'),
        ]);

        const groups = rows.filter((row) => row.type === 'group');
        expect(groups).toHaveLength(3);
        if (groups[0]?.type === 'group') {
            expect(groups[0].groupInfo.fileMutationAction).toBe('created');
            expect(getToolActivityGroupSummaryCount('edit', groups[0].items, (part) => part)).toBe(1);
        }
        if (groups[1]?.type === 'group') {
            expect(groups[1].groupInfo.fileMutationAction).toBe('edited');
            expect(getToolActivityGroupSummaryCount('edit', groups[1].items, (part) => part)).toBe(1);
        }
        if (groups[2]?.type === 'group') {
            expect(groups[2].groupInfo.fileMutationAction).toBe('wrote');
            expect(getToolActivityGroupSummaryCount('edit', groups[2].items, (part) => part)).toBe(1);
        }
    });

    test('bridges file groups across assistant tool-call messages in live rendering', () => {
        const items = [
            { messageId: 'message-1', kind: 'tool' as const, tool: 'oc_write', part: toolPart('oc_write', { input: { path: 'db/a.sql' }, metadata: { exists: false } }, 'create-1') },
            { messageId: 'message-2', kind: 'tool' as const, tool: 'oc_write', part: toolPart('oc_write', { input: { path: 'db/b.sql' }, metadata: { exists: false } }, 'create-2') },
        ];

        const groups = collectCrossMessageFileActivityGroups(items, {
            getToolName: (item) => item.tool,
            getToolPart: (item) => item.part,
            getMessageId: (item) => item.messageId,
        });

        expect(groups).toHaveLength(1);
        expect(groups[0]?.groupInfo.fileMutationAction).toBe('created');
        expect(groups[0]?.items.map((item) => item.part.id)).toEqual(['create-1', 'create-2']);
        expect(getToolActivityGroupSummaryCount('edit', groups[0]?.items ?? [], (item) => item.part)).toBe(2);
    });

    test('renders one passive browser activity for a 15-command narrated turn in sorted and live modes', () => {
        type BrowserTurnItem = {
            messageId: string;
            kind: 'tool' | 'reasoning';
            tool?: string;
            part?: ToolPart;
        };
        const makeItems = (finalStatus: 'running' | 'completed'): BrowserTurnItem[] => (
            Array.from({ length: 15 }, (_, index) => {
                const status = index === 14 ? finalStatus : 'completed';
                const browserPart = toolPart('devryan_browser', { status }, `browser-${index + 1}`);
                return [
                    {
                        messageId: `message-${Math.floor(index / 5) + 1}`,
                        kind: 'tool' as const,
                        tool: 'devryan_browser',
                        part: browserPart,
                    },
                    {
                        messageId: `message-${Math.floor(index / 5) + 1}`,
                        kind: 'reasoning' as const,
                    },
                ];
            }).flat()
        );
        const options = {
            getToolName: (item: BrowserTurnItem) => item.tool ?? '',
            getToolPart: (item: BrowserTurnItem) => item.part,
            getMessageId: (item: BrowserTurnItem) => item.messageId,
            isReasoningOrJustification: (item: BrowserTurnItem) => item.kind === 'reasoning',
        };

        for (const status of ['running', 'completed'] as const) {
            const items = makeItems(status);
            const sortedRows = collectToolActivityRows(items, options);
            const sortedBrowserRows = sortedRows.filter((row) => (
                row.type === 'group' && row.groupInfo.kind === 'browser'
            ));
            expect(sortedBrowserRows).toHaveLength(1);
            if (sortedBrowserRows[0]?.type === 'group') {
                expect(sortedBrowserRows[0].items).toHaveLength(15);
                expect(getToolActivityGroupSummaryCount('browser', sortedBrowserRows[0].items, options.getToolPart)).toBe(1);
            }

            const liveGroups = collectCrossMessageFileActivityGroups(items, options)
                .filter((group) => group.groupInfo.kind === 'browser');
            expect(liveGroups).toHaveLength(1);
            expect(liveGroups[0]?.items).toHaveLength(15);
        }

        expect(getToolActivityGroupInfo('devryan_browser')?.kind).toBe('browser');
        expect(getToolActivityGroupLabelKey('browser', 1)).toBe('chat.toolGroup.usingDevRyanBrowser');
        expect(dict['chat.toolGroup.usingDevRyanBrowser']).toBe('Using DevRyan Browser');
    });

    test('does not bridge a single-message file burst or unrelated tool groups', () => {
        const sameMessageWrites = [
            { messageId: 'message-1', tool: 'oc_write', part: toolPart('oc_write', { input: { path: 'db/a.sql' }, metadata: { exists: false } }, 'create-1') },
            { messageId: 'message-1', tool: 'oc_write', part: toolPart('oc_write', { input: { path: 'db/b.sql' }, metadata: { exists: false } }, 'create-2') },
        ];
        const shellCalls = [
            { messageId: 'message-1', tool: 'bash', part: toolPart('bash', { input: { command: 'pwd' } }, 'bash-1') },
            { messageId: 'message-2', tool: 'bash', part: toolPart('bash', { input: { command: 'ls' } }, 'bash-2') },
        ];
        const options = {
            getToolName: (item: (typeof sameMessageWrites)[number]) => item.tool,
            getToolPart: (item: (typeof sameMessageWrites)[number]) => item.part,
            getMessageId: (item: (typeof sameMessageWrites)[number]) => item.messageId,
        };

        expect(collectCrossMessageFileActivityGroups(sameMessageWrites, options)).toEqual([]);
        expect(collectCrossMessageFileActivityGroups(shellCalls, options)).toEqual([]);
    });

    test('keeps failed file calls grouped with their attempted action and extracted path', () => {
        const rows = collectToolActivityRowsFromToolParts([
            toolPart('oc_write', {
                status: 'error',
                input: { path: 'db/failed.sql' },
                metadata: { exists: false },
                error: 'write failed',
            }, 'failed-create'),
            toolPart('stat', {
                status: 'error',
                input: { path: 'db/missing.sql' },
                error: 'missing',
            }, 'failed-stat'),
        ]);

        expect(rows).toHaveLength(2);
        if (rows[0]?.type === 'group') {
            expect(rows[0].groupInfo.fileMutationAction).toBe('created');
            expect(extractEditedFilePathsFromToolPart(rows[0].items[0])).toEqual(['db/failed.sql']);
        }
        if (rows[1]?.type === 'group') {
            expect(rows[1].groupInfo.kind).toBe('read');
            expect(extractReadFilePathsFromToolPart(rows[1].items[0])).toEqual(['db/missing.sql']);
        }
    });

    test('consolidates reads across standalone task tools', () => {
        const rows = collectToolActivityRowsFromToolParts([
            toolPart('read', { input: { filePath: 'src/a.ts' } }, 'read-1'),
            toolPart('task', { input: { description: 'Nested task' } }, 'task-1'),
            toolPart('read', { input: { filePath: 'src/b.ts' } }, 'read-2'),
        ]);

        expect(rows).toHaveLength(2);
        expect(rows[0]?.type).toBe('group');
        if (rows[0]?.type === 'group') {
            expect(rows[0].groupInfo.kind).toBe('read');
            expect(rows[0].items).toHaveLength(2);
        }
        expect(rows[1]?.type).toBe('item');
        if (rows[1]?.type === 'item') {
            expect(rows[1].item.tool).toBe('task');
        }
    });
});

describe('tool activity summary extraction', () => {
    test('totals structured patch file stats for tool badges', () => {
        const part = toolPart('apply_patch', {
            metadata: {
                files: [
                    { relativePath: 'src/a.ts', additions: 2, deletions: 1 },
                    { relativePath: 'src/b.ts', additions: 4, deletions: 0 },
                ],
            },
        });

        expect(getToolPartDiffStatsFromToolPart(part)).toEqual({ additions: 6, deletions: 1 });
    });

    test('does not expose anonymous raw patch text as a scoped tool badge', () => {
        const part = toolPart('apply_patch', {
            metadata: {
                patch: '--- a/big.ts\n+++ b/big.ts\n@@ -1,2 +1 @@\n-old\n-removed\n+new',
            },
        });

        expect(getToolPartDiffStatsFromToolPart(part)).toBeNull();
    });

    test('keeps raw patch stats when tied to an explicit edited file path', () => {
        const part = toolPart('edit', {
            input: { filePath: 'src/a.ts' },
            metadata: {
                patch: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n-old\n+new\n+line',
            },
        });

        expect(getToolPartDiffStatsFromToolPart(part)).toEqual({ additions: 2, deletions: 1 });
    });

    test('extracts patch files and diff stats from metadata', () => {
        const part = toolPart('apply_patch', {
            metadata: {
                files: [
                    {
                        relativePath: 'src/a.ts',
                        patch: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n-old\n+new\n+line',
                    },
                ],
            },
        });

        const summaries = extractPatchFileSummariesFromToolPart(part);
        expect(summaries).toHaveLength(1);
        expect(summaries[0]?.path).toBe('src/a.ts');
        expect(summaries[0]?.additions).toBe(2);
        expect(summaries[0]?.deletions).toBe(1);
    });

    test('extracts Cursor patch files from patchText input', () => {
        const part = toolPart('applyPatchToolCall', {
            input: {
                patchText: '--- a/src/cursor.ts\n+++ b/src/cursor.ts\n@@ -1 +1,2 @@\n-old\n+new\n+line',
            },
        });

        const summaries = extractPatchFileSummariesFromToolPart(part);
        expect(summaries).toHaveLength(1);
        expect(summaries[0]?.path).toBe('src/cursor.ts');
        expect(summaries[0]?.additions).toBe(2);
        expect(summaries[0]?.deletions).toBe(1);
    });

    test('extracts Cursor patch aliases from patch-like input', () => {
        for (const tool of ['patchToolCall', 'filePatchToolCall', 'applyDiffToolCall']) {
            const summaries = extractPatchFileSummariesFromToolPart(toolPart(tool, {
                input: {
                    patchText: '--- a/src/alias.ts\n+++ b/src/alias.ts\n@@ -1 +1,2 @@\n-old\n+new\n+line',
                },
            }));

            expect(summaries).toHaveLength(1);
            expect(summaries[0]?.path).toBe('src/alias.ts');
            expect(summaries[0]?.additions).toBe(2);
            expect(summaries[0]?.deletions).toBe(1);
        }
    });

    test('merges repeated patch summaries by normalized file path with cumulative stats', () => {
        const first = toolPart('apply_patch', {
            metadata: {
                files: [{
                    relativePath: './src/a.ts',
                    additions: 2,
                    deletions: 1,
                    patch: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n-old\n+new\n+line',
                }],
            },
        }, 'patch-1');
        const second = toolPart('apply_patch', {
            metadata: {
                files: [{
                    relativePath: 'src/a.ts',
                    additions: 3,
                    deletions: 0,
                    patch: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -8 +8,2 @@\n-old2\n+new2\n+line2',
                }],
            },
        }, 'patch-2');

        const summaries = mergePatchFileSummariesFromToolParts([first, second]);

        expect(summaries).toHaveLength(1);
        expect(summaries[0]?.path).toBe('src/a.ts');
        expect(summaries[0]?.additions).toBe(5);
        expect(summaries[0]?.deletions).toBe(1);
        expect(summaries[0]?.patch).toContain('new');
        expect(summaries[0]?.patch).toContain('new2');
    });

    test('extracts searched files from grep and glob output', () => {
        expect(extractSearchedFilePathsFromToolPart(toolPart('grep', { output: 'src/a.ts:10:hello\nsrc/b.ts:20:world' }))).toEqual(['src/a.ts', 'src/b.ts']);
        expect(extractSearchedFilePathsFromToolPart(toolPart('ripgrep', { output: 'src/a.ts:10:4:hello\nsrc/b.ts:20:8:world' }))).toEqual(['src/a.ts', 'src/b.ts']);
        expect(extractSearchedFilePathsFromToolPart(toolPart('glob', { output: 'src/a.ts\nsrc/nested/b.ts' }))).toEqual(['src/a.ts', 'src/nested/b.ts']);
    });

    test('extracts Cursor SDK legacy top-level tool data for activity labels', () => {
        const searched = {
            id: 'cursor-grep',
            type: 'tool',
            tool: 'grep',
            input: { pattern: 'Open request form' },
            output: 'src/a.ts:10:Open request form\nsrc/b.ts:20:Open request form',
            state: { status: 'completed' },
            messageID: 'message-1',
        } as unknown as ToolPart;
        const read = {
            id: 'cursor-read',
            type: 'tool',
            tool: 'read',
            input: { path: 'src/a.ts' },
            state: { status: 'completed' },
            messageID: 'message-1',
        } as unknown as ToolPart;
        const patched = {
            id: 'cursor-patch',
            type: 'tool',
            tool: 'apply_patch',
            input: {
                patchText: '--- a/src/c.ts\n+++ b/src/c.ts\n@@ -1 +1,2 @@\n-old\n+new\n+line',
            },
            state: { status: 'completed' },
            messageID: 'message-1',
        } as unknown as ToolPart;

        expect(extractSearchedFilePathsFromToolPart(searched)).toEqual(['src/a.ts', 'src/b.ts']);
        expect(extractReadFilePathsFromToolPart(read)).toEqual(['src/a.ts']);
        expect(extractPatchFileSummariesFromToolPart(patched).map((summary) => summary.path)).toEqual(['src/c.ts']);
        expect(getToolActivityGroupSummaryCount('search', [searched], (part) => part)).toBe(2);
        expect(getToolActivityGroupSummaryCount('read', [read], (part) => part)).toBe(1);
        expect(getToolActivityGroupSummaryCount('patch', [patched], (part) => part)).toBe(1);
    });

    test('ignores read line snippets in search output', () => {
        const output = [
            'packages/ui/src/stores/useAgentsStore.ts:',
            "Line 5: import { create } from '../lib/state';",
            'packages/ui/src/components/session/SessionSidebar.tsx:',
            'packages/ui/src/components/sections/openchamber/VoiceSettings.tsx:',
            "Line 23: import { getSelectableVoiceInputProviders } from './voiceSettingsUtils';",
            'Line 388: && prev.onOpenSettings === next.onOpenSettings',
            'app-icon white.svg',
            '.env',
        ].join('\n');

        expect(extractSearchedFilePathsFromToolPart(toolPart('search', { output }))).toEqual([
            'packages/ui/src/stores/useAgentsStore.ts',
            'packages/ui/src/components/session/SessionSidebar.tsx',
            'packages/ui/src/components/sections/openchamber/VoiceSettings.tsx',
            'app-icon white.svg',
            '.env',
        ]);
    });

    test('does not treat code snippets as searched files', () => {
        const output = [
            "Line 12: const url = 'https://example.com/a//b';",
            "Line 13: const alias = '@/components/chat/ChatInput';",
            "Line 14: import value from '../stores/useAgentsStore';",
            "Line 15: if (path === 'packages/ui/src/App.tsx') return;",
        ].join('\n');

        expect(extractSearchedFilePathsFromToolPart(toolPart('search', { output }))).toEqual([]);
        expect(getToolActivityGroupSummaryCount('search', [toolPart('search', { output })], (part) => part)).toBe(1);
    });

    test('extracts read file paths from input and metadata', () => {
        expect(extractReadFilePathsFromToolPart(toolPart('read', { input: { filePath: 'src/a.ts' } }))).toEqual(['src/a.ts']);
        expect(extractReadFilePathsFromToolPart(toolPart('view', { metadata: { path: 'src/b.ts' } }))).toEqual(['src/b.ts']);
        expect(extractReadFilePathsFromToolPart(toolPart('readToolCall', { input: { file: 'src/c.ts' } }))).toEqual(['src/c.ts']);
    });

    test('extracts edited file paths only from string path fields', () => {
        expect(extractEditedFilePathsFromToolPart(toolPart('edit', {
            input: { filePath: { path: 'not-a-string' }, path: 'src/a.ts' },
            metadata: {
                path: 123,
                files: [
                    { filePath: ['not-a-string'] },
                    { relativePath: 'src/b.ts' },
                ],
            },
        }))).toEqual(['src/a.ts', 'src/b.ts']);
    });

    test('extracts Cursor write target paths from path aliases', () => {
        expect(extractEditedFilePathsFromToolPart(toolPart('writeToolCall', {
            input: { targetFile: 'src/cursor-write.ts', fileText: 'const value = 1\n' },
        }))).toEqual(['src/cursor-write.ts']);
    });

    test('extracts fetched urls from input and metadata', () => {
        expect(extractFetchedUrlsFromToolPart(toolPart('webfetch', { input: { url: 'https://example.com/a' } }))).toEqual(['https://example.com/a']);
        expect(extractFetchedUrlsFromToolPart(toolPart('fetch', { metadata: { URL: 'https://example.com/b' } }))).toEqual(['https://example.com/b']);
    });

    test('counts fetched urls using exact url keys', () => {
        const first = toolPart('fetch', { input: { url: 'https://example.com/a//b' } }, 'fetch-1');
        const second = toolPart('fetch', { input: { url: 'https://example.com/a/b' } }, 'fetch-2');

        expect(getToolActivityGroupSummaryCount('fetch', [first, second], (part) => part)).toBe(2);
    });
});
