export const COMMIT_DRAFT_MAX_SELECTED_FILES = 200;
export const COMMIT_DRAFT_MAX_PATH_LENGTH = 1024;
export const COMMIT_DRAFT_CONTEXT_LIMITS = Object.freeze({
  recentCommitCount: 6,
  diffConcurrency: 6,
  maxDiffCharsPerFile: 1_500,
  maxTotalDiffChars: 16_000,
  diffContextLines: 1,
  largeFileLineThreshold: 200,
});

const requestError = (message, code) => Object.assign(new Error(message), {
  statusCode: 400,
  code,
});

const normalizeGitPath = (value) => String(value || '')
  .replace(/\\/g, '/')
  .replace(/^\.\/+/, '')
  .trim();

const validateSelectedFiles = (selectedFiles) => {
  if (!Array.isArray(selectedFiles) || selectedFiles.length === 0) {
    throw requestError('At least one selected file is required', 'COMMIT_DRAFT_FILES_REQUIRED');
  }
  const normalized = [];
  const seen = new Set();
  for (const value of selectedFiles) {
    if (typeof value !== 'string') {
      throw requestError('Selected file paths must be strings', 'COMMIT_DRAFT_INVALID_PATH');
    }
    const filePath = normalizeGitPath(value);
    if (
      !filePath
      || filePath.length > COMMIT_DRAFT_MAX_PATH_LENGTH
      || filePath === '..'
      || filePath.startsWith('../')
      || filePath.startsWith('/')
      || /^[a-z]:\//i.test(filePath)
      || filePath.split('/').includes('..')
      || filePath.includes('\0')
    ) {
      throw requestError('Selected file path is invalid', 'COMMIT_DRAFT_INVALID_PATH');
    }
    if (!seen.has(filePath)) {
      seen.add(filePath);
      normalized.push(filePath);
      if (normalized.length > COMMIT_DRAFT_MAX_SELECTED_FILES) {
        throw requestError(
          `At most ${COMMIT_DRAFT_MAX_SELECTED_FILES} files can be used to generate a commit message`,
          'COMMIT_DRAFT_TOO_MANY_FILES',
        );
      }
    }
  }
  return normalized;
};

const isUnmergedStatus = (value) => String(value || '').trim().toUpperCase().includes('U');

const hasMergeOrRebaseConflict = (files) => files.some((file) => (
  isUnmergedStatus(file.index) || isUnmergedStatus(file.working_dir)
));

const isBinaryDiffText = (diff) => /binary files differ/i.test(diff);
const DIFF_TRUNCATION_MARKER = '\n... [diff truncated]';

const truncateDiff = (diff, maxChars) => {
  if (diff.length <= maxChars) return { text: diff, truncated: false };
  if (maxChars <= DIFF_TRUNCATION_MARKER.length) {
    return { text: diff.slice(0, maxChars), truncated: true };
  }
  return {
    text: `${diff.slice(0, maxChars - DIFF_TRUNCATION_MARKER.length)}${DIFF_TRUNCATION_MARKER}`,
    truncated: true,
  };
};

const normalizeDiffResult = (value) => {
  if (typeof value === 'string') return value;
  return typeof value?.diff === 'string' ? value.diff : '';
};

