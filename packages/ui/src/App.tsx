import React from 'react';
import { MainLayout } from '@/components/layout/MainLayout';
import { ChatView } from '@/components/views/ChatView';
import { FireworksProvider } from '@/contexts/FireworksContext';
import { Toaster } from '@/components/ui/sonner';
import { MemoryDebugPanel } from '@/components/ui/MemoryDebugPanel';
import { RuntimeLoadingScreen } from '@/components/ui/RuntimeLoadingScreen';
import { setStreamPerfEnabled, streamDebugEnabled } from '@/stores/utils/streamDebug';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
// useEventStream removed — replaced by SyncProvider + SyncBridge
import { useMenuActions } from '@/hooks/useMenuActions';
import { useRouter } from '@/hooks/useRouter';
import { usePushVisibilityBeacon } from '@/hooks/usePushVisibilityBeacon';
import { useWindowTitle } from '@/hooks/useWindowTitle';
import { useConfigStore } from '@/stores/useConfigStore';
import { hasModifier } from '@/lib/utils';
import { isDesktopLocalOriginActive, isDesktopShell, isTauriShell, restartDesktopApp } from '@/lib/desktop';
import {
  getInjectedBootOutcome,
  getBootInjectionStatus,
  resolveDesktopBootView,
  shouldRestartDesktopBootFlow,
  type BootInjectionStatus,
  type DesktopBootView,
} from '@/lib/desktopBoot';
import type { RecoveryVariant } from '@/components/onboarding/DesktopConnectionRecovery';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { opencodeClient } from '@/lib/opencode/client';
import { SyncProvider, useDirectorySync, useGlobalSyncSelector, useSessions } from '@/sync/sync-context';
import { ConfigUpdateOverlay } from '@/components/ui/ConfigUpdateOverlay';
import { AboutDialog } from '@/components/ui/AboutDialog';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { VoiceProvider } from '@/components/voice';
import { useUIStore } from '@/stores/useUIStore';
import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';
import type { RuntimeAPIs } from '@/lib/api/types';
import { TooltipProvider } from '@/components/ui/tooltip';
import { McpOAuthCallbackPage } from '@/components/sections/mcp/McpOAuthCallbackPage';
import { MCP_OAUTH_CALLBACK_PATH } from '@/components/sections/mcp/mcpOAuth';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { applyMobileKeyboardMode } from '@/lib/mobileKeyboardMode';
import { SyncAppEffects } from '@/apps/AppEffects';
import { useAppFontEffects } from '@/apps/useAppFontEffects';
import {
  createStartupReadinessSnapshot,
  recoverStartupInitialization,
  shouldShowStartupReadinessScreen,
  summarizeStartupReadiness,
  withStartupBootstrapReadiness,
  withStartupReadinessPhase,
  type StartupPhaseSnapshot,
  type StartupReadinessSummary,
} from '@/lib/startup/readiness';
import { warmAgentRuntime } from '@/lib/startup/agent-runtime-warmup';
import { warmChatRuntime } from '@/lib/startup/chat-runtime-warmup';
import { primeWorktreeBootstrap } from '@/lib/worktrees/worktreeBootstrap';
import { useAgentRuntimeWarmupStore } from '@/stores/useAgentRuntimeWarmupStore';
import { isPrincipalStorageEvent } from '@/stores/utils/safeStorage';
import { useAuthPrincipal } from '@/lib/authSession';
import { initClientErrorCapture } from '@/lib/client-error-capture';

// Lazy-loaded heavy views — loaded on demand to reduce initial bundle size.
const OnboardingScreen = lazyWithChunkRecovery(() =>
  import('@/components/onboarding/OnboardingScreen').then((m) => ({ default: m.OnboardingScreen })),
);

const AboutDialogWrapper: React.FC = () => {
  const isAboutDialogOpen = useUIStore((s) => s.isAboutDialogOpen);
  const setAboutDialogOpen = useUIStore((s) => s.setAboutDialogOpen);
  return (
    <AboutDialog
      open={isAboutDialogOpen}
      onOpenChange={setAboutDialogOpen}
    />
  );
};

type AppProps = {
  apis: RuntimeAPIs;
};

type EmbeddedSessionChatConfig = {
  sessionId: string;
  directory: string | null;
};

type EmbeddedVisibilityPayload = {
  visible?: unknown;
};

