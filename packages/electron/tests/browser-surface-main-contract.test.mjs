import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const managerSource = readFileSync(new URL('../browser-surface-manager.mjs', import.meta.url), 'utf8');
const mainSource = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8');

describe('main-owned browser surface contract', () => {
  test('publishes only the token-free snapshot projection', () => {
    const start = managerSource.indexOf('const snapshot = (surface) =>');
    const end = managerSource.indexOf('\n\n  const emitSnapshot', start);
    const block = managerSource.slice(start, end);
    for (const field of ['surfaceId', 'kind', 'leaseId', 'placement', 'url', 'title', 'loading', 'canGoBack', 'canGoForward', 'devToolsOpen']) {
      expect(block).toContain(field);
    }
    expect(block).not.toContain('token');
    expect(block).not.toContain('wsUrl');
  });

  test('validates ownership, bounds, and allowed navigation schemes in main', () => {
    expect(managerSource).toContain('surface.homeWindowId !== requestWindowId && surface.popoutWindow?.id !== requestWindowId');
    expect(managerSource).toContain("throw new Error('Browser surface does not belong to the requesting window')");
    expect(managerSource).toContain("throw new Error('Browser surface bounds are required')");
    expect(managerSource).toContain("parsed.protocol === 'http:' || parsed.protocol === 'https:'");
    expect(managerSource).toContain("if (!raw || raw === 'about:blank') return 'about:blank'");
    expect(managerSource).toContain("throw new Error('Browser surface URL must be about:blank or HTTP(S)')");
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
  });

  test('keeps surface commands local-only and does not put page state in the pop-out URL', () => {
    const remoteCommands = mainSource.slice(
      mainSource.indexOf('const COMMANDS_SAFE_FOR_REMOTE = new Set(['),
      mainSource.indexOf("ipcMain.handle('openchamber:invoke'"),
    );
    expect(mainSource).toContain("case 'desktop_browser_surface_create':");
    expect(mainSource).toContain("case 'desktop_browser_surface_popout':");
    expect(mainSource).toContain("case 'desktop_browser_surface_dock':");
    expect(remoteCommands).not.toContain('desktop_browser_surface_');
    const popoutUrlBlock = mainSource.slice(
      mainSource.indexOf('const buildBrowserPopoutUrl ='),
      mainSource.indexOf('\n\nconst createBrowserPopoutWindow', mainSource.indexOf('const buildBrowserPopoutUrl =')),
    );
    expect(popoutUrlBlock).toContain("url.searchParams.set('surfaceId'");
    expect(popoutUrlBlock).not.toContain("url.searchParams.set('url'");
    expect(popoutUrlBlock).not.toContain("url.searchParams.set('directory'");
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
