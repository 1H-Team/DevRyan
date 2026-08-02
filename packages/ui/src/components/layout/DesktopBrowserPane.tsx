import React from 'react';
import { RiArrowLeftLine, RiArrowRightLine, RiCodeSSlashLine, RiCursorLine, RiExternalLinkLine, RiGlobalLine, RiPlayLine, RiRefreshLine, RiServerLine } from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { openExternalUrl } from '@/lib/url';
import { invokeDesktop } from '@/lib/desktop';
import {
  desktopAnnotationToFile,
  formatPreviewAnnotationMarkdown,
  isPreviewElementMetadata,
} from '@/lib/preview/screenshot-capture';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { useInputStore } from '@/sync/input-store';
import { browserAgentLeaseSelectors, useBrowserAgentStore } from '@/stores/useBrowserAgentStore';
import { formatBrowserAddress, normalizeBrowserUrl } from './browserUrl';
import { BrowserAgentCursor } from './BrowserAgentCursor';
import {
  useLocalPreviewInstances,
  useReachableLocalPreviewInstances,
} from './localPreviewInstances';

// Electron <webview> guest surface for the context panel's browser tab.
// Desktop-only: the host window opts into webviewTag, and the main process
// hardens every guest (will-attach-webview strips preload/nodeIntegration and
// pins the partition; popups are contained via setWindowOpenHandler; the
// partition denies permission prompts and downloads). The pane itself never
// relies on those in-page scripts for security — they are UX only.

// React's JSX types already declare <webview> (WebViewHTMLAttributes /
// HTMLWebViewElement); this extends the element with the Electron guest
// methods the pane calls, all optional because they only exist once the
// guest has attached.
type WebviewElement = HTMLElement & {
  src: string;
  getURL?: () => string;
  loadURL?: (url: string) => Promise<void> | void;
  goBack?: () => void;
  goForward?: () => void;
  reload?: () => void;
  isLoading?: () => boolean;
  getWebContentsId?: () => number;
  isDevToolsOpened?: () => boolean;
  executeJavaScript?: (code: string, userGesture?: boolean) => Promise<unknown>;
};

const DESKTOP_BROWSER_INSPECT_SCRIPT = `new Promise((resolve) => {
  const existing = document.getElementById('__openchamber_desktop_browser_overlay');
  if (existing) existing.remove();
  if (typeof window.__openchamberDesktopBrowserCancelInspect === 'function') {
    try { window.__openchamberDesktopBrowserCancelInspect(); } catch { /* webview not ready */ }
  }
  const overlay = document.createElement('div');
  overlay.id = '__openchamber_desktop_browser_overlay';
  overlay.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #60a5fa;background:rgba(96,165,250,.24);border-radius:3px;display:none;box-sizing:border-box;';
  document.documentElement.appendChild(overlay);
  const cssEscape = (value) => {
    try { return CSS.escape(value); } catch { return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&'); }
  };
  const selectorPart = (element) => {
    const tag = element.tagName.toLowerCase();
    if (element.id) return tag + '#' + cssEscape(element.id);
    const className = String(element.className || '').trim().split(/\\s+/).filter(Boolean).slice(0, 3).map((part) => '.' + cssEscape(part)).join('');
    return tag + className;
  };
  const metadata = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const ancestry = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && ancestry.length < 8) {
      ancestry.unshift({ tag: current.tagName.toLowerCase(), id: current.id || undefined, className: typeof current.className === 'string' ? current.className : undefined, selectorPart: selectorPart(current) });
      current = current.parentElement;
    }
    const attrs = {};
    for (const attr of Array.from(element.attributes || []).slice(0, 16)) attrs[attr.name] = attr.value.slice(0, 300);
    const path = ancestry.map((entry) => entry.selectorPart).join(' > ');
    return {
      frame: 'top',
      tag: element.tagName.toLowerCase(),
      text: String(element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 500),
      selector: element.id ? '#' + cssEscape(element.id) : path,
      path,
      bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      center: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
      attributes: attrs,
      computedStyle: { display: style.display, position: style.position, fontWeight: style.fontWeight, fontSize: style.fontSize, lineHeight: style.lineHeight, fontFamily: style.fontFamily, color: style.color, backgroundColor: style.backgroundColor, zIndex: style.zIndex },
      ancestry,
    };
  };
  const move = (event) => {
    const element = document.elementFromPoint(event.clientX, event.clientY);
    if (!element || element === overlay || element === document.documentElement || element === document.body) return;
    const rect = element.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.left = rect.left + 'px';
    overlay.style.top = rect.top + 'px';
    overlay.style.width = rect.width + 'px';
    overlay.style.height = rect.height + 'px';
  };
  const cleanup = () => {
    window.removeEventListener('mousemove', move, true);
    window.removeEventListener('click', click, true);
    window.removeEventListener('keydown', keydown, true);
    if (window.__openchamberDesktopBrowserCancelInspect === cancel) {
      delete window.__openchamberDesktopBrowserCancelInspect;
    }
  };
  const cancel = () => {
    cleanup();
    overlay.remove();
    resolve(null);
  };
  const click = (event) => {
    event.preventDefault();
    event.stopPropagation();
    const element = document.elementFromPoint(event.clientX, event.clientY);
    const result = element ? metadata(element) : null;
    cleanup();
    overlay.remove();
    resolve(result);
  };
  const keydown = (event) => {
    if (event.key !== 'Escape') return;
    cancel();
  };
  window.__openchamberDesktopBrowserCancelInspect = cancel;
  window.addEventListener('mousemove', move, true);
  window.addEventListener('click', click, true);
  window.addEventListener('keydown', keydown, true);
});`;

