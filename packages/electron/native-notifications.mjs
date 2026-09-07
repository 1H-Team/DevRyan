export function createNativeNotifications({ BrowserWindow, Notification, app, platform, getMainWindow, emitToAllWindows }) {
  const normalizeNotificationInput = (raw) => {
    if (!raw || typeof raw !== 'object') return {};
    // UI IPC path wraps in { payload: {...} }; sidecar stdout path is flat.
    if (raw.payload && typeof raw.payload === 'object') {
      return { ...raw, ...raw.payload };
    }
    return raw;
  };

  const isAnyWindowFocused = () =>
    BrowserWindow.getAllWindows().some(
      (window) => !window.isDestroyed() && window.isFocused(),
    );

  const focusForegroundWindow = () => {
    const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed());
    if (windows.length === 0) return;
    const target = getMainWindow() && !getMainWindow().isDestroyed()
      ? getMainWindow()
      : windows.find((window) => window.isVisible()) || windows[0];
    // macOS: bring the app to foreground FIRST. When the window is minimized
    // to the Dock or hidden via Cmd+H, the app is in the background, and
    // subsequent window.show/restore/focus calls won't pull it forward
    // unless app.focus runs first.
    if (platform === 'darwin') app.focus({ steal: true });
    if (target.isMinimized()) target.restore();
    target.show();
    target.focus();
    if (typeof target.moveTop === 'function') target.moveTop();
  };

  // Keep references to live notifications so they aren't garbage-collected
  // before the OS fires click/close. On macOS, losing the JS reference causes
  // click events to silently stop firing after ~1 min.
  // See https://blog.bloomca.me/2025/02/22/electron-mac-notifications
  const activeNotifications = new Set();

  const maybeShowNativeNotification = (rawInput) => {
    const payload = normalizeNotificationInput(rawInput);
    const requireHidden = Boolean(payload.requireHidden ?? payload.require_hidden);

    if (requireHidden && isAnyWindowFocused()) {
      return;
    }

    if (!Notification.isSupported()) {
      return;
    }

    const title = typeof payload.title === 'string' && payload.title.trim()
      ? payload.title.trim()
      : 'DevRyan';
    const body = typeof payload.body === 'string' ? payload.body : '';
    const sessionId = typeof payload.sessionId === 'string' && payload.sessionId.trim()
      ? payload.sessionId.trim()
      : null;

    const notification = new Notification({
      title,
      body,
      silent: false,
      ...(platform === 'darwin' ? { sound: 'Glass' } : {}),
    });

    activeNotifications.add(notification);
    const release = () => { activeNotifications.delete(notification); };

    notification.on('click', () => {
      focusForegroundWindow();
      if (sessionId) {
        emitToAllWindows('openchamber:open-session', { sessionId });
      }
      release();
    });
    notification.on('close', release);
    notification.on('failed', release);

    notification.show();
  };

  return { maybeShowNativeNotification, focusForegroundWindow, isAnyWindowFocused };
}
