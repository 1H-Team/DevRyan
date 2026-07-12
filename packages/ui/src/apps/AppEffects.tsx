import React from 'react';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { usePwaManifestSync } from '@/hooks/usePwaManifestSync';
import { useQueuedMessageAutoSend } from '@/hooks/useQueuedMessageAutoSend';
import { useProviderErrorRecovery } from '@/hooks/useProviderErrorRecovery';
import { useSessionAutoCleanup } from '@/hooks/useSessionAutoCleanup';
import { useWindowControlsOverlayLayout } from '@/hooks/useWindowControlsOverlayLayout';
import { setOptimisticRefs } from '@/sync/session-actions';
import { markSessionViewed } from '@/sync/notification-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { setExternallyViewedSession } from '@/sync/sync-context';
import { useSync } from '@/sync/use-sync';
import { quotaRefreshCoordinator } from '@/stores/useQuotaStore';
import { useManagedOrchestrationStore } from '@/stores/useManagedOrchestrationStore';

const MINI_CHAT_PRESENCE_CHANNEL = 'openchamber:mini-chat-presence';
const MANAGED_TASK_EVENT = 'openchamber:managed-task';
const MANAGED_TASK_REMOVED_EVENT = 'openchamber:managed-task-removed';
const MANAGED_WARNING_EVENT = 'openchamber:managed-orchestration-warning';
let managedOrchestrationOwnerCount = 0;
let managedOrchestrationCleanupGeneration = 0;

type MiniChatPresenceMessage = {
  type?: string;
  sessionId?: string;
  directory?: string;
  viewed?: boolean;
};

const SyncOptimisticBridge: React.FC = () => {
  const sync = useSync();
  const addRef = React.useRef(sync.optimistic.add);
  const removeRef = React.useRef(sync.optimistic.remove);
  addRef.current = sync.optimistic.add;
  removeRef.current = sync.optimistic.remove;

  React.useEffect(() => {
    setOptimisticRefs(
      (input) => addRef.current(input),
      (input) => removeRef.current(input),
    );
  }, []);

  return null;
};

const MiniChatPresenceBridge: React.FC = () => {
  React.useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;

    const channel = new BroadcastChannel(MINI_CHAT_PRESENCE_CHANNEL);
    channel.onmessage = (event) => {
      const data = event.data as MiniChatPresenceMessage | null;
      if (data?.type !== 'mini-chat-session-presence' || !data.sessionId || !data.directory) {
        return;
      }

      const viewed = data.viewed !== false;
      setExternallyViewedSession(data.directory, data.sessionId, viewed);
      if (viewed) {
        markSessionViewed(data.sessionId);
        useSessionUIStore.getState().clearReadCompletionIndicators([data.sessionId]);
      }
    };

    return () => channel.close();
  }, []);

  return null;
};

const QuotaRefreshOwner: React.FC<{ enabled: boolean }> = ({ enabled }) => {
  React.useEffect(() => {
    if (!enabled) return;
    quotaRefreshCoordinator.start();
    return () => quotaRefreshCoordinator.stop();
  }, [enabled]);

  return null;
};

const ManagedOrchestrationOwner: React.FC = () => {
  React.useEffect(() => {
    managedOrchestrationOwnerCount += 1;
    managedOrchestrationCleanupGeneration += 1;
    const store = useManagedOrchestrationStore.getState();
    void store.loadSnapshot();

    const ingestWindowEvent = (event: Event) => {
      useManagedOrchestrationStore.getState().ingestEvent((event as CustomEvent<unknown>).detail);
    };
    const handleConnectionStatus = (event: Event) => {
      const detail = (event as CustomEvent<{ status?: unknown }>).detail;
      if (detail?.status === 'connected') {
        void useManagedOrchestrationStore.getState().loadSnapshot();
      }
    };
    window.addEventListener(MANAGED_TASK_EVENT, ingestWindowEvent);
    window.addEventListener(MANAGED_TASK_REMOVED_EVENT, ingestWindowEvent);
    window.addEventListener(MANAGED_WARNING_EVENT, ingestWindowEvent);
    window.addEventListener('openchamber:connection-status', handleConnectionStatus);

    return () => {
      window.removeEventListener(MANAGED_TASK_EVENT, ingestWindowEvent);
      window.removeEventListener(MANAGED_TASK_REMOVED_EVENT, ingestWindowEvent);
      window.removeEventListener(MANAGED_WARNING_EVENT, ingestWindowEvent);
      window.removeEventListener('openchamber:connection-status', handleConnectionStatus);
      managedOrchestrationOwnerCount = Math.max(0, managedOrchestrationOwnerCount - 1);
      const cleanupGeneration = ++managedOrchestrationCleanupGeneration;
      queueMicrotask(() => {
        if (
          managedOrchestrationOwnerCount === 0
          && managedOrchestrationCleanupGeneration === cleanupGeneration
        ) {
          useManagedOrchestrationStore.getState().reset();
        }
      });
    };
  }, []);

  return null;
};

export function SyncRuntimeEffects({ embeddedBackgroundWorkEnabled }: {
  embeddedBackgroundWorkEnabled: boolean;
}) {
  useSessionAutoCleanup(embeddedBackgroundWorkEnabled);
  useProviderErrorRecovery(embeddedBackgroundWorkEnabled);
  useQueuedMessageAutoSend(embeddedBackgroundWorkEnabled);

  return <SyncOptimisticBridge />;
}

export function SyncAppEffects({ embeddedBackgroundWorkEnabled }: {
  embeddedBackgroundWorkEnabled: boolean;
}) {
  usePwaManifestSync();
  useWindowControlsOverlayLayout();
  useKeyboardShortcuts();

  return (
    <>
      <SyncRuntimeEffects embeddedBackgroundWorkEnabled={embeddedBackgroundWorkEnabled} />
      <MiniChatPresenceBridge />
      <QuotaRefreshOwner enabled={embeddedBackgroundWorkEnabled} />
      <ManagedOrchestrationOwner />
    </>
  );
}
