import { describe, expect, test } from 'bun:test';
import type { Part } from '@opencode-ai/sdk/v2';

import {
    assistantRowRendersContent,
    projectAssistantDisplayParts,
    projectAssistantVisibleParts,
    selectAssistantHeaderTargetId,
} from './assistantRowContent';

const part = (value: Record<string, unknown>): Part => value as unknown as Part;

const textPart = (text: string, id = 'p_text'): Part => part({ id, type: 'text', text });
const reasoningPart = (text = 'thinking about it', id = 'p_reasoning'): Part => part({
    id,
    type: 'reasoning',
    text,
});

/** A managed control call — the orchestrator polling a running sub-agent. */
const managedControlPart = (action: string, id = 'p_managed'): Part => part({
    id,
    type: 'tool',
    tool: 'devryan_task',
    callID: `call_${id}`,
    state: { status: 'completed', input: { action }, output: '{}' },
});

const managedStartPart = (
    { taskId, status = 'completed' }: { taskId?: string; status?: string },
    id = 'p_start',
): Part => part({
    id,
    type: 'tool',
    tool: 'devryan_task',
    callID: `call_${id}`,
    state: {
        status,
        input: { action: 'start', agent: 'fixer', label: 'Verify navigation' },
        output: taskId ? JSON.stringify({ task: { taskId } }) : '{}',
    },
});

const EMPTY_ROW = { parts: [] as Part[] };

describe('assistantRowRendersContent', () => {
    test('reports nothing for the empty assistant shells the sync reducer can create', () => {
        // message.updated inserts info with zero parts; step-start/step-finish/patch
        // are dropped before they ever reach the store.
        expect(assistantRowRendersContent({ parts: [] })).toBe(false);
        expect(assistantRowRendersContent({ parts: [textPart('   \n  ')] })).toBe(false);
        expect(assistantRowRendersContent({
            parts: [part({ id: 'p1', type: 'compaction' })],
        })).toBe(false);
        expect(assistantRowRendersContent({
            parts: [part({ id: 'p1', type: 'patch', hash: 'abc' })],
        })).toBe(false);
    });

    test('reports nothing for an orchestrator poll message while a sub-agent runs', () => {
        // The regression: reasoning is suppressed for a pure managed-control
        // message and the dispatch card belongs to another row, so this paints
        // nothing — yet it used to stamp a full "agent · model" header.
        for (const action of ['status', 'wait', 'continue', 'resume']) {
            expect(assistantRowRendersContent({
                parts: [reasoningPart(), managedControlPart(action)],
            })).toBe(false);
        }
    });

    test('reports content for a managed dispatch that owns tasks or pending work', () => {
        expect(assistantRowRendersContent({
            parts: [managedStartPart({ taskId: 'dvr_task_abc123' })],
        })).toBe(true);

        expect(assistantRowRendersContent({
            parts: [managedStartPart({ status: 'running' })],
        })).toBe(true);
    });

    test('reports content for ordinary assistant output', () => {
        expect(assistantRowRendersContent({ parts: [textPart('Here is the answer.')] })).toBe(true);
        expect(assistantRowRendersContent({ parts: [reasoningPart()] })).toBe(true);
        expect(assistantRowRendersContent({
            parts: [part({ id: 'p1', type: 'file', mime: 'image/png', url: 'blob:x' })],
        })).toBe(true);
        expect(assistantRowRendersContent({
            parts: [part({
                id: 'p1',
                type: 'tool',
                tool: 'read',
                callID: 'call_1',
                state: { status: 'completed', input: {}, output: 'ok' },
            })],
        })).toBe(true);
    });

    test('ignores hidden tools unless the row also carries real content', () => {
        const hiddenOnly = [part({
            id: 'p1',
            type: 'tool',
            tool: 'create_plan',
            callID: 'call_1',
            state: { status: 'completed', input: {}, output: 'plan' },
        })];

        expect(assistantRowRendersContent({ parts: hiddenOnly })).toBe(false);
        expect(assistantRowRendersContent({
            parts: [...hiddenOnly, textPart('## Plan\n\nStep one.')],
        })).toBe(true);
    });

    test('reports content for a cursor-native task projection', () => {
        expect(assistantRowRendersContent({
            parts: [part({
                id: 'p_task',
                type: 'tool',
                tool: 'task',
                callID: 'call_task',
                state: {
                    status: 'running',
                    input: { description: 'Investigate' },
                    metadata: { cursorNativeTask: { schemaVersion: 1, source: 'cursor-native' } },
                },
            })],
        })).toBe(true);
    });

    test('every ownership override keeps an otherwise-empty row reporting content', () => {
        expect(assistantRowRendersContent({ ...EMPTY_ROW, isLiveStreamingRow: true })).toBe(true);
        expect(assistantRowRendersContent({ ...EMPTY_ROW, hasErrorSurface: true })).toBe(true);
        expect(assistantRowRendersContent({ ...EMPTY_ROW, ownsManagedTaskCard: true })).toBe(true);
        expect(assistantRowRendersContent({ ...EMPTY_ROW, ownsAssistantImages: true })).toBe(true);
        expect(assistantRowRendersContent({ ...EMPTY_ROW, ownsActivityOutput: true })).toBe(true);
    });

    test('suppressed intermediate status text does not count as content', () => {
        // messageFinish === 'tool-calls' drops throwaway status narration; a row
        // left with only a managed control call still paints nothing.
        expect(assistantRowRendersContent({
            parts: [textPart('Waiting on the dispatch status.'), managedControlPart('wait')],
            messageFinish: 'tool-calls',
        })).toBe(false);
    });
});

