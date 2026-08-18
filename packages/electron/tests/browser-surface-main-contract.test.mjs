import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const managerSource = readFileSync(new URL('../browser-surface-manager.mjs', import.meta.url), 'utf8');
const mainSource = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8');

describe('main-owned browser surface contract', () => {
  test('publishes only the token-free snapshot projection', () => {
    const start = managerSource.indexOf('const snapshot = (surface) =>');
    const end = managerSource.indexOf('\n\n  const emitSnapshot', start);
    const block = managerSource.slice(start, end);
    for (const field of ['surfaceId', 'kind', 'leaseId', 'workspaceId', 'tabId', 'placement', 'viewportMode', 'url', 'title', 'faviconUrl', 'loading', 'canGoBack', 'canGoForward', 'devToolsOpen']) {
      expect(block).toContain(field);
    }
    expect(block).not.toContain('token');
    expect(block).not.toContain('wsUrl');
  });

  test('publishes and cleans up page favicon metadata', () => {
    expect(managerSource).toContain("contents.on('page-favicon-updated', onFaviconUpdated)");
    expect(managerSource).toContain("contents.off?.('page-favicon-updated', onFaviconUpdated)");
    expect(managerSource).toContain("contents.on('did-navigate', onDidNavigate)");
    expect(managerSource).toContain("surface.faviconUrl = '';");
  });

  test('validates ownership, bounds, and allowed navigation schemes in main', () => {
    expect(managerSource).toContain('surface.homeWindowId !== requestWindowId && surface.popoutWindow?.id !== requestWindowId');
    expect(managerSource).toContain("throw new Error('Browser surface does not belong to the requesting window')");
    expect(managerSource).toContain("throw new Error('Browser surface bounds are required')");
    expect(managerSource).toContain("parsed.protocol === 'http:' || parsed.protocol === 'https:'");
    expect(managerSource).toContain("if (!raw || raw === 'about:blank') return 'about:blank'");
    expect(managerSource).toContain("throw new Error('Browser surface URL must be about:blank or HTTP(S)')");
  });

  test('applies an ownership-validated viewport mode without reloading', () => {
    const start = managerSource.indexOf('const setViewportMode =');
    const end = managerSource.indexOf('\n\n  const dock = async', start);
    const block = managerSource.slice(start, end);
    expect(block).toContain('getOwnedSurface(requestWindow, surfaceId)');
    expect(block).toContain('applyViewportMode(surface, surface.lastBounds)');
    expect(block).not.toContain('loadURL');
    expect(mainSource).toContain("case 'desktop_browser_surface_set_viewport_mode':");
    expect(mainSource).toContain("'desktop_browser_surface_set_viewport_mode',");
  });

  test('accepts benign aborted loads while preserving genuine navigation failures', () => {
    const start = managerSource.indexOf('const command = async');
    const end = managerSource.indexOf('\n\n  const dock = async', start);
    const block = managerSource.slice(start, end);
    expect(block).toContain('await contents.loadURL(target)');
    expect(block).toContain('if (!isBenignNavigationAbort(error)) throw error;');
  });

  test('moves one view among inline, pop-out, and parking hosts', () => {
    expect(managerSource).toContain('current.contentView?.removeChildView?.(surface.view)');
    expect(managerSource).toContain('ownerWindow.contentView.addChildView(surface.view)');
    expect(managerSource).toContain('surface.popoutWindow = popup');
    expect(managerSource).toContain("surface.placement = 'popout'");
    expect(managerSource).toContain("surface.placement = 'parked'");
    expect(managerSource).not.toContain('new WebContentsView({\n      webPreferences: surface');
  });

  test('focuses an existing pop-out and docks on close', () => {
    expect(managerSource).toContain('if (isAliveWindow(surface.popoutWindow))');
    expect(managerSource).toContain('surface.popoutWindow.focus?.()');
    expect(managerSource).toContain("popup.on('close', (event) =>");
    expect(managerSource).toContain('event.preventDefault()');
    expect(managerSource).toContain('void dock(surface)');
  });

  test('aligns macOS traffic lights with the shared 38px browser toolbar', () => {
    const start = mainSource.indexOf('const createBrowserPopoutWindow =');
    const end = mainSource.indexOf('\n\nconst createMiniChatWindow', start);
    const block = mainSource.slice(start, end);
    expect(block).toContain("trafficLightPosition: process.platform === 'darwin' ? { x: 16, y: 12 } : undefined");
    expect(managerSource).toContain('const DEFAULT_TOOLBAR_HEIGHT = 38;');
    expect(managerSource).toContain('const DEFAULT_BROWSER_WORKSPACE_CHROME_HEIGHT = 70;');
  });

  test('loads the pop-out shell before attaching native browser content', () => {
    const start = mainSource.indexOf('const createBrowserPopoutWindow =');
    const end = mainSource.indexOf('\n\nconst createMiniChatWindow', start);
    const block = mainSource.slice(start, end);
    expect(block).toContain('await navigateWindow(browserWindow, buildBrowserPopoutUrl({ surfaceId, workspaceId, baseOrigin }))');
    expect(block).toContain('if (!browserWindow.isDestroyed()) browserWindow.destroy();');
    expect(block.indexOf('await navigateWindow')).toBeLessThan(block.indexOf('return browserWindow'));
  });

  test('opens managed developer Browser pop-outs on the requesting host origin', () => {
    expect(mainSource).toContain('const openHostRoutedBrowserWorkspace = async');
    expect(mainSource).toContain('baseOrigin: rendererUrl.origin');
    expect(mainSource).toContain("case 'desktop_browser_host_workspace_popout':");
    expect(mainSource).toContain("'desktop_browser_host_workspace_popout',");
    expect(mainSource).toContain("'desktop_browser_host_workspace_focus_popout',");
  });

  test('groups manual surfaces into one validated workspace pop-out while leaving leases surface-scoped', () => {
    expect(managerSource).toContain('const manualWorkspaces = new Map();');
    expect(managerSource).toContain("throw new Error('Browser workspace does not belong to the requesting window')");
    expect(managerSource).toContain('workspace.surfaceIds.add(surface.surfaceId)');
    expect(managerSource).toContain('const popoutWorkspace = async');
    expect(managerSource).toContain('const activateWorkspaceSurface =');
    expect(managerSource).toContain('surface.tabId === normalizeSurfaceId(tabId)');
    expect(managerSource).toContain('attachActiveWorkspaceSurface(workspace)');
    expect(managerSource).toContain('park(surface)');
    expect(mainSource).toContain("case 'desktop_browser_workspace_activate':");
    expect(mainSource).toContain("case 'desktop_browser_workspace_popout':");
    expect(mainSource).toContain("case 'desktop_browser_workspace_dock':");
    expect(mainSource).toContain("case 'desktop_browser_workspace_focus_popout':");
  });

  test('authorizes native surface commands for configured DevRyan origins and keeps state out of pop-out URLs', () => {
    const remoteCommands = mainSource.slice(
      mainSource.indexOf('const COMMANDS_SAFE_FOR_REMOTE = new Set(['),
      mainSource.indexOf("ipcMain.handle('openchamber:invoke'"),
    );
    expect(mainSource).toContain("case 'desktop_browser_surface_create':");
    expect(mainSource).toContain("case 'desktop_browser_surface_popout':");
    expect(mainSource).toContain("case 'desktop_browser_surface_dock':");
    expect(remoteCommands).toContain('const NATIVE_BROWSER_COMMANDS = new Set([');
    expect(mainSource).toContain('await authorizeNativeBrowserWindow(browserWindow, { force });');
    expect(mainSource).toContain("new URL('/auth/session', origin)");
    expect(mainSource).toContain('readAuthorizedBrowserPrincipal(');
    const popoutUrlBlock = mainSource.slice(
      mainSource.indexOf('const buildBrowserPopoutUrl ='),
      mainSource.indexOf('\n\nconst createBrowserPopoutWindow', mainSource.indexOf('const buildBrowserPopoutUrl =')),
    );
    expect(popoutUrlBlock).toContain("url.searchParams.set('surfaceId'");
    expect(popoutUrlBlock).toContain("url.searchParams.set('workspaceId'");
    expect(popoutUrlBlock).not.toContain("url.searchParams.set('url'");
    expect(popoutUrlBlock).not.toContain("url.searchParams.set('directory'");
  });

  test('binds manual surfaces to a main-derived per-user Browser context', () => {
    expect(managerSource).toContain("throw new Error('Authenticated Browser context is required')");
    expect(managerSource).toContain("partition: kind === 'manual' ? browserContext.partition : BROWSER_WEBVIEW_PARTITION");
    expect(managerSource).toContain('existingWorkspace.browserContextKey !== browserContext.contextKey');
    expect(managerSource).toContain("throw new Error('Browser surface belongs to another authenticated context')");
    expect(mainSource).toContain('createManualBrowserContext({ origin, principalId: principal.id })');
    expect(mainSource).toContain("releaseManualForHomeWindow(windowId, 'browser_context_changed')");
  });

  test('binds agent CDP to the manager-owned contents before reporting ready', () => {
    const start = mainSource.indexOf('const createDesktopBrowserLease =');
    const end = mainSource.indexOf('\n\nconst touchDesktopBrowserLease', start);
    const block = mainSource.slice(start, end);
    expect(block).toContain('createLeaseSurface(ownerWindow');
    expect(block).toContain('bridge.bindLeaseGuest(leaseId, surfaceContents');
    expect(block.indexOf('bridge.bindLeaseGuest')).toBeLessThan(block.indexOf("state: 'ready'"));
    expect(block).not.toContain('guest_bind_timeout');
  });
});
