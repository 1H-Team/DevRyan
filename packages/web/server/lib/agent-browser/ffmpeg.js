import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import assets from './ffmpeg-assets.json' with { type: 'json' };

const identity = (stat) => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
const digest = async (file) => {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};

// No install scripts, archive extraction, system PATH changes or global tools.
export function createFfmpegInstaller({ installRoot, runCommand, platform = process.platform,
  arch = process.arch, manifest = assets, fetchImpl = fetch }) {
  const platformKey = `${platform}-${arch === 'aarch64' ? 'arm64' : arch === 'x86_64' ? 'x64' : arch}`;
  const asset = manifest.platforms[platformKey];
  const root = path.join(installRoot, 'ffmpeg');
  const binaryName = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const binaryPath = path.join(root, binaryName);
  let pending;
  let verifiedIdentity;
  const base = { expectedVersion: manifest.release, binaryPath, source: manifest.source };
  const failure = (code, message) => ({ ...base, ok: false, state: asset ? 'unavailable' : 'unsupported',
    issues: [{ code, message }] });

  const probe = async (directory) => {
    const binary = path.join(directory, binaryName);
    const version = await runCommand(binary, ['-version'], { timeoutMs: 5_000 });
    if (!version.ok || !/^ffmpeg version /m.test(version.stdout)) throw new Error('FFmpeg version probe failed');
    // Exercise the exact encoders used by agent-browser, not just their names.
    for (const [codec, extension] of [['libvpx', 'webm'], ['libx264', 'mp4']]) {
      const output = path.join(directory, `probe.${extension}`);
      try {
        const result = await runCommand(binary, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
          '-f', 'lavfi', '-i', 'color=c=black:s=16x16:r=1', '-frames:v', '1', '-c:v', codec, output],
        { timeoutMs: 10_000 });
        if (!result.ok || !(await fs.stat(output)).size) throw new Error(`FFmpeg ${codec} encoding probe failed`);
      } finally { await fs.rm(output, { force: true }); }
    }
    return version.stdout.split('\n')[0];
  };

  const status = async () => {
    if (!asset) return failure('ffmpeg-unsupported-platform', `Recording is unavailable on ${platformKey}`);
    try {
      const stat = await fs.lstat(binaryPath);
      if (!stat.isFile() || (platform !== 'win32' && !(stat.mode & 0o111))) throw new Error('invalid executable');
      const receipt = JSON.parse(await fs.readFile(path.join(root, 'ready.json'), 'utf8'));
      const current = identity(stat);
      if (receipt.release !== manifest.release || receipt.identity !== current || receipt.sha256 !== asset.binary.sha256) {
        throw new Error('invalid receipt');
      }
      const notices = [['LICENSE', asset.license], ['README', asset.readme]];
      const noticeIdentities = await Promise.all(notices.map(async ([name]) => {
        const stat = await fs.lstat(path.join(root, name));
        if (!stat.isFile()) throw new Error('invalid distribution notice');
        return identity(stat);
      }));
      const verificationIdentity = [current, ...noticeIdentities].join('|');
      if (verifiedIdentity !== verificationIdentity) {
        if (await digest(binaryPath) !== asset.binary.sha256) throw new Error('checksum mismatch');
        for (const [name, source] of notices) {
          if (await digest(path.join(root, name)) !== source.sha256) throw new Error('missing distribution notice');
        }
        verifiedIdentity = verificationIdentity;
      }
      return { ...base, ok: true, state: 'ready', installedVersion: receipt.version, issues: [] };
    } catch {
      return failure('ffmpeg-not-ready', 'Recording needs a verified FFmpeg installation. Use Repair to install it.');
    }
  };

  const download = async (source, target, signal, limit) => {
    const response = await fetchImpl(source.url, { signal });
    if (!response.ok || !response.body) throw new Error(`FFmpeg download failed (${response.status})`);
    let bytes = 0;
    const hash = crypto.createHash('sha256');
    await pipeline(Readable.fromWeb(response.body), async function* (stream) {
      for await (const chunk of stream) {
        bytes += chunk.length;
        if (bytes > limit) throw new Error('FFmpeg download exceeded its size limit');
        hash.update(chunk);
        yield chunk;
      }
    }, createWriteStream(target, { flags: 'wx', mode: 0o600 }), { signal });
    if (hash.digest('hex') !== source.sha256) throw new Error('FFmpeg download checksum mismatch');
  };

  const ensureInstalled = ({ repair = false } = {}) => {
    if (pending) return pending;
    pending = (async () => {
      const before = await status();
      if (!asset || (before.ok && !repair)) return before;
      await fs.mkdir(installRoot, { recursive: true });
      const stage = await fs.mkdtemp(path.join(installRoot, '.ffmpeg-stage-'));
      const previous = `${stage}-previous`;
      let moved = false;
      let activated = false;
      let committed = false;
      try {
        const signal = AbortSignal.timeout(120_000);
        for (const [name, source] of [[binaryName, asset.binary], ['LICENSE', asset.license], ['README', asset.readme]]) {
          await download(source, path.join(stage, name), signal, name === binaryName ? 200 * 1024 * 1024 : 1024 * 1024);
        }
        await fs.chmod(path.join(stage, binaryName), 0o755);
        const version = await probe(stage);
        await fs.writeFile(path.join(stage, 'ready.json'), JSON.stringify({ release: manifest.release,
          sha256: asset.binary.sha256, identity: identity(await fs.stat(path.join(stage, binaryName))), version }), { mode: 0o600 });
        try { await fs.rename(root, previous); moved = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
        try { await fs.rename(stage, root); activated = true; }
        catch (error) { if (moved) { await fs.rename(previous, root); moved = false; } throw error; }
        verifiedIdentity = null;
        const after = await status();
        if (!after.ok) throw new Error('FFmpeg activation verification failed');
        committed = true;
        return { ...after, changed: true };
      } catch (error) {
        if (activated) {
          await fs.rm(root, { recursive: true, force: true });
          if (moved) { await fs.rename(previous, root); moved = false; }
        }
        const retained = await status();
        return { ...retained, issues: [...retained.issues, { code: 'ffmpeg-install-failed',
          message: `Recording dependency repair failed: ${error.message}. Use Repair to retry.` }] };
      } finally {
        await fs.rm(stage, { recursive: true, force: true });
        // Preserve the backup if restoring it failed.
        if (moved && committed) await fs.rm(previous, { recursive: true, force: true });
      }
    })().catch(() => failure('ffmpeg-install-failed', 'Recording dependency installation failed. Use Repair to retry.'))
      .finally(() => { pending = null; });
    return pending;
  };
  return { status, ensureInstalled };
}
