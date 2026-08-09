import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';

import {
  BROWSER_DEVTOOLS_DOCK_MODE,
  BROWSER_DEVTOOLS_HOST_MODE,
  createBrowserDevToolsController,
} from '../browser-devtools-controller.mjs';

let nextGuestId = 1;

const createGuest = ({ open = false, destroyed = false, reportsCustomHostOpen = true, emitsOpenEvent = true } = {}) => {
  const guest = new EventEmitter();
  let devToolsOpen = open;
  let devToolsContents = null;
  const calls = [];
  Object.assign(guest, {
    id: nextGuestId++,
    calls,
    closeDevTools() {
      calls.push({ method: 'closeDevTools' });
      queueMicrotask(() => {
        devToolsOpen = false;
        guest.emit('devtools-closed');
      });
    },
    isDestroyed: () => destroyed,
    isDevToolsOpened: () => reportsCustomHostOpen && devToolsOpen,
    openDevTools(options) {
      calls.push({ method: 'openDevTools', options });
      queueMicrotask(() => {
        devToolsOpen = true;
        if (devToolsContents) {
          devToolsContents.url = 'devtools://devtools/bundled/devtools_app.html';
          devToolsContents.emit('did-finish-load');
        }
        if (emitsOpenEvent) guest.emit('devtools-opened');
      });
    },
    setDevToolsWebContents(webContents) {
      calls.push({ method: 'setDevToolsWebContents', webContents });
      devToolsContents = webContents;
    },
  });
  return guest;
};

const createHarness = () => {
  const childViews = [];
  const ownerWindow = {
    contentView: {
      addChildView(view) { childViews.push(view); },
      removeChildView(view) {
        const index = childViews.indexOf(view);
        if (index >= 0) childViews.splice(index, 1);
      },
    },
    getContentBounds: () => ({ width: 1200, height: 800 }),
    isDestroyed: () => false,
  };
  const views = [];
  const createDevToolsView = () => {
    let destroyed = false;
    const contents = new EventEmitter();
    Object.assign(contents, {
      url: '',
      close() { destroyed = true; },
      getURL() { return contents.url; },
      isDestroyed: () => destroyed,
    });
    const view = {
      bounds: null,
      setBounds(bounds) { view.bounds = bounds; },
      webContents: contents,
    };
    views.push(view);
    return view;
  };
  return {
    childViews,
    controller: createBrowserDevToolsController({ createDevToolsView }),
    ownerWindow,
    views,
  };
};

