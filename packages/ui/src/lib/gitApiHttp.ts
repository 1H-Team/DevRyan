

import type {
  GitStatus,
  GitDiffResponse,
  GetGitDiffOptions,
  GitFileDiffResponse,
  GetGitFileDiffOptions,
  GitBranch,
  GitDeleteBranchPayload,
  GitDeleteRemoteBranchPayload,
  GitRemoveRemotePayload,
  GenerateGitCommitMessageRequest,
  GeneratedCommitMessage,
  GitWorktreeInfo,
  CreateGitWorktreePayload,
  GitWorktreeCreateResult,
  RemoveGitWorktreePayload,
  GitWorktreeValidationResult,
  CreateGitCommitOptions,
  GitCommitResult,
  GitPushResult,
  GitPullResult,
  GitPullOptions,
  GitStashEntry,
  GitLogOptions,
  GitLogResponse,
  GitCommitFilesResponse,
  GitIdentityProfile,
  GitIdentitySummary,
  DiscoveredGitCredential,
  MergeConflictDetails,
} from './api/types';

declare global {
  interface Window {
    __OPENCHAMBER_DESKTOP_SERVER__?: {
      origin: string;
      opencodePort: number | null;
      apiPrefix: string;
      cliAvailable: boolean;
    };
  }
}

export const resolveGitApiBaseOrigin = (): string => {
  if (typeof window === 'undefined') {
    return '';
  }
  const currentOrigin = window.location?.origin || '';
  const desktopOrigin = window.__OPENCHAMBER_DESKTOP_SERVER__?.origin;
  if (desktopOrigin && desktopOrigin !== currentOrigin) {
    const currentHost = (() => {
      try {
        return new URL(currentOrigin).hostname;
      } catch {
        return '';
      }
    })();
    if (currentHost === 'localhost' || currentHost === '127.0.0.1' || currentHost === '::1') {
      return currentOrigin;
    }
  }
  if (desktopOrigin) {
    return desktopOrigin;
  }
  return currentOrigin;
};

const API_BASE = '/api/git';
const GIT_STATUS_CACHE_TTL_MS = 1200;
const GIT_REPO_CHECK_CACHE_TTL_MS = 5000;

const gitStatusCache = new Map<string, { value: GitStatus; expiresAt: number }>();
const gitStatusInFlight = new Map<string, Promise<GitStatus>>();
const gitRepoCache = new Map<string, { value: boolean; expiresAt: number }>();
const gitRepoInFlight = new Map<string, Promise<boolean>>();

const normalizeDirectoryKey = (directory: string): string => directory.trim();

const invalidateGitStatusCache = (directory: string): void => {
  const key = normalizeDirectoryKey(directory);
  gitStatusCache.delete(key);
  gitStatusCache.delete(`${key}::light`);
  gitStatusInFlight.delete(key);
  gitStatusInFlight.delete(`${key}::light`);
};

function buildUrl(
  path: string,
  directory: string | null | undefined,
  params?: Record<string, string | number | boolean | undefined>
): string {
  const url = new URL(path, resolveGitApiBaseOrigin());
  if (directory) {
    url.searchParams.set('directory', directory);
  }

  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
  }

  return url.toString();
}

export async function checkIsGitRepository(directory: string): Promise<boolean> {
  const key = normalizeDirectoryKey(directory);
  const now = Date.now();
  const cached = gitRepoCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const inFlight = gitRepoInFlight.get(key);
  if (inFlight) {
    return inFlight;
  }

  const task = (async () => {
    const response = await fetch(buildUrl(`${API_BASE}/check`, directory));
    if (!response.ok) {
      throw new Error(`Failed to check git repository: ${response.statusText}`);
    }
    const data = await response.json();
    const isGitRepository = Boolean(data.isGitRepository);
    gitRepoCache.set(key, {
      value: isGitRepository,
      expiresAt: Date.now() + GIT_REPO_CHECK_CACHE_TTL_MS,
    });
    return isGitRepository;
  })();

  gitRepoInFlight.set(key, task);
  try {
    return await task;
  } finally {
    if (gitRepoInFlight.get(key) === task) {
      gitRepoInFlight.delete(key);
    }
  }
}

