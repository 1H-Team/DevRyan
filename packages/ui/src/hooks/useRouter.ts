import React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import { parseRoute, updateBrowserURL, hasRouteParams } from '@/lib/router';
import type { RouteState, AppRouteState } from '@/lib/router';
import type { MainTab } from '@/stores/useUIStore';
import { resolveSettingsSlug } from '@/lib/settings/metadata';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { resolveRoutedSessionDirectory } from '@/lib/router/routedSessionDirectory';

let pendingRoutedSessionId: string | null = null;

const applyRoutedSessionSelection = (sessionId: string): boolean => {
  const sessionState = useSessionUIStore.getState();
  const globalState = useGlobalSessionsStore.getState();
  const directory = resolveRoutedSessionDirectory(
    sessionId,
    sessionState.getDirectoryForSession(sessionId),
    [...globalState.activeSessions, ...globalState.archivedSessions],
  );
  if (!directory) {
    pendingRoutedSessionId = sessionId;
    return false;
  }

  pendingRoutedSessionId = null;
  sessionState.setCurrentSession(sessionId, directory);
  return true;
};

/**
 * Check if running in VS Code webview context.
 */
function isVSCodeContext(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  const win = window as { __VSCODE_CONFIG__?: unknown };
  return win.__VSCODE_CONFIG__ !== undefined;
}

/**
 * Hook that provides bidirectional URL routing for OpenChamber.
 *
 * On mount:
 * - Parses URL parameters and applies them to app state
 * - Sets up subscriptions to sync state changes back to URL
 * - Listens for browser back/forward navigation
 *
 * Works in:
 * - Web: Full bidirectional sync
 * - Desktop (Tauri): Full bidirectional sync
 * - VS Code: State-only (no URL updates, reads initial params)
 */
