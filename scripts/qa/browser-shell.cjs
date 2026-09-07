// Test-only Chromium host for the standalone web runtime; no desktop preload.
const { app, BrowserWindow } = require('electron');
app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 1280, height: 800, show: process.env.DEVRYAN_QA_BACKGROUND !== '1', webPreferences: { sandbox: true, contextIsolation: true } });
  window.loadURL(process.env.DEVRYAN_QA_ORIGIN);
});
app.on('window-all-closed', () => app.quit());
