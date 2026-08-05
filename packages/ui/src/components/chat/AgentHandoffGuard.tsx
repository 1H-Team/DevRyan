import React from 'react';

import { managedOrchestrationApi } from '@/lib/orchestrationApi';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import {
  createAgentHandoffCoordinator,
  shouldReconcileBuilderSession,
} from './agentHandoffCoordinator';
import { DeferredChatDialog, LazyAgentHandoffDialog } from './lazyChatDialogs';
import { LazyViewBoundary } from '@/components/views/lazyViews';
import {
  AgentHandoffGuardContext,
  registerQueuedBuilderSendGuard,
  type AgentChangeRequest,
  type AgentHandoffGuardValue,
  type BuilderSendRequest,
} from './agentHandoffGuardContext';

const normalizedAgent = (value: string | null | undefined) => value?.trim().toLowerCase() ?? '';

const resolveAgentName = (requestedName: string) => (
  useConfigStore.getState().agents.find((agent) => (
    normalizedAgent(agent.name) === normalizedAgent(requestedName)
  ))?.name ?? requestedName
);

const commitExistingSessionAgent = (sessionId: string, requestedName: string) => {
  const agentName = resolveAgentName(requestedName);
  useConfigStore.getState().setAgent(agentName);
  useSelectionStore.getState().saveSessionAgentSelection(sessionId, agentName);
};

export const AgentHandoffGuardProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const coordinator = React.useMemo(() => createAgentHandoffCoordinator({
    api: managedOrchestrationApi,
  }), []);
  const state = React.useSyncExternalStore(
    coordinator.subscribe,
    coordinator.getState,
    coordinator.getState,
  );
  const currentSessionId = useSessionUIStore((store) => store.currentSessionId);
  const sessionSavedAgentName = useSelectionStore((store) => (
    currentSessionId ? store.sessionAgentSelections.get(currentSessionId) ?? null : null
  ));

  React.useEffect(() => {
    coordinator.setSession(currentSessionId);
  }, [coordinator, currentSessionId]);

  const restoreOrchestrator = React.useCallback((sessionId: string) => {
    commitExistingSessionAgent(sessionId, 'Orchestrator');
  }, []);

  const commitBuilder = React.useCallback((sessionId: string) => {
    useSelectionStore.getState().markBuilderHandoffCleared(sessionId);
    commitExistingSessionAgent(sessionId, 'Builder');
  }, []);

  React.useEffect(() => {
    if (!shouldReconcileBuilderSession({
      sessionId: currentSessionId,
      savedAgentName: sessionSavedAgentName,
      handoffCleared: currentSessionId
        ? useSelectionStore.getState().hasBuilderHandoffClearance(currentSessionId)
        : false,
    })) {
      return;
    }
    if (!currentSessionId) return;

    void coordinator.reconcileBuilderSession({
      sessionId: currentSessionId,
      restoreOrchestrator: () => restoreOrchestrator(currentSessionId),
      commitBuilder: () => commitBuilder(currentSessionId),
    });
  }, [commitBuilder, coordinator, currentSessionId, restoreOrchestrator, sessionSavedAgentName]);

  const requestAgentChange = React.useCallback(async (request: AgentChangeRequest) => {
    await coordinator.requestAgentChange(request);
  }, [coordinator]);

  const guardBuilderSend = React.useCallback(async (request: BuilderSendRequest) => {
    const sessionId = request.sessionId;
    if (!sessionId || normalizedAgent(request.agentName) !== 'builder') return true;
    if (useSessionUIStore.getState().currentSessionId !== sessionId) {
      try {
        const result = await managedOrchestrationApi.handoff({
          rootSessionId: sessionId,
          fromMode: 'orchestrator',
          toMode: 'builder',
          confirm: false,
        });
        return result.state === 'clear';
      } catch {
        return false;
      }
    }
    if (coordinator.isBuilderSendBlocked(sessionId)) return false;

    const builderIsSelected = normalizedAgent(
      useSelectionStore.getState().getSessionAgentSelection(sessionId),
    ) === 'builder';

    const result = await coordinator.reconcileBuilderSession({
      sessionId,
      restoreOrchestrator: builderIsSelected
        ? () => restoreOrchestrator(sessionId)
        : () => undefined,
      commitBuilder: builderIsSelected
        ? () => commitBuilder(sessionId)
        : () => undefined,
    });
    return result?.state === 'clear';
  }, [commitBuilder, coordinator, restoreOrchestrator]);

  React.useEffect(() => registerQueuedBuilderSendGuard(guardBuilderSend), [guardBuilderSend]);

  const value = React.useMemo<AgentHandoffGuardValue>(() => ({
    requestAgentChange,
    guardBuilderSend,
  }), [guardBuilderSend, requestAgentChange]);

  return (
    <AgentHandoffGuardContext.Provider value={value}>
      {children}
      <DeferredChatDialog active={state.open}>
        <LazyViewBoundary>
          <LazyAgentHandoffDialog
            state={state}
            onCancel={() => { coordinator.cancel(); }}
            onConfirm={() => { void coordinator.confirm(); }}
            onRetry={() => { void coordinator.retry(); }}
          />
        </LazyViewBoundary>
      </DeferredChatDialog>
    </AgentHandoffGuardContext.Provider>
  );
};
