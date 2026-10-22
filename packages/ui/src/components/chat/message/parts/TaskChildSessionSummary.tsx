import React from 'react';
import type { ContentChangeReason } from '@/hooks/useChatAutoFollow';
import { useSessionActivity } from '@/hooks/useSessionActivity';
import { opencodeClient } from '@/lib/opencode/client';
import { useEnsureSessionMessages, useSessionMessageRecords } from '@/sync/sync-context';
import { getSyncChildStores } from '@/sync/sync-refs';
import { TaskToolSummary } from './TaskToolSummary';
import {
    buildTaskSessionMessagesSignature,
    buildTaskSummaryEntriesFromSession,
    materializeTaskSessionSnapshot,
    type SessionMessageWithParts,
    type TaskToolSummaryEntry,
} from './taskToolUtils';

const TASK_TOOL_POLL_FAST_MS = 1200;
const TASK_TOOL_POLL_IDLE_MS = 3200;
const TASK_TOOL_POLL_HIDDEN_MS = 6000;
const TASK_TOOL_INITIAL_FETCH_LIMIT = 500;
const TASK_TOOL_ACTIVE_FETCH_LIMIT = 160;
const TASK_TOOL_IDLE_FETCH_LIMIT = 80;
const TASK_TOOL_NO_CHANGE_BACKOFF_AFTER_POLLS = 3;
const TASK_TOOL_SETTLE_GRACE_MS = 2500;

type TaskToolSummaryProps = React.ComponentProps<typeof TaskToolSummary>;

interface TaskChildSessionSummaryProps extends Omit<TaskToolSummaryProps, 'entries' | 'sessionId'> {
    taskSessionId: string;
    currentDirectory: string;
    /** The task tool part is still running (not finalized). */
    isTaskActive: boolean;
    isFinalized: boolean;
    activeLatched: boolean;
    metadataEntries: TaskToolSummaryEntry[];
    onContentChange?: (reason?: ContentChangeReason) => void;
}

/**
 * The opened sub-agent card: loads, follows and polls the child session's
 * messages to list its tool activity. A collapsed card renders from the task
 * tool part alone (prompt, status, duration, result), so a transcript with many
 * running sub-agents holds and re-renders no child transcripts until one is opened.
 */