export function useRouter(): void {
  const isVSCode = React.useMemo(() => isVSCodeContext(), []);

  // Track initialization to avoid duplicate applies
  const initializedRef = React.useRef(false);
  const isApplyingRouteRef = React.useRef(false);

  // Get store actions (stable references)
  const setActiveMainTab = useUIStore((state) => state.setActiveMainTab);
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const navigateToDiff = useUIStore((state) => state.navigateToDiff);

  /**
   * Apply a parsed route state to the application stores.
   */
  const applyRoute = React.useCallback(
    async (route: RouteState): Promise<boolean> => {
      if (isApplyingRouteRef.current) {
        return false;
      }

      isApplyingRouteRef.current = true;

      try {
        // 1. Apply session first (may trigger async operations)
        if (route.sessionId) {
          const currentSessionId = useSessionUIStore.getState().currentSessionId;
          const currentDirectory = useSessionUIStore.getState().getDirectoryForSession(route.sessionId);
          if (route.sessionId !== currentSessionId || !currentDirectory) {
            applyRoutedSessionSelection(route.sessionId);
          } else {
            pendingRoutedSessionId = null;
          }
        } else {
          pendingRoutedSessionId = null;
        }

        // 2. Handle settings (takes precedence over tabs - it's a full-screen overlay)
        if (route.settingsPath) {
          setSettingsPage(resolveSettingsSlug(route.settingsPath));
          setSettingsDialogOpen(true);
          // Don't process tab when settings is open
          return pendingRoutedSessionId === null;
        }

        // Close settings if URL has no settings section
        if (useUIStore.getState().isSettingsDialogOpen) {
          setSettingsDialogOpen(false);
        }

        // 3. Apply tab
        if (route.tab) {
          setActiveMainTab(route.tab);
        }

        // 4. Apply diff file (only if going to diff tab)
        if (route.diffFile && (route.tab === 'diff' || !route.tab)) {
          navigateToDiff(route.diffFile);
        }
        return pendingRoutedSessionId === null;
      } finally {
        isApplyingRouteRef.current = false;
      }
    },
    [setActiveMainTab, setSettingsDialogOpen, setSettingsPage, navigateToDiff]
  );

  /**
   * Get current app state for URL serialization.
   */
  const getCurrentAppState = React.useCallback((): AppRouteState => {
    const sessionState = useSessionUIStore.getState();
    const uiState = useUIStore.getState();

    return {
      sessionId: sessionState.currentSessionId,
      tab: uiState.activeMainTab,
      isSettingsOpen: uiState.isSettingsDialogOpen,
      settingsPath: uiState.settingsPage,
      diffFile: uiState.pendingDiffFile,
    };
  }, []);

  /**
   * Sync current app state to URL.
   */
  const syncURLFromState = React.useCallback(
    (options: { replace?: boolean } = {}) => {
      if (isVSCode || isApplyingRouteRef.current) {
        return;
      }

      const state = getCurrentAppState();
      updateBrowserURL(state, options);
    },
    [isVSCode, getCurrentAppState]
  );

  // Initialize: parse URL and apply route on mount
  React.useEffect(() => {
    if (initializedRef.current) {
      return;
    }
    initializedRef.current = true;

    // Only process if URL has route params
    if (!hasRouteParams()) {
      // No route params - just set up sync (URL will update when user navigates)
      return;
    }

    const route = parseRoute();

    // Apply the initial route
    const initializeRoute = async () => {
      const sessionResolved = await applyRoute(route);

      // After applying, update URL to normalized form (use replaceState)
      if (!isVSCode && sessionResolved) {
        syncURLFromState({ replace: true });
      }
    };

    void initializeRoute();
  }, [applyRoute, isVSCode, syncURLFromState]);

  // Cold deep links can arrive before the global session snapshot. Reconcile
  // the pending identity as soon as either global metadata or a routing hint
  // becomes authoritative, without temporarily rewriting the URL.
  React.useEffect(() => {
    const reconcilePendingSession = () => {
      const sessionId = pendingRoutedSessionId;
      if (!sessionId) return;
      isApplyingRouteRef.current = true;
      try {
        if (!applyRoutedSessionSelection(sessionId)) return;
      } finally {
        isApplyingRouteRef.current = false;
      }
      if (!isVSCode) syncURLFromState({ replace: true });
    };

    reconcilePendingSession();
    const unsubscribeGlobal = useGlobalSessionsStore.subscribe(reconcilePendingSession);
    const unsubscribeSession = useSessionUIStore.subscribe(reconcilePendingSession);
    return () => {
      unsubscribeGlobal();
      unsubscribeSession();
    };
  }, [isVSCode, syncURLFromState]);

  // Subscribe to session changes
  React.useEffect(() => {
    if (isVSCode) {
      return;
    }

    let prevSessionId: string | null = useSessionUIStore.getState().currentSessionId;

    const unsubscribe = useSessionUIStore.subscribe((state) => {
      const sessionId = state.currentSessionId;

      // Skip if no change or if we're currently applying a route
      if (sessionId === prevSessionId || isApplyingRouteRef.current) {
        return;
      }

      prevSessionId = sessionId;
      pendingRoutedSessionId = null;
      syncURLFromState();
    });

    return unsubscribe;
  }, [isVSCode, syncURLFromState]);

  // Subscribe to UI store changes (tab, settings)
  React.useEffect(() => {
    if (isVSCode) {
      return;
    }

    let prevTab: MainTab = useUIStore.getState().activeMainTab;
    let prevSettingsOpen: boolean = useUIStore.getState().isSettingsDialogOpen;
    let prevSettingsPath: string = useUIStore.getState().settingsPage;
    let prevDiffFile: string | null = useUIStore.getState().pendingDiffFile;

    const unsubscribe = useUIStore.subscribe((state) => {
      // Skip if we're currently applying a route
      if (isApplyingRouteRef.current) {
        return;
      }

      const tabChanged = state.activeMainTab !== prevTab;
      const settingsOpenChanged = state.isSettingsDialogOpen !== prevSettingsOpen;
      const settingsPathChanged = state.settingsPage !== prevSettingsPath;
      const diffFileChanged = state.pendingDiffFile !== prevDiffFile && state.activeMainTab === 'diff';

      // Update tracking vars
      prevTab = state.activeMainTab;
      prevSettingsOpen = state.isSettingsDialogOpen;
      prevSettingsPath = state.settingsPage;
      prevDiffFile = state.pendingDiffFile;

      // Only sync if something relevant changed
      if (tabChanged || settingsOpenChanged || settingsPathChanged || diffFileChanged) {
        syncURLFromState();
      }
    });

    return unsubscribe;
  }, [isVSCode, syncURLFromState]);

  // Listen for browser back/forward navigation
  React.useEffect(() => {
    if (typeof window === 'undefined' || isVSCode) {
      return;
    }

    const handlePopState = () => {
      // Parse the new URL and apply it
      const route = parseRoute();

      // Check if this is a route with any params, or if we should restore defaults
      if (hasRouteParams()) {
        void applyRoute(route);
      } else {
        pendingRoutedSessionId = null;
        // URL has no route params - this might be a "back to home" navigation
        // Close settings if open, keep current session
        const uiState = useUIStore.getState();
        if (uiState.isSettingsDialogOpen) {
          setSettingsDialogOpen(false);
        }
        // Reset to chat tab if not already there
        if (uiState.activeMainTab !== 'chat') {
          setActiveMainTab('chat');
        }
      }
    };

    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, [applyRoute, isVSCode, setActiveMainTab, setSettingsDialogOpen]);
}

/**
 * Programmatically navigate to a route.
 * Can be used from outside React components.
 */
export function navigateToRoute(route: Partial<RouteState>): void {
  if (typeof window === 'undefined') {
    return;
  }

  // Check VS Code context
  const win = window as { __VSCODE_CONFIG__?: unknown };
  if (win.__VSCODE_CONFIG__ !== undefined) {
    // In VS Code, just apply state changes directly
    if (route.sessionId) {
      applyRoutedSessionSelection(route.sessionId);
    }
    if (route.settingsPath) {
      useUIStore.getState().setSettingsPage(resolveSettingsSlug(route.settingsPath));
      useUIStore.getState().setSettingsDialogOpen(true);
    } else if (route.tab) {
      useUIStore.getState().setActiveMainTab(route.tab);
    }
    if (route.diffFile) {
      useUIStore.getState().navigateToDiff(route.diffFile);
    }
    return;
  }

  // Build URL and navigate
  const params = new URLSearchParams();

  if (route.sessionId) {
    params.set('session', route.sessionId);
  }
  if (route.settingsPath) {
    params.set('settings', route.settingsPath);
  } else if (route.tab && route.tab !== 'chat') {
    if (useUIStore.getState().isSettingsDialogOpen) {
      useUIStore.getState().setSettingsDialogOpen(false);
    }
    params.set('tab', route.tab);
  }
  if (route.diffFile) {
    params.set('file', route.diffFile);
  }

  const search = params.toString();
  const url = search ? `${window.location.pathname}?${search}` : window.location.pathname;

  window.history.pushState({ route }, '', url);

  // Also apply to state
  if (route.sessionId) {
    applyRoutedSessionSelection(route.sessionId);
  }
  if (route.settingsPath) {
    useUIStore.getState().setSettingsPage(resolveSettingsSlug(route.settingsPath));
    useUIStore.getState().setSettingsDialogOpen(true);
  } else if (route.tab) {
    useUIStore.getState().setActiveMainTab(route.tab);
  }
  if (route.diffFile) {
    useUIStore.getState().navigateToDiff(route.diffFile);
  }
}

/**
 * Get a shareable URL for the current state.
 */
export function getShareableURL(): string {
  if (typeof window === 'undefined') {
    return '/';
  }

  const sessionState = useSessionUIStore.getState();
  const uiState = useUIStore.getState();

  const params = new URLSearchParams();

  if (sessionState.currentSessionId) {
    params.set('session', sessionState.currentSessionId);
  }

  if (uiState.isSettingsDialogOpen) {
    params.set('settings', uiState.settingsPage || 'home');
  } else if (uiState.activeMainTab !== 'chat') {
    params.set('tab', uiState.activeMainTab);
  }

  if (uiState.activeMainTab === 'diff' && uiState.pendingDiffFile) {
    params.set('file', uiState.pendingDiffFile);
  }

  const search = params.toString();
  const base = `${window.location.origin}${window.location.pathname}`;

  return search ? `${base}?${search}` : base;
}
