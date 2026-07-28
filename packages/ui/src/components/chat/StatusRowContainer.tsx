import React from 'react';

import { useAssistantStatus, type AssistantActivePartType } from '@/hooks/useAssistantStatus';
import { useConfigStore } from '@/stores/useConfigStore';
import { useI18n } from '@/lib/i18n';
import { useSessionRevertPending } from '@/sync/sync-context';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { StatusRow } from './StatusRow';
import { isManagedTaskToolName } from './message/parts/toolRenderUtils';
import { getAssistantToolStatusPhrase } from '@/hooks/assistantStatusFormatting';
import {
    managedOrchestrationSelectors,
    useManagedOrchestrationStore,
} from '@/stores/useManagedOrchestrationStore';

// Exported for focused regression tests; keep component exports unchanged otherwise.
// eslint-disable-next-line react-refresh/only-export-components
export const shouldRenderStatusRowAssistantStatus = (
    activePartType: AssistantActivePartType,
    isWorking: boolean,
    managedBarrierOwnsStatus = false,
    managedChildOwnsIdleStatus = false,
): boolean => (
    // A managed child keeps running after its parent turn ends — that is the
    // normal shape of a recovered subtask, and of one whose parent tool wait
    // detached. Without this the row went blank while a subagent was actively
    // working, so the session looked finished or dead.
    managedChildOwnsIdleStatus
    || (isWorking && (activePartType !== 'reasoning' || managedBarrierOwnsStatus))
);

// Exported for focused regression tests; keep component exports unchanged otherwise.
// eslint-disable-next-line react-refresh/only-export-components
export const resolveStatusRowAssistantDisplay = ({
    isRevertPending,
    revertingText,
    showWorkingPlaceholder,
    assistantStatusText,
    assistantIsGenericStatus,
}: {
    isRevertPending: boolean;
    revertingText: string;
    showWorkingPlaceholder: boolean;
    assistantStatusText: string | null;
    assistantIsGenericStatus: boolean;
}): { isWorking: boolean; statusText: string | null; isGenericStatus: boolean } => {
    if (isRevertPending) {
        return { isWorking: true, statusText: revertingText, isGenericStatus: false };
    }
    return {
        isWorking: showWorkingPlaceholder,
        statusText: showWorkingPlaceholder ? assistantStatusText : null,
        isGenericStatus: assistantIsGenericStatus,
    };
};

/**
 * Status row wrapper.
 * Uses the dedicated assistant status hook so the row keeps accurate live activity
 * labels while still limiting subscriptions to the active assistant message.
 */
export const StatusRowContainer: React.FC = React.memo(() => {
    const { t } = useI18n();
    const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
    const isRevertPending = useSessionRevertPending(currentSessionId ?? '');
    const abortRecord = useSessionUIStore(
        React.useCallback((state) => {
            if (!currentSessionId) {
                return null;
            }
            return state.sessionAbortFlags?.get(currentSessionId) ?? null;
        }, [currentSessionId]),
    );
    const { working } = useAssistantStatus();
    const currentAgentName = useConfigStore((state) => state.currentAgentName);
    const managedBarrierLocked = useManagedOrchestrationStore(React.useMemo(
        () => managedOrchestrationSelectors.hasUndispositionedTasksForRoot(currentSessionId ?? ''),
        [currentSessionId],
    ));

    const managedChildActive = useManagedOrchestrationStore(React.useMemo(
        () => managedOrchestrationSelectors.hasActiveTasksForRoot(currentSessionId ?? ''),
        [currentSessionId],
    ));

    const wasAborted = Boolean(abortRecord && !abortRecord.acknowledged);
    // Only speak for the row once the parent turn has nothing of its own to say,
    // so a builder that legitimately keeps working alongside a managed child
    // still reports its own activity.
    const managedChildOwnsIdleStatus = !working.isWorking && managedChildActive;
    const managedBarrierOwnsStatus = managedChildOwnsIdleStatus || (managedBarrierLocked && (
        working.activePartType === 'reasoning'
        || working.activePartType === undefined
        || (
            working.activePartType === 'tool'
            && isManagedTaskToolName(working.activeToolName ?? '')
        )
    ));
    const showWorkingPlaceholder = shouldRenderStatusRowAssistantStatus(
        working.activePartType,
        working.isWorking,
        managedBarrierOwnsStatus,
        managedChildOwnsIdleStatus,
    );
    const display = resolveStatusRowAssistantDisplay({
        isRevertPending,
        revertingText: t('chat.statusRow.revertingChat'),
        showWorkingPlaceholder,
        assistantStatusText: managedBarrierOwnsStatus
            ? getAssistantToolStatusPhrase('devryan_task')
            : working.statusText,
        assistantIsGenericStatus: managedBarrierOwnsStatus ? false : working.isGenericStatus,
    });

    return (
        <StatusRow
            isWorking={display.isWorking}
            statusText={display.statusText}
            isGenericStatus={display.isGenericStatus}
            isWaitingForPermission={isRevertPending ? false : working.isWaitingForPermission}
            wasAborted={isRevertPending ? false : wasAborted || working.wasAborted}
            abortActive={isRevertPending ? false : wasAborted || working.abortActive}
            retryInfo={isRevertPending ? null : working.retryInfo}
            showAssistantStatus
            showTodos={false}
            agentName={currentAgentName}
        />
    );
});

StatusRowContainer.displayName = 'StatusRowContainer';
