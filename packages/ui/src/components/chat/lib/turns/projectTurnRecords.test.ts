import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2';
import { projectTurnRecords } from './projectTurnRecords';
import type { ChatMessageEntry } from './types';

function createMessageEntry({
    id,
    role,
    parentID,
    createdAt,
    completedAt,
    finish,
    planMode = false,
    parts = [],
}: {
    id: string;
    role: 'user' | 'assistant' | 'system';
    parentID?: string;
    createdAt: number;
    completedAt?: number;
    finish?: string;
    planMode?: boolean;
    parts?: Part[];
}): ChatMessageEntry {
    return {
        info: {
            id,
            role,
            ...(parentID ? { parentID } : {}),
            ...(finish ? { finish } : {}),
            ...(planMode ? { mode: 'plan' } : {}),
            time: { created: createdAt, ...(completedAt ? { completed: completedAt } : {}) },
        } as Message,
        parts,
    };
}

const createPlanPart = (messageId: string, title: string): Part => ({
    id: `${messageId}-plan`,
    messageID: messageId,
    sessionID: 'session-1',
    type: 'text',
    text: `<!--plan-->\n# ${title}\n\n## Context\n\nKeep context.\n\n## Implementation\n\n1. Do work.\n\n## Verification\n\n1. Run tests.`,
} as Part);

