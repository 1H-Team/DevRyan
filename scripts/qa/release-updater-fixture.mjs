// Test-process-only feed transport. The installed updater still validates the
// canonical GitHub URLs and the exact candidate digest; no app override ships.
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { RELEASE_REPOSITORY, releaseAssetDownloadUrl, releaseAssetName } from '../../packages/electron/release-assets.mjs';
import { readReleaseManifest } from '../release-candidate.mjs';

export const feedUrl = `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`;

// Observe the real IPC operation in main: renderer reloads must not erase its
// completion receipt. Every call and progress notification is forwarded intact.
export function updaterObservationScript() {
  return `(() => {
    if (!process.versions.electron) return true;
    const { ipcMain, BrowserWindow } = process.getBuiltinModule('module').createRequire(process.execPath)('electron');
    const handle = ipcMain.handle;
    globalThis.__devryanUpgradeQa = { state: 'idle', downloaded: 0 };
    ipcMain.handle = function(channel, listener) {
      if (channel !== 'devryan:invoke') return handle.call(this, channel, listener);
      return handle.call(this, channel, async (...args) => {
        if (args[1] === 'desktop_restart') {
          // Installer preparation rejects here; the renderer's caller may discard it.
          const restart = globalThis.__devryanUpgradeQa.restart = { state: 'pending' };
          try { const result = await listener(...args); restart.state = 'returned'; return result; }
          catch (error) {
            Object.assign(restart, { state: 'failed', code: String(error?.code ?? '').slice(0, 80), message: String(error?.message ?? error).slice(0, 300) });
            if (error?.diagnostic && typeof error.diagnostic === 'object') restart.diagnostic = JSON.stringify(error.diagnostic).slice(0, 300);
            throw error;
          }
        }
        if (args[1] !== 'desktop_download_and_install_update') return listener(...args);
        const observation = globalThis.__devryanUpgradeQa = { state: 'pending', downloaded: 0 };
        const restore = BrowserWindow.getAllWindows().map(window => {
          const contents = window.webContents, send = contents.send;
          contents.send = function(channel, payload, ...rest) {
            if (channel === 'devryan:emit' && payload?.event === 'devryan:update-progress'
              && payload.detail?.event === 'Progress' && Number.isSafeInteger(payload.detail.data?.downloaded)) {
              observation.downloaded = payload.detail.data.downloaded;
            }
            return send.call(this, channel, payload, ...rest);
          };
          return () => { contents.send = send; };
        });
        try { const result = await listener(...args); observation.state = 'complete'; return result; }
        catch (error) { observation.state = 'failed'; observation.message = String(error?.message ?? error).slice(0, 300); throw error; }
        finally { for (const reset of restore) reset(); }
      });
    };
    return true;
  })()`;
}

export function updaterFixtureScript({ origin, version }) {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error('Fixture must bind loopback');
  const routes = { [feedUrl]: `${origin}/latest`, [releaseAssetDownloadUrl('macos-arm64', version)]: `${origin}/candidate` };
  return `(() => { const original = globalThis.fetch; const routes = ${JSON.stringify(routes)};
    globalThis.fetch = (input, options) => { const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return original(routes[url] ?? input, options); }; return true; })()`;
}

/** Redirects only the canonical feed URL; downloads stay on their real URLs. */
export function feedMirrorScript({ origin }) {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error('Feed mirror must bind loopback');
  return `(() => { const original = globalThis.fetch; const feed = ${JSON.stringify(feedUrl)}, mirror = ${JSON.stringify(`${origin}/latest`)};
    globalThis.fetch = (input, options) => { const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return original(url === feed ? mirror : input, options); }; return true; })()`;
}

/**
 * Serves the exact /releases/latest response the QA process read (with the
 * read-only workflow token) to the installed app's unchanged, anonymous
 * updater, so a shared runner's anonymous GitHub limit cannot fail the check.
 */
export async function createFeedMirror({ status, body }) {
  if (![200, 404].includes(status) || typeof body !== 'string') throw new Error('Feed mirror needs the real feed status and body');
  const requests = { discovery: 0 };
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/latest') { res.writeHead(404).end(); return; }
    requests.discovery++;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(body);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { requests, origin, script: feedMirrorScript({ origin }),
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

export async function createUpdaterFixture({ dmg, manifestPath }) {
  const manifest = await readReleaseManifest(manifestPath);
  const stat = await fs.stat(dmg);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(dmg)) hash.update(chunk);
  if (stat.size !== manifest.size || hash.digest('hex') !== manifest.sha256) throw new Error('Fixture DMG does not match release manifest');
  const name = releaseAssetName('macos-arm64', manifest.version);
  const payload = { tag_name: `v${manifest.version}`, draft: false, prerelease: false,
    html_url: `https://github.com/${RELEASE_REPOSITORY}/releases/tag/v${manifest.version}`, body: 'Isolated candidate qualification',
    assets: [{ name, state: 'uploaded', size: manifest.size, digest: `sha256:${manifest.sha256}`,
      browser_download_url: releaseAssetDownloadUrl('macos-arm64', manifest.version) }] };
  const requests = { discovery: 0, download: 0 };
  const server = createServer((req, res) => {
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    if (req.url === '/latest') {
      requests.discovery++;
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload)); return;
    }
    if (req.url !== '/candidate') { res.writeHead(404).end(); return; }
    const match = req.headers.range?.match(/^bytes=(\d+)-$/);
    const offset = match ? Number(match[1]) : 0;
    if (req.headers.range && !match || !Number.isSafeInteger(offset) || offset >= manifest.size) { res.writeHead(416).end(); return; }
    requests.download++;
    res.writeHead(offset ? 206 : 200, { 'Content-Type': 'application/octet-stream', 'Content-Length': manifest.size - offset,
      ...(offset ? { 'Content-Range': `bytes ${offset}-${manifest.size - 1}/${manifest.size}` } : {}) });
    const stream = createReadStream(dmg, { start: offset });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { version: manifest.version, sha256: manifest.sha256, requests, origin: `http://127.0.0.1:${server.address().port}`,
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
