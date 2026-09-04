import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2';
import { buildPlanImplementationRequestMarker } from '@/lib/messages/actionablePlan';
import { projectTurnRecords } from './projectTurnRecords';
import type { ChatMessageEntry } from './types';

function createMessageEntry({
    id,
    role,
    parentID,
    createdAt,
    completedAt,
    planMode = false,
    parts = [],
}: {
    id: string;
    role: 'user' | 'assistant' | 'system';
    parentID?: string;
    createdAt: number;
    completedAt?: number;
    planMode?: boolean;
    parts?: Part[];
}): ChatMessageEntry {
    return {
        info: {
            id,
            role,
            sessionID: 'session-1',
            ...(parentID ? { parentID } : {}),
            ...(planMode ? { mode: 'plan' } : {}),
            time: { created: createdAt, ...(completedAt ? { completed: completedAt } : {}) },
        } as Message,
        parts,
    };
}

const createTextPart = (messageId: string, text: string, synthetic = false): Part => ({
    id: `${messageId}-text`,
    messageID: messageId,
    sessionID: 'session-1',
    type: 'text',
    text,
    ...(synthetic ? { synthetic: true } : {}),
} as Part);

const planText = (title: string): string => (
    `Preamble narration.\n<!--plan-->\n# ${title}\n\n## Context\n\nKeep context.\n\n## Implementation\n\n1. Do work.`
);

const syntheticContinuationUser = (id: string, createdAt: number): ChatMessageEntry => (
    createMessageEntry({
        id,
        role: 'user',
        createdAt,
        parts: [createTextPart(id, 'Continue from where the previous response left off.', true)],
    })
);

const compactionUser = (id: string, createdAt: number): ChatMessageEntry => (
    createMessageEntry({
        id,
        role: 'user',
        createdAt,
        parts: [createTextPart(id, '/compact')],
    })
);

// An Implement Plan request as the server echoes it: fully synthetic, and
// stamped `mode: 'plan'` because the session's last agent was `plan`.
const implementationUser = (id: string, createdAt: number, sourceMessageId: string): ChatMessageEntry => (
    createMessageEntry({
        id,
        role: 'user',
        createdAt,
        planMode: true,
        parts: [
            {
                ...createTextPart(id, buildPlanImplementationRequestMarker({
                    sourceSessionId: 'session-1',
                    sourceMessageId,
                    planIndex: 0,
                }), true),
                id: `${id}-marker`,
            } as Part,
            createTextPart(id, 'Read the plan at /repo/.opencode/plans/fix.md and implement it.', true),
        ],
    })
);

