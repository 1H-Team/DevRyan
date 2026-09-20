// Chromium's throttling policy is shared by contents in the same host window.
// Keep live agent leases out of the inactive manual-tab parking window.
export function createBrowserParkingPool(createWindow) {
  const windows = new Map();
  return {
    windowFor(kind) {
      if (kind !== 'manual' && kind !== 'lease') throw new TypeError('Unknown browser surface kind');
      let window = windows.get(kind);
      if (!window || window.isDestroyed()) {
        window = createWindow(kind);
        windows.set(kind, window);
      }
      return window;
    },
    close() {
      for (const window of windows.values()) if (!window.isDestroyed()) window.destroy();
      windows.clear();
    },
  };
}

export function setBrowserSurfaceScheduling(surface, parked) {
  surface.view.webContents.setBackgroundThrottling?.(parked && surface.kind === 'manual');
}