export async function getGitStatus(directory: string, options?: { mode?: 'light' }): Promise<GitStatus> {
  const mode = options?.mode;
  const key = mode === 'light' ? `${normalizeDirectoryKey(directory)}::light` : normalizeDirectoryKey(directory);
  const now = Date.now();
  const cached = gitStatusCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const inFlight = gitStatusInFlight.get(key);
  if (inFlight) {
    return inFlight;
  }

  const task = (async () => {
    const response = await fetch(buildUrl(`${API_BASE}/status`, directory, mode ? { mode } : undefined));
    if (!response.ok) {
      throw new Error(`Failed to get git status: ${response.statusText}`);
    }
    const payload = await response.json() as GitStatus;
    gitStatusCache.set(key, {
      value: payload,
      expiresAt: Date.now() + GIT_STATUS_CACHE_TTL_MS,
    });
    return payload;
  })();

  gitStatusInFlight.set(key, task);
  try {
    return await task;
  } finally {
    if (gitStatusInFlight.get(key) === task) {
      gitStatusInFlight.delete(key);
    }
  }
}

export async function getGitDiff(directory: string, options: GetGitDiffOptions): Promise<GitDiffResponse> {
  const { path, staged, contextLines } = options;
  if (!path) {
    throw new Error('path is required to fetch git diff');
  }

  const response = await fetch(
    buildUrl(`${API_BASE}/diff`, directory, {
      path,
      staged: staged ? 'true' : undefined,
      context: contextLines,
    })
  );

  if (!response.ok) {
    throw new Error(`Failed to get git diff: ${response.statusText}`);
  }

  return response.json();
}

export async function getGitFileDiff(directory: string, options: GetGitFileDiffOptions): Promise<GitFileDiffResponse> {
  const { path, staged } = options;
  if (!path) {
    throw new Error('path is required to fetch git file diff');
  }

  const response = await fetch(
    buildUrl(`${API_BASE}/file-diff`, directory, {
      path,
      staged: staged ? 'true' : undefined,
    })
  );

  if (!response.ok) {
    throw new Error(`Failed to get git file diff: ${response.statusText}`);
  }

  return response.json();
}

export async function revertGitFile(directory: string, filePath: string): Promise<void> {
  if (!filePath) {
    throw new Error('path is required to revert git changes');
  }

  const response = await fetch(buildUrl(`${API_BASE}/revert`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath }),
  });

  if (!response.ok) {
    const message = await response
      .json()
      .catch(() => ({ error: response.statusText }));
    throw new Error(message.error || 'Failed to revert git changes');
  }
}

async function postGitFileAction(
  endpoint: string,
  directory: string,
  filePath: string,
  actionLabel: string
): Promise<void> {
  if (!filePath) {
    throw new Error(`path is required to ${actionLabel} git changes`);
  }

  const response = await fetch(buildUrl(`${API_BASE}/${endpoint}`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath }),
  });

  if (!response.ok) {
    const message = await response
      .json()
      .catch(() => ({ error: response.statusText }));
    throw new Error(message.error || `Failed to ${actionLabel} git changes`);
  }
}

export async function stageGitFile(directory: string, filePath: string): Promise<void> {
  return postGitFileAction('stage', directory, filePath, 'stage');
}

export async function unstageGitFile(directory: string, filePath: string): Promise<void> {
  return postGitFileAction('unstage', directory, filePath, 'unstage');
}

export async function stageGitHunk(directory: string, filePath: string, patch: string): Promise<void> {
  await applyGitHunk(directory, filePath, patch, 'stage');
}

export async function unstageGitHunk(directory: string, filePath: string, patch: string): Promise<void> {
  await applyGitHunk(directory, filePath, patch, 'unstage');
}

