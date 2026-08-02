// Native Chromium DevTools lifecycle for an already-validated in-app browser
// guest. Guest ownership, type, and partition checks stay in main.mjs; this
// module owns the custom dock view and keeps its lifecycle directly testable.

export const BROWSER_DEVTOOLS_DOCK_MODE = 'bottom';
// Electron requires `detach` when DevTools renders into caller-owned
// WebContents. The WebContentsView bounds provide the actual bottom dock.
export const BROWSER_DEVTOOLS_HOST_MODE = 'detach';

const DEVTOOLS_STATE_TIMEOUT_MS = 2_000;
const DEVTOOLS_URL_PREFIX = 'devtools://';

const assertControllableGuest = (guest) => {
  if (!guest || typeof guest !== 'object') {
    throw new Error('Browser webview is required');
  }
  if (typeof guest.isDestroyed === 'function' && guest.isDestroyed()) {
    throw new Error('Browser webview is not available');
  }
  if (
    typeof guest.isDevToolsOpened !== 'function'
    || typeof guest.openDevTools !== 'function'
    || typeof guest.closeDevTools !== 'function'
    || typeof guest.setDevToolsWebContents !== 'function'
  ) {
    throw new Error('Browser webview does not support DevTools');
  }
};

const assertOwnerWindow = (ownerWindow) => {
  if (!ownerWindow || typeof ownerWindow !== 'object' || ownerWindow.isDestroyed?.()) {
    throw new Error('Browser window is not available');
  }
  if (
    !ownerWindow.contentView
    || typeof ownerWindow.contentView.addChildView !== 'function'
    || typeof ownerWindow.contentView.removeChildView !== 'function'
  ) {
    throw new Error('Browser window does not support docked DevTools');
  }
};

const normalizeDockBounds = (rawBounds, ownerWindow) => {
  const ownerBounds = ownerWindow.getContentBounds?.();
  const ownerWidth = Number.isFinite(ownerBounds?.width) ? Math.max(1, Math.floor(ownerBounds.width)) : null;
  const ownerHeight = Number.isFinite(ownerBounds?.height) ? Math.max(1, Math.floor(ownerBounds.height)) : null;
  if (ownerWidth === null || ownerHeight === null) {
    throw new Error('Browser window bounds are unavailable');
  }

  const x = Number.isFinite(rawBounds?.x) ? Math.max(0, Math.floor(rawBounds.x)) : null;
  const y = Number.isFinite(rawBounds?.y) ? Math.max(0, Math.floor(rawBounds.y)) : null;
  const width = Number.isFinite(rawBounds?.width) ? Math.max(1, Math.floor(rawBounds.width)) : null;
  const height = Number.isFinite(rawBounds?.height) ? Math.max(1, Math.floor(rawBounds.height)) : null;
  if (x === null || y === null || width === null || height === null) {
    throw new Error('DevTools dock bounds are required');
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

const waitForDevToolsState = async (guest, shouldOpen) => {
  if (guest.isDevToolsOpened() === shouldOpen) return shouldOpen;
  const eventName = shouldOpen ? 'devtools-opened' : 'devtools-closed';
  if (typeof guest.once !== 'function') return guest.isDevToolsOpened();

  return new Promise((resolve) => {
    let settled = false;
    const finish = (eventObserved) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      guest.removeListener?.(eventName, onEvent);
      resolve(eventObserved ? shouldOpen : guest.isDevToolsOpened());
    };
    const onEvent = () => finish(true);
    const timer = setTimeout(() => finish(false), DEVTOOLS_STATE_TIMEOUT_MS);
    guest.once(eventName, onEvent);
  });
};

const isDevToolsViewReady = (view) => {
  const contents = view?.webContents;
  if (!contents || contents.isDestroyed?.()) return false;
  try {
    return typeof contents.getURL === 'function' && contents.getURL().startsWith(DEVTOOLS_URL_PREFIX);
  } catch {
    return false;
  }
};

const waitForDevToolsViewReady = async (view) => {
  if (isDevToolsViewReady(view)) return true;
  const contents = view?.webContents;
  if (typeof contents?.once !== 'function') return false;

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      contents.removeListener?.('did-finish-load', finish);
      contents.removeListener?.('destroyed', finish);
      resolve(isDevToolsViewReady(view));
    };
    const timer = setTimeout(finish, DEVTOOLS_STATE_TIMEOUT_MS);
    contents.once('did-finish-load', finish);
    contents.once('destroyed', finish);
  });
};

