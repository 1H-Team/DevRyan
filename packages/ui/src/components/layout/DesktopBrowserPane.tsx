import React from 'react';
import {
  RiArrowLeftLine,
  RiArrowRightLine,
  RiCodeSSlashLine,
  RiComputerLine,
  RiCursorLine,
  RiDeviceLine,
  RiExternalLinkLine,
  RiGlobalLine,
  RiPictureInPicture2Line,
  RiPictureInPictureExitLine,
  RiPlayLine,
  RiRefreshLine,
  RiServerLine,
  RiSmartphoneLine,
  RiTerminalBoxLine,
} from '@remixicon/react';

import { useAppFontEffects } from '@/apps/useAppFontEffects';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { invokeDesktop, isElectronShell, isStandaloneWebRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import {
  desktopAnnotationToFile,
  formatPreviewAnnotationMarkdown,
  isPreviewElementMetadata,
} from '@/lib/preview/screenshot-capture';
import { openExternalUrl } from '@/lib/url';
import { cn } from '@/lib/utils';
import { useBrowserAgentStore, browserAgentLeaseSelectors } from '@/stores/useBrowserAgentStore';
import {
  createDesktopBrowserSurface,
  ensureBrowserSurfaceListeners,
  useBrowserSurfaceStore,
  type BrowserSurfaceSnapshot,
} from '@/stores/useBrowserSurfaceStore';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import {
  browserTabLabelForUrl,
  sanitizeManualBrowserWorkspace,
  useManualBrowserTabsStore,
  type ManualBrowserTab,
} from '@/stores/useManualBrowserTabsStore';
import { useUIStore, type BrowserLeaseTab } from '@/stores/useUIStore';
import { useInputStore } from '@/sync/input-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import {
  formatBrowserAddress,
  normalizeBrowserUrl,
  reconcileWebBrowserDisplayUrl,
  sanitizeWebBrowserDisplayUrl,
} from './browserUrl';
import { closeManualBrowserStripTab } from './browserPanelClose';
import {
  CONTEXT_PANEL_RESIZE_GUTTER_PX,
  resolveBrowserViewportLayout,
  sanitizeBrowserViewportMode,
  type BrowserViewportMode,
} from './browserViewport';
import {
  useProjectPreviewInstances,
} from './localPreviewInstances';
import { isBrowserHostRoutedUrl, parsePreviewHttpUrl } from './previewLifecycle';
import {
  usePreviewDiagnostics,
  type PreviewAnnotationAttachment,
} from './previewDiagnostics';
import { PreviewConsolePanel } from './PreviewConsolePanel';
import { BrowserTabStrip, type BrowserTabStripItem } from './BrowserTabStrip';
import { useGuestRetention } from './useGuestRetention';
import { useNativeSurfaceRectSync, type NativeSurfaceRect } from './useNativeSurfaceRectSync';
import { setNativeSurfaceOccupancy } from './nativeSurfaceOccupancy';
import {
  createEmptyPreviewDiagnosticsState,
  formatPreviewConsoleText,
  isPreviewConsoleEvent,
  isPreviewDiagnosticsState,
  type PreviewConsoleEvent,
  type PreviewDiagnosticsState,
} from './previewDiagnosticsState';

export type DesktopBrowserPaneProps = {
  initialUrl: string;
  directory: string;
  tabID: string;
  active: boolean;
  leaseId?: string;
  workspaceId?: string;
  popped?: boolean;
  onPopoutOrDock?: () => void;
  webInitialState?: WebBrowserSessionState;
  onWebState?: (state: WebBrowserSessionState) => void;
  viewportMode?: BrowserViewportMode;
  onViewportModeChange?: (mode: BrowserViewportMode) => void;
};

type BrowserToolbarProps = {
  snapshot: Pick<BrowserSurfaceSnapshot, 'loading' | 'canGoBack' | 'canGoForward' | 'devToolsOpen'>;
  urlInput: string;
  viewportMode: BrowserViewportMode;
  popped: boolean;
  supportsDevTools?: boolean;
  supportsInspect?: boolean;
  showWebDiagnostics?: boolean;
  webDiagnosticsEnabled?: boolean;
  webDiagnosticsDisabledReason?: string;
  consoleOpen?: boolean;
  inspecting?: boolean;
  nativeTitlebar?: boolean;
  onUrlInput: (value: string) => void;
  onNavigate: (value: string) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onToggleDevTools?: () => void;
  onInspect?: () => void;
  onToggleConsole?: () => void;
  onPopoutOrDock: () => void;
  onViewportModeChange: (mode: BrowserViewportMode) => void;
};

const BROWSER_TOOLBAR_BUTTON_CLASS = 'size-7 p-0 leading-none';
const BROWSER_TOOLBAR_ICON_CLASS = 'size-3.5';

const BROWSER_VIEWPORT_OPTIONS: readonly {
  value: BrowserViewportMode;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { value: 'responsive', label: 'Responsive', icon: RiDeviceLine },
  { value: 'desktop', label: 'Desktop', icon: RiComputerLine },
  { value: 'mobile', label: 'Mobile', icon: RiSmartphoneLine },
];

type BrowserTabsBarProps = {
  tabs: readonly ManualBrowserTab[];
  activeTabId: string;
  nativeTitlebar?: boolean;
  leaseTabs?: readonly BrowserLeaseTab[];
  activeLeaseId?: string | null;
  onSelectLease?: (leaseId: string) => void;
  onCloseLease?: (leaseId: string) => void;
  trailingActions?: React.ReactNode;
  onAdd: () => void;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onReorder: (activeTabId: string, overTabId: string) => void;
};

export const BrowserTabsBar: React.FC<BrowserTabsBarProps> = ({
  tabs,
  activeTabId,
  nativeTitlebar = false,
  leaseTabs = [],
  activeLeaseId = null,
  onSelectLease,
  onCloseLease,
  trailingActions,
  onAdd,
  onSelect,
  onClose,
  onReorder,
}) => {
  const reserveMacTrafficLights = nativeTitlebar
    && typeof navigator !== 'undefined'
    && /Macintosh|Mac OS X/.test(navigator.userAgent || '');
  const activeManualSurfaceId = useBrowserSurfaceStore((state) => state.surfaceIdByTabId.get(activeTabId) ?? '');
  const activeManualLoading = useBrowserSurfaceStore((state) => (
    activeManualSurfaceId ? state.byId.get(activeManualSurfaceId)?.loading === true : false
  ));
  const activeLeaseSelector = React.useMemo(
    () => browserAgentLeaseSelectors.lease(activeLeaseId ?? ''),
    [activeLeaseId],
  );
  const activeLease = useBrowserAgentStore(activeLeaseSelector);
  const activeLeaseSurface = useBrowserSurfaceStore((state) => (
    activeLease?.surfaceId ? state.byId.get(activeLease.surfaceId) ?? null : null
  ));
  const items = React.useMemo<BrowserTabStripItem[]>(() => [
    ...tabs.map((tab) => ({
      id: tab.id,
      label: tab.label,
      title: tab.url === 'about:blank' ? 'New tab' : tab.url,
      faviconUrl: tab.faviconUrl,
      loading: tab.id === activeTabId && !activeLeaseId ? activeManualLoading : false,
      sortable: true,
    })),
    ...leaseTabs.map((tab) => ({
      id: tab.id,
      label: tab.leaseId === activeLeaseId && activeLease?.title ? activeLease.title : tab.label,
      title: tab.url === 'about:blank' ? tab.label : tab.url,
      faviconUrl: tab.leaseId === activeLeaseId ? activeLeaseSurface?.faviconUrl : undefined,
      loading: tab.leaseId === activeLeaseId && activeLeaseSurface?.loading === true,
      leaseDot: true,
      sortable: false,
    })),
  ], [activeLease?.title, activeLeaseId, activeLeaseSurface?.faviconUrl, activeLeaseSurface?.loading, activeManualLoading, activeTabId, leaseTabs, tabs]);
  const activeStripId = activeLeaseId
    ? leaseTabs.find((tab) => tab.leaseId === activeLeaseId)?.id ?? activeTabId
    : activeTabId;
  const leaseByTabId = React.useMemo(() => new Map(leaseTabs.map((tab) => [tab.id, tab.leaseId])), [leaseTabs]);

  return (
    <div
      data-browser-tabs-strip="true"
      className={`flex h-8 shrink-0 items-stretch bg-[var(--surface-elevated)] ${reserveMacTrafficLights ? 'pl-[78px]' : ''}`}
    >
      <BrowserTabStrip
        items={items}
        activeId={activeStripId}
        onSelect={(tabId) => {
          const leaseId = leaseByTabId.get(tabId);
          if (leaseId) onSelectLease?.(leaseId);
          else onSelect(tabId);
        }}
        onClose={(tabId) => {
          const leaseId = leaseByTabId.get(tabId);
          if (leaseId) onCloseLease?.(leaseId);
          else onClose(tabId);
        }}
        onReorder={onReorder}
        onAdd={onAdd}
        trailingActions={trailingActions}
      />
    </div>
  );
};