const readEmbeddedSessionChatConfig = (): EmbeddedSessionChatConfig | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  const params = new URLSearchParams(window.location.search);
  if (params.get('ocPanel') !== 'session-chat') {
    return null;
  }

  const sessionIdRaw = params.get('sessionId');
  const sessionId = typeof sessionIdRaw === 'string' ? sessionIdRaw.trim() : '';
  if (!sessionId) {
    return null;
  }

  const directoryRaw = params.get('directory');
  const directory = typeof directoryRaw === 'string' && directoryRaw.trim().length > 0
    ? directoryRaw.trim()
    : null;

  return {
    sessionId,
    directory,
  };
};

const isMcpOAuthCallbackPath = (): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.location.pathname === MCP_OAUTH_CALLBACK_PATH;
};

const EmbeddedSessionSelectionGate: React.FC<{
  embeddedSessionChat: EmbeddedSessionChatConfig | null;
  isVSCodeRuntime: boolean;
}> = ({ embeddedSessionChat, isVSCodeRuntime }) => {
  const sessions = useSessions();
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);

  React.useEffect(() => {
    if (!embeddedSessionChat || isVSCodeRuntime) {
      return;
    }

    if (currentSessionId === embeddedSessionChat.sessionId) {
      return;
    }

    if (!sessions.some((session) => session.id === embeddedSessionChat.sessionId)) {
      return;
    }

    void setCurrentSession(embeddedSessionChat.sessionId);
  }, [currentSessionId, embeddedSessionChat, isVSCodeRuntime, sessions, setCurrentSession]);

  return null;
};

const dismissInitialLoadingElement = () => {
  if (typeof document === 'undefined') return;
  const loadingElement = document.getElementById('initial-loading');
  if (!loadingElement) return;
  loadingElement.classList.add('fade-out');
  window.setTimeout(() => {
    loadingElement.remove();
  }, 300);
};

const setInitialLoadingStatus = (text: string) => {
  if (typeof document === 'undefined') return;
  const statusElement = document.getElementById('loading-status');
  if (!statusElement) return;
  statusElement.textContent = text;
};

const STARTUP_PHASE_LABELS = {
  health: 'Waiting for OpenCode',
  providers: 'Loading providers',
  agents: 'Loading agents',
  initialization: 'Finishing initialization',
  globalSync: 'Syncing workspace',
  directorySync: 'Preparing directory',
  sessionList: 'Loading sessions',
  responseStyle: 'Loading chat settings',
  worktree: 'Priming worktree state',
  agentRuntime: 'Warming agent runtime',
  chatRuntime: 'Warming chat',
} satisfies Record<NonNullable<StartupReadinessSummary['phase']>, string>;

const getStartupStatusText = (summary: StartupReadinessSummary): string => {
  if (summary.ready) return 'Ready';
  if (summary.error) return summary.error;
  return summary.phase ? STARTUP_PHASE_LABELS[summary.phase] : 'Starting DevRyan';
};

type DirectoryStartupSnapshot = {
  status: 'loading' | 'partial' | 'complete';
  sessionListStatus: 'idle' | 'loading' | 'ready' | 'error';
  sessionListError?: string;
};

const DirectoryStartupProbe: React.FC<{
  directory: string;
  onSnapshot: (snapshot: DirectoryStartupSnapshot) => void;
}> = ({ directory, onSnapshot }) => {
  const status = useDirectorySync((state) => state.status, directory);
  const sessionListStatus = useDirectorySync((state) => state.sessionListStatus, directory);
  const sessionListError = useDirectorySync((state) => state.sessionListError, directory);

  React.useEffect(() => {
    onSnapshot({ status, sessionListStatus, sessionListError });
  }, [onSnapshot, sessionListError, sessionListStatus, status]);

  return null;
};

const StartupReadinessScreen: React.FC<{
  summary: StartupReadinessSummary;
  onRetry: () => void;
  isRetrying: boolean;
}> = ({ summary, onRetry, isRetrying }) => {
  const statusText = getStartupStatusText(summary);
  const isError = Boolean(summary.error);

  return (
    <RuntimeLoadingScreen
      message={statusText}
      state={isError ? 'error' : 'loading'}
      onRetry={isError ? onRetry : undefined}
      isRetrying={isRetrying}
    />
  );
};

