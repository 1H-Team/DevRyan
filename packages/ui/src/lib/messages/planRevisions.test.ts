import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2/client';

import { buildPlanImplementationRequestMarker } from './actionablePlan';
import {
    isContinuationTurnUserMessage,
    projectPlanRevisions,
    type PlanRevisionAssistantInput,
    type PlanRevisionTurnInput,
} from './planRevisions';

const userInfo = (id: string, extra: Record<string, unknown> = {}): Message => ({
    id,
    sessionID: 'session-1',
    role: 'user',
    time: { created: 1 },
    ...extra,
} as unknown as Message);

const textPart = (messageId: string, text: string, synthetic = false): Part => ({
    id: `${messageId}-${text.length}`,
    messageID: messageId,
    sessionID: 'session-1',
    type: 'text',
    text,
    ...(synthetic ? { synthetic: true } : {}),
} as Part);

const planText = (title: string): string => (
    `<!--plan-->\n# ${title}\n\n## Context\n\nKeep context.\n\n## Implementation\n\n1. Do work.`
);

const assistant = (id: string, text: string, completedAt: number | null = 10): PlanRevisionAssistantInput => ({
    id,
    parentMessageId: null,
    completedAt,
    parts: [textPart(id, text)],
});

const implementationParts = (messageId: string, sourceMessageId: string): Part[] => [
    textPart(messageId, buildPlanImplementationRequestMarker({
        sourceSessionId: 'session-1',
        sourceMessageId,
        planIndex: 0,
    }), true),
    textPart(messageId, 'Read the plan at /repo/.opencode/plans/fix.md and implement it.', true),
];

const turn = (
    turnId: string,
    parts: Part[],
    assistants: PlanRevisionAssistantInput[],
    options: { recordedPlanMode?: boolean; info?: Record<string, unknown> } = {},
): PlanRevisionTurnInput => ({
    turnId,
    userMessageId: turnId,
    userInfo: userInfo(turnId, options.info),
    userParts: parts,
    isRecordedPlanMode: options.recordedPlanMode ?? false,
    assistants,
});

describe('isContinuationTurnUserMessage', () => {
    test('folds /compact and fully synthetic turns, but never a recorded plan-mode turn', () => {
        expect(isContinuationTurnUserMessage([textPart('u2', '/compact')], false)).toBe(true);
        expect(isContinuationTurnUserMessage([textPart('u2', 'Continue from where you left off.', true)], false)).toBe(true);
        expect(isContinuationTurnUserMessage([textPart('u2', 'Continue.', true)], true)).toBe(false);
        expect(isContinuationTurnUserMessage([textPart('u2', 'Revise the plan')], false)).toBe(false);
    });

    test('an implementation request is fully synthetic yet never a continuation', () => {
        expect(isContinuationTurnUserMessage(implementationParts('u2', 'a1'), false)).toBe(false);
    });
});

describe('projectPlanRevisions', () => {
    test('a plan turn followed by an implementation turn yields one plan revision, and the implementation turn opens its own group', () => {
        const revisions = projectPlanRevisions([
            turn('u1', [textPart('u1', 'Plan the fix')], [assistant('a1', planText('Plan'))], { recordedPlanMode: true }),
            // OpenCode stamps the implementation turn with the session's last
            // agent (`plan`) — the marker must still win.
            turn('u2', implementationParts('u2', 'a1'), [
                assistant('a2', 'Editing files now.', null),
                assistant('a3', 'Done.', null),
            ], { info: { mode: 'plan', agent: 'plan' } }),
        ]);

        expect(revisions).toHaveLength(1);
        const revision = revisions[0]!;
        expect(revision.rootTurnId).toBe('u1');
        expect(revision.memberTurnIds).toEqual(['u1']);
        expect(revision.intent).toBe('plan');
        expect(revision.sourceMessageId).toBe('a1');
        expect(revision.isSettled).toBe(true);
        expect(revision.turnIdsAfterSource).toEqual([]);
        expect(revision.messageRoles.get('a1')).toBe('source');
        expect(revision.messageRoles.has('a2')).toBe(false);
        expect(revision.messageRoles.has('a3')).toBe(false);
    });

    test('an implementation group yields no revision even when its assistants echo plan-shaped output', () => {
        const revisions = projectPlanRevisions([
            turn('u1', implementationParts('u1', 'external-a0'), [
                assistant('a1', planText('Echoed plan headings while working')),
            ], { recordedPlanMode: true, info: { mode: 'plan' } }),
        ]);

        expect(revisions).toEqual([]);
    });

    test('compaction and fully synthetic continuation turns still fold into the open plan revision', () => {
        const revisions = projectPlanRevisions([
            turn('u1', [textPart('u1', 'Plan the fix')], [assistant('a1', 'Exploring.')], { recordedPlanMode: true }),
            turn('u2', [textPart('u2', '/compact')], [assistant('a2', 'Summary.')]),
            turn('u3', [textPart('u3', 'Continue from where you left off.', true)], [assistant('a3', planText('Plan'))]),
            turn('u4', [textPart('u4', 'Continue.', true)], [assistant('a4', 'Epilogue.')]),
        ]);

        expect(revisions).toHaveLength(1);
        const revision = revisions[0]!;
        expect(revision.memberTurnIds).toEqual(['u1', 'u2', 'u3', 'u4']);
        expect(revision.sourceTurnId).toBe('u3');
        expect(revision.sourceMessageId).toBe('a3');
        expect(revision.turnIdsAfterSource).toEqual(['u4']);
        expect(revision.messageRoles.get('a1')).toBe('before-source');
        expect(revision.messageRoles.get('a4')).toBe('after-source');
    });

    test('a continuation after an implementation turn folds into the implementation group, not the plan', () => {
        const revisions = projectPlanRevisions([
            turn('u1', [textPart('u1', 'Plan the fix')], [assistant('a1', planText('Plan'))], { recordedPlanMode: true }),
            turn('u2', implementationParts('u2', 'a1'), [assistant('a2', 'Working.', null)]),
            turn('u3', [textPart('u3', '/compact')], [assistant('a3', 'Summary.', null)]),
        ]);

        expect(revisions).toHaveLength(1);
        expect(revisions[0]?.memberTurnIds).toEqual(['u1']);
        expect(revisions[0]?.messageRoles.has('a3')).toBe(false);
    });

    test('a non-plan-mode turn is a revision only when an assistant carries a sentinel plan', () => {
        const revisions = projectPlanRevisions([
            turn('u1', [textPart('u1', 'How should we fix this?')], [assistant('a1', planText('Suggested plan'))]),
            turn('u2', [textPart('u2', 'Thanks')], [assistant('a2', 'You are welcome.')]),
        ]);

        expect(revisions).toHaveLength(1);
        expect(revisions[0]?.intent).toBe('none');
        expect(revisions[0]?.isPlanModeRevision).toBe(false);
        expect(revisions[0]?.sourceMessageId).toBe('a1');
    });
});