describe('browser DevTools controller', () => {
  test('opens Chromium DevTools in a visible custom bottom dock', async () => {
    const harness = createHarness();
    const guest = createGuest();

    await expect(harness.controller.setOpen({
      guest,
      ownerWindow: harness.ownerWindow,
      bounds: { x: 700, y: 500, width: 500, height: 300 },
      open: true,
    })).resolves.toEqual({ open: true });
    expect(guest.calls).toEqual([
      { method: 'setDevToolsWebContents', webContents: harness.views[0].webContents },
      { method: 'openDevTools', options: { mode: BROWSER_DEVTOOLS_HOST_MODE, activate: true } },
    ]);
    expect(BROWSER_DEVTOOLS_DOCK_MODE).toBe('bottom');
    expect(BROWSER_DEVTOOLS_HOST_MODE).toBe('detach');
    expect(harness.views[0].bounds).toEqual({ x: 700, y: 500, width: 500, height: 300 });
    expect(harness.childViews).toEqual([harness.views[0]]);
  });

  test('trusts the native opened event when a webview custom host reports false', async () => {
    const harness = createHarness();
    const guest = createGuest({ reportsCustomHostOpen: false });

    await expect(harness.controller.setOpen({
      guest,
      ownerWindow: harness.ownerWindow,
      bounds: { x: 700, y: 500, width: 500, height: 300 },
      open: true,
    })).resolves.toEqual({ open: true });
    expect(harness.childViews).toEqual([harness.views[0]]);

    await expect(harness.controller.setOpen({ guest, ownerWindow: harness.ownerWindow, open: false }))
      .resolves.toEqual({ open: false });
    expect(guest.calls.at(-1)).toEqual({ method: 'closeDevTools' });
    expect(harness.childViews).toEqual([]);
  });

  test('trusts the custom DevTools view URL when the guest omits opened state and event', async () => {
    const harness = createHarness();
    const guest = createGuest({ reportsCustomHostOpen: false, emitsOpenEvent: false });

    await expect(harness.controller.setOpen({
      guest,
      ownerWindow: harness.ownerWindow,
      bounds: { x: 700, y: 500, width: 500, height: 300 },
      open: true,
    })).resolves.toEqual({ open: true });
    expect(harness.views[0].webContents.getURL().startsWith('devtools://')).toBe(true);
    expect(harness.childViews).toEqual([harness.views[0]]);
  });

  test('closes and destroys an open custom dock', async () => {
    const harness = createHarness();
    const guest = createGuest();
    await harness.controller.setOpen({
      guest,
      ownerWindow: harness.ownerWindow,
      bounds: { x: 700, y: 500, width: 500, height: 300 },
      open: true,
    });

    await expect(harness.controller.setOpen({ guest, ownerWindow: harness.ownerWindow, open: false }))
      .resolves.toEqual({ open: false });
    expect(guest.calls.at(-1)).toEqual({ method: 'closeDevTools' });
    expect(harness.childViews).toEqual([]);
    expect(harness.views[0].webContents.isDestroyed()).toBe(true);
  });

  test('updates bounds idempotently without reopening DevTools', async () => {
    const harness = createHarness();
    const guest = createGuest();
    await harness.controller.setOpen({
      guest,
      ownerWindow: harness.ownerWindow,
      bounds: { x: 700, y: 500, width: 500, height: 300 },
      open: true,
    });

    await expect(harness.controller.setOpen({
      guest,
      ownerWindow: harness.ownerWindow,
      bounds: { x: 650, y: 450, width: 550, height: 350 },
      open: true,
    })).resolves.toEqual({ open: true });
    expect(guest.calls.filter((call) => call.method === 'openDevTools')).toHaveLength(1);
    expect(harness.views[0].bounds).toEqual({ x: 650, y: 450, width: 550, height: 350 });
  });

  test('rehosts an open dock with the same guest and DevTools view', async () => {
    const harness = createHarness();
    const guest = createGuest();
    await harness.controller.setOpen({
      guest,
      ownerWindow: harness.ownerWindow,
      bounds: { x: 700, y: 500, width: 500, height: 300 },
      open: true,
    });
    const otherViews = [];
    const otherWindow = {
      contentView: {
        addChildView(view) { otherViews.push(view); },
        removeChildView(view) {
          const index = otherViews.indexOf(view);
          if (index >= 0) otherViews.splice(index, 1);
        },
      },
      getContentBounds: () => ({ width: 900, height: 600 }),
      isDestroyed: () => false,
    };

    expect(harness.controller.isOpen(guest.id)).toBe(true);
    expect(harness.controller.rehost({
      guest,
      ownerWindow: otherWindow,
      bounds: { x: 0, y: 300, width: 900, height: 300 },
    })).toEqual({ open: true });
    expect(harness.childViews).toEqual([]);
    expect(otherViews).toEqual([harness.views[0]]);
    expect(harness.views[0].bounds).toEqual({ x: 0, y: 300, width: 900, height: 300 });
    expect(guest.calls.filter((call) => call.method === 'openDevTools')).toHaveLength(1);
  });

  test('clamps renderer-provided bounds to the owning window', async () => {
    const harness = createHarness();
    const guest = createGuest();
    await harness.controller.setOpen({
      guest,
      ownerWindow: harness.ownerWindow,
      bounds: { x: 1_100, y: 700, width: 500, height: 300 },
      open: true,
    });
    expect(harness.views[0].bounds).toEqual({ x: 1100, y: 700, width: 100, height: 100 });
  });

  test('rejects invalid guests, owners, and bounds', async () => {
    const harness = createHarness();
    await expect(harness.controller.setOpen({ guest: null, ownerWindow: harness.ownerWindow, open: true }))
      .rejects.toThrow('Browser webview is required');
    await expect(harness.controller.setOpen({ guest: createGuest({ destroyed: true }), ownerWindow: harness.ownerWindow, open: true }))
      .rejects.toThrow('Browser webview is not available');
    await expect(harness.controller.setOpen({ guest: { id: 1, isDestroyed: () => false }, ownerWindow: harness.ownerWindow, open: true }))
      .rejects.toThrow('does not support DevTools');
    await expect(harness.controller.setOpen({ guest: createGuest(), ownerWindow: null, open: true }))
      .rejects.toThrow('Browser window is not available');
    await expect(harness.controller.setOpen({ guest: createGuest(), ownerWindow: harness.ownerWindow, open: true }))
      .rejects.toThrow('dock bounds are required');
  });
});

describe('desktop browser DevTools IPC boundary', () => {
  const mainSource = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8');

  test('routes DevTools through an owner-validated surface ID', () => {
    const commandStart = mainSource.indexOf("case 'desktop_browser_devtools_set_open':");
    const commandEnd = mainSource.indexOf("case 'desktop_capture_page_rect':", commandStart);
    const commandBlock = mainSource.slice(commandStart, commandEnd);

    expect(commandStart).toBeGreaterThan(-1);
    expect(commandBlock).toContain('getBrowserSurfaceManager().setDevTools(browserWindow, args)');
    expect(commandBlock).not.toContain('webContentsId');
  });

  test('revalidates remote-origin DevTools through the native Browser authorization gate', () => {
    const nativeCommands = mainSource.slice(
      mainSource.indexOf('const NATIVE_BROWSER_COMMANDS = new Set(['),
      mainSource.indexOf("ipcMain.handle('openchamber:invoke'"),
    );
    const invokeHandler = mainSource.slice(
      mainSource.indexOf("ipcMain.handle('openchamber:invoke'"),
      mainSource.indexOf("ipcMain.handle('openchamber:dialog:open'"),
    );
    expect(nativeCommands).toContain('desktop_browser_devtools_set_open');
    expect(nativeCommands).toContain('const SENSITIVE_NATIVE_BROWSER_COMMANDS');
    expect(invokeHandler).toContain('await authorizeNativeBrowserWindow(browserWindow, { force });');
    expect(invokeHandler.indexOf('await authorizeNativeBrowserWindow')).toBeLessThan(invokeHandler.indexOf('return handleInvoke'));
  });
});