export const TaskChildSessionSummary: React.FC<TaskChildSessionSummaryProps> = ({
    taskSessionId,
    currentDirectory,
    isTaskActive: isActive,
    isFinalized,
    activeLatched,
    metadataEntries: metadataTaskSummaryEntries,
    onContentChange,
    ...summaryProps
}) => {
    const childSessionMessages = useSessionMessageRecords(taskSessionId, currentDirectory);
    useEnsureSessionMessages(taskSessionId, currentDirectory);
    const childSessionTaskSummaryEntries = React.useMemo<TaskToolSummaryEntry[]>(() => {
        if (!Array.isArray(childSessionMessages) || childSessionMessages.length === 0) {
            return [];
        }
        return buildTaskSummaryEntriesFromSession(childSessionMessages);
    }, [childSessionMessages]);

    const childSessionHasInFlightTools = React.useMemo(() => {
        if (!taskSessionId || !Array.isArray(childSessionMessages) || childSessionMessages.length === 0) {
            return false;
        }

        for (const message of childSessionMessages) {
            if (message?.info?.role !== 'assistant') {
                continue;
            }
            const parts = Array.isArray(message.parts) ? message.parts : [];
            for (const childPart of parts) {
                if (childPart?.type !== 'tool') {
                    continue;
                }
                const childStatus =
                    typeof childPart === 'object' && childPart !== null && 'state' in childPart
                        ? (childPart.state as { status?: string } | undefined)?.status
                        : undefined;
                if (childStatus === 'running' || childStatus === 'pending' || childStatus === 'started') {
                    return true;
                }
            }
        }

        return false;
    }, [childSessionMessages, taskSessionId]);

    const childSessionActivity = useSessionActivity(taskSessionId, currentDirectory);
    const [taskChildSeenActive, setTaskChildSeenActive] = React.useState(false);
    const [taskChildPollingStopped, setTaskChildPollingStopped] = React.useState(false);
    const [taskPendingFinalFetch, setTaskPendingFinalFetch] = React.useState(false);

    const taskPollNoChangeCountRef = React.useRef(0);
    const taskPollLastSignatureRef = React.useRef<string>('');
    const taskFinalFetchDoneRef = React.useRef(false);

    React.useEffect(() => {
        setTaskChildSeenActive(false);
        setTaskChildPollingStopped(false);
        setTaskPendingFinalFetch(false);
        taskPollNoChangeCountRef.current = 0;
        taskPollLastSignatureRef.current = '';
        taskFinalFetchDoneRef.current = false;
    }, [taskSessionId]);

    React.useEffect(() => {
        if (!taskSessionId) {
            return;
        }

        const childSessionIsActive =
            childSessionActivity.phase === 'busy'
            || childSessionActivity.phase === 'retry'
            || childSessionHasInFlightTools;

        if (childSessionIsActive) {
            if (!taskChildSeenActive) {
                setTaskChildSeenActive(true);
            }
            if (taskChildPollingStopped) {
                setTaskChildPollingStopped(false);
            }
            if (taskPendingFinalFetch) {
                setTaskPendingFinalFetch(false);
            }
            return;
        }

        // Always stop polling if already done.
        if (taskChildPollingStopped && taskFinalFetchDoneRef.current) {
            return;
        }

        // Normal settle path: child went idle after we saw it active, and we have entries.
        // Schedule a grace period before marking polling as stopped.
        if (taskChildSeenActive && childSessionTaskSummaryEntries.length > 0 && !taskChildPollingStopped) {
            if (typeof window === 'undefined') {
                setTaskChildPollingStopped(true);
                return;
            }

            const timer = window.setTimeout(() => {
                setTaskChildPollingStopped(true);
            }, TASK_TOOL_SETTLE_GRACE_MS);

            return () => {
                window.clearTimeout(timer);
            };
        }

        // Final-fetch path: child went idle before parent saw it active, or we have no
        // entries yet. First stop polling after the settle grace period. A separate
        // effect performs the final fetch once polling has fully stopped, avoiding
        // races with any in-flight polling response.
        if (!taskChildPollingStopped && !taskFinalFetchDoneRef.current) {
            if (typeof window === 'undefined') {
                setTaskPendingFinalFetch(true);
                setTaskChildPollingStopped(true);
                return;
            }

            const timer = window.setTimeout(() => {
                setTaskPendingFinalFetch(true);
                setTaskChildPollingStopped(true);
            }, TASK_TOOL_SETTLE_GRACE_MS);

            return () => {
                window.clearTimeout(timer);
            };
        }
    }, [
        childSessionActivity.phase,
        childSessionHasInFlightTools,
        childSessionTaskSummaryEntries.length,
        currentDirectory,
        activeLatched,
        isFinalized,
        taskPendingFinalFetch,
        taskChildPollingStopped,
        taskChildSeenActive,
        taskSessionId,
    ]);

    React.useEffect(() => {
        if (!taskSessionId || !taskChildPollingStopped || !taskPendingFinalFetch || taskFinalFetchDoneRef.current) {
            return;
        }

        let cancelled = false;
        const capturedSessionId = taskSessionId;

        const runFinalFetch = async () => {
            try {
                const scopedClient = opencodeClient.getScopedSdkClient(currentDirectory);
                const response = await scopedClient.session.messages({
                    sessionID: capturedSessionId,
                    limit: TASK_TOOL_INITIAL_FETCH_LIMIT,
                });

                if (cancelled) {
                    return;
                }

                const messages = response.data ?? [];
                if (Array.isArray(messages) && messages.length > 0) {
                    const childStores = getSyncChildStores();
                    childStores.update(currentDirectory, (prev) => {
                        const records = messages as SessionMessageWithParts[];
                        return materializeTaskSessionSnapshot(prev, capturedSessionId, records);
                    });
                }

                taskFinalFetchDoneRef.current = true;
                setTaskPendingFinalFetch(false);
            } catch {
                if (cancelled) {
                    return;
                }

                setTaskPendingFinalFetch(false);
                setTaskChildPollingStopped(false);
            }
        };

        void runFinalFetch();

        return () => {
            cancelled = true;
        };
    }, [
        currentDirectory,
        taskChildPollingStopped,
        taskPendingFinalFetch,
        taskSessionId,
    ]);
    const taskSummaryEntries = React.useMemo<TaskToolSummaryEntry[]>(() => {
        if (childSessionTaskSummaryEntries.length > 0) {
            return childSessionTaskSummaryEntries;
        }
        return metadataTaskSummaryEntries;
    }, [childSessionTaskSummaryEntries, metadataTaskSummaryEntries]);

    React.useEffect(() => {
        if (!taskSessionId) {
            return;
        }

        const childSessionActive = childSessionActivity.phase === 'busy' || childSessionActivity.phase === 'retry';
        const shouldPoll =
            !taskChildPollingStopped
            && (childSessionHasInFlightTools || childSessionActive || childSessionTaskSummaryEntries.length === 0);
        const shouldFetchSnapshot = !taskPendingFinalFetch && (childSessionTaskSummaryEntries.length === 0 || shouldPoll);
        if (!shouldFetchSnapshot) {
            return;
        }

        let cancelled = false;
        let pollTimer: number | undefined;

        const isVisible = () => {
            if (typeof document === 'undefined') {
                return true;
            }
            return document.visibilityState === 'visible';
        };

        const resolveFetchLimit = (isInitialFetch: boolean) => {
            if (isInitialFetch && childSessionTaskSummaryEntries.length === 0) {
                return TASK_TOOL_INITIAL_FETCH_LIMIT;
            }
            if (isActive || childSessionHasInFlightTools || childSessionActive) {
                return TASK_TOOL_ACTIVE_FETCH_LIMIT;
            }
            return TASK_TOOL_IDLE_FETCH_LIMIT;
        };

        const resolvePollDelay = () => {
            if (!isVisible()) {
                return TASK_TOOL_POLL_HIDDEN_MS;
            }
            if (taskPollNoChangeCountRef.current >= TASK_TOOL_NO_CHANGE_BACKOFF_AFTER_POLLS) {
                return TASK_TOOL_POLL_IDLE_MS;
            }
            return TASK_TOOL_POLL_FAST_MS;
        };

        const scheduleNextPoll = () => {
            if (!shouldPoll || typeof window === 'undefined' || cancelled) {
                return;
            }
            pollTimer = window.setTimeout(() => {
                pollTimer = undefined;
                void fetchSessionMessages(false);
            }, resolvePollDelay());
        };

        const fetchSessionMessages = async (isInitialFetch: boolean) => {
            try {
                const scopedClient = opencodeClient.getScopedSdkClient(currentDirectory);
                const response = await scopedClient.session.messages({
                    sessionID: taskSessionId,
                    limit: resolveFetchLimit(isInitialFetch),
                });
                const messages = response.data ?? [];
                if (cancelled || !Array.isArray(messages) || messages.length === 0) {
                    return;
                }

                const nextSignature = buildTaskSessionMessagesSignature(messages as SessionMessageWithParts[]);
                if (nextSignature === taskPollLastSignatureRef.current) {
                    taskPollNoChangeCountRef.current += 1;
                    return;
                }

                taskPollLastSignatureRef.current = nextSignature;
                taskPollNoChangeCountRef.current = 0;
                // Inject fetched subagent messages into sync child store
                const childStores = getSyncChildStores();
                childStores.update(currentDirectory, (prev) => {
                    const records = messages as SessionMessageWithParts[];
                    return materializeTaskSessionSnapshot(prev, taskSessionId, records);
                });
            } catch {
                // Ignore transient subagent fetch errors.
            } finally {
                scheduleNextPoll();
            }
        };

        void fetchSessionMessages(true);

        return () => {
            cancelled = true;
            if (typeof pollTimer === 'number') {
                window.clearTimeout(pollTimer);
            }
        };
    }, [
        childSessionActivity.phase,
        childSessionHasInFlightTools,
        childSessionTaskSummaryEntries.length,
        currentDirectory,
        isActive,
        taskPendingFinalFetch,
        taskChildPollingStopped,
        taskSessionId,
    ]);

    const taskSummaryLenRef = React.useRef<number>(taskSummaryEntries.length);
    React.useEffect(() => {
        if (taskSummaryLenRef.current === taskSummaryEntries.length) {
            return;
        }
        taskSummaryLenRef.current = taskSummaryEntries.length;
        onContentChange?.('structural');
    }, [onContentChange, taskSummaryEntries.length]);

    return <TaskToolSummary {...summaryProps} entries={taskSummaryEntries} sessionId={taskSessionId} />;
};
