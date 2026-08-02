import React from 'react';

import { useAssistantStatus, type AssistantActivePartType } from '@/hooks/useAssistantStatus';
import { useConfigStore } from '@/stores/useConfigStore';
import { useI18n } from '@/lib/i18n';
import {
    useSessionRevertPending,
    useSyncChildStores,
    useSyncResyncSession,
} from '@/sync/sync-context';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { StatusRow } from './StatusRow';
import { isManagedTaskToolName } from './message/parts/toolRenderUtils';
import { getAssistantToolStatusPhrase } from '@/hooks/assistantStatusFormatting';
import {
    managedOrchestrationSelectors,
    useManagedOrchestrationStore,
} from '@/stores/useManagedOrchestrationStore';
import { getToolMetadata } from '@/lib/toolHelpers';
import { useProviderRecoveryStore } from '@/stores/useProviderRecoveryStore';
import {
    providerStallSelector,
    useProviderStallStore,
} from '@/stores/useProviderStallStore';
import { stopStalledProviderAndOfferRecovery } from '@/sync/provider-stall-recovery';
import { haveSameProviderStallFingerprint } from '@/sync/reconnect-recovery';

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
    const childStores = useSyncChildStores();
    const resyncSession = useSyncResyncSession();
    const isRevertPending = useSessionRevertPending(currentSessionId ?? '');
    const providerStall = useProviderStallStore(React.useMemo(
        () => providerStallSelector(currentSessionId ?? ''),
        [currentSessionId],
    ));
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
    const resolveProviderStall = React.useCallback(async () => {
        if (!currentSessionId) return;
        const current = useProviderStallStore.getState().stallsBySessionId[currentSessionId];
        if (!current || current.pending) return;

        useProviderStallStore.getState().setActionState(currentSessionId, true, null);
        try {
            const outcome = await stopStalledProviderAndOfferRecovery(current, {
                resyncSession,
                getState: () => childStores.getChild(current.directory)?.getState(),
                isCurrent: () => {
                    const latest = useProviderStallStore.getState().stallsBySessionId[currentSessionId];
                    return haveSameProviderStallFingerprint(current, latest);
                },
                abort: async (sessionID, status) => {
                    const { abortCurrentOperationConfirmed } = await import('@/sync/session-actions');
                    const latest = useProviderStallStore.getState().stallsBySessionId[sessionID];
                    if (!haveSameProviderStallFingerprint(current, latest)) return false;
                    return abortCurrentOperationConfirmed(sessionID, status);
                },
                offerRecovery: (recovery) => useProviderRecoveryStore.getState().offerRecovery(recovery),
            });
            useProviderStallStore.getState().clearStall(currentSessionId, current);
            if (outcome === 'stream-resumed') return;
        } catch (error) {
            useProviderStallStore.getState().setActionState(
                currentSessionId,
                false,
                error instanceof Error ? error.message : String(error),
            );
        }
    }, [childStores, currentSessionId, resyncSession]);
    const providerStallTool = providerStall?.kind === 'tool-input'
        ? getToolMetadata(providerStall.tool).displayName.replace(/:\s*$/, '')
        : null;

    return (
        <StatusRow
            isWorking={display.isWorking}
            statusText={display.statusText}
            isGenericStatus={display.isGenericStatus}
            isWaitingForPermission={isRevertPending ? false : working.isWaitingForPermission}
            wasAborted={isRevertPending ? false : wasAborted || working.wasAborted}
            abortActive={isRevertPending ? false : wasAborted || working.abortActive}
            retryInfo={isRevertPending ? null : working.retryInfo}
            providerStallStatusText={providerStallTool
                ? t('chat.statusRow.providerStall.status', { tool: providerStallTool })
                : providerStall
                    ? t('chat.statusRow.providerStall.inferenceStatus')
                    : null}
            providerStallPending={providerStall?.pending ?? false}
            providerStallError={providerStall?.actionError ?? null}
            onResolveProviderStall={providerStall ? resolveProviderStall : undefined}
            showAssistantStatus
            showTodos={false}
            agentName={currentAgentName}
        />
    );
});

StatusRowContainer.displayName = 'StatusRowContainer';
