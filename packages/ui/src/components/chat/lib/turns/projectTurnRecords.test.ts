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
    providerID,
    planMode = false,
    parts = [],
}: {
    id: string;
    role: 'user' | 'assistant' | 'system';
    parentID?: string;
    createdAt: number;
    completedAt?: number;
    finish?: string;
    providerID?: string;
    planMode?: boolean;
    parts?: Part[];
}): ChatMessageEntry {
    return {
        info: {
            id,
            role,
            ...(parentID ? { parentID } : {}),
            ...(finish ? { finish } : {}),
            ...(providerID ? { providerID } : {}),
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

const createTextPart = (messageId: string, id: string, text: string): Part => ({
    id,
    messageID: messageId,
    sessionID: 'session-1',
    type: 'text',
    text,
} as Part);

const createReasoningPart = (messageId: string, id: string, text: string): Part => ({
    id,
    messageID: messageId,
    sessionID: 'session-1',
    type: 'reasoning',
    text,
    time: { start: 1, end: 2 },
} as Part);

const createToolPart = (messageId: string, id: string, tool: string): Part => ({
    id,
    messageID: messageId,
    sessionID: 'session-1',
    type: 'tool',
    tool,
    callID: `${id}-call`,
    state: { status: 'completed', input: {}, output: '' },
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

    test('keeps OpenAI reasoning and tools as activity while leaving the final text as the answer', () => {
        const user = createMessageEntry({ id: 'u-openai', role: 'user', createdAt: 1 });
        const progress = createMessageEntry({
            id: 'a-openai-progress',
            role: 'assistant',
            parentID: 'u-openai',
            createdAt: 2,
            completedAt: 3,
            finish: 'tool-calls',
            providerID: 'openai',
            parts: [
                createReasoningPart('a-openai-progress', 'openai-reasoning', '**Reviewing the files**'),
                createToolPart('a-openai-progress', 'openai-tool', 'apply_patch'),
            ],
        });
        const final = createMessageEntry({
            id: 'a-openai-final',
            role: 'assistant',
            parentID: 'u-openai',
            createdAt: 4,
            completedAt: 5,
            finish: 'stop',
            providerID: 'openai',
            parts: [createTextPart('a-openai-final', 'openai-final-text', 'Implemented and tested.')],
        });

        const turn = projectTurnRecords([user, progress, final]).turns[0];

        expect(turn?.activityParts.map(({ id, kind, providerID }) => ({ id, kind, providerID }))).toEqual([
            { id: 'openai-reasoning', kind: 'reasoning', providerID: 'openai' },
            { id: 'openai-tool', kind: 'tool', providerID: 'openai' },
        ]);
        expect(turn?.summary).toEqual({
            text: 'Implemented and tested.',
            sourceMessageId: 'a-openai-final',
            sourcePartId: 'openai-final-text',
        });
    });

    test('projects OpenCodeGo tool-step text as justification without consuming the final answer', () => {
        const user = createMessageEntry({ id: 'u-kimi', role: 'user', createdAt: 1 });
        const progress = createMessageEntry({
            id: 'a-kimi-progress',
            role: 'assistant',
            parentID: 'u-kimi',
            createdAt: 2,
            completedAt: 3,
            finish: 'tool-calls',
            providerID: 'opencodego',
            parts: [
                createTextPart('a-kimi-progress', 'kimi-progress-text', '**Planning the change**The existing helper is nearby.'),
                createToolPart('a-kimi-progress', 'kimi-tool', 'edit'),
            ],
        });
        const final = createMessageEntry({
            id: 'a-kimi-final',
            role: 'assistant',
            parentID: 'u-kimi',
            createdAt: 4,
            completedAt: 5,
            finish: 'stop',
            providerID: 'opencodego',
            parts: [createTextPart('a-kimi-final', 'kimi-final-text', 'The helper and test are complete.')],
        });

        const turn = projectTurnRecords([user, progress, final]).turns[0];

        expect(turn?.activityParts.map(({ id, kind }) => ({ id, kind }))).toEqual([
            { id: 'kimi-progress-text', kind: 'justification' },
            { id: 'kimi-tool', kind: 'tool' },
        ]);
        expect(turn?.summary.sourcePartId).toBe('kimi-final-text');
        expect(turn?.activityParts.some(({ id }) => id === 'kimi-final-text')).toBe(false);
    });

    test('preserves Anthropic reasoning and narrated tool progress in source order', () => {
        const user = createMessageEntry({ id: 'u-anthropic', role: 'user', createdAt: 1 });
        const progress = createMessageEntry({
            id: 'a-anthropic-progress',
            role: 'assistant',
            parentID: 'u-anthropic',
            createdAt: 2,
            completedAt: 3,
            finish: 'tool-calls',
            providerID: 'anthropic',
            parts: [
                createReasoningPart('a-anthropic-progress', 'anthropic-reasoning', 'I should inspect the implementation.'),
                createTextPart('a-anthropic-progress', 'anthropic-progress-text', 'I’m checking the existing helper first.'),
                createToolPart('a-anthropic-progress', 'anthropic-tool', 'read'),
            ],
        });
        const final = createMessageEntry({
            id: 'a-anthropic-final',
            role: 'assistant',
            parentID: 'u-anthropic',
            createdAt: 4,
            completedAt: 5,
            finish: 'stop',
            providerID: 'anthropic',
            parts: [
                createReasoningPart('a-anthropic-final', 'anthropic-final-reasoning', 'The focused test passed.'),
                createTextPart('a-anthropic-final', 'anthropic-final-text', 'Implemented the helper and test.'),
            ],
        });

        const turn = projectTurnRecords([user, progress, final]).turns[0];

        expect(turn?.activityParts.map(({ id, kind }) => ({ id, kind }))).toEqual([
            { id: 'anthropic-reasoning', kind: 'reasoning' },
            { id: 'anthropic-progress-text', kind: 'justification' },
            { id: 'anthropic-tool', kind: 'tool' },
            { id: 'anthropic-final-reasoning', kind: 'reasoning' },
        ]);
        expect(turn?.summary.sourcePartId).toBe('anthropic-final-text');
        expect(turn?.activityParts.some(({ id }) => id === 'anthropic-final-text')).toBe(false);
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

describe('plan-bearing text justification exemption', () => {
    const structuredPlanText = [
        '# Grok Plan Without Sentinel',
        '',
        '## Context',
        '',
        'Why this change is needed.',
        '',
        '## Implementation',
        '',
        '1. Do the work.',
        '',
        '## Verification',
        '',
        '1. Run the tests.',
    ].join('\n');

    const findActivity = (
        projection: ReturnType<typeof projectTurnRecords>,
        partId: string,
    ) => projection.turns[0]?.activityParts.find((record) => record.part.id === partId);

    test('a sentinel plan part in a tool-bearing message with finish tool-calls is not justification', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = createMessageEntry({
            id: 'a1',
            role: 'assistant',
            parentID: 'u1',
            createdAt: 2,
            finish: 'tool-calls',
            parts: [
                createToolPart('a1', 'a1-tool', 'read'),
                createPlanPart('a1', 'Grok Plan'),
            ],
        });

        const projection = projectTurnRecords([user, assistant]);
        expect(findActivity(projection, 'a1-plan')).toBe(undefined);
    });

    test('a trailing sign-off stays justification while the plan part is exempt', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = createMessageEntry({
            id: 'a1',
            role: 'assistant',
            parentID: 'u1',
            createdAt: 2,
            finish: 'tool-calls',
            parts: [
                createToolPart('a1', 'a1-tool', 'read'),
                createPlanPart('a1', 'Grok Plan'),
                createTextPart('a1', 'a1-signoff', 'Let me know if you want changes.'),
            ],
        });

        const projection = projectTurnRecords([user, assistant]);
        expect(findActivity(projection, 'a1-plan')).toBe(undefined);
        expect(findActivity(projection, 'a1-signoff')?.kind).toBe('justification');
    });

    test('a structured sentinel-less plan is exempt only for plan-mode turns', () => {
        const planModeUser = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1, planMode: true });
        const normalUser = createMessageEntry({ id: 'u2', role: 'user', createdAt: 1 });
        const assistantFor = (parentID: string) => createMessageEntry({
            id: `${parentID}-a`,
            role: 'assistant',
            parentID,
            createdAt: 2,
            finish: 'tool-calls',
            parts: [
                createToolPart(`${parentID}-a`, `${parentID}-a-tool`, 'read'),
                createTextPart(`${parentID}-a`, `${parentID}-a-plan`, structuredPlanText),
            ],
        });

        const planModeProjection = projectTurnRecords([planModeUser, assistantFor('u1')]);
        expect(findActivity(planModeProjection, 'u1-a-plan')).toBe(undefined);

        const normalProjection = projectTurnRecords([normalUser, assistantFor('u2')]);
        expect(findActivity(normalProjection, 'u2-a-plan')?.kind).toBe('justification');
    });

    // Grok interleaves tool calls mid-plan: the plan spans several text parts,
    // none of which is plan-bearing alone — only the message-level joined text is.
    const fragmentedPlanAssistant = (parentID: string) => createMessageEntry({
        id: `${parentID}-a`,
        role: 'assistant',
        parentID,
        createdAt: 2,
        finish: 'tool-calls',
        parts: [
            createTextPart(`${parentID}-a`, `${parentID}-a-frag1`, '# Grok Plan\n\nIntro prose.'),
            createToolPart(`${parentID}-a`, `${parentID}-a-tool1`, 'read'),
            createTextPart(`${parentID}-a`, `${parentID}-a-frag2`, '## Implementation\n\n1. Do the work.'),
            createToolPart(`${parentID}-a`, `${parentID}-a-tool2`, 'grep'),
            createTextPart(`${parentID}-a`, `${parentID}-a-frag3`, '## Verification\n\n1. Run the tests.'),
            createTextPart(`${parentID}-a`, `${parentID}-a-narration`, 'I will index the homepage next.'),
        ],
    });

    test('plan fragments interleaved with tool calls are exempt from justification in plan-mode turns', () => {
        const planModeUser = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1, planMode: true });

        const projection = projectTurnRecords([planModeUser, fragmentedPlanAssistant('u1')]);
        expect(findActivity(projection, 'u1-a-frag1')).toBe(undefined);
        expect(findActivity(projection, 'u1-a-frag2')).toBe(undefined);
        expect(findActivity(projection, 'u1-a-frag3')).toBe(undefined);
        expect(findActivity(projection, 'u1-a-narration')).toBe(undefined);
    });

    test('the same fragmented message keeps justification in a non-plan-mode turn', () => {
        const normalUser = createMessageEntry({ id: 'u2', role: 'user', createdAt: 1 });

        const projection = projectTurnRecords([normalUser, fragmentedPlanAssistant('u2')]);
        expect(findActivity(projection, 'u2-a-frag1')?.kind).toBe('justification');
        expect(findActivity(projection, 'u2-a-frag2')?.kind).toBe('justification');
        expect(findActivity(projection, 'u2-a-frag3')?.kind).toBe('justification');
        expect(findActivity(projection, 'u2-a-narration')?.kind).toBe('justification');
    });

    test('a plan-mode tool-bearing message without plan content keeps justification', () => {
        const planModeUser = createMessageEntry({ id: 'u3', role: 'user', createdAt: 1, planMode: true });
        const assistant = createMessageEntry({
            id: 'u3-a',
            role: 'assistant',
            parentID: 'u3',
            createdAt: 2,
            finish: 'tool-calls',
            parts: [
                createToolPart('u3-a', 'u3-a-tool', 'read'),
                createTextPart('u3-a', 'u3-a-narration', 'Just narration, no plan headings.'),
            ],
        });

        const projection = projectTurnRecords([planModeUser, assistant]);
        expect(findActivity(projection, 'u3-a-narration')?.kind).toBe('justification');
    });
});

describe('plan rendered as a thought (Grok, 2026-08-21)', () => {
    const findActivity = (
        projection: ReturnType<typeof projectTurnRecords>,
        partId: string,
    ) => projection.turns[0]?.activityParts.find((record) => record.part.id === partId);

    const structuredPlan = (heading = '#') => [
        `${heading} Support Chat Routing Plan`,
        '',
        `${heading}# Context`,
        '',
        'Signed-out visitors cannot reach an agent.',
        '',
        `${heading}# Implementation`,
        '',
        '1. Fix the routing function.',
        '',
        `${heading}# Verification`,
        '',
        '1. Run the migration tests.',
    ].join('\n');

    test('a plan drafted inside a reasoning part is not ALSO rendered as a thought', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1, planMode: true });
        const assistant = createMessageEntry({
            id: 'a1',
            role: 'assistant',
            parentID: 'u1',
            createdAt: 2,
            finish: 'tool-calls',
            parts: [
                createToolPart('a1', 'a1-tool', 'read'),
                createReasoningPart('a1', 'a1-reasoning', structuredPlan()),
            ],
        });

        const projection = projectTurnRecords([user, assistant]);
        // The plan card mounts from this reasoning part, so it must not appear
        // in the activity timeline as well.
        expect(findActivity(projection, 'a1-reasoning')).toBe(undefined);
    });

    test('an ordinary reasoning part in a plan-mode turn still renders as a thought', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1, planMode: true });
        const assistant = createMessageEntry({
            id: 'a1',
            role: 'assistant',
            parentID: 'u1',
            createdAt: 2,
            finish: 'tool-calls',
            parts: [
                createToolPart('a1', 'a1-tool', 'read'),
                createReasoningPart('a1', 'a1-reasoning', 'Let me look at the routing function first.'),
            ],
        });

        const projection = projectTurnRecords([user, assistant]);
        expect(findActivity(projection, 'a1-reasoning')?.kind).toBe('reasoning');
    });

    test('when the plan is in the text parts the reasoning part stays a thought', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1, planMode: true });
        const assistant = createMessageEntry({
            id: 'a1',
            role: 'assistant',
            parentID: 'u1',
            createdAt: 2,
            finish: 'tool-calls',
            parts: [
                createToolPart('a1', 'a1-tool', 'read'),
                createReasoningPart('a1', 'a1-reasoning', 'Thinking about the shape of the plan.'),
                createPlanPart('a1', 'Routing Plan'),
            ],
        });

        const projection = projectTurnRecords([user, assistant]);
        expect(findActivity(projection, 'a1-reasoning')?.kind).toBe('reasoning');
        expect(findActivity(projection, 'a1-plan')).toBe(undefined);
    });

    test('a plan written with ### section headings is exempt from the justification bucket', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1, planMode: true });
        const assistant = createMessageEntry({
            id: 'a1',
            role: 'assistant',
            parentID: 'u1',
            createdAt: 2,
            finish: 'tool-calls',
            parts: [
                createToolPart('a1', 'a1-tool', 'read'),
                createTextPart('a1', 'a1-plan-h3', structuredPlan('##')),
            ],
        });

        const projection = projectTurnRecords([user, assistant]);
        expect(findActivity(projection, 'a1-plan-h3')).toBe(undefined);
    });

    test('a plan split across two assistant messages is exempt in both', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1, planMode: true });
        const first = createMessageEntry({
            id: 'a1',
            role: 'assistant',
            parentID: 'u1',
            createdAt: 2,
            finish: 'tool-calls',
            parts: [
                // One recognized heading only -> NOT plan-bearing on its own.
                createTextPart('a1', 'a1-plan-head', '# Support Chat Routing Plan\n\nSigned-out visitors cannot reach an agent.'),
                createToolPart('a1', 'a1-tool', 'read'),
            ],
        });
        const second = createMessageEntry({
            id: 'a2',
            role: 'assistant',
            parentID: 'u1',
            createdAt: 3,
            finish: 'tool-calls',
            parts: [
                // One recognized heading only -> NOT plan-bearing on its own.
                createTextPart('a2', 'a2-plan-tail', '## Implementation\n\n1. Fix the routing function.'),
                createToolPart('a2', 'a2-tool', 'read'),
            ],
        });

        const projection = projectTurnRecords([user, first, second]);
        // Neither fragment is plan-bearing on its own; only the turn-level join is.
        expect(findActivity(projection, 'a1-plan-head')).toBe(undefined);
        expect(findActivity(projection, 'a2-plan-tail')).toBe(undefined);
    });

    test('non-plan-mode turns are unaffected by the turn-level exemption', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = createMessageEntry({
            id: 'a1',
            role: 'assistant',
            parentID: 'u1',
            createdAt: 2,
            finish: 'tool-calls',
            parts: [
                createToolPart('a1', 'a1-tool', 'read'),
                createTextPart('a1', 'a1-text', structuredPlan()),
            ],
        });

        const projection = projectTurnRecords([user, assistant]);
        expect(findActivity(projection, 'a1-text')?.kind).toBe('justification');
    });
});

