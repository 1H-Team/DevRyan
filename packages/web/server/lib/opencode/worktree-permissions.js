import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const normalizeProjectId = (value) => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (
    !normalized
    || normalized === '.'
    || normalized === '..'
    || normalized.includes('/')
    || normalized.includes('\\')
    || normalized.includes('\0')
  ) {
    return null;
  }
  return normalized;
};

const isContainedPath = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
};

const findGitMarker = (workingDirectory) => {
  let current = path.resolve(workingDirectory);
  while (true) {
    const marker = path.join(current, '.git');
    if (fs.existsSync(marker)) return marker;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
};

const readProjectIdFromGitMarker = (gitMarker) => {
  try {
    const markerStat = fs.statSync(gitMarker);
    let commonGitDirectory = gitMarker;
    if (markerStat.isFile()) {
      const marker = fs.readFileSync(gitMarker, 'utf8').trim();
      const match = marker.match(/^gitdir:\s*(.+)$/i);
      if (!match) return null;
      const linkedGitDirectory = path.resolve(path.dirname(gitMarker), match[1].trim());
      const commonDir = fs.readFileSync(path.join(linkedGitDirectory, 'commondir'), 'utf8').trim();
      if (!commonDir) return null;
      commonGitDirectory = path.resolve(linkedGitDirectory, commonDir);
    } else if (!markerStat.isDirectory()) {
      return null;
    }

    return normalizeProjectId(fs.readFileSync(path.join(commonGitDirectory, 'opencode'), 'utf8'));
  } catch {
    return null;
  }
};

const getOpenCodeDataDirectory = (options = {}) => {
  if (typeof options.openCodeDataDirectory === 'string' && options.openCodeDataDirectory.trim()) {
    return path.resolve(options.openCodeDataDirectory.trim());
  }
  const env = options.env ?? process.env;
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const xdgDataHome = typeof env.XDG_DATA_HOME === 'string' && env.XDG_DATA_HOME.trim()
    ? env.XDG_DATA_HOME.trim()
    : path.join(homeDirectory, '.local', 'share');
  return path.resolve(xdgDataHome, 'opencode');
};

const resolveActiveProjectWorktreeContainer = (workingDirectory, options = {}) => {
  if (typeof workingDirectory !== 'string' || !workingDirectory.trim()) return null;

  const resolvedWorkingDirectory = path.resolve(workingDirectory.trim());
  const worktreeDirectory = path.join(getOpenCodeDataDirectory(options), 'worktree');
  let projectId = null;

  if (isContainedPath(worktreeDirectory, resolvedWorkingDirectory)) {
    projectId = normalizeProjectId(path.relative(worktreeDirectory, resolvedWorkingDirectory).split(path.sep)[0]);
  }
  if (!projectId) {
    const gitMarker = findGitMarker(resolvedWorkingDirectory);
    projectId = gitMarker ? readProjectIdFromGitMarker(gitMarker) : null;
  }

  return projectId ? path.join(worktreeDirectory, projectId) : null;
};

export {
  getOpenCodeDataDirectory,
  resolveActiveProjectWorktreeContainer,
};
