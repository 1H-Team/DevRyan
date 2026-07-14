import { describe, expect, test } from 'bun:test';

import { createChatFlowTraceArtifact } from './chatFlowTrace';

describe('createChatFlowTraceArtifact', () => {
    test('assigns deterministic logical sequence numbers to correlated chat events', () => {
        const artifact = createChatFlowTraceArtifact({
            runId: 'run-1',
            runtime: 'electron',
            projectDirectory: '/Users/zoubair/Repositories/test',
            sessionId: 'session-1',
            events: [
                {
                    action: 'plan.revision',
                    turnId: 'user-2',
                    userMessageId: 'user-2',
                    assistantMessageIds: ['assistant-2'],
                    assistantParentMessageId: 'user-2',
                    planVersion: 2,
                    planSourceMessageId: 'assistant-2',
                    statusBefore: 'busy',
                    statusAfter: 'idle',
                    assertions: [{ name: 'preserves-base-context', passed: true }],
                },
                {
                    action: 'queue.send-now',
                    sessionId: 'session-2',
                    queueItemId: 'queue-1',
                    queuePosition: 1,
                    turnId: 'user-3',
                    userMessageId: 'user-3',
                    assistantMessageIds: ['assistant-3'],
                    assistantParentMessageId: 'user-3',
                    abortReason: 'steered',
                    assertions: [{ name: 'fifo', passed: true }],
                },
            ],
        });

        expect(artifact.schemaVersion).toBe(1);
        expect(artifact.runtime).toBe('electron');
        expect(artifact.events.map((event) => event.sequence)).toEqual([1, 2]);
        expect(artifact.events.map((event) => event.runtime)).toEqual(['electron', 'electron']);
        expect(artifact.events.map((event) => event.sessionId)).toEqual(['session-1', 'session-2']);
        expect(artifact.events[0]?.planVersion).toBe(2);
        expect(artifact.events[0]?.assistantParentMessageId).toBe('user-2');
        expect(artifact.events[1]?.queueItemId).toBe('queue-1');
        expect(artifact.events[1]?.abortReason).toBe('steered');
        expect(JSON.parse(JSON.stringify(artifact))).toEqual(artifact);
    });
});
