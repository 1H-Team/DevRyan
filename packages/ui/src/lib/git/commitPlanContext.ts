import {
  getGitDiff,
  getGitFileDiff,
  getGitLog,
  getGitStatus,
} from '../gitApiHttp';
import type {
  GitCommitMessageContext,
  GitCommitMessageFileContext,
  GitStatusFile,
} from '../api/types';

export interface CommitContextLimits {
  recentCommitCount: number;
  diffConcurrency: number;
  maxDiffCharsPerFile: number;
  maxTotalDiffChars: number;
  diffContextLines: number;
  largeFileLineThreshold: number;
}

export const COMMIT_PLAN_CONTEXT_LIMITS: CommitContextLimits = {
  recentCommitCount: 12,
  diffConcurrency: 6,
  maxDiffCharsPerFile: 6_000,
  maxTotalDiffChars: 80_000,
  diffContextLines: 3,
  largeFileLineThreshold: 500,
};

export type CommitPlanFileContext = GitCommitMessageFileContext;
export type CommitPlanContext = GitCommitMessageContext;

export type BuildCommitPlanContextResult =
  | { status: 'ready'; context: CommitPlanContext }
  | { status: 'blocked'; message: string };

const normalizeGitPath = (value: string): string => value.replace(/\\/g, '/').replace(/^\.\/+/, '').trim();

const isUnmergedStatus = (value: string): boolean => {
  const normalized = value.trim().toUpperCase();
  return normalized.includes('U');
};

const hasMergeOrRebaseConflict = (files: GitStatusFile[]): boolean =>
  files.some((file) => isUnmergedStatus(file.index) || isUnmergedStatus(file.working_dir));

const formatStatusPair = (index: string, workingDir: string): string => {
  const staged = index.trim() || '.';
  const unstaged = workingDir.trim() || '.';
  return `index=${staged} worktree=${unstaged}`;
};

const truncateDiffText = (diff: string, maxChars: number): { text: string; truncated: boolean } => {
  if (diff.length <= maxChars) {
    return { text: diff, truncated: false };
  }
  return {
    text: `${diff.slice(0, maxChars)}\n... [diff truncated]`,
    truncated: true,
  };
};

const isBinaryDiffText = (diff: string): boolean => /binary files differ/i.test(diff);

const fetchFileDiffContext = async (
  directory: string,
  path: string,
  stagedOnly: boolean,
  limits: CommitContextLimits,
): Promise<Pick<CommitPlanFileContext, 'diff' | 'diffNote'>> => {
  // Fetch metadata + unified diff in parallel — they hit the same git data
  // but the server treats them as separate calls. Sequencing them doubled the
  // network round-trips per file.
  const [fileDiffResult, diffResult] = await Promise.allSettled([
    getGitFileDiff(directory, { path, staged: stagedOnly }),
    getGitDiff(directory, { path, staged: stagedOnly, contextLines: limits.diffContextLines }),
  ]);

  if (fileDiffResult.status === 'fulfilled' && fileDiffResult.value.isBinary) {
    return { diffNote: 'binary file (diff omitted)' };
  }

  if (diffResult.status === 'rejected') {
    return {
      diffNote: diffResult.reason instanceof Error ? diffResult.reason.message : 'failed to load diff',
    };
  }

  const diff = typeof diffResult.value.diff === 'string' ? diffResult.value.diff.trim() : '';
  if (!diff) {
    return { diffNote: 'no diff available for current scope' };
  }
  if (isBinaryDiffText(diff)) {
    return { diffNote: 'binary file (diff omitted)' };
  }
  const truncated = truncateDiffText(diff, limits.maxDiffCharsPerFile);
  return {
    diff: truncated.text,
    ...(truncated.truncated ? { diffNote: 'diff truncated' } : {}),
  };
};

