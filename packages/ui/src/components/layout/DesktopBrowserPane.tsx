import React from 'react';
import {
  RiArrowLeftLine,
  RiArrowRightLine,
  RiCodeSSlashLine,
  RiCursorLine,
  RiExternalLinkLine,
  RiGlobalLine,
  RiPictureInPicture2Line,
  RiPictureInPictureExitLine,
  RiPlayLine,
  RiRefreshLine,
  RiServerLine,
  RiTerminalBoxLine,
} from '@remixicon/react';

import { useAppFontEffects } from '@/apps/useAppFontEffects';
import { Button } from '@/components/ui/button';
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
import { useBrowserAgentStore, browserAgentLeaseSelectors } from '@/stores/useBrowserAgentStore';
import {
  createDesktopBrowserSurface,
  ensureBrowserSurfaceListeners,
  useBrowserSurfaceStore,
  type BrowserSurfaceSnapshot,
} from '@/stores/useBrowserSurfaceStore';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { useUIStore } from '@/stores/useUIStore';
import { useInputStore } from '@/sync/input-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import {
  formatBrowserAddress,
  normalizeBrowserUrl,
  reconcileWebBrowserDisplayUrl,
  sanitizeWebBrowserDisplayUrl,
} from './browserUrl';
import {
  useLocalPreviewInstances,
  useReachableLocalPreviewInstances,
} from './localPreviewInstances';
import { isPreviewLoopbackHost, parsePreviewHttpUrl } from './previewLifecycle';
import {
  usePreviewDiagnostics,
  type PreviewAnnotationAttachment,
} from './previewDiagnostics';
import { PreviewConsolePanel } from './PreviewConsolePanel';
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
};

type BrowserToolbarProps = {
  snapshot: Pick<BrowserSurfaceSnapshot, 'loading' | 'canGoBack' | 'canGoForward' | 'devToolsOpen'>;
  urlInput: string;
  currentUrl: string;
  popped: boolean;
  supportsDevTools?: boolean;
  supportsInspect?: boolean;
  showWebDiagnostics?: boolean;
  webDiagnosticsEnabled?: boolean;
  webDiagnosticsDisabledReason?: string;
  consoleOpen?: boolean;
  consoleErrorCount?: number;
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
};

const BROWSER_TOOLBAR_BUTTON_CLASS = 'size-7 p-0 leading-none';
const BROWSER_TOOLBAR_ICON_CLASS = 'size-3.5';

