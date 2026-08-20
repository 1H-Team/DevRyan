import React from 'react';
import type { ManagedTaskEventRecord } from '@openchamber/orchestration-runtime';

import { useAssistantStatus } from '@/hooks/useAssistantStatus';
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
import {
    haveSameLongRunningToolFingerprint,
    haveSameProviderStallFingerprint,
} from '@/sync/reconnect-recovery';
import {
    longRunningToolSelector,
    useLongRunningToolStore,
    type LongRunningToolRecord,
} from '@/stores/useLongRunningToolStore';
import { stopLongRunningTool } from '@/sync/long-running-tool-recovery';
import { formatElapsedDuration } from '@/lib/duration';
import { useDocumentAnimationState } from '@/hooks/useDocumentAnimationState';

type ManagedDelegationStatusPhase = 'starting' | 'waiting' | null;

const MANAGED_START_ACTIONS = new Set(['start', 'retry']);
const MANAGED_WAIT_ACTIONS = new Set([
    'status',
    'wait',
    'cancel',
    'continue',
    'resume',
    'recover_in_place',
    'retry_in_place',
    'abandon',
]);

// Exported for focused regression tests. The scheduler phase wins once a
// child is actually running; before its first durable task event, the live
// start call keeps the status truthful while the Agent Dispatch card prepares.
// eslint-disable-next-line react-refresh/only-export-components
export const resolveManagedDelegationStatusPhase = ({
    rootPhase,
    activeToolName,
    activeToolAction,
}: {
    rootPhase: ManagedDelegationStatusPhase;
    activeToolName?: string;
    activeToolAction?: string;
}): ManagedDelegationStatusPhase => {
    if (rootPhase === 'waiting') return 'waiting';
    if (!isManagedTaskToolName(activeToolName ?? '')) return rootPhase;
    const action = activeToolAction?.trim().toLowerCase();
    if (action && MANAGED_WAIT_ACTIONS.has(action)) return 'waiting';
    if (action && MANAGED_START_ACTIONS.has(action)) return 'starting';
    return rootPhase ?? 'starting';
};

const useElapsedToolLabel = (startedAt: number | undefined): string | null => {
    const [, setTick] = React.useState(0);
    const { isVisible } = useDocumentAnimationState();

    React.useEffect(() => {
        if (typeof startedAt !== 'number' || !isVisible) return;
        const timer = window.setInterval(() => setTick((tick) => tick + 1), 1_000);
        return () => window.clearInterval(timer);
    }, [isVisible, startedAt]);

    if (typeof startedAt !== 'number') return null;
    const duration = formatElapsedDuration(startedAt, undefined);
    return duration.available ? duration.label : null;
};

// Exported for focused regression tests; keeps alias display and action gating deterministic.
// eslint-disable-next-line react-refresh/only-export-components
export const resolveLongRunningToolPresentation = (
    record: Pick<LongRunningToolRecord, 'tool' | 'confirmedAt'> | undefined,
    elapsed: string | null,
): { tool: string; elapsed: string | null; actionable: boolean } | null => {
    if (!record) return null;
    return {
        tool: getToolMetadata(record.tool).displayName.replace(/:\s*$/, ''),
        elapsed,
        actionable: record.confirmedAt !== null,
    };
};