describe('plan-mode recorded only locally (Grok, 2026-08-22)', () => {
    const findActivity = (
        projection: ReturnType<typeof projectTurnRecords>,
        partId: string,
    ) => projection.turns[0]?.activityParts.find((record) => record.part.id === partId);

    const reasoningPlan = [
        'Perfect! The exact model ID is in the catalog.',
        '<!--plan-->',
        '# Zen API No Text Diagnosis',
        '',
        '## Context',
        '',
        'The error occurs when the API returns 200 with empty content.',
    ].join('\n');

    const buildTurn = (planModeMetadata: boolean) => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1, planMode: planModeMetadata });
        const assistant = createMessageEntry({
            id: 'a1',
            role: 'assistant',
            parentID: 'u1',
            createdAt: 2,
            finish: 'tool-calls',
            parts: [
                createToolPart('a1', 'a1-tool', 'read'),
                createReasoningPart('a1', 'a1-reasoning', reasoningPlan),
            ],
        });
        return [user, assistant];
    };

    test('recordedPlanModeMessageIds alone enables the plan exemptions', () => {
        // No plan-mode metadata and no synthetic instruction part — the flag
        // lives only in the locally recorded set, the common local case.
        const projection = projectTurnRecords(buildTurn(false), {
            recordedPlanModeMessageIds: new Set(['u1']),
        });
        expect(findActivity(projection, 'a1-reasoning')).toBe(undefined);
    });

    test('without any plan-mode signal the reasoning part stays a thought', () => {
        const projection = projectTurnRecords(buildTurn(false));
        expect(findActivity(projection, 'a1-reasoning')?.kind).toBe('reasoning');
    });

    test('a plan straddling the reasoning and text channels exempts both halves', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = createMessageEntry({
            id: 'a1',
            role: 'assistant',
            parentID: 'u1',
            createdAt: 2,
            finish: 'tool-calls',
            parts: [
                createToolPart('a1', 'a1-tool', 'read'),
                createReasoningPart('a1', 'a1-plan-head', 'Thinking.\n<!--plan-->\n# Routing Plan\n\n## Context\n\nWhy.'),
                createTextPart('a1', 'a1-plan-tail', '## Implementation\n\n1. Fix it.\n\n## Verification\n\n1. Run tests.'),
            ],
        });

        const projection = projectTurnRecords([user, assistant], {
            recordedPlanModeMessageIds: new Set(['u1']),
        });
        // The reasoning head hosts the plan card; the text tail is plan
        // continuation — neither may land in the thought/justification bucket.
        expect(findActivity(projection, 'a1-plan-head')).toBe(undefined);
        expect(findActivity(projection, 'a1-plan-tail')).toBe(undefined);
    });
});