describe('selectAssistantHeaderTargetId', () => {
    test('promotes the header to the first row that renders content', () => {
        expect(selectAssistantHeaderTargetId(['a', 'b', 'c'], new Set(['b', 'c']))).toBe('b');
    });

    test('keeps the first row when it already renders content', () => {
        expect(selectAssistantHeaderTargetId(['a', 'b'], new Set(['a', 'b']))).toBe('a');
    });

    test('returns null when no row in the turn renders anything', () => {
        expect(selectAssistantHeaderTargetId(['a', 'b'], new Set())).toBeNull();
        expect(selectAssistantHeaderTargetId([], new Set(['a']))).toBeNull();
    });
});

describe('shared part projections', () => {
    test('projectAssistantDisplayParts drops synthetic system reminders and patches', () => {
        const { visibleParts, displayParts } = projectAssistantDisplayParts({
            parts: [
                part({ id: 'p1', type: 'text', text: '<system-reminder>hi</system-reminder>', synthetic: true }),
                textPart('real answer', 'p2'),
                part({ id: 'p3', type: 'patch', hash: 'abc' }),
            ],
        });

        expect(visibleParts.map((entry) => entry.id)).toEqual(['p2']);
        expect(displayParts.map((entry) => entry.id)).toEqual(['p2']);
    });

    test('projectAssistantDisplayParts honours includeReasoning', () => {
        const parts = [reasoningPart(), textPart('answer', 'p2')];

        expect(projectAssistantDisplayParts({ parts }).visibleParts).toHaveLength(2);
        expect(projectAssistantDisplayParts({ parts, includeReasoning: false }).visibleParts)
            .toHaveLength(1);
    });

    test('projectAssistantVisibleParts keeps managed task parts but drops other hidden tools', () => {
        const { visibleParts } = projectAssistantVisibleParts([
            managedControlPart('wait', 'p_managed'),
            part({
                id: 'p_hidden',
                type: 'tool',
                tool: 'mkdir',
                callID: 'call_hidden',
                state: { status: 'completed', input: {}, output: '' },
            }),
            textPart('   ', 'p_blank'),
        ]);

        expect(visibleParts.map((entry) => entry.id)).toEqual(['p_managed']);
    });
});
