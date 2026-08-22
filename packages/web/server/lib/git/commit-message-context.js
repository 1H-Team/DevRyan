export const COMMIT_DRAFT_MAX_SELECTED_FILES = 200;
export const COMMIT_DRAFT_MAX_PATH_LENGTH = 1024;
export const COMMIT_DRAFT_CONTEXT_LIMITS = Object.freeze({
  recentCommitCount: 6,
  maxTotalDiffChars: 16_000,
  diffContextLines: 1,
});

const requestError = (message, code) => Object.assign(new Error(message), {
  statusCode: 400,
  code,
});

const normalizeGitPath = (value) => String(value || '')
  .replace(/\\/g, '/')
  .replace(/^\.\/+/, '')
  .trim();

export const validateCommitMessageSelectedFiles = (selectedFiles) => {
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

const collectBatchContext = async ({
  directory,
  files,
  stagedOnly,
  diffStats,
  getDiff,
  limits,
}) => {
  const selectedPaths = files.map((file) => file.path);
  const requests = [getDiff(directory, {
    paths: selectedPaths,
    staged: true,
    contextLines: limits.diffContextLines,
  })];
  if (!stagedOnly) {
    requests.push(getDiff(directory, {
      paths: selectedPaths,
      staged: false,
      contextLines: limits.diffContextLines,
    }));
  }
  const settled = await Promise.allSettled(requests);
  const combined = settled
    .filter((result) => result.status === 'fulfilled')
    .map((result) => normalizeDiffResult(result.value).trim())
    .filter(Boolean)
    .join('\n');
  const { text: patch, truncated } = truncateDiff(combined, limits.maxTotalDiffChars);
  return {
    files: files.map((file) => {
      const stats = diffStats?.[file.path];
      return {
        ...file,
        ...(stats ? {
          insertions: Number(stats.insertions || 0),
          deletions: Number(stats.deletions || 0),
        } : {}),
      };
    }),
    patch,
    patchTruncated: truncated,
    partial: settled.some((result) => result.status === 'rejected'),
  };
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
  const selectedPaths = validateCommitMessageSelectedFiles(selectedFiles);
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

  const batchContext = await collectBatchContext({
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
      selectedFiles: batchContext.files,
      recentCommitSubjects,
      ...(batchContext.patch ? { patch: batchContext.patch } : {}),
      ...(batchContext.patchTruncated ? { patchNote: 'combined patch truncated' } : {}),
      ...(batchContext.partial ? { contextWarning: 'some diff context was unavailable' } : {}),
    },
  };
};

export const __test = {
  normalizeGitPath,
  validateSelectedFiles: validateCommitMessageSelectedFiles,
  collectBatchContext,
};
