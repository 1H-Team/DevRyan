import React from 'react';
import { RiCloseLine, RiFullscreenExitLine, RiFullscreenLine, RiGlobalLine, RiLoader4Line } from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useI18n } from '@/lib/i18n';
import { startBrowserAgentView, stopBrowserAgentView, type BrowserAgentViewSession } from '@/lib/browserAgentApi';
import { isDesktopLocalOriginActive, isElectronShell } from '@/lib/desktop';
import { resolveRootSessionID } from '@/lib/sessionLineage';
import { cn } from '@/lib/utils';
import {
  browserAgentLeaseSelectors,
  ensureBrowserAgentListeners,
  setObservedBrowserAgentLease,
  useBrowserAgentStore,
} from '@/stores/useBrowserAgentStore';
import { useManualBrowserTabsStore } from '@/stores/useManualBrowserTabsStore';
import { useUIStore } from '@/stores/useUIStore';
import { getAllSyncSessions } from '@/sync/sync-refs';
import { useSession } from '@/sync/sync-context';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { BrowserTabsBar, DesktopBrowserPane, ManualBrowserWorkspacePane } from './DesktopBrowserPane';
import { closeBrowserLeaseStripTab, closeManualBrowserStripTab } from './browserPanelClose';
import { isBrowserPanelRuntimeSupported } from './browserRuntime';
import {
  clampBrowserPanelPreferredWidth,
  resolveBrowserPanelWidth,
} from './browserPanelLayout';

const BROWSER_PANEL_DEFAULT_WIDTH = 600;
const EMPTY_BROWSER_LEASE_TABS: never[] = [];

const normalizeDirectoryKey = (value: string): string => {
  if (!value) return '';
  const raw = value.replace(/\\/g, '/');
  const hadUncPrefix = raw.startsWith('//');
  let normalized = raw.replace(/\/+$/g, '').replace(/\/+/g, '/');
  if (hadUncPrefix && !normalized.startsWith('//')) normalized = `/${normalized}`;
  if (!normalized) return raw.startsWith('/') ? '/' : '';
  return normalized;
};

const clampWidth = (value: number): number => {
  return clampBrowserPanelPreferredWidth(value);
};

const BrowserLeasePane: React.FC<{ leaseId: string; active: boolean }> = React.memo(({ leaseId, active }) => {
  const leaseSelector = React.useMemo(() => browserAgentLeaseSelectors.lease(leaseId), [leaseId]);
  const lease = useBrowserAgentStore(leaseSelector);
  if (!lease) return null;

  if (lease.transport === 'stream') {
    return <RemoteBrowserLeasePane leaseId={leaseId} active={active} />;
  }

  return (
    <div
      className={cn('absolute inset-0', active ? 'z-10 opacity-100' : 'z-0 pointer-events-none opacity-0')}
      aria-hidden={!active}
      data-browser-lease-pane={leaseId}
    >
      <DesktopBrowserPane
        initialUrl={lease.url}
        directory={lease.directory}
        tabID={`browser:lease:${leaseId}`}
        active={active}
        leaseId={leaseId}
      />
    </div>
  );
});
BrowserLeasePane.displayName = 'BrowserLeasePane';

