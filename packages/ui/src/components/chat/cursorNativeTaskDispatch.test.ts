import { describe, expect, test } from 'bun:test';
import { resolveCursorNativeTaskDispatches } from './cursorNativeTaskDispatch';

describe('Cursor native Agent Dispatch projection', () => {
    test('projects only versioned Cursor-native task metadata', () => {
        expect(resolveCursorNativeTaskDispatches([{
            id: 'task-part-1',
            type: 'tool',
            tool: 'task',
            state: {
                status: 'running',
                input: {
                    description: 'Inspect compatibility',
                    subagentType: { kind: 'explore', name: 'Explorer' },
                    model: { id: 'composer-2.5', params: [{ id: 'fast', value: 'true' }] },
                },
                metadata: {
                    cursorNativeTask: {
                        schemaVersion: 1,
                        source: 'cursor-native',
                        parentCallId: 'cursor-task-1',
                        text: 'Reading files.',
                        entries: [{
                            id: 'nested-read',
                            tool: 'read',
                            state: { status: 'completed', input: { path: 'src/main.ts' } },
                        }],
                        stepCount: 2,
                    },
                },
            },
        }])).toEqual([{
            partId: 'task-part-1',
            callId: 'cursor-task-1',
            description: 'Inspect compatibility',
            agent: 'Explorer',
            model: { id: 'composer-2.5', params: [{ id: 'fast', value: 'true' }] },
            modelLabel: 'Composer 2.5 (fast=true)',
            status: 'running',
            text: 'Reading files.',
            output: '',
            entries: [{
                id: 'nested-read',
                tool: 'read',
                state: { status: 'completed', input: { path: 'src/main.ts' } },
            }],
            stepCount: 2,
            truncated: false,
        }]);

        expect(resolveCursorNativeTaskDispatches([{
            id: 'ordinary-task',
            type: 'tool',
            tool: 'task',
            state: { metadata: { cursorNativeTask: { source: 'cursor-native' } } },
        }])).toEqual([]);
    });

    test('does not infer managed control or child navigation from Cursor agent ids', () => {
        const [task] = resolveCursorNativeTaskDispatches([{
            id: 'task-part-2',
            type: 'tool',
            tool: 'task',
            state: {
                status: 'completed',
                input: { prompt: 'Inspect the repository', subagent_type: 'explorer' },
                output: { agentId: 'cursor-agent-1' },
                metadata: {
                    cursorNativeTask: {
                        schemaVersion: 1,
                        source: 'cursor-native',
                        parentCallId: 'cursor-task-2',
                        entries: [],
                    },
                },
            },
        }]);

        expect(task?.agent).toBe('explorer');
        expect(task?.status).toBe('completed');
        expect(task ? 'taskId' in task : true).toBe(false);
        expect(task ? 'childSessionId' in task : true).toBe(false);
        expect(task ? 'agentId' in task : true).toBe(false);
    });
});
