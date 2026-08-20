import React from 'react';
import { LazyAgentManagerView, LazyViewBoundary } from '@/components/views/lazyViews';
import { FireworksProvider } from '@/contexts/FireworksContext';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { VSCodeLayout } from '@/components/layout/VSCodeLayout';
import { usePushVisibilityBeacon } from '@/hooks/usePushVisibilityBeacon';
import { useRouter } from '@/hooks/useRouter';
import { useWindowTitle } from '@/hooks/useWindowTitle';
import { opencodeClient } from '@/lib/opencode/client';
import type { RuntimeAPIs } from '@/lib/api/types';
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';
import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { SyncProvider, useDirectorySync, useGlobalSyncSelector } from '@/sync/sync-context';
import { SyncAppEffects } from './AppEffects';
import { useAppFontEffects } from './useAppFontEffects';
import {
  createStartupReadinessSnapshot,
  summarizeStartupReadiness,
  withStartupReadinessPhase,
  type StartupPhaseSnapshot,
  type StartupReadinessSummary,
} from '@/lib/startup/readiness';
import { warmAgentRuntime } from '@/lib/startup/agent-runtime-warmup';
import { warmChatRuntime } from '@/lib/startup/chat-runtime-warmup';
import { primeWorktreeBootstrap } from '@/lib/worktrees/worktreeBootstrap';

type VSCodePanelType = 'chat' | 'agentManager';

declare global {
  interface Window {
    __OPENCHAMBER_PANEL_TYPE__?: VSCodePanelType;
  }
}

type VSCodeAppProps = {
  apis: RuntimeAPIs;
};

type VSCodeDirectoryStartupSnapshot = {
  status: 'loading' | 'partial' | 'complete';
  sessionListStatus: 'idle' | 'loading' | 'ready' | 'error';
  sessionListError?: string;
};

const dispatchVSCodeStartupReady = () => {
  if (typeof window === 'undefined') return;
  (window as unknown as {
    __openchamberAppReady?: boolean;
    __openchamberStartupReady?: boolean;
  }).__openchamberAppReady = true;
  (window as unknown as {
    __openchamberAppReady?: boolean;
    __openchamberStartupReady?: boolean;
  }).__openchamberStartupReady = true;
  window.dispatchEvent(new Event('openchamber:startup-ready'));
  window.dispatchEvent(new Event('openchamber:app-ready'));
};

const setVSCodeLoadingStatus = (text: string) => {
  if (typeof document === 'undefined') return;
  const statusElement = document.getElementById('loading-status');
  if (statusElement) statusElement.textContent = text;
};

const VSCodeDirectoryStartupProbe: React.FC<{
  directory: string;
  onSnapshot: (snapshot: VSCodeDirectoryStartupSnapshot) => void;
}> = ({ directory, onSnapshot }) => {
  const status = useDirectorySync((state) => state.status, directory);
  const sessionListStatus = useDirectorySync((state) => state.sessionListStatus, directory);
  const sessionListError = useDirectorySync((state) => state.sessionListError, directory);

  React.useEffect(() => {
    onSnapshot({ status, sessionListStatus, sessionListError });
  }, [onSnapshot, sessionListError, sessionListStatus, status]);

  return null;
};

