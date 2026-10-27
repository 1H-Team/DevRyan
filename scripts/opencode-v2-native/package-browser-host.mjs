// Opt-in Electron owner for compiled-runtime browser acceptance; no app profile.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { createRequire } from 'node:module';
import { app, BrowserWindow, session } from 'electron';
import { createBrowserCdpBridge } from '../../packages/electron/browser-cdp-bridge.mjs';
import { createBrowserSurfaceManager } from '../../packages/electron/browser-surface-manager.mjs';

const require = createRequire(new URL('../../packages/electron/package.json', import.meta.url));
const { WebSocketServer } = require('ws');
const root = process.env.DEVRYAN_PACKAGE_BROWSER_ROOT, token = process.env.DEVRYAN_PACKAGE_BROWSER_TOKEN;
assert.ok(root && path.isAbsolute(root) && token && /^[a-f0-9]{64}$/.test(token));
for (const key of ['userData', 'sessionData', 'logs', 'crashDumps']) app.setPath(key, path.join(root, key));
for (const flag of ['disable-background-networking', 'disable-component-update', 'disable-domain-reliability']) app.commandLine.appendSwitch(flag);
app.setName('DevRyan Native Browser Qualification');
app.on('window-all-closed', () => {});
async function run() {
await app.whenReady(); app.dock?.hide();
const partition = session.fromPartition('devryan-native-browser-qualification', { cache: false });
partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
partition.setPermissionCheckHandler(() => false);
const certificate = await fs.readFile(path.join(root, 'preview.pem'), 'utf8');
const certificateFingerprint = new crypto.X509Certificate(certificate).fingerprint256;
partition.setCertificateVerifyProc((request, callback) => {
  let matches = false;
  try { matches = request.hostname === '127.0.0.1' && new crypto.X509Certificate(request.certificate.data).fingerprint256 === certificateFingerprint; } catch {}
  callback(matches ? 0 : -2);
});
let previewOrigin, blocked = 0;
partition.webRequest.onBeforeRequest((details, callback) => {
  const url = new URL(details.url), allowed = ['about:', 'data:'].includes(url.protocol) || url.origin === previewOrigin;
  if (!allowed) blocked++;
  callback({ cancel: !allowed });
});
const window = new BrowserWindow({ width: 800, height: 600, show: false,
  webPreferences: { session: partition, nodeIntegration: false, contextIsolation: true, sandbox: true } });
await window.loadURL('about:blank');
const surfaces = createBrowserSurfaceManager({ createPopoutWindow: () => { throw Error('Unexpected qualification popout'); },
  emitToWindow() {}, getWindowById: id => id === window.id ? window : null,
  getManualBrowserContext: () => ({ contextKey: 'qualification', partition: 'devryan-native-browser-qualification' }) });
const bridge = createBrowserCdpBridge({ crypto, createWebSocketServer: options => new WebSocketServer(options) });
const created = [], released = [];
let touches = 0;
const html = '<!doctype html><html><head><meta charset="utf-8"><title>DevRyan compiled browser</title></head><body><h1>Compiled browser qualification</h1><label>Name<input id="name"></label><button id="save" onclick="document.querySelector(\'#result\').textContent=document.querySelector(\'#name\').value">Save</button><p id="result">Initial</p></body></html>';
const previewServer = createTlsServer({ key: await fs.readFile(path.join(root, 'preview-key.pem')), cert: certificate }, (req, res) => {
  if (req.method !== 'GET' || !['/fixture', '/favicon.ico'].includes(req.url)) { res.writeHead(404); res.end(); return; }
  if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(html);
});
await new Promise(resolve => previewServer.listen(0, '127.0.0.1', resolve));
previewOrigin = `https://127.0.0.1:${previewServer.address().port}`;
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.method, 'POST'); assert.equal(req.headers.authorization, 'Bearer ' + token);
    let body = ''; for await (const chunk of req) { body += chunk; assert.ok(Buffer.byteLength(body) <= 16384); }
    const input = JSON.parse(body);
    let result;
    if (req.url === '/status') result = { leaseCount: bridge.status().leaseCount, created, released, touches, blocked,
      versions: { electron: process.versions.electron, chromium: process.versions.chrome } };
    else {
      assert.match(input.leaseId, /^dvr_lease_[A-Za-z0-9_-]+$/);
      if (req.url === '/create') {
        assert.ok(!created.includes(input.leaseId));
        const active = await bridge.createLease({ leaseId: input.leaseId, metadata: input.metadata,
          onClosed: () => surfaces.releaseLease(input.leaseId, 'qualification') });
        assert.equal(active.ok, true);
        const surface = surfaces.createLeaseSurface(window, { leaseId: input.leaseId, browserPartition: 'devryan-native-browser-qualification' });
        await surface.webContents.loadURL('about:blank');
        surfaces.layout(window, { surfaceId: surface.snapshot.surfaceId, visible: true, bounds: { x: 0, y: 0, width: 640, height: 480 } });
        surfaces.layout(window, { surfaceId: surface.snapshot.surfaceId, visible: false });
        assert.equal(bridge.bindLeaseGuest(input.leaseId, surface.webContents, { ownerWindowId: window.id }).ok, true);
        created.push(input.leaseId); result = active;
      } else if (req.url === '/touch') { touches++; result = bridge.touchLease(input.leaseId, input.metadata); }
      else if (req.url === '/release') { bridge.closeLease(input.leaseId, 'qualification'); released.push(input.leaseId); result = { ok: true }; }
      else throw Error('Unknown qualification operation');
    }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(result));
  } catch { res.statusCode = 500; res.end('{"error":"browser_qualification_request_failed"}'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
await fs.writeFile(path.join(root, 'ready.json'), JSON.stringify({ origin, previewOrigin }), { mode: 0o600 });
let closing;
const close = () => closing ??= (async () => { await bridge.stop(); surfaces.closeAll();
  await Promise.all([server, previewServer].map(server => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); }));
  window.destroy(); app.quit(); })();
process.on('SIGINT', () => { void close(); }); process.on('SIGTERM', () => { void close(); });
}
run().catch(error => { console.error(error.stack); app.exit(1); });
