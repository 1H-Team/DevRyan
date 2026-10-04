import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AGENT_BROWSER_VERSION, AGENT_BROWSER_MANAGED_CONFIG_FILE } from '../../agent-browser/install.js';
import { createFfmpegInstaller } from '../../agent-browser/ffmpeg.js';

const fail = () => Object.assign(Error('native_browser_assets_invalid'), { code: 'native_browser_assets_invalid', statusCode: 503 });
const identity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
async function readAsset(file, limit, executable = false) {
  if (!path.isAbsolute(file) || file.includes('\0') || await fs.realpath(file) !== file) throw fail();
  const handle = await fs.open(file, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > limit || executable && !(before.mode & 0o111)) throw fail();
    const bytes = await handle.readFile();
    if (identity(before) !== identity(await handle.stat()) || identity(before) !== identity(await fs.lstat(file))) throw fail();
    return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  } finally { await handle.close(); }
}

/** Seal only the existing Electron-owned installation. This does not install, execute or discover browser tools. */
export async function readNativeBrowserAssets(environment = {}) {
  const binaryPath = environment.DEVRYAN_AGENT_BROWSER_BIN;
  if (binaryPath === undefined) return undefined;
  if (typeof binaryPath !== 'string' || !path.isAbsolute(binaryPath)) throw fail();
  const packageRoot = path.dirname(path.dirname(binaryPath)), modules = path.dirname(packageRoot), installRoot = path.dirname(modules);
  if (path.basename(packageRoot) !== 'agent-browser' || path.basename(modules) !== 'node_modules'
    || path.dirname(binaryPath) !== path.join(packageRoot, 'bin')
    || path.basename(binaryPath) !== `agent-browser-${process.platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`) throw fail();
  const info = JSON.parse((await readAsset(path.join(packageRoot, 'package.json'), 1024 * 1024)).bytes.toString());
  if (info.name !== 'agent-browser' || info.version !== AGENT_BROWSER_VERSION) throw fail();
  const configPath = path.join(installRoot, AGENT_BROWSER_MANAGED_CONFIG_FILE);
  const config = await readAsset(configPath, 4096), parsed = JSON.parse(config.bytes.toString());
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length) throw fail();
  const binary = await readAsset(binaryPath, 200 * 1024 * 1024, true);
  const recording = await createFfmpegInstaller({ installRoot, runCommand: async () => { throw fail(); } }).status();
  const ffmpeg = recording.ok ? { path: recording.binaryPath, sha256: (await readAsset(recording.binaryPath, 200 * 1024 * 1024, true)).sha256 } : undefined;
  return Object.freeze({ binaryPath, sha256: binary.sha256, configPath, configSha256: config.sha256,
    ...(ffmpeg ? { ffmpeg: Object.freeze(ffmpeg) } : {}) });
}
