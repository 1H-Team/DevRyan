import React from 'react';
import { RiArrowLeftRightLine, RiChat4Line, RiCloseLine, RiDonutChartFill, RiFileTextLine, RiFullscreenExitLine, RiFullscreenLine, RiGlobalLine, RiRefreshLine, RiExternalLinkLine, RiTerminalBoxLine, RiCursorLine } from '@remixicon/react';
import { useReducedMotion } from 'motion/react';

import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Button } from '@/components/ui/button';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import {
  LazyDiffView,
  LazyFilesView,
  LazyPlanView,
  LazyViewBoundary,
} from '@/components/views/lazyViews';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { openExternalUrl } from '@/lib/url';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { useUIStore, type ContextPanelMode } from '@/stores/useUIStore';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { getAllSyncSessions } from '@/sync/sync-refs';
import { useSession } from '@/sync/sync-context';
import { useInputStore } from '@/sync/input-store';
import { useManagedOrchestrationStore } from '@/stores/useManagedOrchestrationStore';
import { useSessionPlanFileStore } from '@/stores/useSessionPlanFileStore';
import { ContextPanelContent } from './ContextSidebarTab';
import { toast } from '@/components/ui';
import {
  buildPreviewFrameKey,
  isPreviewLoopbackHost,
  parsePreviewHttpUrl,
  resolvePreviewReloadUrl,
} from './previewLifecycle';
import {
  formatPreviewAnnotationMarkdown,
  isPreviewElementMetadata,
  renderPreviewScreenshot,
  type PreviewElementMetadata,
} from '@/lib/preview/screenshot-capture';
import { resolveContextPlanSessionChange } from './contextPlanSessionLifecycle';
import { DesktopBrowserPane } from './DesktopBrowserPane';
import { useGuestRetention } from './useGuestRetention';
import {
  browserAgentLeaseSelectors,
  ensureBrowserAgentListeners,
  setObservedBrowserAgentLease,
  useBrowserAgentStore,
} from '@/stores/useBrowserAgentStore';
import { isElectronShell } from '@/lib/desktop';
import { resolveRootSessionID } from '@/lib/sessionLineage';

const CONTEXT_PANEL_MIN_WIDTH = 360;
const CONTEXT_PANEL_MAX_WIDTH = 1400;
const CONTEXT_PANEL_DEFAULT_WIDTH = 600;
const CONTEXT_TAB_LABEL_MAX_CHARS = 24;
const CONTEXT_PLAN_ENTER_ANIMATION_NAME = 'oc-context-plan-panel-enter';
const CONTEXT_PLAN_EXIT_ANIMATION_NAME = 'oc-context-plan-panel-exit';
type TranslateFn = ReturnType<typeof useI18n>['t'];

type ActiveContextPlanMotion = {
  requestID: number;
  direction: 'enter' | 'exit';
  closeTabID?: string;
};

type PreviewConsoleEvent = {
  id: number;
  level: 'log' | 'info' | 'warn' | 'error' | 'debug' | 'resource' | 'runtime';
  message: string;
  details?: string;
  ts: number;
};

type PreviewConsoleFilter = 'all' | 'errors' | 'warnings' | 'logs';

type PreviewBridgeMessage = {
  source?: string;
  version?: number;
  type?: string;
  level?: PreviewConsoleEvent['level'];
  args?: unknown[];
  message?: unknown;
  stack?: unknown;
  filename?: unknown;
  line?: unknown;
  column?: unknown;
  tag?: unknown;
  url?: unknown;
  outerHTML?: unknown;
  title?: unknown;
  ts?: unknown;
  target?: unknown;
  navigation?: unknown;
};

const PREVIEW_CONSOLE_EVENT_LIMIT = 200;

const getPreviewConsoleFilterMatch = (event: PreviewConsoleEvent, filter: PreviewConsoleFilter): boolean => {
  if (filter === 'all') return true;
  if (filter === 'errors') return event.level === 'error' || event.level === 'runtime' || event.level === 'resource';
  if (filter === 'warnings') return event.level === 'warn';
  return event.level === 'log' || event.level === 'info' || event.level === 'debug';
};

const normalizeDirectoryKey = (value: string): string => {
  if (!value) return '';

  const raw = value.replace(/\\/g, '/');
  const hadUncPrefix = raw.startsWith('//');
  let normalized = raw.replace(/\/+$/g, '');
  normalized = normalized.replace(/\/+/g, '/');

  if (hadUncPrefix && !normalized.startsWith('//')) {
    normalized = `/${normalized}`;
  }

  if (normalized === '') {
    return raw.startsWith('/') ? '/' : '';
  }

  return normalized;
};

const clampWidth = (width: number): number => {
  if (!Number.isFinite(width)) {
    return CONTEXT_PANEL_DEFAULT_WIDTH;
  }

  return Math.min(CONTEXT_PANEL_MAX_WIDTH, Math.max(CONTEXT_PANEL_MIN_WIDTH, Math.round(width)));
};

const getRelativePathLabel = (filePath: string | null, directory: string): string => {
  if (!filePath) {
    return '';
  }
  const normalizedFile = filePath.replace(/\\/g, '/');
  const normalizedDir = directory.replace(/\\/g, '/').replace(/\/+$/, '');
  if (normalizedDir && normalizedFile.startsWith(normalizedDir + '/')) {
    return normalizedFile.slice(normalizedDir.length + 1);
  }
  return normalizedFile;
};

const getModeLabel = (
  mode: 'diff' | 'file' | 'context' | 'plan' | 'chat' | 'preview' | 'browser',
  t: TranslateFn
): string => {
  if (mode === 'chat') return t('contextPanel.mode.chat');
  if (mode === 'file') return t('contextPanel.mode.files');
  if (mode === 'diff') return t('contextPanel.mode.diff');
  if (mode === 'plan') return t('contextPanel.mode.plan');
  if (mode === 'preview') return t('contextPanel.mode.preview');
  if (mode === 'browser') return t('contextPanel.mode.browser');
  return t('contextPanel.mode.context');
};

const getFileNameFromPath = (path: string | null): string | null => {
  if (!path) {
    return null;
  }

  const normalized = path.replace(/\\/g, '/').trim();
  if (!normalized) {
    return null;
  }

  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) {
    return normalized;
  }

  return segments[segments.length - 1] || null;
};

const getTabLabel = (
  tab: { mode: 'diff' | 'file' | 'context' | 'plan' | 'chat' | 'preview' | 'browser'; label: string | null; targetPath: string | null },
  t: TranslateFn
): string => {
  if (tab.label) {
    return tab.label;
  }

  if (tab.mode === 'file') {
    return getFileNameFromPath(tab.targetPath) || t('contextPanel.mode.files');
  }

  if (tab.mode === 'preview' || tab.mode === 'browser') {
    const url = tab.targetPath;
    const fallback = tab.mode === 'browser' ? t('contextPanel.mode.browser') : t('contextPanel.mode.preview');
    if (url) {
      try {
        const parsed = new URL(url);
        return parsed.host || parsed.hostname || fallback;
      } catch {
        // ignore invalid URL
      }
    }
    return fallback;
  }

  return getModeLabel(tab.mode, t);
};

const getTabIcon = (tab: { mode: 'diff' | 'file' | 'context' | 'plan' | 'chat' | 'preview' | 'browser'; targetPath: string | null; leaseId?: string | null }): React.ReactNode | undefined => {
  if (tab.mode === 'file') {
    return tab.targetPath
      ? <FileTypeIcon filePath={tab.targetPath} className="h-3.5 w-3.5" />
      : undefined;
  }

  if (tab.mode === 'diff') {
    return <RiArrowLeftRightLine className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'plan') {
    return <RiFileTextLine className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'context') {
    return <RiDonutChartFill className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'chat') {
    return <RiChat4Line className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'preview') {
    return <RiGlobalLine className="h-3.5 w-3.5 text-[var(--status-info)]" />;
  }

  if (tab.mode === 'browser') {
    return <BrowserTabIcon leaseId={tab.leaseId} />;
  }

  return undefined;
};