const DESKTOP_BROWSER_CANCEL_INSPECT_SCRIPT = `(() => {
  if (typeof window.__openchamberDesktopBrowserCancelInspect === 'function') {
    window.__openchamberDesktopBrowserCancelInspect();
    return;
  }
  const overlay = document.getElementById('__openchamber_desktop_browser_overlay');
  if (overlay) overlay.remove();
})()`;

// UX enhancement only: keeps window.open/target=_blank inside the pane
// without a popup flash. The security boundary is the main process's
// setWindowOpenHandler on webview guests, which denies every popup.
const DESKTOP_BROWSER_SAME_WEBVIEW_NAVIGATION_SCRIPT = `(() => {
  if (window.__openchamberSameWebviewNavigationInstalled) return;
  window.__openchamberSameWebviewNavigationInstalled = true;

  const navigate = (rawUrl) => {
    if (typeof rawUrl !== 'string' || rawUrl.length === 0) return false;
    try {
      const url = new URL(rawUrl, window.location.href);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
      window.location.assign(url.href);
      return true;
    } catch (_error) {
      return false;
    }
  };

  const originalOpen = window.open.bind(window);
  window.open = (url, target, features) => {
    if (navigate(url)) return null;
    return originalOpen(url, target, features);
  };

  document.addEventListener('click', (event) => {
    if (event.defaultPrevented) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest('a[target="_blank"][href]');
    if (!(anchor instanceof HTMLAnchorElement)) return;
    if (!navigate(anchor.href)) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);
})()`;

export type DesktopBrowserPaneProps = {
  initialUrl: string;
  directory: string;
  tabID: string;
  active: boolean;
  leaseId?: string;
};

type BrowserDevToolsState = {
  open: boolean;
};

type BrowserDevToolsBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const DEFAULT_DEVTOOLS_DOCK_HEIGHT = 300;
const MIN_DEVTOOLS_DOCK_HEIGHT = 180;
const MIN_BROWSER_VIEW_HEIGHT = 120;
const DEVTOOLS_DOCK_SEPARATOR_HEIGHT = 6;

