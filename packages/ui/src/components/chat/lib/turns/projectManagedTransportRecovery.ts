import {
    classifyProviderTransportFailure,
    isManagedRetryInPlacePrompt,
    isManagedResumeContinuationPrompt,
    isManagedTransientTransportContinuationPrompt,
    type ManagedTaskEventRecord,
    type ProviderTransportFailureKind,
} from '@devryan/orchestration-runtime';

import type {
    ChatMessageEntry,
    ManagedAbortRecoveryState,
    ManagedTransportRecoveryState,
} from './types';
import { readAssistantMessageError } from '@/lib/decoders/assistantMessageError';
import {
    readMessageCreatedAt,
    readMessageParentId,
    readMessageRole,
    readMessageSessionId,
} from '@/lib/decoders/messageInfo';

const resolveMessageRole = (message: ChatMessageEntry): string => readMessageRole(message.info) ?? '';

const resolveMessageId = (message: ChatMessageEntry): string => (
    typeof message.info.id === 'string' ? message.info.id : ''
);

const resolveParentMessageId = (message: ChatMessageEntry): string | null => readMessageParentId(message.info);

const resolveSessionId = (message: ChatMessageEntry): string | null => readMessageSessionId(message.info);

const resolveTransportFailureKind = (
    message: ChatMessageEntry,
): ProviderTransportFailureKind | null => {
    if (resolveMessageRole(message) !== 'assistant') return null;
    const error = readAssistantMessageError(message.info);
    if (!error) return null;
    return classifyProviderTransportFailure(error.name, error.dataMessage ?? error.message);
};

const isManagedTransportContinuationMessage = (message: ChatMessageEntry): boolean => (
    resolveMessageRole(message) === 'user'
    && message.parts.some((part) => (
        part.type === 'text'
        && isManagedTransientTransportContinuationPrompt(
            (part as { text?: unknown }).text,
        )
    ))
);

const isManagedResumeContinuationMessage = (message: ChatMessageEntry): boolean => (
    resolveMessageRole(message) === 'user'
    && message.parts.some((part) => (
        part.type === 'text'
        && isManagedResumeContinuationPrompt((part as { text?: unknown }).text)
    ))
);

const isManagedRetryInPlaceContinuationMessage = (message: ChatMessageEntry): boolean => (
    resolveMessageRole(message) === 'user'
    && message.parts.some((part) => (
        part.type === 'text'
        && isManagedRetryInPlacePrompt((part as { text?: unknown }).text)
    ))
);

export const orderChatMessagesChronologically = (
    messages: ChatMessageEntry[],
): ChatMessageEntry[] => {
    if (messages.length < 2) return messages;
    const indexed: Array<{ createdAt: number; index: number; message: ChatMessageEntry }> = [];
    for (const [index, message] of messages.entries()) {
        const createdAt = readMessageCreatedAt(message.info);
        if (createdAt === null) return messages;
        indexed.push({ createdAt, index, message });
    }

    const hasInversion = indexed.some((entry, index) => (
        index > 0
        && entry.createdAt < indexed[index - 1].createdAt
    ));
    if (!hasInversion) return messages;

    indexed.sort((left, right) => (
        left.createdAt - right.createdAt
        || left.index - right.index
    ));
    return indexed.map(({ message }) => message);
};

const isAbortedAssistant = (message: ChatMessageEntry): boolean => {
    if (resolveMessageRole(message) !== 'assistant') return false;
    const error = readAssistantMessageError(message.info);
    return [error?.dataMessage, error?.message, error?.name].some((candidate) => (
        typeof candidate === 'string' && candidate.trim().toLowerCase() === 'aborted'
    ));
};

const resolveRecoveryState = (
    task: ManagedTaskEventRecord,
): ManagedTransportRecoveryState => {
    if (task.status === 'queued' || task.status === 'starting' || task.status === 'running') {
        return 'recovering';
    }
    return task.status === 'completed' ? 'recovered' : 'failed';
};

const findInterruptedAssistant = (
    messages: ChatMessageEntry[],
    continuationIndex: number,
): { messageId: string; parentId: string | null; kind: ProviderTransportFailureKind } | null => {
    for (let index = continuationIndex - 1; index >= 0; index -= 1) {
        const candidate = messages[index];
        const role = resolveMessageRole(candidate);
        if (role === 'user') return null;
        if (role !== 'assistant') continue;
        const kind = resolveTransportFailureKind(candidate);
        if (!kind) continue;
        const messageId = resolveMessageId(candidate);
        if (!messageId) return null;
        return { messageId, parentId: resolveParentMessageId(candidate), kind };
    }
    return null;
};

const findAbortedAssistant = (
    messages: ChatMessageEntry[],
    continuationIndex: number,
): { messageId: string; parentId: string | null } | null => {
    for (let index = continuationIndex - 1; index >= 0; index -= 1) {
        const candidate = messages[index];
        const role = resolveMessageRole(candidate);
        if (role === 'user') return null;
        if (!isAbortedAssistant(candidate)) continue;
        const messageId = resolveMessageId(candidate);
        return messageId ? { messageId, parentId: resolveParentMessageId(candidate) } : null;
    }
    return null;
};

