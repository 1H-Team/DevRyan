import { BaseWindow, WebContentsView } from 'electron';

import {
  BROWSER_WEBVIEW_PARTITION,
  isAllowedWebviewNavigationUrl,
} from './browser-webview-policy.mjs';
import { isBenignNavigationAbort } from './browser-navigation-error.mjs';

const DEFAULT_WIDTH = 1180;
const DEFAULT_HEIGHT = 760;
const DEFAULT_TOOLBAR_HEIGHT = 38;
const DEFAULT_BROWSER_WORKSPACE_CHROME_HEIGHT = 70;
const MAX_SURFACE_ID_LENGTH = 220;
const MAX_FAVICON_URL_LENGTH = 32_768;
const AGENT_OBSERVATION_FRAME_INTERVAL_MS = 125;
const AGENT_OBSERVATION_MAX_WIDTH = 1280;
const AGENT_OBSERVATION_MAX_HEIGHT = 720;
const AGENT_OBSERVATION_JPEG_QUALITY = 65;

export const BROWSER_VIEWPORT_PRESETS = Object.freeze({
  desktop: Object.freeze({ width: 1440, height: 900 }),
  mobile: Object.freeze({ width: 390, height: 844 }),
});

export const sanitizeBrowserViewportMode = (value) => (
  value === 'desktop' || value === 'mobile' ? value : 'responsive'
);

export const resolveBrowserEmulation = (viewportMode, bounds) => {
  const mode = sanitizeBrowserViewportMode(viewportMode);
  if (mode === 'responsive') return { mode, bounds, parameters: null };
  const preset = BROWSER_VIEWPORT_PRESETS[mode];
  const scale = Math.min(1, bounds.width / preset.width, bounds.height / preset.height);
  const width = Math.max(1, Math.floor(preset.width * scale));
  const height = Math.max(1, Math.floor(preset.height * scale));
  return {
    mode,
    bounds: {
      x: bounds.x + Math.max(0, Math.floor((bounds.width - width) / 2)),
      y: bounds.y + Math.max(0, Math.floor((bounds.height - height) / 2)),
      width,
      height,
    },
    parameters: {
      screenPosition: mode === 'mobile' ? 'mobile' : 'desktop',
      screenSize: preset,
      viewPosition: { x: 0, y: 0 },
      deviceScaleFactor: 0,
      viewSize: preset,
      scale,
    },
  };
};

const BROWSER_INSPECT_CANCEL_SCRIPT = `(() => {
  if (typeof window.__devryanBrowserCancelInspect === 'function') {
    window.__devryanBrowserCancelInspect();
  }
  document.getElementById('__devryan_browser_inspect_overlay')?.remove();
})()`;

const BROWSER_INSPECT_SCRIPT = `new Promise((resolve) => {
  if (typeof window.__devryanBrowserCancelInspect === 'function') {
    try { window.__devryanBrowserCancelInspect(); } catch {}
  }
  const overlay = document.createElement('div');
  overlay.id = '__devryan_browser_inspect_overlay';
  overlay.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #60a5fa;background:rgba(96,165,250,.24);border-radius:3px;display:none;box-sizing:border-box;';
  document.documentElement.appendChild(overlay);
  const cssEscape = (value) => {
    try { return CSS.escape(value); } catch { return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); }
  };
  const selectorPart = (element) => {
    const tag = element.tagName.toLowerCase();
    if (element.id) return tag + '#' + cssEscape(element.id);
    const classes = String(element.className || '').trim().split(/\s+/).filter(Boolean).slice(0, 3);
    return tag + classes.map((part) => '.' + cssEscape(part)).join('');
  };
  const metadata = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const ancestry = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && ancestry.length < 8) {
      ancestry.unshift({
        tag: current.tagName.toLowerCase(),
        id: current.id || undefined,
        className: typeof current.className === 'string' ? current.className : undefined,
        selectorPart: selectorPart(current),
      });
      current = current.parentElement;
    }
    const attributes = {};
    for (const attr of Array.from(element.attributes || []).slice(0, 16)) {
      attributes[attr.name] = attr.value.slice(0, 300);
    }
    const path = ancestry.map((entry) => entry.selectorPart).join(' > ');
    return {
      frame: 'top',
      tag: element.tagName.toLowerCase(),
      text: String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500),
      outerHTML: String(element.outerHTML || '').replace(/\\0/g, '').trim().slice(0, 6000),
      selector: element.id ? '#' + cssEscape(element.id) : path,
      path,
      bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      center: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
      attributes,
      computedStyle: {
        display: style.display,
        position: style.position,
        fontWeight: style.fontWeight,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        fontFamily: style.fontFamily,
        color: style.color,
        backgroundColor: style.backgroundColor,
        zIndex: style.zIndex,
      },
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
    if (window.__devryanBrowserCancelInspect === cancel) delete window.__devryanBrowserCancelInspect;
  };
  const cancel = () => { cleanup(); overlay.remove(); resolve(null); };
  const click = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const element = document.elementFromPoint(event.clientX, event.clientY);
    cleanup();
    overlay.remove();
    await new Promise((resolvePaint) => requestAnimationFrame(() => requestAnimationFrame(resolvePaint)));
    resolve(element ? {
      target: metadata(element),
      viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio || 1 },
    } : null);
  };
  const keydown = (event) => { if (event.key === 'Escape') cancel(); };
  window.__devryanBrowserCancelInspect = cancel;
  window.addEventListener('mousemove', move, true);
  window.addEventListener('click', click, true);
  window.addEventListener('keydown', keydown, true);
})`;

const safeString = (value, maxLength = 8192) => (
  typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
);

export const normalizeBrowserSurfaceUrl = (value) => {
  const raw = safeString(value);
  if (!raw || raw === 'about:blank') return 'about:blank';
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed.toString()
      : 'about:blank';
  } catch {
    return 'about:blank';
  }
};

const requireBrowserSurfaceUrl = (value) => {
  const raw = safeString(value);
  if (raw === 'about:blank') return raw;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.toString();
  } catch {
  }
  throw new Error('Browser surface URL must be about:blank or HTTP(S)');
};

const normalizeSurfaceId = (value) => {
  const id = safeString(value, MAX_SURFACE_ID_LENGTH);
  if (!id || id.includes('\u0000')) throw new Error('Browser surface id is required');
  return id;
};