export const createBrowserDevToolsController = ({ createDevToolsView }) => {
  if (typeof createDevToolsView !== 'function') {
    throw new Error('createDevToolsView is required');
  }

  const entries = new Map();

  const destroyEntry = (guestId) => {
    const entry = entries.get(guestId);
    if (!entry) return;
    entries.delete(guestId);
    entry.guest.removeListener?.('devtools-closed', entry.onClosed);
    try { entry.ownerWindow.contentView.removeChildView(entry.view); } catch { }
    try {
      if (!entry.view.webContents?.isDestroyed?.()) entry.view.webContents?.close?.();
    } catch { }
  };

  const closeOtherDocksForWindow = async (ownerWindow, exceptGuestId) => {
    const closing = [];
    for (const [guestId, entry] of entries) {
      if (guestId === exceptGuestId || entry.ownerWindow !== ownerWindow) continue;
      if (!entry.guest.isDestroyed?.()) {
        entry.guest.closeDevTools();
        closing.push(waitForDevToolsState(entry.guest, false));
      }
      destroyEntry(guestId);
    }
    await Promise.all(closing);
  };

  const setOpen = async ({ guest, ownerWindow, bounds, open }) => {
    assertControllableGuest(guest);
    assertOwnerWindow(ownerWindow);
    const guestId = guest.id;
    if (!Number.isFinite(guestId)) throw new Error('Browser webview id is required');

    const shouldOpen = open === true;
    if (!shouldOpen) {
      if (entries.has(guestId) || guest.isDevToolsOpened()) {
        guest.closeDevTools();
        await waitForDevToolsState(guest, false);
      }
      destroyEntry(guestId);
      return { open: false };
    }

    const dockBounds = normalizeDockBounds(bounds, ownerWindow);
    await closeOtherDocksForWindow(ownerWindow, guestId);

    let entry = entries.get(guestId);
    if (!entry) {
      const view = createDevToolsView();
      if (!view?.webContents || typeof view.setBounds !== 'function') {
        throw new Error('Unable to create DevTools dock');
      }
      ownerWindow.contentView.addChildView(view);
      guest.setDevToolsWebContents(view.webContents);
      const onClosed = () => destroyEntry(guestId);
      entry = { guest, ownerWindow, view, onClosed, open: false };
      entries.set(guestId, entry);
      guest.once?.('devtools-closed', onClosed);
    }

    entry.view.setBounds(dockBounds);
    if (!entry.open) {
      const opening = waitForDevToolsState(guest, true);
      const viewOpening = waitForDevToolsViewReady(entry.view);
      guest.openDevTools({ mode: BROWSER_DEVTOOLS_HOST_MODE, activate: true });
      entry.open = isDevToolsViewReady(entry.view)
        || (await opening)
        || (await viewOpening);
    }
    // Electron's <webview> can keep isDevToolsOpened() false when DevTools is
    // rendered in caller-owned WebContents, even though devtools-opened fired.
    // The lifecycle event and owned entry are authoritative for that case.
    const actualOpen = entry.open || guest.isDevToolsOpened();
    if (!actualOpen) destroyEntry(guestId);
    return { open: actualOpen };
  };

  const destroyGuest = (guestId) => destroyEntry(guestId);

  return { destroyGuest, setOpen };
};