const VSCodeStartupReadyDispatcher: React.FC<{
  currentDirectory: string;
  bypassChatReadiness?: boolean;
}> = ({ currentDirectory, bypassChatReadiness }) => {
  const isConnected = useConfigStore((state) => state.isConnected);
  const isInitialized = useConfigStore((state) => state.isInitialized);
  const providersLoadStatus = useConfigStore((state) => state.providersLoadStatus);
  const providersLoadError = useConfigStore((state) => state.providersLoadError);
  const agentsLoadStatus = useConfigStore((state) => state.agentsLoadStatus);
  const agentsLoadError = useConfigStore((state) => state.agentsLoadError);
  const responseStyleInstructionLoaded = useConfigStore((state) => state.responseStyleInstructionLoaded);
  const globalReady = useGlobalSyncSelector((state) => state.ready);
  const globalError = useGlobalSyncSelector((state) => state.error?.message);
  const [directorySnapshot, setDirectorySnapshot] = React.useState<VSCodeDirectoryStartupSnapshot>({
    status: currentDirectory ? 'loading' : 'complete',
    sessionListStatus: currentDirectory ? 'idle' : 'ready',
    sessionListError: undefined,
  });
  const [worktreePhase, setWorktreePhase] = React.useState<StartupPhaseSnapshot>({
    status: currentDirectory ? 'idle' : 'ready',
    error: null,
  });
  const [agentRuntimePhase, setAgentRuntimePhase] = React.useState<StartupPhaseSnapshot>({
    status: bypassChatReadiness ? 'ready' : 'loading',
    error: null,
  });
  const [chatRuntimePhase, setChatRuntimePhase] = React.useState<StartupPhaseSnapshot>({
    status: bypassChatReadiness ? 'ready' : 'loading',
    error: null,
  });
  const dispatchedRef = React.useRef(false);

  const updateDirectorySnapshot = React.useCallback((snapshot: VSCodeDirectoryStartupSnapshot) => {
    setDirectorySnapshot(snapshot);
  }, []);

  React.useEffect(() => {
    if (!bypassChatReadiness) return;
    if (dispatchedRef.current) return;
    dispatchedRef.current = true;
    dispatchVSCodeStartupReady();
  }, [bypassChatReadiness]);

  React.useEffect(() => {
    setDirectorySnapshot({
      status: currentDirectory ? 'loading' : 'complete',
      sessionListStatus: currentDirectory ? 'idle' : 'ready',
      sessionListError: undefined,
    });
  }, [currentDirectory]);

  React.useEffect(() => {
    let cancelled = false;
    if (!currentDirectory || bypassChatReadiness) {
      setWorktreePhase({ status: 'ready', error: null });
      return;
    }
    if (!isConnected) {
      setWorktreePhase({ status: 'idle', error: null });
      return;
    }

    setWorktreePhase({ status: 'loading', error: null });
    void primeWorktreeBootstrap(currentDirectory)
      .then(() => {
        if (!cancelled) setWorktreePhase({ status: 'ready', error: null });
      })
      .catch((error) => {
        if (!cancelled) {
          setWorktreePhase({
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [bypassChatReadiness, currentDirectory, isConnected]);

  React.useEffect(() => {
    let cancelled = false;
    if (bypassChatReadiness) {
      setAgentRuntimePhase({ status: 'ready', error: null });
      return;
    }
    if (!isConnected) {
      setAgentRuntimePhase({ status: 'idle', error: null });
      return;
    }

    setAgentRuntimePhase({ status: 'loading', error: null });
    void warmAgentRuntime({ directory: currentDirectory || null })
      .then((result) => {
        if (result.timedOut) {
          console.warn('[startup] agent runtime warmup timed out; continuing startup.');
        } else if (result.errors.length > 0) {
          console.warn('[startup] agent runtime warmup failed partially; continuing startup:', result.errors);
        }
        if (!cancelled) {
          setAgentRuntimePhase({ status: 'ready', error: null });
        }
      })
      .catch((error) => {
        console.warn('[startup] agent runtime warmup failed; continuing startup:', error);
        if (!cancelled) {
          setAgentRuntimePhase({ status: 'ready', error: null });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [bypassChatReadiness, currentDirectory, isConnected]);

  React.useEffect(() => {
    let cancelled = false;
    if (bypassChatReadiness) {
      setChatRuntimePhase({ status: 'ready', error: null });
      return;
    }

    setChatRuntimePhase({ status: 'loading', error: null });
    void warmChatRuntime()
      .then((result) => {
        if (result.timedOut) {
          console.warn('[startup] chat runtime warmup timed out; continuing startup.');
        }
        if (!cancelled) {
          setChatRuntimePhase({ status: 'ready', error: null });
        }
      })
      .catch((error) => {
        console.warn('[startup] chat runtime warmup failed; continuing startup:', error);
        if (!cancelled) {
          setChatRuntimePhase({ status: 'ready', error: null });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [bypassChatReadiness]);

  const readinessSummary = React.useMemo<StartupReadinessSummary>(() => {
    if (bypassChatReadiness) {
      return { ready: true };
    }

    let snapshot = createStartupReadinessSnapshot('ready');
    if (!isConnected || !isInitialized) {
      snapshot = withStartupReadinessPhase(snapshot, 'health', { status: 'loading' });
    }
    snapshot = withStartupReadinessPhase(snapshot, 'providers', {
      status: providersLoadStatus,
      error: providersLoadError,
    });
    snapshot = withStartupReadinessPhase(snapshot, 'agents', {
      status: agentsLoadStatus,
      error: agentsLoadError,
    });
    snapshot = withStartupReadinessPhase(snapshot, 'globalSync', globalError
      ? { status: 'error', error: globalError }
      : { status: globalReady ? 'ready' : 'loading' });
    snapshot = withStartupReadinessPhase(snapshot, 'directorySync', {
      status: directorySnapshot.status === 'complete' ? 'ready' : 'loading',
    });
    snapshot = withStartupReadinessPhase(snapshot, 'sessionList', {
      status: directorySnapshot.sessionListStatus === 'ready'
        ? 'ready'
        : directorySnapshot.sessionListStatus === 'error'
          ? 'error'
          : 'loading',
      error: directorySnapshot.sessionListError,
    });
    snapshot = withStartupReadinessPhase(snapshot, 'responseStyle', {
      status: responseStyleInstructionLoaded ? 'ready' : 'loading',
    });
    snapshot = withStartupReadinessPhase(snapshot, 'worktree', worktreePhase);
    snapshot = withStartupReadinessPhase(snapshot, 'agentRuntime', agentRuntimePhase);
    snapshot = withStartupReadinessPhase(snapshot, 'chatRuntime', chatRuntimePhase);

    return summarizeStartupReadiness(snapshot, { route: 'main' });
  }, [
    agentsLoadError,
    agentsLoadStatus,
    bypassChatReadiness,
    directorySnapshot.sessionListError,
    directorySnapshot.sessionListStatus,
    directorySnapshot.status,
    globalError,
    globalReady,
    isConnected,
    isInitialized,
    providersLoadError,
    providersLoadStatus,
    responseStyleInstructionLoaded,
    agentRuntimePhase,
    chatRuntimePhase,
    worktreePhase,
  ]);

  React.useEffect(() => {
    if (readinessSummary.ready) return;
    setVSCodeLoadingStatus(
      readinessSummary.error || (readinessSummary.phase === 'agentRuntime'
        ? 'Warming agent runtime'
        : readinessSummary.phase === 'chatRuntime'
          ? 'Warming chat'
          : readinessSummary.phase
            ? `Loading ${readinessSummary.phase}`
            : 'Starting DevRyan'),
    );
  }, [readinessSummary]);

  React.useEffect(() => {
    if (!readinessSummary.ready || dispatchedRef.current) return;
    dispatchedRef.current = true;
    dispatchVSCodeStartupReady();
  }, [readinessSummary.ready]);

  return currentDirectory && !bypassChatReadiness ? (
    <VSCodeDirectoryStartupProbe
      directory={currentDirectory}
      onSnapshot={updateDirectorySnapshot}
    />
  ) : null;
};

export function VSCodeApp({ apis }: VSCodeAppProps) {
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const error = useSessionUIStore((state) => state.error);
  const clearError = useSessionUIStore((state) => state.clearError);
  const refreshGitHubAuthStatus = useGitHubAuthStore((state) => state.refreshStatus);
  const setPlanModeEnabled = useFeatureFlagsStore((state) => state.setPlanModeEnabled);
  const panelType = typeof window !== 'undefined'
    ? window.__OPENCHAMBER_PANEL_TYPE__
    : 'chat';

  React.useEffect(() => {
    registerRuntimeAPIs(apis);
    return () => registerRuntimeAPIs(null);
  }, [apis]);

  useAppFontEffects();
  usePushVisibilityBeacon({ enabled: true });
  useWindowTitle();
  useRouter();

  React.useEffect(() => {
    void refreshGitHubAuthStatus(apis.github, { force: true });
  }, [apis.github, refreshGitHubAuthStatus]);

  React.useEffect(() => {
    let cancelled = false;
    opencodeClient.setContextModeAvailable(false);

    const run = async () => {
      const res = await fetch('/health', { method: 'GET' }).catch(() => null);
      if (!res || !res.ok || cancelled) return;
      const data = (await res.json().catch(() => null)) as null | {
        planModeExperimentalEnabled?: unknown;
        contextModeAvailable?: unknown;
        contextModeReadOnlyIndexing?: unknown;
      };
      if (!data || cancelled) return;
      opencodeClient.setContextModeAvailable(
        data.contextModeAvailable ?? data.contextModeReadOnlyIndexing,
      );
      const raw = data.planModeExperimentalEnabled;
      const enabled = raw === true || raw === 1 || raw === '1' || raw === 'true';
      setPlanModeEnabled(enabled);
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [setPlanModeEnabled]);

  React.useEffect(() => {
    if (!error) {
      return;
    }

    const timeout = window.setTimeout(() => clearError(), 5000);
    return () => window.clearTimeout(timeout);
  }, [clearError, error]);

  if (panelType === 'agentManager') {
    return (
      <ErrorBoundary>
        <SyncProvider sdk={opencodeClient.getSdkClient()} directory={currentDirectory || ''}>
          <RuntimeAPIProvider apis={apis}>
            <TooltipProvider delayDuration={300} skipDelayDuration={150}>
              <div className="h-full text-foreground bg-background">
                <VSCodeStartupReadyDispatcher currentDirectory={currentDirectory} bypassChatReadiness />
                <SyncAppEffects embeddedBackgroundWorkEnabled={true} />
                <LazyViewBoundary>
                  <LazyAgentManagerView />
                </LazyViewBoundary>
                <Toaster />
              </div>
            </TooltipProvider>
          </RuntimeAPIProvider>
        </SyncProvider>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <SyncProvider sdk={opencodeClient.getSdkClient()} directory={currentDirectory || ''}>
        <RuntimeAPIProvider apis={apis}>
          <FireworksProvider>
            <TooltipProvider delayDuration={300} skipDelayDuration={150}>
              <div className="h-full text-foreground bg-background">
                <VSCodeStartupReadyDispatcher currentDirectory={currentDirectory} />
                <SyncAppEffects embeddedBackgroundWorkEnabled={true} />
                <VSCodeLayout />
                <Toaster />
              </div>
            </TooltipProvider>
          </FireworksProvider>
        </RuntimeAPIProvider>
      </SyncProvider>
    </ErrorBoundary>
  );
}