const isAliveWindow = (window) => Boolean(window && !window.isDestroyed?.());

const navigationState = (contents) => {
  const history = contents?.navigationHistory;
  const canGoBack = typeof history?.canGoBack === 'function'
    ? history.canGoBack()
    : Boolean(contents?.canGoBack?.());
  const canGoForward = typeof history?.canGoForward === 'function'
    ? history.canGoForward()
    : Boolean(contents?.canGoForward?.());
  return { canGoBack, canGoForward };
};

const navigateHistory = (contents, action) => {
  const history = contents?.navigationHistory;
  if (action === 'back') {
    if (!navigationState(contents).canGoBack) return;
    if (typeof history?.goBack === 'function') history.goBack();
    else contents?.goBack?.();
    return;
  }
  if (action === 'forward') {
    if (!navigationState(contents).canGoForward) return;
    if (typeof history?.goForward === 'function') history.goForward();
    else contents?.goForward?.();
    return;
  }
  if (action === 'reload') contents?.reload?.();
};

const normalizeBounds = (rawBounds, ownerWindow) => {
  const contentBounds = ownerWindow?.getContentBounds?.();
  const ownerWidth = Number.isFinite(contentBounds?.width) ? Math.max(1, Math.floor(contentBounds.width)) : null;
  const ownerHeight = Number.isFinite(contentBounds?.height) ? Math.max(1, Math.floor(contentBounds.height)) : null;
  if (ownerWidth === null || ownerHeight === null) throw new Error('Browser window bounds are unavailable');

  const x = Number.isFinite(rawBounds?.x) ? Math.max(0, Math.floor(rawBounds.x)) : null;
  const y = Number.isFinite(rawBounds?.y) ? Math.max(0, Math.floor(rawBounds.y)) : null;
  const width = Number.isFinite(rawBounds?.width) ? Math.max(1, Math.floor(rawBounds.width)) : null;
  const height = Number.isFinite(rawBounds?.height) ? Math.max(1, Math.floor(rawBounds.height)) : null;
  if (x === null || y === null || width === null || height === null) {
    throw new Error('Browser surface bounds are required');
  }

  const clampedX = Math.min(x, ownerWidth - 1);
  const clampedY = Math.min(y, ownerHeight - 1);
  return {
    x: clampedX,
    y: clampedY,
    width: Math.min(width, ownerWidth - clampedX),
    height: Math.min(height, ownerHeight - clampedY),
  };
};

const createParkingWindow = () => {
  const parkingWindow = new BaseWindow({
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    show: false,
  });
  parkingWindow.__ocBrowserParking = true;
  return parkingWindow;
};

const installCursorOverlay = async (contents, input, visible) => {
  if (!contents || contents.isDestroyed?.()) return;
  const payload = JSON.stringify({ input, visible });
  const script = `(() => {
    const payload = ${payload};
    const id = '__devryan_agent_browser_cursor';
    let cursor = document.getElementById(id);
    if (!payload.visible) {
      if (cursor) {
        cursor.style.display = 'none';
        if (cursor.__devryanHideTimer) clearTimeout(cursor.__devryanHideTimer);
        cursor.__devryanHideTimer = null;
      }
      return;
    }
    if (!cursor) {
      cursor = document.createElement('div');
      cursor.id = id;
      cursor.setAttribute('aria-hidden', 'true');
      cursor.style.cssText = 'position:fixed;z-index:2147483647;width:28px;height:32px;pointer-events:none;transform-origin:0 0;transition:left 35ms linear,top 35ms linear,transform 70ms ease-out;display:none;filter:drop-shadow(0 2px 2px rgba(0,0,0,.42));';
      cursor.innerHTML = '<svg viewBox="0 0 28 32" width="28" height="32" overflow="visible" xmlns="http://www.w3.org/2000/svg"><path d="M0 0v24.8l6.15-6.3 4.55 9.35 4.5-2.2-4.45-9.05H20z" fill="#fff" stroke="#202124" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/></svg>';
      document.documentElement.appendChild(cursor);
    }
    const point = payload.input || {};
    if (Number.isFinite(point.x) && Number.isFinite(point.y)) {
      cursor.style.left = point.x + 'px';
      cursor.style.top = point.y + 'px';
      cursor.style.display = 'block';
      cursor.style.transform = point.kind === 'down'
        ? 'scale(.9)'
        : 'scale(1)';
    }
    if (cursor.style.display !== 'none') {
      if (cursor.__devryanHideTimer) clearTimeout(cursor.__devryanHideTimer);
      cursor.__devryanHideTimer = setTimeout(() => {
        cursor.style.display = 'none';
        cursor.__devryanHideTimer = null;
      }, 4000);
    }
  })()`;
  try {
    await contents.executeJavaScriptInIsolatedWorld?.(991, [{ code: script }], false);
  } catch {
  }
};