const StartupReadinessGate: React.FC<{
  children: React.ReactNode;
  currentDirectory: string;
  isConnected: boolean;
  isDesktopRuntime: boolean;
  isInitialized: boolean;
  initializationRetriesExhausted: boolean;
  bootOutcomeKnown: boolean;
  bootViewIsMain: boolean;
  isRetrying: boolean;
  onRetry: () => void;
}> = ({
  children,
  currentDirectory,
  isConnected,
  isDesktopRuntime,
  isInitialized,
  initializationRetriesExhausted,
  bootOutcomeKnown,
  bootViewIsMain,
  isRetrying,
  onRetry,
}) => {
  const providersLoadStatus = useConfigStore((state) => state.providersLoadStatus);
  const providersLoadError = useConfigStore((state) => state.providersLoadError);
  const agentsLoadStatus = useConfigStore((state) => state.agentsLoadStatus);
  const agentsLoadError = useConfigStore((state) => state.agentsLoadError);
  const initializationLoadStatus = useConfigStore((state) => state.initializationLoadStatus);
  const initializationLoadError = useConfigStore((state) => state.initializationLoadError);
  const responseStyleInstructionLoaded = useConfigStore((state) => state.responseStyleInstructionLoaded);
  const globalReady = useGlobalSyncSelector((state) => state.ready);
  const globalError = useGlobalSyncSelector((state) => state.error?.message);
  const [directorySnapshot, setDirectorySnapshot] = React.useState<DirectoryStartupSnapshot>({
    status: currentDirectory ? 'loading' : 'complete',
    sessionListStatus: currentDirectory ? 'idle' : 'ready',
    sessionListError: undefined,
  });
  const [worktreePhase, setWorktreePhase] = React.useState<StartupPhaseSnapshot>({
    status: currentDirectory ? 'idle' : 'ready',
    error: null,
  });
  const [agentRuntimePhase, setAgentRuntimePhase] = React.useState<StartupPhaseSnapshot>({
    status: 'loading',
    error: null,
  });
  const [chatRuntimePhase, setChatRuntimePhase] = React.useState<StartupPhaseSnapshot>({
    status: 'loading',
    error: null,
  });
  const [hasCompletedStartup, setHasCompletedStartup] = React.useState(false);
  const readyDispatchedRef = React.useRef(false);
  const lastLoggedPhaseRef = React.useRef<string | null>(null);

  const updateDirectorySnapshot = React.useCallback((snapshot: DirectoryStartupSnapshot) => {
    setDirectorySnapshot(snapshot);
  }, []);

  React.useEffect(() => {
    setDirectorySnapshot({
      status: currentDirectory ? 'loading' : 'complete',
      sessionListStatus: currentDirectory ? 'idle' : 'ready',
      sessionListError: undefined,
    });
  }, [currentDirectory]);

  React.useEffect(() => {
    let cancelled = false;
    if (!currentDirectory) {
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
  }, [currentDirectory, isConnected]);

  React.useEffect(() => {
    let cancelled = false;
    const warmupDirectory = currentDirectory || null;
    const clearWarmingDirectory = () => {
      const warmupState = useAgentRuntimeWarmupStore.getState();
      if (warmupState.warmingDirectory === warmupDirectory) {
        warmupState.setWarmingDirectory(null);
      }
    };

    if (!isConnected) {
      clearWarmingDirectory();
      setAgentRuntimePhase({ status: 'idle', error: null });
      return;
    }

    useAgentRuntimeWarmupStore.getState().setWarmingDirectory(warmupDirectory);
    setAgentRuntimePhase({ status: 'loading', error: null });
    void warmAgentRuntime({ directory: warmupDirectory })
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
      })
      .finally(clearWarmingDirectory);

    return () => {
      cancelled = true;
      clearWarmingDirectory();
    };
  }, [currentDirectory, isConnected]);

  React.useEffect(() => {
    let cancelled = false;
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
  }, []);

  const summary = React.useMemo(() => {
    let snapshot = createStartupReadinessSnapshot('ready');
    snapshot = withStartupBootstrapReadiness(snapshot, {
      desktopBootReady: !isDesktopRuntime || (bootOutcomeKnown && bootViewIsMain),
      isConnected,
      isInitialized,
      retriesExhausted: initializationRetriesExhausted,
      providers: { status: providersLoadStatus, error: providersLoadError },
      agents: { status: agentsLoadStatus, error: agentsLoadError },
      initialization: {
        status: initializationLoadStatus,
        error: initializationLoadError,
      },
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
    bootOutcomeKnown,
    bootViewIsMain,
    directorySnapshot.sessionListError,
    directorySnapshot.sessionListStatus,
    directorySnapshot.status,
    globalError,
    globalReady,
    isConnected,
    isDesktopRuntime,
    isInitialized,
    initializationLoadError,
    initializationLoadStatus,
    initializationRetriesExhausted,
    providersLoadError,
    providersLoadStatus,
    responseStyleInstructionLoaded,
    agentRuntimePhase,
    chatRuntimePhase,
    worktreePhase,
  ]);

  React.useEffect(() => {
    setInitialLoadingStatus(getStartupStatusText(summary));
    if (!streamDebugEnabled()) return;
    const signature = `${summary.ready}:${summary.phase ?? 'ready'}:${summary.status ?? ''}:${summary.error ?? ''}`;
    if (lastLoggedPhaseRef.current === signature) return;
    lastLoggedPhaseRef.current = signature;
    if (typeof performance !== 'undefined' && typeof performance.mark === 'function') {
      performance.mark(`devryan-startup-${summary.phase ?? 'ready'}-${summary.status ?? 'ready'}`);
    }
    console.log('[startup] readiness', summary);
  }, [summary]);

  React.useEffect(() => {
    if (!summary.ready) return;
    setHasCompletedStartup(true);
    if (readyDispatchedRef.current) return;
    readyDispatchedRef.current = true;
    const timer = window.setTimeout(() => {
      dismissInitialLoadingElement();
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
    }, 150);

    return () => window.clearTimeout(timer);
  }, [summary.ready]);

  React.useEffect(() => {
    if (!summary.error) return;
    dismissInitialLoadingElement();
  }, [summary.error]);

  const showStartupScreen = shouldShowStartupReadinessScreen(summary, hasCompletedStartup);

  return (
    <>
      {currentDirectory && (
        <DirectoryStartupProbe
          directory={currentDirectory}
          onSnapshot={updateDirectorySnapshot}
        />
      )}
      {showStartupScreen ? (
        <StartupReadinessScreen
          summary={summary}
          onRetry={onRetry}
          isRetrying={isRetrying}
        />
      ) : children}
    </>
  );
};

function App({ apis }: AppProps) {
  const initializeApp = useConfigStore((s) => s.initializeApp);
  const isInitialized = useConfigStore((s) => s.isInitialized);
  const isConnected = useConfigStore((s) => s.isConnected);
  const error = useSessionUIStore((s) => s.error);
  const clearError = useSessionUIStore((s) => s.clearError);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const setDirectory = useDirectoryStore((state) => state.setDirectory);
  const isSwitchingDirectory = useDirectoryStore((state) => state.isSwitchingDirectory);
  const [showMemoryDebug, setShowMemoryDebug] = React.useState(false);
  const refreshGitHubAuthStatus = useGitHubAuthStore((state) => state.refreshStatus);
  const authPrincipal = useAuthPrincipal();
  const [isVSCodeRuntime, setIsVSCodeRuntime] = React.useState<boolean>(() => apis.runtime.isVSCode);
  const [isEmbeddedVisible, setIsEmbeddedVisible] = React.useState(true);
  const [initRetryExhausted, setInitRetryExhausted] = React.useState(false);
  const [initRetryEpoch, setInitRetryEpoch] = React.useState(0);
  const [manualInitRetrying, setManualInitRetrying] = React.useState(false);
  const mobileKeyboardMode = useUIStore((state) => state.mobileKeyboardMode);
  const isDesktopRuntime = React.useMemo(() => isDesktopShell(), []);
  const setPlanModeEnabled = useFeatureFlagsStore((state) => state.setPlanModeEnabled);
  const [bootInjectionStatus, setBootInjectionStatus] = React.useState<BootInjectionStatus>(() => {
    return getBootInjectionStatus();
  });
  const [bootView, setBootView] = React.useState<DesktopBootView | null>(() => {
    const outcome = getInjectedBootOutcome();
    return outcome !== null
      ? resolveDesktopBootView({ isDesktopShell: true, bootOutcome: outcome })
      : null;
  });
  const embeddedSessionChat = React.useMemo<EmbeddedSessionChatConfig | null>(() => readEmbeddedSessionChatConfig(), []);
  const embeddedBackgroundWorkEnabled = !embeddedSessionChat || isEmbeddedVisible;
  const isMcpOAuthCallback = React.useMemo(() => isMcpOAuthCallbackPath(), []);

  React.useEffect(() => {
    setStreamPerfEnabled(showMemoryDebug);
    return () => {
      setStreamPerfEnabled(false);
    };
  }, [showMemoryDebug]);

  // Only managed sessions have an endpoint to report to; local scope stays silent.
  React.useEffect(() => {
    if (authPrincipal.scope !== 'managed') return;
    return initClientErrorCapture();
  }, [authPrincipal.scope]);

  React.useEffect(() => {
    applyMobileKeyboardMode(mobileKeyboardMode);
  }, [mobileKeyboardMode]);

  React.useEffect(() => {
    setIsVSCodeRuntime(apis.runtime.isVSCode);
  }, [apis.runtime.isVSCode]);

  React.useEffect(() => {
    registerRuntimeAPIs(apis);
    return () => registerRuntimeAPIs(null);
  }, [apis]);

  React.useEffect(() => {
    if (embeddedSessionChat) {
      return;
    }

    void refreshGitHubAuthStatus(apis.github, { force: true });
  }, [apis.github, authPrincipal.id, authPrincipal.scope, embeddedSessionChat, refreshGitHubAuthStatus]);

  useAppFontEffects();

  const bootOutcomeKnown = bootInjectionStatus === 'valid';
  const bootViewIsMain = bootView?.screen === 'main';

  React.useEffect(() => {
    if (!isConnected || !isInitialized || !currentDirectory) return;
    if (authPrincipal.scope === 'managed' || isVSCodeRuntime) return;
    if (isDesktopRuntime && (!bootOutcomeKnown || !bootViewIsMain)) return;

    void import('@/lib/directoryRecovery')
      .then(({ recoverMissingActiveDirectory }) => recoverMissingActiveDirectory(currentDirectory))
      .catch((recoveryError) => {
        console.warn('[startup] active directory validation failed; preserving the current directory:', recoveryError);
      });
  }, [
    authPrincipal.id,
    authPrincipal.scope,
    bootOutcomeKnown,
    bootViewIsMain,
    currentDirectory,
    isConnected,
    isDesktopRuntime,
    isInitialized,
    isVSCodeRuntime,
  ]);

  // Non-main desktop boot routes do not show chat, so they can leave the
  // OpenCode readiness gate and dismiss the static splash immediately.
  React.useEffect(() => {
    if (!isDesktopRuntime || !bootOutcomeKnown || bootViewIsMain) {
      return;
    }

    const timer = window.setTimeout(dismissInitialLoadingElement, 150);

    return () => window.clearTimeout(timer);
  }, [isDesktopRuntime, bootOutcomeKnown, bootViewIsMain]);

  // Deterministic malformed handling: update splash text so the user
  // sees a specific error instead of a generic spinner, but do NOT
  // dismiss the splash (that only happens on a valid outcome).
  React.useEffect(() => {
    if (!isDesktopRuntime || bootInjectionStatus !== 'malformed') {
      return;
    }

    const loadingElement = document.getElementById('initial-loading');
    if (loadingElement) {
      loadingElement.textContent = 'Desktop startup failed — please restart the app.';
    }
  }, [isDesktopRuntime, bootInjectionStatus]);

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
    // VS Code runtime bootstraps config + sessions after the managed OpenCode instance reports "connected".
    // Doing the default initialization here can race with startup and lead to one-shot failures.
    if (isVSCodeRuntime) {
      return;
    }
    void initializeApp();
  }, [initializeApp, isVSCodeRuntime]);

  React.useEffect(() => {
    if (isVSCodeRuntime || isInitialized) return;

    let active = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryCount = 0;
    const MAX_RETRIES = 10;
    const BASE_DELAY_MS = 1000;

    const retryInitialization = async () => {
      if (!active) return;
      if (retryCount >= MAX_RETRIES) {
        setInitRetryExhausted(true);
        return;
      }
      const state = useConfigStore.getState();
      if (state.isInitialized) {
        setInitRetryExhausted(false);
        return;
      }
      retryCount += 1;
      await state.initializeApp();

      const next = useConfigStore.getState();
      if (!active) return;
      if (next.isInitialized) {
        setInitRetryExhausted(false);
        return;
      }
      if (retryCount >= MAX_RETRIES) {
        setInitRetryExhausted(true);
        return;
      }
      const delay = Math.min(BASE_DELAY_MS * Math.pow(2, retryCount - 1), 16000);
      retryTimer = setTimeout(retryInitialization, delay);
    };

    retryTimer = setTimeout(retryInitialization, BASE_DELAY_MS);

    return () => {
      active = false;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [initRetryEpoch, isInitialized, isVSCodeRuntime]);

  React.useEffect(() => {
    if (isInitialized) {
      setInitRetryExhausted(false);
    }
  }, [isInitialized]);

  React.useEffect(() => {
    if (!initRetryExhausted) return;

    dismissInitialLoadingElement();
  }, [initRetryExhausted]);

  React.useEffect(() => {
    if (isSwitchingDirectory) {
      return;
    }

    // VS Code runtime loads sessions via VSCodeLayout bootstrap to avoid startup races.
    if (isVSCodeRuntime) {
      return;
    }

    if (!isConnected) {
      return;
    }
    opencodeClient.setDirectory(currentDirectory);

    // Session loading is handled by the sync system's bootstrap — no manual loadSessions needed.
  }, [currentDirectory, isSwitchingDirectory, isConnected, isVSCodeRuntime]);

  React.useEffect(() => {
    if (!embeddedSessionChat || typeof window === 'undefined') {
      return;
    }

    const applyVisibility = (payload?: EmbeddedVisibilityPayload) => {
      const nextVisible = payload?.visible === true;
      setIsEmbeddedVisible(nextVisible);
    };

    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) {
        return;
      }

      const data = event.data as { type?: unknown; payload?: EmbeddedVisibilityPayload };
      if (data?.type !== 'openchamber:embedded-visibility') {
        return;
      }

      applyVisibility(data.payload);
    };

    const scopedWindow = window as unknown as {
      __openchamberSetEmbeddedVisibility?: (payload?: EmbeddedVisibilityPayload) => void;
    };

    scopedWindow.__openchamberSetEmbeddedVisibility = applyVisibility;
    window.addEventListener('message', handleMessage);

    return () => {
      window.removeEventListener('message', handleMessage);
      if (scopedWindow.__openchamberSetEmbeddedVisibility === applyVisibility) {
        delete scopedWindow.__openchamberSetEmbeddedVisibility;
      }
    };
  }, [embeddedSessionChat]);

  React.useEffect(() => {
    if (!embeddedSessionChat?.directory || isVSCodeRuntime) {
      return;
    }

    if (currentDirectory === embeddedSessionChat.directory) {
      return;
    }

    setDirectory(embeddedSessionChat.directory, { showOverlay: false });
  }, [currentDirectory, embeddedSessionChat, isVSCodeRuntime, setDirectory]);

  React.useEffect(() => {
    if (!embeddedSessionChat || typeof window === 'undefined') {
      return;
    }

    const handleStorage = (event: StorageEvent) => {
      if (!isPrincipalStorageEvent(event, 'ui-store')) {
        return;
      }

      void useUIStore.persist.rehydrate();
    };

    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener('storage', handleStorage);
    };
  }, [embeddedSessionChat]);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string; directory?: string }>).detail;
      const sessionId = typeof detail?.sessionId === 'string' ? detail.sessionId.trim() : '';
      if (!sessionId) return;
      const directory = typeof detail?.directory === 'string' && detail.directory.trim().length > 0
        ? detail.directory.trim()
        : null;
      useUIStore.getState().setActiveMainTab('chat');
      void useSessionUIStore.getState().setCurrentSession(sessionId, directory);
    };

    window.addEventListener('openchamber:open-session', handler as EventListener);
    return () => window.removeEventListener('openchamber:open-session', handler as EventListener);
  }, []);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ directory?: string; projectId?: string }>).detail;
      const directory = typeof detail?.directory === 'string' && detail.directory.trim().length > 0
        ? detail.directory.trim()
        : null;
      const projectId = typeof detail?.projectId === 'string' && detail.projectId.trim().length > 0
        ? detail.projectId.trim()
        : null;
      useUIStore.getState().setActiveMainTab('chat');
      useUIStore.getState().setSessionSwitcherOpen(false);
      useSessionUIStore.getState().openNewSessionDraft({
        selectedProjectId: projectId,
        directoryOverride: directory,
        preserveDirectoryOverride: Boolean(directory),
      });
    };

    window.addEventListener('openchamber:open-draft-session', handler as EventListener);
    return () => window.removeEventListener('openchamber:open-draft-session', handler as EventListener);
  }, []);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ projectPath?: string }>).detail;
      const projectPath = typeof detail?.projectPath === 'string' ? detail.projectPath.trim() : '';
      if (!projectPath) return;
      const projectsStore = useProjectsStore.getState();
      const existing = projectsStore.projects.find((project) => project.path === projectPath);
      if (existing) {
        projectsStore.setActiveProject(existing.id);
      } else {
        projectsStore.addProject(projectPath);
      }
    };

    window.addEventListener('openchamber:open-project', handler as EventListener);
    return () => window.removeEventListener('openchamber:open-project', handler as EventListener);
  }, []);

  // useEventStream replaced by SyncProvider + SyncBridge

  // Session attention now handled by notification-store via SSE events (session.idle/session.error)

  usePushVisibilityBeacon({ enabled: embeddedBackgroundWorkEnabled });

  useWindowTitle();

  useRouter();

  const handleToggleMemoryDebug = React.useCallback(() => {
    setShowMemoryDebug(prev => !prev);
  }, []);

  useMenuActions(handleToggleMemoryDebug, apis.diagnostics);

  React.useEffect(() => {
    if (embeddedSessionChat) {
      return;
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      const isDebugShortcut = hasModifier(e)
        && e.shiftKey
        && !e.altKey
        && (e.code === 'KeyD' || e.key.toLowerCase() === 'd');

      if (isDebugShortcut) {
        e.preventDefault();
        setShowMemoryDebug(prev => !prev);
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [embeddedSessionChat]);

  React.useEffect(() => {
    if (embeddedSessionChat) {
      return;
    }

    if (error) {

      setTimeout(() => clearError(), 5000);
    }
  }, [clearError, embeddedSessionChat, error]);

  // Poll for the injected boot outcome until it becomes available (desktop only).
  // The Rust backend sets window.__OPENCHAMBER_DESKTOP_BOOT_OUTCOME__ once the
  // sidecar reaches a stable state. We poll with exponential backoff to handle
  // potential race conditions during startup and config writes.
  React.useEffect(() => {
    if (!isDesktopRuntime || bootInjectionStatus !== 'not-injected') {
      return;
    }

    let cancelled = false;
    let attempts = 0;
    const BASE_INTERVAL = 200;
    const MAX_INTERVAL = 2000;
    const MAX_ATTEMPTS = 50; // 10 seconds total (200ms * 50 with exponential backoff cap)

    const pollWithBackoff = () => {
      if (cancelled) return;

      attempts++;
      const status = getBootInjectionStatus();

      if (status !== 'not-injected') {
        cancelled = true;
        setBootInjectionStatus(status);

        if (status === 'valid') {
          const outcome = getInjectedBootOutcome();
          if (outcome) {
            setBootView(resolveDesktopBootView({ isDesktopShell: true, bootOutcome: outcome }));
          }
        }
        // If status is 'malformed', we keep the splash visible with error text
        // handled by the separate useEffect below
        return;
      }

      // Exponential backoff with cap
      const nextInterval = Math.min(BASE_INTERVAL * Math.pow(1.1, attempts), MAX_INTERVAL);

      if (attempts >= MAX_ATTEMPTS) {
        // Max attempts reached - keep polling but show error
        const loadingElement = document.getElementById('initial-loading');
        if (loadingElement && !loadingElement.textContent?.includes('taking longer')) {
          loadingElement.textContent = 'Desktop startup is taking longer than expected...';
        }
      }

      window.setTimeout(pollWithBackoff, nextInterval);
    };

    // Start polling
    window.setTimeout(pollWithBackoff, BASE_INTERVAL);

    return () => {
      cancelled = true;
    };
  }, [isDesktopRuntime, bootInjectionStatus]);

  const handleDesktopBootDismiss = React.useCallback(async () => {
    if (shouldRestartDesktopBootFlow({
      isTauriShell: isTauriShell(),
      isDesktopLocalOriginActive: isDesktopLocalOriginActive(),
    })) {
      await restartDesktopApp();
      return;
    }

    window.location.reload();
  }, []);

  const handleManualInitRetry = React.useCallback(async () => {
    if (manualInitRetrying) return;

    setInitRetryExhausted(false);
    setManualInitRetrying(true);
    try {
      const recovery = await recoverStartupInitialization({
        loadHealth: async () => {
          const response = await fetch('/health', {
            method: 'GET',
            headers: { Accept: 'application/json' },
            cache: 'no-store',
          });
          if (!response.ok) return null;
          return await response.json() as {
            openCodeRunning?: unknown;
            isOpenCodeReady?: unknown;
            lastOpenCodeError?: unknown;
          };
        },
        restartOpenCode: apis.settings.restartOpenCode,
        initializeApp: () => useConfigStore.getState().initializeApp(),
      });
      if (recovery.restartError) {
        console.warn('[startup] OpenCode recovery restart failed:', recovery.restartError);
      }
    } finally {
      setManualInitRetrying(false);
    }

    if (!useConfigStore.getState().isInitialized) {
      setInitRetryEpoch((value) => value + 1);
    }
  }, [apis.settings.restartOpenCode, manualInitRetrying]);

  // Map boot outcome kind to recovery variant
  const mapBootViewToRecoveryVariant = (view: DesktopBootView): RecoveryVariant | undefined => {
    if (view.screen === 'recovery') {
      return view.variant;
    }
    return undefined;
  };

  // Desktop boot view routing.
  // When the boot outcome resolves to a non-main screen (chooser, recovery),
  // render OnboardingScreen with appropriate mode/variant.
  if (isDesktopRuntime && bootView && bootView.screen !== 'main') {
    // First-launch chooser
    if (bootView.screen === 'chooser') {
      return (
        <ErrorBoundary>
          <div className="h-full text-foreground bg-transparent">
            <React.Suspense fallback={<div className="h-full" />}>
              <OnboardingScreen
                mode="first-launch"
                onCliAvailable={handleDesktopBootDismiss}
                onChooseRemote={() => {
                  // Switch to remote tab - handled internally by OnboardingScreen
                }}
              />
            </React.Suspense>
          </div>
        </ErrorBoundary>
      );
    }

    // Recovery screens
    const recoveryVariant = mapBootViewToRecoveryVariant(bootView);
    const hostUrl = bootView.screen === 'recovery' && 'url' in bootView ? bootView.url : undefined;

    return (
      <ErrorBoundary>
        <div className="h-full text-foreground bg-transparent">
          <React.Suspense fallback={<div className="h-full" />}>
            <OnboardingScreen
              mode="recovery"
              recoveryVariant={recoveryVariant}
              recoveryHostUrl={hostUrl}
              recoveryHostLabel={undefined}
              onCliAvailable={handleDesktopBootDismiss}
            />
          </React.Suspense>
        </div>
      </ErrorBoundary>
    );
  }

  if (embeddedSessionChat) {
    return (
      <ErrorBoundary>
        <SyncProvider sdk={opencodeClient.getSdkClient()} directory={currentDirectory || ''}>
          <RuntimeAPIProvider apis={apis}>
            <TooltipProvider delayDuration={300} skipDelayDuration={150}>
              <div className="h-full text-foreground bg-background">
                <EmbeddedSessionSelectionGate embeddedSessionChat={embeddedSessionChat} isVSCodeRuntime={isVSCodeRuntime} />
                <SyncAppEffects embeddedBackgroundWorkEnabled={embeddedBackgroundWorkEnabled} />
                <ChatView />
                <Toaster />
              </div>
            </TooltipProvider>
          </RuntimeAPIProvider>
        </SyncProvider>
      </ErrorBoundary>
    );
  }

  if (isMcpOAuthCallback) {
    return (
      <ErrorBoundary>
        <McpOAuthCallbackPage />
      </ErrorBoundary>
    );
  }

  // Always mount the full provider tree to avoid remounts when isInitialized
  // flips from false → true. FireworksProvider and VoiceProvider are lightweight
  // shells; their heavy children are only activated when actually needed.
  return (
    <ErrorBoundary>
      <SyncProvider sdk={opencodeClient.getSdkClient()} directory={currentDirectory || ''}>
        <RuntimeAPIProvider apis={apis}>
          <FireworksProvider>
            <VoiceProvider>
              <TooltipProvider delayDuration={300} skipDelayDuration={150}>
                <div className={isDesktopRuntime ? 'h-full text-foreground bg-transparent' : 'h-full text-foreground bg-background'}>
                  <SyncAppEffects embeddedBackgroundWorkEnabled={embeddedBackgroundWorkEnabled} />
                  <StartupReadinessGate
                    currentDirectory={currentDirectory}
                    isConnected={isConnected}
                    isDesktopRuntime={isDesktopRuntime}
                    isInitialized={isInitialized}
                    initializationRetriesExhausted={initRetryExhausted}
                    bootOutcomeKnown={bootOutcomeKnown}
                    bootViewIsMain={bootViewIsMain}
                    onRetry={() => { void handleManualInitRetry(); }}
                    isRetrying={manualInitRetrying}
                  >
                    <MainLayout />
                    <Toaster />
                    <>
                      <ConfigUpdateOverlay />
                      <AboutDialogWrapper />
                      {showMemoryDebug && (
                        <MemoryDebugPanel onClose={() => setShowMemoryDebug(false)} />
                      )}
                    </>
                  </StartupReadinessGate>
                </div>
              </TooltipProvider>
            </VoiceProvider>
          </FireworksProvider>
        </RuntimeAPIProvider>
      </SyncProvider>
    </ErrorBoundary>
  );
}

export default App;
