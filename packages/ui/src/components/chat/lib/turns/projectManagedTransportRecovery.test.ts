import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2';
import {
    MANAGED_READ_ONLY_PROMPT,
    MANAGED_RETRY_IN_PLACE_PROMPT,
    MANAGED_RESUME_CONTINUATION_PROMPT,
    MANAGED_TRANSIENT_TIMEOUT_CONTINUATION_PROMPT,
    MANAGED_TRANSIENT_TRANSPORT_CONTINUATION_PROMPT,
    type ManagedTaskEventRecord,
    type ManagedTaskStatus,
} from '@openchamber/orchestration-runtime';

import { projectManagedTransportRecovery } from './projectManagedTransportRecovery';
import type { ChatMessageEntry } from './types';

const SESSION_ID = 'ses_child';

const entry = ({
    id,
    role,
    parentID,
    text,
    error,
    finish,
    createdAt = 1_000,
}: {
    id: string;
    role: 'user' | 'assistant';
    parentID?: string;
    text?: string;
    error?: unknown;
    finish?: string;
    createdAt?: number;
}): ChatMessageEntry => ({
    info: {
        id,
        role,
        sessionID: SESSION_ID,
        time: { created: createdAt, ...(finish ? { completed: createdAt + 100 } : {}) },
        ...(parentID ? { parentID } : {}),
        ...(error ? { error } : {}),
        ...(finish ? { finish } : {}),
    } as unknown as Message,
    parts: text ? [{
        id: `prt_${id}`,
        messageID: id,
        sessionID: SESSION_ID,
        type: 'text',
        text,
    } as unknown as Part] : [],
});

const task = (
    status: ManagedTaskStatus,
    overrides: Partial<ManagedTaskEventRecord> = {},
): ManagedTaskEventRecord => ({
    childSessionId: SESSION_ID,
    status,
    ...overrides,
} as ManagedTaskEventRecord);

const transportError = (name: string, detail: string) => ({
    name,
    data: { message: detail },
});

const claudeConnectionFailure = '{"type":"api_error","message":"Claude Code returned an error result: API Error: Connection closed mid-response. The response above may be incomplete."}';

