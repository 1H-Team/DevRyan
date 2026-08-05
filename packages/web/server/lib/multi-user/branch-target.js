import path from 'node:path';

import {
  createWorktree,
  getBranches,
  getStatus,
  getWorktrees,
} from '../git/service.js';

export const normalizeLogicalBranchName = (value) => String(value || '')
  .trim()
  .replace(/^refs\/heads\//, '')
  .replace(/^heads\//, '')
  .replace(/^refs\/remotes\/[^/]+\//, '')
  .replace(/^remotes\/[^/]+\//, '');

const parseRemoteRef = (value) => {
  const match = String(value || '').trim().match(/^(?:refs\/)?remotes\/([^/]+)\/(.+)$/);
  if (!match || match[2] === 'HEAD') return null;
  return { remote: match[1], branch: match[2], ref: `remotes/${match[1]}/${match[2]}` };
};

export function buildBranchOptions(inventory = {}) {
  const byName = new Map();
  const ensure = (rawName) => {
    const name = normalizeLogicalBranchName(rawName);
    if (!name || name === 'HEAD') return null;
    const current = byName.get(name) || { name, local: false, remoteRefs: [], preferredRef: name };
    byName.set(name, current);
    return current;
  };

  for (const ref of Array.isArray(inventory.all) ? inventory.all : []) {
    const remote = parseRemoteRef(ref);
    const option = ensure(ref);
    if (!option) continue;
    if (remote) {
      if (!option.remoteRefs.includes(remote.ref)) option.remoteRefs.push(remote.ref);
    } else {
      option.local = true;
    }
  }

  for (const [rawName, details] of Object.entries(inventory.branches || {})) {
    const option = ensure(rawName);
    if (!option) continue;
    const remote = parseRemoteRef(rawName);
    if (remote) {
      if (!option.remoteRefs.includes(remote.ref)) option.remoteRefs.push(remote.ref);
      continue;
    }
    option.local = true;
    const tracking = parseRemoteRef(details?.tracking);
    if (tracking && normalizeLogicalBranchName(tracking.branch) === option.name) {
      if (!option.remoteRefs.includes(tracking.ref)) option.remoteRefs.push(tracking.ref);
      option.preferredRemoteRef = tracking.ref;
    }
  }

  return [...byName.values()]
    .map((option) => {
      const remoteRefs = [...option.remoteRefs].sort((left, right) => left.localeCompare(right));
      const origin = remoteRefs.find((ref) => ref === `remotes/origin/${option.name}`);
      return {
        name: option.name,
        local: option.local,
        remoteRefs,
        preferredRef: option.local
          ? option.name
          : (option.preferredRemoteRef || origin || remoteRefs[0] || option.name),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

const canonicalPath = (value) => path.resolve(String(value || ''));

export async function ensureBranchTarget({
  repositoryPath,
  branchName,
  idempotencyKey,
  ownerId,
  git = { createWorktree, getBranches, getStatus, getWorktrees },
}) {
  const logicalBranchName = normalizeLogicalBranchName(branchName);
  if (!repositoryPath || !logicalBranchName || !idempotencyKey) {
    return { status: 'failure', message: 'Project, branch, and idempotency key are required' };
  }

  const [inventory, worktrees] = await Promise.all([
    git.getBranches(repositoryPath),
    git.getWorktrees(repositoryPath),
  ]);
  const option = buildBranchOptions(inventory).find((entry) => entry.name === logicalBranchName);
  if (!option) {
    return { status: 'unavailable', branchName: logicalBranchName, message: `Branch is unavailable: ${logicalBranchName}` };
  }

  const rootPath = canonicalPath(repositoryPath);
  const linkedWorktree = (worktrees || []).find((worktree) => (
    canonicalPath(worktree.path) !== rootPath
    && normalizeLogicalBranchName(worktree.branch) === logicalBranchName
  ));
  if (linkedWorktree) {
    return {
      status: 'success',
      source: 'worktree',
      branchName: logicalBranchName,
      directory: linkedWorktree.path,
    };
  }

  const rootStatus = await git.getStatus(repositoryPath, { mode: 'light' });
  if (normalizeLogicalBranchName(rootStatus?.current) === logicalBranchName) {
    return {
      status: 'success',
      source: 'root',
      branchName: logicalBranchName,
      directory: repositoryPath,
    };
  }

  const preferredRemote = parseRemoteRef(option.preferredRef);
  const created = await git.createWorktree(repositoryPath, {
    mode: 'existing',
    existingBranch: option.preferredRef,
    branchName: logicalBranchName,
    worktreeName: logicalBranchName,
    idempotencyKey,
    ownerId,
    ...(preferredRemote ? {
      setUpstream: true,
      upstreamRemote: preferredRemote.remote,
      upstreamBranch: preferredRemote.branch,
    } : {}),
  });
  const bootstrapStatus = String(created?.bootstrap?.status || '').toLowerCase();
  return {
    status: ['queued', 'pending', 'running'].includes(bootstrapStatus) ? 'pending' : 'success',
    source: 'created',
    branchName: logicalBranchName,
    directory: created.path,
    operationId: created.operationId || null,
    bootstrap: created.bootstrap || null,
  };
}
