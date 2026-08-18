import {
    classifyProviderTransportFailure,
    isManagedRetryInPlacePrompt,
    isManagedResumeContinuationPrompt,
    isManagedTransientTransportContinuationPrompt,
    type ManagedTaskEventRecord,
    type ProviderTransportFailureKind,
} from '@openchamber/orchestration-runtime';

import type {
    ChatMessageEntry,
    ManagedAbortRecoveryState,
    ManagedTransportRecoveryState,
} from './types';

const resolveMessageRole = (message: ChatMessageEntry): string => {
    const info = message.info as { clientRole?: string | null; role?: string | null };
    return info.clientRole ?? info.role ?? '';
};

const resolveMessageId = (message: ChatMessageEntry): string => (
    typeof message.info.id === 'string' ? message.info.id : ''
);

const resolveParentMessageId = (message: ChatMessageEntry): string | null => {
    const parentId = (message.info as { parentID?: unknown }).parentID;
    return typeof parentId === 'string' && parentId.trim() ? parentId : null;
};

const resolveSessionId = (message: ChatMessageEntry): string | null => {
    const sessionId = (message.info as { sessionID?: unknown }).sessionID;
    return typeof sessionId === 'string' && sessionId.trim() ? sessionId : null;
};

const resolveTransportFailureKind = (
    message: ChatMessageEntry,
): ProviderTransportFailureKind | null => {
    if (resolveMessageRole(message) !== 'assistant') return null;
    const error = (message.info as {
        error?: { data?: { message?: unknown }; message?: unknown; name?: unknown };
    }).error;
    if (!error) return null;
    const detail = error.data?.message ?? error.message;
    return classifyProviderTransportFailure(error.name, detail);
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
    const indexed = messages.map((message, index) => ({
        createdAt: (message.info as { time?: { created?: unknown } }).time?.created,
        index,
        message,
    }));
    if (indexed.some(({ createdAt }) => !Number.isFinite(createdAt))) return messages;

    const hasInversion = indexed.some((entry, index) => (
        index > 0
        && (entry.createdAt as number) < (indexed[index - 1].createdAt as number)
    ));
    if (!hasInversion) return messages;

    indexed.sort((left, right) => (
        (left.createdAt as number) - (right.createdAt as number)
        || left.index - right.index
    ));
    return indexed.map(({ message }) => message);
};

const isAbortedAssistant = (message: ChatMessageEntry): boolean => {
    if (resolveMessageRole(message) !== 'assistant') return false;
    const error = (message.info as {
        error?: { data?: { message?: unknown }; message?: unknown; name?: unknown };
    }).error;
    return [error?.data?.message, error?.message, error?.name].some((candidate) => (
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
