import React from 'react';
import type { ContentChangeReason } from '@/hooks/useChatAutoFollow';
import { useSessionActivity } from '@/hooks/useSessionActivity';
import { opencodeClient } from '@/lib/opencode/client';
import { useEnsureSessionMessages, useSessionMessageRecords } from '@/sync/sync-context';
import { getSyncChildStores } from '@/sync/sync-refs';
import { TaskToolSummary } from './TaskToolSummary';
import {
    buildTaskSummaryEntriesFromSession,
    materializeTaskSessionSnapshot,
    type TaskToolSummaryEntry,
} from './taskToolUtils';

// SSE owns live activity. HTTP only repairs a silent stream or settles a child.
const TASK_TOOL_RECOVERY_MS = 20_000;
const TASK_TOOL_SETTLE_GRACE_MS = 2500;
const TASK_TOOL_RECOVERY_FETCH_LIMIT = 30;

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
 * The opened sub-agent card: loads and follows the child session's
 * messages to list its tool activity. A collapsed card renders from the task
 * tool part alone (prompt, status, duration, result), so a transcript with many
 * running sub-agents holds and re-renders no child transcripts until one is opened.
 */
export const TaskChildSessionSummary: React.FC<TaskChildSessionSummaryProps> = ({
    taskSessionId,
    currentDirectory,
    isTaskActive: _isActive,
    isFinalized: _isFinalized,
    activeLatched: _activeLatched,
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

    const childSessionActivity = useSessionActivity(taskSessionId, currentDirectory);
    const taskSummaryEntries = childSessionTaskSummaryEntries.length > 0
        ? childSessionTaskSummaryEntries : metadataTaskSummaryEntries;
    const isActive = childSessionActivity.phase === 'busy' || childSessionActivity.phase === 'retry';
    const settledRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        if (!taskSessionId) return;
        if (isActive) settledRef.current = null;
        else if (settledRef.current === taskSessionId) return;
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const schedule = () => {
            timer = setTimeout(() => { void recover(); }, isActive ? TASK_TOOL_RECOVERY_MS : TASK_TOOL_SETTLE_GRACE_MS);
        };
        const recover = async () => {
            // Hidden cards consume SSE but do not repeatedly load HTTP snapshots.
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
                schedule();
                return;
            }
            try {
                const query = { sessionID: taskSessionId, limit: TASK_TOOL_RECOVERY_FETCH_LIMIT, $query_toolOutput: 'omit' };
                const response = await opencodeClient.getScopedSdkClient(currentDirectory).session.messages(query);
                if (cancelled) return;
                const records = response.data;
                if (Array.isArray(records) && records.length > 0) {
                    getSyncChildStores().update(currentDirectory, (previous) =>
                        materializeTaskSessionSnapshot(previous, taskSessionId, records));
                }
                if (!isActive) settledRef.current = taskSessionId;
            } catch {
                // Keep the last SSE evidence; retry the same bounded read after silence.
            } finally {
                if (!cancelled && (isActive || settledRef.current !== taskSessionId)) schedule();
            }
        };
        schedule();
        return () => { cancelled = true; if (timer) clearTimeout(timer); };
        // Fresh exact-child SSE records restart the silence deadline; unrelated
        // directory activity keeps this snapshot's identity and cannot postpone it.
    }, [childSessionMessages, currentDirectory, isActive, taskSessionId]);

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
