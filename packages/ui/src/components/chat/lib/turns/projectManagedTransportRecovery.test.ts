import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2';
import {
    MANAGED_READ_ONLY_PROMPT,
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
}: {
    id: string;
    role: 'user' | 'assistant';
    parentID?: string;
    text?: string;
    error?: unknown;
    finish?: string;
}): ChatMessageEntry => ({
    info: {
        id,
        role,
        sessionID: SESSION_ID,
        time: { created: 1_000, ...(finish ? { completed: 2_000 } : {}) },
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

const task = (status: ManagedTaskStatus): ManagedTaskEventRecord => ({
    childSessionId: SESSION_ID,
    status,
} as ManagedTaskEventRecord);

const transportError = (name: string, detail: string) => ({
    name,
    data: { message: detail },
});

const claudeConnectionFailure = '{"type":"api_error","message":"Claude Code returned an error result: API Error: Connection closed mid-response. The response above may be incomplete."}';

describe('projectManagedTransportRecovery', () => {
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