const RemoteBrowserLeasePane: React.FC<{ leaseId: string; active: boolean }> = React.memo(({ leaseId, active }) => {
  const { t } = useI18n();
  const leaseSelector = React.useMemo(() => browserAgentLeaseSelectors.lease(leaseId), [leaseId]);
  const lease = useBrowserAgentStore(leaseSelector);
  const leaseAvailable = Boolean(lease);
  const [view, setView] = React.useState<BrowserAgentViewSession | null>(null);
  const [state, setState] = React.useState<'idle' | 'connecting' | 'live' | 'error'>('idle');
  const [retry, setRetry] = React.useState(0);

  React.useEffect(() => {
    if (!active || !leaseAvailable) {
      setView(null);
      setState('idle');
      return;
    }
    let disposed = false;
    let currentView: BrowserAgentViewSession | null = null;
    setState('connecting');
    void startBrowserAgentView(leaseId).then((created) => {
      if (disposed) {
        void stopBrowserAgentView(created);
        return;
      }
      currentView = created;
      setView(created);
    }).catch(() => {
      if (!disposed) setState('error');
    });
    return () => {
      disposed = true;
      setView(null);
      if (currentView) void stopBrowserAgentView(currentView);
    };
  }, [active, leaseAvailable, leaseId, retry]);

  if (!lease) return null;
  return (
    <div
      className={cn('absolute inset-0 flex flex-col bg-background', active ? 'z-10 opacity-100' : 'z-0 pointer-events-none opacity-0')}
      aria-hidden={!active}
      data-browser-lease-pane={leaseId}
      data-browser-remote-view-state={state}
    >
      <div className="flex h-[38px] shrink-0 items-center justify-between gap-3 border-b border-border/40 bg-[var(--surface-background)] px-3">
        <div className="min-w-0">
          <span className="block truncate typography-ui-label text-foreground">
            {lease.agent ? `${lease.agent} · ${lease.title || lease.hostname || 'Browser'}` : lease.title || lease.hostname || 'Browser'}
          </span>
        </div>
        <span className="shrink-0 rounded-full border border-border/60 bg-[var(--surface-elevated)] px-2 py-0.5 typography-micro text-muted-foreground">
          {t('contextPanel.browser.viewOnly')}
        </span>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden bg-black">
        {view ? (
          <img
            src={view.streamUrl}
            alt={t('contextPanel.browser.liveViewAlt')}
            className="pointer-events-none h-full w-full select-none object-contain"
            draggable={false}
            onLoad={() => setState('live')}
            onError={() => {
              setView(null);
              setState('error');
              void stopBrowserAgentView(view);
            }}
          />
        ) : null}
        {state !== 'live' ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center text-white/80">
            {state === 'connecting' ? <RiLoader4Line className="size-6 animate-spin motion-reduce:animate-none" /> : <RiGlobalLine className="size-7" />}
            <p className="typography-ui-label text-white">
              {state === 'error'
                ? t('contextPanel.browser.liveViewUnavailable')
                : t('contextPanel.browser.agentDriving')}
            </p>
            <p className="max-w-sm typography-micro text-white/65">
              {state === 'error'
                ? t('contextPanel.browser.liveViewUnavailableHint')
                : t('contextPanel.browser.liveViewConnecting')}
            </p>
            {state === 'error' ? (
              <Button type="button" variant="secondary" size="sm" onClick={() => setRetry((value) => value + 1)}>
                {t('contextPanel.preview.actions.retry')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
});
RemoteBrowserLeasePane.displayName = 'RemoteBrowserLeasePane';

const BrowserLeaseRootPruner: React.FC<{ directory: string }> = React.memo(({ directory }) => {
  const tabs = useUIStore((state) => state.browserLeaseTabsByDirectory[directory] ?? EMPTY_BROWSER_LEASE_TABS);
  const closeBrowserLease = useUIStore((state) => state.closeBrowserLease);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentSession = useSession(currentSessionId);
  const currentRootSessionId = React.useMemo(() => {
    if (!currentSessionId) return null;
    const sessions = getAllSyncSessions();
    if (currentSession && !sessions.some((session) => session.id === currentSession.id)) sessions.push(currentSession);
    return resolveRootSessionID(currentSessionId, sessions);
  }, [currentSession, currentSessionId]);

  React.useLayoutEffect(() => {
    for (const tab of tabs) {
      if (tab.rootSessionId !== currentRootSessionId) closeBrowserLease(directory, tab.leaseId);
    }
  }, [closeBrowserLease, currentRootSessionId, directory, tabs]);
  return null;
});
BrowserLeaseRootPruner.displayName = 'BrowserLeaseRootPruner';

export const BrowserPanel: React.FC = () => {
  const { t } = useI18n();
  const effectiveDirectory = useEffectiveDirectory() ?? '';
  const directoryKey = React.useMemo(() => normalizeDirectoryKey(effectiveDirectory), [effectiveDirectory]);
  const panelState = useUIStore((state) => directoryKey ? state.browserPanelByDirectory[directoryKey] : undefined);
  const leaseTabs = useUIStore((state) => directoryKey
    ? state.browserLeaseTabsByDirectory[directoryKey] ?? EMPTY_BROWSER_LEASE_TABS
    : EMPTY_BROWSER_LEASE_TABS);
  const activeLeaseId = useUIStore((state) => directoryKey ? state.activeBrowserLeaseIdByDirectory[directoryKey] ?? null : null);
  const contextPanelExpanded = useUIStore((state) => (
    directoryKey
      ? state.contextPanelByDirectory[directoryKey]?.isOpen === true
        && state.contextPanelByDirectory[directoryKey]?.expanded === true
      : false
  ));
  const closeBrowserPanel = useUIStore((state) => state.closeBrowserPanel);
  const setBrowserPanelWidth = useUIStore((state) => state.setBrowserPanelWidth);
  const toggleBrowserPanelExpanded = useUIStore((state) => state.toggleBrowserPanelExpanded);
  const setActiveBrowserLease = useUIStore((state) => state.setActiveBrowserLease);
  const workspace = useManualBrowserTabsStore((state) => directoryKey ? state.byDirectory[directoryKey] ?? null : null);
  const addTab = useManualBrowserTabsStore((state) => state.addTab);
  const activateTab = useManualBrowserTabsStore((state) => state.activateTab);
  const reorderTabs = useManualBrowserTabsStore((state) => state.reorderTabs);
  const liveLeaseIds = useBrowserAgentStore((state) => state.leaseIds);

  const isOpen = Boolean(directoryKey && panelState?.isOpen);
  const isExpanded = Boolean(isOpen && panelState?.expanded);
  const width = clampWidth(panelState?.width ?? BROWSER_PANEL_DEFAULT_WIDTH);
  const surfacesActive = isOpen && !contextPanelExpanded;
  const observedLeaseId = surfacesActive
    && activeLeaseId
    && liveLeaseIds.includes(activeLeaseId)
    ? activeLeaseId
    : null;
  const usesNativeLeaseSurface = isElectronShell() && isDesktopLocalOriginActive();
  const [isResizing, setIsResizing] = React.useState(false);
  const [availableWidth, setAvailableWidth] = React.useState<number | null>(null);
  const panelRef = React.useRef<HTMLElement | null>(null);
  const resizeHandleRef = React.useRef<HTMLDivElement | null>(null);
  const startXRef = React.useRef(0);
  const startPreferredWidthRef = React.useRef(width);
  const resizingPreferredWidthRef = React.useRef<number | null>(null);
  const resizingWidthRef = React.useRef<number | null>(null);
  const activeResizePointerIDRef = React.useRef<number | null>(null);

  React.useLayoutEffect(() => {
    const panel = panelRef.current;
    const workspace = panel?.parentElement;
    if (!panel || !workspace || !isOpen) {
      setAvailableWidth(null);
      return;
    }

    const contextPanel = Array.from(workspace.children).find((child) => (
      child instanceof HTMLElement && child.dataset.contextPanel === 'true'
    ));
    const measure = () => {
      const workspaceWidth = workspace.getBoundingClientRect().width;
      const contextWidth = contextPanel instanceof HTMLElement
        && contextPanel.getAttribute('aria-hidden') !== 'true'
        && !contextPanelExpanded
        ? contextPanel.getBoundingClientRect().width
        : 0;
      const next = Math.max(0, Math.round(workspaceWidth - contextWidth));
      setAvailableWidth((current) => current === next ? current : next);
    };

    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(workspace);
    if (contextPanel instanceof HTMLElement) observer?.observe(contextPanel);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [contextPanelExpanded, isOpen]);

  const appliedWidth = availableWidth === null
    ? width
    : resolveBrowserPanelWidth({ preferredWidth: width, availableWidth });

  React.useEffect(() => {
    ensureBrowserAgentListeners();
  }, []);

  React.useEffect(() => {
    if (usesNativeLeaseSurface) void setObservedBrowserAgentLease(observedLeaseId);
  }, [observedLeaseId, usesNativeLeaseSurface]);

  React.useEffect(() => () => {
    if (usesNativeLeaseSurface) void setObservedBrowserAgentLease(null);
  }, [usesNativeLeaseSurface]);

  const applyLiveWidth = React.useCallback((nextWidth: number) => {
    panelRef.current?.style.setProperty('--oc-browser-panel-width', `${nextWidth}px`);
  }, []);

  const handleResizeStart = React.useCallback((event: React.PointerEvent) => {
    if (!isOpen || isExpanded || !directoryKey) return;
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* fallback pointer events still run */ }
    activeResizePointerIDRef.current = event.pointerId;
    startXRef.current = event.clientX;
    startPreferredWidthRef.current = width;
    resizingPreferredWidthRef.current = width;
    resizingWidthRef.current = appliedWidth;
    setIsResizing(true);
    applyLiveWidth(appliedWidth);
    event.preventDefault();
  }, [appliedWidth, applyLiveWidth, directoryKey, isExpanded, isOpen, width]);

  const updateResize = React.useCallback((pointerId: number, clientX: number) => {
    if (activeResizePointerIDRef.current !== pointerId) return;
    const preferredWidth = clampWidth(startPreferredWidthRef.current + startXRef.current - clientX);
    const nextWidth = availableWidth === null
      ? preferredWidth
      : resolveBrowserPanelWidth({ preferredWidth, availableWidth });
    if (resizingWidthRef.current === nextWidth) return;
    resizingPreferredWidthRef.current = preferredWidth;
    resizingWidthRef.current = nextWidth;
    applyLiveWidth(nextWidth);
  }, [applyLiveWidth, availableWidth]);

  const finishResize = React.useCallback((pointerId: number) => {
    if (!directoryKey || activeResizePointerIDRef.current !== pointerId) return;
    const finalPreferredWidth = resizingPreferredWidthRef.current ?? width;
    activeResizePointerIDRef.current = null;
    try { resizeHandleRef.current?.releasePointerCapture(pointerId); } catch { /* capture may already be released */ }
    resizingPreferredWidthRef.current = null;
    resizingWidthRef.current = null;
    setIsResizing(false);
    setBrowserPanelWidth(directoryKey, finalPreferredWidth);
  }, [directoryKey, setBrowserPanelWidth, width]);

  React.useEffect(() => {
    if (!isResizing) return;
    const handleMove = (event: PointerEvent) => updateResize(event.pointerId, event.clientX);
    const handleEnd = (event: PointerEvent) => finishResize(event.pointerId);
    window.addEventListener('pointermove', handleMove, true);
    window.addEventListener('pointerup', handleEnd, true);
    window.addEventListener('pointercancel', handleEnd, true);
    return () => {
      window.removeEventListener('pointermove', handleMove, true);
      window.removeEventListener('pointerup', handleEnd, true);
      window.removeEventListener('pointercancel', handleEnd, true);
    };
  }, [finishResize, isResizing, updateResize]);

  const panelStyle: React.CSSProperties = !isOpen
    ? { width: '100%', minWidth: '100%', maxWidth: '100%' }
    : isExpanded
      ? { ['--oc-browser-panel-width' as string]: '100%', width: '100%', minWidth: '100%', maxWidth: '100%' }
      : {
        ['--oc-browser-panel-width' as string]: `${isResizing ? resizingWidthRef.current ?? appliedWidth : appliedWidth}px`,
        width: 'var(--oc-browser-panel-width)',
        minWidth: 'var(--oc-browser-panel-width)',
        maxWidth: 'var(--oc-browser-panel-width)',
      };

  const trailingActions = directoryKey ? (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="size-7 p-0"
        title={isExpanded ? t('contextPanel.actions.collapsePanel') : t('contextPanel.actions.expandPanel')}
        aria-label={isExpanded ? t('contextPanel.actions.collapsePanel') : t('contextPanel.actions.expandPanel')}
        onClick={() => toggleBrowserPanelExpanded(directoryKey)}
      >
        {isExpanded ? <RiFullscreenExitLine className="size-3.5" /> : <RiFullscreenLine className="size-3.5" />}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="size-7 p-0"
        title={t('contextPanel.actions.closePanel')}
        aria-label={t('contextPanel.actions.closePanel')}
        onClick={() => closeBrowserPanel(directoryKey)}
      >
        <RiCloseLine className="size-3.5" />
      </Button>
    </>
  ) : null;

  return (
    <aside
      ref={panelRef}
      data-browser-panel="true"
      aria-hidden={!isOpen}
      tabIndex={-1}
      className={cn(
        'flex min-h-0 flex-col overflow-hidden bg-background',
        !isOpen
          ? 'pointer-events-none fixed inset-0 -z-10 opacity-0'
          : isExpanded
            ? 'absolute inset-0 z-20 min-w-0'
            : 'relative h-full flex-shrink-0 border-l border-border/40',
        isResizing ? 'transition-none' : 'transition-[width] duration-200 ease-in-out',
      )}
      style={panelStyle}
      onKeyDownCapture={(event) => {
        if (event.key !== 'Escape' || !directoryKey) return;
        event.preventDefault();
        event.stopPropagation();
        closeBrowserPanel(directoryKey);
      }}
    >
      {directoryKey ? <BrowserLeaseRootPruner directory={directoryKey} /> : null}
      {isOpen && !isExpanded ? (
        <div
          ref={resizeHandleRef}
          data-panel-resize-handle="browser-panel"
          className="group absolute left-0 top-0 z-30 h-full w-2 cursor-col-resize"
          onPointerDown={handleResizeStart}
          onPointerMove={(event) => updateResize(event.pointerId, event.clientX)}
          onPointerUp={(event) => finishResize(event.pointerId)}
          onPointerCancel={(event) => finishResize(event.pointerId)}
          onLostPointerCapture={(event) => finishResize(event.pointerId)}
          role="separator"
          aria-orientation="vertical"
          aria-label={t('contextPanel.actions.resizePanelAria')}
        >
          <span
            aria-hidden="true"
            className={cn(
              'pointer-events-none absolute inset-y-0 left-0 w-px bg-border/40 transition-colors group-hover:bg-[var(--interactive-border)]/80',
              isResizing && 'bg-[var(--interactive-border)]',
            )}
          />
        </div>
      ) : null}
      {isOpen && (workspace || leaseTabs.length > 0) ? (
        <BrowserTabsBar
          tabs={workspace?.tabs ?? []}
          activeTabId={workspace?.activeTabId ?? ''}
          leaseTabs={leaseTabs}
          activeLeaseId={activeLeaseId}
          onAdd={() => {
            addTab(directoryKey);
            setActiveBrowserLease(directoryKey, null);
          }}
          onSelect={(tabId) => {
            activateTab(directoryKey, tabId);
            setActiveBrowserLease(directoryKey, null);
          }}
          onClose={(tabId) => closeManualBrowserStripTab(directoryKey, tabId)}
          onReorder={(tabId, overTabId) => reorderTabs(directoryKey, tabId, overTabId)}
          onSelectLease={(leaseId) => setActiveBrowserLease(directoryKey, leaseId)}
          onCloseLease={(leaseId) => closeBrowserLeaseStripTab(directoryKey, leaseId)}
          trailingActions={trailingActions}
        />
      ) : null}
      <div className={cn('relative min-h-0 flex-1 overflow-hidden', isResizing && 'pointer-events-none')}>
        {isOpen && isBrowserPanelRuntimeSupported() ? (
          <>
            <ManualBrowserWorkspacePane
              key={directoryKey}
              directory={directoryKey}
              active={surfacesActive && !activeLeaseId}
              showTabStrip={false}
            />
            {leaseTabs.map((tab) => (
              <BrowserLeasePane
                key={tab.leaseId}
                leaseId={tab.leaseId}
                active={surfacesActive && observedLeaseId === tab.leaseId}
              />
            ))}
          </>
        ) : isOpen ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <RiGlobalLine className="size-12 text-muted-foreground/50" />
            <div className="max-w-sm typography-micro text-muted-foreground">{t('contextPanel.browser.desktopOnly')}</div>
          </div>
        ) : null}
      </div>
    </aside>
  );
};
