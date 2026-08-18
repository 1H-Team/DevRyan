import path from 'node:path';

export const createHarnessPaths = ({ rootDir }) => {
  if (typeof rootDir !== 'string' || rootDir.trim().length === 0) {
    throw new TypeError('rootDir is required');
  }

  const harnessDir = path.join(path.resolve(rootDir), 'harness');
  return {
    harnessDir,
    commandDeadlineDir: path.join(harnessDir, 'command-deadlines'),
    worktreeOpsDir: path.join(harnessDir, 'worktree-ops'),
    journalDir: path.join(harnessDir, 'journal'),
    evidenceDir: path.join(harnessDir, 'evidence'),
  };
};
