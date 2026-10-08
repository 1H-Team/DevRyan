const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const fixtureUrl = process.env.DEVRYAN_VISUAL_FIXTURE_URL;
if (!fixtureUrl) throw new Error('DEVRYAN_VISUAL_FIXTURE_URL is required');
const debuggingPort = Number.parseInt(process.env.DEVRYAN_VISUAL_DEBUG_PORT || '', 10);
if (!Number.isSafeInteger(debuggingPort) || debuggingPort < 1) {
  throw new Error('DEVRYAN_VISUAL_DEBUG_PORT is required');
}

// Keep the profile out of ~/Library/Application Support unless the caller chose one.
if (!app.commandLine.hasSwitch('user-data-dir')) {
  const marker = `${path.sep}.cache${path.sep}e2e${path.sep}`;
  const at = process.execPath.indexOf(marker);
  app.setPath('userData', process.env.DEVRYAN_VISUAL_USER_DATA_DIR
    || (at >= 0 ? path.join(process.execPath.slice(0, at + marker.length), 'production-bots-visual-userdata')
      : path.join(require('node:os').tmpdir(), 'devryan-production-bots-visual-user-data')));
}

app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('remote-debugging-port', String(debuggingPort));

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    x: process.env.DEVRYAN_VISUAL_HEADLESS === '1' ? -10_000 : undefined,
    y: process.env.DEVRYAN_VISUAL_HEADLESS === '1' ? -10_000 : undefined,
    show: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await window.loadURL(fixtureUrl);

  const shutdown = () => {
    window.destroy();
    app.quit();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}).catch((error) => {
  console.error('[production-bots-visual-shell]', error);
  app.exit(1);
});
