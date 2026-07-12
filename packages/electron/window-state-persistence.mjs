export const persistWindowState = async ({
  browserWindow,
  mainWindowID,
  minWidth,
  minHeight,
  mutateSettingsRoot,
}) => {
  if (!browserWindow || browserWindow.isDestroyed()) {
    return false;
  }
  if (browserWindow.id !== mainWindowID) {
    return false;
  }

  // BrowserWindow methods become invalid as soon as the native window is
  // destroyed. Capture every value before queueing the asynchronous settings
  // mutation so shutdown cannot leave a deferred callback holding the window.
  const bounds = browserWindow.getBounds();
  const windowState = {
    x: bounds.x,
    y: bounds.y,
    width: Math.max(bounds.width, minWidth),
    height: Math.max(bounds.height, minHeight),
    maximized: browserWindow.isMaximized(),
    fullscreen: browserWindow.isFullScreen(),
  };

  await mutateSettingsRoot((root) => {
    root.desktopWindowState = windowState;
  });
  return true;
};
