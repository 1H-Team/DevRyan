import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLAUDE_CODE_PACKAGE_SEGMENTS = ['@anthropic-ai', 'claude-code'];
const MERIDIAN_PACKAGE_SEGMENTS = ['@rynfar', 'meridian'];

const isExecutableFile = (filePath, { fsApi = fs, platform = process.platform } = {}) => {
  try {
    const stat = fsApi.statSync(filePath);
    if (!stat.isFile()) return false;
    if (platform !== 'win32') fsApi.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const executableNames = (name, { env = process.env, pathApi = path, platform = process.platform } = {}) => {
  if (platform !== 'win32' || pathApi.extname(name)) return [name];
  const pathExt = env.PATHEXT || env.PathExt || '.COM;.EXE;.BAT;.CMD';
  return [name, ...String(pathExt).split(';')
    .map((extension) => extension.trim())
    .filter(Boolean)
    .map((extension) => `${name}${extension.startsWith('.') ? extension : `.${extension}`}`)];
};

export const searchPathForClaudeCode = (pathValue, options = {}) => {
  const pathApi = options.pathApi || path;
  const candidates = executableNames('claude', { ...options, pathApi });
  for (const directory of String(pathValue || '').split(pathApi.delimiter).filter(Boolean)) {
    if (!pathApi.isAbsolute(directory)) continue;
    for (const name of candidates) {
      const candidate = pathApi.join(directory, name);
      if (isExecutableFile(candidate, options)) return candidate;
    }
  }
  return null;
};

const readPackageBin = (packageDirectory, options = {}) => {
  const fsApi = options.fsApi || fs;
  const pathApi = options.pathApi || path;
  try {
    const packageJson = JSON.parse(fsApi.readFileSync(pathApi.join(packageDirectory, 'package.json'), 'utf8'));
    const bin = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.claude;
    if (typeof bin !== 'string' || !bin.trim()) return null;
    const candidate = pathApi.resolve(packageDirectory, bin);
    const relative = pathApi.relative(packageDirectory, candidate);
    if (!relative || relative.startsWith('..') || pathApi.isAbsolute(relative)) return null;
    return isExecutableFile(candidate, options) ? candidate : null;
  } catch {
    return null;
  }
};

const resolveManagedClaudeCode = (configDirectory, options = {}) => {
  const pathApi = options.pathApi || path;
  const binDirectory = pathApi.join(configDirectory, 'node_modules', '.bin');
  const shim = searchPathForClaudeCode(binDirectory, options);
  if (shim) return shim;
  if ((options.platform || process.platform) === 'win32') return null;

  const packageDirectories = [
    pathApi.join(configDirectory, 'node_modules', ...CLAUDE_CODE_PACKAGE_SEGMENTS),
    pathApi.join(
      configDirectory,
      'node_modules',
      ...MERIDIAN_PACKAGE_SEGMENTS,
      'node_modules',
      ...CLAUDE_CODE_PACKAGE_SEGMENTS,
    ),
  ];
  for (const packageDirectory of packageDirectories) {
    const executable = readPackageBin(packageDirectory, options);
    if (executable) return executable;
  }
  return null;
};

const prependExecutableDirectory = (pathValue, executable, pathApi = path) => {
  const directory = pathApi.dirname(executable);
  const segments = String(pathValue || '').split(pathApi.delimiter).filter(Boolean);
  return [directory, ...segments.filter((segment) => segment !== directory)].join(pathApi.delimiter);
};

export const resolveClaudeCodeLaunch = ({
  env = process.env,
  pathValue = env.PATH || '',
  configDirectory,
  fsApi = fs,
  homedir = os.homedir,
  pathApi = path,
  platform = process.platform,
} = {}) => {
  const options = { env, fsApi, pathApi, platform };
  const explicit = typeof env.CLAUDE_CODE_CLI === 'string' ? env.CLAUDE_CODE_CLI.trim() : '';
  if (explicit) {
    const hasPathSeparator = explicit.includes('/') || explicit.includes('\\');
    const executable = hasPathSeparator || pathApi.isAbsolute(explicit)
      ? (isExecutableFile(pathApi.resolve(explicit), options) ? pathApi.resolve(explicit) : null)
      : executableNames(explicit, options).flatMap((name) => String(pathValue || '')
        .split(pathApi.delimiter)
        .filter((directory) => pathApi.isAbsolute(directory))
        .map((directory) => pathApi.join(directory, name)))
        .find((candidate) => isExecutableFile(candidate, options)) || null;
    return executable
      ? {
          executable,
          pathValue: prependExecutableDirectory(pathValue, executable, pathApi),
          source: 'explicit',
        }
      : null;
  }

  const managedDirectory = configDirectory || pathApi.join(homedir(), '.config', 'opencode');
  const managedExecutable = resolveManagedClaudeCode(managedDirectory, options);
  if (managedExecutable) {
    return {
      executable: managedExecutable,
      pathValue: prependExecutableDirectory(pathValue, managedExecutable, pathApi),
      source: 'managed',
    };
  }

  const pathExecutable = searchPathForClaudeCode(pathValue, options);
  return pathExecutable
    ? {
        executable: pathExecutable,
        pathValue: prependExecutableDirectory(pathValue, pathExecutable, pathApi),
        source: 'path',
      }
    : null;
};
