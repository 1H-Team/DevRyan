import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { app, BrowserWindow, session } from 'electron';
import { __test } from '../../../web/server/default-config/plugins/devryan-browser.mjs';

const temporaryRoot = process.env.DEVRYAN_BROWSER_INSPECTION_ROOT;
const resultPath = process.env.DEVRYAN_BROWSER_INSPECTION_RESULT;
if (!temporaryRoot || !resultPath) throw new Error('Launch this fixture through run.mjs');

app.setName('DevRyan Browser Inspection Fixture');
for (const [key, directory] of Object.entries({
  userData: 'user-data',
  sessionData: 'session-data',
  logs: 'logs',
  crashDumps: 'crashes',
})) {
  const isolatedPath = path.join(temporaryRoot, directory);
  mkdirSync(isolatedPath, { recursive: true, mode: 0o700 });
  app.setPath(key, isolatedPath);
}
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-domain-reliability');

const html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>[role="tooltip"] { animation-duration: 0.25s; transition-duration: 0.125s; --inspection-color: seagreen; }</style>
</head><body><button id="trigger" aria-describedby="tooltip">Tooltip trigger</button>
<div id="tooltip" role="tooltip" data-state="open">Transient tooltip</div>
<div class="duplicate" data-secret="first"></div><div class="duplicate" data-secret="second"></div>
</body></html>`;

let window;
let surfaces;
let blockedNetworkRequests = 0;
const checks = [];

const inspect = async (inspection) => {
  const raw = await window.webContents.executeJavaScript(__test.buildBrowserInspectionScript(inspection));
  return __test.parseBrowserInspectionResult(JSON.stringify(raw), inspection);
};

const run = async () => {
  await app.whenReady();
  const baselineRoot = process.env.DEVRYAN_BROWSER_INSPECTION_BASELINE;
  const managerModule = baselineRoot
    ? pathToFileURL(path.join(baselineRoot, 'packages/electron/browser-surface-manager.mjs')).href
    : new URL('../../browser-surface-manager.mjs', import.meta.url).href;
  const { createBrowserSurfaceManager } = await import(managerModule);
  app.dock?.hide();
  const fixtureSession = session.fromPartition('devryan-browser-inspection', { cache: false });
  assert.equal(fixtureSession.isPersistent(), false);
  fixtureSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  fixtureSession.setPermissionCheckHandler(() => false);
  fixtureSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => {
    blockedNetworkRequests += 1;
    callback({ cancel: true });
  });
  window = new BrowserWindow({
    width: 640,
    height: 480,
    show: false,
    webPreferences: {
      session: fixtureSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  const tooltip = {
    selector: '[role="tooltip"]',
    styles: ['animation-duration', 'transition-duration', '--inspection-color'],
    attributes: ['data-state', 'aria-label'],
  };
  const present = await inspect(tooltip);
  assert.deepEqual(present, {
    status: 'found',
    selector: tooltip.selector,
    matchCount: 1,
    styles: { 'animation-duration': '0.25s', 'transition-duration': '0.125s', '--inspection-color': 'seagreen' },
    attributes: { 'data-state': 'open', 'aria-label': null },
  });
  checks.push('Present tooltip: computed durations, custom CSS property, and absent attribute');

  await window.webContents.executeJavaScript(`new Promise((resolve) => {
    const trigger = document.querySelector('#trigger');
    trigger.addEventListener('mouseleave', () => {
      setTimeout(() => { document.querySelector('[role="tooltip"]').remove(); resolve(); }, 10);
    }, { once: true });
    trigger.dispatchEvent(new MouseEvent('mouseleave'));
  })`);
  const removed = await inspect(tooltip);
  assert.deepEqual(removed, { status: 'missing', selector: tooltip.selector, matchCount: 0, styles: {}, attributes: {} });
  assert.deepEqual(await inspect(tooltip), removed);
  checks.push('Dismissed tooltip: repeated inspection returns missing without throwing');

  const originalException = await window.webContents.executeJavaScript(`(() => {
    try {
      getComputedStyle(document.querySelector('[role="tooltip"]')).animationDuration;
      return null;
    } catch (error) {
      return { name: error.name, message: error.message };
    }
  })()`);
  assert.equal(originalException?.name, 'TypeError');
  assert.match(originalException.message, /Failed to execute 'getComputedStyle'.*parameter 1 is not of type 'Element'/s);
  checks.push('Original getComputedStyle(null) Chromium failure reproduced');

  const duplicate = { selector: '.duplicate', styles: ['display'], attributes: ['data-secret'] };
  assert.deepEqual(await inspect(duplicate), {
    status: 'ambiguous', selector: duplicate.selector, matchCount: 2, styles: {}, attributes: {},
  });
  checks.push('Multiple matches: ambiguous result exposes no element values');

  await assert.rejects(inspect({ selector: '[', styles: [], attributes: [] }), (error) => {
    assert.equal(error.code, 'DEVRYAN_BROWSER_INPUT_INVALID');
    return true;
  });
  checks.push('Invalid CSS selector: deterministic browser input error');

  const quotedValue = `quote" slash\\ and apostrophe'`;
  await window.webContents.executeJavaScript(`document.querySelector('#trigger').setAttribute('data-quoted', ${JSON.stringify(quotedValue)})`);
  const quoted = { selector: `[data-quoted=${JSON.stringify(quotedValue)}]`, styles: [], attributes: ['data-quoted'] };
  assert.deepEqual(await inspect(quoted), {
    status: 'found', selector: quoted.selector, matchCount: 1, styles: {}, attributes: { 'data-quoted': quotedValue },
  });
  checks.push('Quoted and backslash-containing selector is passed as data');

  surfaces = createBrowserSurfaceManager({
    createPopoutWindow: () => { throw new Error('Unexpected popout'); },
    emitToWindow() {}, getWindowById: id => id === window.id ? window : null,
    getManualBrowserContext: () => ({ contextKey: 'fixture', partition: 'devryan-browser-inspection' }),
  });
  const manual = [];
  window.showInactive();
  for (let index = 0; index < 3; index++) {
    const snapshot = surfaces.createManualSurface(window, { tabId: `tab-${index}`, initialUrl: 'about:blank' });
    const surface = surfaces.getOwnedSurface(window, snapshot.surfaceId);
    await surface.view.webContents.loadURL('about:blank');
    assert.equal(surface.view.webContents.getBackgroundThrottling(), !baselineRoot);
    manual.push(surface);
  }
  const lease = surfaces.createLeaseSurface(window, { leaseId: 'fixture-lease', initialUrl: 'about:blank', browserPartition: 'devryan-browser-inspection' });
  await lease.webContents.loadURL('about:blank');
  surfaces.layout(window, { surfaceId: lease.snapshot.surfaceId, visible: true, bounds: { x: 0, y: 0, width: 320, height: 240 } });
  await new Promise(resolve => setTimeout(resolve, 100));
  surfaces.layout(window, { surfaceId: lease.snapshot.surfaceId, visible: false });
  assert.equal(lease.webContents.getBackgroundThrottling(), false);
  if (!baselineRoot) assert.notEqual(manual[0].attachedWindow, surfaces.surfaceForLease('fixture-lease').attachedWindow);
  const startCounter = `window.frameCount=0; window.fixtureMarker='retained'; document.body.textContent='Browser scheduling fixture'; (()=>{const frame=()=>{window.frameCount++; document.body.style.backgroundColor=window.frameCount%2?'white':'lightgray';requestAnimationFrame(frame)};requestAnimationFrame(frame)})()`;
  for (const surface of manual) await surface.view.webContents.executeJavaScript(startCounter);
  await lease.webContents.executeJavaScript(startCounter);
  const samples = [];
  for (let sample = 0; sample < 3; sample++) {
    await new Promise(resolve => setTimeout(resolve, 250));
    const counts = async () => Promise.all([...manual.map(surface => surface.view.webContents), lease.webContents]
      .map(contents => contents.executeJavaScript('window.frameCount')));
    const before = await counts();
    await new Promise(resolve => setTimeout(resolve, 1000));
    const after = await counts();
    samples.push({ frames: after.map((count, index) => count - before[index]),
      visibility: await Promise.all([...manual.map(surface => surface.view.webContents), lease.webContents].map(contents => contents.executeJavaScript('document.visibilityState'))) });
  }
  const manualFrames = samples.reduce((sum, sample) => sum + sample.frames.slice(0, 3).reduce((a, b) => a + b, 0), 0);
  if (baselineRoot) assert.ok(manualFrames > 0, 'unthrottled baseline must animate');
  else assert.ok(samples.every(sample => sample.visibility.slice(0, 3).every(value => value === 'hidden')), 'parked manual pages must observe hidden hosts');
  assert.ok(samples.every(sample => sample.frames[3] > 0), 'agent lease must keep producing frames');
  surfaces.layout(window, { surfaceId: manual[0].surfaceId, visible: true, bounds: { x: 0, y: 0, width: 320, height: 240 } });
  assert.equal(manual[0].view.webContents.getBackgroundThrottling(), false);
  assert.equal(await manual[0].view.webContents.executeJavaScript('window.fixtureMarker'), 'retained');
  assert.equal((await lease.webContents.capturePage()).isEmpty(), false);
  checks.push('Parked manual scheduling policy, agent frames, capture and restored tab verified');
  surfaces.closeAll();

  assert.equal(blockedNetworkRequests, 0);
  writeFileSync(resultPath, `${JSON.stringify({
    status: 'passed',
    runtime: { electron: process.versions.electron, chromium: process.versions.chrome },
    isolation: { inMemoryPartition: true, networkRequests: 0, productionRuntimeLoaded: false },
    checks,
    present,
    removed,
    originalException,
    parking: { arm: baselineRoot ? 'baseline' : 'candidate', manualFrames, samples, scope: 'animation scheduling; not a CPU/GPU benchmark' },
  }, null, 2)}\n`, { mode: 0o600 });
  window.destroy();
  app.exit(0);
};

// Do not await readiness at ESM top level: Electron emits ready only after the
// entry module has completed evaluation.
void run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  surfaces?.closeAll();
  if (window && !window.isDestroyed()) window.destroy();
  app.exit(1);
});
