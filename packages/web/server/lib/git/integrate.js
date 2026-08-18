import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { runGitCommand, runGitCommandOrThrow } from './service.js';
import { getRequestPrincipal } from '../multi-user/request-context.js';

export const INTEGRATE_TMP_PREFIX = 'devryan-integrate-';
const INTEGRATE_OPERATION_TTL_MS = 24 * 60 * 60 * 1000;
const INTEGRATE_OPERATION_LIMIT = 100;
const activeIntegrations = new Map();

const integrateTempPrefixPath = () => path.join(os.tmpdir(), INTEGRATE_TMP_PREFIX);

export const isIntegrateTempPath = (value) => {
  const input = typeof value === 'string' ? value.trim() : '';
  if (!input) return false;
  const resolved = path.resolve(input);
  const prefix = integrateTempPrefixPath();
  if (resolved.startsWith(prefix)) return true;
  const base = path.basename(resolved);
  if (!base.startsWith(INTEGRATE_TMP_PREFIX)) return false;
  const tmpDir = path.resolve(os.tmpdir());
  if (resolved === tmpDir || resolved.startsWith(`${tmpDir}${path.sep}`)) return true;
  if (tmpDir.startsWith(`${path.sep}var${path.sep}`)) {
    const privateTmp = `${path.sep}private${tmpDir}`;
    if (resolved === privateTmp || resolved.startsWith(`${privateTmp}${path.sep}`)) return true;
  }
  return false;
};

const currentOwnerId = () => {
  const principal = getRequestPrincipal();
  return principal?.scope === 'managed' && typeof principal.id === 'string'
    ? principal.id
    : null;
};

const pruneIntegrations = () => {
  const cutoff = Date.now() - INTEGRATE_OPERATION_TTL_MS;
  for (const [operationId, entry] of activeIntegrations) {
    if (entry.updatedAt < cutoff) {
      activeIntegrations.delete(operationId);
      void removeTempWorktree(entry.state.repoRoot, entry.state.tempWorktreePath).catch(() => {});
    }
  }
  while (activeIntegrations.size > INTEGRATE_OPERATION_LIMIT) {
    const oldest = activeIntegrations.keys().next().value;
    if (!oldest) break;
    const entry = activeIntegrations.get(oldest);
    activeIntegrations.delete(oldest);
    if (entry) void removeTempWorktree(entry.state.repoRoot, entry.state.tempWorktreePath).catch(() => {});
  }
};

const rememberIntegration = (state) => {
  pruneIntegrations();
  const operationId = state.operationId || crypto.randomUUID();
  const next = { ...state, operationId };
  activeIntegrations.delete(operationId);
  activeIntegrations.set(operationId, {
    state: next,
    ownerId: currentOwnerId(),
    updatedAt: Date.now(),
  });
  pruneIntegrations();
  return next;
};

const lines = (value) => String(value || '')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);

const assertBranchName = async (repoRoot, branch, label) => {
  const normalized = String(branch || '').trim();
  if (!normalized || normalized === 'HEAD') {
    throw Object.assign(new Error(`${label} branch is required`), { statusCode: 400 });
  }
  const result = await runGitCommand(repoRoot, ['check-ref-format', '--branch', normalized]);
  if (!result.success) {
    throw Object.assign(new Error(`Invalid ${label.toLowerCase()} branch name`), { statusCode: 400 });
  }
  return normalized;
};

const ensureLocalBranch = async (repoRoot, branch) => {
  const local = await runGitCommand(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
  if (local.success) return branch;

  const remote = await runGitCommand(repoRoot, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);
  if (remote.success) {
    await runGitCommandOrThrow(
      repoRoot,
      ['branch', '--track', branch, `origin/${branch}`],
      `Failed to create local tracking branch ${branch}`,
    );
  }
  return branch;
};

const listWorktrees = async (repoRoot) => {
  const result = await runGitCommandOrThrow(
    repoRoot,
    ['worktree', 'list', '--porcelain'],
    'Failed to list Git worktrees',
  );
  const entries = [];
  let current = null;
  for (const line of String(result.stdout || '').split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = { path: line.slice('worktree '.length).trim(), branchRef: null };
    } else if (current && line.startsWith('branch ')) {
      current.branchRef = line.slice('branch '.length).trim();
    }
  }
  if (current) entries.push(current);
  return entries;
};

