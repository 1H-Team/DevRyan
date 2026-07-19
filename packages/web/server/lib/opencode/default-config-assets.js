import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_CONFIG_MANAGED_ROOTS = Object.freeze(['agents', 'plugins', 'user-profile']);
export const RUNTIME_PLUGIN_EXTENSIONS = Object.freeze(['.js', '.mjs', '.cjs', '.ts']);

const PROHIBITED_SEGMENTS = new Set([
  'auth', 'credential', 'credentials', 'secret', 'secrets', 'log', 'logs',
  'cache', 'caches', 'backup', 'backups', 'node_modules', '.git', '.openchamber',
]);

const toSegments = (relativePath) => String(relativePath)
  .split(/[\\/]+/)
  .filter((segment) => segment && segment !== '.');

const hasProhibitedFileName = (fileName) => (
  fileName === '.DS_Store'
  || fileName.endsWith('.d.ts')
  || fileName.endsWith('.lock')
  || /^(auth|credential|credentials|secret|secrets|log|logs|cache|caches|backup|backups)(?=[._-]|$)/i.test(fileName)
  || /(^|[._-])(test|spec)(?=[._-]|$)/i.test(fileName)
  || /(^|[._-])manifest(?:[._-]|\.json$)/i.test(fileName)
  || /^(?:package-lock\.json|npm-shrinkwrap\.json|bun\.lockb?)$/i.test(fileName)
);

export const isRuntimePluginFileName = (fileName) => {
  if (typeof fileName !== 'string' || hasProhibitedFileName(path.basename(fileName))) {
    return false;
  }
  return RUNTIME_PLUGIN_EXTENSIONS.includes(path.extname(fileName).toLowerCase());
};

export const isProhibitedDefaultConfigRelativePath = (relativePath) => {
  const segments = toSegments(relativePath);
  if (segments.some((segment) => PROHIBITED_SEGMENTS.has(segment.toLowerCase()))) {
    return true;
  }
  return segments.length > 0 && hasProhibitedFileName(segments.at(-1));
};

export const isManagedDefaultConfigRelativePath = (relativePath) => (
  DEFAULT_CONFIG_MANAGED_ROOTS.includes(toSegments(relativePath)[0])
);

// This intentionally permits directories so fs.cp can descend only into the
// canonical roots. File callers still receive the stricter runtime policy.
export const isAllowedDefaultConfigRelativePath = (relativePath, { directory = false } = {}) => {
  const segments = toSegments(relativePath);
  if (segments.length === 0) {
    return true;
  }
  if (isProhibitedDefaultConfigRelativePath(relativePath)) {
    return false;
  }
  const [root] = segments;
  if (segments.length === 1 && root === 'opencode.json') {
    return true;
  }
  if (!DEFAULT_CONFIG_MANAGED_ROOTS.includes(root)) {
    return false;
  }
  if (directory) {
    return true;
  }
  return root !== 'plugins' || isRuntimePluginFileName(segments.at(-1));
};

const listFiles = async (root, relative = '', policyPrefix = '') => {
  const directory = path.join(root, relative);
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const nextRelative = path.join(relative, entry.name);
    const policyRelative = path.join(policyPrefix, nextRelative);
    if (!isAllowedDefaultConfigRelativePath(policyRelative, { directory: entry.isDirectory() })) {
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...await listFiles(root, nextRelative, policyPrefix));
    } else if (entry.isFile() && isAllowedDefaultConfigRelativePath(policyRelative)) {
      files.push(policyRelative.split(path.sep).join('/'));
    }
  }
  return files;
};

export const listDefaultConfigAssets = async (defaultConfigRoot) => (
  (await listFiles(defaultConfigRoot)).sort((left, right) => left.localeCompare(right))
);

export const listUserProfileAssets = async (profileRoot) => (
  (await listFiles(profileRoot, '', 'user-profile')).sort((left, right) => left.localeCompare(right))
);

export const listRuntimePluginAssets = async (defaultConfigRoot) => (
  (await listDefaultConfigAssets(defaultConfigRoot))
    .filter((relativePath) => relativePath.startsWith('plugins/'))
);
