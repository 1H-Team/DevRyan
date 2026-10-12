import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildStartupSplashHtml, buildStartupErrorHtml, resolveStartupSplashPalette } from './startup-splash.mjs';

let configured = false;
let earlyWindow = null;
let releaseWindowGuards = () => {};
let closedBeforeMain = false;
let releaseAppGuards = () => {};
const deferredLinks = [];

export function configureEarlyStartup({ app, isPreview, WINDOWS_PREVIEW_NAME, APP_USER_MODEL_ID,
  isRuntimeServiceMode, isRuntimeServiceControlProbe }) {
  if (configured) return true;
  if (typeof process.env.OPENCHAMBER_ELECTRON_USER_DATA_DIR === 'string') {
    const configuredUserDataDirectory = process.env.OPENCHAMBER_ELECTRON_USER_DATA_DIR;
    if (!path.isAbsolute(configuredUserDataDirectory) || /[\u0000-\u001f]/.test(configuredUserDataDirectory)) {
      throw new Error('Electron user data directory must be an absolute path');
    }
    const devUserDataDirectory = path.resolve(configuredUserDataDirectory);
    fs.mkdirSync(devUserDataDirectory, { recursive: true });
    // A packaged development binary otherwise contends with the installed app's
    // single-instance lock and Chromium profile. Isolate both before acquiring
    // the lock so visual verification never disrupts the user's running app.
    app.setPath('userData', devUserDataDirectory);
  }

  // The background runtime service and the status probe run from the same app
  // bundle as the foreground window. Without this, macOS registers them as
  // regular apps and shows a second "DevRyan" in the Dock.
  const hideHeadlessProcessFromDock = () => {
    if (process.platform !== 'darwin') return;
    try {
      app.dock?.hide();
    } catch {
    }
  };

  if (isRuntimeServiceMode || isRuntimeServiceControlProbe) {
    hideHeadlessProcessFromDock();
  }

  if (isRuntimeServiceMode) {
    const serviceUserDataDirectory = `${app.getPath('userData')}-runtime-service`;
    fs.mkdirSync(serviceUserDataDirectory, { recursive: true });
    app.setPath('userData', serviceUserDataDirectory);
  }

  if (!isRuntimeServiceControlProbe && !app.requestSingleInstanceLock()) {
    app.exit(0);
    return false;
  }

  // Set the product name early so electron-log derives its log directory as
  // ~/Library/Logs/DevRyan/ (not ~/Library/Logs/@openchamber/electron/).
  app.setName(isPreview ? WINDOWS_PREVIEW_NAME : 'DevRyan');
  app.setAppUserModelId(APP_USER_MODEL_ID);
  app.commandLine.appendSwitch('proxy-bypass-list', '<-loopback>');

  configured = true;
  return true;
}

export function createStartupWindowOptions({ app, isPreview = false, palette,
  localOrigin = '', serverOrigin = '', bootOutcome = null, macosMajor = 0 }) {
  return {
    title: 'DevRyan', width: 1280, height: 800, minWidth: 800, minHeight: 520, show: false,
    backgroundColor: palette.background,
    titleBarStyle: process.platform === 'darwin' ? 'hidden' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 16, y: 17 } : undefined,
    webPreferences: {
      additionalArguments: [
        `--devryan-runtime-mode=${isPreview ? 'standard-preview' : 'native'}`,
        `--openchamber-local-origin=${localOrigin}`,
        `--openchamber-server-origin=${serverOrigin}`,
        `--openchamber-home=${os.homedir() || ''}`,
        `--openchamber-macos-major=${macosMajor}`,
        `--openchamber-boot-outcome=${JSON.stringify(bootOutcome)}`,
      ],
      preload: path.join(app.getAppPath(), 'preload.mjs'),
      backgroundThrottling: false, contextIsolation: true, nodeIntegration: false,
      // The compatibility preload needs Electron's Node layer; guest webviews remain sandboxed.
      sandbox: false, webviewTag: true,
    },
  };
}

export function deferEarlyAppEvents(app) {
  const onSecond = (_event, argv) => {
    if (Array.isArray(argv)) deferredLinks.push(...argv.filter(arg => typeof arg === 'string' && arg.startsWith('openchamber://')));
    if (earlyWindow && !earlyWindow.isDestroyed()) { earlyWindow.show(); earlyWindow.focus(); }
  };
  const onUrl = (event, url) => { event.preventDefault(); deferredLinks.push(url); };
  app.on('second-instance', onSecond);
  app.on('open-url', onUrl);
  releaseAppGuards = () => { app.removeListener('second-instance', onSecond); app.removeListener('open-url', onUrl); };
}

export function takeEarlyAppLinks() {
  releaseAppGuards();
  return deferredLinks.splice(0);
}

export async function showEarlyStartupWindow({ app, BrowserWindow, nativeTheme }) {
  const palette = resolveStartupSplashPalette({}, nativeTheme.shouldUseDarkColors);
  const window = new BrowserWindow(createStartupWindowOptions({ app, palette,
    macosMajor: Number(os.release().split('.')[0]) >= 20 ? Number(os.release().split('.')[0]) - 9 : 0 }));
  earlyWindow = window;
  const splash = `data:text/html;charset=utf-8,${encodeURIComponent(buildStartupSplashHtml())}`;
  const denyNavigation = (event, url) => { if (url !== splash) event.preventDefault(); };
  const denyGuest = event => event.preventDefault();
  const onClose = () => { closedBeforeMain = true; app.quit(); };
  window.on('close', onClose);
  window.webContents.on('will-navigate', denyNavigation);
  window.webContents.on('will-attach-webview', denyGuest);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  releaseWindowGuards = () => {
    window.removeListener('close', onClose);
    window.webContents.removeListener('will-navigate', denyNavigation);
    window.webContents.removeListener('will-attach-webview', denyGuest);
  };
  const shown = new Promise(resolve => {
    window.once('ready-to-show', () => { if (!closedBeforeMain) { window.show(); window.focus(); } resolve(); });
    window.once('closed', resolve);
  });
  await window.loadURL(splash);
  await shown;
  if (closedBeforeMain) return false;
  // Yield Chromium two frames after show before main's evaluation can occupy this thread.
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  return !closedBeforeMain;
}

export function takeEarlyStartupWindow() {
  const window = earlyWindow;
  earlyWindow = null;
  if (!window || window.isDestroyed()) return null;
  releaseWindowGuards();
  return window;
}


export async function showEarlyStartupFailure({ app, clipboard, dialog }) {
  const message = 'DevRyan could not finish loading. Retry to restart the app.';
  const window = earlyWindow;
  if (!window || window.isDestroyed()) {
    await dialog.showMessageBox({ type: 'error', title: 'DevRyan startup failed', message,
      buttons: ['Quit'] });
    app.quit();
    return;
  }
  releaseWindowGuards();
  const failureUrl = `data:text/html;charset=utf-8,${encodeURIComponent(buildStartupErrorHtml({}, { message }))}`;
  window.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    if (window.webContents.getURL() !== failureUrl) return;
    if (url === 'openchamber://retry-startup') { app.relaunch(); app.quit(); }
    if (url === 'openchamber://copy-startup-diagnostics') clipboard.writeText('{"code":"electron_main_import_failed"}');
  });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  await window.loadURL(failureUrl);
  window.show();
  window.focus();
}