export async function revertGitHunk(directory: string, filePath: string, patch: string): Promise<void> {
  await applyGitHunk(directory, filePath, patch, 'discard');
}

async function applyGitHunk(
  directory: string,
  filePath: string,
  patch: string,
  action: 'stage' | 'unstage' | 'discard',
): Promise<void> {
  if (!filePath) {
    throw new Error('path is required to apply a git hunk');
  }
  if (typeof patch !== 'string' || !patch.trim()) {
    throw new Error('patch is required to apply a git hunk');
  }

  const response = await fetch(buildUrl(`${API_BASE}/apply-hunk`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath, patch, action }),
  });

  if (!response.ok) {
    const message = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(message.error || 'Failed to apply git hunk');
  }
}

export async function isLinkedWorktree(directory: string): Promise<boolean> {
  if (!directory) {
    return false;
  }
  const response = await fetch(buildUrl(`${API_BASE}/worktree-type`, directory));
  if (!response.ok) {
    throw new Error(`Failed to detect worktree type: ${response.statusText}`);
  }
  const data = await response.json();
  return Boolean(data.linked);
}

export async function getGitBranches(directory: string): Promise<GitBranch> {
  const response = await fetch(buildUrl(`${API_BASE}/branches`, directory));
  if (!response.ok) {
    throw new Error(`Failed to get branches: ${response.statusText}`);
  }
  return response.json();
}

export async function deleteGitBranch(directory: string, payload: GitDeleteBranchPayload): Promise<{ success: boolean }> {
  if (!payload?.branch) {
    throw new Error('branch is required to delete a branch');
  }

  const response = await fetch(buildUrl(`${API_BASE}/branches`, directory), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to delete branch');
  }

  return response.json();
}

export async function deleteRemoteBranch(directory: string, payload: GitDeleteRemoteBranchPayload): Promise<{ success: boolean }> {
  if (!payload?.branch) {
    throw new Error('branch is required to delete remote branch');
  }

  const response = await fetch(buildUrl(`${API_BASE}/remote-branches`, directory), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to delete remote branch');
  }

  return response.json();
}

export async function removeRemote(directory: string, payload: GitRemoveRemotePayload): Promise<{ success: boolean }> {
  const remote = payload?.remote?.trim();
  if (!remote) {
    throw new Error('remote is required to remove a remote');
  }

  const response = await fetch(buildUrl(`${API_BASE}/remotes`, directory), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ remote }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to remove remote');
  }

  return response.json();
}

