import {
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export class FixtureSafetyError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'FixtureSafetyError';
    this.code = options.code ?? 'fixture_safety_error';
    if (options.cleanup) this.cleanup = options.cleanup;
  }
}

const runGit = (fixtureRoot, args) => {
  const result = spawnSync('git', args, {
    cwd: fixtureRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new FixtureSafetyError(`Fixture git inspection failed for ${args[0]}`, {
      code: 'fixture_git_error',
    });
  }
  return result.stdout;
};

const splitNull = (value) => value.split('\0').filter(Boolean);

const hashBuffer = (value) => createHash('sha256').update(value).digest('hex');

const pathEntryExists = (candidate) => {
  try {
    lstatSync(candidate);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
};

const captureDirectoryIdentity = (directoryPath, label) => {
  let stats;
  try {
    stats = lstatSync(directoryPath);
  } catch {
    throw new FixtureSafetyError(`${label} directory does not exist`, {
      code: 'fixture_directory_identity_changed',
    });
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new FixtureSafetyError(`${label} must be an ordinary directory`, {
      code: 'fixture_directory_identity_changed',
    });
  }
  return Object.freeze({ dev: stats.dev, ino: stats.ino });
};

const assertDirectoryIdentity = (directoryPath, expected, label) => {
  const current = captureDirectoryIdentity(directoryPath, label);
  if (!expected || current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new FixtureSafetyError(`${label} directory identity changed`, {
      code: 'fixture_directory_identity_changed',
    });
  }
};

const describePath = (fixtureRoot, relativePath) => {
  const absolutePath = path.join(fixtureRoot, relativePath);
  if (!pathEntryExists(absolutePath)) {
    return {
      path: relativePath,
      type: 'missing',
      mode: null,
      size: null,
      sha256: null,
    };
  }
  const stats = lstatSync(absolutePath);
  if (stats.isSymbolicLink()) {
    const target = readlinkSync(absolutePath);
    return {
      path: relativePath,
      type: 'symlink',
      mode: stats.mode & 0o7777,
      size: Buffer.byteLength(target),
      sha256: hashBuffer(Buffer.from(target)),
    };
  }
  if (stats.isFile()) {
    return {
      path: relativePath,
      type: 'file',
      mode: stats.mode & 0o7777,
      size: stats.size,
      sha256: hashBuffer(readFileSync(absolutePath)),
    };
  }
  return {
    path: relativePath,
    type: stats.isDirectory() ? 'directory' : 'other',
    mode: stats.mode & 0o7777,
    size: stats.size,
    sha256: null,
  };
};

const normalizeFixtureRoot = (fixtureRoot) => {
  if (typeof fixtureRoot !== 'string' || !fixtureRoot.trim()) {
    throw new FixtureSafetyError('Fixture root is required');
  }
  const literalRoot = path.resolve(fixtureRoot);
  captureDirectoryIdentity(literalRoot, 'Fixture root');
  let canonical;
  try {
    canonical = realpathSync(literalRoot);
  } catch {
    throw new FixtureSafetyError('Fixture root does not exist');
  }
  const gitRoot = path.resolve(runGit(canonical, ['rev-parse', '--show-toplevel']).trim());
  if (realpathSync(gitRoot) !== canonical) {
    throw new FixtureSafetyError('Fixture root must be the exact git worktree root');
  }
  return canonical;
};

const trackedDirtyEntries = (fixtureRoot) => splitNull(
  runGit(fixtureRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
).filter((entry) => !entry.startsWith('?? '));

export const captureFixtureManifest = (fixtureRoot) => {
  const root = normalizeFixtureRoot(fixtureRoot);
  const trackedPaths = splitNull(runGit(root, ['ls-files', '-z'])).sort();
  const untrackedPaths = splitNull(
    runGit(root, ['ls-files', '--others', '--exclude-standard', '-z']),
  ).sort();
  return {
    tracked: trackedPaths.map((entry) => describePath(root, entry)),
    untracked: untrackedPaths.map((entry) => describePath(root, entry)),
    trackedDirty: trackedDirtyEntries(root).sort(),
  };
};

export const assertFixtureReady = (fixtureRoot) => {
  const manifest = captureFixtureManifest(fixtureRoot);
  if (manifest.trackedDirty.length > 0) {
    throw new FixtureSafetyError('Fixture tracked state is dirty; evaluation aborted before mutation', {
      code: 'fixture_tracked_dirty',
    });
  }
  return manifest;
};

const manifestMap = (entries) => new Map(entries.map((entry) => [entry.path, entry]));

const compareEntries = (label, before, after, differences) => {
  const beforeMap = manifestMap(before);
  const afterMap = manifestMap(after);
  const paths = [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort();
  for (const entryPath of paths) {
    const oldEntry = beforeMap.get(entryPath);
    const newEntry = afterMap.get(entryPath);
    if (!oldEntry) {
      differences.push(`${label} path added: ${entryPath}`);
    } else if (!newEntry) {
      differences.push(`${label} path removed: ${entryPath}`);
    } else if (JSON.stringify(oldEntry) !== JSON.stringify(newEntry)) {
      differences.push(`${label} path changed: ${entryPath}`);
    }
  }
};

export const compareFixtureManifests = (before, after) => {
  const differences = [];
  compareEntries('tracked', before?.tracked ?? [], after?.tracked ?? [], differences);
  compareEntries('untracked', before?.untracked ?? [], after?.untracked ?? [], differences);
  if (JSON.stringify(before?.trackedDirty ?? []) !== JSON.stringify(after?.trackedDirty ?? [])) {
    differences.push('tracked dirty-status entries changed');
  }
  return { matches: differences.length === 0, differences };
};

const validateRunId = (runId) => {
  if (typeof runId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(runId)) {
    throw new FixtureSafetyError('Evaluation run ID is invalid');
  }
  return runId;
};

export const allocateRunFiles = (fixtureRoot, runId) => {
  const root = normalizeFixtureRoot(fixtureRoot);
  const fixtureIdentity = captureDirectoryIdentity(root, 'Fixture root');
  const safeRunId = validateRunId(runId);
  const srcPath = path.join(root, 'src');
  const sourceDirectoryIdentity = captureDirectoryIdentity(srcPath, 'Fixture src');
  let canonicalSrc;
  try {
    canonicalSrc = realpathSync(srcPath);
  } catch {
    throw new FixtureSafetyError('Fixture must contain an existing src directory');
  }
  if (path.dirname(canonicalSrc) !== root) {
    throw new FixtureSafetyError('Fixture src directory must not escape the fixture root');
  }
  const sourceRelativePath = `src/devryan-eval-${safeRunId}.ts`;
  const testRelativePath = `src/devryan-eval-${safeRunId}.test.mjs`;
  const sourcePath = path.join(root, sourceRelativePath);
  const testPath = path.join(root, testRelativePath);
  for (const candidate of [sourcePath, testPath]) {
    if (pathEntryExists(candidate)) {
      throw new FixtureSafetyError(`Run-owned file already exists: ${path.basename(candidate)}`, {
        code: 'fixture_run_file_collision',
      });
    }
  }
  return Object.freeze({
    fixtureRoot: root,
    fixtureIdentity,
    sourceDirectoryEntry: srcPath,
    sourceDirectory: canonicalSrc,
    sourceDirectoryIdentity,
    runId: safeRunId,
    sourcePath,
    testPath,
    sourceRelativePath,
    testRelativePath,
    ownedPaths: Object.freeze([sourcePath, testPath]),
  });
};

const assertOwnedPath = (targetPath, runFiles) => {
  const resolved = path.resolve(targetPath);
  if (!runFiles?.ownedPaths?.includes(resolved)) {
    throw new FixtureSafetyError('Refusing to access a path not owned by this evaluation run', {
      code: 'fixture_path_not_owned',
    });
  }
  assertDirectoryIdentity(runFiles.fixtureRoot, runFiles.fixtureIdentity, 'Fixture root');
  assertDirectoryIdentity(
    runFiles.sourceDirectoryEntry,
    runFiles.sourceDirectoryIdentity,
    'Fixture src',
  );
  let currentSourceDirectory;
  try {
    currentSourceDirectory = realpathSync(path.dirname(resolved));
  } catch {
    throw new FixtureSafetyError('Refusing to access a run-owned path after its src directory changed', {
      code: 'fixture_source_directory_changed',
    });
  }
  if (currentSourceDirectory !== runFiles.sourceDirectory) {
    throw new FixtureSafetyError('Refusing to access a run-owned path after its src directory changed', {
      code: 'fixture_source_directory_changed',
    });
  }
  return resolved;
};

export const writeRunOwnedFile = (targetPath, content, runFiles) => {
  const resolved = assertOwnedPath(targetPath, runFiles);
  if (typeof content !== 'string') {
    throw new FixtureSafetyError('Run-owned file content must be a string');
  }
  try {
    writeFileSync(resolved, content, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new FixtureSafetyError(`Run-owned file already exists: ${path.basename(resolved)}`, {
        code: 'fixture_run_file_collision',
      });
    }
    throw error;
  }
};

export const cleanupRunFiles = ({ fixtureRoot, runFiles, startingManifest }) => {
  const root = normalizeFixtureRoot(fixtureRoot);
  if (root !== runFiles?.fixtureRoot) {
    throw new FixtureSafetyError('Cleanup fixture does not match the allocation owner');
  }
  let deletedOwnedFileCount = 0;
  const deletionFailures = [];
  for (const targetPath of runFiles.ownedPaths) {
    try {
      const resolved = assertOwnedPath(targetPath, runFiles);
      if (!pathEntryExists(resolved)) continue;
      const stats = lstatSync(resolved);
      if (stats.isDirectory()) {
        throw new FixtureSafetyError('Refusing to recursively delete a run-owned path');
      }
      unlinkSync(resolved);
      deletedOwnedFileCount += 1;
    } catch {
      deletionFailures.push(path.basename(targetPath));
    }
  }

  const finalManifest = captureFixtureManifest(root);
  const comparison = compareFixtureManifests(startingManifest, finalManifest);
  const cleanup = {
    restored: deletionFailures.length === 0 && comparison.matches,
    deletedOwnedFileCount,
    manifestMatch: comparison.matches,
    deletionFailureCount: deletionFailures.length,
  };
  if (!cleanup.restored) {
    throw new FixtureSafetyError('Fixture exact starting manifest was not restored by surgical cleanup', {
      code: 'fixture_restoration_failed',
      cleanup,
    });
  }
  return cleanup;
};
