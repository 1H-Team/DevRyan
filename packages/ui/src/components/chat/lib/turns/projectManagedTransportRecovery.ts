import {
    classifyProviderTransportFailure,
    isManagedTransientTransportContinuationPrompt,
    type ManagedTaskEventRecord,
    type ProviderTransportFailureKind,
} from '@openchamber/orchestration-runtime';

import type {
    ChatMessageEntry,
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

export const projectManagedTransportRecovery = (
    messages: ChatMessageEntry[],
    latestTask: ManagedTaskEventRecord | undefined,
): ChatMessageEntry[] => {
    if (!latestTask?.childSessionId) return messages;

    const recoveryState = resolveRecoveryState(latestTask);
    const removedContinuationIds = new Set<string>();
    const recoveryByAssistantId = new Map<string, {
        kind: ProviderTransportFailureKind;
        state: ManagedTransportRecoveryState;
    }>();
    const visibleParentByContinuationId = new Map<string, string | null>();

    for (let index = 0; index < messages.length; index += 1) {
        const continuation = messages[index];
        if (
            resolveSessionId(continuation) !== latestTask.childSessionId
            || !isManagedTransportContinuationMessage(continuation)
        ) continue;

        const interrupted = findInterruptedAssistant(messages, index);
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

    if (removedContinuationIds.size === 0) return messages;

    return messages.flatMap((message) => {
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
};