export async function generateCommitMessage(
  directory: string,
  request: GenerateGitCommitMessageRequest,
): Promise<GeneratedCommitMessage> {
  if (!request?.context || !Array.isArray(request.context.selectedFiles) || request.context.selectedFiles.length === 0) {
    throw new Error('No worktree context provided to generate commit message');
  }

  const response = await fetch(buildUrl(`${API_BASE}/commit-message`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    console.error('[git-generation][browser] http error', {
      status: response.status,
      statusText: response.statusText,
      error,
    });
    const traceSuffix = typeof error?.traceId === 'string' && error.traceId
      ? ` (traceId: ${error.traceId})`
      : '';
    throw new Error(`${error.error || 'Failed to generate commit message'}${traceSuffix}`);
  }

  const data = await response.json();

  if (!data?.message || typeof data.message !== 'object') {
    throw new Error('Malformed commit generation response');
  }

  const subject =
    typeof data.message.subject === 'string' && data.message.subject.trim().length > 0
      ? data.message.subject.trim()
      : '';

  const highlights: string[] = Array.isArray(data.message.highlights)
    ? (data.message.highlights as unknown[])
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map((item) => (item as string).trim())
    : [];

  return { subject, highlights };
}

export async function generatePullRequestDescription(
  directory: string,
  payload: { base: string; head: string; context?: string; zenModel?: string; providerId?: string; modelId?: string }
): Promise<{ title: string; body: string }> {
  const { base, head, context, zenModel, providerId, modelId } = payload;
  if (!base || !head) {
    throw new Error('base and head are required');
  }

  const requestBody: { base: string; head: string; context?: string; zenModel?: string; providerId?: string; modelId?: string } = { base, head };
  if (context?.trim()) {
    requestBody.context = context.trim();
  }
  if (zenModel) {
    requestBody.zenModel = zenModel;
  }
  if (providerId) {
    requestBody.providerId = providerId;
  }
  if (modelId) {
    requestBody.modelId = modelId;
  }

  const response = await fetch(buildUrl(`${API_BASE}/pr-description`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to generate PR description');
  }

  const data = await response.json().catch(() => null);
  const title = typeof data?.title === 'string' ? data.title : '';
  const body = typeof data?.body === 'string' ? data.body : '';
  if (!title && !body) {
    throw new Error('Malformed PR description response');
  }
  return { title, body };
}

export async function listGitWorktrees(directory: string): Promise<GitWorktreeInfo[]> {
  const response = await fetch(buildUrl(`${API_BASE}/worktrees`, directory));
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to list worktrees');
  }
  return response.json();
}

export async function getPrimaryWorktreeRoot(directory: string): Promise<string> {
  const response = await fetch(buildUrl(`${API_BASE}/worktree-root`, directory));
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to resolve primary worktree root');
  }

  const data = await response.json().catch(() => null) as { root?: unknown } | null;
  const root = typeof data?.root === 'string' ? data.root.trim() : '';
  if (!root) {
    throw new Error('Malformed primary worktree root response');
  }
  return root;
}

