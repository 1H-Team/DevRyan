import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import test from 'node:test';
import { createStartupWindowOptions } from '../early-startup.mjs';

const entry = await fs.readFile(new URL('../entry.mjs', import.meta.url), 'utf8');
const packageJson = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
const fresh = () => import(`../early-startup.mjs?fixture=${Math.random()}`);
class FixtureWindow extends EventEmitter {
  constructor(options) {
    super(); this.options = options; this.webContents = new EventEmitter();
    this.webContents.setWindowOpenHandler = handler => { this.openHandler = handler; };
    this.webContents.executeJavaScript = async () => { this.paintYielded = true; };
    this.webContents.getURL = () => this.url;
    FixtureWindow.latest = this;
  }
  async loadURL(url) { this.url = url; queueMicrotask(() => this.emit('ready-to-show')); }
  show() { this.shown = true; }
  focus() { this.focused = true; }
  isDestroyed() { return Boolean(this.destroyed); }
}
const app = () => Object.assign(new EventEmitter(), { getAppPath: () => '/fixture/app', quit() { this.quitRequested = true; } });

test('foreground entry paints before importing main; service and probe do not create windows', () => {
  assert.equal(packageJson.main, './dist-bundle/entry.mjs');
  assert.ok(entry.indexOf('await showEarlyStartupWindow') < entry.indexOf("import('./main.mjs')"));
  assert.match(entry, /if \(!service && !probe/);
  assert.match(entry, /if \(service \|\| probe\) \{ app\.exit\(1\); return; \}/);
  assert.deepEqual(packageJson.build.files.slice(0, 3), ['dist-bundle/entry.mjs', 'dist-bundle/early-startup.mjs', 'dist-bundle/startup-splash.mjs']);
});

test('early splash is adopted once, blocks navigation and guests, and keeps preload isolation', async () => {
  const startup = await fresh(), fixtureApp = app();
  assert.equal(await startup.showEarlyStartupWindow({ app: fixtureApp, BrowserWindow: FixtureWindow, nativeTheme: { shouldUseDarkColors: true } }), true);
  const window = FixtureWindow.latest;
  assert.equal(window.shown, true);
  assert.equal(window.paintYielded, true);
  assert.deepEqual(window.openHandler({ url: 'https://example.invalid' }), { action: 'deny' });
  let denied = 0;
  window.webContents.emit('will-navigate', { preventDefault: () => denied++ }, 'https://example.invalid');
  window.webContents.emit('will-attach-webview', { preventDefault: () => denied++ });
  assert.equal(denied, 2);
  assert.equal(window.options.webPreferences.contextIsolation, true);
  assert.equal(window.options.webPreferences.nodeIntegration, false);
  assert.equal(window.options.webPreferences.preload, '/fixture/app/preload.mjs');
  assert.equal(startup.takeEarlyStartupWindow(), window);
  assert.equal(startup.takeEarlyStartupWindow(), null);
  assert.equal(window.listenerCount('close'), 0);
  assert.equal(window.webContents.listenerCount('will-navigate'), 0);
});

test('closing the early splash prevents main startup and late first paint', async () => {
  const startup = await fresh(), fixtureApp = app();
  class ClosingWindow extends FixtureWindow {
    async loadURL() { this.emit('close'); this.destroyed = true; this.emit('closed'); }
  }
  assert.equal(await startup.showEarlyStartupWindow({ app: fixtureApp, BrowserWindow: ClosingWindow, nativeTheme: { shouldUseDarkColors: false } }), false);
  assert.equal(fixtureApp.quitRequested, true);
  assert.equal(startup.takeEarlyStartupWindow(), null);
});

test('deep links arriving during heavy import are replayed once', async () => {
  const startup = await fresh(), fixtureApp = app();
  startup.deferEarlyAppEvents(fixtureApp);
  let prevented = false;
  fixtureApp.emit('open-url', { preventDefault: () => { prevented = true; } }, 'openchamber://session/fixture');
  fixtureApp.emit('second-instance', {}, ['app', 'openchamber://session/second', 'devryan://session/third']);
  assert.equal(prevented, true);
  assert.deepEqual(startup.takeEarlyAppLinks(), ['openchamber://session/fixture', 'openchamber://session/second', 'devryan://session/third']);
  assert.deepEqual(startup.takeEarlyAppLinks(), []);
  assert.equal(fixtureApp.listenerCount('open-url'), 0);
});

test('main and early startup share construction options and runtime capability arguments', () => {
  const options = createStartupWindowOptions({ app: app(), palette: { background: '#123456' }, localOrigin: 'http://127.0.0.1:1' });
  assert.ok(options.webPreferences.additionalArguments.includes('--devryan-local-origin=http://127.0.0.1:1'));
  assert.equal(options.backgroundColor, '#123456');
});


test('failed imports keep bounded native diagnostics and a guarded relaunch on the existing window', async () => {
  const startup = await fresh(), fixtureApp = app();
  fixtureApp.relaunch = () => { fixtureApp.relaunched = true; };
  await startup.showEarlyStartupWindow({ app: fixtureApp, BrowserWindow: FixtureWindow, nativeTheme: { shouldUseDarkColors: false } });
  let copied;
  await startup.showEarlyStartupFailure({ app: fixtureApp, clipboard: { writeText: text => { copied = text; } }, dialog: {} });
  const window = FixtureWindow.latest;
  assert.ok(decodeURIComponent(window.url).includes('Retry to restart the app.'));
  let denied = false;
  window.webContents.emit('will-navigate', { preventDefault: () => { denied = true; } }, 'openchamber://copy-startup-diagnostics');
  assert.equal(denied, true);
  assert.equal(copied, '{"code":"electron_main_import_failed"}');
  window.webContents.emit('will-navigate', { preventDefault() {} }, 'openchamber://retry-startup');
  assert.equal(fixtureApp.relaunched, true);
  assert.equal(fixtureApp.quitRequested, true);
});