export const createBrowserSurfaceManager = ({
  createPopoutWindow,
  emitToWindow,
  getWindowById,
  devToolsController,
  onLeaseMetadata,
  onLeaseSurfaceDestroyed,
  getManualBrowserContext = () => null,
  shouldQuit = () => false,
  log = () => {},
} = {}) => {
  if (typeof createPopoutWindow !== 'function') throw new Error('createPopoutWindow is required');
  if (typeof emitToWindow !== 'function') throw new Error('emitToWindow is required');
  if (typeof getWindowById !== 'function') throw new Error('getWindowById is required');

  const surfaces = new Map();
  const manualSurfaceByHomeAndTab = new Map();
  const leaseSurfaceByLeaseId = new Map();
  const manualWorkspaces = new Map();
  let surfaceCounter = 0;
  let parkingWindow = null;

  const ensureParkingWindow = () => {
    if (!isAliveWindow(parkingWindow)) parkingWindow = createParkingWindow();
    return parkingWindow;
  };

  const snapshot = (surface) => {
    const contents = surface.view.webContents;
    const { canGoBack, canGoForward } = navigationState(contents);
    const currentUrl = safeString(contents.getURL?.()) || surface.url || 'about:blank';
    return {
      surfaceId: surface.surfaceId,
      kind: surface.kind,
      ...(surface.leaseId ? { leaseId: surface.leaseId } : {}),
      ...(surface.workspaceId ? { workspaceId: surface.workspaceId } : {}),
      ...(surface.tabId ? { tabId: surface.tabId } : {}),
      placement: surface.placement,
      viewportMode: surface.viewportMode,
      url: currentUrl,
      title: safeString(contents.getTitle?.(), 1024),
      faviconUrl: surface.faviconUrl,
      loading: Boolean(contents.isLoading?.()),
      canGoBack,
      canGoForward,
      devToolsOpen: Boolean(devToolsController?.isOpen?.(contents.id) || contents.isDevToolsOpened?.()),
    };
  };

  const emitSnapshot = (surface) => {
    const detail = snapshot(surface);
    const targets = new Set([surface.homeWindowId, surface.popoutWindow?.id]);
    for (const windowId of targets) {
      if (!Number.isInteger(windowId)) continue;
      const target = getWindowById(windowId);
      if (isAliveWindow(target)) emitToWindow(target, 'browser-surface-updated', detail);
    }
    return detail;
  };

  const detachView = (surface) => {
    const current = surface.attachedWindow;
    if (!isAliveWindow(current)) {
      surface.attachedWindow = null;
      return;
    }
    try { current.contentView?.removeChildView?.(surface.view); } catch { }
    surface.attachedWindow = null;
  };

  const applyViewportMode = (surface, bounds) => {
    const emulation = resolveBrowserEmulation(surface.viewportMode, bounds);
    surface.view.setBounds(emulation.bounds);
    if (emulation.parameters) {
      surface.view.webContents.enableDeviceEmulation?.(emulation.parameters);
    } else {
      surface.view.webContents.disableDeviceEmulation?.();
    }
  };

  const attachView = (surface, ownerWindow, bounds) => {
    if (!isAliveWindow(ownerWindow)) throw new Error('Browser window is not available');
    const nextBounds = normalizeBounds(bounds, ownerWindow);
    if (surface.attachedWindow !== ownerWindow) {
      detachView(surface);
      ownerWindow.contentView.addChildView(surface.view);
      surface.attachedWindow = ownerWindow;
    }
    applyViewportMode(surface, nextBounds);
    surface.lastBounds = nextBounds;
    surface.view.setVisible?.(true);
    surface.view.webContents.setBackgroundThrottling?.(false);
    return nextBounds;
  };

  const park = (surface) => {
    const owner = ensureParkingWindow();
    const bounds = surface.lastBounds || { x: 0, y: 0, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
    if (surface.attachedWindow !== owner) {
      detachView(surface);
      owner.contentView.addChildView(surface.view);
      surface.attachedWindow = owner;
    }
    surface.view.setBounds({ x: 0, y: 0, width: Math.max(1, bounds.width), height: Math.max(1, bounds.height) });
    surface.view.setVisible?.(surface.kind === 'lease');
    if (surface.kind === 'lease' && !surface.frameSubscriptionActive && typeof surface.view.webContents.beginFrameSubscription === 'function') {
      surface.view.webContents.beginFrameSubscription(true, () => {});
      surface.frameSubscriptionActive = true;
    }
  };

  const stopParkingCapture = (surface) => {
    if (!surface.frameSubscriptionActive) return;
    surface.view.webContents.endFrameSubscription?.();
    surface.frameSubscriptionActive = false;
  };

  const configureContents = (surface) => {
    const contents = surface.view.webContents;
    contents.setBackgroundThrottling?.(false);
    contents.setWindowOpenHandler(({ url }) => {
      const target = normalizeBrowserSurfaceUrl(url);
      if (target !== 'about:blank') void contents.loadURL(target).catch(() => undefined);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      if (isAllowedWebviewNavigationUrl(url)) return;
      event.preventDefault();
    });

    let metadataTimer = null;
    const flush = () => {
      metadataTimer = null;
      surface.url = safeString(contents.getURL?.()) || surface.url;
      emitSnapshot(surface);
      if (surface.leaseId) {
        onLeaseMetadata?.(surface.leaseId, {
          url: surface.url,
          title: safeString(contents.getTitle?.(), 1024),
        });
      }
    };
    const schedule = () => {
      if (metadataTimer) return;
      metadataTimer = setTimeout(flush, 50);
      metadataTimer.unref?.();
    };
    const metadataEvents = ['did-start-loading', 'did-stop-loading', 'did-navigate-in-page', 'page-title-updated', 'devtools-opened', 'devtools-closed'];
    for (const event of metadataEvents) {
      contents.on(event, schedule);
    }
    const onDidNavigate = () => {
      surface.faviconUrl = '';
      schedule();
    };
    const onFaviconUpdated = (_event, favicons) => {
      surface.faviconUrl = Array.isArray(favicons)
        ? safeString(favicons[0], MAX_FAVICON_URL_LENGTH)
        : '';
      schedule();
    };
    contents.on('did-navigate', onDidNavigate);
    contents.on('page-favicon-updated', onFaviconUpdated);
    const onDestroyed = () => destroy(surface, 'contents_destroyed');
    contents.once('destroyed', onDestroyed);
    surface.cleanupContents = () => {
      if (metadataTimer) clearTimeout(metadataTimer);
      for (const event of metadataEvents) {
        contents.off?.(event, schedule);
      }
      contents.off?.('did-navigate', onDidNavigate);
      contents.off?.('page-favicon-updated', onFaviconUpdated);
      contents.off?.('destroyed', onDestroyed);
    };
  };

  const createSurface = ({
    kind,
    ownerWindow,
    tabId = '',
    leaseId = '',
    workspaceId = '',
    initialUrl = 'about:blank',
    viewportMode = 'responsive',
    browserContext = null,
    browserPartition = '',
  }) => {
    if (!isAliveWindow(ownerWindow)) throw new Error('Browser window is not available');
    if (kind === 'manual' && (!browserContext?.contextKey || !browserContext?.partition)) {
      throw new Error('Authenticated Browser context is required');
    }
    const surfaceId = kind === 'lease'
      ? `lease:${normalizeSurfaceId(leaseId)}`
      : `manual:${ownerWindow.id}:${++surfaceCounter}`;
    const view = new WebContentsView({
      webPreferences: {
        partition: kind === 'manual'
          ? browserContext.partition
          : safeString(browserPartition, 256) || BROWSER_WEBVIEW_PARTITION,
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    const surface = {
      surfaceId,
      kind,
      tabId: safeString(tabId, 512),
      workspaceId: kind === 'manual' ? normalizeSurfaceId(workspaceId) : '',
      browserContextKey: kind === 'manual' ? browserContext.contextKey : '',
      browserOrigin: kind === 'manual' ? browserContext.origin : '',
      manualKey: '',
      leaseId: kind === 'lease' ? normalizeSurfaceId(leaseId) : '',
      homeWindowId: ownerWindow.id,
      view,
      attachedWindow: null,
      popoutWindow: null,
      placement: 'parked',
      viewportMode: sanitizeBrowserViewportMode(viewportMode),
      url: normalizeBrowserSurfaceUrl(initialUrl),
      faviconUrl: '',
      lastBounds: null,
      inlineBounds: null,
      cleanupContents: null,
      closingPopout: false,
      frameSubscriptionActive: false,
      lastAgentInput: null,
      cursorSuppressionCount: 0,
      observationSubscribers: new Set(),
      observationTimer: null,
      observationCaptureGeneration: 0,
    };
    surfaces.set(surfaceId, surface);
    if (surface.leaseId) leaseSurfaceByLeaseId.set(surface.leaseId, surfaceId);
    configureContents(surface);
    park(surface);
    void view.webContents.loadURL(surface.url).catch((error) => {
      log(`[browser-surface] failed to load ${surface.surfaceId}`, error);
    });
    return surface;
  };

  const getSurface = (surfaceId) => surfaces.get(normalizeSurfaceId(surfaceId)) || null;

  const getOwnedSurface = (requestWindow, surfaceId) => {
    const surface = getSurface(surfaceId);
    if (!surface) throw new Error('Unknown browser surface');
    const requestWindowId = requestWindow?.id;
    if (
      !Number.isInteger(requestWindowId)
      || (surface.homeWindowId !== requestWindowId && surface.popoutWindow?.id !== requestWindowId)
    ) {
      throw new Error('Browser surface does not belong to the requesting window');
    }
    if (surface.kind === 'manual' && getManualBrowserContext(requestWindow)?.contextKey !== surface.browserContextKey) {
      throw new Error('Browser surface belongs to another authenticated context');
    }
    return surface;
  };

  const getOwnedWorkspace = (requestWindow, workspaceId) => {
    const workspace = manualWorkspaces.get(normalizeSurfaceId(workspaceId));
    if (!workspace) throw new Error('Unknown browser workspace');
    const requestWindowId = requestWindow?.id;
    if (
      !Number.isInteger(requestWindowId)
      || (workspace.homeWindowId !== requestWindowId && workspace.popoutWindow?.id !== requestWindowId)
    ) {
      throw new Error('Browser workspace does not belong to the requesting window');
    }
    if (getManualBrowserContext(requestWindow)?.contextKey !== workspace.browserContextKey) {
      throw new Error('Browser workspace belongs to another authenticated context');
    }
    return workspace;
  };

  const workspaceSurfaces = (workspace) => Array.from(workspace.surfaceIds)
    .map((surfaceId) => surfaces.get(surfaceId))
    .filter(Boolean);

  const attachActiveWorkspaceSurface = (workspace) => {
    if (!isAliveWindow(workspace.popoutWindow)) return;
    const active = surfaces.get(workspace.activeSurfaceId);
    if (!active) return;
    for (const surface of workspaceSurfaces(workspace)) {
      surface.popoutWindow = workspace.popoutWindow;
      surface.placement = 'popout';
      if (surface === active) continue;
      if (devToolsController?.isOpen?.(surface.view.webContents.id)) {
        void devToolsController.setOpen?.({ guest: surface.view.webContents, ownerWindow: workspace.popoutWindow, open: false });
      }
      park(surface);
      emitSnapshot(surface);
    }
    const contentBounds = workspace.popoutWindow.getContentBounds();
    const devToolsHeight = devToolsController?.isOpen?.(active.view.webContents.id) ? 300 : 0;
    stopParkingCapture(active);
    attachView(active, workspace.popoutWindow, {
      x: 0,
      y: DEFAULT_BROWSER_WORKSPACE_CHROME_HEIGHT,
      width: contentBounds.width,
      height: Math.max(1, contentBounds.height - DEFAULT_BROWSER_WORKSPACE_CHROME_HEIGHT - devToolsHeight),
    });
    emitSnapshot(active);
  };

  const createManualSurface = (ownerWindow, {
    tabId,
    workspaceId,
    initialUrl,
    viewportMode = 'responsive',
  } = {}) => {
    const browserContext = getManualBrowserContext(ownerWindow);
    if (!browserContext?.contextKey || !browserContext?.partition) {
      throw new Error('Authenticated Browser context is required');
    }
    const normalizedTabId = normalizeSurfaceId(tabId);
    const normalizedWorkspaceId = normalizeSurfaceId(workspaceId || `legacy:${ownerWindow.id}:${normalizedTabId}`);
    const existingWorkspace = manualWorkspaces.get(normalizedWorkspaceId);
    if (existingWorkspace && (
      existingWorkspace.homeWindowId !== ownerWindow.id
      || existingWorkspace.browserContextKey !== browserContext.contextKey
    )) {
      throw new Error('Browser workspace does not belong to the requesting window');
    }
    const workspace = existingWorkspace || {
      workspaceId: normalizedWorkspaceId,
      homeWindowId: ownerWindow.id,
      browserContextKey: browserContext.contextKey,
      popoutWindow: null,
      activeSurfaceId: '',
      surfaceIds: new Set(),
      closingPopout: false,
    };
    manualWorkspaces.set(normalizedWorkspaceId, workspace);
    const key = `${ownerWindow.id}\u0000${normalizedWorkspaceId}\u0000${normalizedTabId}`;
    const existingId = manualSurfaceByHomeAndTab.get(key);
    const existing = existingId ? surfaces.get(existingId) : null;
    if (existing) return snapshot(existing);
    const surface = createSurface({
      kind: 'manual',
      ownerWindow,
      tabId: normalizedTabId,
      workspaceId: normalizedWorkspaceId,
      initialUrl,
      viewportMode,
      browserContext,
    });
    surface.manualKey = key;
    manualSurfaceByHomeAndTab.set(key, surface.surfaceId);
    workspace.surfaceIds.add(surface.surfaceId);
    workspace.activeSurfaceId ||= surface.surfaceId;
    if (isAliveWindow(workspace.popoutWindow)) {
      surface.popoutWindow = workspace.popoutWindow;
      surface.placement = 'popout';
      if (workspace.activeSurfaceId === surface.surfaceId) {
        const contentBounds = workspace.popoutWindow.getContentBounds();
        attachView(surface, workspace.popoutWindow, {
          x: 0,
          y: DEFAULT_BROWSER_WORKSPACE_CHROME_HEIGHT,
          width: contentBounds.width,
          height: Math.max(1, contentBounds.height - DEFAULT_BROWSER_WORKSPACE_CHROME_HEIGHT),
        });
      } else {
        park(surface);
      }
    }
    return snapshot(surface);
  };

  const createLeaseSurface = (ownerWindow, { leaseId, initialUrl, browserPartition = '' } = {}) => {
    const normalizedLeaseId = normalizeSurfaceId(leaseId);
    const existingId = leaseSurfaceByLeaseId.get(normalizedLeaseId);
    const existing = existingId ? surfaces.get(existingId) : null;
    if (existing) return { snapshot: snapshot(existing), webContents: existing.view.webContents };
    const surface = createSurface({
      kind: 'lease',
      ownerWindow,
      leaseId: normalizedLeaseId,
      initialUrl,
      browserPartition,
    });
    return { snapshot: snapshot(surface), webContents: surface.view.webContents };
  };

  const layout = (requestWindow, { surfaceId, bounds, visible } = {}) => {
    const surface = getOwnedSurface(requestWindow, surfaceId);
    if (visible !== true) {
      if (surface.placement !== 'popout') {
        park(surface);
        surface.placement = 'parked';
      }
      return emitSnapshot(surface);
    }
    const expectedWindow = surface.placement === 'popout' ? surface.popoutWindow : getWindowById(surface.homeWindowId);
    if (!isAliveWindow(expectedWindow) || expectedWindow.id !== requestWindow.id) {
      return emitSnapshot(surface);
    }
    stopParkingCapture(surface);
    attachView(surface, expectedWindow, bounds);
    surface.placement = surface.popoutWindow ? 'popout' : 'inline';
    if (!surface.popoutWindow) surface.inlineBounds = surface.lastBounds;
    return emitSnapshot(surface);
  };

  const command = async (requestWindow, { surfaceId, action, url } = {}) => {
    const surface = getOwnedSurface(requestWindow, surfaceId);
    const contents = surface.view.webContents;
    if (action === 'navigate') {
      const target = requireBrowserSurfaceUrl(url);
      surface.url = target;
      try {
        await contents.loadURL(target);
      } catch (error) {
        if (!isBenignNavigationAbort(error)) throw error;
      }
    } else if (action === 'back' || action === 'forward' || action === 'reload') {
      navigateHistory(contents, action);
    } else {
      throw new Error('Unknown browser surface command');
    }
    return emitSnapshot(surface);
  };

  const setViewportMode = (requestWindow, { surfaceId, viewportMode } = {}) => {
    const surface = getOwnedSurface(requestWindow, surfaceId);
    surface.viewportMode = sanitizeBrowserViewportMode(viewportMode);
    if (surface.lastBounds && surface.attachedWindow && isAliveWindow(surface.attachedWindow)) {
      applyViewportMode(surface, surface.lastBounds);
    }
    return emitSnapshot(surface);
  };

  const dock = async (surface) => {
    const popup = surface.popoutWindow;
    surface.popoutWindow = null;
    const home = getWindowById(surface.homeWindowId);
    surface.placement = isAliveWindow(home) ? 'inline' : 'parked';
    park(surface);
    if (isAliveWindow(home) && devToolsController?.isOpen?.(surface.view.webContents.id)) {
      const contentBounds = home.getContentBounds();
      const inline = surface.inlineBounds || {
        x: 0,
        y: DEFAULT_TOOLBAR_HEIGHT,
        width: contentBounds.width,
        height: Math.max(1, contentBounds.height - DEFAULT_TOOLBAR_HEIGHT),
      };
      const height = Math.min(300, Math.max(1, inline.height - 120));
      devToolsController.rehost?.({
        guest: surface.view.webContents,
        ownerWindow: home,
        bounds: {
          x: inline.x,
          y: inline.y + inline.height - height,
          width: inline.width,
          height,
        },
      });
    }
    emitSnapshot(surface);
    if (isAliveWindow(popup)) {
      surface.closingPopout = true;
      popup.destroy();
      surface.closingPopout = false;
    }
    return snapshot(surface);
  };

  const popout = async (requestWindow, { surfaceId } = {}) => {
    const surface = getOwnedSurface(requestWindow, surfaceId);
    if (isAliveWindow(surface.popoutWindow)) {
      if (surface.popoutWindow.isMinimized?.()) surface.popoutWindow.restore?.();
      surface.popoutWindow.show?.();
      surface.popoutWindow.focus?.();
      return snapshot(surface);
    }
    const popup = await createPopoutWindow({
      surfaceId: surface.surfaceId,
      baseOrigin: surface.browserOrigin,
    });
    if (!isAliveWindow(popup)) throw new Error('Unable to create browser pop-out');
    popup.__ocBrowserPopout = true;
    popup.__ocBrowserSurfaceId = surface.surfaceId;
    surface.popoutWindow = popup;
    surface.placement = 'popout';
    stopParkingCapture(surface);
    const initialDevToolsHeight = devToolsController?.isOpen?.(surface.view.webContents.id) ? 300 : 0;
    attachView(surface, popup, {
      x: 0,
      y: DEFAULT_TOOLBAR_HEIGHT,
      width: popup.getContentBounds().width,
      height: Math.max(1, popup.getContentBounds().height - DEFAULT_TOOLBAR_HEIGHT - initialDevToolsHeight),
    });
    popup.on('resize', () => {
      if (surface.popoutWindow !== popup || surface.attachedWindow !== popup) return;
      const contentBounds = popup.getContentBounds();
      const devToolsHeight = devToolsController?.isOpen?.(surface.view.webContents.id) ? 300 : 0;
      attachView(surface, popup, {
        x: 0,
        y: DEFAULT_TOOLBAR_HEIGHT,
        width: contentBounds.width,
        height: Math.max(1, contentBounds.height - DEFAULT_TOOLBAR_HEIGHT - devToolsHeight),
      });
      devToolsController?.rehost?.({
        guest: surface.view.webContents,
        ownerWindow: popup,
        bounds: {
          x: 0,
          y: Math.max(DEFAULT_TOOLBAR_HEIGHT, contentBounds.height - devToolsHeight),
          width: contentBounds.width,
          height: Math.max(1, devToolsHeight),
        },
      });
    });
    popup.on('close', (event) => {
      if (surface.closingPopout || shouldQuit()) return;
      event.preventDefault();
      void dock(surface);
    });
    popup.on('closed', () => {
      if (surface.popoutWindow === popup) {
        surface.popoutWindow = null;
        surface.placement = 'inline';
        park(surface);
        emitSnapshot(surface);
      }
    });
    if (devToolsController?.isOpen?.(surface.view.webContents.id)) {
      const contentBounds = popup.getContentBounds();
      devToolsController.rehost?.({
        guest: surface.view.webContents,
        ownerWindow: popup,
        bounds: {
          x: 0,
          y: Math.max(DEFAULT_TOOLBAR_HEIGHT, contentBounds.height - 300),
          width: contentBounds.width,
          height: Math.min(300, Math.max(1, contentBounds.height - DEFAULT_TOOLBAR_HEIGHT)),
        },
      });
    }
    emitSnapshot(surface);
    return snapshot(surface);
  };

  const dockOwned = (requestWindow, { surfaceId } = {}) => dock(getOwnedSurface(requestWindow, surfaceId));

  const focusPopout = (requestWindow, { surfaceId } = {}) => {
    const surface = getOwnedSurface(requestWindow, surfaceId);
    if (!isAliveWindow(surface.popoutWindow)) return { focused: false };
    if (surface.popoutWindow.isMinimized?.()) surface.popoutWindow.restore?.();
    surface.popoutWindow.show?.();
    surface.popoutWindow.focus?.();
    return { focused: true };
  };

  const activateWorkspaceSurface = (requestWindow, { workspaceId, surfaceId, tabId } = {}) => {
    const workspace = getOwnedWorkspace(requestWindow, workspaceId);
    const normalizedSurfaceId = surfaceId
      ? normalizeSurfaceId(surfaceId)
      : workspaceSurfaces(workspace).find((surface) => surface.tabId === normalizeSurfaceId(tabId))?.surfaceId || '';
    if (!workspace.surfaceIds.has(normalizedSurfaceId)) {
      throw new Error('Browser surface is not part of this workspace');
    }
    workspace.activeSurfaceId = normalizedSurfaceId;
    if (isAliveWindow(workspace.popoutWindow)) attachActiveWorkspaceSurface(workspace);
    return snapshot(surfaces.get(normalizedSurfaceId));
  };

  const dockWorkspace = async (workspace) => {
    const popup = workspace.popoutWindow;
    workspace.popoutWindow = null;
    const home = getWindowById(workspace.homeWindowId);
    for (const surface of workspaceSurfaces(workspace)) {
      surface.popoutWindow = null;
      surface.placement = isAliveWindow(home) ? 'inline' : 'parked';
      park(surface);
      emitSnapshot(surface);
    }
    if (isAliveWindow(popup)) {
      workspace.closingPopout = true;
      popup.destroy();
      workspace.closingPopout = false;
    }
    return {
      workspaceId: workspace.workspaceId,
      placement: isAliveWindow(home) ? 'inline' : 'parked',
      activeSurfaceId: workspace.activeSurfaceId,
    };
  };

  const popoutWorkspace = async (requestWindow, { workspaceId, activeSurfaceId } = {}) => {
    const workspace = getOwnedWorkspace(requestWindow, workspaceId);
    if (activeSurfaceId) {
      const normalizedActiveId = normalizeSurfaceId(activeSurfaceId);
      if (!workspace.surfaceIds.has(normalizedActiveId)) {
        throw new Error('Browser surface is not part of this workspace');
      }
      workspace.activeSurfaceId = normalizedActiveId;
    }
    if (!workspace.activeSurfaceId || !surfaces.has(workspace.activeSurfaceId)) {
      throw new Error('Browser workspace has no active surface');
    }
    if (isAliveWindow(workspace.popoutWindow)) {
      workspace.popoutWindow.show?.();
      workspace.popoutWindow.focus?.();
      return { workspaceId: workspace.workspaceId, placement: 'popout', activeSurfaceId: workspace.activeSurfaceId };
    }
    const activeSurface = surfaces.get(workspace.activeSurfaceId);
    const popup = await createPopoutWindow({
      workspaceId: workspace.workspaceId,
      baseOrigin: activeSurface?.browserOrigin || '',
    });
    if (!isAliveWindow(popup)) throw new Error('Unable to create browser workspace pop-out');
    popup.__ocBrowserPopout = true;
    popup.__ocBrowserWorkspaceId = workspace.workspaceId;
    workspace.popoutWindow = popup;
    attachActiveWorkspaceSurface(workspace);
    popup.on('resize', () => {
      if (workspace.popoutWindow !== popup) return;
      attachActiveWorkspaceSurface(workspace);
    });
    popup.on('close', (event) => {
      if (workspace.closingPopout || shouldQuit()) return;
      event.preventDefault();
      void dockWorkspace(workspace);
    });
    popup.on('closed', () => {
      if (workspace.popoutWindow !== popup) return;
      workspace.popoutWindow = null;
      for (const surface of workspaceSurfaces(workspace)) {
        surface.popoutWindow = null;
        surface.placement = 'inline';
        park(surface);
        emitSnapshot(surface);
      }
    });
    return { workspaceId: workspace.workspaceId, placement: 'popout', activeSurfaceId: workspace.activeSurfaceId };
  };

  const dockOwnedWorkspace = (requestWindow, { workspaceId } = {}) => (
    dockWorkspace(getOwnedWorkspace(requestWindow, workspaceId))
  );

  const focusWorkspacePopout = (requestWindow, { workspaceId } = {}) => {
    const workspace = getOwnedWorkspace(requestWindow, workspaceId);
    if (!isAliveWindow(workspace.popoutWindow)) return { focused: false };
    if (workspace.popoutWindow.isMinimized?.()) workspace.popoutWindow.restore?.();
    workspace.popoutWindow.show?.();
    workspace.popoutWindow.focus?.();
    return { focused: true };
  };

  const setDevTools = async (requestWindow, { surfaceId, open, bounds } = {}) => {
    const surface = getOwnedSurface(requestWindow, surfaceId);
    const ownerWindow = surface.placement === 'popout' ? surface.popoutWindow : getWindowById(surface.homeWindowId);
    if (!isAliveWindow(ownerWindow)) throw new Error('Browser window is not available');
    const result = await devToolsController.setOpen({
      guest: surface.view.webContents,
      ownerWindow,
      bounds,
      open: open === true,
    });
    if (surface.placement === 'popout' && isAliveWindow(surface.popoutWindow)) {
      const contentBounds = surface.popoutWindow.getContentBounds();
      const chromeHeight = surface.workspaceId
        ? DEFAULT_BROWSER_WORKSPACE_CHROME_HEIGHT
        : DEFAULT_TOOLBAR_HEIGHT;
      attachView(surface, surface.popoutWindow, {
        x: 0,
        y: chromeHeight,
        width: contentBounds.width,
        height: Math.max(1, contentBounds.height - chromeHeight - (result.open ? 300 : 0)),
      });
      if (result.open) {
        devToolsController.rehost?.({
          guest: surface.view.webContents,
          ownerWindow: surface.popoutWindow,
          bounds: {
            x: 0,
            y: Math.max(chromeHeight, contentBounds.height - 300),
            width: contentBounds.width,
            height: Math.min(300, Math.max(1, contentBounds.height - chromeHeight)),
          },
        });
      }
    }
    emitSnapshot(surface);
    return result;
  };

  const capture = async (requestWindow, { surfaceId } = {}) => {
    const surface = getOwnedSurface(requestWindow, surfaceId);
    const image = await surface.view.webContents.capturePage();
    const viewport = await surface.view.webContents.executeJavaScript(
      '({ width: window.innerWidth, height: window.innerHeight })',
      true,
    ).catch(() => null);
    const buffer = image.toJPEG(82);
    return {
      mime: 'image/jpeg',
      base64: buffer.toString('base64'),
      width: image.getSize().width,
      height: image.getSize().height,
      cssWidth: Number.isFinite(viewport?.width) ? viewport.width : image.getSize().width,
      cssHeight: Number.isFinite(viewport?.height) ? viewport.height : image.getSize().height,
    };
  };

  const stopLeaseObservationCapture = (surface) => {
    if (!surface) return;
    surface.observationCaptureGeneration += 1;
    if (surface.observationTimer) clearTimeout(surface.observationTimer);
    surface.observationTimer = null;
  };

  const closeLeaseObservationSubscribers = (surface, reason = 'surface_closed') => {
    stopLeaseObservationCapture(surface);
    for (const subscriber of surface?.observationSubscribers ?? []) {
      try { subscriber.onClose?.(reason); } catch { }
    }
    surface?.observationSubscribers?.clear?.();
  };

  const captureLeaseObservationFrame = async (surface) => {
    const image = await surface.view.webContents.capturePage();
    const size = image.getSize();
    const scale = Math.min(
      1,
      AGENT_OBSERVATION_MAX_WIDTH / Math.max(1, size.width),
      AGENT_OBSERVATION_MAX_HEIGHT / Math.max(1, size.height),
    );
    const frame = scale < 1
      ? image.resize({
        width: Math.max(1, Math.floor(size.width * scale)),
        height: Math.max(1, Math.floor(size.height * scale)),
      }).toJPEG(AGENT_OBSERVATION_JPEG_QUALITY)
      : image.toJPEG(AGENT_OBSERVATION_JPEG_QUALITY);
    return frame;
  };

  const startLeaseObservationCapture = (surface) => {
    if (!surface || surface.observationSubscribers.size === 0 || surface.observationTimer) return;
    const generation = ++surface.observationCaptureGeneration;
    const captureNext = async () => {
      surface.observationTimer = null;
      if (
        generation !== surface.observationCaptureGeneration
        || surface.observationSubscribers.size === 0
        || surface.view.webContents.isDestroyed?.()
      ) return;
      try {
        const frame = await captureLeaseObservationFrame(surface);
        if (generation !== surface.observationCaptureGeneration) return;
        for (const subscriber of surface.observationSubscribers) {
          try { subscriber.onFrame(frame); } catch { }
        }
      } catch (error) {
        log(`[browser-surface] failed to capture observed lease ${surface.leaseId}`, error);
      }
      if (generation !== surface.observationCaptureGeneration || surface.observationSubscribers.size === 0) return;
      surface.observationTimer = setTimeout(captureNext, AGENT_OBSERVATION_FRAME_INTERVAL_MS);
      surface.observationTimer.unref?.();
    };
    void captureNext();
  };

  const subscribeLeaseFrames = (leaseId, subscriber) => {
    const surface = surfaceForLease(leaseId);
    if (!surface || typeof subscriber?.onFrame !== 'function') {
      throw Object.assign(new Error('Browser lease surface is not available'), {
        code: 'browser_observation_unavailable',
      });
    }
    surface.observationSubscribers.add(subscriber);
    startLeaseObservationCapture(surface);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      surface.observationSubscribers.delete(subscriber);
      if (surface.observationSubscribers.size === 0) stopLeaseObservationCapture(surface);
    };
  };

  const inspect = async (requestWindow, { surfaceId, cancel } = {}) => {
    const surface = getOwnedSurface(requestWindow, surfaceId);
    const result = await surface.view.webContents.executeJavaScript(
      cancel === true ? BROWSER_INSPECT_CANCEL_SCRIPT : BROWSER_INSPECT_SCRIPT,
      true,
    );
    if (cancel === true) return { cancelled: true };
    if (!result?.target || !result?.viewport) return null;
    const image = await surface.view.webContents.capturePage();
    return {
      target: result.target,
      capture: {
        mime: 'image/png',
        base64: image.toPNG().toString('base64'),
        width: image.getSize().width,
        height: image.getSize().height,
        cssWidth: result.viewport.width,
        cssHeight: result.viewport.height,
        devicePixelRatio: result.viewport.devicePixelRatio,
      },
    };
  };

  const destroy = (surface, reason = 'released') => {
    if (!surface || !surfaces.has(surface.surfaceId)) return false;
    surfaces.delete(surface.surfaceId);
    if (surface.leaseId) leaseSurfaceByLeaseId.delete(surface.leaseId);
    if (surface.kind === 'manual') {
      manualSurfaceByHomeAndTab.delete(surface.manualKey);
      const workspace = manualWorkspaces.get(surface.workspaceId);
      if (workspace) {
        workspace.surfaceIds.delete(surface.surfaceId);
        if (workspace.activeSurfaceId === surface.surfaceId) {
          workspace.activeSurfaceId = workspace.surfaceIds.values().next().value || '';
        }
        if (workspace.surfaceIds.size === 0) {
          manualWorkspaces.delete(workspace.workspaceId);
          if (isAliveWindow(workspace.popoutWindow)) {
            workspace.closingPopout = true;
            workspace.popoutWindow.destroy();
          }
        } else if (isAliveWindow(workspace.popoutWindow)) {
          attachActiveWorkspaceSurface(workspace);
        }
      }
    }
    closeLeaseObservationSubscribers(surface, reason);
    stopParkingCapture(surface);
    surface.cleanupContents?.();
    devToolsController?.destroyGuest?.(surface.view.webContents.id);
    detachView(surface);
    if (!surface.workspaceId && isAliveWindow(surface.popoutWindow)) {
      surface.closingPopout = true;
      surface.popoutWindow.destroy();
    }
    if (!surface.view.webContents.isDestroyed?.()) surface.view.webContents.close?.({ waitForBeforeUnload: false });
    if (surface.leaseId) onLeaseSurfaceDestroyed?.(surface.leaseId, reason);
    return true;
  };

  const releaseOwned = (requestWindow, { surfaceId } = {}) => destroy(getOwnedSurface(requestWindow, surfaceId));
  const releaseLease = (leaseId, reason) => {
    const surfaceId = leaseSurfaceByLeaseId.get(safeString(leaseId, MAX_SURFACE_ID_LENGTH));
    return surfaceId ? destroy(surfaces.get(surfaceId), reason) : false;
  };

  const surfaceForLease = (leaseId) => {
    const surfaceId = leaseSurfaceByLeaseId.get(safeString(leaseId, MAX_SURFACE_ID_LENGTH));
    return surfaceId ? surfaces.get(surfaceId) || null : null;
  };

  const setLeaseHomeWindow = (leaseId, ownerWindow) => {
    const surface = surfaceForLease(leaseId);
    if (!surface || !isAliveWindow(ownerWindow)) return false;
    surface.homeWindowId = ownerWindow.id;
    emitSnapshot(surface);
    return true;
  };

  const handleHomeWindowClosed = (windowId) => {
    for (const surface of [...surfaces.values()]) {
      if (surface.homeWindowId !== windowId) continue;
      surface.homeWindowId = null;
      if (surface.kind === 'manual') {
        destroy(surface, 'home_window_closed');
      } else {
        if (isAliveWindow(surface.popoutWindow)) {
          surface.closingPopout = true;
          surface.popoutWindow.destroy();
          surface.popoutWindow = null;
        }
        park(surface);
        surface.placement = 'parked';
        emitSnapshot(surface);
      }
    }
  };

  const releaseManualForHomeWindow = (windowId, reason = 'browser_context_changed') => {
    let released = 0;
    for (const surface of [...surfaces.values()]) {
      if (
        surface.kind !== 'manual'
        || (surface.homeWindowId !== windowId && surface.popoutWindow?.id !== windowId)
      ) continue;
      if (destroy(surface, reason)) released += 1;
    }
    return released;
  };

  const showAgentInput = (leaseId, input) => {
    const surface = surfaceForLease(leaseId);
    if (!surface) return;
    surface.lastAgentInput = input;
    if (surface.cursorSuppressionCount > 0) return;
    void installCursorOverlay(surface.view.webContents, input, true);
  };

  const setAgentCursorVisible = async (leaseId, visible) => {
    const surface = surfaceForLease(leaseId);
    if (!surface) return;
    await installCursorOverlay(surface.view.webContents, surface.lastAgentInput, visible);
  };

  const setAgentCursorSuppressed = async (leaseId, suppressed) => {
    const surface = surfaceForLease(leaseId);
    if (!surface) return;
    if (suppressed) {
      surface.cursorSuppressionCount += 1;
      if (surface.cursorSuppressionCount === 1) {
        await installCursorOverlay(surface.view.webContents, surface.lastAgentInput, false);
      }
      return;
    }
    surface.cursorSuppressionCount = Math.max(0, surface.cursorSuppressionCount - 1);
    if (surface.cursorSuppressionCount === 0) {
      await installCursorOverlay(surface.view.webContents, surface.lastAgentInput, true);
    }
  };

  const closeAll = (reason = 'app_quit') => {
    for (const surface of [...surfaces.values()]) destroy(surface, reason);
    manualWorkspaces.clear();
    if (isAliveWindow(parkingWindow)) parkingWindow.destroy();
    parkingWindow = null;
  };

  return {
    capture,
    activateWorkspaceSurface,
    closeAll,
    command,
    createLeaseSurface,
    createManualSurface,
    dock: dockOwned,
    dockWorkspace: dockOwnedWorkspace,
    focusPopout,
    focusWorkspacePopout,
    getOwnedSurface,
    getSurfaceSnapshot: (requestWindow, { surfaceId } = {}) => snapshot(getOwnedSurface(requestWindow, surfaceId)),
    handleHomeWindowClosed,
    inspect,
    layout,
    popout,
    popoutWorkspace,
    releaseLease,
    releaseManualForHomeWindow,
    releaseOwned,
    setAgentCursorVisible,
    setAgentCursorSuppressed,
    setDevTools,
    setViewportMode,
    setLeaseHomeWindow,
    showAgentInput,
    snapshotForLease: (leaseId) => {
      const surface = surfaceForLease(leaseId);
      return surface ? snapshot(surface) : null;
    },
    subscribeLeaseFrames,
    surfaceForLease,
  };
};