describe('projectTurnRecords', () => {
    test('groups assistant replies under their parent user turn', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 });

        const projection = projectTurnRecords([user, assistant]);

        expect(projection.turns).toHaveLength(1);
        expect(projection.turns[0]?.turnId).toBe('u1');
        expect(projection.turns[0]?.assistantMessageIds).toEqual(['a1']);
        expect(projection.ungroupedMessageIds.size).toBe(0);
    });

    test('keeps out-of-order assistant replies attached to their parent user turn', () => {
        const user1 = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant1 = createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 });
        const assistant2 = createMessageEntry({ id: 'a2', role: 'assistant', parentID: 'u2', createdAt: 4 });
        const user2 = createMessageEntry({ id: 'u2', role: 'user', createdAt: 3 });

        const projection = projectTurnRecords([user1, assistant1, assistant2, user2]);

        expect(projection.turns).toHaveLength(2);
        expect(projection.turns[0]?.turnId).toBe('u1');
        expect(projection.turns[0]?.assistantMessageIds).toEqual(['a1']);
        expect(projection.turns[1]?.turnId).toBe('u2');
        expect(projection.turns[1]?.assistantMessageIds).toEqual(['a2']);
        expect(projection.ungroupedMessageIds.size).toBe(0);
    });

    test('does not render assistant replies while their parent user turn is missing', () => {
        const user1 = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant1 = createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 });
        const assistant2 = createMessageEntry({ id: 'a2', role: 'assistant', parentID: 'u2', createdAt: 4 });

        const projection = projectTurnRecords([user1, assistant1, assistant2]);

        expect(projection.turns).toHaveLength(1);
        expect(projection.turns[0]?.turnId).toBe('u1');
        expect(projection.turns[0]?.assistantMessageIds).toEqual(['a1']);
        expect(projection.ungroupedMessageIds.has('a2')).toBe(false);
        expect(projection.indexes.messageToTurnId.has('a2')).toBe(false);
    });

    test('does not render orphan assistant messages as standalone ungrouped entries', () => {
        const assistant = createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'missing-user', createdAt: 1 });

        const projection = projectTurnRecords([assistant]);

        expect(projection.turns).toHaveLength(0);
        expect(projection.ungroupedMessageIds.has('a1')).toBe(false);
        expect(projection.indexes.messageToTurnId.has('a1')).toBe(false);
    });

    test('keeps non-assistant orphan messages available as ungrouped entries', () => {
        const system = createMessageEntry({ id: 's1', role: 'system', createdAt: 1 });

        const projection = projectTurnRecords([system]);

        expect(projection.turns).toHaveLength(0);
        expect(projection.ungroupedMessageIds.has('s1')).toBe(true);
    });

    test('reuses unchanged turn records from the previous projection', () => {
        const user1 = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant1 = createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 });
        const user2 = createMessageEntry({ id: 'u2', role: 'user', createdAt: 3 });
        const assistant2 = createMessageEntry({ id: 'a2', role: 'assistant', parentID: 'u2', createdAt: 4 });
        const previous = projectTurnRecords([user1, assistant1, user2, assistant2]);
        const assistant2WithNewParts: ChatMessageEntry = {
            info: assistant2.info,
            parts: [{ id: 'p1', messageID: 'a2', type: 'text', text: 'new text' } as Part],
        };

        const next = projectTurnRecords([user1, assistant1, user2, assistant2WithNewParts], {
            previousProjection: previous,
        });

        expect(next.turns[0]).toBe(previous.turns[0]);
        expect(next.turns[1]).not.toBe(previous.turns[1]);
    });

    test('projects final assistant summary source ids for turn-aware actions', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const progress = createMessageEntry({
            id: 'a1',
            role: 'assistant',
            parentID: 'u1',
            createdAt: 2,
            parts: [{ id: 'progress-text', messageID: 'a1', type: 'text', text: 'Checking files.' } as Part],
        });
        const final = createMessageEntry({
            id: 'a2',
            role: 'assistant',
            parentID: 'u1',
            createdAt: 3,
            finish: 'stop',
            parts: [{ id: 'final-text', messageID: 'a2', type: 'text', text: 'Done.' } as Part],
        });

        const projection = projectTurnRecords([user, progress, final]);

        expect(projection.turns[0]?.summary).toEqual({
            text: 'Done.',
            sourceMessageId: 'a2',
            sourcePartId: 'final-text',
        });
    });

    test('indexes completed plan revisions in canonical turn order', () => {
        const firstUser = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1, planMode: true });
        const firstPlan = createMessageEntry({
            id: 'a1',
            role: 'assistant',
            parentID: 'u1',
            createdAt: 2,
            completedAt: 3,
            parts: [createPlanPart('a1', 'First Plan')],
        });
        const revisionUser = createMessageEntry({ id: 'u2', role: 'user', createdAt: 4, planMode: true });
        const revisedPlan = createMessageEntry({
            id: 'a2',
            role: 'assistant',
            parentID: 'u2',
            createdAt: 5,
            completedAt: 6,
            parts: [createPlanPart('a2', 'Revised Plan')],
        });

        const projection = projectTurnRecords([firstUser, firstPlan, revisionUser, revisedPlan]);

        const [firstEntry, secondEntry] = projection.planTraceIndex.entries;
        expect(projection.planTraceIndex.entries).toHaveLength(2);
        expect(firstEntry?.planVersion).toBe(1);
        expect(firstEntry?.turnId).toBe('u1');
        expect(firstEntry?.userMessageId).toBe('u1');
        expect(firstEntry?.assistantSourceMessageId).toBe('a1');
        expect(firstEntry?.assistantParentMessageId).toBe('u1');
        expect(firstEntry?.isLatestPlan).toBe(false);
        expect(firstEntry?.isSuperseded).toBe(true);
        expect(firstEntry?.isActionable).toBe(false);
        expect(secondEntry?.planVersion).toBe(2);
        expect(secondEntry?.turnId).toBe('u2');
        expect(secondEntry?.userMessageId).toBe('u2');
        expect(secondEntry?.assistantSourceMessageId).toBe('a2');
        expect(secondEntry?.assistantParentMessageId).toBe('u2');
        expect(secondEntry?.isLatestPlan).toBe(true);
        expect(secondEntry?.isSuperseded).toBe(false);
        expect(secondEntry?.isActionable).toBe(true);
        expect(projection.planTraceIndex.latestPlanTurnId).toBe('u2');
        expect(projection.planTraceIndex.latestPlanSourceMessageId).toBe('a2');
        expect(projection.planTraceIndex.pendingPlanTurnId).toBeNull();
        expect(projection.planTraceIndex.bySourceMessageId.get('a1')?.planVersion).toBe(1);
        expect(projection.planTraceIndex.byTurnId.get('u2')?.planVersion).toBe(2);
    });

    test('marks prior plans superseded while the latest plan-mode turn is pending', () => {
        const firstUser = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1, planMode: true });
        const firstPlan = createMessageEntry({
            id: 'a1',
            role: 'assistant',
            parentID: 'u1',
            createdAt: 2,
            completedAt: 3,
            parts: [createPlanPart('a1', 'First Plan')],
        });
        const revisionUser = createMessageEntry({ id: 'u2', role: 'user', createdAt: 4, planMode: true });
        const partialReply = createMessageEntry({
            id: 'a2',
            role: 'assistant',
            parentID: 'u2',
            createdAt: 5,
            parts: [{ id: 'a2-text', messageID: 'a2', type: 'text', text: 'Reviewing the earlier plan.' } as Part],
        });

        const projection = projectTurnRecords([firstUser, firstPlan, revisionUser, partialReply]);

        expect(projection.planTraceIndex.entries).toHaveLength(2);
        const firstEntry = projection.planTraceIndex.byTurnId.get('u1');
        const pendingEntry = projection.planTraceIndex.byTurnId.get('u2');
        expect(firstEntry?.isLatestPlan).toBe(false);
        expect(firstEntry?.isSuperseded).toBe(true);
        expect(firstEntry?.isActionable).toBe(false);
        expect(pendingEntry?.planVersion).toBe(2);
        expect(pendingEntry?.assistantSourceMessageId).toBeNull();
        expect(pendingEntry?.isLatestPlan).toBe(true);
        expect(pendingEntry?.isActionable).toBe(false);
        expect(projection.planTraceIndex.latestPlanSourceMessageId).toBeNull();
        expect(projection.planTraceIndex.pendingPlanTurnId).toBe('u2');
    });

    test('does not supersede a completed plan for a normal-mode follow-up turn', () => {
        const planUser = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1, planMode: true });
        const plan = createMessageEntry({
            id: 'a1',
            role: 'assistant',
            parentID: 'u1',
            createdAt: 2,
            completedAt: 3,
            parts: [createPlanPart('a1', 'Plan')],
        });
        const normalUser = createMessageEntry({ id: 'u2', role: 'user', createdAt: 4 });

        const projection = projectTurnRecords([planUser, plan, normalUser]);

        expect(projection.planTraceIndex.entries).toHaveLength(1);
        const entry = projection.planTraceIndex.bySourceMessageId.get('a1');
        expect(entry?.isLatestPlan).toBe(true);
        expect(entry?.isSuperseded).toBe(false);
        expect(entry?.isActionable).toBe(true);
    });

    test('does not index structured markdown from a normal-mode assistant turn as a plan', () => {
        const planUser = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1, planMode: true });
        const plan = createMessageEntry({
            id: 'a1',
            role: 'assistant',
            parentID: 'u1',
            createdAt: 2,
            completedAt: 3,
            parts: [createPlanPart('a1', 'Plan')],
        });
        const normalUser = createMessageEntry({ id: 'u2', role: 'user', createdAt: 4 });
        const normalAssistant = createMessageEntry({
            id: 'a2',
            role: 'assistant',
            parentID: 'u2',
            createdAt: 5,
            completedAt: 6,
            parts: [{
                id: 'a2-text',
                messageID: 'a2',
                type: 'text',
                text: '# Explanation\n\n## Implementation\n\nThis is explanatory prose.\n\n## Verification\n\nNo plan was requested.',
            } as Part],
        });

        const projection = projectTurnRecords([planUser, plan, normalUser, normalAssistant]);

        expect(projection.planTraceIndex.entries).toHaveLength(1);
        expect(projection.planTraceIndex.latestPlanTurnId).toBe('u1');
        expect(projection.planTraceIndex.latestPlanSourceMessageId).toBe('a1');
    });

    test('reuses the plan trace index while streaming content changes without identity changes', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1, planMode: true });
        const assistant = createMessageEntry({
            id: 'a1',
            role: 'assistant',
            parentID: 'u1',
            createdAt: 2,
            parts: [createPlanPart('a1', 'Streaming Plan')],
        });
        const previous = projectTurnRecords([user, assistant]);
        const updatedAssistant = createMessageEntry({
            id: 'a1',
            role: 'assistant',
            parentID: 'u1',
            createdAt: 2,
            parts: [createPlanPart('a1', 'Streaming Plan With More Detail')],
        });

        const next = projectTurnRecords([user, updatedAssistant], { previousProjection: previous });

        expect(next.planTraceIndex).toBe(previous.planTraceIndex);
    });
});
