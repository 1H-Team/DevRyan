import React from 'react';
import type { AssistantMessage, Message, Part, ReasoningPart, TextPart, ToolPart } from '@opencode-ai/sdk/v2';

import type { MessageStreamPhase } from '@/stores/types/sessionTypes';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useDirectorySync, useSessionPermissions, useSessionQuestions, useSessionStatus } from '@/sync/sync-context';
import { isTerminalAssistantMessage as isTerminalSyncAssistantMessage } from '@/sync/session-working';
import { isFullySyntheticMessage } from '@/lib/messages/synthetic';
import { postRendererTurnTimingMark } from '@/stores/utils/streamDebug';
import { getAssistantToolStatusPhrase } from './assistantStatusFormatting';
import { useSessionActivity } from './useSessionActivity';
import { useRetryVisibility } from '@/components/chat/lib/turns/retryVisibility';
import { useAgentRuntimeWarmupStore } from '@/stores/useAgentRuntimeWarmupStore';

export type AssistantActivity = 'idle' | 'streaming' | 'tooling' | 'cooldown' | 'permission';

interface WorkingSummary {
    activity: AssistantActivity;
    hasWorkingContext: boolean;
    hasActiveTools: boolean;
    isWorking: boolean;
    isStreaming: boolean;
    isCooldown: boolean;
    lifecyclePhase: MessageStreamPhase | null;
    statusText: string | null;
    isGenericStatus: boolean;
    isWaitingForPermission: boolean;
    canAbort: boolean;
    compactionDeadline: number | null;
    activePartType?: 'text' | 'tool' | 'reasoning' | 'editing';
    activeToolName?: string;
    activeToolAction?: string;
    wasAborted: boolean;
    abortActive: boolean;
    lastCompletionId: string | null;
    isComplete: boolean;
    retryInfo: { attempt?: number; next?: number; message?: string } | null;
    providerID?: string;
    hasStreamedActivity: boolean;
}

interface FormingSummary {
    isActive: boolean;
    characterCount: number;
}

export interface AssistantStatusSnapshot {
    forming: FormingSummary;
    working: WorkingSummary;
}

export type AssistantActivePartType = 'text' | 'tool' | 'reasoning' | 'editing' | undefined;

export interface AssistantActivePartStatus {
    activePartType: AssistantActivePartType;
    activeToolName: string | undefined;
    activeToolAction?: string;
}

interface AssistantActivePartStatusOptions {
    isTerminalAssistantMessage?: boolean;
}

type AssistantMessageWithState = AssistantMessage & {
    status?: string;
    streaming?: boolean;
    abortedAt?: number;
};

interface AssistantSessionMessageRecord {
    info: AssistantMessageWithState;
    parts: readonly Part[];
}

type SessionMessageRecord = {
    info: Message;
    parts: readonly Part[];
};

const DEFAULT_WORKING: WorkingSummary = {
    activity: 'idle',
    hasWorkingContext: false,
    hasActiveTools: false,
    isWorking: false,
    isStreaming: false,
    isCooldown: false,
    lifecyclePhase: null,
    statusText: null,
    isGenericStatus: true,
    isWaitingForPermission: false,
    canAbort: false,
    compactionDeadline: null,
    activePartType: undefined,
    activeToolName: undefined,
    wasAborted: false,
    abortActive: false,
    lastCompletionId: null,
    isComplete: false,
    retryInfo: null,
    providerID: undefined,
    hasStreamedActivity: false,
};

const EMPTY_MESSAGES: Message[] = [];
const EMPTY_PARTS: Part[] = [];
const EMPTY_SESSION_MESSAGES: SessionMessageRecord[] = [];
const isAssistantMessage = (message: Message): message is AssistantMessageWithState => message.role === 'assistant';

const sortAssistantSessionRecords = (records: readonly AssistantSessionMessageRecord[]): AssistantSessionMessageRecord[] => {
    return records
        .map((record, index) => ({ record, index }))
        .sort((a, b) => {
            const aCreated = typeof a.record.info.time?.created === 'number' ? a.record.info.time.created : null;
            const bCreated = typeof b.record.info.time?.created === 'number' ? b.record.info.time.created : null;

            if (aCreated !== null && bCreated !== null && aCreated !== bCreated) {
                return aCreated - bCreated;
            }

            return a.index - b.index;
        })
        .map(({ record }) => record);
};

const hasAssistantStatusContext = (record: AssistantSessionMessageRecord): boolean => {
    return (record.parts?.length ?? 0) > 0 || isTerminalSyncAssistantMessage(record.info);
};