const BrowserToolbar: React.FC<BrowserToolbarProps> = ({
  snapshot,
  urlInput,
  viewportMode,
  popped,
  supportsDevTools = false,
  supportsInspect = false,
  showWebDiagnostics = false,
  webDiagnosticsEnabled = false,
  webDiagnosticsDisabledReason,
  consoleOpen = false,
  inspecting = false,
  nativeTitlebar = false,
  onUrlInput,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onToggleDevTools,
  onInspect,
  onToggleConsole,
  onPopoutOrDock,
  onViewportModeChange,
}) => {
  const { t } = useI18n();
  const reserveMacTrafficLights = nativeTitlebar
    && typeof navigator !== 'undefined'
    && /Macintosh|Mac OS X/.test(navigator.userAgent || '');
  const selectedViewport = BROWSER_VIEWPORT_OPTIONS.find((option) => option.value === viewportMode)
    ?? BROWSER_VIEWPORT_OPTIONS[0];
  const ViewportIcon = selectedViewport.icon;
  return (
    <div className={`flex h-[38px] shrink-0 items-center gap-1 border-b border-border/40 bg-[var(--surface-background)] pr-2 ${reserveMacTrafficLights ? 'pl-[78px]' : 'pl-2'}`}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={BROWSER_TOOLBAR_BUTTON_CLASS}
        disabled={!snapshot.canGoBack}
        aria-label={t('contextPanel.browser.backAria')}
        onClick={onBack}
      >
        <RiArrowLeftLine className={BROWSER_TOOLBAR_ICON_CLASS} />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={BROWSER_TOOLBAR_BUTTON_CLASS}
        disabled={!snapshot.canGoForward}
        aria-label={t('contextPanel.browser.forwardAria')}
        onClick={onForward}
      >
        <RiArrowRightLine className={BROWSER_TOOLBAR_ICON_CLASS} />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={BROWSER_TOOLBAR_BUTTON_CLASS}
        aria-label={t('contextPanel.preview.actions.reload')}
        onClick={onReload}
      >
        <RiRefreshLine className={`${BROWSER_TOOLBAR_ICON_CLASS} ${snapshot.loading ? 'animate-spin' : ''}`} />
      </Button>
      <form
        className="flex min-w-0 flex-1 items-center"
        onSubmit={(event) => {
          event.preventDefault();
          onNavigate(urlInput);
        }}
      >
        <input
          value={urlInput}
          onChange={(event) => onUrlInput(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
          className="block h-7 w-full rounded-md border border-border/50 bg-[var(--surface-elevated)] px-2 font-sans typography-ui-label font-normal leading-none tracking-normal text-foreground outline-none focus:border-[var(--interactive-focus-ring)]"
          aria-label={t('contextPanel.browser.addressAria')}
          placeholder={t('contextPanel.browser.addressPlaceholder')}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
      </form>
      {supportsDevTools ? (
        <Button
          type="button"
          variant={snapshot.devToolsOpen ? 'secondary' : 'ghost'}
          size="sm"
          className={BROWSER_TOOLBAR_BUTTON_CLASS}
          aria-label={snapshot.devToolsOpen ? 'Close DevTools' : 'Open DevTools'}
          aria-pressed={snapshot.devToolsOpen}
          onClick={onToggleDevTools}
        >
          <RiCodeSSlashLine className={BROWSER_TOOLBAR_ICON_CLASS} />
        </Button>
      ) : null}
      {showWebDiagnostics ? (
        <Button
          type="button"
          variant={consoleOpen ? 'secondary' : 'ghost'}
          size="sm"
          className={BROWSER_TOOLBAR_BUTTON_CLASS}
          disabled={!webDiagnosticsEnabled}
          aria-label="Console"
          aria-pressed={consoleOpen}
          title={webDiagnosticsEnabled ? 'Console' : webDiagnosticsDisabledReason}
          onClick={onToggleConsole}
        >
          <RiTerminalBoxLine className={BROWSER_TOOLBAR_ICON_CLASS} />
        </Button>
      ) : null}
      {supportsInspect || showWebDiagnostics ? (
        <Button
          type="button"
          variant={inspecting ? 'secondary' : 'ghost'}
          size="sm"
          className={BROWSER_TOOLBAR_BUTTON_CLASS}
          aria-label={t('contextPanel.browser.selectForChat')}
          aria-pressed={inspecting}
          disabled={showWebDiagnostics && !webDiagnosticsEnabled}
          title={showWebDiagnostics && !webDiagnosticsEnabled
            ? webDiagnosticsDisabledReason
            : t('contextPanel.browser.selectForChat')}
          onClick={onInspect}
        >
          <RiCursorLine className={BROWSER_TOOLBAR_ICON_CLASS} />
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={BROWSER_TOOLBAR_BUTTON_CLASS}
        aria-label={popped ? 'Dock Browser' : 'Pop Out Browser'}
        title={popped ? 'Dock Browser' : 'Pop Out Browser'}
        onClick={onPopoutOrDock}
      >
        {popped
          ? <RiPictureInPictureExitLine className={BROWSER_TOOLBAR_ICON_CLASS} />
          : <RiPictureInPicture2Line className={BROWSER_TOOLBAR_ICON_CLASS} />}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={BROWSER_TOOLBAR_BUTTON_CLASS}
            aria-label={`Viewport: ${selectedViewport.label}`}
            title={`Viewport: ${selectedViewport.label}`}
          >
            <ViewportIcon className={BROWSER_TOOLBAR_ICON_CLASS} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-40">
          <DropdownMenuRadioGroup
            value={viewportMode}
            onValueChange={(value) => onViewportModeChange(sanitizeBrowserViewportMode(value))}
          >
            {BROWSER_VIEWPORT_OPTIONS.map((option) => {
              const OptionIcon = option.icon;
              return (
                <DropdownMenuRadioItem key={option.value} value={option.value}>
                  <OptionIcon className="size-4 text-muted-foreground" />
                  {option.label}
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};

const EmptyBrowserState: React.FC<{
  directory: string;
  active: boolean;
  loading: boolean;
  onNavigate: (url: string) => void;
}> = ({ directory, active, loading, onNavigate }) => {
  const { t } = useI18n();
  const reachable = useProjectPreviewInstances(active && !loading, directory);
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-background p-6">
      {reachable.length > 0 ? (
        <div role="list" aria-label={t('contextPanel.browser.localInstancesAria')} className="w-full max-w-[39rem] overflow-hidden rounded-2xl border border-border/70 bg-[var(--surface-background)]">
          {reachable.map((instance, index) => (
            <div key={instance.origin} role="listitem" className={index === 0 ? 'flex min-h-16 items-center gap-4 px-4 py-3' : 'flex min-h-16 items-center gap-4 border-t border-border/60 px-4 py-3'}>
              <RiServerLine className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate typography-ui-header text-foreground">{instance.label}</span>
              <span className="shrink-0 font-mono typography-ui-header text-muted-foreground">:{instance.port}</span>
              <Button type="button" variant="secondary" size="sm" className="h-10 w-10 shrink-0 rounded-xl p-0" onClick={() => onNavigate(instance.url)}>
                <RiPlayLine className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center gap-3 text-center">
          <RiGlobalLine className="h-12 w-12 text-muted-foreground/50" />
          <span className="typography-ui-header text-foreground">{t('contextPanel.browser.empty')}</span>
          <span className="max-w-sm typography-micro text-muted-foreground">{t('contextPanel.browser.emptyHint')}</span>
        </div>
      )}
    </div>
  );
};

const DEFAULT_DEVTOOLS_HEIGHT = 300;
const MIN_BROWSER_HEIGHT = 120;

const ElectronBrowserPane: React.FC<DesktopBrowserPaneProps> = ({
  initialUrl,
  directory,
  tabID,
  active,
  leaseId,
  workspaceId,
  popped: poppedOverride,
  onPopoutOrDock,
  viewportMode: initialViewportMode = 'responsive',
  onViewportModeChange,
}) => {
  const { t } = useI18n();
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const initialUrlRef = React.useRef(normalizeBrowserUrl(initialUrl));
  const initialViewportModeRef = React.useRef(initialViewportMode);
  const [manualSurfaceId, setManualSurfaceId] = React.useState('');
  const [urlInput, setUrlInput] = React.useState(formatBrowserAddress(normalizeBrowserUrl(initialUrl)));
  const [inspecting, setInspecting] = React.useState(false);
  const [devToolsHeight, setDevToolsHeight] = React.useState(DEFAULT_DEVTOOLS_HEIGHT);
  const leaseSelector = React.useMemo(() => browserAgentLeaseSelectors.lease(leaseId ?? ''), [leaseId]);
  const lease = useBrowserAgentStore(leaseSelector);
  const surfaceId = leaseId ? (lease?.surfaceId ?? '') : manualSurfaceId;
  const snapshot = useBrowserSurfaceStore((state) => surfaceId ? state.byId.get(surfaceId) ?? null : null);
  const setContextPanelTabTargetPath = useUIStore((state) => state.setContextPanelTabTargetPath);
  const updateManualBrowserTabUrl = useManualBrowserTabsStore((state) => state.updateTabUrl);
  const updateManualBrowserTabTitle = useManualBrowserTabsStore((state) => state.updateTabTitle);
  const updateManualBrowserTabFavicon = useManualBrowserTabsStore((state) => state.updateTabFavicon);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentDraftId = useSessionUIStore((state) => state.currentDraftId);
  const newSessionDraftOpen = useSessionUIStore((state) => Boolean(state.currentDraftId && state.newSessionDraft?.open));
  const addInlineCommentDraft = useInlineCommentDraftStore((state) => state.addDraft);
  const addAttachedFile = useInputStore((state) => state.addAttachedFile);
  const currentUrl = snapshot?.url ?? normalizeBrowserUrl(initialUrl);
  const viewportMode = snapshot?.viewportMode ?? initialViewportMode;
  const isBlank = currentUrl === 'about:blank';
  const popped = poppedOverride ?? snapshot?.placement === 'popout';

  React.useEffect(() => {
    ensureBrowserSurfaceListeners();
    if (leaseId) return;
    let cancelled = false;
    void createDesktopBrowserSurface(tabID, initialUrlRef.current, workspaceId, initialViewportModeRef.current)
      .then((created) => {
        if (!cancelled && created) setManualSurfaceId(created.surfaceId);
      })
      .catch(() => {
        if (!cancelled) toast.error(t('contextPanel.browser.openFailed'));
      });
    return () => { cancelled = true; };
  }, [leaseId, t, tabID, workspaceId]);

  React.useEffect(() => {
    if (!surfaceId) return;
    void invokeDesktop<unknown>('desktop_browser_surface_snapshot', { surfaceId })
      .then((value) => useBrowserSurfaceStore.getState().applySnapshot(value, leaseId ? undefined : tabID))
      .catch(() => {});
  }, [leaseId, surfaceId, tabID]);

  React.useEffect(() => {
    setUrlInput(formatBrowserAddress(currentUrl));
    if (workspaceId) {
      updateManualBrowserTabUrl(directory, tabID, currentUrl);
    } else if (!leaseId && currentUrl !== 'about:blank') {
      setContextPanelTabTargetPath(directory, tabID, currentUrl);
    }
  }, [currentUrl, directory, leaseId, setContextPanelTabTargetPath, tabID, updateManualBrowserTabUrl, workspaceId]);

  React.useEffect(() => {
    if (snapshot) onViewportModeChange?.(snapshot.viewportMode);
  }, [onViewportModeChange, snapshot]);

  React.useEffect(() => {
    if (!workspaceId || !snapshot) return;
    updateManualBrowserTabTitle(directory, tabID, snapshot.title);
  }, [directory, snapshot, tabID, updateManualBrowserTabTitle, workspaceId]);

  React.useEffect(() => {
    if (!workspaceId || !snapshot) return;
    updateManualBrowserTabFavicon(directory, tabID, snapshot.faviconUrl ?? null);
  }, [directory, snapshot, tabID, updateManualBrowserTabFavicon, workspaceId]);

  const syncLayout = React.useCallback((rect: NativeSurfaceRect) => {
    if (!surfaceId) return;
    const gutter = popped ? 0 : CONTEXT_PANEL_RESIZE_GUTTER_PX;
    const left = rect.x + gutter;
    const width = Math.max(1, rect.width - gutter);
    const visible = active && !popped && !isBlank && rect.width > 0 && rect.height > 0;
    const height = snapshot?.devToolsOpen
      ? Math.max(MIN_BROWSER_HEIGHT, rect.height - devToolsHeight)
      : rect.height;
    const occupiedX = Math.round(left);
    const occupiedY = rect.y;
    const occupiedWidth = Math.max(1, Math.round(width));
    const occupiedHeight = Math.max(1, Math.round(rect.height));
    setNativeSurfaceOccupancy(surfaceId, visible ? {
      x: occupiedX,
      y: occupiedY,
      width: occupiedWidth,
      height: occupiedHeight,
      right: occupiedX + occupiedWidth,
      bottom: occupiedY + occupiedHeight,
    } : null);
    void invokeDesktop('desktop_browser_surface_layout', {
      surfaceId,
      visible,
      bounds: {
        x: occupiedX,
        y: rect.y,
        width: occupiedWidth,
        height: Math.max(1, Math.round(height)),
      },
    }).catch(() => {});
    if (snapshot?.devToolsOpen && !popped) {
      const dockHeight = Math.min(devToolsHeight, Math.max(180, rect.height - MIN_BROWSER_HEIGHT));
      void invokeDesktop('desktop_browser_devtools_set_open', {
        surfaceId,
        open: true,
        bounds: {
          x: Math.round(left),
          y: Math.round(rect.bottom - dockHeight),
          width: Math.max(1, Math.round(width)),
          height: Math.max(1, Math.round(dockHeight)),
        },
      }).catch(() => {});
    }
  }, [active, devToolsHeight, isBlank, popped, snapshot?.devToolsOpen, surfaceId]);

  useNativeSurfaceRectSync(contentRef, syncLayout);

  React.useLayoutEffect(() => () => {
    if (surfaceId) {
      setNativeSurfaceOccupancy(surfaceId, null);
      void invokeDesktop('desktop_browser_surface_layout', { surfaceId, visible: false }).catch(() => {});
    }
  }, [surfaceId]);

  React.useEffect(() => () => {
    if (!surfaceId || leaseId) return;
    void invokeDesktop('desktop_browser_surface_release', { surfaceId }).catch(() => {});
    useBrowserSurfaceStore.getState().removeSurface(surfaceId);
  }, [leaseId, surfaceId]);

  React.useEffect(() => {
    if (active || popped || !surfaceId || !snapshot?.devToolsOpen) return;
    void invokeDesktop('desktop_browser_devtools_set_open', { surfaceId, open: false }).catch(() => {});
  }, [active, popped, snapshot?.devToolsOpen, surfaceId]);

  const command = React.useCallback((action: 'back' | 'forward' | 'reload' | 'navigate', url?: string) => {
    if (!surfaceId) return;
    const args: Record<string, unknown> = { surfaceId, action };
    if (action === 'navigate') args.url = normalizeBrowserUrl(url ?? '');
    void invokeDesktop<unknown>('desktop_browser_surface_command', args)
      .then((value) => useBrowserSurfaceStore.getState().applySnapshot(value, leaseId ? undefined : tabID))
      .catch(() => toast.error(t('contextPanel.browser.openFailed')));
  }, [leaseId, surfaceId, t, tabID]);

  const toggleDevTools = React.useCallback(() => {
    if (!surfaceId || !contentRef.current) return;
    const rect = contentRef.current.getBoundingClientRect();
    const gutter = popped ? 0 : CONTEXT_PANEL_RESIZE_GUTTER_PX;
    const height = Math.min(devToolsHeight, Math.max(180, rect.height - MIN_BROWSER_HEIGHT));
    void invokeDesktop<unknown>('desktop_browser_devtools_set_open', {
      surfaceId,
      open: !snapshot?.devToolsOpen,
      bounds: {
        x: Math.round(rect.left + gutter),
        y: Math.round(rect.bottom - height),
        width: Math.max(1, Math.round(rect.width - gutter)),
        height: Math.max(1, Math.round(height)),
      },
    }).then((value) => {
      if (value && snapshot) {
        useBrowserSurfaceStore.getState().applySnapshot({ ...snapshot, devToolsOpen: (value as { open?: boolean }).open === true });
      }
    }).catch(() => toast.error(t('contextPanel.browser.devtoolsUnavailable')));
  }, [devToolsHeight, popped, snapshot, surfaceId, t]);

  const inspect = React.useCallback(() => {
    if (!surfaceId) return;
    if (inspecting) {
      setInspecting(false);
      void invokeDesktop('desktop_browser_surface_inspect', { surfaceId, cancel: true }).catch(() => {});
      return;
    }
    setInspecting(true);
    void invokeDesktop<{
      target: unknown;
      capture: { mime: string; base64: string; width: number; height: number; cssWidth: number; cssHeight: number; devicePixelRatio: number };
    } | null>('desktop_browser_surface_inspect', { surfaceId })
      .then(async (result) => {
        setInspecting(false);
        const target = result?.target;
        if (!isPreviewElementMetadata(target)) return;
        const sessionKey = currentSessionId ?? (currentDraftId ? `draft:${currentDraftId}` : newSessionDraftOpen ? 'draft' : null);
        if (!sessionKey) {
          toast.error(t('contextPanel.preview.inspect.attachNoSession'));
          return;
        }
        const capture = result?.capture;
        let screenshotAttached = false;
        if (capture) {
          const file = await desktopAnnotationToFile(
            capture.base64,
            capture.width,
            capture.height,
            capture.cssWidth,
            capture.cssHeight,
            target,
            capture.mime,
          );
          if (file) {
            await addAttachedFile(file);
            screenshotAttached = true;
          }
        }
        addInlineCommentDraft({
          sessionKey,
          source: 'preview-annotation',
          fileLabel: currentUrl || 'browser',
          startLine: 1,
          endLine: 1,
          code: formatPreviewAnnotationMarkdown({
            pageUrl: currentUrl,
            viewport: { width: capture?.cssWidth ?? 0, height: capture?.cssHeight ?? 0 },
            devicePixelRatio: capture?.devicePixelRatio ?? (window.devicePixelRatio || 1),
            target,
            screenshotAttached,
            intro: screenshotAttached
              ? t('contextPanel.preview.inspect.attachAnnotationWithScreenshot')
              : t('contextPanel.preview.inspect.attachAnnotation'),
          }),
          language: 'markdown',
          text: '',
        });
        toast.success(t('contextPanel.preview.inspect.attached'));
      })
      .catch(() => {
        setInspecting(false);
        toast.error(t('contextPanel.browser.inspectUnavailable'));
      });
  }, [addAttachedFile, addInlineCommentDraft, currentDraftId, currentSessionId, currentUrl, inspecting, newSessionDraftOpen, surfaceId, t]);

  React.useEffect(() => {
    if (!inspecting) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      inspect();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [inspect, inspecting]);

  const togglePopout = React.useCallback(() => {
    if (onPopoutOrDock) {
      onPopoutOrDock();
      return;
    }
    if (!surfaceId) return;
    const commandName = popped ? 'desktop_browser_surface_dock' : 'desktop_browser_surface_popout';
    void invokeDesktop<unknown>(commandName, { surfaceId })
      .then((value) => useBrowserSurfaceStore.getState().applySnapshot(value, leaseId ? undefined : tabID))
      .catch(() => toast.error('Unable to change browser placement'));
  }, [leaseId, onPopoutOrDock, popped, surfaceId, tabID]);

  const changeViewportMode = React.useCallback((mode: BrowserViewportMode) => {
    if (!surfaceId) return;
    void invokeDesktop<unknown>('desktop_browser_surface_set_viewport_mode', {
      surfaceId,
      viewportMode: mode,
    }).then((value) => {
      useBrowserSurfaceStore.getState().applySnapshot(value, leaseId ? undefined : tabID);
      onViewportModeChange?.(mode);
    }).catch(() => toast.error('Unable to change browser viewport'));
  }, [leaseId, onViewportModeChange, surfaceId, tabID]);

  const toolbarSnapshot = snapshot ?? {
    loading: false,
    canGoBack: false,
    canGoForward: false,
    devToolsOpen: false,
  };

  return (
    <div className="absolute inset-0 flex flex-col bg-background">
      <BrowserToolbar
        snapshot={toolbarSnapshot}
        urlInput={urlInput}
        viewportMode={viewportMode}
        popped={popped}
        supportsDevTools
        supportsInspect
        inspecting={inspecting}
        onUrlInput={setUrlInput}
        onNavigate={(url) => command('navigate', url)}
        onBack={() => command('back')}
        onForward={() => command('forward')}
        onReload={() => command('reload')}
        onToggleDevTools={toggleDevTools}
        onInspect={inspect}
        onPopoutOrDock={togglePopout}
        onViewportModeChange={changeViewportMode}
      />
      <div ref={contentRef} className="relative min-h-0 flex-1 bg-background">
        {popped ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
            <RiGlobalLine className="h-12 w-12 text-muted-foreground/50" />
            <span className="typography-ui-header text-foreground">Browser is open in another window</span>
            <div className="flex gap-2">
              <Button type="button" variant="secondary" onClick={() => void invokeDesktop('desktop_browser_surface_focus_popout', { surfaceId })}>Focus</Button>
              <Button type="button" variant="secondary" onClick={togglePopout}>Dock</Button>
            </div>
          </div>
        ) : isBlank ? (
          <EmptyBrowserState directory={directory} active={active} loading={toolbarSnapshot.loading} onNavigate={(url) => command('navigate', url)} />
        ) : null}
        {snapshot?.devToolsOpen && !popped ? (
          <div
            role="separator"
            aria-orientation="horizontal"
            className="absolute inset-x-0 z-20 h-1.5 cursor-row-resize border-t border-border/60"
            style={{ bottom: devToolsHeight - 3 }}
            onPointerDown={(event) => {
              const startY = event.clientY;
              const startHeight = devToolsHeight;
              const onMove = (move: PointerEvent) => setDevToolsHeight(Math.max(180, startHeight + startY - move.clientY));
              const onEnd = () => {
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onEnd);
              };
              window.addEventListener('pointermove', onMove);
              window.addEventListener('pointerup', onEnd);
            }}
          />
        ) : null}
      </div>
    </div>
  );
};

type ProxyState = { origin: string; base: string; loading: boolean; error: string; external: boolean };

const RECOVERABLE_PREVIEW_TARGET_CODES = new Set([
  'preview_target_expired',
  'preview_target_not_found',
]);

// A site that keeps bouncing between origins (a sign-in handshake that never
// settles) or a target that keeps failing to resolve would otherwise re-register
// and remount the frame without end. Bound both, and say so instead of looping.
const BROWSER_HANDOFF_LOOP_WINDOW_MS = 20_000;
const BROWSER_HANDOFF_LOOP_LIMIT = 6;
const BROWSER_TARGET_INVALIDATE_WINDOW_MS = 30_000;
const BROWSER_TARGET_INVALIDATE_LIMIT = 4;
const BROWSER_HANDOFF_LOOP_MESSAGE = 'This page kept redirecting inside the DevRyan browser. Press Reload to try again, or open it in your regular browser.';
const BROWSER_TARGET_LOOP_MESSAGE = 'This page kept losing its DevRyan browser session. Press Reload to try again.';

const recordLoopAttempt = (timestamps: number[], windowMs: number): number[] => {
  const now = Date.now();
  const recent = timestamps.filter((entry) => now - entry < windowMs);
  recent.push(now);
  return recent;
};

const isRecoverablePreviewTargetDocument = (iframe: HTMLIFrameElement): boolean => {
  try {
    const frameDocument = iframe.contentDocument;
    if (!frameDocument?.contentType.toLowerCase().includes('application/json')) return false;
    const payload = JSON.parse(frameDocument.body?.textContent || '') as { code?: unknown };
    return typeof payload.code === 'string' && RECOVERABLE_PREVIEW_TARGET_CODES.has(payload.code);
  } catch {
    return false;
  }
};

export type WebBrowserSessionState = {
  version: 1;
  viewportMode: BrowserViewportMode;
  displayUrl: string;
  history: string[];
  historyIndex: number;
  diagnostics: PreviewDiagnosticsState;
  proxyTargets: Record<string, { proxyBasePath: string; expiresAt: number }>;
};

const createWebBrowserSessionState = (
  initialUrl: string,
  viewportMode: BrowserViewportMode = 'responsive',
): WebBrowserSessionState => {
  const displayUrl = sanitizeWebBrowserDisplayUrl(initialUrl);
  return {
    version: 1,
    viewportMode,
    displayUrl,
    history: [displayUrl],
    historyIndex: 0,
    diagnostics: createEmptyPreviewDiagnosticsState(),
    proxyTargets: {},
  };
};

const normalizeWebBrowserSessionState = (
  value: unknown,
  fallbackUrl = 'about:blank',
  fallbackViewportMode: BrowserViewportMode = 'responsive',
): WebBrowserSessionState => {
  if (!value || typeof value !== 'object') return createWebBrowserSessionState(fallbackUrl, fallbackViewportMode);
  const candidate = value as Partial<WebBrowserSessionState>;
  const history = Array.isArray(candidate.history)
    ? candidate.history
      .filter((entry): entry is string => typeof entry === 'string')
      .slice(-100)
      .map(sanitizeWebBrowserDisplayUrl)
    : [];
  if (history.length === 0) return createWebBrowserSessionState(fallbackUrl, fallbackViewportMode);
  const historyIndex = Math.min(
    history.length - 1,
    Math.max(0, Number.isFinite(candidate.historyIndex) ? Math.trunc(candidate.historyIndex as number) : history.length - 1),
  );
  const diagnostics = isPreviewDiagnosticsState(candidate.diagnostics)
    ? {
      consoleEvents: candidate.diagnostics.consoleEvents.slice(-200),
      consoleOpen: candidate.diagnostics.consoleOpen,
      consoleFilter: candidate.diagnostics.consoleFilter,
      inspectMode: candidate.diagnostics.inspectMode,
    }
    : createEmptyPreviewDiagnosticsState();
  const proxyTargets = candidate.proxyTargets && typeof candidate.proxyTargets === 'object'
    ? Object.fromEntries(Object.entries(candidate.proxyTargets).flatMap(([origin, entry]) => {
      if (!entry || typeof entry !== 'object') return [];
      const target = entry as { proxyBasePath?: unknown; expiresAt?: unknown };
      if (
        !/^\/api\/preview\/proxy\/[a-f0-9]{16,64}$/i.test(String(target.proxyBasePath || ''))
        || typeof target.expiresAt !== 'number'
      ) return [];
      return [[origin, { proxyBasePath: String(target.proxyBasePath), expiresAt: target.expiresAt }]];
    }))
    : {};
  return {
    version: 1,
    viewportMode: candidate.viewportMode === undefined
      ? fallbackViewportMode
      : sanitizeBrowserViewportMode(candidate.viewportMode),
    displayUrl: history[historyIndex],
    history,
    historyIndex,
    diagnostics,
    proxyTargets,
  };
};

const useBrowserFrameSource = (
  url: string,
  directory: string,
  reloadKey: number,
  knownTargets: WebBrowserSessionState['proxyTargets'],
  onTarget: (origin: string, target: { proxyBasePath: string; expiresAt: number }) => void,
): ProxyState & { src: string; routed: boolean } => {
  const parsed = parsePreviewHttpUrl(url);
  const hostRouted = isBrowserHostRoutedUrl(url);
  const target = parsed?.toString() ?? '';
  const origin = parsed?.origin ?? '';
  const [registrationNonce, bumpRegistration] = React.useReducer((value: number) => value + 1, 0);
  const [state, setState] = React.useState<ProxyState>({ origin: '', base: '', loading: Boolean(target && hostRouted), error: '', external: Boolean(target && !hostRouted) });
  React.useEffect(() => {
    if (!target) {
      setState({ origin: '', base: '', loading: false, error: '', external: false });
      return;
    }
    if (!hostRouted) {
      setState({ origin, base: '', loading: false, error: '', external: true });
      return;
    }
    const knownTarget = knownTargets[origin];
    if (knownTarget && knownTarget.expiresAt - Date.now() > 30_000) {
      setState({ origin, base: knownTarget.proxyBasePath, loading: false, error: '', external: false });
      const refreshIn = Math.max(1_000, knownTarget.expiresAt - Date.now() - 30_000);
      const timer = window.setTimeout(bumpRegistration, refreshIn);
      return () => window.clearTimeout(timer);
    }
    let cancelled = false;
    setState({ origin, base: '', loading: true, error: '', external: false });
    void (async () => {
      let lastError = 'Failed to register browser target';
      for (let attempt = 0; attempt < 12 && !cancelled; attempt += 1) {
        const response = await fetch('/api/browser/targets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-DevRyan-CSRF': '1' },
          credentials: 'include',
          cache: 'no-store',
          body: JSON.stringify({ url: target, directory }),
        });
        const body = await response.json().catch(() => ({})) as {
          proxyBasePath?: unknown;
          expiresAt?: unknown;
          error?: unknown;
          code?: unknown;
        };
        if (response.ok && typeof body.proxyBasePath === 'string' && typeof body.expiresAt === 'number') {
          onTarget(origin, { proxyBasePath: body.proxyBasePath, expiresAt: body.expiresAt });
          if (!cancelled) setState({ origin, base: body.proxyBasePath, loading: false, error: '', external: false });
          return;
        }
        if (response.status === 401) {
          lastError = 'Your DevRyan session has expired. Sign in again to use Browser.';
          break;
        }
        lastError = typeof body.error === 'string' ? body.error : `HTTP ${response.status}`;
        const approvalPending = response.status === 403
          && (body.code === 'project_preview_not_approved'
            || body.error === 'This project preview port has not been approved');
        if (!approvalPending || attempt === 11) break;
        await new Promise<void>((resolve) => window.setTimeout(resolve, 300));
      }
      throw new Error(lastError);
    })().catch((error) => {
      if (!cancelled) setState({ origin, base: '', loading: false, error: error instanceof Error ? error.message : String(error), external: false });
    });
    return () => { cancelled = true; };
  }, [directory, hostRouted, knownTargets, onTarget, origin, registrationNonce, target]);

  if (!target || url === 'about:blank') return { ...state, src: '', routed: false };
  // Never combine a newly entered URL with the previous origin's proxy id.
  // The registration effect runs after render, so origin ownership must be
  // explicit to avoid one transient request (and visible flash) to the wrong app.
  if (state.origin !== origin || !state.base || !parsed) return { ...state, src: '', routed: true };
  return {
    ...state,
    src: `${state.base}${parsed.pathname || '/'}${parsed.search}${parsed.hash}`,
    routed: true,
  };
};

type WebBrowserSurfaceProps = {
  initialState: WebBrowserSessionState;
  directory: string;
  active: boolean;
  popped?: boolean;
  onState?: (state: WebBrowserSessionState) => void;
  onAttachConsole: (events: PreviewConsoleEvent[], pageUrl: string) => void;
  onAttachAnnotation: (attachment: PreviewAnnotationAttachment) => void;
  onPopoutOrDock: () => void;
};

const useBrowserCanvasSize = (ref: React.RefObject<HTMLDivElement | null>) => {
  const [size, setSize] = React.useState({ width: 1, height: 1 });
  React.useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      const rect = element.getBoundingClientRect();
      setSize((current) => {
        const width = Math.max(1, rect.width);
        const height = Math.max(1, rect.height);
        return current.width === width && current.height === height ? current : { width, height };
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
};

const WebBrowserSurface: React.FC<WebBrowserSurfaceProps> = ({
  initialState,
  directory,
  active,
  popped = false,
  onState,
  onAttachConsole,
  onAttachAnnotation,
  onPopoutOrDock,
}) => {
  const { currentTheme } = useThemeSystem();
  const iframeRef = React.useRef<HTMLIFrameElement | null>(null);
  const canvasRef = React.useRef<HTMLDivElement | null>(null);
  const pendingNavigationRef = React.useRef<string | null>(null);
  const normalizedInitialState = React.useRef(normalizeWebBrowserSessionState(initialState));
  const [history, setHistory] = React.useState(normalizedInitialState.current.history);
  const [historyIndex, setHistoryIndex] = React.useState(normalizedInitialState.current.historyIndex);
  const [frameTargetUrl, setFrameTargetUrl] = React.useState(normalizedInitialState.current.displayUrl);
  const [proxyTargets, setProxyTargets] = React.useState(normalizedInitialState.current.proxyTargets);
  const [viewportMode, setViewportMode] = React.useState(normalizedInitialState.current.viewportMode);
  const [urlInput, setUrlInput] = React.useState(formatBrowserAddress(normalizedInitialState.current.displayUrl));
  const [reloadKey, setReloadKey] = React.useState(0);
  const [frameLoaded, setFrameLoaded] = React.useState(false);
  const [renderedFrame, setRenderedFrame] = React.useState({ src: '', key: '' });
  const [loopError, setLoopError] = React.useState('');
  const [externalOpenBlocked, setExternalOpenBlocked] = React.useState(false);
  const handoffNavigationsRef = React.useRef<number[]>([]);
  const targetInvalidationsRef = React.useRef<number[]>([]);
  const currentUrl = history[historyIndex] ?? 'about:blank';
  const canvasSize = useBrowserCanvasSize(canvasRef);
  const viewportLayout = resolveBrowserViewportLayout(canvasSize.width, canvasSize.height, viewportMode);
  const resetLoopGuards = React.useCallback(() => {
    handoffNavigationsRef.current = [];
    targetInvalidationsRef.current = [];
    setLoopError('');
  }, []);
  const invalidateRenderedProxyTarget = React.useCallback(() => {
    const attempts = recordLoopAttempt(targetInvalidationsRef.current, BROWSER_TARGET_INVALIDATE_WINDOW_MS);
    targetInvalidationsRef.current = attempts;
    if (attempts.length > BROWSER_TARGET_INVALIDATE_LIMIT) {
      // Keeping the stale target is what stops the cycle: without a new
      // proxy id the frame source is unchanged and nothing remounts.
      setLoopError(BROWSER_TARGET_LOOP_MESSAGE);
      return;
    }
    setProxyTargets((current) => {
      const staleOrigin = Object.entries(current).find(([, target]) => (
        renderedFrame.src === target.proxyBasePath
        || renderedFrame.src.startsWith(`${target.proxyBasePath}/`)
        || renderedFrame.src.startsWith(`${target.proxyBasePath}?`)
      ))?.[0];
      if (!staleOrigin) return current;
      const next = { ...current };
      delete next[staleOrigin];
      return next;
    });
  }, [renderedFrame.src]);
  const handleFrameLoad = React.useCallback(() => {
    const iframe = iframeRef.current;
    if (iframe && isRecoverablePreviewTargetDocument(iframe)) {
      setFrameLoaded(false);
      invalidateRenderedProxyTarget();
      return;
    }
    setFrameLoaded(true);
  }, [invalidateRenderedProxyTarget]);
  const rememberProxyTarget = React.useCallback((origin: string, target: { proxyBasePath: string; expiresAt: number }) => {
    setProxyTargets((current) => {
      const previous = current[origin];
      if (previous?.proxyBasePath === target.proxyBasePath && previous.expiresAt === target.expiresAt) return current;
      return { ...current, [origin]: target };
    });
  }, []);
  const frame = useBrowserFrameSource(
    frameTargetUrl,
    directory,
    reloadKey,
    proxyTargets,
    rememberProxyTarget,
  );
  React.useLayoutEffect(() => {
    if (!frame.src) return;
    const key = `${frame.src}:${reloadKey}`;
    if (renderedFrame.src === frame.src && renderedFrame.key === key) return;
    setFrameLoaded(false);
    setRenderedFrame({ src: frame.src, key });
  }, [frame.src, reloadKey, renderedFrame.key, renderedFrame.src]);
  const frameActive = Boolean(frame.src && renderedFrame.src === frame.src);
  const loading = !loopError && (frame.loading || (currentUrl !== 'about:blank' && !frameLoaded && !frame.error));
  const loadingLabel = (() => {
    try {
      return `Loading ${new URL(currentUrl).host}…`;
    } catch {
      return 'Loading page…';
    }
  })();

  const navigate = React.useCallback((value: string) => {
    const next = sanitizeWebBrowserDisplayUrl(value);
    pendingNavigationRef.current = next;
    setHistory((current) => [...current.slice(0, historyIndex + 1), next]);
    setHistoryIndex(historyIndex + 1);
    setFrameTargetUrl(next);
    setFrameLoaded(false);
    setUrlInput(formatBrowserAddress(next));
  }, [historyIndex]);
  const openExternal = React.useCallback((value: string) => {
    setExternalOpenBlocked(false);
    void openExternalUrl(value).then((opened) => setExternalOpenBlocked(!opened));
  }, []);
  const navigateFromUser = React.useCallback((value: string) => {
    const next = sanitizeWebBrowserDisplayUrl(value);
    navigate(next);
    const parsed = parsePreviewHttpUrl(next);
    if (parsed && !isBrowserHostRoutedUrl(next)) openExternal(next);
  }, [navigate, openExternal]);
  // Redirect handoffs are driven by the embedded page, so they are the one
  // navigation source that can run unattended. Bound how often it may fire.
  const handleHandoffNavigate = React.useCallback((value: string) => {
    const attempts = recordLoopAttempt(handoffNavigationsRef.current, BROWSER_HANDOFF_LOOP_WINDOW_MS);
    handoffNavigationsRef.current = attempts;
    if (attempts.length > BROWSER_HANDOFF_LOOP_LIMIT) {
      setLoopError(BROWSER_HANDOFF_LOOP_MESSAGE);
      return;
    }
    const next = sanitizeWebBrowserDisplayUrl(value);
    navigate(next);
    const parsed = parsePreviewHttpUrl(next);
    if (parsed && !isBrowserHostRoutedUrl(next)) openExternal(next);
  }, [navigate, openExternal]);
  const handleRenderReady = React.useCallback(() => setFrameLoaded(true), []);
  const handleNavigationStart = React.useCallback(() => setFrameLoaded(false), []);
  const handleDisplayNavigate = React.useCallback((value: string, reason: 'ready' | 'display') => {
    const next = reconcileWebBrowserDisplayUrl(value, currentUrl);
    if (next === 'about:blank') return;
    if (next === currentUrl) {
      if (reason === 'ready') pendingNavigationRef.current = null;
      setUrlInput(formatBrowserAddress(next));
      return;
    }
    if (reason === 'ready' && pendingNavigationRef.current) {
      pendingNavigationRef.current = null;
      setHistory((current) => current.map((entry, index) => (index === historyIndex ? next : entry)));
    } else {
      pendingNavigationRef.current = null;
      setHistory((current) => [...current.slice(0, historyIndex + 1), next]);
      setHistoryIndex(historyIndex + 1);
    }
    setUrlInput(formatBrowserAddress(next));
  }, [currentUrl, historyIndex]);

  const diagnostics = usePreviewDiagnostics({
    iframeRef,
    enabled: frame.routed && frameActive,
    // Key off the mounted iframe, not the displayed URL: a same-document SPA
    // navigation keeps the bridge alive and must not reset it, since only a
    // freshly parsed document ever announces itself as ready again.
    frameKey: renderedFrame.key,
    pageUrl: currentUrl,
    colorScheme: currentTheme.metadata.variant,
    initialState: normalizedInitialState.current.diagnostics,
    onRenderReady: handleRenderReady,
    onNavigationStart: handleNavigationStart,
    onDisplayNavigate: handleDisplayNavigate,
    onTargetNavigate: handleHandoffNavigate,
    onExternalNavigate: handleHandoffNavigate,
    onAttachConsole,
    onAttachAnnotation,
  });

  React.useEffect(() => {
    onState?.({
      version: 1,
      viewportMode,
      displayUrl: currentUrl,
      history,
      historyIndex,
      diagnostics: {
        consoleEvents: diagnostics.consoleEvents,
        consoleOpen: diagnostics.consoleOpen,
        consoleFilter: diagnostics.consoleFilter,
        inspectMode: diagnostics.inspectMode,
      },
      proxyTargets,
    });
  }, [
    currentUrl,
    diagnostics.consoleEvents,
    diagnostics.consoleFilter,
    diagnostics.consoleOpen,
    diagnostics.inspectMode,
    history,
    historyIndex,
    onState,
    proxyTargets,
    viewportMode,
  ]);

  const diagnosticsEnabled = frame.routed && frameActive && diagnostics.bridgeReady;
  const diagnosticsDisabledReason = currentUrl === 'about:blank'
    ? 'Open a project app to use Console and Select Element.'
    : frame.routed
      ? 'Waiting for the project app inspection bridge.'
      : 'Console and Select Element are available only for project apps routed through DevRyan.';

  const toolbarSnapshot = {
    loading,
    canGoBack: historyIndex > 0,
    canGoForward: historyIndex < history.length - 1,
    devToolsOpen: false,
  };
  return (
    <div className="absolute inset-0 flex flex-col bg-background">
      <BrowserToolbar
        snapshot={toolbarSnapshot}
        urlInput={urlInput}
        viewportMode={viewportMode}
        popped={popped}
        showWebDiagnostics
        webDiagnosticsEnabled={diagnosticsEnabled}
        webDiagnosticsDisabledReason={diagnosticsDisabledReason}
        consoleOpen={diagnostics.consoleOpen}
        inspecting={diagnostics.inspectMode}
        onUrlInput={setUrlInput}
        onNavigate={(value) => {
          resetLoopGuards();
          navigateFromUser(value);
        }}
        onBack={() => {
          const next = Math.max(0, historyIndex - 1);
          resetLoopGuards();
          pendingNavigationRef.current = history[next];
          setHistoryIndex(next);
          setFrameTargetUrl(history[next]);
          setFrameLoaded(false);
          setUrlInput(formatBrowserAddress(history[next]));
        }}
        onForward={() => {
          const next = Math.min(history.length - 1, historyIndex + 1);
          resetLoopGuards();
          pendingNavigationRef.current = history[next];
          setHistoryIndex(next);
          setFrameTargetUrl(history[next]);
          setFrameLoaded(false);
          setUrlInput(formatBrowserAddress(history[next]));
        }}
        onReload={() => {
          resetLoopGuards();
          pendingNavigationRef.current = currentUrl;
          setFrameTargetUrl(currentUrl);
          setFrameLoaded(false);
          setReloadKey((value) => value + 1);
        }}
        onToggleConsole={() => diagnostics.setConsoleOpen((value) => !value)}
        onInspect={() => diagnostics.setInspectMode((value) => !value)}
        onPopoutOrDock={onPopoutOrDock}
        onViewportModeChange={setViewportMode}
      />
      <div ref={canvasRef} className="relative min-h-0 flex-1 overflow-hidden bg-[var(--surface-elevated)]">
        {currentUrl === 'about:blank' ? (
          <EmptyBrowserState directory={directory} active={active} loading={loading} onNavigate={navigate} />
        ) : frame.external ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background p-6 text-center">
            <RiExternalLinkLine className="h-10 w-10 text-muted-foreground/60" aria-hidden="true" />
            <span className="typography-ui-header text-foreground">
              {externalOpenBlocked
                ? 'Your browser blocked the new tab.'
                : "This site opens in your regular browser using this device's connection."}
            </span>
            <span className="max-w-lg break-all typography-micro text-muted-foreground">{currentUrl}</span>
            <Button type="button" variant="secondary" onClick={() => openExternal(currentUrl)}>
              {externalOpenBlocked ? 'Open in Browser' : 'Open Again'}
            </Button>
          </div>
        ) : (
          <div
            className="absolute overflow-hidden bg-background shadow-sm"
            data-browser-viewport={viewportMode}
            style={{
              left: viewportLayout.offsetX,
              top: viewportLayout.offsetY,
              width: viewportLayout.cssWidth,
              height: viewportLayout.cssHeight,
              transform: `scale(${viewportLayout.scale})`,
              transformOrigin: 'top left',
            }}
          >
            {renderedFrame.src ? (
              <iframe
                ref={iframeRef}
                key={renderedFrame.key}
                src={renderedFrame.src}
                title="Browser"
                className="h-full w-full border-0 bg-background"
                sandbox="allow-downloads allow-forms allow-modals allow-pointer-lock allow-popups allow-same-origin allow-scripts"
                referrerPolicy="strict-origin-when-cross-origin"
                onLoad={handleFrameLoad}
              />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center p-6 text-center typography-micro text-muted-foreground">
                {frame.error || 'Loading local page…'}
              </div>
            )}
            {currentUrl !== 'about:blank' && (loading || frame.error || loopError) ? (
              <div
                className="absolute inset-0 z-10 flex items-center justify-center bg-background p-6 text-center typography-micro text-muted-foreground"
                role="status"
                aria-live="polite"
              >
                {frame.error || loopError || loadingLabel}
              </div>
            ) : null}
            {diagnostics.inspectMode && diagnostics.hoverTarget ? (
              <div
                className="pointer-events-none absolute rounded-sm border-2 border-[var(--interactive-focus-ring)] bg-[var(--interactive-focus-ring)]/35"
                style={{
                  left: diagnostics.hoverTarget.bounds.x,
                  top: diagnostics.hoverTarget.bounds.y,
                  width: diagnostics.hoverTarget.bounds.width,
                  height: diagnostics.hoverTarget.bounds.height,
                }}
              >
                <div className="absolute -top-6 left-0 max-w-64 truncate rounded bg-[var(--surface-elevated)] px-2 py-0.5 typography-micro text-foreground shadow">
                  {diagnostics.hoverTarget.tag}{diagnostics.hoverTarget.text ? ` · ${diagnostics.hoverTarget.text}` : ''}
                </div>
              </div>
            ) : null}
          </div>
        )}
        {diagnostics.consoleOpen ? <PreviewConsolePanel {...diagnostics} /> : null}
      </div>
    </div>
  );
};

const randomSurfaceId = (): string => {
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
};

type BrowserSurfaceMessage = {
  source: 'devryan-browser-surface';
  version: 1;
  surfaceId: string;
  type: 'ready' | 'init' | 'state' | 'request-dock' | 'dock' | 'closed' | 'close' | 'attach-console' | 'attach-annotation' | 'ping' | 'pong';
  state?: WebBrowserSessionState;
  directory?: string;
  events?: PreviewConsoleEvent[];
  pageUrl?: string;
  attachment?: PreviewAnnotationAttachment;
};

const BROWSER_SURFACE_MESSAGE_TYPES = new Set<BrowserSurfaceMessage['type']>([
  'ready',
  'init',
  'state',
  'request-dock',
  'dock',
  'closed',
  'close',
  'attach-console',
  'attach-annotation',
  'ping',
  'pong',
]);

const isBrowserSurfaceMessage = (value: unknown, surfaceId: string): value is BrowserSurfaceMessage => {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<BrowserSurfaceMessage>;
  return message.source === 'devryan-browser-surface'
    && message.version === 1
    && message.surfaceId === surfaceId
    && BROWSER_SURFACE_MESSAGE_TYPES.has(message.type as BrowserSurfaceMessage['type']);
};

const createBrowserSurfaceMessage = (
  surfaceId: string,
  message: Omit<BrowserSurfaceMessage, 'source' | 'version' | 'surfaceId'>,
): BrowserSurfaceMessage => ({ source: 'devryan-browser-surface', version: 1, surfaceId, ...message });

const getAuthenticatedBrowserIdentity = (value: unknown): string | null => {
  if (!value || typeof value !== 'object') return null;
  const session = value as { authenticated?: unknown; principal?: unknown };
  if (session.authenticated !== true || !session.principal || typeof session.principal !== 'object') return null;
  const principal = session.principal as { id?: unknown; policy?: unknown };
  const policy = principal.policy && typeof principal.policy === 'object'
    ? principal.policy as { browser?: unknown }
    : null;
  if (policy?.browser !== true) return null;
  const principalId = principal.id;
  return typeof principalId === 'string' && principalId ? `principal:${principalId}` : null;
};

const useBrowserChatAttachments = () => {
  const { t } = useI18n();
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentDraftId = useSessionUIStore((state) => state.currentDraftId);
  const newSessionDraftOpen = useSessionUIStore((state) => Boolean(state.currentDraftId && state.newSessionDraft?.open));
  const addInlineCommentDraft = useInlineCommentDraftStore((state) => state.addDraft);
  const addAttachedFile = useInputStore((state) => state.addAttachedFile);
  const sessionKey = currentSessionId ?? (currentDraftId ? `draft:${currentDraftId}` : newSessionDraftOpen ? 'draft' : null);

  const attachConsole = React.useCallback((events: PreviewConsoleEvent[], pageUrl: string) => {
    if (!sessionKey) {
      toast.error(t('contextPanel.preview.console.attachNoSession'));
      return;
    }
    addInlineCommentDraft({
      sessionKey,
      source: 'preview-console',
      fileLabel: pageUrl || 'browser',
      startLine: 1,
      endLine: Math.max(1, events.length),
      code: formatPreviewConsoleText(events, pageUrl),
      language: 'text',
      text: t('contextPanel.preview.console.attachAnnotation'),
    });
    toast.success(t('contextPanel.preview.console.attached'));
  }, [addInlineCommentDraft, sessionKey, t]);

  const attachAnnotation = React.useCallback((attachment: PreviewAnnotationAttachment) => {
    if (!sessionKey) {
      toast.error(t('contextPanel.preview.inspect.attachNoSession'));
      return;
    }
    void (async () => {
      let screenshotAttached = false;
      if (attachment.screenshot) {
        try {
          await addAttachedFile(attachment.screenshot);
          screenshotAttached = true;
        } catch {
          screenshotAttached = false;
        }
      }
      addInlineCommentDraft({
        sessionKey,
        source: 'preview-annotation',
        fileLabel: attachment.pageUrl || 'browser',
        startLine: 1,
        endLine: 1,
        code: formatPreviewAnnotationMarkdown({
          pageUrl: attachment.pageUrl,
          viewport: attachment.viewport,
          devicePixelRatio: attachment.devicePixelRatio,
          target: attachment.target,
          screenshotAttached,
          intro: screenshotAttached
            ? t('contextPanel.preview.inspect.attachAnnotationWithScreenshot')
            : t('contextPanel.preview.inspect.attachAnnotation'),
        }),
        language: 'markdown',
        text: '',
      });
      toast.success(t('contextPanel.preview.inspect.attached'));
    })();
  }, [addAttachedFile, addInlineCommentDraft, sessionKey, t]);

  return { attachConsole, attachAnnotation };
};

const WebBrowserPane: React.FC<DesktopBrowserPaneProps> = ({ initialUrl, directory, tabID, active }) => {
  const surfaceIdRef = React.useRef(randomSurfaceId());
  const channelRef = React.useRef<BroadcastChannel | null>(null);
  const popupRef = React.useRef<Window | null>(null);
  const fallbackMessageHandlerRef = React.useRef<((event: MessageEvent) => void) | null>(null);
  const stateRef = React.useRef(createWebBrowserSessionState(initialUrl));
  const [placement, setPlacement] = React.useState<'inline' | 'popout'>('inline');
  const setContextPanelTabTargetPath = useUIStore((state) => state.setContextPanelTabTargetPath);
  const { attachConsole, attachAnnotation } = useBrowserChatAttachments();
  const applyState = React.useCallback((state: WebBrowserSessionState) => {
    const next = normalizeWebBrowserSessionState(state, stateRef.current.displayUrl);
    stateRef.current = next;
    if (next.displayUrl !== 'about:blank') {
      setContextPanelTabTargetPath(directory, tabID, next.displayUrl);
    }
  }, [directory, setContextPanelTabTargetPath, tabID]);

  const sendToPopup = React.useCallback((message: Omit<BrowserSurfaceMessage, 'source' | 'version' | 'surfaceId'>) => {
    const envelope = createBrowserSurfaceMessage(surfaceIdRef.current, message);
    if (channelRef.current) {
      channelRef.current.postMessage(envelope);
      return;
    }
    const popup = popupRef.current;
    if (popup && !popup.closed) popup.postMessage(envelope, window.location.origin);
  }, []);

  const dock = React.useCallback(() => {
    const popup = popupRef.current;
    popupRef.current = null;
    if (popup && !popup.closed) popup.close();
    channelRef.current?.close();
    channelRef.current = null;
    if (fallbackMessageHandlerRef.current) {
      window.removeEventListener('message', fallbackMessageHandlerRef.current);
      fallbackMessageHandlerRef.current = null;
    }
    setPlacement('inline');
  }, []);

  const popout = React.useCallback(() => {
    const surfaceId = surfaceIdRef.current;
    const popup = window.open(`/browser.html?surfaceId=${encodeURIComponent(surfaceId)}`, `devryan-browser-${surfaceId}`, 'popup,width=1180,height=760');
    if (!popup) {
      toast.error('The browser pop-out was blocked. Allow pop-ups for this site and try again.');
      return;
    }
    popupRef.current = popup;
    const channel = typeof BroadcastChannel === 'function'
      ? new BroadcastChannel(`devryan-browser-surface:${surfaceId}`)
      : null;
    channelRef.current?.close();
    channelRef.current = channel;
    const receive = (message: BrowserSurfaceMessage) => {
      if (message.type === 'ready') {
        sendToPopup({ type: 'init', state: stateRef.current, directory });
      } else if (message.type === 'state' && message.state) {
        applyState(message.state);
      } else if (
        message.type === 'attach-console'
        && Array.isArray(message.events)
        && message.events.every(isPreviewConsoleEvent)
      ) {
        attachConsole(message.events, typeof message.pageUrl === 'string' ? message.pageUrl : stateRef.current.displayUrl);
      } else if (message.type === 'attach-annotation' && message.attachment && isPreviewElementMetadata(message.attachment.target)) {
        attachAnnotation(message.attachment);
      } else if (message.type === 'ping') {
        sendToPopup({ type: 'pong' });
      } else if (message.type === 'dock' || message.type === 'closed') {
        if (message.state) applyState(message.state);
        dock();
      }
    };
    if (channel) {
      channel.onmessage = (event: MessageEvent) => {
        if (isBrowserSurfaceMessage(event.data, surfaceId)) receive(event.data);
      };
    }
    const fallbackHandler = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== popup) return;
      if (isBrowserSurfaceMessage(event.data, surfaceId)) receive(event.data);
    };
    fallbackMessageHandlerRef.current = fallbackHandler;
    window.addEventListener('message', fallbackHandler);
    setPlacement('popout');
    const timer = window.setInterval(() => {
      if (!popup.closed) return;
      window.clearInterval(timer);
      dock();
    }, 400);
  }, [applyState, attachAnnotation, attachConsole, directory, dock, sendToPopup]);

  React.useEffect(() => () => {
    sendToPopup({ type: 'close' });
    channelRef.current?.close();
    if (popupRef.current && !popupRef.current.closed) popupRef.current.close();
    if (fallbackMessageHandlerRef.current) window.removeEventListener('message', fallbackMessageHandlerRef.current);
  }, [sendToPopup]);

  if (placement === 'popout') {
    return (
      <div className="absolute inset-0 flex flex-col bg-background">
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <RiGlobalLine className="h-12 w-12 text-muted-foreground/50" />
          <span className="typography-ui-header text-foreground">Browser is open in another window</span>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={() => popupRef.current?.focus()}>Focus</Button>
            <Button type="button" variant="secondary" onClick={() => sendToPopup({ type: 'request-dock' })}>Dock</Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <WebBrowserSurface
      initialState={stateRef.current}
      directory={directory}
      active={active}
      onState={applyState}
      onAttachConsole={attachConsole}
      onAttachAnnotation={attachAnnotation}
      onPopoutOrDock={popout}
    />
  );
};

const WebBrowserWorkspacePage: React.FC<DesktopBrowserPaneProps> = ({
  initialUrl,
  directory,
  active,
  popped = false,
  onPopoutOrDock,
  webInitialState,
  onWebState,
}) => {
  const initialStateRef = React.useRef(webInitialState ?? createWebBrowserSessionState(initialUrl));
  const { attachConsole, attachAnnotation } = useBrowserChatAttachments();
  return (
    <WebBrowserSurface
      initialState={initialStateRef.current}
      directory={directory}
      active={active}
      popped={popped}
      onState={onWebState}
      onAttachConsole={attachConsole}
      onAttachAnnotation={attachAnnotation}
      onPopoutOrDock={onPopoutOrDock ?? (() => undefined)}
    />
  );
};

type BrowserWorkspaceRuntimeTab = ManualBrowserTab & {
  webState?: WebBrowserSessionState;
};

type BrowserWorkspaceRuntimeState = {
  version: 2;
  transport: 'native' | 'host';
  workspaceId: string;
  directory: string;
  activeTabId: string;
  tabs: BrowserWorkspaceRuntimeTab[];
};

type BrowserWorkspaceMessage = {
  source: 'devryan-browser-workspace';
  version: 2;
  workspaceId: string;
  type: 'ready' | 'init' | 'state' | 'add-tab' | 'activate-tab' | 'close-tab' | 'reorder-tabs' | 'request-dock' | 'dock' | 'closed' | 'close' | 'attach-console' | 'attach-annotation' | 'ping' | 'pong';
  state?: BrowserWorkspaceRuntimeState;
  tabId?: string;
  overTabId?: string;
  events?: PreviewConsoleEvent[];
  pageUrl?: string;
  attachment?: PreviewAnnotationAttachment;
};

const createBrowserWorkspaceMessage = (
  workspaceId: string,
  message: Omit<BrowserWorkspaceMessage, 'source' | 'version' | 'workspaceId'>,
): BrowserWorkspaceMessage => ({
  source: 'devryan-browser-workspace',
  version: 2,
  workspaceId,
  ...message,
});

const BROWSER_WORKSPACE_MESSAGE_TYPES = new Set<BrowserWorkspaceMessage['type']>([
  'ready',
  'init',
  'state',
  'add-tab',
  'activate-tab',
  'close-tab',
  'reorder-tabs',
  'request-dock',
  'dock',
  'closed',
  'close',
  'attach-console',
  'attach-annotation',
  'ping',
  'pong',
]);

const isBrowserWorkspaceMessage = (value: unknown, workspaceId: string): value is BrowserWorkspaceMessage => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<BrowserWorkspaceMessage>;
  return candidate.source === 'devryan-browser-workspace'
    && candidate.version === 2
    && candidate.workspaceId === workspaceId
    && BROWSER_WORKSPACE_MESSAGE_TYPES.has(candidate.type as BrowserWorkspaceMessage['type']);
};

const BROWSER_PAGE_SLEEP_DELAY_MS = 60_000;

export const ManualBrowserWorkspacePane: React.FC<{
  directory: string;
  active: boolean;
  legacyUrl?: string | null;
  showTabStrip?: boolean;
}> = ({ directory, active, showTabStrip = true }) => {
  const useNativeBrowser = isElectronShell();
  const workspace = useManualBrowserTabsStore((state) => state.byDirectory[directory] ?? null);
  const addTab = useManualBrowserTabsStore((state) => state.addTab);
  const activateTab = useManualBrowserTabsStore((state) => state.activateTab);
  const updateTabUrl = useManualBrowserTabsStore((state) => state.updateTabUrl);
  const updateTabViewportMode = useManualBrowserTabsStore((state) => state.updateTabViewportMode);
  const reorderTabs = useManualBrowserTabsStore((state) => state.reorderTabs);
  const replaceWorkspace = useManualBrowserTabsStore((state) => state.replaceWorkspace);
  const surfaceByTabId = useBrowserSurfaceStore((state) => state.surfaceIdByTabId);
  const surfaces = useBrowserSurfaceStore((state) => state.byId);
  const webStatesRef = React.useRef(new Map<string, WebBrowserSessionState>());
  const workspaceIdRef = React.useRef('');
  const popupRef = React.useRef<Window | null>(null);
  const channelRef = React.useRef<BroadcastChannel | null>(null);
  const fallbackHandlerRef = React.useRef<((event: MessageEvent) => void) | null>(null);
  const [webPopped, setWebPopped] = React.useState(false);
  const { attachConsole, attachAnnotation } = useBrowserChatAttachments();

  React.useEffect(() => {
    if (!workspace) return;
    workspaceIdRef.current = workspace.workspaceId;
    const liveIds = new Set(workspace.tabs.map((tab) => tab.id));
    for (const tab of workspace.tabs) {
      if (!webStatesRef.current.has(tab.id)) {
        webStatesRef.current.set(tab.id, createWebBrowserSessionState(tab.url, tab.viewportMode));
      }
    }
    for (const tabId of webStatesRef.current.keys()) {
      if (!liveIds.has(tabId)) webStatesRef.current.delete(tabId);
    }
  }, [workspace]);

  const activeSurfaceId = workspace ? surfaceByTabId.get(workspace.activeTabId) ?? '' : '';
  const activeSurface = activeSurfaceId ? surfaces.get(activeSurfaceId) ?? null : null;
  const popped = useNativeBrowser ? activeSurface?.placement === 'popout' : webPopped;

  const runtimeState = React.useCallback((): BrowserWorkspaceRuntimeState | null => {
    const current = useManualBrowserTabsStore.getState().byDirectory[directory];
    if (!current) return null;
    return {
      version: 2,
      transport: useNativeBrowser ? 'native' : 'host',
      workspaceId: current.workspaceId,
      directory,
      activeTabId: current.activeTabId,
      tabs: current.tabs.map((tab) => ({
        ...tab,
        ...(!useNativeBrowser
          ? { webState: webStatesRef.current.get(tab.id) ?? createWebBrowserSessionState(tab.url, tab.viewportMode) }
          : {}),
      })),
    };
  }, [directory, useNativeBrowser]);

  const sendToPopup = React.useCallback((message: Omit<BrowserWorkspaceMessage, 'source' | 'version' | 'workspaceId'>) => {
    const workspaceId = workspaceIdRef.current;
    if (!workspaceId) return;
    const envelope = createBrowserWorkspaceMessage(workspaceId, message);
    if (channelRef.current) {
      channelRef.current.postMessage(envelope);
      return;
    }
    const popup = popupRef.current;
    if (popup && !popup.closed) popup.postMessage(envelope, window.location.origin);
  }, []);

  const closePopupChannel = React.useCallback(() => {
    channelRef.current?.close();
    channelRef.current = null;
    if (fallbackHandlerRef.current) {
      window.removeEventListener('message', fallbackHandlerRef.current);
      fallbackHandlerRef.current = null;
    }
  }, []);

  const applyDetachedState = React.useCallback((state: BrowserWorkspaceRuntimeState) => {
    if (!workspace || state.workspaceId !== workspace.workspaceId || state.directory !== directory) return;
    replaceWorkspace(directory, {
      workspaceId: state.workspaceId,
      activeTabId: state.activeTabId,
      tabs: state.tabs,
      touchedAt: Date.now(),
    });
    if (!useNativeBrowser) {
      webStatesRef.current = new Map(state.tabs.map((tab) => [
        tab.id,
        normalizeWebBrowserSessionState(tab.webState, tab.url, tab.viewportMode),
      ]));
    }
  }, [directory, replaceWorkspace, useNativeBrowser, workspace]);

  const dock = React.useCallback(() => {
    if (!workspace) return;
    if (useNativeBrowser) {
      void invokeDesktop('desktop_browser_workspace_dock', { workspaceId: workspace.workspaceId }).catch(() => {
        toast.error('Unable to dock Browser');
      });
    } else {
      sendToPopup({ type: 'request-dock' });
      setWebPopped(false);
    }
  }, [sendToPopup, useNativeBrowser, workspace]);

  const handlePopupMessage = React.useCallback((message: BrowserWorkspaceMessage) => {
    if (!workspace) return;
    if (message.type === 'ready') {
      const state = runtimeState();
      if (state) sendToPopup({ type: 'init', state });
    } else if (message.type === 'state' && message.state) {
      applyDetachedState(message.state);
    } else if (message.type === 'add-tab') {
      addTab(directory);
    } else if (message.type === 'activate-tab' && message.tabId) {
      activateTab(directory, message.tabId);
    } else if (message.type === 'close-tab' && message.tabId) {
      closeManualBrowserStripTab(directory, message.tabId);
    } else if (message.type === 'reorder-tabs' && message.tabId && message.overTabId) {
      reorderTabs(directory, message.tabId, message.overTabId);
    } else if (message.type === 'attach-console' && Array.isArray(message.events) && message.events.every(isPreviewConsoleEvent)) {
      attachConsole(message.events, typeof message.pageUrl === 'string' ? message.pageUrl : 'about:blank');
    } else if (message.type === 'attach-annotation' && message.attachment && isPreviewElementMetadata(message.attachment.target)) {
      attachAnnotation(message.attachment);
    } else if (message.type === 'ping') {
      sendToPopup({ type: 'pong' });
    } else if (message.type === 'dock' || message.type === 'closed') {
      if (message.state) applyDetachedState(message.state);
      popupRef.current = null;
      closePopupChannel();
      setWebPopped(false);
    }
  }, [activateTab, addTab, applyDetachedState, attachAnnotation, attachConsole, closePopupChannel, directory, reorderTabs, runtimeState, sendToPopup, workspace]);

  const preparePopupChannel = React.useCallback(() => {
    if (!workspace) return;
    closePopupChannel();
    const channel = typeof BroadcastChannel === 'function'
      ? new BroadcastChannel(`devryan-browser-workspace:${workspace.workspaceId}`)
      : null;
    channelRef.current = channel;
    if (channel) {
      channel.onmessage = (event: MessageEvent) => {
        if (isBrowserWorkspaceMessage(event.data, workspace.workspaceId)) handlePopupMessage(event.data);
      };
    }
    const fallbackHandler = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== popupRef.current) return;
      if (isBrowserWorkspaceMessage(event.data, workspace.workspaceId)) handlePopupMessage(event.data);
    };
    fallbackHandlerRef.current = fallbackHandler;
    window.addEventListener('message', fallbackHandler);
  }, [closePopupChannel, handlePopupMessage, workspace]);

  const popout = React.useCallback(() => {
    if (!workspace) return;
    preparePopupChannel();
    if (useNativeBrowser) {
      void invokeDesktop('desktop_browser_workspace_popout', {
        workspaceId: workspace.workspaceId,
        activeSurfaceId,
      }).catch(() => toast.error('Unable to pop out Browser'));
      return;
    }
    if (isElectronShell()) {
      void invokeDesktop('desktop_browser_host_workspace_popout', {
        workspaceId: workspace.workspaceId,
      }).then(() => setWebPopped(true)).catch(() => {
        closePopupChannel();
        toast.error('Unable to pop out Browser');
      });
      return;
    }
    const popup = window.open(
      `/browser.html?workspaceId=${encodeURIComponent(workspace.workspaceId)}`,
      `devryan-browser-workspace-${workspace.workspaceId}`,
      'popup,width=1180,height=760',
    );
    if (!popup) {
      closePopupChannel();
      toast.error('The browser pop-out was blocked. Allow pop-ups for this site and try again.');
      return;
    }
    popupRef.current = popup;
    setWebPopped(true);
  }, [activeSurfaceId, closePopupChannel, preparePopupChannel, useNativeBrowser, workspace]);

  React.useEffect(() => {
    if (!workspace || !channelRef.current) return;
    const state = runtimeState();
    if (state) sendToPopup({ type: 'state', state });
  }, [runtimeState, sendToPopup, workspace]);

  React.useEffect(() => {
    if (!useNativeBrowser || !workspace || !activeSurfaceId) return;
    void invokeDesktop('desktop_browser_workspace_activate', {
      workspaceId: workspace.workspaceId,
      surfaceId: activeSurfaceId,
    }).catch(() => {});
  }, [activeSurfaceId, useNativeBrowser, workspace]);

  React.useEffect(() => () => {
    sendToPopup({ type: 'close' });
    closePopupChannel();
    const popup = popupRef.current;
    if (popup && !popup.closed) popup.close();
  }, [closePopupChannel, sendToPopup]);

  React.useEffect(() => {
    if (workspace) return;
    const popup = popupRef.current;
    const hasOpenPopup = Boolean(popup && !popup.closed) || webPopped;
    if (!hasOpenPopup) return;
    sendToPopup({ type: 'close' });
    closePopupChannel();
    if (popup && !popup.closed) popup.close();
    popupRef.current = null;
    setWebPopped(false);
  }, [closePopupChannel, sendToPopup, webPopped, workspace]);

  const retainedTabIds = useGuestRetention({
    keepIDs: workspace
      ? (useNativeBrowser && popped ? workspace.tabs.map((tab) => tab.id) : [workspace.activeTabId])
      : [],
    sleepDelayMs: BROWSER_PAGE_SLEEP_DELAY_MS,
  });

  if (!workspace) return null;

  const tabStrip = (
    <BrowserTabsBar
      tabs={workspace.tabs}
      activeTabId={workspace.activeTabId}
      onAdd={() => addTab(directory)}
      onSelect={(tabId) => activateTab(directory, tabId)}
      onClose={(tabId) => closeManualBrowserStripTab(directory, tabId)}
      onReorder={(tabId, overTabId) => reorderTabs(directory, tabId, overTabId)}
    />
  );

  return (
    <div className="absolute inset-0 flex flex-col bg-background" data-manual-browser-workspace={workspace.workspaceId}>
      {showTabStrip ? tabStrip : null}
      <div className="relative min-h-0 flex-1">
        {workspace.tabs.map((tab) => {
          const isActive = active && tab.id === workspace.activeTabId;
          const isMounted = isActive || retainedTabIds.has(tab.id);
          if (!isMounted) return null;
          return (
            <div
              key={tab.id}
              className={cn('absolute inset-0', (!isActive || popped) && 'invisible pointer-events-none')}
              aria-hidden={!isActive || popped}
              data-browser-page-tab={tab.id}
            >
              <DesktopBrowserPane
                initialUrl={tab.url}
                directory={directory}
                tabID={tab.id}
                workspaceId={workspace.workspaceId}
                active={isActive}
                popped={popped}
                viewportMode={tab.viewportMode}
                onViewportModeChange={(mode) => updateTabViewportMode(directory, tab.id, mode)}
                onPopoutOrDock={popout}
                webInitialState={webStatesRef.current.get(tab.id)}
                onWebState={(state) => {
                  webStatesRef.current.set(tab.id, state);
                  updateTabUrl(directory, tab.id, state.displayUrl);
                  updateTabViewportMode(directory, tab.id, state.viewportMode);
                }}
              />
            </div>
          );
        })}
        {popped ? (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background p-6 text-center">
            <RiGlobalLine className="h-12 w-12 text-muted-foreground/50" />
            <span className="typography-ui-header text-foreground">Browser is open in another window</span>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  if (useNativeBrowser) {
                    void invokeDesktop('desktop_browser_workspace_focus_popout', { workspaceId: workspace.workspaceId });
                  } else if (isElectronShell()) {
                    void invokeDesktop('desktop_browser_host_workspace_focus_popout', { workspaceId: workspace.workspaceId });
                  } else {
                    popupRef.current?.focus();
                  }
                }}
              >
                Focus
              </Button>
              <Button type="button" variant="secondary" onClick={dock}>Dock</Button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};

const BrowserWorkspacePopout: React.FC<{ workspaceId: string }> = ({ workspaceId }) => {
  const channelRef = React.useRef<BroadcastChannel | null>(null);
  const openerRef = React.useRef(window.opener);
  const stateRef = React.useRef<BrowserWorkspaceRuntimeState | null>(null);
  const [state, setState] = React.useState<BrowserWorkspaceRuntimeState | null>(null);
  const [connectionLost, setConnectionLost] = React.useState(false);
  const [authVerified, setAuthVerified] = React.useState(false);
  const authIdentityRef = React.useRef<string | null>(null);
  const lastPongAtRef = React.useRef(Date.now());
  const surfaces = useBrowserSurfaceStore((store) => store.byId);
  const browserTransport = state?.transport;
  const useNativeBrowser = isElectronShell() && browserTransport !== 'host';

  const send = React.useCallback((message: Omit<BrowserWorkspaceMessage, 'source' | 'version' | 'workspaceId'>) => {
    const envelope = createBrowserWorkspaceMessage(workspaceId, message);
    if (channelRef.current) {
      channelRef.current.postMessage(envelope);
      return;
    }
    const opener = openerRef.current;
    if (opener && !opener.closed) opener.postMessage(envelope, window.location.origin);
  }, [workspaceId]);

  const applyState = React.useCallback((next: BrowserWorkspaceRuntimeState) => {
    if (next.workspaceId !== workspaceId || next.version !== 2 || !next.directory) return;
    const metadata = sanitizeManualBrowserWorkspace({
      workspaceId: next.workspaceId,
      activeTabId: next.activeTabId,
      tabs: next.tabs,
      touchedAt: Date.now(),
    });
    if (!metadata) return;
    const sourceById = new Map(next.tabs.map((tab) => [tab.id, tab]));
    const normalized: BrowserWorkspaceRuntimeState = {
      version: 2,
      transport: next.transport === 'host' || !isElectronShell() ? 'host' : 'native',
      workspaceId,
      directory: next.directory,
      activeTabId: metadata.activeTabId,
      tabs: metadata.tabs.map((tab) => ({
        ...tab,
        ...(next.transport === 'host' || !isElectronShell()
          ? { webState: normalizeWebBrowserSessionState(sourceById.get(tab.id)?.webState, tab.url, tab.viewportMode) }
          : {}),
      })),
    };
    stateRef.current = normalized;
    setState(normalized);
  }, [workspaceId]);

  React.useEffect(() => {
    ensureBrowserSurfaceListeners();
    const channel = typeof BroadcastChannel === 'function'
      ? new BroadcastChannel(`devryan-browser-workspace:${workspaceId}`)
      : null;
    channelRef.current = channel;
    let initialized = false;
    const receive = (message: BrowserWorkspaceMessage) => {
      if ((message.type === 'init' || message.type === 'state') && message.state) {
        initialized = true;
        lastPongAtRef.current = Date.now();
        applyState(message.state);
      } else if (message.type === 'pong') {
        lastPongAtRef.current = Date.now();
      } else if (message.type === 'request-dock' || message.type === 'close') {
        send({ type: message.type === 'request-dock' ? 'dock' : 'closed', state: stateRef.current ?? undefined });
        window.close();
      }
    };
    if (channel) {
      channel.onmessage = (event: MessageEvent) => {
        if (isBrowserWorkspaceMessage(event.data, workspaceId)) receive(event.data);
      };
    }
    const fallbackHandler = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== openerRef.current) return;
      if (isBrowserWorkspaceMessage(event.data, workspaceId)) receive(event.data);
    };
    window.addEventListener('message', fallbackHandler);
    const readyTimer = window.setInterval(() => {
      if (!initialized) send({ type: 'ready' });
    }, 250);
    send({ type: 'ready' });
    const onBeforeUnload = () => send({ type: 'closed', state: stateRef.current ?? undefined });
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.clearInterval(readyTimer);
      window.removeEventListener('message', fallbackHandler);
      window.removeEventListener('beforeunload', onBeforeUnload);
      channel?.close();
    };
  }, [applyState, send, workspaceId]);

  React.useEffect(() => {
    if (!browserTransport) return;
    if (isElectronShell() && browserTransport !== 'host') {
      setAuthVerified(true);
      return;
    }
    const verifyConnection = async () => {
      const opener = openerRef.current;
      if (!isElectronShell() && (!opener || opener.closed)) {
        setConnectionLost(true);
        return;
      }
      try {
        const response = await fetch('/auth/session', { credentials: 'include', cache: 'no-store' });
        if (!response.ok) {
          setConnectionLost(true);
          return;
        }
        const identity = getAuthenticatedBrowserIdentity(await response.json().catch(() => null));
        if (!identity) {
          setConnectionLost(true);
          return;
        }
        if (authIdentityRef.current === null) {
          authIdentityRef.current = identity;
          setAuthVerified(true);
        } else if (authIdentityRef.current !== identity) {
          setConnectionLost(true);
        }
      } catch {
        setConnectionLost(true);
      }
    };
    void verifyConnection();
    const timer = window.setInterval(() => void verifyConnection(), 15_000);
    return () => window.clearInterval(timer);
  }, [browserTransport]);

  React.useEffect(() => {
    const timer = window.setInterval(() => {
      if (browserTransport === 'host') {
        if (Date.now() - lastPongAtRef.current > 12_000) {
          setConnectionLost(true);
          return;
        }
      } else if (!isElectronShell()) {
        const opener = openerRef.current;
        if (!opener || opener.closed || Date.now() - lastPongAtRef.current > 12_000) {
          setConnectionLost(true);
          return;
        }
      }
      send({ type: 'ping' });
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [browserTransport, send]);

  const updateWebState = React.useCallback((tabId: string, webState: WebBrowserSessionState) => {
    setState((current) => {
      if (!current) return current;
      const tabs = current.tabs.map((tab) => tab.id === tabId
        ? {
          ...tab,
          url: webState.displayUrl,
          label: browserTabLabelForUrl(webState.displayUrl),
          viewportMode: webState.viewportMode,
          webState,
        }
        : tab);
      const next = { ...current, tabs };
      stateRef.current = next;
      send({ type: 'state', state: next });
      return next;
    });
  }, [send]);

  const mutateWebTabs = React.useCallback((action: 'add' | 'activate' | 'close' | 'reorder', tabId?: string, overTabId?: string) => {
    if (useNativeBrowser) {
      if (action === 'add') send({ type: 'add-tab' });
      if (action === 'activate' && tabId) send({ type: 'activate-tab', tabId });
      if (action === 'close' && tabId) send({ type: 'close-tab', tabId });
      if (action === 'reorder' && tabId && overTabId) send({ type: 'reorder-tabs', tabId, overTabId });
      return;
    }
    setState((current) => {
      if (!current) return current;
      let next = current;
      if (action === 'add') {
        const id = `browser-tab:${randomSurfaceId()}`;
        const webState = createWebBrowserSessionState('about:blank');
        next = {
          ...current,
          activeTabId: id,
          tabs: [...current.tabs, {
            id,
            url: 'about:blank',
            label: 'New tab',
            viewportMode: 'responsive',
            webState,
          }],
        };
      } else if (action === 'activate' && tabId && current.tabs.some((tab) => tab.id === tabId)) {
        next = { ...current, activeTabId: tabId };
      } else if (action === 'close' && tabId) {
        const index = current.tabs.findIndex((tab) => tab.id === tabId);
        if (index !== -1 && current.tabs.length === 1) {
          send({ type: 'close-tab', tabId });
          window.close();
          return current;
        }
        if (index !== -1) {
          const tabs = current.tabs.filter((tab) => tab.id !== tabId);
          next = {
            ...current,
            tabs,
            activeTabId: current.activeTabId === tabId
              ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? tabs[0]!.id)
              : current.activeTabId,
          };
        }
      } else if (action === 'reorder' && tabId && overTabId) {
        const from = current.tabs.findIndex((tab) => tab.id === tabId);
        const to = current.tabs.findIndex((tab) => tab.id === overTabId);
        if (from !== -1 && to !== -1) {
          const tabs = [...current.tabs];
          const [moved] = tabs.splice(from, 1);
          if (moved) tabs.splice(to, 0, moved);
          next = { ...current, tabs };
        }
      }
      stateRef.current = next;
      send({ type: 'state', state: next });
      return next;
    });
  }, [send, useNativeBrowser]);

  const handleActiveWebState = React.useCallback((webState: WebBrowserSessionState) => {
    const activeTabId = stateRef.current?.activeTabId;
    if (activeTabId) updateWebState(activeTabId, webState);
  }, [updateWebState]);

  React.useEffect(() => {
    if (!useNativeBrowser || !state?.activeTabId) return;
    void invokeDesktop<unknown>('desktop_browser_workspace_activate', {
      workspaceId,
      tabId: state.activeTabId,
    }).then((value) => {
      useBrowserSurfaceStore.getState().applySnapshot(value, state.activeTabId);
    }).catch(() => {});
  }, [state?.activeTabId, useNativeBrowser, workspaceId]);

  if (connectionLost) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-background p-6 text-center text-foreground">
        <span className="typography-ui-header">The DevRyan session or opener is no longer available.</span>
        <Button type="button" variant="secondary" onClick={() => window.close()}>Close Browser</Button>
      </div>
    );
  }
  if (!authVerified || !state) {
    return <div className="flex h-screen items-center justify-center bg-background text-muted-foreground">Connecting browser workspace…</div>;
  }

  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0];
  if (!activeTab) return null;
  const activeSurface = Array.from(surfaces.values()).find((surface) => (
    surface.kind === 'manual'
    && surface.workspaceId === workspaceId
    && surface.tabId === activeTab.id
  )) ?? null;

  return (
    <div className="flex h-screen flex-col bg-background">
      <BrowserTabsBar
        tabs={state.tabs}
        activeTabId={activeTab.id}
        nativeTitlebar={isElectronShell()}
        onAdd={() => mutateWebTabs('add')}
        onSelect={(tabId) => mutateWebTabs('activate', tabId)}
        onClose={(tabId) => mutateWebTabs('close', tabId)}
        onReorder={(tabId, overTabId) => mutateWebTabs('reorder', tabId, overTabId)}
      />
      <div className="relative min-h-0 flex-1">
        {useNativeBrowser ? (
          activeSurface ? (
            <ElectronBrowserWorkspaceToolbar
              surface={activeSurface}
              onDock={() => {
                send({ type: 'dock', state: stateRef.current ?? undefined });
                void invokeDesktop('desktop_browser_workspace_dock', { workspaceId });
              }}
            />
          ) : <div className="h-[38px] border-b border-border/40 bg-[var(--surface-background)]" />
        ) : (
          <WebBrowserSurface
            key={activeTab.id}
            initialState={normalizeWebBrowserSessionState(activeTab.webState, activeTab.url)}
            directory={state.directory}
            active
            popped
            onState={handleActiveWebState}
            onAttachConsole={(events, pageUrl) => send({ type: 'attach-console', events, pageUrl })}
            onAttachAnnotation={(attachment) => send({ type: 'attach-annotation', attachment })}
            onPopoutOrDock={() => {
              send({ type: 'dock', state: stateRef.current ?? undefined });
              window.close();
            }}
          />
        )}
      </div>
    </div>
  );
};

const ElectronBrowserWorkspaceToolbar: React.FC<{
  surface: BrowserSurfaceSnapshot;
  onDock: () => void;
}> = ({ surface, onDock }) => {
  const [urlInput, setUrlInput] = React.useState(formatBrowserAddress(surface.url));
  React.useEffect(() => setUrlInput(formatBrowserAddress(surface.url)), [surface.url]);
  const command = (action: string, url?: string) => {
    void invokeDesktop<unknown>('desktop_browser_surface_command', {
      surfaceId: surface.surfaceId,
      action,
      ...(url ? { url: normalizeBrowserUrl(url) } : {}),
    }).then((value) => useBrowserSurfaceStore.getState().applySnapshot(value)).catch(() => {});
  };
  return (
    <BrowserToolbar
      snapshot={surface}
      urlInput={urlInput}
      viewportMode={surface.viewportMode}
      popped
      supportsDevTools
      onUrlInput={setUrlInput}
      onNavigate={(url) => command('navigate', url)}
      onBack={() => command('back')}
      onForward={() => command('forward')}
      onReload={() => command('reload')}
      onToggleDevTools={() => void invokeDesktop('desktop_browser_devtools_set_open', {
        surfaceId: surface.surfaceId,
        open: !surface.devToolsOpen,
        bounds: { x: 0, y: Math.max(70, window.innerHeight - 300), width: window.innerWidth, height: 300 },
      })}
      onPopoutOrDock={onDock}
      onViewportModeChange={(viewportMode) => {
        void invokeDesktop<unknown>('desktop_browser_surface_set_viewport_mode', {
          surfaceId: surface.surfaceId,
          viewportMode,
        }).then((value) => useBrowserSurfaceStore.getState().applySnapshot(value)).catch(() => {});
      }}
    />
  );
};

export const BrowserPopoutApp: React.FC = () => {
  useAppFontEffects();
  const surfaceId = React.useMemo(() => new URLSearchParams(window.location.search).get('surfaceId') ?? '', []);
  const workspaceId = React.useMemo(() => new URLSearchParams(window.location.search).get('workspaceId') ?? '', []);
  if (workspaceId) return <BrowserWorkspacePopout workspaceId={workspaceId} />;
  if (!surfaceId) {
    return <div className="flex h-screen items-center justify-center bg-background text-foreground">Missing browser surface.</div>;
  }
  if (isElectronShell()) return <ElectronBrowserPopout surfaceId={surfaceId} />;
  if (!isStandaloneWebRuntime()) {
    return <div className="flex h-screen items-center justify-center bg-background text-foreground">Browser pop-outs are unavailable in this runtime.</div>;
  }
  return <WebBrowserPopout surfaceId={surfaceId} />;
};

const ElectronBrowserPopout: React.FC<{ surfaceId: string }> = ({ surfaceId }) => {
  const [urlInput, setUrlInput] = React.useState('');
  const snapshot = useBrowserSurfaceStore((state) => state.byId.get(surfaceId) ?? null);
  React.useEffect(() => {
    ensureBrowserSurfaceListeners();
    void invokeDesktop<unknown>('desktop_browser_surface_snapshot', { surfaceId })
      .then((value) => useBrowserSurfaceStore.getState().applySnapshot(value))
      .catch(() => {});
  }, [surfaceId]);
  React.useEffect(() => setUrlInput(formatBrowserAddress(snapshot?.url ?? 'about:blank')), [snapshot?.url]);
  if (!snapshot) return <div className="h-[38px] border-b border-border/40 bg-[var(--surface-background)]" />;
  const command = (action: string, url?: string) => {
    void invokeDesktop<unknown>('desktop_browser_surface_command', { surfaceId, action, ...(url ? { url: normalizeBrowserUrl(url) } : {}) })
      .then((value) => useBrowserSurfaceStore.getState().applySnapshot(value))
      .catch(() => {});
  };
  return (
    <div className="h-screen bg-background">
      <BrowserToolbar
        snapshot={snapshot}
        urlInput={urlInput}
        viewportMode={snapshot.viewportMode}
        popped
        nativeTitlebar
        supportsDevTools
        onUrlInput={setUrlInput}
        onNavigate={(url) => command('navigate', url)}
        onBack={() => command('back')}
        onForward={() => command('forward')}
        onReload={() => command('reload')}
        onToggleDevTools={() => void invokeDesktop('desktop_browser_devtools_set_open', {
          surfaceId,
          open: !snapshot.devToolsOpen,
          bounds: { x: 0, y: Math.max(38, window.innerHeight - 300), width: window.innerWidth, height: 300 },
        })}
        onPopoutOrDock={() => void invokeDesktop('desktop_browser_surface_dock', { surfaceId })}
        onViewportModeChange={(viewportMode) => {
          void invokeDesktop<unknown>('desktop_browser_surface_set_viewport_mode', {
            surfaceId,
            viewportMode,
          }).then((value) => useBrowserSurfaceStore.getState().applySnapshot(value)).catch(() => {});
        }}
      />
    </div>
  );
};

const WebBrowserPopout: React.FC<{ surfaceId: string }> = ({ surfaceId }) => {
  const channelRef = React.useRef<BroadcastChannel | null>(null);
  const stateRef = React.useRef<WebBrowserSessionState | null>(null);
  const [initialState, setInitialState] = React.useState<WebBrowserSessionState | null>(null);
  const [directory, setDirectory] = React.useState('');
  const [connectionLost, setConnectionLost] = React.useState(false);
  const [authVerified, setAuthVerified] = React.useState(false);
  const openerRef = React.useRef(window.opener);
  const authIdentityRef = React.useRef<string | null>(null);
  const lastOpenerPongAtRef = React.useRef(Date.now());

  const send = React.useCallback((message: Omit<BrowserSurfaceMessage, 'source' | 'version' | 'surfaceId'>) => {
    const envelope = createBrowserSurfaceMessage(surfaceId, message);
    if (channelRef.current) {
      channelRef.current.postMessage(envelope);
      return;
    }
    const opener = openerRef.current;
    if (opener && !opener.closed) opener.postMessage(envelope, window.location.origin);
  }, [surfaceId]);

  React.useEffect(() => {
    const channel = typeof BroadcastChannel === 'function'
      ? new BroadcastChannel(`devryan-browser-surface:${surfaceId}`)
      : null;
    channelRef.current = channel;
    let initialized = false;
    let readyInterval = 0;
    const receive = (message: BrowserSurfaceMessage) => {
      if (message.type === 'init' && message.state && typeof message.directory === 'string') {
        initialized = true;
        lastOpenerPongAtRef.current = Date.now();
        if (readyInterval) window.clearInterval(readyInterval);
        const next = normalizeWebBrowserSessionState(message.state);
        stateRef.current = next;
        setInitialState(next);
        setDirectory(message.directory);
      }
      if (message.type === 'pong') lastOpenerPongAtRef.current = Date.now();
      if (message.type === 'request-dock') {
        send({ type: 'dock', state: stateRef.current ?? undefined });
        window.close();
      }
      if (message.type === 'close') window.close();
    };
    if (channel) {
      channel.onmessage = (event: MessageEvent) => {
        if (isBrowserSurfaceMessage(event.data, surfaceId)) receive(event.data);
      };
    }
    const fallbackHandler = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== openerRef.current) return;
      if (isBrowserSurfaceMessage(event.data, surfaceId)) receive(event.data);
    };
    window.addEventListener('message', fallbackHandler);
    const announceReady = () => {
      if (!initialized) send({ type: 'ready' });
    };
    announceReady();
    readyInterval = window.setInterval(announceReady, 250);
    const onBeforeUnload = () => send({ type: 'closed', state: stateRef.current ?? undefined });
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('message', fallbackHandler);
      window.clearInterval(readyInterval);
      channel?.close();
    };
  }, [send, surfaceId]);

  React.useEffect(() => {
    const verifyConnection = async () => {
      const opener = openerRef.current;
      if (!opener || opener.closed) {
        setConnectionLost(true);
        return;
      }
      try {
        const response = await fetch('/auth/session', { credentials: 'include', cache: 'no-store' });
        if (!response.ok) {
          setConnectionLost(true);
          return;
        }
        const identity = getAuthenticatedBrowserIdentity(await response.json().catch(() => null));
        if (!identity) {
          setConnectionLost(true);
          return;
        }
        if (authIdentityRef.current === null) {
          authIdentityRef.current = identity;
          setAuthVerified(true);
        } else if (authIdentityRef.current !== identity) {
          setConnectionLost(true);
        }
      } catch {
        setConnectionLost(true);
      }
    };
    void verifyConnection();
    const interval = window.setInterval(() => { void verifyConnection(); }, 15_000);
    return () => window.clearInterval(interval);
  }, []);

  React.useEffect(() => {
    const interval = window.setInterval(() => {
      const opener = openerRef.current;
      if (!opener || opener.closed || Date.now() - lastOpenerPongAtRef.current > 12_000) {
        setConnectionLost(true);
        return;
      }
      send({ type: 'ping' });
    }, 3_000);
    return () => window.clearInterval(interval);
  }, [send]);

  if (connectionLost) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-background p-6 text-center text-foreground">
        <span className="typography-ui-header">The DevRyan session or opener is no longer available.</span>
        <Button type="button" variant="secondary" onClick={() => window.close()}>Close Browser</Button>
      </div>
    );
  }
  if (!authVerified || initialState === null) {
    return <div className="flex h-screen items-center justify-center bg-background text-muted-foreground">Connecting browser surface…</div>;
  }
  return (
    <WebBrowserSurface
      initialState={initialState}
      directory={directory}
      active
      popped
      onState={(state) => {
        stateRef.current = state;
        send({ type: 'state', state });
      }}
      onAttachConsole={(events, pageUrl) => send({ type: 'attach-console', events, pageUrl })}
      onAttachAnnotation={(attachment) => send({ type: 'attach-annotation', attachment })}
      onPopoutOrDock={() => {
        send({ type: 'dock', state: stateRef.current ?? undefined });
        window.close();
      }}
    />
  );
};

export const DesktopBrowserPane: React.FC<DesktopBrowserPaneProps> = (props) => {
  if (isElectronShell()) return <ElectronBrowserPane {...props} />;
  if (isStandaloneWebRuntime() && props.workspaceId) return <WebBrowserWorkspacePage {...props} />;
  if (isStandaloneWebRuntime()) return <WebBrowserPane {...props} />;
  return null;
};
