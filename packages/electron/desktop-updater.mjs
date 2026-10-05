import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeFileAtomic } from '../harness-runtime/lib/atomic-file.js';
import { RELEASE_REPOSITORY, RELEASE_VERSION_PATTERN, releaseAssetName, releaseAssetDownloadUrl } from './release-assets.mjs';

const metadataUrl = `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`;
const fail = (code, message) => Object.assign(new Error(message), { code });
const versionParts = (value) => {
  if (!RELEASE_VERSION_PATTERN.test(value ?? '')) throw fail('update_release_invalid', 'Invalid release version');
  const parts = value.split('.').map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) throw fail('update_release_invalid', 'Invalid release version');
  return parts;
};
const newer = (next, current) => {
  const left = versionParts(next), right = versionParts(current);
  for (let index = 0; index < 3; index++) { if (left[index] !== right[index]) return left[index] > right[index]; }
  return false;
};

export function discoverDesktopUpdate(payload, { currentVersion, platform = process.platform, arch = process.arch }) {
  const installPlatform = platform === 'darwin' && arch === 'arm64' ? 'macos-arm64'
    : platform === 'win32' && ['x64', 'arm64'].includes(arch) ? `win-${arch}` : null;
  if (!installPlatform) throw fail('update_platform_unsupported', 'Desktop updates are unavailable on this platform');
  if (!payload || payload.draft !== false || payload.prerelease !== false || typeof payload.tag_name !== 'string'
    || !payload.tag_name.startsWith('v') || !Array.isArray(payload.assets)) throw fail('update_release_invalid', 'Release discovery did not return a published stable release');
  const version = payload.tag_name.slice(1);
  versionParts(version);
  if (payload.html_url !== `https://github.com/${RELEASE_REPOSITORY}/releases/tag/v${version}`) throw fail('update_release_invalid', 'Release identity does not match DevRyan');
  if (!newer(version, currentVersion)) return null;
  const name = releaseAssetName(installPlatform, version);
  const assets = payload.assets.filter((asset) => asset?.name === name);
  const asset = assets[0];
  if (assets.length !== 1 || asset.browser_download_url !== releaseAssetDownloadUrl(installPlatform, version)
    || asset.state !== 'uploaded' || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '')
    || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 8 * 1024 ** 3) {
    throw fail('update_asset_unverified', 'This release has no verified installer for your architecture. Retry later.');
  }
  return Object.freeze({ version, name, url: asset.browser_download_url, sha256: asset.digest.slice(7), size: asset.size,
    body: typeof payload.body === 'string' ? payload.body.slice(0, 64 * 1024) : null,
    date: typeof payload.published_at === 'string' ? payload.published_at : null });
}

const openOwnedFile = async (file, flags) => {
  const handle = await fs.open(file, flags | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const stat = await handle.stat(), named = await fs.lstat(file);
    if (!stat.isFile() || stat.nlink !== 1 || process.getuid && stat.uid !== process.getuid()
      || !named.isFile() || named.dev !== stat.dev || named.ino !== stat.ino) {
      throw fail('update_cache_invalid', 'The update cache changed');
    }
    return { handle, stat };
  } catch (error) { await handle.close(); throw error; }
};

export async function verifyDownloadedUpdate(file, update) {
  const { handle, stat } = await openOwnedFile(file, constants.O_RDONLY);
  try {
    if (stat.size !== update.size) throw fail('update_integrity_failed', 'Installer size verification failed');
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(128 * 1024);
    for (let offset = 0; offset < stat.size;) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
      if (!bytesRead) throw fail('update_integrity_failed', 'Installer download is incomplete');
      hash.update(buffer.subarray(0, bytesRead));offset += bytesRead;
    }
    const after = await handle.stat(), named = await fs.lstat(file);
    if (hash.digest('hex') !== update.sha256 || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs
      || stat.ctimeMs !== after.ctimeMs || after.nlink !== 1 || !named.isFile() || named.dev !== stat.dev || named.ino !== stat.ino) {
      throw fail('update_integrity_failed', 'Installer SHA-256 verification failed');
    }
    return file;
  } finally { await handle.close(); }
}