describe('projectManagedTransportRecovery', () => {
    test('folds an automatic resume into the aborted turn and reparents its completion', () => {
        const originalUser = entry({ id: 'msg_user', role: 'user', text: 'Implement the fix.' });
        const aborted = entry({
            id: 'msg_aborted',
            role: 'assistant',
            parentID: originalUser.info.id,
            text: 'Partial implementation',
            error: { message: 'aborted' },
        });
        const continuation = entry({
            id: 'msg_resume',
            role: 'user',
            text: MANAGED_RESUME_CONTINUATION_PROMPT,
        });
        const completed = entry({
            id: 'msg_completed',
            role: 'assistant',
            parentID: continuation.info.id,
            text: 'Implementation complete',
            finish: 'stop',
        });

        const projected = projectManagedTransportRecovery(
            [originalUser, aborted, continuation, completed],
            task('completed'),
        );

        expect(projected.map((message) => message.info.id)).toEqual([
            originalUser.info.id,
            aborted.info.id,
            completed.info.id,
        ]);
        expect(projected[1].presentation?.managedAbortRecovery).toEqual({ state: 'recovered' });
        expect((projected[2].info as { parentID?: string }).parentID).toBe(originalUser.info.id);
    });

    test('restores mixed-provider chronology and folds a manual in-place retry', () => {
        const originalUser = entry({
            id: 'msg_1a00579c3bd350dddb2',
            role: 'user',
            text: 'Implement the fix.',
            createdAt: 1_000,
        });
        const failedCursorAssistant = entry({
            id: 'msg_1a00579c3bd350dddb2_assistant',
            role: 'assistant',
            parentID: originalUser.info.id,
            text: 'Partial Cursor work',
            finish: 'error',
            createdAt: 1_100,
        });
        const retry = entry({
            id: 'msg_005959f3b0016fR37NuXEYC1vc',
            role: 'user',
            text: MANAGED_RETRY_IN_PLACE_PROMPT,
            createdAt: 2_000,
        });
        const completedOpenAiAssistant = entry({
            id: 'msg_005959f640013jZ67Mdq5lNl0F',
            role: 'assistant',
            parentID: retry.info.id,
            text: 'Completed with the selected model',
            finish: 'stop',
            createdAt: 2_100,
        });

        // This is the order produced by lexically sorting the incompatible ID
        // formats: the newer OpenCode records precede the legacy Cursor records.
        const projected = projectManagedTransportRecovery(
            [retry, completedOpenAiAssistant, originalUser, failedCursorAssistant],
            task('completed', { executionKind: 'retry_in_place' }),
        );

        expect(projected.map((message) => message.info.id)).toEqual([
            originalUser.info.id,
            failedCursorAssistant.info.id,
            completedOpenAiAssistant.info.id,
        ]);
        expect((projected[2].info as { parentID?: string }).parentID).toBe(originalUser.info.id);
    });

    test('restores mixed-provider chronology after managed task metadata is gone', () => {
        const olderCursorMessage = entry({
            id: 'msg_1a00579c3bd350dddb2',
            role: 'user',
            text: 'Original Cursor request',
            createdAt: 1_000,
        });
        const newerOpenAiMessage = entry({
            id: 'msg_005959f3b0016fR37NuXEYC1vc',
            role: 'user',
            text: 'Later OpenAI request',
            createdAt: 2_000,
        });

        expect(projectManagedTransportRecovery(
            [newerOpenAiMessage, olderCursorMessage],
            undefined,
        )).toEqual([olderCursorMessage, newerOpenAiMessage]);
    });

    test('projects live, manual, and terminal abort states from narrow managed-task inputs', () => {
        const originalUser = entry({ id: 'msg_user', role: 'user', text: 'Implement the fix.' });
        const aborted = entry({
            id: 'msg_aborted',
            role: 'assistant',
            parentID: originalUser.info.id,
            error: { data: { message: 'Aborted' } },
        });
        const messages = [originalUser, aborted];

        expect(projectManagedTransportRecovery(messages, task('running'))[1]
            .presentation?.managedAbortRecovery).toEqual({ state: 'continuing' });
        expect(projectManagedTransportRecovery(messages, task('failed'), 'dvr_task_failed')[1]
            .presentation?.managedAbortRecovery).toEqual({ state: 'manual_recovery' });
        expect(projectManagedTransportRecovery(messages, task('failed'))[1]
            .presentation?.managedAbortRecovery).toEqual({ state: 'stopped' });
    });

    test('carries the failure kind so a parked timeout can be named as one', () => {
        const originalUser = entry({ id: 'msg_user', role: 'user', text: 'Implement the fix.' });
        const aborted = entry({
            id: 'msg_aborted',
            role: 'assistant',
            parentID: originalUser.info.id,
            error: { data: { message: 'Aborted' } },
        });
        const timedOut = {
            ...task('failed'),
            failureKind: 'deadline_exceeded',
        } as ManagedTaskEventRecord;

        expect(projectManagedTransportRecovery([originalUser, aborted], timedOut, 'dvr_task_timeout')[1]
            .presentation?.managedAbortRecovery).toEqual({
                state: 'manual_recovery',
                failureKind: 'deadline_exceeded',
            });
    });

    test('folds the journal-shaped read-only Claude recovery into the original visible turn', () => {
        const originalUser = entry({ id: 'msg_user', role: 'user', text: 'Inspect the layout.' });
        const interrupted = entry({
            id: 'msg_interrupted',
            role: 'assistant',
            parentID: originalUser.info.id,
            text: 'Useful work before the connection closed',
            error: transportError('UnknownError', claudeConnectionFailure),
        });
        const continuation = entry({
            id: 'msg_continuation',
            role: 'user',
            text: `${MANAGED_READ_ONLY_PROMPT}\n\n${MANAGED_TRANSIENT_TRANSPORT_CONTINUATION_PROMPT}`,
        });
        const completed = entry({
            id: 'msg_completed',
            role: 'assistant',
            parentID: continuation.info.id,
            text: 'Completed after connection recovery',
            finish: 'stop',
        });
        const messages = [originalUser, interrupted, continuation, completed];

        const projected = projectManagedTransportRecovery(messages, task('completed'));

        expect(projected.map((message) => message.info.id)).toEqual([
            originalUser.info.id,
            interrupted.info.id,
            completed.info.id,
        ]);
        expect(projected[0]).toBe(originalUser);
        expect(projected[1].presentation?.managedTransportRecovery).toEqual({
            kind: 'connection_failure',
            state: 'recovered',
        });
        expect((projected[2].info as { parentID?: string }).parentID).toBe(originalUser.info.id);
        expect((completed.info as { parentID?: string }).parentID).toBe(continuation.info.id);
        expect(projected[2].parts).toBe(completed.parts);
    });

    test('projects each normalized transport class with the authoritative running state', () => {
        const cases = [
            ['UnknownError', 'The operation timed out.', 'request_timeout'],
            ['HeadersTimeoutError', 'UND_ERR_HEADERS_TIMEOUT', 'response_header_timeout'],
            ['BodyTimeoutError', 'UND_ERR_BODY_TIMEOUT', 'stream_idle_timeout'],
            ['UnknownError', 'Streaming response failed: socket hang up', 'connection_failure'],
        ] as const;

        for (const [name, detail, expectedKind] of cases) {
            const originalUser = entry({ id: `msg_user_${expectedKind}`, role: 'user', text: 'Inspect.' });
            const interrupted = entry({
                id: `msg_error_${expectedKind}`,
                role: 'assistant',
                parentID: originalUser.info.id,
                error: transportError(name, detail),
            });
            const continuation = entry({
                id: `msg_continue_${expectedKind}`,
                role: 'user',
                text: expectedKind === 'request_timeout'
                    ? MANAGED_TRANSIENT_TIMEOUT_CONTINUATION_PROMPT
                    : MANAGED_TRANSIENT_TRANSPORT_CONTINUATION_PROMPT,
            });

            const projected = projectManagedTransportRecovery(
                [originalUser, interrupted, continuation],
                task('running'),
            );

            expect(projected).toHaveLength(2);
            expect(projected[1].presentation?.managedTransportRecovery).toEqual({
                kind: expectedKind,
                state: 'recovering',
            });
        }
    });

    test('keeps the second terminal failure actionable after one automatic recovery', () => {
        const originalUser = entry({ id: 'msg_user', role: 'user', text: 'Inspect.' });
        const firstFailure = entry({
            id: 'msg_failure_1',
            role: 'assistant',
            parentID: originalUser.info.id,
            error: transportError('UnknownError', claudeConnectionFailure),
        });
        const continuation = entry({
            id: 'msg_continuation',
            role: 'user',
            text: MANAGED_TRANSIENT_TRANSPORT_CONTINUATION_PROMPT,
        });
        const secondFailure = entry({
            id: 'msg_failure_2',
            role: 'assistant',
            parentID: continuation.info.id,
            error: transportError('UnknownError', claudeConnectionFailure),
        });

        const projected = projectManagedTransportRecovery(
            [originalUser, firstFailure, continuation, secondFailure],
            task('failed'),
        );

        expect(projected).toHaveLength(3);
        expect(projected[1].presentation?.managedTransportRecovery?.state).toBe('failed');
        expect(projected[2].presentation?.managedTransportRecovery).toBe(undefined);
        expect((projected[2].info as { error?: unknown }).error).toBe(
            (secondFailure.info as { error?: unknown }).error,
        );
        expect((projected[2].info as { parentID?: string }).parentID).toBe(originalUser.info.id);
    });

    test('leaves unrelated transcripts and user-authored continuation text unchanged', () => {
        const originalUser = entry({ id: 'msg_user', role: 'user', text: 'Inspect.' });
        const ordinaryFailure = entry({
            id: 'msg_failure',
            role: 'assistant',
            parentID: originalUser.info.id,
            error: transportError('UnknownError', 'Permanent provider refusal'),
        });
        const authoredText = entry({
            id: 'msg_authored',
            role: 'user',
            text: MANAGED_TRANSIENT_TRANSPORT_CONTINUATION_PROMPT,
        });
        const messages = [originalUser, ordinaryFailure, authoredText];

        expect(projectManagedTransportRecovery(messages, task('running'))).toBe(messages);
        expect(projectManagedTransportRecovery(messages, undefined)).toBe(messages);
    });

    test('preserves every unaffected message reference', () => {
        const unrelated = entry({ id: 'msg_unrelated', role: 'user', text: 'Earlier work.' });
        const originalUser = entry({ id: 'msg_user', role: 'user', text: 'Inspect.' });
        const interrupted = entry({
            id: 'msg_interrupted',
            role: 'assistant',
            parentID: originalUser.info.id,
            error: transportError('UnknownError', claudeConnectionFailure),
        });
        const continuation = entry({
            id: 'msg_continuation',
            role: 'user',
            text: MANAGED_TRANSIENT_TRANSPORT_CONTINUATION_PROMPT,
        });
        const completed = entry({
            id: 'msg_completed',
            role: 'assistant',
            parentID: continuation.info.id,
            text: 'Done',
            finish: 'stop',
        });

        const projected = projectManagedTransportRecovery(
            [unrelated, originalUser, interrupted, continuation, completed],
            task('completed'),
        );

        expect(projected[0]).toBe(unrelated);
        expect(projected[1]).toBe(originalUser);
        expect(projected[2]).not.toBe(interrupted);
        expect(projected[3]).not.toBe(completed);
    });
});
