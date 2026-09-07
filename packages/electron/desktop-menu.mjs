export function createDesktopMenu({ BrowserWindow, Menu, app, shell, log, getMainWindow,
  emitToWindow, emitToAllWindows, handleInvoke,
  GITHUB_BUG_REPORT_URL, GITHUB_FEATURE_REQUEST_URL, DISCORD_INVITE_URL,
}) {
  const dispatchDomEventToWindow = (browserWindow, event, detail) => {
    if (!browserWindow || browserWindow.isDestroyed()) return;

    const eventLiteral = JSON.stringify(event);
    const script = detail === undefined
      ? `window.dispatchEvent(new Event(${eventLiteral}));`
      : `window.dispatchEvent(new CustomEvent(${eventLiteral}, { detail: ${JSON.stringify(detail)} }));`;

    void browserWindow.webContents.executeJavaScript(script, true).catch(() => {});
  };

  const getMenuTargetWindow = () => {
    const focused = BrowserWindow.getFocusedWindow();
    if (focused && !focused.isDestroyed()) return focused;
    if (getMainWindow() && !getMainWindow().isDestroyed()) return getMainWindow();
    const [firstWindow] = BrowserWindow.getAllWindows();
    return firstWindow && !firstWindow.isDestroyed() ? firstWindow : null;
  };

  const dispatchMenuAction = (action) => {
    const target = getMenuTargetWindow();
    emitToWindow(target, 'openchamber:menu-action', action);
    dispatchDomEventToWindow(target, 'openchamber:menu-action', action);
  };

  const dispatchCheckForUpdates = () => {
    emitToAllWindows('openchamber:check-for-updates');
    for (const browserWindow of BrowserWindow.getAllWindows()) {
      dispatchDomEventToWindow(browserWindow, 'openchamber:check-for-updates');
    }
  };

  const buildMacMenu = () => {
    const dispatchAction = (action) => dispatchMenuAction(action);
    const handleCopyAction = () => {
      BrowserWindow.getFocusedWindow()?.webContents.copy();
      dispatchAction('copy');
    };

    return Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: 'about' },
          {
            label: 'Check for Updates',
            click: () => dispatchCheckForUpdates(),
          },
          { type: 'separator' },
          { label: 'Settings', accelerator: 'Cmd+,', click: () => dispatchAction('settings') },
          { label: 'Command Palette', accelerator: 'Cmd+P', click: () => dispatchAction('command-palette') },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      {
        label: 'File',
        submenu: [
          { label: 'New Window', accelerator: 'Cmd+Shift+Alt+N', click: () => void handleInvoke(null, 'desktop_new_window') },
          { type: 'separator' },
          { label: 'New Session', accelerator: 'Cmd+N', click: () => dispatchAction('new-session') },
          { label: 'New Worktree', accelerator: 'Cmd+Shift+N', click: () => dispatchAction('new-worktree-session') },
          { type: 'separator' },
          { label: 'Add Workspace', click: () => dispatchAction('change-workspace') },
          { type: 'separator' },
          { role: 'close' },
        ],
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { label: 'Copy', accelerator: 'Cmd+C', click: () => handleCopyAction() },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
      {
        label: 'View',
        submenu: [
          { label: 'Git', accelerator: 'Cmd+G', click: () => dispatchAction('open-git-tab') },
          { label: 'Diff', accelerator: 'Cmd+E', click: () => dispatchAction('open-diff-tab') },
          { label: 'Terminal', accelerator: 'Cmd+T', click: () => dispatchAction('open-terminal-tab') },
          { type: 'separator' },
          { label: 'Light Theme', click: () => dispatchAction('theme-light') },
          { label: 'Dark Theme', click: () => dispatchAction('theme-dark') },
          { label: 'System Theme', click: () => dispatchAction('theme-system') },
          { type: 'separator' },
          { label: 'Toggle Session Sidebar', accelerator: 'Cmd+Alt+L', click: () => dispatchAction('toggle-sidebar') },
          { label: 'Toggle Memory Debug', accelerator: 'Cmd+Shift+D', click: () => dispatchAction('toggle-memory-debug') },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      {
        label: 'Window',
        submenu: [
          { role: 'minimize' },
          { role: 'zoom' },
          { type: 'separator' },
          { role: 'close' },
        ],
      },
      {
        label: 'Help',
        submenu: [
          { label: 'Keyboard Shortcuts', accelerator: 'Cmd+.', click: () => dispatchAction('help-dialog') },
          { label: 'Show Diagnostics', accelerator: 'Cmd+Shift+L', click: () => dispatchAction('download-logs') },
          { type: 'separator' },
          {
            label: 'Clear Cache',
            click: () => {
              void handleInvoke(null, 'desktop_clear_cache').catch((error) => {
                log.warn('[electron] failed to clear cache from menu:', error);
              });
            },
          },
          { type: 'separator' },
          { label: 'Report a Bug', click: () => shell.openExternal(GITHUB_BUG_REPORT_URL) },
          { label: 'Request a Feature', click: () => shell.openExternal(GITHUB_FEATURE_REQUEST_URL) },
          { type: 'separator' },
          { label: 'Join Discord', click: () => shell.openExternal(DISCORD_INVITE_URL) },
        ],
      },
    ]);
  };

  return { buildMacMenu, dispatchMenuAction, dispatchCheckForUpdates, dispatchDomEventToWindow };
}