export function createDesktopUpdater({ currentVersion, cacheDirectory, platform = process.platform, arch = process.arch,
  fetchImpl = fetch, onProgress = () => {}, idleTimeoutMs = 30_000 }) {
  versionParts(currentVersion);
  if (!path.isAbsolute(cacheDirectory ?? '')) throw new TypeError('An absolute update cache directory is required');
  let pending = null, downloaded = null, operation = null, downloadAbort = null;
  const emit = (event, data) => onProgress({ event, data });
  const exclusive = (action) => {
    if (operation) return Promise.reject(fail('update_busy', 'Another update operation is running'));
    operation = Promise.resolve().then(action).finally(() => { operation = null; });return operation;
  };
  const directoryFor = async (update) => {
    await fs.mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
    const cache = await fs.lstat(cacheDirectory);
    if (await fs.realpath(cacheDirectory) !== cacheDirectory || !cache.isDirectory() || (cache.mode & 0o077)
      || process.getuid && cache.uid !== process.getuid()) {
      throw fail('update_cache_invalid', 'The update cache is not an owned directory');
    }
    const directory = path.join(cacheDirectory, update.version);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (await fs.realpath(directory) !== directory || !stat.isDirectory() || (stat.mode & 0o077)
      || process.getuid && stat.uid !== process.getuid()) throw fail('update_cache_invalid', 'The update cache changed');
    return directory;
  };
  const check = () => exclusive(async () => {
    const response = await fetchImpl(metadataUrl, { headers: { Accept: 'application/vnd.github+json',
      'User-Agent': `DevRyan/${currentVersion}`, 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw fail('update_discovery_unavailable', 'Release discovery is unavailable. Retry later.');
    const bytes = [], reader = response.body?.getReader();let length = 0;
    if (!reader) throw fail('update_release_invalid', 'Release metadata is empty');
    try {
      for (;;) {
        const { value, done } = await reader.read();if (done) break;
        length += value.length;
        if (length > 2 * 1024 * 1024) throw fail('update_release_invalid', 'Release metadata exceeds its limit');
        bytes.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const next = discoverDesktopUpdate(JSON.parse(Buffer.concat(bytes).toString('utf8')), { currentVersion, platform, arch });
    if (pending?.sha256 !== next?.sha256 || pending?.version !== next?.version) downloaded = null;
    pending = next;
    return { available: Boolean(next), currentVersion, version: next?.version ?? null, body: next?.body ?? null, date: next?.date ?? null };
  });
  const download = () => exclusive(async () => {
    if (!pending) throw fail('update_not_pending', 'No verified update is pending');
    const update = pending, directory = await directoryFor(update);
    const destination = path.join(directory, update.name), partial = `${destination}.partial`, identityPath = `${partial}.json`;
    const identity = JSON.stringify({ url: update.url, size: update.size, sha256: update.sha256 });
    downloaded = null;
    try {
      await verifyDownloadedUpdate(destination, update);downloaded = { file: destination, update };emit('Finished', {});return null;
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'update_integrity_failed') throw error;
      if (error.code === 'update_integrity_failed') await fs.unlink(destination);
    }
    const previousIdentity = await fs.readFile(identityPath, 'utf8').catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (previousIdentity !== identity) {
      await fs.unlink(partial).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      await writeFileAtomic(identityPath, identity);
    }
    const { handle, stat } = await openOwnedFile(partial, constants.O_CREAT | constants.O_RDWR);
    let offset = stat.size;
    let timer, reader;
    downloadAbort = new AbortController();
    const resetTimeout = () => { clearTimeout(timer);timer = setTimeout(() => downloadAbort?.abort(fail('update_download_timeout', 'Installer download timed out')), idleTimeoutMs);timer.unref?.(); };
    try {
      if (offset > update.size) { await handle.truncate(0);offset = 0; }
      const space = await fs.statfs(directory);
      if (space.bavail * space.bsize < update.size - offset + 8 * 1024 * 1024) throw fail('update_disk_space', 'There is not enough free space for the installer');
      emit('Started', { contentLength: update.size });emit('Progress', { downloaded: offset, total: update.size, chunkLength: 0 });
      if (offset < update.size) {
        resetTimeout();
        const response = await fetchImpl(update.url, { headers: { ...(offset ? { Range: `bytes=${offset}-` } : {}), 'Accept-Encoding': 'identity' }, signal: downloadAbort.signal });
        if (response.status === 200) { if (offset) await handle.truncate(0);offset = 0; }
        else if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${offset}-${update.size - 1}/${update.size}`) {
          await response.body?.cancel();throw fail('update_resume_invalid', 'The server refused a verified resumable download');
        }
        const length = response.headers.get('content-length');
        if (length !== null && Number(length) !== update.size - offset) {
          await response.body?.cancel();throw fail('update_integrity_failed', 'Installer response size does not match its release');
        }
        reader = response.body?.getReader();
        if (!reader) throw fail('update_download_incomplete', 'Installer response is empty');
        for (;;) {
          const { value, done } = await reader.read();if (done) break;
          resetTimeout();
          if (offset + value.length > update.size) throw fail('update_integrity_failed', 'Installer response exceeds its release size');
          for (let position = 0; position < value.length;) {
            const { bytesWritten } = await handle.write(value, position, value.length - position, offset + position);
            if (!bytesWritten) throw fail('update_write_failed', 'Installer cache write failed');position += bytesWritten;
          }
          offset += value.length;emit('Progress', { downloaded: offset, total: update.size, chunkLength: value.length });
        }
      }
      await handle.sync();
      if (offset !== update.size) throw fail('update_download_incomplete', 'Installer download was interrupted; retry to resume');
    } catch (error) {
      await handle.sync();
      if (error.code === 'update_integrity_failed') await handle.truncate(0);
      emit('Error', { message: error.message });throw error;
    } finally {
      clearTimeout(timer);downloadAbort?.abort();downloadAbort = null;
      await reader?.cancel().catch(() => {});await handle.close();
    }
    try { await verifyDownloadedUpdate(partial, update); }
    catch (error) { await fs.unlink(partial);emit('Error', { message: error.message });throw error; }
    await fs.rename(partial, destination);
    downloaded = { file: destination, update };emit('Finished', {});return null;
  });
  return { check, download, isDownloaded: () => Boolean(downloaded),
    getDownloaded: async () => {
      if (!downloaded) throw fail('update_not_downloaded', 'Download the verified installer first');
      await verifyDownloadedUpdate(downloaded.file, downloaded.update);return { ...downloaded };
    }, cancelDownload: () => downloadAbort?.abort(fail('update_download_interrupted', 'Installer download was interrupted; retry to resume')) };
}
