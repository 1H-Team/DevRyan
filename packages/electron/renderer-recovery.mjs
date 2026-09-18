// Recovery belongs to the native host: a dead renderer cannot display a React
// boundary or handle a menu event. Reload only this window, never its runtime.
export function installRendererRecovery({
  browserWindow,
  shouldQuit,
  showMessageBox,
  log,
  schedule = setTimeout,
  cancel = clearTimeout,
  stableMs = 60_000,
  loadTimeoutMs = 30_000,
}) {
  const contents = browserWindow.webContents;
  let disposed = false;
  let attempted = false;
  let recovering = false;
  let promptPending = false;
  let loadFailed = false;
  let navigation = 0;
  let reloadTimer = null;
  let deadline = null;
  let stableTimer = null;
  const alive = () => !disposed && !shouldQuit()
    && !browserWindow.isDestroyed() && !contents.isDestroyed();
  const record = (event) => log.info('[renderer] recovery', {
    windowId: browserWindow.id,
    event,
  });
  const clearTimers = () => {
    for (const timer of [reloadTimer, deadline, stableTimer]) {
      if (timer !== null) cancel(timer);
    }
    reloadTimer = deadline = stableTimer = null;
  };

  const prompt = async () => {
    if (!alive() || promptPending) return;
    promptPending = true;
    const currentNavigation = navigation;
    record('manual_recovery_required');
    try {
      const { response } = await showMessageBox(browserWindow, {
        type: 'warning',
        title: 'DevRyan window recovery',
        message: 'This window stopped responding or could not be restored.',
        detail: 'Reload this window to reconnect. Reloading does not restart the background runtime. Text that was not saved may need to be entered again.',
        buttons: ['Reload Window', 'Later'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (response === 0 && alive() && navigation === currentNavigation) {
        queueReload();
      }
    } catch {
      record('recovery_dialog_failed');
    } finally {
      promptPending = false;
    }
  };

  const queueReload = () => {
    clearTimers();
    if (!alive()) return;
    attempted = true;
    recovering = true;
    // Yield out of render-process-gone; an ordinary navigation/close in the
    // meantime cancels the scheduled reload.
    reloadTimer = schedule(() => {
      reloadTimer = null;
      if (!alive()) return;
      record('reload_started');
      deadline = schedule(() => {
        deadline = null;
        void prompt();
      }, loadTimeoutMs);
      try {
        contents.reload();
      } catch {
        clearTimers();
        void prompt();
      }
    }, 0);
  };

  const onGone = (_event, details) => {
    log.error('[renderer] render process exited', {
      label: browserWindow.__ocLabel,
      windowId: browserWindow.id,
      reason: details?.reason || 'unknown',
      exitCode: Number.isInteger(details?.exitCode) ? details.exitCode : null,
    });
    clearTimers();
    if (!alive()) return;
    recovering = true;
    // An unexpected clean-exit still leaves a live BrowserWindow blank.
    // Only shutdown/destruction makes that exit expected.
    if (!attempted) queueReload();
    else void prompt();
  };
  const onNavigation = (_event, _url, isInPlace, isMainFrame) => {
    if (!isMainFrame || isInPlace) return;
    navigation += 1;
    loadFailed = false;
    if (reloadTimer !== null) {
      cancel(reloadTimer);
      reloadTimer = null;
    }
    if (stableTimer !== null) {
      cancel(stableTimer);
      stableTimer = null;
    }
  };
  const onLoaded = () => {
    if (loadFailed) return;
    clearTimers();
    navigation += 1;
    if (!alive() || !attempted) return;
    if (recovering) record('reload_completed');
    recovering = false;
    // A loaded document alone must not reset the crash-loop budget.
    stableTimer = schedule(() => {
      stableTimer = null;
      if (alive()) attempted = false;
    }, stableMs);
  };
  const onFailed = (_event, code, _description, _url, isMainFrame) => {
    if (!recovering || !isMainFrame || code === -3) return;
    loadFailed = true;
    clearTimers();
    void prompt();
  };
  const dispose = () => {
    disposed = true;
    clearTimers();
    contents.removeListener('render-process-gone', onGone);
    contents.removeListener('did-start-navigation', onNavigation);
    contents.removeListener('did-finish-load', onLoaded);
    contents.removeListener('did-fail-load', onFailed);
    contents.removeListener('destroyed', dispose);
    browserWindow.removeListener('closed', dispose);
  };
  contents.on('render-process-gone', onGone);
  contents.on('did-start-navigation', onNavigation);
  contents.on('did-finish-load', onLoaded);
  contents.on('did-fail-load', onFailed);
  contents.once('destroyed', dispose);
  browserWindow.once('closed', dispose);
  return dispose;
}