export const DesktopBrowserPane: React.FC<DesktopBrowserPaneProps> = ({
  initialUrl,
  directory,
  tabID,
  active,
  leaseId,
}) => {
  const { t } = useI18n();
  const webviewRef = React.useRef<WebviewElement | null>(null);
  const browserContentRef = React.useRef<HTMLDivElement | null>(null);
  const setContextPanelTabTargetPath = useUIStore((state) => state.setContextPanelTabTargetPath);
  const normalized = normalizeBrowserUrl(initialUrl);
  const startUrl = formatBrowserAddress(normalized);
  const initialWebviewSrcRef = React.useRef(normalized);
  const [urlInput, setUrlInput] = React.useState(startUrl);
  const [currentUrl, setCurrentUrl] = React.useState(startUrl);
  const [isInspecting, setIsInspecting] = React.useState(false);
  const [isDevToolsOpen, setIsDevToolsOpen] = React.useState(false);
  const [devToolsDockHeight, setDevToolsDockHeight] = React.useState(DEFAULT_DEVTOOLS_DOCK_HEIGHT);
  const [isLoading, setIsLoading] = React.useState(startUrl !== '');
  const leaseSelector = React.useMemo(
    () => browserAgentLeaseSelectors.lease(leaseId ?? ''),
    [leaseId],
  );
  const lease = useBrowserAgentStore(leaseSelector);
  const isAgentDriving = Boolean(leaseId && lease?.clientAttached);
  const loadingTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const agentDisconnectToastShownRef = React.useRef(false);
  const boundWebContentsIdRef = React.useRef<number | null>(null);
  const bindingWebContentsIdRef = React.useRef<number | null>(null);

  const persistUrl = React.useCallback((url: string) => {
    if (!url || url === 'about:blank' || !directory || !tabID) return;
    const safeUrl = normalizeBrowserUrl(url);
    if (safeUrl === 'about:blank') return;
    setContextPanelTabTargetPath(directory, tabID, safeUrl);
  }, [directory, tabID, setContextPanelTabTargetPath]);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentDraftId = useSessionUIStore((state) => state.currentDraftId);
  const newSessionDraftOpen = useSessionUIStore((state) => Boolean(state.currentDraftId && state.newSessionDraft?.open));
  const addInlineCommentDraft = useInlineCommentDraftStore((state) => state.addDraft);
  const addAttachedFile = useInputStore((state) => state.addAttachedFile);
  const isBlankPage = !currentUrl || currentUrl === 'about:blank';
  const localPreviewCandidates = useLocalPreviewInstances(
    directory,
    t('contextPanel.browser.localInstanceFallback'),
  );
  const reachableLocalPreviews = useReachableLocalPreviewInstances(
    localPreviewCandidates,
    !leaseId && active && isBlankPage && !isLoading,
  );

  const bindLeaseGuest = React.useCallback(() => {
    if (!leaseId) return;
    const webview = webviewRef.current;
    if (!webview || typeof webview.getWebContentsId !== 'function') return;

    try {
      const webContentsId = webview.getWebContentsId();
      if (
        !Number.isFinite(webContentsId)
        || boundWebContentsIdRef.current === webContentsId
        || bindingWebContentsIdRef.current === webContentsId
      ) {
        return;
      }

      bindingWebContentsIdRef.current = webContentsId;
      void invokeDesktop('desktop_browser_lease_bind_guest', { leaseId, webContentsId })
        .then((result) => {
          if (result !== null) boundWebContentsIdRef.current = webContentsId;
        })
        .catch(() => {})
        .finally(() => {
          if (bindingWebContentsIdRef.current === webContentsId) {
            bindingWebContentsIdRef.current = null;
          }
        });
    } catch {
      // The guest has not attached yet; did-attach/dom-ready will retry.
    }
  }, [leaseId]);

  const getDevToolsDockBounds = React.useCallback((): BrowserDevToolsBounds | null => {
    const content = browserContentRef.current;
    if (!content) return null;
    const rect = content.getBoundingClientRect();
    const maxDockHeight = Math.max(MIN_DEVTOOLS_DOCK_HEIGHT, Math.floor(rect.height) - MIN_BROWSER_VIEW_HEIGHT);
    const reservedHeight = Math.min(devToolsDockHeight, maxDockHeight);
    const height = Math.max(1, reservedHeight - DEVTOOLS_DOCK_SEPARATOR_HEIGHT);
    if (rect.width < 1 || rect.height < 1) return null;
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.bottom - height),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(height)),
    };
  }, [devToolsDockHeight]);

  const requestDevToolsOpen = React.useCallback((open: boolean): Promise<BrowserDevToolsState | null> => {
    const webview = webviewRef.current;
    if (!webview || typeof webview.getWebContentsId !== 'function') return Promise.resolve(null);

    try {
      const webContentsId = webview.getWebContentsId();
      if (!Number.isFinite(webContentsId)) return Promise.resolve(null);
      const bounds = open ? getDevToolsDockBounds() : undefined;
      if (open && !bounds) return Promise.resolve(null);
      return invokeDesktop<BrowserDevToolsState>('desktop_browser_devtools_set_open', { webContentsId, open, bounds });
    } catch {
      return Promise.resolve(null);
    }
  }, [getDevToolsDockBounds]);

  // Listen to webview navigation and native DevTools lifecycle events.
  React.useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    const syncUrl = () => {
      try {
        const url = webview.getURL?.();
        if (url) {
          const address = formatBrowserAddress(url);
          setCurrentUrl(address);
          setUrlInput(address);
          persistUrl(url);
        }
      } catch { /* webview not ready */ }
    };

    const onNavigate = (event: Event) => {
      const detail = (event as CustomEvent<{ url: string }>).detail ?? (event as unknown as { url?: string });
      const url = typeof (detail as { url?: unknown })?.url === 'string' ? (detail as { url: string }).url : '';
      if (url) {
        const address = formatBrowserAddress(url);
        setCurrentUrl(address);
        setUrlInput(address);
        persistUrl(url);
      }
    };

    const onStartLoading = () => {
      if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current);
      loadingTimerRef.current = setTimeout(() => setIsLoading(true), 200);
    };
    const onStopLoading = () => {
      if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current);
      setIsLoading(false);
      syncUrl();
    };
    const onFailLoading = (event: Event) => {
      const detail = event as unknown as { errorCode?: number; isMainFrame?: boolean };
      if (detail.isMainFrame === false || detail.errorCode === -3) return;
      if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current);
      setIsLoading(false);
    };

    const installSameWebviewNavigation = () => {
      try {
        webview.executeJavaScript?.(DESKTOP_BROWSER_SAME_WEBVIEW_NAVIGATION_SCRIPT, true)?.catch(() => {});
      } catch { /* webview not ready */ }
    };

    const syncDevToolsOpen = () => {
      try {
        setIsDevToolsOpen(Boolean(webview.isDevToolsOpened?.()));
      } catch {
        setIsDevToolsOpen(false);
      }
    };

    const onDevToolsOpened = () => setIsDevToolsOpen(true);
    const onDevToolsClosed = () => setIsDevToolsOpen(false);
    const onDevToolsOpenUrl = (event: Event) => {
      const directUrl = (event as unknown as { url?: unknown }).url;
      const detailUrl = (event as CustomEvent<{ url?: unknown }>).detail?.url;
      const url = typeof directUrl === 'string' ? directUrl : typeof detailUrl === 'string' ? detailUrl : '';
      if (url) void openExternalUrl(url);
    };

    webview.addEventListener('did-navigate', onNavigate);
    webview.addEventListener('did-navigate-in-page', onNavigate);
    webview.addEventListener('did-start-loading', onStartLoading);
    webview.addEventListener('did-stop-loading', onStopLoading);
    webview.addEventListener('did-fail-load', onFailLoading);
    webview.addEventListener('dom-ready', installSameWebviewNavigation);
    webview.addEventListener('did-attach', bindLeaseGuest);
    webview.addEventListener('dom-ready', bindLeaseGuest);
    webview.addEventListener('devtools-opened', onDevToolsOpened);
    webview.addEventListener('devtools-closed', onDevToolsClosed);
    webview.addEventListener('devtools-open-url', onDevToolsOpenUrl);

    // Check current loading state imperatively — we may have missed the event.
    try {
      if (webview.isLoading && !webview.isLoading()) {
        setIsLoading(false);
        syncUrl();
      }
    } catch { /* webview not ready */ }
    syncDevToolsOpen();
    installSameWebviewNavigation();
    bindLeaseGuest();

    return () => {
      if (loadingTimerRef.current) clearTimeout(loadingTimerRef.current);
      webview.removeEventListener('did-navigate', onNavigate);
      webview.removeEventListener('did-navigate-in-page', onNavigate);
      webview.removeEventListener('did-start-loading', onStartLoading);
      webview.removeEventListener('did-stop-loading', onStopLoading);
      webview.removeEventListener('did-fail-load', onFailLoading);
      webview.removeEventListener('dom-ready', installSameWebviewNavigation);
      webview.removeEventListener('did-attach', bindLeaseGuest);
      webview.removeEventListener('dom-ready', bindLeaseGuest);
      webview.removeEventListener('devtools-opened', onDevToolsOpened);
      webview.removeEventListener('devtools-closed', onDevToolsClosed);
      webview.removeEventListener('devtools-open-url', onDevToolsOpenUrl);
    };
  }, [bindLeaseGuest, persistUrl]);

  // Safety timeout: hide the loading overlay after 30s even if events fire late.
  React.useEffect(() => {
    const safety = setTimeout(() => setIsLoading(false), 30_000);
    return () => clearTimeout(safety);
  }, []);

  // A native DevTools dock must never outlive the visible browser tab. Hidden
  // browser guests stay mounted to preserve history, so close explicitly when
  // this tab becomes inactive.
  React.useEffect(() => {
    if (active || !isDevToolsOpen) return;
    void requestDevToolsOpen(false).catch(() => {});
  }, [active, isDevToolsOpen, requestDevToolsOpen]);

  // The native DevTools WebContentsView lives above the renderer. Keep its
  // bounds aligned with this pane as the context panel or window resizes.
  React.useEffect(() => {
    if (!isDevToolsOpen) return;
    const content = browserContentRef.current;
    if (!content) return;
    const syncBounds = () => { void requestDevToolsOpen(true).catch(() => {}); };
    syncBounds();
    const observer = new ResizeObserver(syncBounds);
    observer.observe(content);
    window.addEventListener('resize', syncBounds);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', syncBounds);
    };
  }, [devToolsDockHeight, isDevToolsOpen, requestDevToolsOpen]);

  // Escape key cancels inspect mode.
  React.useEffect(() => {
    if (!isInspecting) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setIsInspecting(false);
      const webview = webviewRef.current;
      try { webview?.executeJavaScript?.(DESKTOP_BROWSER_CANCEL_INSPECT_SCRIPT)?.catch(() => {}); } catch { /* webview not ready */ }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [isInspecting]);

  // Persist the last URL and close both inspection modes on unmount.
  React.useEffect(() => {
    const webview = webviewRef.current;
    return () => {
      try {
        const url = webview?.getURL?.();
        if (url && url !== 'about:blank') {
          const safeUrl = normalizeBrowserUrl(url);
          if (safeUrl !== 'about:blank') setContextPanelTabTargetPath(directory, tabID, safeUrl);
        }
      } catch { /* webview not ready */ }
      try { webview?.executeJavaScript?.(DESKTOP_BROWSER_CANCEL_INSPECT_SCRIPT)?.catch(() => {}); } catch { /* webview not ready */ }
      try {
        const webContentsId = webview?.getWebContentsId?.();
        if (Number.isFinite(webContentsId)) {
          void invokeDesktop('desktop_browser_devtools_set_open', { webContentsId, open: false }).catch(() => {});
        }
      } catch { /* webview may already be detached */ }
    };
  }, [directory, tabID, setContextPanelTabTargetPath]);

  const loadUrl = React.useCallback((value: string) => {
    const webview = webviewRef.current;
    if (typeof webview?.loadURL !== 'function') return;
    const nextUrl = normalizeBrowserUrl(value);
    setUrlInput(formatBrowserAddress(nextUrl));
    setIsLoading(nextUrl !== 'about:blank');
    try {
      Promise.resolve(webview.loadURL(nextUrl)).catch(() => {
        setIsLoading(false);
        toast.error(t('contextPanel.browser.openFailed'));
      });
    } catch {
      setIsLoading(false);
      toast.error(t('contextPanel.browser.openFailed'));
    }
  }, [t]);

  const handleToggleDevTools = React.useCallback(async () => {
    const shouldOpen = !isDevToolsOpen;
    const disconnectingAgent = shouldOpen && isAgentDriving;

    try {
      const result = await requestDevToolsOpen(shouldOpen);
      if (!result) {
        toast.error(t('contextPanel.browser.devtoolsUnavailable'));
        return;
      }
      setIsDevToolsOpen(result.open);
      if (disconnectingAgent && result.open && !agentDisconnectToastShownRef.current) {
        agentDisconnectToastShownRef.current = true;
        toast.info(t('contextPanel.browser.devtoolsAgentDisconnected'));
      }
    } catch {
      toast.error(t('contextPanel.browser.devtoolsUnavailable'));
    }
  }, [isAgentDriving, isDevToolsOpen, requestDevToolsOpen, t]);

  const handleDevToolsDockResizeStart = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const content = browserContentRef.current;
    if (!content) return;
    const startY = event.clientY;
    const startHeight = devToolsDockHeight;
    const maxHeight = Math.max(MIN_DEVTOOLS_DOCK_HEIGHT, Math.floor(content.getBoundingClientRect().height) - MIN_BROWSER_VIEW_HEIGHT);
    const onMove = (moveEvent: PointerEvent) => {
      const nextHeight = startHeight + startY - moveEvent.clientY;
      setDevToolsDockHeight(Math.min(maxHeight, Math.max(MIN_DEVTOOLS_DOCK_HEIGHT, Math.round(nextHeight))));
    };
    const onEnd = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
  }, [devToolsDockHeight]);

  const handleInspect = React.useCallback(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    if (isInspecting) {
      setIsInspecting(false);
      try { webview.executeJavaScript?.(DESKTOP_BROWSER_CANCEL_INSPECT_SCRIPT)?.catch(() => {}); } catch { /* webview not ready */ }
      return;
    }

    if (typeof webview.executeJavaScript !== 'function') {
      toast.error(t('contextPanel.browser.inspectUnavailable'));
      return;
    }

    setIsInspecting(true);
    webview.executeJavaScript(DESKTOP_BROWSER_INSPECT_SCRIPT, true)
      .then(async (target: unknown) => {
        setIsInspecting(false);
        if (!target || !isPreviewElementMetadata(target)) return;

        const sessionKey = currentSessionId ?? (currentDraftId ? `draft:${currentDraftId}` : newSessionDraftOpen ? 'draft' : null);
        if (!sessionKey) {
          toast.error(t('contextPanel.preview.inspect.attachNoSession'));
          return;
        }

        const wcId = typeof webview.getWebContentsId === 'function' ? webview.getWebContentsId() : null;

        let screenshotAttached = false;
        let cssWidth = 0;
        let cssHeight = 0;
        if (wcId !== null && wcId !== undefined) {
          const capture = await invokeDesktop<{ mime: string; base64: string; width: number; height: number }>(
            'desktop_browser_capture_page', { webContentsId: wcId },
          );

          const cssViewport = await webview.executeJavaScript?.(
            '({ width: window.innerWidth, height: window.innerHeight })', true,
          )?.catch(() => null) as { width: number; height: number } | null | undefined;

          cssWidth = Number.isFinite(cssViewport?.width) ? (cssViewport as { width: number }).width : capture?.width ?? 0;
          cssHeight = Number.isFinite(cssViewport?.height) ? (cssViewport as { height: number }).height : capture?.height ?? 0;

          if (capture) {
            const file = await desktopAnnotationToFile(capture.base64, capture.width, capture.height, cssWidth, cssHeight, target);
            if (file) {
              await addAttachedFile(file);
              screenshotAttached = true;
            }
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
            viewport: { width: cssWidth, height: cssHeight },
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
      .catch(() => setIsInspecting(false));
  }, [addAttachedFile, addInlineCommentDraft, currentDraftId, currentSessionId, currentUrl, isInspecting, newSessionDraftOpen, t]);

  const showEmptyState = isBlankPage && !isLoading;
  const devToolsLabel = isDevToolsOpen
    ? t('contextPanel.browser.devtoolsClose')
    : t('contextPanel.browser.devtoolsOpen');

  return (
    <div className="absolute inset-0 flex flex-col bg-background">
      <div className="flex items-center gap-1 border-b border-border/40 bg-[var(--surface-background)] px-2 py-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          aria-label={t('contextPanel.browser.backAria')}
          onClick={() => { try { webviewRef.current?.goBack?.(); } catch { /* webview not ready */ } }}
        >
          <RiArrowLeftLine className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          aria-label={t('contextPanel.browser.forwardAria')}
          onClick={() => { try { webviewRef.current?.goForward?.(); } catch { /* webview not ready */ } }}
        >
          <RiArrowRightLine className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          aria-label={t('contextPanel.preview.actions.reload')}
          onClick={() => { try { webviewRef.current?.reload?.(); } catch { /* webview not ready */ } }}
        >
          <RiRefreshLine className="h-3.5 w-3.5" />
        </Button>
        <form className="min-w-0 flex-1" onSubmit={(event) => { event.preventDefault(); loadUrl(urlInput); }}>
          <input
            value={urlInput}
            onChange={(event) => setUrlInput(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
            className="h-7 w-full rounded-md border border-border/50 bg-[var(--surface-elevated)] px-2 typography-micro text-foreground outline-none focus:border-[var(--interactive-focus-ring)]"
            aria-label={t('contextPanel.browser.addressAria')}
            placeholder={t('contextPanel.browser.addressPlaceholder')}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
        </form>
        <Button
          type="button"
          variant={isDevToolsOpen ? 'secondary' : 'ghost'}
          size="sm"
          className="h-7 w-7 p-0"
          onClick={() => void handleToggleDevTools()}
          title={devToolsLabel}
          aria-label={devToolsLabel}
          aria-pressed={isDevToolsOpen}
          data-browser-devtools-toggle="true"
        >
          <RiCodeSSlashLine className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant={isInspecting ? 'secondary' : 'ghost'}
          size="sm"
          className="h-7 w-7 p-0"
          onClick={handleInspect}
          title={t('contextPanel.browser.selectForChat')}
          aria-label={t('contextPanel.browser.selectForChat')}
        >
          <RiCursorLine className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          disabled={!currentUrl}
          aria-label={t('contextPanel.preview.actions.openExternal')}
          onClick={() => void openExternalUrl(currentUrl)}
        >
          <RiExternalLinkLine className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div ref={browserContentRef} className="relative min-h-0 flex-1 bg-background">
        <webview
          ref={(node) => { webviewRef.current = node as WebviewElement | null; }}
          src={initialWebviewSrcRef.current}
          partition="persist:openchamber-browser"
          data-browser-lease-id={leaseId ?? undefined}
          style={{
            width: '100%',
            height: isDevToolsOpen ? `calc(100% - ${devToolsDockHeight}px)` : '100%',
            border: 'none',
          }}
        />
        {showEmptyState ? (
          <div className="absolute inset-0 flex items-center justify-center bg-background p-6">
            {reachableLocalPreviews.length > 0 ? (
              <div
                role="list"
                aria-label={t('contextPanel.browser.localInstancesAria')}
                className="w-full max-w-[39rem] overflow-hidden rounded-2xl border border-border/70 bg-[var(--surface-background)]"
              >
                {reachableLocalPreviews.map((instance, index) => (
                  <div
                    key={instance.origin}
                    role="listitem"
                    className={index === 0
                      ? 'flex min-h-16 items-center gap-4 px-4 py-3'
                      : 'flex min-h-16 items-center gap-4 border-t border-border/60 px-4 py-3'}
                  >
                    <RiServerLine className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate typography-ui-header text-foreground">
                      {instance.label}
                    </span>
                    <span className="shrink-0 font-mono typography-ui-header text-muted-foreground">
                      :{instance.port}
                    </span>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="h-10 w-10 shrink-0 rounded-xl p-0"
                      aria-label={t('contextPanel.browser.openLocalInstance', {
                        name: instance.label,
                        port: instance.port,
                      })}
                      onClick={() => loadUrl(instance.url)}
                    >
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
        ) : null}
        {isDevToolsOpen ? (
          <>
            <div
              aria-hidden="true"
              className="absolute inset-x-0 bottom-0 bg-[var(--surface-background)]"
              style={{ height: devToolsDockHeight }}
            />
            <div
              role="separator"
              aria-label={t('contextPanel.browser.devtoolsResize')}
              aria-orientation="horizontal"
              className="absolute inset-x-0 z-20 cursor-row-resize border-t border-border/60 bg-[var(--surface-background)] hover:bg-[var(--surface-elevated)]"
              style={{ bottom: devToolsDockHeight - DEVTOOLS_DOCK_SEPARATOR_HEIGHT, height: DEVTOOLS_DOCK_SEPARATOR_HEIGHT }}
              onPointerDown={handleDevToolsDockResizeStart}
            />
          </>
        ) : null}
        {leaseId ? <BrowserAgentCursor active={active && isAgentDriving} leaseId={leaseId} /> : null}
      </div>
    </div>
  );
};