export const selectAssistantStatusRecord = (
    records: readonly SessionMessageRecord[],
): AssistantSessionMessageRecord | null => {
    const assistantMessages = records
        .filter(
            (msg): msg is AssistantSessionMessageRecord =>
                isAssistantMessage(msg.info) && !isFullySyntheticMessage(msg.parts as Part[])
        );

    if (assistantMessages.length === 0) {
        return null;
    }

    const sortedAssistantMessages = sortAssistantSessionRecords(assistantMessages);
    for (let index = sortedAssistantMessages.length - 1; index >= 0; index -= 1) {
        const record = sortedAssistantMessages[index];
        if (hasAssistantStatusContext(record)) {
            return record;
        }
    }

    return sortedAssistantMessages[sortedAssistantMessages.length - 1];
};

export const selectAssistantStatusMessageId = (
    messages: readonly Message[],
    partsByMessageId: Record<string, readonly Part[] | undefined>,
): string | null => {
    const selected = selectAssistantStatusRecord(messages.map((msg) => ({
        info: msg,
        parts: partsByMessageId[msg.id] ?? EMPTY_PARTS,
    })));
    return selected?.info.id ?? null;
};

const isReasoningPart = (part: Part): part is ReasoningPart => part.type === 'reasoning';

const isTextPart = (part: Part): part is TextPart => part.type === 'text';

const getLegacyTextContent = (part: Part): string | undefined => {
    if (isTextPart(part)) {
        return part.text;
    }
    const candidate = part as Partial<{ text?: unknown; content?: unknown; value?: unknown }>;
    if (typeof candidate.text === 'string') {
        return candidate.text;
    }
    if (typeof candidate.content === 'string') {
        return candidate.content;
    }
    if (typeof candidate.value === 'string') {
        return candidate.value;
    }
    return undefined;
};

const getPartTimeInfo = (part: Part): { end?: number } | undefined => {
    if (isTextPart(part) || isReasoningPart(part)) {
        return part.time;
    }
    const candidate = part as Partial<{ time?: { end?: number } }>;
    return candidate.time;
};

const getToolDisplayName = (part: ToolPart): string => {
    if (part.tool) {
        return part.tool;
    }
    const candidate = part as ToolPart & Partial<{ name?: unknown }>;
    return typeof candidate.name === 'string' ? candidate.name : 'tool';
};

const getToolAction = (part: ToolPart): string | undefined => {
    const state = part.state as { input?: unknown } | undefined;
    if (!state?.input || typeof state.input !== 'object' || Array.isArray(state.input)) {
        return undefined;
    }
    const action = (state.input as Record<string, unknown>).action;
    return typeof action === 'string' && action.trim().length > 0
        ? action.trim().toLowerCase()
        : undefined;
};

const EDITING_TOOLS = new Set(['edit', 'write', 'multiedit', 'apply_patch']);

const isToolLive = (part: ToolPart): boolean => {
    const status = part.state?.status;
    return status === 'running' || status === 'pending';
};

export const getAssistantActivePartStatus = (
    parts: readonly Part[] | undefined,
    options: AssistantActivePartStatusOptions = {},
): AssistantActivePartStatus => {
    if (options.isTerminalAssistantMessage) {
        return { activePartType: undefined, activeToolName: undefined };
    }

    let hasNewerReliableActivity = false;

    for (let i = (parts ?? []).length - 1; i >= 0; i -= 1) {
        const part = parts?.[i];
        if (!part) continue;

        switch (part.type) {
            case 'reasoning': {
                const time = part.time ?? getPartTimeInfo(part);
                const stillRunning = !time || typeof time.end === 'undefined';
                if (stillRunning) {
                    return { activePartType: 'reasoning', activeToolName: undefined };
                }
                hasNewerReliableActivity = true;
                break;
            }
            case 'tool': {
                if (isToolLive(part)) {
                    if (hasNewerReliableActivity) {
                        return { activePartType: undefined, activeToolName: undefined };
                    }

                    const toolName = getToolDisplayName(part);
                    const normalizedToolName = toolName.trim().toLowerCase();
                    return {
                        activePartType: EDITING_TOOLS.has(normalizedToolName) ? 'editing' : 'tool',
                        activeToolName: toolName,
                        activeToolAction: getToolAction(part),
                    };
                }

                hasNewerReliableActivity = true;
                break;
            }
            case 'text': {
                const rawContent = getLegacyTextContent(part) ?? '';
                if (typeof rawContent === 'string' && rawContent.trim().length > 0) {
                    const time = getPartTimeInfo(part);
                    const streamingPart = !time || typeof time.end === 'undefined';
                    if (streamingPart) {
                        return { activePartType: 'text', activeToolName: undefined };
                    }
                    hasNewerReliableActivity = true;
                }
                break;
            }
            default:
                break;
        }
    }

    return { activePartType: undefined, activeToolName: undefined };
};

