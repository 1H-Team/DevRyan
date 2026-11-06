import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

// Apple's /usr/bin developer tools (git, cc, make, swift and the other hard
// links of one shim, and xcrun) pick the real tool when they run. With a full
// Xcode selected the shim first spawns xcodebuild. The execution profile denies
// posix_spawn and the spawn adapter never loads into a platform binary, so each
// shim exits 71 inside confinement. With only the Command Line Tools selected
// the shim runs the tool directly and works. A confined command therefore gets
// the selected Xcode's tool directories ahead of /usr/bin, toolchain first as
// xcrun orders them (Developer/usr/bin/ld is itself an xcrun stub). It also gets
// the SDKROOT the shim gives the tools it launches: without it cc cannot find
// the SDK headers. Explicit /usr/bin/<tool> and xcrun calls still exit 71.
// Kill switch: DEVRYAN_DEVELOPER_TOOL_PATH=0.
const RESOLUTION_TTL_MS = 60_000;
const resolutions = new Map();

const isDirectory = (directory) => fs.stat(directory).then(stat => stat.isDirectory(), () => false);
const isFile = (file) => fs.stat(file).then(stat => stat.isFile(), () => false);
// Usable as a PATH entry: absolute, normalized, no separator or control character.
const searchable = (directory) => path.isAbsolute(directory) && path.normalize(directory) === directory && !/[\u0000-\u001f:]/.test(directory);
const isSystemBin = (entry) => entry !== '' && path.posix.normalize(`${entry}/`) === '/usr/bin/';

// The command's own DEVELOPER_DIR selects as it would for the shim;
// xcode-select reads the selection without spawning xcodebuild.
async function resolveSelectedXcode(developerDirectory, run) {
  let selected;
  try {
    const { stdout } = await run('/usr/bin/xcode-select', ['-p'], { timeout: 5000, maxBuffer: 4096,
      env: { PATH: '/usr/bin:/bin', ...(developerDirectory ? { DEVELOPER_DIR: developerDirectory } : {}) } });
    selected = String(stdout).trim();
  } catch { return null; }
  if (!searchable(selected) || !await isFile(path.join(selected, 'usr', 'bin', 'xcodebuild'))) return null;
  const candidates = [path.join(selected, 'Toolchains', 'XcodeDefault.xctoolchain', 'usr', 'bin'), path.join(selected, 'usr', 'bin')];
  const directories = (await Promise.all(candidates.map(async directory => await isDirectory(directory) ? directory : null))).filter(Boolean);
  const sdk = path.join(selected, 'Platforms', 'MacOSX.platform', 'Developer', 'SDKs', 'MacOSX.sdk');
  return { directories, sdk: await isDirectory(sdk) ? sdk : null };
}

/** PATH and SDKROOT additions for a command run under the macOS execution
 * profile. Never rejects: on another platform, without a full Xcode, without
 * /usr/bin on PATH or when the selection cannot be read, the command keeps its
 * own environment. Entries ahead of /usr/bin keep their precedence, and an
 * existing SDKROOT is kept. A selection is re-read after a minute. */
export async function developerToolEnvironment(env, { platform = process.platform, run = execute, cache = resolutions, now = Date.now } = {}) {
  if (platform !== 'darwin' || process.env.DEVRYAN_DEVELOPER_TOOL_PATH === '0' || typeof env?.PATH !== 'string') return {};
  const entries = env.PATH.split(':');
  const system = entries.findIndex(isSystemBin);
  if (system < 0) return {};
  const developerDirectory = typeof env.DEVELOPER_DIR === 'string' ? env.DEVELOPER_DIR : '';
  let resolution = cache.get(developerDirectory);
  if (!resolution || resolution.expires <= now()) {
    resolution = { expires: now() + RESOLUTION_TTL_MS, xcode: resolveSelectedXcode(developerDirectory, run).catch(() => null) };
    cache.set(developerDirectory, resolution);
    while (cache.size > 8) cache.delete(cache.keys().next().value);
  }
  const xcode = await resolution.xcode;
  if (!xcode?.directories.length) return {};
  const ahead = new Set(entries.slice(0, system));
  const added = xcode.directories.filter(directory => !ahead.has(directory));
  return {
    ...(added.length ? { PATH: [...entries.slice(0, system), ...added, ...entries.slice(system)].join(':') } : {}),
    ...(xcode.sdk && !env.SDKROOT ? { SDKROOT: xcode.sdk } : {}),
  };
}