const collectFileContexts = async ({
  directory,
  files,
  stagedOnly,
  diffStats,
  getDiff,
  limits,
}) => {
  const results = new Array(files.length);
  let nextIndex = 0;
  let totalDiffChars = 0;

  const takeNext = () => {
    const current = nextIndex;
    nextIndex += 1;
    return current < files.length ? current : null;
  };

  const worker = async () => {
    for (;;) {
      const index = takeNext();
      if (index === null) return;

      const file = files[index];
      const base = {
        path: file.path,
        index: file.index,
        workingDir: file.workingDir,
      };
      const stats = diffStats?.[file.path];
      const changedLines = stats ? Number(stats.insertions || 0) + Number(stats.deletions || 0) : 0;
      if (changedLines > limits.largeFileLineThreshold) {
        results[index] = {
          ...base,
          diffNote: `large change (${changedLines} lines; diff omitted)`,
        };
        continue;
      }
      if (totalDiffChars >= limits.maxTotalDiffChars) {
        results[index] = { ...base, diffNote: 'diff omitted (context budget reached)' };
        continue;
      }

      try {
        const raw = await getDiff(directory, {
          path: file.path,
          staged: stagedOnly,
          contextLines: limits.diffContextLines,
        });
        const diff = normalizeDiffResult(raw).trim();
        if (!diff) {
          results[index] = { ...base, diffNote: 'no diff available for current scope' };
          continue;
        }
        if (isBinaryDiffText(diff)) {
          results[index] = { ...base, diffNote: 'binary file (diff omitted)' };
          continue;
        }

        const remaining = Math.max(0, limits.maxTotalDiffChars - totalDiffChars);
        if (remaining === 0) {
          results[index] = { ...base, diffNote: 'diff omitted (context budget reached)' };
          continue;
        }
        const maxChars = Math.min(limits.maxDiffCharsPerFile, remaining);
        const { text: selectedDiff, truncated } = truncateDiff(diff, maxChars);
        totalDiffChars += selectedDiff.length;
        results[index] = {
          ...base,
          diff: selectedDiff,
          ...(truncated ? { diffNote: 'diff truncated' } : {}),
        };
      } catch (error) {
        results[index] = {
          ...base,
          diffNote: error instanceof Error ? error.message : 'failed to load diff',
        };
      }
    }
  };

  const workerCount = Math.min(limits.diffConcurrency, files.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
};

export const collectCommitMessageContext = async ({
  directory,
  selectedFiles,
  stagedOnly = false,
  getStatus,
  getLog,
  getDiff,
  limits = COMMIT_DRAFT_CONTEXT_LIMITS,
}) => {
  const selectedPaths = validateSelectedFiles(selectedFiles);
  const allowlist = new Set(selectedPaths);
  const [status, log] = await Promise.all([
    getStatus(directory),
    getLog(directory, { maxCount: limits.recentCommitCount }),
  ]);
  const statusFiles = Array.isArray(status?.files) ? status.files : [];
  if (status?.mergeInProgress || status?.rebaseInProgress || hasMergeOrRebaseConflict(statusFiles)) {
    return {
      status: 'blocked',
      message: 'Merge or rebase conflicts must be resolved before generating a commit message',
    };
  }

  const files = statusFiles
    .map((file) => ({
      path: normalizeGitPath(file.path),
      index: typeof file.index === 'string' ? file.index : '',
      workingDir: typeof file.working_dir === 'string' ? file.working_dir : '',
    }))
    .filter((file) => allowlist.has(file.path));
  const resolved = new Set(files.map((file) => file.path));
  for (const filePath of selectedPaths) {
    if (!resolved.has(filePath)) {
      files.push({ path: filePath, index: '?', workingDir: '?' });
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));

  const fileContexts = await collectFileContexts({
    directory,
    files,
    stagedOnly,
    diffStats: status?.diffStats,
    getDiff,
    limits,
  });
  const recentCommitSubjects = (Array.isArray(log?.all) ? log.all : [])
    .map((entry) => (typeof entry?.message === 'string' ? entry.message.trim() : ''))
    .filter(Boolean)
    .slice(0, limits.recentCommitCount);

  return {
    status: 'ready',
    context: {
      branch: typeof status?.current === 'string' ? status.current : '',
      tracking: typeof status?.tracking === 'string' ? status.tracking : null,
      scope: stagedOnly ? 'staged-only' : 'staged-and-unstaged',
      stagedOnly,
      selectedFiles: fileContexts,
      recentCommitSubjects,
    },
  };
};

export const __test = {
  normalizeGitPath,
  validateSelectedFiles,
  collectFileContexts,
};