// Manual browser guests sleep 60s after their tab deactivates (quick flips do
// not reload). Lease guests have an independent invariant fleet below and stay
// mounted until their authoritative lease disappears. Chat iframes are
// same-process but each hosts a full app instance; the long grace mirrors
// relaunch behavior for long-idle tabs without losing recently-typed drafts.
const BROWSER_GUEST_SLEEP_DELAY_MS = 60_000;
const CHAT_GUEST_SLEEP_DELAY_MS = 30 * 60_000;

const BrowserTabIcon: React.FC<{ leaseId?: string | null }> = ({ leaseId }) => {
  const leaseSelector = React.useMemo(
    () => browserAgentLeaseSelectors.lease(leaseId ?? ''),
    [leaseId],
  );
  const lease = useBrowserAgentStore(leaseSelector);
  return (
    <span className="relative inline-flex">
      <RiGlobalLine className="h-3.5 w-3.5" />
      {lease ? (
        <span
          className="absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full bg-[var(--status-info)]"
          aria-hidden="true"
        />
      ) : null}
    </span>
  );
};

const BrowserLeasePane: React.FC<{ leaseId: string; active: boolean }> = React.memo(({
  leaseId,
  active,
}) => {
  const leaseSelector = React.useMemo(
    () => browserAgentLeaseSelectors.lease(leaseId),
    [leaseId],
  );
  const lease = useBrowserAgentStore(leaseSelector);
  if (!lease) return null;

  return (
    <div
      className={cn(
        'absolute inset-0',
        active ? 'z-10 opacity-100' : 'z-0 pointer-events-none opacity-0',
      )}
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

type BrowserLeasePresentationTab = {
  id: string;
  mode: ContextPanelMode;
  leaseId?: string | null;
  ownerSessionId?: string | null;
};

const getStaleBrowserLeaseTabIDs = (
  tabs: readonly BrowserLeasePresentationTab[],
  currentRootSessionId: string | null,
): string[] => tabs
  .filter((tab) => (
    tab.mode === 'browser'
    && Boolean(tab.leaseId)
    && tab.ownerSessionId !== currentRootSessionId
  ))
  .map((tab) => tab.id);

const getSessionIDFromDedupeKey = (dedupeKey: string | undefined): string | null => {
  if (!dedupeKey || !dedupeKey.startsWith('session:')) {
    return null;
  }

  const sessionID = dedupeKey.slice('session:'.length).trim();
  return sessionID || null;
};

const buildEmbeddedSessionChatURL = (sessionID: string, directory: string | null): string => {
  if (typeof window === 'undefined') {
    return '';
  }

  const url = new URL(window.location.pathname, window.location.origin);
  url.searchParams.set('ocPanel', 'session-chat');
  url.searchParams.set('surface', 'desktop');
  url.searchParams.set('sessionId', sessionID);
  if (directory && directory.trim().length > 0) {
    url.searchParams.set('directory', directory);
  } else {
    url.searchParams.delete('directory');
  }

  url.hash = '';
  return url.toString();
};

const truncateTabLabel = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars - 3)}...`;
};

type PreviewPaneProps = {
  tabID: string;
  targetUrl: string;
  displayUrl: string;
  onDisplayNavigate: (url: string) => void;
  onTargetNavigate: (url: string) => void;
};

type PreviewProxyState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; proxyBasePath: string; expiresAt: number }
  | { status: 'error'; message: string };

// Module-scoped, in-memory cache of registered proxy targets keyed by the
// fully-qualified upstream URL. Survives PreviewPane unmount/remount and tab
// switches, but intentionally does NOT survive a full page reload: the server
// holds the target map in memory and the auth cookie is HttpOnly + scoped to
// the proxy id, so a stale persisted entry would 404 after a server restart.
// Entries are evicted on registration error (refetched) or when the upstream
// returns 403 (cookie expired) / 404 (target unknown) at iframe load time.
type CachedProxyTarget = { proxyBasePath: string; expiresAt: number };
const previewProxyTargetCache = new Map<string, CachedProxyTarget>();
const PREVIEW_PROXY_CACHE_SAFETY_MS = 30_000;

const getCachedProxyTarget = (url: string): CachedProxyTarget | null => {
  const entry = previewProxyTargetCache.get(url);
  if (!entry) return null;
  if (entry.expiresAt - Date.now() <= PREVIEW_PROXY_CACHE_SAFETY_MS) {
    previewProxyTargetCache.delete(url);
    return null;
  }
  return entry;
};

const PreviewPane: React.FC<PreviewPaneProps> = ({
  tabID,
  targetUrl,
  displayUrl,
  onDisplayNavigate,
  onTargetNavigate,
}) => {
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const [reloadNonce, bumpReload] = React.useReducer((x: number) => x + 1, 0);
  const [probeNonce, bumpProbe] = React.useReducer((x: number) => x + 1, 0);
  const [proxyRegistrationNonce, bumpProxyRegistration] = React.useReducer((x: number) => x + 1, 0);
  const [frameRequest, setFrameRequest] = React.useState(() => ({
    ownerTargetUrl: targetUrl,
    url: targetUrl,
  }));
  const [proxyState, setProxyState] = React.useState<PreviewProxyState>({ status: 'idle' });
  const iframeRef = React.useRef<HTMLIFrameElement | null>(null);
  const nextConsoleEventIdRef = React.useRef(1);
  const [bridgeReady, setBridgeReady] = React.useState(false);
  const [consoleOpen, setConsoleOpen] = React.useState(false);
  const [consoleFilter, setConsoleFilter] = React.useState<PreviewConsoleFilter>('all');
  const [consoleEvents, setConsoleEvents] = React.useState<PreviewConsoleEvent[]>([]);
  const [inspectMode, setInspectMode] = React.useState(false);
  const [hoverTarget, setHoverTarget] = React.useState<PreviewElementMetadata | null>(null);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentDraftId = useSessionUIStore((state) => state.currentDraftId);
  const newSessionDraftOpen = useSessionUIStore((state) => Boolean(state.currentDraftId && state.newSessionDraft?.open));
  const addInlineCommentDraft = useInlineCommentDraftStore((state) => state.addDraft);
  const addAttachedFile = useInputStore((state) => state.addAttachedFile);

  const normalizedUrl = parsePreviewHttpUrl(targetUrl);
  const isBlankPreview = targetUrl === 'about:blank';
  const frameUrl = frameRequest.ownerTargetUrl === targetUrl
    ? resolvePreviewReloadUrl(targetUrl, frameRequest.url)
    : normalizedUrl;
  const isLoopback = normalizedUrl ? isPreviewLoopbackHost(normalizedUrl.hostname) : false;

  const targetKey = normalizedUrl ? normalizedUrl.toString() : '';
  const currentDisplayUrl = displayUrl || targetUrl || frameUrl?.toString() || '';
  const intentionalFrameKey = buildPreviewFrameKey(tabID, targetKey, reloadNonce);
  const previewColorScheme = currentTheme.metadata.variant;

  React.useEffect(() => {
    if (!targetKey || !isLoopback) {
      setProxyState({ status: 'idle' });
      return;
    }

    const cached = getCachedProxyTarget(targetKey);
    if (cached) {
      setProxyState({ status: 'ready', proxyBasePath: cached.proxyBasePath, expiresAt: cached.expiresAt });
      return;
    }

    let cancelled = false;
    setProxyState({ status: 'loading' });

    void (async () => {
      try {
        const response = await fetch('/api/preview/targets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ url: targetKey }),
        });

        if (!response.ok) {
          previewProxyTargetCache.delete(targetKey);
          const errorBody = await response.json().catch(() => ({}));
          const message = typeof errorBody?.error === 'string'
            ? errorBody.error
            : `HTTP ${response.status}`;
          if (!cancelled) {
            setProxyState({ status: 'error', message });
          }
          return;
        }

        const body = await response.json() as { proxyBasePath?: unknown; expiresAt?: unknown };
        const proxyBasePath = typeof body.proxyBasePath === 'string' ? body.proxyBasePath : '';
        const expiresAt = typeof body.expiresAt === 'number' ? body.expiresAt : 0;
        if (!proxyBasePath) {
          previewProxyTargetCache.delete(targetKey);
          if (!cancelled) {
            setProxyState({ status: 'error', message: t('contextPanel.preview.proxyError') });
          }
          return;
        }

        previewProxyTargetCache.set(targetKey, { proxyBasePath, expiresAt });
        if (!cancelled) {
          setProxyState({ status: 'ready', proxyBasePath, expiresAt });
        }
      } catch (error) {
        previewProxyTargetCache.delete(targetKey);
        if (!cancelled) {
          const message = error instanceof Error ? error.message : String(error);
          setProxyState({ status: 'error', message });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isLoopback, proxyRegistrationNonce, t, targetKey]);

  const directSrc = isBlankPreview ? 'about:blank' : (frameUrl?.toString() ?? '');

  const proxySrc = isLoopback && proxyState.status === 'ready' && frameUrl
    ? (() => {
      const path = frameUrl.pathname || '/';
      const searchParams = new URLSearchParams(frameUrl.search);
      searchParams.set('ocPreview', String(reloadNonce));
      const search = searchParams.toString();
      const hash = frameUrl.hash || '';
      return `${proxyState.proxyBasePath}${path}${search ? `?${search}` : ''}${hash}`;
    })()
    : '';

  const effectiveSrc = isLoopback ? proxySrc : directSrc;
  const externalSrc = parsePreviewHttpUrl(currentDisplayUrl)?.toString() || directSrc;
  const showLoading = isLoopback && (proxyState.status === 'loading' || proxyState.status === 'idle');
  const showError = isLoopback && proxyState.status === 'error';

  const reloadPreview = React.useCallback(() => {
    setFrameRequest({ ownerTargetUrl: targetUrl, url: currentDisplayUrl || targetUrl });
    bumpReload();
    bumpProbe();
  }, [currentDisplayUrl, targetUrl]);

  const attachPreviewAnnotation = React.useCallback((target: PreviewElementMetadata) => {
    const sessionKey = currentSessionId ?? (currentDraftId ? `draft:${currentDraftId}` : newSessionDraftOpen ? 'draft' : null);
    if (!sessionKey) {
      toast.error(t('contextPanel.preview.inspect.attachNoSession'));
      return;
    }

    const pageUrl = currentDisplayUrl || effectiveSrc || '';
    const viewport = typeof window !== 'undefined'
      ? { width: window.innerWidth, height: window.innerHeight }
      : { width: 0, height: 0 };
    const devicePixelRatio = typeof window !== 'undefined' ? window.devicePixelRatio : 1;

    void (async () => {
      let attachedScreenshot = false;
      try {
        const iframe = iframeRef.current;
        const screenshot = iframe ? await renderPreviewScreenshot(iframe, target) : null;
        if (screenshot) {
          await addAttachedFile(screenshot);
          attachedScreenshot = true;
        }
      } catch {
        attachedScreenshot = false;
      }

      addInlineCommentDraft({
        sessionKey,
        source: 'preview-annotation',
        fileLabel: pageUrl || 'preview',
        startLine: 1,
        endLine: 1,
        code: formatPreviewAnnotationMarkdown({
          pageUrl,
          viewport,
          devicePixelRatio,
          target,
          screenshotAttached: attachedScreenshot,
          intro: attachedScreenshot
            ? t('contextPanel.preview.inspect.attachAnnotationWithScreenshot')
            : t('contextPanel.preview.inspect.attachAnnotation'),
        }),
        language: 'markdown',
        text: '',
      });
      toast.success(t('contextPanel.preview.inspect.attached'));
    })();
  }, [addAttachedFile, addInlineCommentDraft, currentDisplayUrl, currentDraftId, currentSessionId, effectiveSrc, newSessionDraftOpen, t]);

  React.useEffect(() => {
    setBridgeReady(false);
    setConsoleEvents([]);
    setConsoleOpen(false);
    setConsoleFilter('all');
    setInspectMode(false);
    setHoverTarget(null);
    nextConsoleEventIdRef.current = 1;
  }, [intentionalFrameKey]);

  React.useEffect(() => {
    const frameWindow = iframeRef.current?.contentWindow;
    if (!bridgeReady || !frameWindow) {
      return;
    }
    frameWindow.postMessage({
      source: 'openchamber-preview-parent',
      version: 1,
      type: 'set-inspect-mode',
      enabled: inspectMode,
    }, window.location.origin);
  }, [bridgeReady, inspectMode]);

  React.useEffect(() => {
    const frameWindow = iframeRef.current?.contentWindow;
    if (!bridgeReady || !frameWindow) {
      return;
    }
    frameWindow.postMessage({
      source: 'openchamber-preview-parent',
      version: 1,
      type: 'set-color-scheme',
      scheme: previewColorScheme,
    }, window.location.origin);
  }, [bridgeReady, previewColorScheme]);

  React.useEffect(() => {
    if (!inspectMode || typeof window === 'undefined') return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        setInspectMode(false);
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [inspectMode]);

  React.useEffect(() => {
    if (!isLoopback || typeof window === 'undefined') {
      return;
    }

    const stringify = (value: unknown): string => {
      if (typeof value === 'string') return value;
      if (value === null || value === undefined) return '';
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    };

    const pushConsoleEvent = (event: Omit<PreviewConsoleEvent, 'id'>) => {
      const id = nextConsoleEventIdRef.current;
      nextConsoleEventIdRef.current += 1;
      setConsoleEvents((current) => {
        const next = [...current, { ...event, id }];
        return next.length > PREVIEW_CONSOLE_EVENT_LIMIT
          ? next.slice(next.length - PREVIEW_CONSOLE_EVENT_LIMIT)
          : next;
      });
    };

    const handler = (event: MessageEvent<PreviewBridgeMessage>) => {
      if (event.source !== iframeRef.current?.contentWindow) {
        return;
      }
      const data = event.data;
      if (!data || data.source !== 'openchamber-preview-bridge' || data.version !== 1) {
        return;
      }

      if (data.type === 'ready') {
        setBridgeReady(true);
        const nextUrl = typeof data.url === 'string' ? data.url : '';
        if (nextUrl) onDisplayNavigate(nextUrl);
        return;
      }

      if (data.type === 'console') {
        const level = data.level === 'error' || data.level === 'warn' || data.level === 'info' || data.level === 'debug'
          ? data.level
          : 'log';
        const args = Array.isArray(data.args) ? data.args.map(stringify).filter(Boolean) : [];
        pushConsoleEvent({
          level,
          message: args.join(' '),
          ts: typeof data.ts === 'number' ? data.ts : Date.now(),
        });
        return;
      }

      if (data.type === 'runtime-error') {
        const filename = stringify(data.filename);
        const line = typeof data.line === 'number' ? data.line : null;
        const column = typeof data.column === 'number' ? data.column : null;
        const location = filename
          ? `${filename}${line !== null ? `:${line}${column !== null ? `:${column}` : ''}` : ''}`
          : '';
        const stack = stringify(data.stack);
        pushConsoleEvent({
          level: 'runtime',
          message: stringify(data.message) || t('contextPanel.preview.console.runtimeError'),
          details: [location, stack].filter(Boolean).join('\n'),
          ts: typeof data.ts === 'number' ? data.ts : Date.now(),
        });
        return;
      }

      if (data.type === 'resource-error') {
        const tag = stringify(data.tag) || 'resource';
        const url = stringify(data.url);
        pushConsoleEvent({
          level: 'resource',
          message: url ? `${tag}: ${url}` : tag,
          details: stringify(data.outerHTML),
          ts: typeof data.ts === 'number' ? data.ts : Date.now(),
        });
        return;
      }

      if (data.type === 'hover') {
        setHoverTarget(isPreviewElementMetadata(data.target) ? data.target : null);
        return;
      }

      if (data.type === 'select' && isPreviewElementMetadata(data.target)) {
        setHoverTarget(data.target);
        setInspectMode(false);
        attachPreviewAnnotation(data.target);
        return;
      }

      if (data.type === 'navigate-preview') {
        const nextUrl = typeof data.url === 'string' ? data.url : '';
        const navigation = data.navigation === 'external'
          ? 'external'
          : data.navigation === 'target'
            ? 'target'
            : 'display';
        if (nextUrl && navigation === 'external') {
          void openExternalUrl(nextUrl);
          return;
        }
        if (nextUrl) {
          if (navigation === 'target') {
            onTargetNavigate(nextUrl);
          } else {
            onDisplayNavigate(nextUrl);
          }
        }
      }
    };

    window.addEventListener('message', handler);
    return () => {
      window.removeEventListener('message', handler);
    };
  }, [attachPreviewAnnotation, isLoopback, onDisplayNavigate, onTargetNavigate, t]);

  const consoleErrorCount = consoleEvents.filter((event) => event.level === 'error' || event.level === 'runtime' || event.level === 'resource').length;
  const filteredConsoleEvents = consoleEvents.filter((event) => getPreviewConsoleFilterMatch(event, consoleFilter));

  const copyConsoleEvents = React.useCallback(() => {
    const header = [
      `Preview URL: ${currentDisplayUrl || effectiveSrc || ''}`,
      `Events: ${consoleEvents.length}`,
      '',
    ].join('\n');
    const text = consoleEvents.map((event) => {
      const timestamp = new Date(event.ts).toISOString();
      const details = event.details ? `\n${event.details}` : '';
      return `[${timestamp}] [${event.level}] ${event.message}${details}`;
    }).join('\n');

    void copyTextToClipboard(`${header}${text}`).then((result) => {
      if (result.ok) {
        toast.success(t('contextPanel.preview.console.copied'));
      } else {
        toast.error(t('contextPanel.preview.console.copyFailed'));
      }
    });
  }, [consoleEvents, currentDisplayUrl, effectiveSrc, t]);

  const attachConsoleEvents = React.useCallback(() => {
    const sessionKey = currentSessionId ?? (currentDraftId ? `draft:${currentDraftId}` : newSessionDraftOpen ? 'draft' : null);
    if (!sessionKey) {
      toast.error(t('contextPanel.preview.console.attachNoSession'));
      return;
    }

    const header = [
      `Preview URL: ${currentDisplayUrl || effectiveSrc || ''}`,
      `Events: ${consoleEvents.length}`,
      '',
    ].join('\n');
    const text = consoleEvents.map((event) => {
      const timestamp = new Date(event.ts).toISOString();
      const details = event.details ? `\n${event.details}` : '';
      return `[${timestamp}] [${event.level}] ${event.message}${details}`;
    }).join('\n');

    addInlineCommentDraft({
      sessionKey,
      source: 'preview-console',
      fileLabel: currentDisplayUrl || effectiveSrc || 'preview',
      startLine: 1,
      endLine: Math.max(1, consoleEvents.length),
      code: `${header}${text}`,
      language: 'text',
      text: t('contextPanel.preview.console.attachAnnotation'),
    });
    toast.success(t('contextPanel.preview.console.attached'));
  }, [addInlineCommentDraft, consoleEvents, currentDisplayUrl, currentDraftId, currentSessionId, effectiveSrc, newSessionDraftOpen, t]);

  // Out-of-band upstream probe: iframes don't expose HTTP status to the parent,
  // so when the proxy returns a 502 (upstream dev server is offline) the iframe
  // would just render the raw JSON error body. Probe the proxy URL with a HEAD
  // request and surface a friendly overlay when the upstream is unreachable.
  type UpstreamState = 'unknown' | 'starting' | 'reachable' | 'unreachable';
  const [upstreamState, setUpstreamState] = React.useState<UpstreamState>('unknown');
  const upstreamProbeStartedAtRef = React.useRef<number>(0);
  const upstreamProbeAttemptRef = React.useRef<number>(0);
  const PREVIEW_STARTUP_GRACE_MS = 15_000;

  React.useEffect(() => {
    if (!proxySrc) {
      setUpstreamState('unknown');
      upstreamProbeStartedAtRef.current = 0;
      upstreamProbeAttemptRef.current = 0;
      return;
    }

    let cancelled = false;
    if (!upstreamProbeStartedAtRef.current) {
      upstreamProbeStartedAtRef.current = Date.now();
      upstreamProbeAttemptRef.current = 0;
    }
    setUpstreamState('unknown');

    void (async () => {
      const probe = async (): Promise<Response | null> => {
        try {
          return await fetch(proxySrc, {
            method: 'GET',
            credentials: 'include',
            cache: 'no-store',
            redirect: 'manual',
          });
        } catch {
          return null;
        }
      };

      const response = await probe();

      if (cancelled) return;

      if (!response) {
        // Network-level failure (e.g. server itself is down) — treat as unreachable.
        setUpstreamState('unreachable');
        return;
      }

      if (response.status === 403 || response.status === 404) {
        previewProxyTargetCache.delete(targetKey);
        setProxyState({ status: 'loading' });
        bumpProxyRegistration();
        return;
      }

      // The proxy emits 502 when the upstream is unreachable. Anything else
      // (including 4xx from the upstream) means the upstream answered.
      if (response.status !== 502) {
        setUpstreamState('reachable');
        return;
      }

      const startedAt = upstreamProbeStartedAtRef.current || Date.now();
      const elapsed = Date.now() - startedAt;
      if (elapsed < PREVIEW_STARTUP_GRACE_MS) {
        // Dev servers can take a moment to bind. During the grace window,
        // keep retrying and show a softer "starting" state.
        setUpstreamState('starting');
        upstreamProbeAttemptRef.current += 1;
        const attempt = upstreamProbeAttemptRef.current;
        const delay = Math.min(2000, 250 * Math.pow(2, Math.min(4, attempt)));
        setTimeout(() => {
          if (!cancelled) {
            bumpProbe();
          }
        }, delay).unref?.();
        return;
      }

      setUpstreamState('unreachable');
    })();

    return () => {
      cancelled = true;
    };
  }, [probeNonce, proxySrc, targetKey]);

  const showUpstreamStarting = isLoopback
    && proxyState.status === 'ready'
    && (upstreamState === 'unknown' || upstreamState === 'starting');

  const showUpstreamUnreachable = isLoopback
    && proxyState.status === 'ready'
    && upstreamState === 'unreachable';

  const handlePreviewFrameLoad = React.useCallback((event: React.SyntheticEvent<HTMLIFrameElement>) => {
    if (!isLoopback || proxyState.status !== 'ready') {
      return;
    }
    if (typeof window === 'undefined') {
      return;
    }

    const frameWindow = event.currentTarget.contentWindow;
    if (!frameWindow) {
      return;
    }

    try {
      const location = frameWindow.location;
      if (location.origin !== window.location.origin) {
        return;
      }
      if (location.pathname.startsWith(proxyState.proxyBasePath)) {
        return;
      }

      const nextPath = `${proxyState.proxyBasePath}${location.pathname}${location.search}${location.hash}`;
      frameWindow.location.replace(nextPath);
    } catch {
      // Cross-origin frames are expected for non-loopback/direct previews.
    }
  }, [isLoopback, proxyState]);

  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="flex items-center gap-1 border-b border-border/40 bg-[var(--surface-background)] px-2 py-1">
        <div className="min-w-0 flex-1 truncate typography-micro text-muted-foreground" title={currentDisplayUrl}>
          {currentDisplayUrl || t('contextPanel.preview.empty')}
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          onClick={reloadPreview}
          title={t('contextPanel.preview.actions.reload')}
          aria-label={t('contextPanel.preview.actions.reload')}
          disabled={!effectiveSrc}
        >
          <RiRefreshLine className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          onClick={() => {
            if (!externalSrc) return;
            void openExternalUrl(externalSrc);
          }}
          title={t('contextPanel.preview.actions.openExternal')}
          aria-label={t('contextPanel.preview.actions.openExternal')}
          disabled={!externalSrc}
        >
          <RiExternalLinkLine className="h-3.5 w-3.5" />
        </Button>
        {isLoopback ? (
          <Button
            type="button"
            size="sm"
            variant={inspectMode ? 'secondary' : 'ghost'}
            className="h-7 gap-1 px-2"
            onClick={() => setInspectMode((value) => !value)}
            title={t('contextPanel.preview.inspect.toggle')}
            aria-label={t('contextPanel.preview.inspect.toggle')}
            disabled={!bridgeReady}
          >
            <RiCursorLine className="h-3.5 w-3.5" />
          </Button>
        ) : null}
        {isLoopback ? (
          <Button
            type="button"
            size="sm"
            variant={consoleOpen ? 'secondary' : 'ghost'}
            className="h-7 gap-1 px-2"
            onClick={() => setConsoleOpen((value) => !value)}
            title={bridgeReady ? t('contextPanel.preview.console.open') : t('contextPanel.preview.console.waiting')}
            aria-label={bridgeReady ? t('contextPanel.preview.console.open') : t('contextPanel.preview.console.waiting')}
            disabled={!bridgeReady && consoleEvents.length === 0}
          >
            <RiTerminalBoxLine className="h-3.5 w-3.5" />
            {consoleErrorCount > 0 ? (
              <span className="typography-micro text-status-error">{consoleErrorCount}</span>
            ) : null}
          </Button>
        ) : null}
      </div>
      <div className="relative min-h-0 flex-1 bg-background">
        {showUpstreamStarting ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground">
            <div>{t('contextPanel.preview.startingServer')}</div>
            <div className="text-xs opacity-70">{t('contextPanel.preview.startingServerHint')}</div>
          </div>
        ) : showUpstreamUnreachable ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground">
            <div>{t('contextPanel.preview.upstreamUnreachable')}</div>
            <div className="text-xs opacity-70">{t('contextPanel.preview.upstreamUnreachableHint')}</div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={reloadPreview}
            >
              {t('contextPanel.preview.actions.retry')}
            </Button>
          </div>
        ) : effectiveSrc && (!isLoopback || upstreamState === 'reachable') ? (
          <div className="relative h-full w-full">
            <iframe
              ref={iframeRef}
              key={intentionalFrameKey}
              src={effectiveSrc}
              title={t('contextPanel.preview.iframeTitle')}
              className="h-full w-full border-0"
              style={{ colorScheme: previewColorScheme }}
              onLoad={handlePreviewFrameLoad}
              sandbox={isLoopback
                ? 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads'
                : 'allow-scripts allow-forms'}
            />
            {inspectMode && hoverTarget ? (
              <div
                className="pointer-events-none absolute rounded-sm border-2 border-[var(--interactive-focus-ring)] bg-[var(--interactive-focus-ring)]/35"
                style={{
                  left: hoverTarget.bounds.x,
                  top: hoverTarget.bounds.y,
                  width: hoverTarget.bounds.width,
                  height: hoverTarget.bounds.height,
                }}
              >
                <div className="absolute -top-6 left-0 max-w-64 truncate rounded bg-[var(--surface-elevated)] px-2 py-0.5 typography-micro text-foreground shadow">
                  {hoverTarget.tag}{hoverTarget.text ? ` · ${hoverTarget.text}` : ''}
                </div>
              </div>
            ) : null}
          </div>
        ) : showLoading ? (
          <div className="flex h-full items-center justify-center px-6 text-sm text-muted-foreground">
            {t('contextPanel.preview.loading')}
          </div>
        ) : showError ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-sm text-muted-foreground">
            <div>{t('contextPanel.preview.proxyError')}</div>
            {proxyState.status === 'error' ? (
              <div className="text-center text-xs opacity-70">{proxyState.message}</div>
            ) : null}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-sm text-muted-foreground">
            {t('contextPanel.preview.invalidUrl')}
          </div>
        )}
        {consoleOpen ? (
          <div className="absolute inset-x-3 bottom-3 z-10 max-h-[45%] overflow-hidden rounded-xl border border-border/70 bg-[var(--surface-elevated)] shadow-lg">
            <div className="flex items-center justify-between border-b border-border/50 px-3 py-2">
              <div className="typography-ui-label text-foreground">{t('contextPanel.preview.console.title')}</div>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={attachConsoleEvents}
                  disabled={consoleEvents.length === 0}
                >
                  {t('contextPanel.preview.console.attach')}
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={copyConsoleEvents}
                  disabled={consoleEvents.length === 0}
                >
                  {t('contextPanel.preview.console.copy')}
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={() => setConsoleEvents([])}
                  disabled={consoleEvents.length === 0}
                >
                  {t('contextPanel.preview.console.clear')}
                </Button>
              </div>
            </div>
            <div className="flex items-center gap-1 border-b border-border/30 px-3 py-1.5">
              {(['all', 'errors', 'warnings', 'logs'] as const).map((filter) => (
                <Button
                  key={filter}
                  type="button"
                  size="xs"
                  variant={consoleFilter === filter ? 'secondary' : 'ghost'}
                  onClick={() => setConsoleFilter(filter)}
                >
                  {filter === 'all'
                    ? t('contextPanel.preview.console.filter.all')
                    : filter === 'errors'
                      ? t('contextPanel.preview.console.filter.errors')
                      : filter === 'warnings'
                        ? t('contextPanel.preview.console.filter.warnings')
                        : t('contextPanel.preview.console.filter.logs')}
                </Button>
              ))}
            </div>
            <div className="max-h-64 overflow-auto p-2 typography-code text-xs">
              {consoleEvents.length === 0 ? (
                <div className="px-2 py-3 text-muted-foreground">{t('contextPanel.preview.console.empty')}</div>
              ) : filteredConsoleEvents.length === 0 ? (
                <div className="px-2 py-3 text-muted-foreground">{t('contextPanel.preview.console.noFilteredEvents')}</div>
              ) : filteredConsoleEvents.map((event) => (
                <div key={event.id} className="border-b border-border/30 px-2 py-1 last:border-b-0">
                  <div className="flex gap-2">
                    <span className={cn(
                      'shrink-0 uppercase',
                      event.level === 'error' || event.level === 'runtime' || event.level === 'resource'
                        ? 'text-status-error'
                        : event.level === 'warn'
                          ? 'text-status-warning'
                          : 'text-muted-foreground'
                    )}>
                      {event.level}
                    </span>
                    <span className="min-w-0 break-words text-foreground">{event.message}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};

export const ContextPanel: React.FC = () => {
  const { t } = useI18n();
  const effectiveDirectory = useEffectiveDirectory() ?? '';
  const directoryKey = React.useMemo(() => normalizeDirectoryKey(effectiveDirectory), [effectiveDirectory]);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentSession = useSession(currentSessionId);
  const currentRootSessionId = React.useMemo(() => {
    if (!currentSessionId) return null;
    const sessions = getAllSyncSessions();
    if (currentSession && !sessions.some((session) => session.id === currentSession.id)) {
      sessions.push(currentSession);
    }
    return resolveRootSessionID(currentSessionId, sessions);
  }, [currentSession, currentSessionId]);
  const currentSessionPlanPath = useSessionPlanFileStore((state) => {
    if (!currentSessionId) {
      return null;
    }

    const record = state.recordsBySession[currentSessionId];
    return record?.status === 'saved' ? record.path : null;
  });

  const panelState = useUIStore((state) => (directoryKey ? state.contextPanelByDirectory[directoryKey] : undefined));
  const contextPlanMotionRequest = useUIStore((state) => state.contextPlanMotionRequest);
  const openContextPlan = useUIStore((state) => state.openContextPlan);
  const closeContextPanel = useUIStore((state) => state.closeContextPanel);
  const closeContextPanelTab = useUIStore((state) => state.closeContextPanelTab);
  const requestContextPanelClose = useUIStore((state) => state.requestContextPanelClose);
  const requestContextPanelTabClose = useUIStore((state) => state.requestContextPanelTabClose);
  const consumeContextPlanMotionRequest = useUIStore((state) => state.consumeContextPlanMotionRequest);
  const toggleContextPanelExpanded = useUIStore((state) => state.toggleContextPanelExpanded);
  const setContextPanelWidth = useUIStore((state) => state.setContextPanelWidth);
  const setActiveContextPanelTab = useUIStore((state) => state.setActiveContextPanelTab);
  const reorderContextPanelTabs = useUIStore((state) => state.reorderContextPanelTabs);
  const setPendingDiffFile = useUIStore((state) => state.setPendingDiffFile);
  const setSelectedFilePath = useFilesViewTabsStore((state) => state.setSelectedPath);
  const openContextPreview = useUIStore((state) => state.openContextPreview);
  const setContextPreviewDisplayUrl = useUIStore((state) => state.setContextPreviewDisplayUrl);
  const leaseIds = useBrowserAgentStore((state) => state.leaseIds);
  const observedLeaseId = useBrowserAgentStore((state) => state.observedLeaseId);
  const { themeMode, lightThemeId, darkThemeId, currentTheme } = useThemeSystem();

  const tabs = React.useMemo(() => panelState?.tabs ?? [], [panelState?.tabs]);
  const activeTab = tabs.find((tab) => tab.id === panelState?.activeTabId) ?? tabs[tabs.length - 1] ?? null;
  const activePreviewTabID = activeTab?.mode === 'preview' ? activeTab.id : null;
  const isOpen = Boolean(panelState?.isOpen && activeTab);
  const isExpanded = Boolean(isOpen && panelState?.expanded);
  const activeLeaseId = isOpen
    && activeTab?.mode === 'browser'
    && activeTab.leaseId
    && leaseIds.includes(activeTab.leaseId)
    ? activeTab.leaseId
    : null;
  const width = clampWidth(panelState?.width ?? CONTEXT_PANEL_DEFAULT_WIDTH);
  const shouldReduceMotion = useReducedMotion() === true
    || (typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  const [isResizing, setIsResizing] = React.useState(false);
  const [planHeaderActionsTarget, setPlanHeaderActionsTarget] = React.useState<HTMLDivElement | null>(null);
  const [activePlanMotion, setActivePlanMotion] = React.useState<ActiveContextPlanMotion | null>(null);
  const startXRef = React.useRef(0);
  const startWidthRef = React.useRef(width);
  const resizingWidthRef = React.useRef<number | null>(null);
  const activeResizePointerIDRef = React.useRef<number | null>(null);
  const panelRef = React.useRef<HTMLElement | null>(null);
  const chatFrameRefs = React.useRef<Map<string, HTMLIFrameElement>>(new Map());
  const wasOpenRef = React.useRef(false);
  const previousSessionIdRef = React.useRef<string | null | undefined>(undefined);

  React.useEffect(() => {
    ensureBrowserAgentListeners();
  }, []);

  React.useEffect(() => {
    void setObservedBrowserAgentLease(activeLeaseId);
  }, [activeLeaseId]);

  React.useEffect(() => () => {
    void setObservedBrowserAgentLease(null);
  }, []);

  React.useLayoutEffect(() => {
    if (!directoryKey) {
      return;
    }

    const staleLeaseTabIDs = getStaleBrowserLeaseTabIDs(tabs, currentRootSessionId);
    for (const staleTabID of staleLeaseTabIDs) {
      closeContextPanelTab(directoryKey, staleTabID);
    }
  }, [closeContextPanelTab, currentRootSessionId, directoryKey, tabs]);

  const finalizePlanExit = React.useCallback((motion: ActiveContextPlanMotion) => {
    if (!directoryKey) {
      return;
    }

    if (motion.closeTabID) {
      closeContextPanelTab(directoryKey, motion.closeTabID);
      return;
    }

    closeContextPanel(directoryKey);
  }, [closeContextPanel, closeContextPanelTab, directoryKey]);

  React.useLayoutEffect(() => {
    if (!contextPlanMotionRequest || contextPlanMotionRequest.directory !== directoryKey) {
      return;
    }

    consumeContextPlanMotionRequest(contextPlanMotionRequest.id);

    if (!isOpen || activeTab?.mode !== 'plan') {
      setActivePlanMotion(null);
      return;
    }

    const motion: ActiveContextPlanMotion = {
      requestID: contextPlanMotionRequest.id,
      direction: contextPlanMotionRequest.direction,
      closeTabID: contextPlanMotionRequest.closeTabID,
    };

    if (shouldReduceMotion) {
      setActivePlanMotion(null);
      if (motion.direction === 'exit') {
        finalizePlanExit(motion);
      }
      return;
    }

    setActivePlanMotion(motion);
  }, [
    activeTab?.mode,
    consumeContextPlanMotionRequest,
    contextPlanMotionRequest,
    directoryKey,
    finalizePlanExit,
    isOpen,
    shouldReduceMotion,
  ]);

  React.useLayoutEffect(() => {
    if (!activePlanMotion) {
      return;
    }

    if (!isOpen || activeTab?.mode !== 'plan') {
      setActivePlanMotion(null);
      return;
    }

    if (!shouldReduceMotion) {
      return;
    }

    setActivePlanMotion(null);
    if (activePlanMotion.direction === 'exit') {
      finalizePlanExit(activePlanMotion);
    }
  }, [activePlanMotion, activeTab?.mode, finalizePlanExit, isOpen, shouldReduceMotion]);

  React.useLayoutEffect(() => {
    const previousSessionId = previousSessionIdRef.current;
    previousSessionIdRef.current = currentSessionId;

    if (!directoryKey) {
      return;
    }

    const action = resolveContextPlanSessionChange({
      previousSessionId,
      currentSessionId,
      isPanelOpen: isOpen,
      activeMode: activeTab?.mode ?? null,
      activeTargetPath: activeTab?.mode === 'plan' ? activeTab.targetPath : null,
      ownerSessionId: activeTab?.mode === 'plan' ? activeTab.ownerSessionId : null,
      currentSessionPlanPath,
      sessions: getAllSyncSessions(),
      managedTasks: Object.values(useManagedOrchestrationStore.getState().tasksById),
    });

    if (action === 'replace' && currentSessionId && currentSessionPlanPath) {
      openContextPlan(directoryKey, currentSessionPlanPath, currentSessionId);
      return;
    }

    if (action !== 'collapse') {
      return;
    }

    closeContextPanel(directoryKey);
  }, [
    activeTab?.mode,
    activeTab?.ownerSessionId,
    activeTab?.targetPath,
    closeContextPanel,
    currentSessionId,
    currentSessionPlanPath,
    directoryKey,
    isOpen,
    openContextPlan,
  ]);

  React.useEffect(() => {
    if (!isOpen || wasOpenRef.current) {
      wasOpenRef.current = isOpen;
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      panelRef.current?.focus({ preventScroll: true });
    });

    wasOpenRef.current = true;
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen]);

  const applyLiveWidth = React.useCallback((nextWidth: number) => {
    const panel = panelRef.current;
    if (!panel) {
      return;
    }

    panel.style.setProperty('--oc-context-panel-width', `${nextWidth}px`);
  }, []);

  const handleResizeStart = React.useCallback((event: React.PointerEvent) => {
    if (!isOpen || isExpanded || !directoryKey) {
      return;
    }

    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // ignore; fallback listeners still handle drag
    }

    activeResizePointerIDRef.current = event.pointerId;
    setIsResizing(true);
    startXRef.current = event.clientX;
    startWidthRef.current = width;
    resizingWidthRef.current = width;
    applyLiveWidth(width);
    event.preventDefault();
  }, [applyLiveWidth, directoryKey, isExpanded, isOpen, width]);

  const handleResizeMove = React.useCallback((event: React.PointerEvent) => {
    if (!isResizing || activeResizePointerIDRef.current !== event.pointerId) {
      return;
    }

    const delta = startXRef.current - event.clientX;
    const nextWidth = clampWidth(startWidthRef.current + delta);
    if (resizingWidthRef.current === nextWidth) {
      return;
    }

    resizingWidthRef.current = nextWidth;
    applyLiveWidth(nextWidth);
  }, [applyLiveWidth, isResizing]);

  const handleResizeEnd = React.useCallback((event: React.PointerEvent) => {
    if (activeResizePointerIDRef.current !== event.pointerId || !directoryKey) {
      return;
    }

    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // ignore
    }

    const finalWidth = resizingWidthRef.current ?? width;
    setIsResizing(false);
    activeResizePointerIDRef.current = null;
    resizingWidthRef.current = null;
    setContextPanelWidth(directoryKey, finalWidth);
  }, [directoryKey, setContextPanelWidth, width]);

  React.useEffect(() => {
    if (!isResizing) {
      resizingWidthRef.current = null;
    }
  }, [isResizing]);

  const handleClose = React.useCallback(() => {
    if (!directoryKey) {
      return;
    }
    requestContextPanelClose(directoryKey);
  }, [directoryKey, requestContextPanelClose]);

  const handlePlanMotionEnd = React.useCallback((event: React.AnimationEvent<HTMLElement>) => {
    if (!activePlanMotion || event.currentTarget !== event.target) {
      return;
    }

    const expectedAnimationName = activePlanMotion.direction === 'enter'
      ? CONTEXT_PLAN_ENTER_ANIMATION_NAME
      : CONTEXT_PLAN_EXIT_ANIMATION_NAME;
    if (event.animationName !== expectedAnimationName) {
      return;
    }

    setActivePlanMotion(null);
    if (activePlanMotion.direction === 'exit') {
      finalizePlanExit(activePlanMotion);
    }
  }, [activePlanMotion, finalizePlanExit]);

  const handleToggleExpanded = React.useCallback(() => {
    if (!directoryKey) {
      return;
    }
    toggleContextPanelExpanded(directoryKey);
  }, [directoryKey, toggleContextPanelExpanded]);

  const handlePanelKeyDownCapture = React.useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    handleClose();
  }, [handleClose]);

  React.useEffect(() => {
    if (!directoryKey || !activeTab) {
      return;
    }

    if (activeTab.mode === 'file' && activeTab.targetPath) {
      setSelectedFilePath(directoryKey, activeTab.targetPath);
      return;
    }

    if (activeTab.mode === 'diff' && activeTab.targetPath) {
      setPendingDiffFile(activeTab.targetPath);
    }
  }, [activeTab, directoryKey, setPendingDiffFile, setSelectedFilePath]);

  const handlePreviewDisplayNavigate = React.useCallback((url: string) => {
    if (!directoryKey || !activePreviewTabID) return;
    setContextPreviewDisplayUrl(directoryKey, activePreviewTabID, url);
  }, [activePreviewTabID, directoryKey, setContextPreviewDisplayUrl]);

  const handlePreviewTargetNavigate = React.useCallback((url: string) => {
    if (!directoryKey) return;
    openContextPreview(directoryKey, url);
  }, [directoryKey, openContextPreview]);

  const activeChatTabID = activeTab?.mode === 'chat' ? activeTab.id : null;

  const postThemeSyncToEmbeddedChat = React.useCallback(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const payload = {
      themeMode,
      lightThemeId,
      darkThemeId,
      currentTheme,
    };

    for (const frame of chatFrameRefs.current.values()) {
      const frameWindow = frame.contentWindow;
      if (!frameWindow) {
        continue;
      }

      const directThemeSync = (frameWindow as unknown as {
        __openchamberApplyThemeSync?: (themePayload: typeof payload) => void;
      }).__openchamberApplyThemeSync;

      if (typeof directThemeSync === 'function') {
        try {
          directThemeSync(payload);
          continue;
        } catch {
          // fallback to postMessage below
        }
      }

      frameWindow.postMessage(
        {
          type: 'openchamber:theme-sync',
          payload,
        },
        window.location.origin,
      );
    }
  }, [currentTheme, darkThemeId, lightThemeId, themeMode]);

  const postEmbeddedVisibilityToChats = React.useCallback(() => {
    if (typeof window === 'undefined') {
      return;
    }

    for (const [tabID, frame] of chatFrameRefs.current.entries()) {
      const frameWindow = frame.contentWindow;
      if (!frameWindow) {
        continue;
      }

      const payload = { visible: activeChatTabID === tabID };
      const directVisibilitySync = (frameWindow as unknown as {
        __openchamberSetEmbeddedVisibility?: (visibilityPayload: typeof payload) => void;
      }).__openchamberSetEmbeddedVisibility;

      if (typeof directVisibilitySync === 'function') {
        try {
          directVisibilitySync(payload);
          continue;
        } catch {
          // fallback to postMessage below
        }
      }

      frameWindow.postMessage(
        {
          type: 'openchamber:embedded-visibility',
          payload,
        },
        window.location.origin,
      );
    }
  }, [activeChatTabID]);

  React.useLayoutEffect(() => {
    const hasAnyChatTab = tabs.some((tab) => tab.mode === 'chat');
    if (!hasAnyChatTab) {
      return;
    }

    postThemeSyncToEmbeddedChat();
    postEmbeddedVisibilityToChats();
  }, [darkThemeId, lightThemeId, postEmbeddedVisibilityToChats, postThemeSyncToEmbeddedChat, tabs, themeMode]);

  const tabItems = React.useMemo(() => tabs.map((tab) => {
    const rawLabel = getTabLabel(tab, t);
    const label = truncateTabLabel(rawLabel, CONTEXT_TAB_LABEL_MAX_CHARS);
    const tabPathLabel = getRelativePathLabel(tab.targetPath, effectiveDirectory);
    return {
      id: tab.id,
      label,
      icon: getTabIcon(tab),
      title: tabPathLabel ? `${rawLabel}: ${tabPathLabel}` : rawLabel,
      closeLabel: t('contextPanel.tab.closeTabAria', { label }),
    };
  }), [effectiveDirectory, t, tabs]);

  const activeNonChatContent = activeTab?.mode === 'diff'
    ? (
      <LazyViewBoundary>
        <LazyDiffView hideStackedFileSidebar stackedDefaultCollapsedAll hideFileSelector pinSelectedFileHeaderToTopOnNavigate showOpenInEditorAction />
      </LazyViewBoundary>
    )
    : activeTab?.mode === 'context'
        ? <ContextPanelContent />
        : activeTab?.mode === 'plan'
            ? (
              <LazyViewBoundary>
                <LazyPlanView
                  key={`${activeTab.ownerSessionId ?? ''}:${activeTab.targetPath ?? ''}`}
                  targetPath={activeTab.targetPath}
                  presentation="context-panel"
                  headerActionsTarget={planHeaderActionsTarget}
                />
              </LazyViewBoundary>
            )
            : activeTab?.mode === 'preview'
                ? (
                  <PreviewPane
                    tabID={activeTab.id}
                    targetUrl={activeTab.targetPath ?? ''}
                    displayUrl={activeTab.displayUrl ?? activeTab.targetPath ?? ''}
                    onDisplayNavigate={handlePreviewDisplayNavigate}
                    onTargetNavigate={handlePreviewTargetNavigate}
                  />
                )
                : (
                  <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
                    <RiGlobalLine className="h-12 w-12 text-muted-foreground/50" />
                    <div className="typography-ui-header text-foreground">{t('contextPanel.preview.title')}</div>
                    <div className="max-w-sm typography-micro text-muted-foreground">{t('contextPanel.preview.description')}</div>
                  </div>
                );

  const chatTabs = React.useMemo(
    () => tabs.filter((tab) => tab.mode === 'chat'),
    [tabs],
  );
  const manualBrowserTabs = React.useMemo(
    () => tabs.filter((tab) => tab.mode === 'browser' && !tab.leaseId),
    [tabs],
  );

  // Manual browser guests retain the existing sleep policy. Lease guests are
  // not part of this set: the invariant lease fleet mounts directly from the
  // authoritative snapshot and unmounts only when a lease disappears.
  const manualBrowserKeepIDs = React.useMemo(
    () => (isOpen && activeTab?.mode === 'browser' && !activeTab.leaseId ? [activeTab.id] : []),
    [activeTab, isOpen],
  );
  const retainedBrowserTabIDs = useGuestRetention({
    keepIDs: manualBrowserKeepIDs,
    sleepDelayMs: BROWSER_GUEST_SLEEP_DELAY_MS,
  });

  const chatKeepIDs = React.useMemo(
    () => (activeChatTabID ? [activeChatTabID] : []),
    [activeChatTabID],
  );
  const retainedChatTabIDs = useGuestRetention({
    keepIDs: chatKeepIDs,
    sleepDelayMs: CHAT_GUEST_SLEEP_DELAY_MS,
  });
  const hasFileTabs = React.useMemo(
    () => tabs.some((tab) => tab.mode === 'file'),
    [tabs],
  );

  const isFileTabActive = activeTab?.mode === 'file';
  const isBrowserTabActive = activeTab?.mode === 'browser';

  const header = (
    <header className="flex h-8 items-stretch pl-1.5">
      <SortableTabsStrip
        items={tabItems}
        activeId={activeTab?.id ?? null}
        onSelect={(tabID) => {
          if (!directoryKey) {
            return;
          }
          setActiveContextPanelTab(directoryKey, tabID);
        }}
        onClose={(tabID) => {
          if (!directoryKey) {
            return;
          }
          requestContextPanelTabClose(directoryKey, tabID);
        }}
        onReorder={(activeTabID, overTabID) => {
          if (!directoryKey) {
            return;
          }
          reorderContextPanelTabs(directoryKey, activeTabID, overTabID);
        }}
        layoutMode="scrollable"
        variant="soft-pill"
      />
      <div className="flex items-center gap-1 px-1.5">
        {activeTab?.mode === 'plan' ? (
          <div
            ref={setPlanHeaderActionsTarget}
            className="flex min-w-0 shrink-0 items-center"
            data-context-plan-actions="true"
          />
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleToggleExpanded}
          className="h-7 w-7 p-0"
          title={isExpanded ? t('contextPanel.actions.collapsePanel') : t('contextPanel.actions.expandPanel')}
          aria-label={isExpanded ? t('contextPanel.actions.collapsePanel') : t('contextPanel.actions.expandPanel')}
        >
          {isExpanded ? <RiFullscreenExitLine className="h-3.5 w-3.5" /> : <RiFullscreenLine className="h-3.5 w-3.5" />}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleClose}
          className="h-7 w-7 p-0"
          title={t('contextPanel.actions.closePanel')}
          aria-label={t('contextPanel.actions.closePanel')}
        >
          <RiCloseLine className="h-3.5 w-3.5" />
        </Button>
      </div>
    </header>
  );

  const panelStyle: React.CSSProperties = !isOpen
    ? {
        width: '100%',
        minWidth: '100%',
        maxWidth: '100%',
      }
    : isExpanded
    ? {
        ['--oc-context-panel-width' as string]: '100%',
        width: '100%',
        minWidth: '100%',
        maxWidth: '100%',
      }
    : {
        width: 'var(--oc-context-panel-width)',
        minWidth: 'var(--oc-context-panel-width)',
        maxWidth: 'var(--oc-context-panel-width)',
        ['--oc-context-panel-width' as string]: `${isResizing ? (resizingWidthRef.current ?? width) : width}px`,
      };

  return (
    <aside
      ref={panelRef}
      data-context-panel="true"
      data-plan-motion={activePlanMotion?.direction}
      aria-hidden={!isOpen}
      tabIndex={-1}
      className={cn(
        'flex min-h-0 flex-col overflow-hidden bg-background',
        !isOpen
          ? 'pointer-events-none fixed inset-0 -z-10 opacity-0'
          : isExpanded
            ? 'absolute inset-0 z-20 min-w-0'
            : 'relative h-full flex-shrink-0 border-l border-border/40',
        isResizing ? 'transition-none' : 'transition-[width] duration-200 ease-in-out'
      )}
      onKeyDownCapture={handlePanelKeyDownCapture}
      onAnimationEnd={handlePlanMotionEnd}
      style={panelStyle}
    >
      {isOpen && !isExpanded && (
        <div
          className={cn(
            'absolute left-0 top-0 z-20 h-full w-[3px] cursor-col-resize transition-colors hover:bg-[var(--interactive-border)]/80',
            isResizing && 'bg-[var(--interactive-border)]'
          )}
          onPointerDown={handleResizeStart}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeEnd}
          onPointerCancel={handleResizeEnd}
          role="separator"
          aria-orientation="vertical"
          aria-label={t('contextPanel.actions.resizePanelAria')}
        />
      )}
      <div
        data-context-panel-content="true"
        className={cn(
          'flex min-h-0 flex-1 flex-col',
          activePlanMotion?.direction === 'exit' && 'pointer-events-none'
        )}
      >
        {isOpen ? header : null}
        <div className={cn('relative min-h-0 flex-1 overflow-hidden', isResizing && 'pointer-events-none')}>
          {isOpen && hasFileTabs ? (
            <div className={cn('absolute inset-0', isFileTabActive ? 'block' : 'hidden')}>
              <LazyViewBoundary>
                <LazyFilesView />
              </LazyViewBoundary>
            </div>
          ) : null}
          {leaseIds.map((leaseId) => (
            <BrowserLeasePane
              key={leaseId}
              leaseId={leaseId}
              active={activeLeaseId === leaseId && observedLeaseId === leaseId}
            />
          ))}
          {manualBrowserTabs.map((tab) => {
            // Manual tabs remain ordinary user browser panes: only the active
            // tab and its short grace-period guest stay mounted.
            const isActive = isOpen && activeTab?.id === tab.id;
            const isMounted = isActive || retainedBrowserTabIDs.has(tab.id);
            if (!isMounted) {
              return null;
            }
            return (
              <div
                key={tab.id}
                className={cn(
                  'absolute inset-0',
                  !isActive && 'invisible pointer-events-none'
                )}
                aria-hidden={!isActive}
              >
                {isElectronShell() ? (
                  <DesktopBrowserPane
                    initialUrl={tab.targetPath ?? ''}
                    directory={directoryKey ?? ''}
                    tabID={tab.id}
                    active={isActive}
                  />
                ) : (
                  <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
                    <RiGlobalLine className="h-12 w-12 text-muted-foreground/50" />
                    <div className="max-w-sm typography-micro text-muted-foreground">{t('contextPanel.browser.desktopOnly')}</div>
                  </div>
                )}
              </div>
            );
          })}
          {isOpen ? chatTabs.map((tab) => {
            const sessionID = getSessionIDFromDedupeKey(tab.dedupeKey);
            if (!sessionID) {
              return null;
            }

            // Each chat iframe hosts a full app instance. Keep the active tab
            // plus recently-used ones mounted; long-idle tabs unmount (their
            // chat state is store/server-backed and rebuilds on remount).
            if (activeChatTabID !== tab.id && !retainedChatTabIDs.has(tab.id)) {
              return null;
            }

            const src = buildEmbeddedSessionChatURL(sessionID, directoryKey || null);
            if (!src) {
              return null;
            }

            return (
              <iframe
                key={tab.id}
                ref={(node) => {
                  if (!node) {
                    chatFrameRefs.current.delete(tab.id);
                    return;
                  }
                  chatFrameRefs.current.set(tab.id, node);
                }}
                src={src}
                title={t('contextPanel.iframe.sessionChatTitle', { sessionID })}
                className={cn(
                  'absolute inset-0 h-full w-full border-0 bg-background',
                  activeChatTabID === tab.id ? 'block' : 'hidden'
                )}
                onLoad={() => {
                  postThemeSyncToEmbeddedChat();
                  postEmbeddedVisibilityToChats();
                }}
              />
            );
          }) : null}
          {isOpen && activeTab?.mode !== 'chat' && !isFileTabActive && !isBrowserTabActive
            ? activeNonChatContent
            : null}
        </div>
      </div>
    </aside>
  );
};