export async function validateGitWorktree(directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeValidationResult> {
  const response = await fetch(buildUrl(`${API_BASE}/worktrees/validate`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to validate worktree');
  }

  return response.json();
}

export async function getGitWorktreeBootstrapStatus(directory: string): Promise<import('./api/types').GitWorktreeBootstrapStatus> {
  const response = await fetch(buildUrl(`${API_BASE}/worktrees/bootstrap-status`, directory));
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to get worktree bootstrap status');
  }
  return response.json();
}

export async function previewGitWorktree(directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeCreateResult> {
  const response = await fetch(buildUrl(`${API_BASE}/worktrees/preview`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to preview worktree');
  }

  return response.json();
}

export async function createGitWorktree(directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeCreateResult> {
  const response = await fetch(buildUrl(`${API_BASE}/worktrees`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to create worktree');
  }

  return response.json();
}

export async function deleteGitWorktree(directory: string, payload: RemoveGitWorktreePayload): Promise<{ success: boolean }> {
  const response = await fetch(buildUrl(`${API_BASE}/worktrees`, directory), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to delete worktree');
  }

  return response.json();
}

export async function createGitCommit(
  directory: string,
  message: string,
  options: CreateGitCommitOptions = {}
): Promise<GitCommitResult> {
  const response = await fetch(buildUrl(`${API_BASE}/commit`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      addAll: options.addAll ?? false,
      files: options.files,
      amend: options.amend ?? false,
      stagedOnly: options.stagedOnly ?? false,
    }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to create commit');
  }
  invalidateGitStatusCache(directory);
  return response.json();
}

export async function gitPush(
  directory: string,
  options: { remote?: string; branch?: string; options?: string[] | Record<string, unknown> } = {}
): Promise<GitPushResult> {
  const response = await fetch(buildUrl(`${API_BASE}/push`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to push');
  }
  invalidateGitStatusCache(directory);
  return response.json();
}

export async function gitPull(
  directory: string,
  options: GitPullOptions = {}
): Promise<GitPullResult> {
  const response = await fetch(buildUrl(`${API_BASE}/pull`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to pull');
  }
  invalidateGitStatusCache(directory);
  return response.json();
}

export async function gitFetch(
  directory: string,
  options: { remote?: string; branch?: string } = {}
): Promise<{ success: boolean }> {
  const response = await fetch(buildUrl(`${API_BASE}/fetch`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to fetch');
  }
  invalidateGitStatusCache(directory);
  return response.json();
}

export async function listGitStashes(directory: string): Promise<{ stashes: GitStashEntry[] }> {
  const response = await fetch(buildUrl(`${API_BASE}/stashes`, directory));
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to list stashes');
  }
  return response.json();
}

export async function countGitStashFiles(directory: string, refs: string[]): Promise<{ counts: Record<string, number> }> {
  const response = await fetch(buildUrl(`${API_BASE}/stashes/file-counts`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refs }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to count stash files');
  }
  return response.json();
}

export async function stashGitChanges(directory: string, options: { message?: string } = {}): Promise<{ success: boolean; created: boolean; message: string; output: string }> {
  const response = await fetch(buildUrl(`${API_BASE}/stash`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to stash changes');
  }
  return response.json();
}

const postStashRef = async (directory: string, path: string, options: { ref: string }): Promise<{ success: boolean; ref: string }> => {
  const response = await fetch(buildUrl(`${API_BASE}/${path}`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || `Failed to ${path}`);
  }
  return response.json();
};

export const applyGitStash = (directory: string, options: { ref: string }) => postStashRef(directory, 'stash/apply', options);
export const popGitStash = (directory: string, options: { ref: string }) => postStashRef(directory, 'stash/pop', options);
export const dropGitStash = (directory: string, options: { ref: string }) => postStashRef(directory, 'stash/drop', options);

export async function checkoutBranch(directory: string, branch: string): Promise<{ success: boolean; branch: string }> {
  const response = await fetch(buildUrl(`${API_BASE}/checkout`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ branch }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to checkout branch');
  }
  return response.json();
}

export async function createBranch(
  directory: string,
  name: string,
  startPoint?: string
): Promise<{ success: boolean; branch: string }> {
  const response = await fetch(buildUrl(`${API_BASE}/branches`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, startPoint }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to create branch');
  }
  return response.json();
}

export async function renameBranch(
  directory: string,
  oldName: string,
  newName: string
): Promise<{ success: boolean; branch: string }> {
  const response = await fetch(buildUrl(`${API_BASE}/branches/rename`, directory), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oldName, newName }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to rename branch');
  }
  return response.json();
}

export async function getGitLog(
  directory: string,
  options: GitLogOptions = {}
): Promise<GitLogResponse> {
  const response = await fetch(
    buildUrl(`${API_BASE}/log`, directory, {
      maxCount: options.maxCount,
      from: options.from,
      to: options.to,
      file: options.file,
    })
  );
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || `Failed to get git log: ${response.statusText}`);
  }
  return response.json();
}

export async function getCommitFiles(
  directory: string,
  hash: string
): Promise<GitCommitFilesResponse> {
  const response = await fetch(
    buildUrl(`${API_BASE}/commit-files`, directory, { hash })
  );
  if (!response.ok) {
    throw new Error(`Failed to get commit files: ${response.statusText}`);
  }
  return response.json();
}

export async function getGitIdentities(): Promise<GitIdentityProfile[]> {
  const response = await fetch(buildUrl(`${API_BASE}/identities`, undefined));
  if (!response.ok) {
    throw new Error(`Failed to get git identities: ${response.statusText}`);
  }
  return response.json();
}

export async function createGitIdentity(profile: GitIdentityProfile): Promise<GitIdentityProfile> {
  const response = await fetch(buildUrl(`${API_BASE}/identities`, undefined), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(profile),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to create git identity');
  }
  return response.json();
}

export async function updateGitIdentity(id: string, updates: GitIdentityProfile): Promise<GitIdentityProfile> {
  const response = await fetch(buildUrl(`${API_BASE}/identities/${id}`, undefined), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to update git identity');
  }
  return response.json();
}

export async function deleteGitIdentity(id: string): Promise<void> {
  const response = await fetch(buildUrl(`${API_BASE}/identities/${id}`, undefined), {
    method: 'DELETE',
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to delete git identity');
  }
}

export async function getCurrentGitIdentity(directory: string): Promise<GitIdentitySummary | null> {
  if (!directory) {
    return null;
  }
  const response = await fetch(buildUrl(`${API_BASE}/current-identity`, directory));
  if (!response.ok) {
    throw new Error(`Failed to get current git identity: ${response.statusText}`);
  }
  const data = await response.json();
  if (!data) {
    return null;
  }
  return {
    userName: data.userName ?? null,
    userEmail: data.userEmail ?? null,
    sshCommand: data.sshCommand ?? null,
  };
}

export async function hasLocalIdentity(directory: string): Promise<boolean> {
  if (!directory) {
    return false;
  }
  const response = await fetch(buildUrl(`${API_BASE}/has-local-identity`, directory));
  if (!response.ok) {
    throw new Error(`Failed to check local identity: ${response.statusText}`);
  }
  const data = await response.json().catch(() => null);
  return data?.hasLocalIdentity === true;
}

export async function getGlobalGitIdentity(): Promise<GitIdentitySummary | null> {
  const response = await fetch(buildUrl(`${API_BASE}/global-identity`, undefined));
  if (!response.ok) {
    throw new Error(`Failed to get global git identity: ${response.statusText}`);
  }
  const data = await response.json();
  if (!data || (!data.userName && !data.userEmail)) {
    return null;
  }
  return {
    userName: data.userName ?? null,
    userEmail: data.userEmail ?? null,
    sshCommand: data.sshCommand ?? null,
  };
}

export async function setGitIdentity(
  directory: string,
  profileId: string
): Promise<{ success: boolean; profile: GitIdentityProfile }> {
  const response = await fetch(buildUrl(`${API_BASE}/set-identity`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to set git identity');
  }
  return response.json();
}

export async function discoverGitCredentials(): Promise<DiscoveredGitCredential[]> {
  const response = await fetch(buildUrl(`${API_BASE}/discover-credentials`, undefined));
  if (!response.ok) {
    throw new Error(`Failed to discover git credentials: ${response.statusText}`);
  }
  return response.json();
}

export async function getRemoteUrl(directory: string, remote?: string): Promise<string | null> {
  if (!directory) {
    return null;
  }
  const response = await fetch(buildUrl(`${API_BASE}/remote-url`, directory, { remote }));
  if (!response.ok) {
    return null;
  }
  const data = await response.json();
  return data.url ?? null;
}

export async function getRemotes(directory: string): Promise<Array<{ name: string; fetchUrl: string; pushUrl: string }>> {
  const response = await fetch(buildUrl(`${API_BASE}/remotes`, directory));
  if (!response.ok) {
    throw new Error(`Failed to get remotes: ${response.statusText}`);
  }
  return response.json();
}

export async function rebase(
  directory: string,
  options: { onto: string }
): Promise<{ success: boolean; conflict?: boolean; conflictFiles?: string[] }> {
  const response = await fetch(buildUrl(`${API_BASE}/rebase`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to rebase');
  }
  return response.json();
}

export async function abortRebase(directory: string): Promise<{ success: boolean }> {
  const response = await fetch(buildUrl(`${API_BASE}/rebase/abort`, directory), {
    method: 'POST',
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to abort rebase');
  }
  return response.json();
}

export async function merge(
  directory: string,
  options: { branch: string }
): Promise<{ success: boolean; conflict?: boolean; conflictFiles?: string[] }> {
  const response = await fetch(buildUrl(`${API_BASE}/merge`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to merge');
  }
  return response.json();
}

export async function abortMerge(directory: string): Promise<{ success: boolean }> {
  const response = await fetch(buildUrl(`${API_BASE}/merge/abort`, directory), {
    method: 'POST',
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to abort merge');
  }
  return response.json();
}

export async function continueRebase(directory: string): Promise<{ success: boolean; conflict: boolean; conflictFiles?: string[] }> {
  const response = await fetch(buildUrl(`${API_BASE}/rebase/continue`, directory), {
    method: 'POST',
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to continue rebase');
  }
  return response.json();
}

export async function continueMerge(directory: string): Promise<{ success: boolean; conflict: boolean; conflictFiles?: string[] }> {
  const response = await fetch(buildUrl(`${API_BASE}/merge/continue`, directory), {
    method: 'POST',
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to continue merge');
  }
  return response.json();
}

export async function stash(
  directory: string,
  options?: { message?: string; includeUntracked?: boolean }
): Promise<{ success: boolean }> {
  await stashGitChanges(directory, { message: options?.message });
  return { success: true };
}

export async function stashPop(directory: string): Promise<{ success: boolean }> {
  await popGitStash(directory, { ref: 'stash@{0}' });
  return { success: true };
}

export async function getConflictDetails(directory: string): Promise<MergeConflictDetails> {
  const response = await fetch(buildUrl(`${API_BASE}/conflict-details`, directory));
  if (!response.ok) {
    throw new Error(`Failed to get conflict details: ${response.statusText}`);
  }
  return response.json();
}

export async function validateWorktreeDirectory(
  directory: string,
  worktreeRoot: string
): Promise<{
  valid: boolean;
  insideWorktreeRoot: boolean;
  resolvedWorktreeRoot: string | null;
  resolvedCwd: string | null;
}> {
  const response = await fetch(`${API_BASE}/validate-directory`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ directory, worktreeRoot }),
  });
  if (!response.ok) {
    throw new Error(`Failed to validate worktree directory: ${response.statusText}`);
  }
  return response.json();
}

export async function canonicalizeWorktreeState(
  directory: string
): Promise<{
  worktreeRoot: string | null;
  cwd: string | null;
  branch: string | null;
  headState: 'branch' | 'detached' | 'unborn';
  worktreeStatus: 'ready' | 'missing' | 'invalid' | 'not-a-repo';
  legacy: boolean;
  degraded: boolean;
  attentionReason?: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | null;
}> {
  const response = await fetch(`${API_BASE}/canonicalize-worktree-state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ directory }),
  });
  if (!response.ok) {
    throw new Error(`Failed to canonicalize worktree state: ${response.statusText}`);
  }
  return response.json();
}


// ---- Conventional commit template (deterministic, no AI) ----

export interface CommitTemplateStatus {
  installed: boolean;
  templatePath: string;
  hookPath: string;
  hooksDir: string;
  templatePresent: boolean;
  hookPresent: boolean;
  templateMatches: boolean;
  hookMatches: boolean;
  templateConfigured: boolean;
  hooksPathConfigured: boolean;
  currentTemplate: string;
  currentHooksPath: string;
}

export async function getCommitTemplateStatus(): Promise<CommitTemplateStatus> {
  const response = await fetch(buildUrl(`${API_BASE}/commit-template/status`, null));
  if (!response.ok) {
    const detail = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(detail.error || "Failed to read commit template status");
  }
  return response.json();
}

export async function installCommitTemplate(): Promise<{ success: boolean; templatePath: string; hookPath: string; hooksDir: string }> {
  const response = await fetch(buildUrl(`${API_BASE}/commit-template/install`, null), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(detail.error || "Failed to install commit template");
  }
  return response.json();
}

export async function uninstallCommitTemplate(): Promise<{ success: boolean }> {
  const response = await fetch(buildUrl(`${API_BASE}/commit-template/uninstall`, null), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(detail.error || "Failed to uninstall commit template");
  }
  return response.json();
}

export async function getCommitTemplateContent(): Promise<{ templatePath: string; content: string; fromDisk: boolean }> {
  const response = await fetch(buildUrl(`${API_BASE}/commit-template/content`, null));
  if (!response.ok) {
    const detail = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(detail.error || "Failed to fetch commit template");
  }
  return response.json();
}