/**
 * Whether the assistant message has produced any real output yet.
 *
 * A text-less reasoning part that has already closed does not count: xAI opens
 * one during its silent pre-token window, and treating it as output would hide
 * the deterministic provider-waiting copy that window exists for.
 */
export const hasAssistantStreamedActivity = (parts: readonly Part[] | undefined): boolean => {
    for (const part of parts ?? []) {
        if (part.type === 'tool') {
            return true;
        }

        const rawContent = getLegacyTextContent(part) ?? '';
        const hasText = typeof rawContent === 'string' && rawContent.trim().length > 0;

        if (part.type === 'text') {
            if (hasText) return true;
            continue;
        }

        if (part.type === 'reasoning') {
            // Any reasoning part means the turn has produced output — even an
            // empty, already-ended one (xai/Grok emits those), so the provider
            // waiting copy must yield to the normal status ladder.
            return true;
        }
    }

    return false;
};

/**
 * Returns a snapshot of assistant activity for the given session.
 *
 * Pass `sessionId` explicitly when you need per-session status (e.g. the
 * sidebar indicator for background sessions). Omit it (or pass `undefined`)
 * to default to the currently-focused session.
 */
export function useAssistantStatus(sessionId?: string | null, directoryOverride?: string | null): AssistantStatusSnapshot {
    const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
    const effectiveSessionId = sessionId ?? currentSessionId;
    const storedDirectory = useSessionUIStore(
        React.useCallback(
            (state) => (effectiveSessionId ? state.getDirectoryForSession(effectiveSessionId) : null),
            [effectiveSessionId],
        ),
    );
    const effectiveDirectory = directoryOverride ?? storedDirectory;
    const warmingDirectory = useAgentRuntimeWarmupStore((state) => state.warmingDirectory);

    const rawSessionMessages = useDirectorySync(
        React.useCallback((state) => {
            if (!effectiveSessionId) {
                return EMPTY_MESSAGES;
            }
            return state.message[effectiveSessionId] ?? EMPTY_MESSAGES;
        }, [effectiveSessionId]),
        effectiveDirectory ?? undefined,
    );

    // Subscribe to the latest assistant that has renderable status context.
    // This skips trailing zero-part assistant shells that can arrive after
    // tool-call turns while still keeping the subscription to one message.
    const lastAssistantId = useDirectorySync(
        React.useCallback((state) => {
            if (!effectiveSessionId) return null;
            return selectAssistantStatusMessageId(
                state.message[effectiveSessionId] ?? EMPTY_MESSAGES,
                state.part,
            );
        }, [effectiveSessionId]),
        effectiveDirectory ?? undefined,
    );

    const lastAssistantParts = useDirectorySync(
        React.useCallback((state) => {
            if (!lastAssistantId) return EMPTY_PARTS;
            return state.part[lastAssistantId] ?? EMPTY_PARTS;
        }, [lastAssistantId]),
        effectiveDirectory ?? undefined,
    );

    const sessionMessages = React.useMemo<SessionMessageRecord[]>(
        () => {
            if (rawSessionMessages.length === 0) {
                return EMPTY_SESSION_MESSAGES;
            }
            return rawSessionMessages.map((msg) => ({
                info: msg,
                parts: msg.id === lastAssistantId ? lastAssistantParts : EMPTY_PARTS,
            }));
        },
        [lastAssistantParts, rawSessionMessages, lastAssistantId]
    );

    const sessionPermissionRequests = useSessionPermissions(effectiveSessionId ?? '', effectiveDirectory ?? undefined);
    const sessionQuestionRequests = useSessionQuestions(effectiveSessionId ?? '', effectiveDirectory ?? undefined);

    const sessionAbortRecord = useSessionUIStore(
        React.useCallback((state) => {
            if (!effectiveSessionId) {
                return null;
            }
            return state.sessionAbortFlags?.get(effectiveSessionId) ?? null;
        }, [effectiveSessionId])
    );

    const { phase: activityPhase, isWorking: isPhaseWorking } = useSessionActivity(effectiveSessionId, effectiveDirectory ?? undefined);

    const currentSessionStatus = useSessionStatus(effectiveSessionId ?? '', effectiveDirectory ?? undefined);

    const sessionRetryAttempt = currentSessionStatus?.type === 'retry'
        ? (currentSessionStatus as { type: 'retry'; attempt?: number }).attempt
        : undefined;

    const sessionRetryNext = currentSessionStatus?.type === 'retry'
        ? (currentSessionStatus as { type: 'retry'; next?: number }).next
        : undefined;

    const sessionRetryMessage = currentSessionStatus?.type === 'retry'
        ? (currentSessionStatus as { type: 'retry'; message?: string }).message
        : undefined;

    const activeRetryStatus = React.useMemo(() => {
        if (!effectiveSessionId || currentSessionStatus?.type !== 'retry') {
            return null;
        }

        return {
            sessionId: effectiveSessionId,
            message: typeof sessionRetryMessage === 'string' ? sessionRetryMessage : '',
            confirmedAt: (currentSessionStatus as { type: 'retry'; confirmedAt?: number }).confirmedAt,
            attempt: sessionRetryAttempt,
            next: sessionRetryNext,
        };
    }, [currentSessionStatus, effectiveSessionId, sessionRetryAttempt, sessionRetryMessage, sessionRetryNext]);
    const visibleRetryStatus = useRetryVisibility(activeRetryStatus);

    interface ParsedStatusResult {
        activePartType: AssistantActivePartType;
        activeToolName: string | undefined;
        activeToolAction?: string;
        statusText: string;
        isGenericStatus: boolean;
        providerID?: string;
        hasStreamedActivity: boolean;
    }

    const parsedStatus = React.useMemo<ParsedStatusResult>(() => {
        if (sessionMessages.length === 0) {
            return { activePartType: undefined, activeToolName: undefined, statusText: 'working', isGenericStatus: true, hasStreamedActivity: false };
        }

        const lastAssistant = selectAssistantStatusRecord(sessionMessages);

        if (!lastAssistant) {
            return { activePartType: undefined, activeToolName: undefined, statusText: 'working', isGenericStatus: true, hasStreamedActivity: false };
        }

        const { activePartType, activeToolName, activeToolAction } = getAssistantActivePartStatus(lastAssistant.parts ?? [], {
            isTerminalAssistantMessage: isTerminalSyncAssistantMessage(lastAssistant.info),
        });
        const hasStreamedActivity = hasAssistantStreamedActivity(lastAssistant.parts ?? []);
        const providerID = typeof (lastAssistant.info as { providerID?: unknown }).providerID === 'string'
            ? (lastAssistant.info as { providerID: string }).providerID.trim().toLowerCase()
            : undefined;

        const WORKING_PHRASES = [
            'working',
            'processing',
            'preparing',
            'warming up',
            'gears turning',
            'computing',
            'calculating',
            'analyzing',
            'wheels spinning',
            'calibrating',
            'synthesizing',
            'connecting dots',
            'inspecting logic',
            'weighing options',
        ];

        const getRandomWorkingPhrase = (): string => {
            return WORKING_PHRASES[Math.floor(Math.random() * WORKING_PHRASES.length)];
        };

        const isGenericStatus = activePartType === undefined;
        const statusText = (() => {
            if (activePartType === 'editing') {
                return activeToolName?.trim().toLowerCase() === 'multiedit'
                    ? getAssistantToolStatusPhrase(activeToolName)
                    : 'editing file';
            }
            if (activePartType === 'tool' && activeToolName) return getAssistantToolStatusPhrase(activeToolName);
            if (activePartType === 'reasoning') return 'thinking';
            if (activePartType === 'text') return 'composing';
            return getRandomWorkingPhrase();
        })();

        return { activePartType, activeToolName, activeToolAction, statusText, isGenericStatus, providerID, hasStreamedActivity };
    }, [sessionMessages]);

    const abortState = React.useMemo(() => {
        const hasActiveAbort = Boolean(sessionAbortRecord && !sessionAbortRecord.acknowledged);
        return { wasAborted: hasActiveAbort, abortActive: hasActiveAbort };
    }, [sessionAbortRecord]);

    const baseWorking = React.useMemo<WorkingSummary>(() => {

        if (abortState.wasAborted) {
            return {
                ...DEFAULT_WORKING,
                wasAborted: true,
                abortActive: abortState.abortActive,
                activity: 'idle',
                hasWorkingContext: false,
                isWorking: false,
                isStreaming: false,
                isCooldown: false,
                statusText: null,
                canAbort: false,
                retryInfo: null,
            };
        }

        const isWorking = isPhaseWorking;
        const isStreaming = activityPhase === 'busy';
        const isCooldown = false;
        const isRetry = activityPhase === 'retry';
        const isPreparingProject = isWorking
            && parsedStatus.isGenericStatus
            && Boolean(effectiveDirectory)
            && warmingDirectory === effectiveDirectory;

        let activity: AssistantActivity = 'idle';
        if (isWorking) {
            if (parsedStatus.activePartType === 'tool' || parsedStatus.activePartType === 'editing') {
                activity = 'tooling';
            } else {
                activity = isCooldown ? 'cooldown' : 'streaming';
            }
        }

        const retryInfo = isRetry && visibleRetryStatus
            ? { attempt: sessionRetryAttempt, next: sessionRetryNext, message: sessionRetryMessage }
            : null;

        return {
            activity,
            hasWorkingContext: isWorking,
            hasActiveTools: parsedStatus.activePartType === 'tool' || parsedStatus.activePartType === 'editing',
            isWorking,
            isStreaming,
            isCooldown,
            lifecyclePhase: isStreaming ? 'streaming' : isCooldown ? 'cooldown' : null,
            statusText: isWorking
                ? (isPreparingProject ? 'preparing project' : parsedStatus.statusText)
                : null,
            isGenericStatus: isWorking ? parsedStatus.isGenericStatus : true,
            isWaitingForPermission: false,
            canAbort: isWorking,
            compactionDeadline: null,
            activePartType: isWorking ? parsedStatus.activePartType : undefined,
            activeToolName: isWorking ? parsedStatus.activeToolName : undefined,
            activeToolAction: isWorking ? parsedStatus.activeToolAction : undefined,
            wasAborted: false,
            abortActive: false,
            lastCompletionId: null,
            isComplete: false,
            retryInfo,
            providerID: isWorking ? parsedStatus.providerID : undefined,
            hasStreamedActivity: isWorking ? parsedStatus.hasStreamedActivity : false,
        };
    }, [activityPhase, isPhaseWorking, parsedStatus, abortState, sessionRetryAttempt, sessionRetryNext, sessionRetryMessage, visibleRetryStatus, effectiveDirectory, warmingDirectory]);

    const forming = React.useMemo<FormingSummary>(() => {

        const isActive = isPhaseWorking && parsedStatus.activePartType === 'text';

        if (!isActive || sessionMessages.length === 0) {
            return { isActive, characterCount: 0 };
        }

        const lastAssistant = selectAssistantStatusRecord(sessionMessages);

        if (!lastAssistant) {
            return { isActive, characterCount: 0 };
        }

        let characterCount = 0;

        (lastAssistant.parts ?? []).forEach((part) => {
            if (part.type !== 'text') return;
            const rawContent = getLegacyTextContent(part) ?? '';
            if (typeof rawContent === 'string' && rawContent.trim().length > 0) {
                characterCount += rawContent.length;
            }
        });

        return { isActive, characterCount };
    }, [sessionMessages, isPhaseWorking, parsedStatus.activePartType]);

    const working = React.useMemo<WorkingSummary>(() => {
        if (baseWorking.wasAborted || baseWorking.abortActive) {
            return baseWorking;
        }

        const hasPendingPermission = sessionPermissionRequests.length > 0;
        const hasPendingQuestion = sessionQuestionRequests.length > 0;

        if (!hasPendingPermission && !hasPendingQuestion) {
            return baseWorking;
        }

        if (hasPendingQuestion) {
            return {
                ...baseWorking,
                statusText: null,
                isWorking: false,
                hasWorkingContext: false,
                hasActiveTools: false,
                canAbort: false,
                activePartType: undefined,
                activeToolName: undefined,
                retryInfo: null,
            };
        }

        return {
            ...baseWorking,
            statusText: 'waiting for permission',
            isWaitingForPermission: true,
            canAbort: false,
            retryInfo: null,
        };
    }, [baseWorking, sessionPermissionRequests, sessionQuestionRequests]);

    React.useEffect(() => {
        if (!effectiveSessionId || working.isWorking || currentSessionStatus?.type !== 'idle') {
            return;
        }

        postRendererTurnTimingMark({
            sessionId: effectiveSessionId,
            assistantMessageId: lastAssistantId ?? undefined,
            mark: 'renderer_status_idle_visible',
            directory: effectiveDirectory ?? undefined,
            metadata: { source: 'useAssistantStatus' },
        });
    }, [currentSessionStatus?.type, effectiveDirectory, effectiveSessionId, lastAssistantId, working.isWorking]);

    return {
        forming,
        working,
    };
}
