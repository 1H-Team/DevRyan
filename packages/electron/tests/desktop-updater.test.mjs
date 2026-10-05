import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createDesktopUpdater, discoverDesktopUpdate } from '../desktop-updater.mjs';
import { releaseAssetDownloadUrl } from '../release-assets.mjs';

const bytes = Buffer.from('disposable installer fixture\n'.repeat(400));
const sha256 = createHash('sha256').update(bytes).digest('hex');
const url = releaseAssetDownloadUrl('macos-arm64', '2.0.2');
const release = () => ({ draft: false, prerelease: false, tag_name: 'v2.0.2', html_url: 'https://github.com/1H-Team/DevRyan/releases/tag/v2.0.2',
  assets: [{ name: 'DevRyan-2.0.2-arm64.dmg', browser_download_url: url, digest: `sha256:${sha256}`, size: bytes.length, state: 'uploaded' }] });
const options = { currentVersion: '2.0.1', platform: 'darwin', arch: 'arm64' };
const fixture = async (action) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-update-')));
  await fs.chmod(root, 0o700);
  try { await action(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
};

test('discovers only the exact published stable architecture asset with a genuine SHA-256', () => {
  assert.equal(discoverDesktopUpdate(release(), options).sha256, sha256);
  for (const mutate of [
    value => { value.draft = true; }, value => { value.prerelease = true; },
    value => { value.tag_name = 'v2.0.2-beta.1'; }, value => { value.html_url = 'https://evil.example/release'; },
    value => { value.assets[0].digest = null; }, value => { value.assets.push(value.assets[0]); },
    value => { value.assets[0].browser_download_url = 'https://evil.example/installer'; },
    value => { value.assets[0].size = -1; }, value => { value.assets[0].name = 'DevRyan-2.0.2-x64.dmg'; },
  ]) { const value = release();mutate(value);assert.throws(() => discoverDesktopUpdate(value, options)); }
  assert.equal(discoverDesktopUpdate(release(), { ...options, currentVersion: '2.0.2' }), null);
  assert.throws(() => discoverDesktopUpdate(release(), { ...options, arch: 'x64' }), { code: 'update_platform_unsupported' });
});

test('resumes an interrupted download and verifies all bytes before marking it downloaded', async () => fixture(async root => {
  let attempts = 0;
  const progress = [];
  const updater = createDesktopUpdater({ ...options, cacheDirectory: root, onProgress: event => progress.push(event), fetchImpl: async (request, init) => {
    if (request.endsWith('/latest')) return Response.json(release());
    assert.equal(request, url);attempts++;
    if (attempts === 1) return new Response(bytes.subarray(0, 1000), { headers: { 'content-length': String(bytes.length) } });
    assert.equal(init.headers.Range, 'bytes=1000-');
    return new Response(bytes.subarray(1000), { status: 206, headers: { 'content-range': `bytes 1000-${bytes.length - 1}/${bytes.length}` } });
  } });
  assert.equal((await updater.check()).available, true);
  await assert.rejects(updater.download(), { code: 'update_download_incomplete' });
  assert.equal(updater.isDownloaded(), false);
  await updater.download();
  const installed = await updater.getDownloaded();
  assert.deepEqual(await fs.readFile(installed.file), bytes);
  assert.equal(progress.at(-1).event, 'Finished');
  assert.equal(attempts, 2);
  // A completed cached download still requires hashing, including at restart.
  await fs.writeFile(installed.file, Buffer.alloc(bytes.length));
  await assert.rejects(updater.getDownloaded(), { code: 'update_integrity_failed' });
}));

test('a server ignoring Range resets the prefix and corrupt or oversized bodies never finish', async () => fixture(async root => {
  let response = bytes.subarray(0, 1000), downloaded;
  const updater = createDesktopUpdater({ ...options, cacheDirectory: root, fetchImpl: async request => request.endsWith('/latest')
    ? Response.json(release()) : new Response(response) });
  await updater.check();await assert.rejects(updater.download(), { code: 'update_download_incomplete' });
  response = bytes;await updater.download();downloaded = await updater.getDownloaded();
  assert.deepEqual(await fs.readFile(downloaded.file), bytes);
  await fs.unlink(downloaded.file);
  response = Buffer.alloc(bytes.length);await assert.rejects(updater.download(), { code: 'update_integrity_failed' });
  assert.equal(updater.isDownloaded(), false);
  response = Buffer.alloc(bytes.length + 1);await assert.rejects(updater.download(), { code: 'update_integrity_failed' });
  assert.equal(updater.isDownloaded(), false);
}));

test('refuses incorrect range identity and keeps the genuine prefix for retry', async () => fixture(async root => {
  let attempt = 0;
  const updater = createDesktopUpdater({ ...options, cacheDirectory: root, fetchImpl: async request => {
    if (request.endsWith('/latest')) return Response.json(release());
    return ++attempt === 1 ? new Response(bytes.subarray(0, 1000))
      : new Response(bytes.subarray(1000), { status: 206, headers: { 'content-range': `bytes 0-${bytes.length - 1}/${bytes.length}` } });
  } });
  await updater.check();await assert.rejects(updater.download(), { code: 'update_download_incomplete' });
  await assert.rejects(updater.download(), { code: 'update_resume_invalid' });
  assert.deepEqual(await fs.readFile(path.join(root, '2.0.2', 'DevRyan-2.0.2-arm64.dmg.partial')), bytes.subarray(0, 1000));
}));

test('unavailable discovery is an error, and linked cache files cannot authorize installation', async () => fixture(async root => {
  const unavailable = createDesktopUpdater({ ...options, cacheDirectory: root, fetchImpl: async () => Response.json({}, { status: 503 }) });
  await assert.rejects(unavailable.check(), { code: 'update_discovery_unavailable' });
  const outside = path.join(root, 'user-file');await fs.writeFile(outside, bytes);
  const directory = path.join(root, '2.0.2');await fs.mkdir(directory, { mode: 0o700 });
  const target = path.join(directory, 'DevRyan-2.0.2-arm64.dmg');await fs.link(outside, target);
  const updater = createDesktopUpdater({ ...options, cacheDirectory: root, fetchImpl: async () => Response.json(release()) });
  await updater.check();await assert.rejects(updater.download(), { code: 'update_cache_invalid' });
  assert.deepEqual(await fs.readFile(outside), bytes);
}));
