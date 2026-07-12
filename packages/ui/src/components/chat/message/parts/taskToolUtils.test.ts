import { describe, expect, test } from 'bun:test';
import {
    buildTaskSessionMessagesSignature,
    buildTaskSummaryEntriesFromSession,
    formatSpecialistTaskOutputForMarkdown,
    formatTaskErrorText,
    formatTaskModelLabel,
    normalizeTaskSummaryEntries,
    parseTaskMetadataBlock,
    readTaskSessionIdFromOutput,
    resolveTaskResultPresentation,
    stripTaskMetadataFromOutput,
    type SessionMessageWithParts,
} from './taskToolUtils';

describe('task tool metadata helpers', () => {
    test('formats string and structured Cursor task models without inferring missing data', () => {
        expect(formatTaskModelLabel(' composer-2.5 ')).toBe('Composer 2.5');
        expect(formatTaskModelLabel({
            id: 'composer-2.5',
            params: [
                { id: 'fast', value: 'false' },
                { id: 'effort', value: 'medium' },
            ],
        })).toBe('Composer 2.5 (fast=false, effort=medium)');
        expect(formatTaskModelLabel(undefined)).toBe('');
        expect(formatTaskModelLabel({ params: [{ id: 'fast', value: 'false' }] })).toBe('');
        expect(formatTaskModelLabel({ id: 'composer-2.5', params: [{ id: '', value: 'false' }] })).toBe('Composer 2.5');
    });

    test('formats fixer result sections as markdown without dropping content', () => {
        const output = [
            '<summary>',
            'Implemented the approved regression fix for the admin dashboard summary strip.',
            '</summary>',
            '<changes>',
            '- `src/components/admin/dashboard/KPICommandBar.tsx`:',
            '  - Added explicit blocking error and no-data states.',
            '</changes>',
            '<verification>',
            '- Tests passed: yes',
            '- Validation: passed',
            '</verification>',
            '<status>complete</status>',
        ].join('\n');

        expect(formatSpecialistTaskOutputForMarkdown(output)).toBe([
            '### Summary',
            '',
            'Implemented the approved regression fix for the admin dashboard summary strip.',
            '',
            '### Changes',
            '',
            '- `src/components/admin/dashboard/KPICommandBar.tsx`:',
            '  - Added explicit blocking error and no-data states.',
            '',
            '### Verification',
            '',
            '- Tests passed: yes',
            '- Validation: passed',
            '',
            '**Status:** complete',
        ].join('\n'));
    });

    test('formats explorer result sections as markdown without dropping content', () => {
        const output = [
            '<results>',
            '<files>',
            '- /repo/src/App.tsx:42 - App shell entrypoint',
            '</files>',
            '<answer>',
            'The likely edit point is the shared chat message renderer.',
            '</answer>',
            '<confidence>high</confidence>',
            '<next_searches>',
            '- `rg "TaskToolSummary" packages/ui/src`',
            '</next_searches>',
            '<status>complete</status>',
            '</results>',
        ].join('\n');

        expect(formatSpecialistTaskOutputForMarkdown(output)).toBe([
            '### Files',
            '',
            '- /repo/src/App.tsx:42 - App shell entrypoint',
            '',
            '### Answer',
            '',
            'The likely edit point is the shared chat message renderer.',
            '',
            '**Confidence:** high',
            '',
            '### Next Searches',
            '',
            '- `rg "TaskToolSummary" packages/ui/src`',
            '',
            '**Status:** complete',
        ].join('\n'));
    });

    test('formats specialist output after task metadata stripping', () => {
        const output = [
            '<summary>Completed focused changes.</summary>',
            '<status>complete</status>',
            '<task_metadata>{"sessionId":"child-session"}</task_metadata>',
        ].join('\n');

        const visibleOutput = stripTaskMetadataFromOutput(output);

        expect(formatSpecialistTaskOutputForMarkdown(visibleOutput)).toBe([
            '### Summary',
            '',
            'Completed focused changes.',
            '',
            '**Status:** complete',
        ].join('\n'));
    });

    test('leaves unknown and malformed tag output unchanged', () => {
        const unknown = '<note>Keep this custom XML visible as-is.</note>';
        const malformed = '<summary>Missing close tag';

        expect(formatSpecialistTaskOutputForMarkdown(unknown)).toBe(unknown);
        expect(formatSpecialistTaskOutputForMarkdown(malformed)).toBe(malformed);
    });

    test('leaves code-fenced XML-like content unchanged', () => {
        const output = [
            '```xml',
            '<summary>Keep this literal XML sample.</summary>',
            '<status>complete</status>',
            '```',
        ].join('\n');

        expect(formatSpecialistTaskOutputForMarkdown(output)).toBe(output);
    });

    test('parses task metadata session id and summary entries', () => {
        const output = [
            'completed work',
            '<task_metadata>{"sessionId":"child-session","summary":[{"tool":"read","title":"src/app.ts","status":"completed"}]}</task_metadata>',
        ].join('\n');

        expect(readTaskSessionIdFromOutput(output)).toBe('child-session');
        expect(stripTaskMetadataFromOutput(output)).toBe('completed work');
        expect(parseTaskMetadataBlock(output).summaryEntries).toEqual([
            {
                id: undefined,
                tool: 'read',
                state: {
                    status: 'completed',
                    title: 'src/app.ts',
                    input: undefined,
                    metadata: undefined,
                    output: undefined,
                    error: undefined,
                },
            },
        ]);
    });

    test('falls back to legacy task id output', () => {
        expect(readTaskSessionIdFromOutput('task_id: child-legacy')).toBe('child-legacy');
        expect(readTaskSessionIdFromOutput('session id: child spaced')).toBe('child');
    });

    test('normalizes string and object summary entries', () => {
        expect(normalizeTaskSummaryEntries([
            'Plain summary',
            {
                id: 'tool-1',
                tool: 'bash',
                status: 'completed',
                input: { command: 'bun test' },
            },
        ])).toEqual([
            {
                tool: 'tool',
                state: { status: 'completed', title: 'Plain summary' },
            },
            {
                id: 'tool-1',
                tool: 'bash',
                state: {
                    status: 'completed',
                    title: undefined,
                    input: { command: 'bun test' },
                    metadata: undefined,
                    output: undefined,
                    error: undefined,
                },
            },
        ]);
    });

    test('builds final child activity from assistant tools only and excludes nested task/todo tools', () => {
        const messages = [
            {
                info: { role: 'user', id: 'user-1', time: { created: 1 } },
                parts: [{ type: 'tool', id: 'ignored-user-tool', tool: 'read' }],
            },
            {
                info: { role: 'assistant', id: 'assistant-1', time: { created: 2 } },
                parts: [
                    { type: 'tool', id: 'read-1', tool: 'read', state: { status: 'completed', input: { path: 'src/app.ts' } } },
                    { type: 'tool', id: 'task-1', tool: 'task', state: { status: 'completed' } },
                    { type: 'tool', id: 'todo-1', tool: 'todowrite', state: { status: 'completed' } },
                    { type: 'tool', id: 'bash-1', tool: 'bash', state: { status: 'completed', input: { command: 'bun test' } } },
                ],
            },
        ] as unknown as SessionMessageWithParts[];

        expect(buildTaskSummaryEntriesFromSession(messages).map((entry) => entry.tool)).toEqual(['read', 'bash']);
    });

    test('session message signature tracks tail changes', () => {
        const base = [{
            info: { role: 'assistant', id: 'assistant-1', time: { created: 2 } },
            parts: [{ type: 'text', id: 'text-1', text: 'hello' }],
        }] as unknown as SessionMessageWithParts[];
        const changed = [{
            info: { role: 'assistant', id: 'assistant-1', time: { created: 2 } },
            parts: [{ type: 'text', id: 'text-1', text: 'hello world' }],
        }] as unknown as SessionMessageWithParts[];

        expect(buildTaskSessionMessagesSignature(base)).not.toBe(buildTaskSessionMessagesSignature(changed));
    });

    test('formats denied task tool errors instead of treating them as unavailable activity', () => {
        expect(formatTaskErrorText('The user has specified a rule which prevents you from using this specific tool call.')).toBe(
            'Task could not start: The user has specified a rule which prevents you from using this specific tool call.'
        );
    });

    test('classifies invalid unavailable-tool task startup errors as runtime tool-surface failures', () => {
        expect(formatTaskErrorText(
            "Model tried to call unavailable tool 'invalid'. Available tools: ast_grep_search, glob, grep, read."
        )).toBe(
            'Task could not start: OpenCode emitted its internal invalid-tool sentinel while starting the subagent. This usually means the managed runtime tool surface is stale or polluted. Available tools: ast_grep_search, glob, grep, read.'
        );
    });

    test('marks retained subagent output as partial when the task fails', () => {
        expect(resolveTaskResultPresentation({
            output: 'Completed repository inspection before disconnecting.',
            error: { message: 'provider disconnected' },
            hasActivity: true,
        })).toEqual({
            hasOutput: true,
            outputKind: 'partial',
            failureText: 'Task was interrupted: provider disconnected',
        });
    });

    test('keeps successful subagent output marked complete', () => {
        expect(resolveTaskResultPresentation({
            output: 'Completed repository inspection.',
            error: undefined,
            hasActivity: true,
        })).toEqual({
            hasOutput: true,
            outputKind: 'complete',
            failureText: '',
        });
    });

    test('keeps startup failures distinct from failures after visible activity', () => {
        expect(resolveTaskResultPresentation({
            output: '',
            error: 'permission denied',
            hasActivity: false,
        })).toEqual({
            hasOutput: false,
            outputKind: 'none',
            failureText: 'Task could not start: permission denied',
        });
        expect(resolveTaskResultPresentation({
            output: '',
            error: 'provider stopped',
            hasActivity: true,
        }).failureText).toBe('Task was interrupted: provider stopped');
    });

    test('marks retained output partial when a provider-native task is cancelled without an error body', () => {
        expect(resolveTaskResultPresentation({
            output: 'Completed useful inspection before cancellation.',
            error: undefined,
            hasActivity: true,
            status: 'cancelled',
        })).toEqual({
            hasOutput: true,
            outputKind: 'partial',
            failureText: '',
            failureStatus: 'cancelled',
        });
    });
});