const fetchSelectedFileDiffs = async (
  directory: string,
  files: Array<{ path: string; index: string; workingDir: string }>,
  stagedOnly: boolean,
  limits: CommitContextLimits,
  diffStats?: Record<string, { insertions: number; deletions: number }>,
): Promise<CommitPlanFileContext[]> => {
  const results: CommitPlanFileContext[] = new Array(files.length);
  let totalDiffChars = 0;
  let nextIndex = 0;

  const takeNext = () => {
    const current = nextIndex;
    nextIndex += 1;
    return current < files.length ? current : null;
  };

  const worker = async () => {
    for (;;) {
      const index = takeNext();
      if (index === null) {
        return;
      }

      const file = files[index];
      const stats = diffStats?.[file.path];
      const changedLines = stats ? stats.insertions + stats.deletions : 0;
      const base: CommitPlanFileContext = {
        path: file.path,
        index: file.index,
        workingDir: file.workingDir,
      };

      if (changedLines > limits.largeFileLineThreshold) {
        results[index] = {
          ...base,
          diffNote: `large change (${changedLines} lines; diff omitted)`,
        };
        continue;
      }

      if (totalDiffChars >= limits.maxTotalDiffChars) {
        results[index] = {
          ...base,
          diffNote: 'diff omitted (context budget reached)',
        };
        continue;
      }

      const diffContext = await fetchFileDiffContext(directory, file.path, stagedOnly, limits);
      const diffChars = typeof diffContext.diff === 'string' ? diffContext.diff.length : 0;
      totalDiffChars += diffChars;
      results[index] = {
        ...base,
        ...diffContext,
      };
    }
  };

  const workerCount = Math.min(limits.diffConcurrency, files.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
};

export const buildCommitPlanContext = async (
  directory: string,
  selectedPaths: string[],
  options: { stagedOnly?: boolean; limits?: CommitContextLimits } = {},
): Promise<BuildCommitPlanContextResult> => {
  const stagedOnly = options.stagedOnly === true;
  const limits = options.limits ?? COMMIT_PLAN_CONTEXT_LIMITS;
  const allowlist = new Set(selectedPaths.map(normalizeGitPath).filter(Boolean));
  if (allowlist.size === 0) {
    return { status: 'blocked', message: 'No files selected for commit plan preview' };
  }

  // Status and recent log don't depend on each other — fetch in parallel.
  const [status, log] = await Promise.all([
    getGitStatus(directory),
    getGitLog(directory, { maxCount: limits.recentCommitCount }),
  ]);
  const statusFiles = Array.isArray(status.files) ? status.files : [];

  if (status.mergeInProgress || status.rebaseInProgress || hasMergeOrRebaseConflict(statusFiles)) {
    return {
      status: 'blocked',
      message: 'Merge or rebase conflicts must be resolved before generating a commit plan',
    };
  }

  const selectedFiles = statusFiles
    .filter((file) => allowlist.has(normalizeGitPath(file.path)))
    .map((file) => ({
      path: normalizeGitPath(file.path),
      index: typeof file.index === 'string' ? file.index : '',
      workingDir: typeof file.working_dir === 'string' ? file.working_dir : '',
    }));

  const missingPaths = Array.from(allowlist).filter(
    (path) => !selectedFiles.some((file) => file.path === path),
  );
  for (const path of missingPaths) {
    selectedFiles.push({
      path,
      index: '?',
      workingDir: '?',
    });
  }

  selectedFiles.sort((a, b) => a.path.localeCompare(b.path));

  const recentCommitSubjects = (Array.isArray(log.all) ? log.all : [])
    .map((entry) => (typeof entry.message === 'string' ? entry.message.trim() : ''))
    .filter(Boolean);

  const fileContexts = await fetchSelectedFileDiffs(
    directory,
    selectedFiles,
    stagedOnly,
    limits,
    status.diffStats,
  );

  return {
    status: 'ready',
    context: {
      branch: typeof status.current === 'string' ? status.current : '',
      tracking: typeof status.tracking === 'string' ? status.tracking : null,
      scope: stagedOnly ? 'staged-only' : 'staged-and-unstaged',
      stagedOnly,
      selectedFiles: fileContexts.map((file) => ({
        ...file,
        index: file.index,
        workingDir: file.workingDir,
      })),
      recentCommitSubjects,
    },
  };
};

export const serializeCommitPlanContext = (context: CommitPlanContext): string =>
  JSON.stringify(
    {
      branch: context.branch,
      tracking: context.tracking,
      scope: context.scope,
      stagedOnly: context.stagedOnly,
      recentCommitSubjects: context.recentCommitSubjects,
      selectedFiles: context.selectedFiles.map((file) => ({
        path: file.path,
        status: formatStatusPair(file.index, file.workingDir),
        ...(file.diff ? { diff: file.diff } : {}),
        ...(file.diffNote ? { diffNote: file.diffNote } : {}),
      })),
    },
    null,
    2,
  );