const BrowserToolbar: React.FC<BrowserToolbarProps> = ({
  snapshot,
  urlInput,
  currentUrl,
  popped,
  supportsDevTools = false,
  supportsInspect = false,
  showWebDiagnostics = false,
  webDiagnosticsEnabled = false,
  webDiagnosticsDisabledReason,
  consoleOpen = false,
  consoleErrorCount = 0,
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
}) => {
  const { t } = useI18n();
  const reserveMacTrafficLights = nativeTitlebar
    && typeof navigator !== 'undefined'
    && /Macintosh|Mac OS X/.test(navigator.userAgent || '');
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
          <span className="relative inline-flex">
            <RiTerminalBoxLine className={BROWSER_TOOLBAR_ICON_CLASS} />
            {consoleErrorCount > 0 ? (
              <span className="absolute -right-1.5 -top-1.5 min-w-3 rounded-full bg-status-error px-0.5 text-[8px] leading-3 text-white">
                {Math.min(consoleErrorCount, 99)}
              </span>
            ) : null}
          </span>
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
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={BROWSER_TOOLBAR_BUTTON_CLASS}
        disabled={!currentUrl || currentUrl === 'about:blank'}
        aria-label={t('contextPanel.preview.actions.openExternal')}
        title="Open in Regular Browser"
        onClick={() => void openExternalUrl(currentUrl)}
      >
        <RiExternalLinkLine className={BROWSER_TOOLBAR_ICON_CLASS} />
      </Button>
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
  const candidates = useLocalPreviewInstances(directory, t('contextPanel.browser.localInstanceFallback'));
  const reachable = useReachableLocalPreviewInstances(candidates, active && !loading, directory);
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
}) => {
  const { t } = useI18n();
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const [manualSurfaceId, setManualSurfaceId] = React.useState('');
  const [urlInput, setUrlInput] = React.useState(formatBrowserAddress(normalizeBrowserUrl(initialUrl)));
  const [inspecting, setInspecting] = React.useState(false);
  const [devToolsHeight, setDevToolsHeight] = React.useState(DEFAULT_DEVTOOLS_HEIGHT);
  const leaseSelector = React.useMemo(() => browserAgentLeaseSelectors.lease(leaseId ?? ''), [leaseId]);
  const lease = useBrowserAgentStore(leaseSelector);
  const surfaceId = leaseId ? (lease?.surfaceId ?? '') : manualSurfaceId;
  const snapshot = useBrowserSurfaceStore((state) => surfaceId ? state.byId.get(surfaceId) ?? null : null);
  const setContextPanelTabTargetPath = useUIStore((state) => state.setContextPanelTabTargetPath);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentDraftId = useSessionUIStore((state) => state.currentDraftId);
  const newSessionDraftOpen = useSessionUIStore((state) => Boolean(state.currentDraftId && state.newSessionDraft?.open));
  const addInlineCommentDraft = useInlineCommentDraftStore((state) => state.addDraft);
  const addAttachedFile = useInputStore((state) => state.addAttachedFile);
  const currentUrl = snapshot?.url ?? normalizeBrowserUrl(initialUrl);
  const isBlank = currentUrl === 'about:blank';
  const popped = snapshot?.placement === 'popout';

  React.useEffect(() => {
    ensureBrowserSurfaceListeners();
    if (leaseId) return;
    let cancelled = false;
    void createDesktopBrowserSurface(tabID, normalizeBrowserUrl(initialUrl))
      .then((created) => {
        if (!cancelled && created) setManualSurfaceId(created.surfaceId);
      })
      .catch(() => {
        if (!cancelled) toast.error(t('contextPanel.browser.openFailed'));
      });
    return () => { cancelled = true; };
  }, [initialUrl, leaseId, t, tabID]);

  React.useEffect(() => {
    if (!surfaceId) return;
    void invokeDesktop<unknown>('desktop_browser_surface_snapshot', { surfaceId })
      .then((value) => useBrowserSurfaceStore.getState().applySnapshot(value, leaseId ? undefined : tabID))
      .catch(() => {});
  }, [leaseId, surfaceId, tabID]);

  React.useEffect(() => {
    setUrlInput(formatBrowserAddress(currentUrl));
    if (!leaseId && currentUrl !== 'about:blank') {
      setContextPanelTabTargetPath(directory, tabID, currentUrl);
    }
  }, [currentUrl, directory, leaseId, setContextPanelTabTargetPath, tabID]);

  const syncLayout = React.useCallback(() => {
    if (!surfaceId || !contentRef.current) return;
    const rect = contentRef.current.getBoundingClientRect();
    const visible = active && !popped && !isBlank && rect.width > 0 && rect.height > 0;
    const height = snapshot?.devToolsOpen
      ? Math.max(MIN_BROWSER_HEIGHT, rect.height - devToolsHeight)
      : rect.height;
    void invokeDesktop('desktop_browser_surface_layout', {
      surfaceId,
      visible,
      bounds: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(height)),
      },
    }).catch(() => {});
    if (snapshot?.devToolsOpen && !popped) {
      const dockHeight = Math.min(devToolsHeight, Math.max(180, rect.height - MIN_BROWSER_HEIGHT));
      void invokeDesktop('desktop_browser_devtools_set_open', {
        surfaceId,
        open: true,
        bounds: {
          x: Math.round(rect.left),
          y: Math.round(rect.bottom - dockHeight),
          width: Math.max(1, Math.round(rect.width)),
          height: Math.max(1, Math.round(dockHeight)),
        },
      }).catch(() => {});
    }
  }, [active, devToolsHeight, isBlank, popped, snapshot?.devToolsOpen, surfaceId]);

  React.useLayoutEffect(() => {
    syncLayout();
    const content = contentRef.current;
    if (!content) return;
    const observer = new ResizeObserver(syncLayout);
    observer.observe(content);
    window.addEventListener('resize', syncLayout);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', syncLayout);
      if (surfaceId) void invokeDesktop('desktop_browser_surface_layout', { surfaceId, visible: false }).catch(() => {});
    };
  }, [surfaceId, syncLayout]);

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
    const height = Math.min(devToolsHeight, Math.max(180, rect.height - MIN_BROWSER_HEIGHT));
    void invokeDesktop<unknown>('desktop_browser_devtools_set_open', {
      surfaceId,
      open: !snapshot?.devToolsOpen,
      bounds: {
        x: Math.round(rect.left),
        y: Math.round(rect.bottom - height),
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(height)),
      },
    }).then((value) => {
      if (value && snapshot) {
        useBrowserSurfaceStore.getState().applySnapshot({ ...snapshot, devToolsOpen: (value as { open?: boolean }).open === true });
      }
    }).catch(() => toast.error(t('contextPanel.browser.devtoolsUnavailable')));
  }, [devToolsHeight, snapshot, surfaceId, t]);

  const inspect = React.useCallback(() => {
    if (!surfaceId) return;
    if (inspecting) {
      setInspecting(false);
      void invokeDesktop('desktop_browser_surface_inspect', { surfaceId, cancel: true }).catch(() => {});
      return;
    }
    setInspecting(true);
    void invokeDesktop<unknown>('desktop_browser_surface_inspect', { surfaceId })
      .then(async (target) => {
        setInspecting(false);
        if (!isPreviewElementMetadata(target)) return;
        const sessionKey = currentSessionId ?? (currentDraftId ? `draft:${currentDraftId}` : newSessionDraftOpen ? 'draft' : null);
        if (!sessionKey) {
          toast.error(t('contextPanel.preview.inspect.attachNoSession'));
          return;
        }
        const capture = await invokeDesktop<{
          base64: string;
          width: number;
          height: number;
          cssWidth: number;
          cssHeight: number;
        }>('desktop_browser_capture_page', { surfaceId });
        let screenshotAttached = false;
        if (capture) {
          const file = await desktopAnnotationToFile(
            capture.base64,
            capture.width,
            capture.height,
            capture.cssWidth,
            capture.cssHeight,
            target,
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
            devicePixelRatio: window.devicePixelRatio || 1,
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
    if (!surfaceId) return;
    const commandName = popped ? 'desktop_browser_surface_dock' : 'desktop_browser_surface_popout';
    void invokeDesktop<unknown>(commandName, { surfaceId })
      .then((value) => useBrowserSurfaceStore.getState().applySnapshot(value, leaseId ? undefined : tabID))
      .catch(() => toast.error('Unable to change browser placement'));
  }, [leaseId, popped, surfaceId, tabID]);

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
        currentUrl={currentUrl}
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

type ProxyState = { base: string; loading: boolean; error: string };

export type WebBrowserSessionState = {
  version: 1;
  displayUrl: string;
  history: string[];
  historyIndex: number;
  diagnostics: PreviewDiagnosticsState;
  proxyTargets: Record<string, { proxyBasePath: string; expiresAt: number }>;
};

const createWebBrowserSessionState = (initialUrl: string): WebBrowserSessionState => {
  const displayUrl = sanitizeWebBrowserDisplayUrl(initialUrl);
  return {
    version: 1,
    displayUrl,
    history: [displayUrl],
    historyIndex: 0,
    diagnostics: createEmptyPreviewDiagnosticsState(),
    proxyTargets: {},
  };
};

const normalizeWebBrowserSessionState = (value: unknown, fallbackUrl = 'about:blank'): WebBrowserSessionState => {
  if (!value || typeof value !== 'object') return createWebBrowserSessionState(fallbackUrl);
  const candidate = value as Partial<WebBrowserSessionState>;
  const history = Array.isArray(candidate.history)
    ? candidate.history
      .filter((entry): entry is string => typeof entry === 'string')
      .slice(-100)
      .map(sanitizeWebBrowserDisplayUrl)
    : [];
  if (history.length === 0) return createWebBrowserSessionState(fallbackUrl);
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
  const target = parsed?.toString() ?? '';
  const loopback = Boolean(parsed && isPreviewLoopbackHost(parsed.hostname));
  const origin = parsed?.origin ?? '';
  const [registrationNonce, bumpRegistration] = React.useReducer((value: number) => value + 1, 0);
  const [state, setState] = React.useState<ProxyState>({ base: '', loading: loopback, error: '' });
  React.useEffect(() => {
    if (!target || !loopback) {
      setState({ base: '', loading: false, error: '' });
      return;
    }
    const knownTarget = knownTargets[origin];
    if (knownTarget && knownTarget.expiresAt - Date.now() > 30_000) {
      setState({ base: knownTarget.proxyBasePath, loading: false, error: '' });
      const refreshIn = Math.max(1_000, knownTarget.expiresAt - Date.now() - 30_000);
      const timer = window.setTimeout(bumpRegistration, refreshIn);
      return () => window.clearTimeout(timer);
    }
    let cancelled = false;
    setState({ base: '', loading: true, error: '' });
    void (async () => {
      let lastError = 'Failed to register project preview';
      for (let attempt = 0; attempt < 12 && !cancelled; attempt += 1) {
        const response = await fetch('/api/preview/targets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-DevRyan-CSRF': '1' },
          credentials: 'include',
          cache: 'no-store',
          body: JSON.stringify({ url: target, directory }),
        });
        const body = await response.json().catch(() => ({})) as { proxyBasePath?: unknown; expiresAt?: unknown; error?: unknown };
        if (response.ok && typeof body.proxyBasePath === 'string' && typeof body.expiresAt === 'number') {
          onTarget(origin, { proxyBasePath: body.proxyBasePath, expiresAt: body.expiresAt });
          if (!cancelled) setState({ base: body.proxyBasePath, loading: false, error: '' });
          return;
        }
        lastError = typeof body.error === 'string' ? body.error : `HTTP ${response.status}`;
        if (response.status !== 403 || attempt === 11) break;
        await new Promise<void>((resolve) => window.setTimeout(resolve, 300));
      }
      throw new Error(lastError);
    })().catch((error) => {
      if (!cancelled) setState({ base: '', loading: false, error: error instanceof Error ? error.message : String(error) });
    });
    return () => { cancelled = true; };
  }, [directory, knownTargets, loopback, onTarget, origin, registrationNonce, target]);

  if (!target || url === 'about:blank') return { ...state, src: '', routed: false };
  if (!loopback) return { ...state, src: target, routed: false };
  if (!state.base || !parsed) return { ...state, src: '', routed: true };
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
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const iframeRef = React.useRef<HTMLIFrameElement | null>(null);
  const pendingNavigationRef = React.useRef<string | null>(null);
  const normalizedInitialState = React.useRef(normalizeWebBrowserSessionState(initialState));
  const [history, setHistory] = React.useState(normalizedInitialState.current.history);
  const [historyIndex, setHistoryIndex] = React.useState(normalizedInitialState.current.historyIndex);
  const [frameTargetUrl, setFrameTargetUrl] = React.useState(normalizedInitialState.current.displayUrl);
  const [proxyTargets, setProxyTargets] = React.useState(normalizedInitialState.current.proxyTargets);
  const [urlInput, setUrlInput] = React.useState(formatBrowserAddress(normalizedInitialState.current.displayUrl));
  const [reloadKey, setReloadKey] = React.useState(0);
  const [navigationKey, bumpNavigationKey] = React.useReducer((value: number) => value + 1, 0);
  const [frameLoaded, setFrameLoaded] = React.useState(false);
  const currentUrl = history[historyIndex] ?? 'about:blank';
  const previewCandidates = useLocalPreviewInstances(directory, t('contextPanel.browser.localInstanceFallback'));
  useReachableLocalPreviewInstances(previewCandidates, active && currentUrl !== 'about:blank', directory);
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
  const loading = frame.loading || (currentUrl !== 'about:blank' && !frameLoaded && !frame.error);

  const navigate = React.useCallback((value: string) => {
    const next = sanitizeWebBrowserDisplayUrl(value);
    pendingNavigationRef.current = next;
    setHistory((current) => [...current.slice(0, historyIndex + 1), next]);
    setHistoryIndex(historyIndex + 1);
    setFrameTargetUrl(next);
    setFrameLoaded(false);
    setUrlInput(formatBrowserAddress(next));
  }, [historyIndex]);

  const diagnostics = usePreviewDiagnostics({
    iframeRef,
    enabled: frame.routed,
    frameKey: `${frameTargetUrl}:${reloadKey}:${navigationKey}`,
    pageUrl: currentUrl,
    colorScheme: currentTheme.metadata.variant,
    initialState: normalizedInitialState.current.diagnostics,
    onDisplayNavigate: (value, reason) => {
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
      bumpNavigationKey();
      setUrlInput(formatBrowserAddress(next));
    },
    onTargetNavigate: navigate,
    onAttachConsole,
    onAttachAnnotation,
  });

  React.useEffect(() => {
    onState?.({
      version: 1,
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
  ]);

  const diagnosticsEnabled = frame.routed && diagnostics.bridgeReady;
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
        currentUrl={currentUrl}
        popped={popped}
        showWebDiagnostics
        webDiagnosticsEnabled={diagnosticsEnabled}
        webDiagnosticsDisabledReason={diagnosticsDisabledReason}
        consoleOpen={diagnostics.consoleOpen}
        consoleErrorCount={diagnostics.consoleErrorCount}
        inspecting={diagnostics.inspectMode}
        onUrlInput={setUrlInput}
        onNavigate={navigate}
        onBack={() => {
          const next = Math.max(0, historyIndex - 1);
          pendingNavigationRef.current = history[next];
          setHistoryIndex(next);
          setFrameTargetUrl(history[next]);
          setFrameLoaded(false);
          setUrlInput(formatBrowserAddress(history[next]));
        }}
        onForward={() => {
          const next = Math.min(history.length - 1, historyIndex + 1);
          pendingNavigationRef.current = history[next];
          setHistoryIndex(next);
          setFrameTargetUrl(history[next]);
          setFrameLoaded(false);
          setUrlInput(formatBrowserAddress(history[next]));
        }}
        onReload={() => {
          pendingNavigationRef.current = currentUrl;
          setFrameTargetUrl(currentUrl);
          setFrameLoaded(false);
          setReloadKey((value) => value + 1);
        }}
        onToggleConsole={() => diagnostics.setConsoleOpen((value) => !value)}
        onInspect={() => diagnostics.setInspectMode((value) => !value)}
        onPopoutOrDock={onPopoutOrDock}
      />
      <div className="relative min-h-0 flex-1">
        {currentUrl === 'about:blank' ? (
          <EmptyBrowserState directory={directory} active={active} loading={loading} onNavigate={navigate} />
        ) : frame.src ? (
          <iframe
            ref={iframeRef}
            key={`${frame.src}:${reloadKey}`}
            src={frame.src}
            title="Browser"
            className="h-full w-full border-0 bg-background"
            sandbox={frame.routed
              ? 'allow-downloads allow-forms allow-modals allow-pointer-lock allow-popups allow-same-origin allow-scripts'
              : 'allow-forms allow-modals allow-popups allow-scripts'}
            referrerPolicy="strict-origin-when-cross-origin"
            onLoad={() => setFrameLoaded(true)}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center p-6 text-center typography-micro text-muted-foreground">
            {frame.error || 'Loading local page…'}
          </div>
        )}
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
  const principalId = (session.principal as { id?: unknown }).id;
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
  const previewCandidates = useLocalPreviewInstances(directory, 'Local app');
  // The pop-out intentionally has a narrow provider root and no terminal
  // store hydration. Keep its source grants alive in the authenticated opener
  // while the detached surface owns navigation and diagnostics state.
  useReachableLocalPreviewInstances(previewCandidates, placement === 'popout', directory);

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

export const BrowserPopoutApp: React.FC = () => {
  useAppFontEffects();
  const surfaceId = React.useMemo(() => new URLSearchParams(window.location.search).get('surfaceId') ?? '', []);
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
        currentUrl={snapshot.url}
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
  if (initialState === null) {
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
  if (isStandaloneWebRuntime()) return <WebBrowserPane {...props} />;
  return null;
};