const findPreviousAssistant = (
    messages: ChatMessageEntry[],
    continuationIndex: number,
): { messageId: string; parentId: string | null } | null => {
    for (let index = continuationIndex - 1; index >= 0; index -= 1) {
        const candidate = messages[index];
        const role = resolveMessageRole(candidate);
        if (role === 'user') return null;
        if (role !== 'assistant') continue;
        const messageId = resolveMessageId(candidate);
        return messageId ? { messageId, parentId: resolveParentMessageId(candidate) } : null;
    }
    return null;
};

const resolveAbortRecoveryState = (
    task: ManagedTaskEventRecord,
    manualRecoveryTaskId: string | undefined,
): ManagedAbortRecoveryState => {
    if (manualRecoveryTaskId) return 'manual_recovery';
    if (task.status === 'queued' || task.status === 'starting' || task.status === 'running') {
        return 'continuing';
    }
    return task.status === 'completed' ? 'recovered' : 'stopped';
};

export const projectManagedTransportRecovery = (
    messages: ChatMessageEntry[],
    latestTask: ManagedTaskEventRecord | undefined,
    manualRecoveryTaskId?: string,
): ChatMessageEntry[] => {
    const chronologicalMessages = orderChatMessagesChronologically(messages);
    if (!latestTask?.childSessionId) return chronologicalMessages;

    const recoveryState = resolveRecoveryState(latestTask);
    const projectsRetryInPlace = latestTask.executionKind === 'retry_in_place'
        || latestTask.executionKind === 'recover_in_place';
    const removedContinuationIds = new Set<string>();
    const recoveryByAssistantId = new Map<string, {
        kind: ProviderTransportFailureKind;
        state: ManagedTransportRecoveryState;
    }>();
    const visibleParentByContinuationId = new Map<string, string | null>();

    for (let index = 0; index < chronologicalMessages.length; index += 1) {
        const continuation = chronologicalMessages[index];
        if (resolveSessionId(continuation) !== latestTask.childSessionId) continue;

        if (projectsRetryInPlace && isManagedRetryInPlaceContinuationMessage(continuation)) {
            const previousAssistant = findPreviousAssistant(chronologicalMessages, index);
            const continuationId = resolveMessageId(continuation);
            if (!previousAssistant || !continuationId) continue;
            const visibleParent = previousAssistant.parentId
                && visibleParentByContinuationId.has(previousAssistant.parentId)
                ? visibleParentByContinuationId.get(previousAssistant.parentId) ?? null
                : previousAssistant.parentId;
            removedContinuationIds.add(continuationId);
            visibleParentByContinuationId.set(continuationId, visibleParent);
            continue;
        }

        if (isManagedResumeContinuationMessage(continuation)) {
            const interrupted = findAbortedAssistant(chronologicalMessages, index);
            const continuationId = resolveMessageId(continuation);
            if (!interrupted || !continuationId) continue;
            removedContinuationIds.add(continuationId);
            visibleParentByContinuationId.set(continuationId, interrupted.parentId);
            continue;
        }

        if (!isManagedTransportContinuationMessage(continuation)) continue;

        const interrupted = findInterruptedAssistant(chronologicalMessages, index);
        if (!interrupted) continue;
        const continuationId = resolveMessageId(continuation);
        if (!continuationId) continue;

        removedContinuationIds.add(continuationId);
        visibleParentByContinuationId.set(continuationId, interrupted.parentId);
        recoveryByAssistantId.set(interrupted.messageId, {
            kind: interrupted.kind,
            state: recoveryState,
        });
    }

    const projected = removedContinuationIds.size === 0
        ? chronologicalMessages
        : chronologicalMessages.flatMap((message) => {
            const messageId = resolveMessageId(message);
            if (removedContinuationIds.has(messageId)) return [];

            const recovery = recoveryByAssistantId.get(messageId);
            const parentId = resolveParentMessageId(message);
            const hasReparentedContinuation = resolveMessageRole(message) === 'assistant'
                && Boolean(parentId && visibleParentByContinuationId.has(parentId));
            if (!recovery && !hasReparentedContinuation) return [message];

            return [{
                ...message,
                info: hasReparentedContinuation
                    ? ({
                        ...(message.info as unknown as Record<string, unknown>),
                        parentID: visibleParentByContinuationId.get(parentId as string) ?? undefined,
                    } as unknown as typeof message.info)
                    : message.info,
                presentation: recovery
                    ? {
                        ...message.presentation,
                        managedTransportRecovery: recovery,
                    }
                    : message.presentation,
            }];
        });

    const abortRecoveryState = resolveAbortRecoveryState(latestTask, manualRecoveryTaskId);
    const abortRecoveryFailureKind = latestTask.failureKind ?? null;
    for (let index = projected.length - 1; index >= 0; index -= 1) {
        const message = projected[index];
        if (
            resolveSessionId(message) !== latestTask.childSessionId
            || !isAbortedAssistant(message)
        ) continue;
        const presented = message.presentation?.managedAbortRecovery;
        if (
            presented?.state === abortRecoveryState
            && (presented.failureKind ?? null) === abortRecoveryFailureKind
        ) {
            return projected;
        }
        const next = [...projected];
        next[index] = {
            ...message,
            presentation: {
                ...message.presentation,
                managedAbortRecovery: {
                    state: abortRecoveryState,
                    ...(abortRecoveryFailureKind ? { failureKind: abortRecoveryFailureKind } : {}),
                },
            },
        };
        return next;
    }

    return projected;
};