const cleanTargetWorktrees = async (repoRoot, targetBranch, excludedPaths) => {
  const excluded = new Set(excludedPaths.map((value) => path.resolve(value)));
  const candidates = (await listWorktrees(repoRoot))
    .filter((entry) => entry.branchRef === `refs/heads/${targetBranch}`)
    .map((entry) => entry.path)
    .filter((entryPath) => entryPath && !excluded.has(path.resolve(entryPath)));
  const clean = [];
  for (const candidate of candidates) {
    const status = await runGitCommand(candidate, ['status', '--porcelain']);
    if (status.success && !String(status.stdout || '').trim()) clean.push(candidate);
  }
  return clean;
};

const syncCleanTargetWorktrees = async (worktrees) => {
  for (const worktree of worktrees) {
    await runGitCommand(worktree, ['reset', '--hard']);
  }
};

const removeTempWorktree = async (repoRoot, tempWorktreePath) => {
  await runGitCommand(repoRoot, ['worktree', 'remove', '--force', tempWorktreePath]);
  await runGitCommand(repoRoot, ['worktree', 'prune']);
  await fs.rm(tempWorktreePath, { recursive: true, force: true }).catch(() => {});
};

const collectConflictDetails = async (tempWorktreePath) => {
  const [status, unmerged, diff, meta, patch] = await Promise.all([
    runGitCommand(tempWorktreePath, ['status', '--porcelain']),
    runGitCommand(tempWorktreePath, ['diff', '--name-only', '--diff-filter=U']),
    runGitCommand(tempWorktreePath, ['diff']),
    runGitCommand(tempWorktreePath, ['show', '--no-patch', '--pretty=fuller', 'CHERRY_PICK_HEAD']),
    runGitCommand(tempWorktreePath, ['show', 'CHERRY_PICK_HEAD']),
  ]);
  return {
    statusPorcelain: status.stdout || '',
    unmergedFiles: lines(unmerged.stdout),
    diff: diff.stdout || diff.stderr || '',
    currentPatchMeta: meta.stdout || meta.stderr || '',
    currentPatch: patch.stdout || patch.stderr || '',
  };
};

const assertIntegrationState = (repoRoot, state) => {
  pruneIntegrations();
  const operationId = typeof state?.operationId === 'string' ? state.operationId.trim() : '';
  const entry = operationId ? activeIntegrations.get(operationId) : null;
  const remembered = entry?.state || null;
  const tempWorktreePath = typeof remembered?.tempWorktreePath === 'string'
    ? remembered.tempWorktreePath.trim()
    : '';
  if (!remembered || !tempWorktreePath || !isIntegrateTempPath(tempWorktreePath)) {
    throw Object.assign(new Error('Invalid integration state'), { statusCode: 400 });
  }
  if (entry.ownerId !== currentOwnerId()) {
    throw Object.assign(new Error('Integration state belongs to another account'), { statusCode: 403 });
  }
  if (path.resolve(remembered.repoRoot || '') !== path.resolve(repoRoot)) {
    throw Object.assign(new Error('Integration state does not match this repository'), { statusCode: 400 });
  }
  return { ...remembered, repoRoot, tempWorktreePath };
};

export async function computeIntegratePlan(repoRoot, input) {
  const sourceBranch = await assertBranchName(repoRoot, input?.sourceBranch, 'Source');
  const requestedTarget = await assertBranchName(repoRoot, input?.targetBranch, 'Target');
  if (sourceBranch === requestedTarget) {
    return { repoRoot, sourceBranch, targetBranch: requestedTarget, commits: [] };
  }
  const targetBranch = await ensureLocalBranch(repoRoot, requestedTarget);
  const cherry = await runGitCommandOrThrow(
    repoRoot,
    ['cherry', targetBranch, sourceBranch],
    'Failed to compare source and target branches',
  );
  const unique = new Set(lines(cherry.stdout)
    .map((line) => line.match(/^\+\s+([0-9a-f]{7,40})\b/i)?.[1])
    .filter(Boolean));
  const ordered = await runGitCommandOrThrow(
    repoRoot,
    ['rev-list', '--reverse', `${targetBranch}..${sourceBranch}`],
    'Failed to list commits for integration',
  );
  return {
    repoRoot,
    sourceBranch,
    targetBranch,
    commits: lines(ordered.stdout).filter((sha) => unique.has(sha)),
  };
}

