// Keep the import graph small until Chromium has painted the existing splash.
import { app, BrowserWindow, nativeTheme, clipboard, dialog } from 'electron';
import { configureEarlyStartup, deferEarlyAppEvents, showEarlyStartupWindow, showEarlyStartupFailure } from './early-startup.mjs';

const service = process.argv.includes('--runtime-service');
const probe = process.argv.includes('--runtime-service-control=status');
if (!configureEarlyStartup({ app, isPreview: false, APP_USER_MODEL_ID:
  'dev.devryan.desktop',
  isRuntimeServiceMode: service, isRuntimeServiceControlProbe: probe })) process.exit(0);
deferEarlyAppEvents(app);
app.whenReady().then(async () => {
  if (!service && !probe && !await showEarlyStartupWindow({ app, BrowserWindow, nativeTheme })) return;
  await import('./main.mjs');
}).catch(async () => {
  // Do not expose raw paths or failed import metadata through the early renderer.
  console.error('[electron] startup failed before the main module loaded');
  if (service || probe) { app.exit(1); return; }
  await showEarlyStartupFailure({ app, clipboard, dialog });
});
