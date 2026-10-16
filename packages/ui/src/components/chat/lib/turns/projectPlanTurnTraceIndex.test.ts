import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2';
import { buildPlanImplementationRequestMarker } from '@/lib/messages/actionablePlan';
import { projectTurnRecords } from './projectTurnRecords';
import type { ChatMessageEntry } from './types';
import { getPlanCardActionState, hasPlanRevisionFailure } from '../../message/parts/planCardReveal';

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
            ...(role === 'assistant' ? { finish: 'stop' } : {}),
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
    test('keeps one source through an empty final marker and rejects an aborted final draft', () => {
        const human = createMessageEntry({ id: 'u', role: 'user', createdAt: 1, planMode: true });
        const draft = createMessageEntry({ id: 'draft', role: 'assistant', parentID: 'u', createdAt: 2, completedAt: 3,
            parts: [{ id: 'r', messageID: 'draft', sessionID: 'session-1', type: 'reasoning', text: '<!--plan-->\n# Draft', time: { start: 2, end: 3 } }] });
        const final = createMessageEntry({ id: 'final', role: 'assistant', parentID: 'u', createdAt: 4,
            parts: [createTextPart('final', '<!--plan-->\n')] });
        const pending = projectTurnRecords([human, draft, final]).planTraceIndex;
        expect(pending.entries).toHaveLength(1);
        expect(pending.entries[0]).toMatchObject({ assistantSourceMessageId: 'draft', isActionable: false, isSettled: false });
        final.parts = [createTextPart('final', '<!--plan-->\n# Final')];
        const streaming = projectTurnRecords([human, draft, final]).planTraceIndex;
        expect(streaming.entries).toHaveLength(1);
        expect(streaming.entries[0]).toMatchObject({ assistantSourceMessageId: 'final', isActionable: false });
        if (final.info.role !== 'assistant') throw new Error('Expected assistant fixture');
        final.info.time.completed = 5;
        final.info.error = { name: 'MessageAbortedError', data: { message: 'Aborted' } };
        for (const messages of [[human, draft, final], structuredClone([human, draft, final])]) {
            expect(projectTurnRecords(messages).planTraceIndex.entries[0]).toMatchObject({
                assistantSourceMessageId: 'final', isSettled: true, hasTerminalError: true, isActionable: false,
            });
        }
    });

    test('verified saved source is required before a failed prefix and native tail become actionable', () => {
        const human = createMessageEntry({ id: 'human', role: 'user', createdAt: 1, planMode: true, parts: [createTextPart('human', 'Plan it')] });
        const prefix = createMessageEntry({ id: 'prefix', role: 'assistant', parentID: 'human', createdAt: 2, completedAt: 3, parts: [createTextPart('prefix', '<!--plan-->\n# Partial ')] });
        if (prefix.info.role !== 'assistant') throw Error('fixture'); prefix.info.error = { name: 'APIError', data: { message: 'interrupted', isRetryable: false } };
        const native = syntheticContinuationUser('native', 4);
        const tail = createMessageEntry({ id: 'tail', role: 'assistant', parentID: 'native', createdAt: 5, completedAt: 6, parts: [createTextPart('tail', 'tail without headings')] });
        const messages = [human, prefix, native, tail];
        expect(projectTurnRecords(messages).planTraceIndex.bySourceMessageId.get('prefix')?.isActionable).toBe(false);
        const sourceIdentity = { sessionID: 'session-1', sourceMessageID: 'prefix', rootUserMessageID: 'human', memberUserMessageIDs: ['human', 'native'], memberAssistantMessageIDs: ['prefix', 'tail'], currentSourceMessageID: 'tail', successful: true as const, settled: true as const, current: true };
        for (const history of [messages, structuredClone(messages)]) {
          const index = projectTurnRecords(history, { sourceIdentity, canonicalContent: '# Partial tail without headings' }).planTraceIndex;
          expect(index.bySourceMessageId.get('prefix')).toMatchObject({ isActionable: true, memberTurnIds: ['human', 'native'], isSettled: true });
          const entry = index.bySourceMessageId.get('prefix');
          if (!entry) throw Error('Verified Plan entry unavailable');
          const failedPrefixNotice = { type: 'error' as const, session: 'session-1', failedUserMessageId: 'human', time: 3, viewed: true };
          expect(getPlanCardActionState({ streamPhase: 'completed', hasPlanText: true,
            isImplementationRequested: false, isLatestPlan: entry.isLatestPlan,
            isRevisionSettled: entry.isSettled, isGenerationSuccessful: entry.isActionable,
            hasTerminalFailure: entry.hasTerminalError || hasPlanRevisionFailure([failedPrefixNotice], 'session-1', entry.userMessageId, entry.isActionable),
          }).canImplement).toBe(true);
        }
        expect(projectTurnRecords([...messages, createMessageEntry({ id: 'later', role: 'user', createdAt: 7 })], { sourceIdentity }).planTraceIndex.bySourceMessageId.get('prefix')?.isActionable).toBe(false);
    });

    test('open-todo maintenance cannot supersede the saved Plan or become a new actionable card', () => {
        const messages = [
            createMessageEntry({ id: 'human', role: 'user', createdAt: 1, planMode: true, parts: [createTextPart('human', 'Create the plan.')] }),
            createMessageEntry({ id: 'plan', role: 'assistant', parentID: 'human', createdAt: 2, completedAt: 3, parts: [createTextPart('plan', planText('Original Plan'))] }),
            createMessageEntry({ id: 'wake', role: 'user', createdAt: 4, planMode: true, parts: [
                createTextPart('wake', 'User has requested to enter plan mode.\nProduce an implementation plan only.', true),
                { ...createTextPart('wake', '[devryan-open-todo-continuation:v1]\nContinue open todos.', true), id: 'wake-marker' },
            ] }),
            createMessageEntry({ id: 'collection', role: 'assistant', parentID: 'wake', createdAt: 5, completedAt: 6, parts: [createTextPart('collection', planText('Automatic Collection'))] }),
        ];
        const index = projectTurnRecords(messages).planTraceIndex;
        expect(index.entries).toHaveLength(1);
        expect(index.latestPlanSourceMessageId).toBe('plan');
        expect(index.byTurnId.has('wake')).toBe(false);
        expect(index.bySourceMessageId.has('collection')).toBe(false);
        expect(index.turnIntentById.get('wake')).toBe('maintenance');
        expect(index.suppressedTurnIds.has('wake')).toBe(false);
        const fresh = projectTurnRecords([...messages,
            createMessageEntry({ id: 'revision-user', role: 'user', createdAt: 7, planMode: true, parts: [createTextPart('revision-user', 'Revise the plan.')] }),
            createMessageEntry({ id: 'revision-plan', role: 'assistant', parentID: 'revision-user', createdAt: 8, completedAt: 9, parts: [createTextPart('revision-plan', planText('Explicit Revised Plan'))] }),
        ]).planTraceIndex;
        expect(fresh.entries).toHaveLength(2);
        expect(fresh.latestPlanSourceMessageId).toBe('revision-plan');
        expect(fresh.byTurnId.get('revision-user')?.isActionable).toBe(false); // Saved server proof is still pending.
    });
    test('arbitrary synthetic and compaction turns cannot borrow saved source authority', () => {
        const messages = [createMessageEntry({ id: 'u1', role: 'user', createdAt: 1, planMode: true }),
          createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2, completedAt: 3, parts: [createTextPart('a1', planText('Plan'))] }),
          compactionUser('u2', 4), syntheticContinuationUser('u3', 5)];
        const index = projectTurnRecords(messages).planTraceIndex;
        expect(index.entries[0]?.memberTurnIds).toEqual(['u1']); expect(index.entries[0]?.isActionable).toBe(false);
        expect(index.byTurnId.has('u2')).toBe(false); expect(index.byTurnId.has('u3')).toBe(false);
    });

    test('unverified tail text remains visible and keeps an earlier source disabled', () => {
        const messages = [createMessageEntry({ id: 'u1', role: 'user', createdAt: 1, planMode: true }),
          createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2, completedAt: 3, parts: [createTextPart('a1', planText('Plan'))] }),
          syntheticContinuationUser('u2', 4), createMessageEntry({ id: 'a2', role: 'assistant', parentID: 'u2', createdAt: 5, completedAt: 6, parts: [createTextPart('a2', 'Tail')] })];
        const index = projectTurnRecords(messages).planTraceIndex;
        expect(index.suppressedTurnIds.has('u2')).toBe(false); expect(index.messageRoleById.has('a2')).toBe(false);
        expect(index.entries[0]?.isActionable).toBe(false);
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
        expect(entry.isActionable).toBe(false);
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
        expect(next.planTraceIndex.entries[0]?.memberTurnIds).toEqual(['u1']);
        expect(next.planTraceIndex.byTurnId.has('u2')).toBe(false);
        expect(next.planTraceIndex.suppressedTurnIds.has('u2')).toBe(false);
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