export async function integrateCommits(repoRoot, input) {
  const plan = await computeIntegratePlan(repoRoot, input);
  if (plan.commits.length === 0) return { kind: 'noop', reason: 'No commits to move' };

  const tempWorktreePath = await fs.mkdtemp(path.join(os.tmpdir(), INTEGRATE_TMP_PREFIX));
  try {
    await runGitCommandOrThrow(
      repoRoot,
      ['worktree', 'add', '--force', tempWorktreePath, plan.targetBranch],
      'Failed to create integration worktree',
    );
    const upstream = await runGitCommand(tempWorktreePath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    const upstreamRef = String(upstream.stdout || '').trim();
    if (upstream.success && upstreamRef) {
      await runGitCommandOrThrow(tempWorktreePath, ['fetch'], 'Failed to fetch target branch');
      await runGitCommandOrThrow(tempWorktreePath, ['merge', '--ff-only', upstreamRef], 'Target branch could not be fast-forwarded');
    }
    const status = await runGitCommandOrThrow(tempWorktreePath, ['status', '--porcelain'], 'Failed to inspect target branch');
    if (String(status.stdout || '').trim()) throw new Error('Target branch has local changes; abort integration and retry');

    const cleanWorktrees = await cleanTargetWorktrees(repoRoot, plan.targetBranch, [tempWorktreePath]).catch(() => []);
    const remaining = [...plan.commits];
    while (remaining.length > 0) {
      const currentCommit = remaining[0];
      const picked = await runGitCommand(tempWorktreePath, ['cherry-pick', currentCommit]);
      if (picked.success) {
        remaining.shift();
        continue;
      }
      const details = await collectConflictDetails(tempWorktreePath);
      if (details.unmergedFiles.length > 0) {
        return {
          kind: 'conflict',
          state: rememberIntegration({
            repoRoot,
            tempWorktreePath,
            sourceBranch: plan.sourceBranch,
            targetBranch: plan.targetBranch,
            cleanTargetWorktrees: cleanWorktrees,
            remainingCommits: remaining,
            currentCommit,
          }),
          details,
        };
      }
      throw new Error(picked.message || 'Cherry-pick failed');
    }
    await removeTempWorktree(repoRoot, tempWorktreePath);
    await syncCleanTargetWorktrees(cleanWorktrees);
    return { kind: 'success', moved: plan.commits.length };
  } catch (error) {
    await removeTempWorktree(repoRoot, tempWorktreePath).catch(() => {});
    throw error;
  }
}

export async function isIntegrateInProgress(repoRoot, inputState) {
  const state = assertIntegrationState(repoRoot, inputState);
  const result = await runGitCommand(state.tempWorktreePath, ['rev-parse', '--verify', '--quiet', 'CHERRY_PICK_HEAD']);
  if (!result.success) activeIntegrations.delete(state.operationId);
  return result.success;
}

export async function getIntegrateConflictDetails(repoRoot, inputState) {
  const state = assertIntegrationState(repoRoot, inputState);
  return collectConflictDetails(state.tempWorktreePath);
}

export async function abortIntegrate(repoRoot, inputState) {
  const state = assertIntegrationState(repoRoot, inputState);
  await runGitCommand(state.tempWorktreePath, ['cherry-pick', '--abort']);
  await removeTempWorktree(repoRoot, state.tempWorktreePath);
  activeIntegrations.delete(state.operationId);
  return { success: true };
}

export async function continueIntegrate(repoRoot, inputState) {
  const state = assertIntegrationState(repoRoot, inputState);
  const continued = await runGitCommand(state.tempWorktreePath, ['cherry-pick', '--continue']);
  if (!continued.success) {
    const details = await collectConflictDetails(state.tempWorktreePath);
    if (details.unmergedFiles.length > 0) return { kind: 'conflict', state, details };
    throw new Error(continued.message || 'Cherry-pick continue failed');
  }

  const remaining = [...state.remainingCommits];
  if (remaining[0] === state.currentCommit) remaining.shift();
  while (remaining.length > 0) {
    const currentCommit = remaining[0];
    const picked = await runGitCommand(state.tempWorktreePath, ['cherry-pick', currentCommit]);
    if (picked.success) {
      remaining.shift();
      continue;
    }
    const details = await collectConflictDetails(state.tempWorktreePath);
    if (details.unmergedFiles.length > 0) {
      return {
        kind: 'conflict',
        state: rememberIntegration({ ...state, remainingCommits: remaining, currentCommit }),
        details,
      };
    }
    throw new Error(picked.message || 'Cherry-pick failed');
  }
  await removeTempWorktree(repoRoot, state.tempWorktreePath);
  await syncCleanTargetWorktrees(state.cleanTargetWorktrees || []);
  activeIntegrations.delete(state.operationId);
  return { kind: 'success', moved: state.remainingCommits.length };
}