// Exported for focused regression tests; keep component exports unchanged otherwise.
// eslint-disable-next-line react-refresh/only-export-components
export const shouldRenderStatusRowAssistantStatus = (
    isWorking: boolean,
    managedChildOwnsIdleStatus = false,
): boolean => (
    // A managed child keeps running after its parent turn ends — that is the
    // normal shape of a recovered subtask, and of one whose parent tool wait
    // detached. Without this the row went blank while a subagent was actively
    // working, so the session looked finished or dead.
    // The row stays visible during reasoning too — it owns the "Thinking"
    // indicator so activity text never jumps between screen positions.
    managedChildOwnsIdleStatus || isWorking
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

// Exported for focused regression tests; keep generic managed-child copy tied
// to the scheduler's authoritative attempt instead of a random working phrase.
// eslint-disable-next-line react-refresh/only-export-components
export const resolveManagedChildGenericStatusText = ({
    task,
    isGenericStatus,
    waitingText,
    recoveringText,
}: {
    task?: Pick<ManagedTaskEventRecord, 'executionKind' | 'status'>;
    isGenericStatus: boolean;
    waitingText: string;
    recoveringText: string;
}): string | null => {
    if (!isGenericStatus || !task) return null;
    if (task.status !== 'queued' && task.status !== 'starting' && task.status !== 'running') {
        return null;
    }
    return task.executionKind === 'resume'
        || task.executionKind === 'recover_in_place'
        || task.executionKind === 'retry_in_place'
        ? recoveringText
        : waitingText;
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
    const longRunningTool = useLongRunningToolStore(React.useMemo(
        () => longRunningToolSelector(currentSessionId ?? ''),
        [currentSessionId],
    ));
    const longRunningElapsed = useElapsedToolLabel(
        longRunningTool && longRunningTool.confirmedAt !== null
            ? longRunningTool.observedAt
            : undefined,
    );
    const longRunningPresentation = resolveLongRunningToolPresentation(
        longRunningTool,
        longRunningElapsed,
    );
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
    const managedRootDelegationPhase = useManagedOrchestrationStore(React.useMemo(
        () => managedOrchestrationSelectors.delegationPhaseForRoot(currentSessionId ?? ''),
        [currentSessionId],
    ));
    const currentManagedTask = useManagedOrchestrationStore(React.useMemo(
        () => managedOrchestrationSelectors.latestTaskForChildSession(currentSessionId ?? ''),
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
    const managedDelegationPhase = resolveManagedDelegationStatusPhase({
        rootPhase: managedRootDelegationPhase,
        activeToolName: working.activeToolName,
        activeToolAction: working.activeToolAction,
    });
    const showWorkingPlaceholder = shouldRenderStatusRowAssistantStatus(
        working.isWorking,
        managedChildOwnsIdleStatus,
    );
    const managedChildGenericStatusText = resolveManagedChildGenericStatusText({
        task: currentManagedTask,
        isGenericStatus: working.isGenericStatus,
        waitingText: t('chat.statusRow.managedChild.waitingForModel'),
        recoveringText: t('chat.statusRow.managedChild.recovering'),
    });
    let assistantStatusText = working.statusText;
    let assistantIsGenericStatus = working.isGenericStatus;
    if (managedChildGenericStatusText) {
        assistantStatusText = managedChildGenericStatusText;
        assistantIsGenericStatus = false;
    }
    if (managedBarrierOwnsStatus || (
        working.activePartType === 'tool'
        && isManagedTaskToolName(working.activeToolName ?? '')
    )) {
        assistantStatusText = managedDelegationPhase === 'starting'
            ? t('chat.statusRow.managedTasks.starting')
            : t('chat.statusRow.managedTasks.waiting');
        assistantIsGenericStatus = false;
    }
    if (longRunningPresentation && !longRunningPresentation.actionable) {
        assistantStatusText = t('chat.statusRow.longRunningTool.running', {
            tool: longRunningPresentation.tool,
        });
    }
    const display = resolveStatusRowAssistantDisplay({
        isRevertPending,
        revertingText: t('chat.statusRow.revertingChat'),
        showWorkingPlaceholder,
        assistantStatusText,
        assistantIsGenericStatus,
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
    const stopCurrentLongRunningTool = React.useCallback(async () => {
        if (!currentSessionId) return;
        const current = useLongRunningToolStore.getState().recordsBySessionId[currentSessionId];
        if (!current?.confirmedAt || current.pending) return;

        useLongRunningToolStore.getState().setActionState(currentSessionId, true, null);
        try {
            await stopLongRunningTool(current, {
                resyncSession,
                getState: () => childStores.getChild(current.directory)?.getState(),
                isCurrent: () => {
                    const latest = useLongRunningToolStore.getState().recordsBySessionId[currentSessionId];
                    return haveSameLongRunningToolFingerprint(current, latest);
                },
                abort: async (sessionID, status) => {
                    const { abortCurrentOperationConfirmed } = await import('@/sync/session-actions');
                    const latest = useLongRunningToolStore.getState().recordsBySessionId[sessionID];
                    if (!haveSameLongRunningToolFingerprint(current, latest)) return false;
                    return abortCurrentOperationConfirmed(sessionID, status);
                },
            });
            useLongRunningToolStore.getState().clearTool(currentSessionId, current);
        } catch (error) {
            useLongRunningToolStore.getState().setActionState(
                currentSessionId,
                false,
                error instanceof Error ? error.message : String(error),
            );
        }
    }, [childStores, currentSessionId, resyncSession]);
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
            longRunningToolStatusText={longRunningPresentation?.actionable
                ? t('chat.statusRow.longRunningTool.status', {
                    tool: longRunningPresentation.tool,
                    elapsed: longRunningPresentation.elapsed ?? '',
                })
                : null}
            longRunningToolPending={longRunningTool?.pending ?? false}
            longRunningToolError={longRunningTool?.actionError ?? null}
            onStopLongRunningTool={longRunningPresentation?.actionable ? stopCurrentLongRunningTool : undefined}
            showAssistantStatus
            showTodos={false}
            agentName={currentAgentName}
        />
    );
});

StatusRowContainer.displayName = 'StatusRowContainer';