describe('projectPlanTurnTraceIndex plan revisions', () => {
    test('folds compaction and synthetic continuation turns into one revision with a single source', () => {
        // Regression fixture for the observed history: a user-authored plan
        // request, compaction, two synthetic continuation turns, three plan
        // sentinels across overlapping assistants, and a trailing epilogue.
        const messages: ChatMessageEntry[] = [
            createMessageEntry({ id: 'u1', role: 'user', createdAt: 1, planMode: true, parts: [createTextPart('u1', 'Plan the fix')] }),
            createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2, completedAt: 3, parts: [createTextPart('a1', 'Exploring the code.')] }),
            compactionUser('u2', 4),
            createMessageEntry({ id: 'a2', role: 'assistant', parentID: 'u2', createdAt: 5, completedAt: 6, parts: [createTextPart('a2', 'Summary of prior context.')] }),
            syntheticContinuationUser('u3', 7),
            createMessageEntry({ id: 'a3', role: 'assistant', parentID: 'u3', createdAt: 8, completedAt: 9, parts: [createTextPart('a3', planText('Plan v1'))] }),
            createMessageEntry({ id: 'a4', role: 'assistant', parentID: 'u3', createdAt: 10, completedAt: 11, parts: [createTextPart('a4', planText('Plan v2'))] }),
            syntheticContinuationUser('u4', 12),
            createMessageEntry({ id: 'a5', role: 'assistant', parentID: 'u4', createdAt: 13, completedAt: 14, parts: [createTextPart('a5', planText('Plan final'))] }),
            createMessageEntry({ id: 'a6', role: 'assistant', parentID: 'u4', createdAt: 15, completedAt: 16, parts: [createTextPart('a6', 'The plan is ready — let me know how to proceed.')] }),
        ];

        const projection = projectTurnRecords(messages);
        const index = projection.planTraceIndex;

        expect(index.entries).toHaveLength(1);
        const entry = index.entries[0]!;
        expect(entry.turnId).toBe('u1');
        expect(entry.userMessageId).toBe('u1');
        expect(entry.memberTurnIds).toEqual(['u1', 'u2', 'u3', 'u4']);
        expect(entry.sourceTurnId).toBe('u4');
        expect(entry.assistantSourceMessageId).toBe('a5');
        expect(entry.isPlanModeRevision).toBe(true);
        expect(entry.isSettled).toBe(true);
        expect(entry.isActionable).toBe(true);

        expect(index.byTurnId.get('u2')).toBe(entry);
        expect(index.byTurnId.get('u3')).toBe(entry);
        expect(index.byTurnId.get('u4')).toBe(entry);
        expect(index.bySourceMessageId.get('a5')).toBe(entry);
        expect(index.latestPlanSourceMessageId).toBe('a5');
        expect(index.pendingPlanTurnId).toBeNull();

        expect(index.messageRoleById.get('a3')).toBe('before-source');
        expect(index.messageRoleById.get('a4')).toBe('before-source');
        expect(index.messageRoleById.get('a5')).toBe('source');
        expect(index.messageRoleById.get('a6')).toBe('after-source');
        expect(index.suppressedTurnIds.size).toBe(0);
    });

    test('suppresses continuation turns that follow the source turn entirely', () => {
        const messages: ChatMessageEntry[] = [
            createMessageEntry({ id: 'u1', role: 'user', createdAt: 1, planMode: true, parts: [createTextPart('u1', 'Plan the fix')] }),
            createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2, completedAt: 3, parts: [createTextPart('a1', planText('Plan'))] }),
            syntheticContinuationUser('u2', 4),
            createMessageEntry({ id: 'a2', role: 'assistant', parentID: 'u2', createdAt: 5, completedAt: 6, parts: [createTextPart('a2', 'Epilogue text.')] }),
        ];

        const index = projectTurnRecords(messages).planTraceIndex;

        expect(index.entries).toHaveLength(1);
        expect(index.entries[0]?.assistantSourceMessageId).toBe('a1');
        expect(index.suppressedTurnIds.has('u2')).toBe(true);
        expect(index.messageRoleById.get('a2')).toBe('after-source');
    });

    test('marks the revision unsettled and non-actionable while a sibling assistant is streaming', () => {
        const messages: ChatMessageEntry[] = [
            createMessageEntry({ id: 'u1', role: 'user', createdAt: 1, planMode: true, parts: [createTextPart('u1', 'Plan the fix')] }),
            createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2, completedAt: 3, parts: [createTextPart('a1', planText('Plan'))] }),
            createMessageEntry({ id: 'a2', role: 'assistant', parentID: 'u1', createdAt: 4, parts: [createTextPart('a2', 'Still writing…')] }),
        ];

        const index = projectTurnRecords(messages).planTraceIndex;
        const entry = index.entries[0]!;

        expect(entry.assistantSourceMessageId).toBe('a1');
        expect(entry.isSettled).toBe(false);
        expect(entry.isActionable).toBe(false);
        expect(index.pendingPlanTurnId).toBe('u1');
    });

    test('switches the source when a later streaming sibling produces a plan', () => {
        const messages: ChatMessageEntry[] = [
            createMessageEntry({ id: 'u1', role: 'user', createdAt: 1, planMode: true, parts: [createTextPart('u1', 'Plan the fix')] }),
            createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2, completedAt: 3, parts: [createTextPart('a1', planText('Plan v1'))] }),
            createMessageEntry({ id: 'a2', role: 'assistant', parentID: 'u1', createdAt: 4, parts: [createTextPart('a2', planText('Plan v2 streaming'))] }),
        ];

        const index = projectTurnRecords(messages).planTraceIndex;
        const entry = index.entries[0]!;

        expect(entry.assistantSourceMessageId).toBe('a2');
        expect(index.messageRoleById.get('a1')).toBe('before-source');
        expect(index.messageRoleById.get('a2')).toBe('source');
        expect(entry.isSettled).toBe(false);
        expect(entry.isActionable).toBe(false);
    });

    test('keeps genuine user-authored plan revisions as separate superseded entries', () => {
        const messages: ChatMessageEntry[] = [
            createMessageEntry({ id: 'u1', role: 'user', createdAt: 1, planMode: true, parts: [createTextPart('u1', 'Plan the fix')] }),
            createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2, completedAt: 3, parts: [createTextPart('a1', planText('Plan v1'))] }),
            createMessageEntry({ id: 'u2', role: 'user', createdAt: 4, planMode: true, parts: [createTextPart('u2', 'Revise the plan')] }),
            createMessageEntry({ id: 'a2', role: 'assistant', parentID: 'u2', createdAt: 5, completedAt: 6, parts: [createTextPart('a2', planText('Plan v2'))] }),
        ];

        const index = projectTurnRecords(messages).planTraceIndex;

        expect(index.entries).toHaveLength(2);
        expect(index.entries[0]?.assistantSourceMessageId).toBe('a1');
        expect(index.entries[0]?.isSuperseded).toBe(true);
        expect(index.entries[1]?.assistantSourceMessageId).toBe('a2');
        expect(index.entries[1]?.isLatestPlan).toBe(true);
        expect(index.suppressedTurnIds.size).toBe(0);
    });

    test('reuses the previous index when revisions are unchanged', () => {
        const messages: ChatMessageEntry[] = [
            createMessageEntry({ id: 'u1', role: 'user', createdAt: 1, planMode: true, parts: [createTextPart('u1', 'Plan the fix')] }),
            createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2, completedAt: 3, parts: [createTextPart('a1', planText('Plan'))] }),
            syntheticContinuationUser('u2', 4),
            createMessageEntry({ id: 'a2', role: 'assistant', parentID: 'u2', createdAt: 5, completedAt: 6, parts: [createTextPart('a2', 'Epilogue text.')] }),
        ];

        const previous = projectTurnRecords(messages);
        const next = projectTurnRecords(messages, { previousProjection: previous });

        expect(next.planTraceIndex).toBe(previous.planTraceIndex);
    });

    test('never marks assistants after-source across an Implement Plan boundary', () => {
        const messages: ChatMessageEntry[] = [
            createMessageEntry({ id: 'u1', role: 'user', createdAt: 1, planMode: true, parts: [createTextPart('u1', 'Plan the fix')] }),
            createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2, completedAt: 3, parts: [createTextPart('a1', planText('Plan'))] }),
            implementationUser('u2', 4, 'a1'),
            createMessageEntry({ id: 'a2', role: 'assistant', parentID: 'u2', createdAt: 5, parts: [createTextPart('a2', 'Editing the files now.')] }),
            createMessageEntry({ id: 'a3', role: 'assistant', parentID: 'u2', createdAt: 6, parts: [createTextPart('a3', planText('Echoed headings while working'))] }),
        ];

        const index = projectTurnRecords(messages).planTraceIndex;

        expect(index.entries).toHaveLength(1);
        const entry = index.entries[0]!;
        expect(entry.memberTurnIds).toEqual(['u1']);
        expect(entry.intent).toBe('plan');
        expect(entry.assistantSourceMessageId).toBe('a1');
        // The plan revision stays settled and actionable: the implementation
        // turn is not one of its siblings.
        expect(entry.isSettled).toBe(true);
        expect(entry.isActionable).toBe(true);
        expect(index.latestPlanSourceMessageId).toBe('a1');

        expect(index.byTurnId.has('u2')).toBe(false);
        expect(index.suppressedTurnIds.has('u2')).toBe(false);
        expect(index.messageRoleById.has('a2')).toBe(false);
        expect(index.messageRoleById.has('a3')).toBe(false);
        expect(index.turnIntentById.get('u1')).toBe('plan');
        expect(index.turnIntentById.get('u2')).toBe('implement');
    });

    test('an Implement Plan turn stamped mode: plan is still not a plan revision', () => {
        const messages: ChatMessageEntry[] = [
            implementationUser('u1', 1, 'external-a0'),
            createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2, completedAt: 3, parts: [createTextPart('a1', planText('Working notes'))] }),
        ];

        const index = projectTurnRecords(messages, { recordedPlanModeMessageIds: new Set(['u1']) }).planTraceIndex;

        expect(index.entries).toHaveLength(0);
        expect(index.byTurnId.size).toBe(0);
        expect(index.messageRoleById.size).toBe(0);
        expect(index.turnIntentById.get('u1')).toBe('implement');
    });

    test('invalidates the memo when a suppressed turn appears without changing the entries', () => {
        const base: ChatMessageEntry[] = [
            createMessageEntry({ id: 'u1', role: 'user', createdAt: 1, planMode: true, parts: [createTextPart('u1', 'Plan the fix')] }),
            createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2, completedAt: 3, parts: [createTextPart('a1', planText('Plan'))] }),
        ];
        const previous = projectTurnRecords(base);
        expect(previous.planTraceIndex.suppressedTurnIds.size).toBe(0);

        // A synthetic continuation with no assistant yet: no roles, no source
        // change, no settledness change — only the membership sets move.
        const next = projectTurnRecords(
            [...base, syntheticContinuationUser('u2', 4)],
            { previousProjection: previous },
        );

        expect(next.planTraceIndex).not.toBe(previous.planTraceIndex);
        expect(next.planTraceIndex.entries[0]?.memberTurnIds).toEqual(['u1', 'u2']);
        expect(next.planTraceIndex.byTurnId.has('u2')).toBe(true);
        expect(next.planTraceIndex.suppressedTurnIds.has('u2')).toBe(true);
    });

    test('invalidates the memo when a turn intent changes', () => {
        const planTurn = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1, planMode: true, parts: [createTextPart('u1', 'Plan the fix')] });
        const planAssistant = createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2, completedAt: 3, parts: [createTextPart('a1', planText('Plan'))] });
        const previous = projectTurnRecords([
            planTurn,
            planAssistant,
            createMessageEntry({ id: 'u2', role: 'user', createdAt: 4, parts: [createTextPart('u2', 'Thanks')] }),
        ]);
        expect(previous.planTraceIndex.turnIntentById.get('u2')).toBe('none');

        const next = projectTurnRecords(
            [planTurn, planAssistant, implementationUser('u2', 4, 'a1')],
            { previousProjection: previous },
        );

        expect(next.planTraceIndex).not.toBe(previous.planTraceIndex);
        expect(next.planTraceIndex.turnIntentById.get('u2')).toBe('implement');
    });
});
