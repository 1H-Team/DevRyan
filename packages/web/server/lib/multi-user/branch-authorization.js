import path from 'node:path';

import { normalizeLogicalBranchName } from './branch-target.js';
import { getRequestPrincipal } from './request-context.js';

const containsPath = (rootValue, candidateValue) => {
  if (typeof rootValue !== 'string' || !rootValue.trim()) return false;
  const root = path.resolve(rootValue);
  const candidate = path.resolve(candidateValue);
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

export function getManagedBranchAuthorization(directory) {
  const principal = getRequestPrincipal();
  if (principal?.scope !== 'managed' || principal.role === 'admin') {
    return { principal, managed: false, assignments: [] };
  }

  const candidate = typeof directory === 'string' && directory.trim()
    ? directory.trim()
    : '';
  if (!candidate) {
    return { principal, managed: true, assignments: [] };
  }

  const matching = (principal.assignments || []).filter((entry) => (
    containsPath(entry.repositoryPath, candidate)
    || containsPath(entry.worktreeContainerPath, candidate)
  ));
  if (matching.length === 0) {
    return { principal, managed: true, assignments: [] };
  }

  const projectId = matching[0]?.projectId;
  const assignments = (principal.assignments || []).filter((entry) => (
    projectId && entry.projectId === projectId
  ));
  return { principal, managed: true, assignments };
}

export function isManagedBranchAssigned(directory, branch) {
  const authorization = getManagedBranchAuthorization(directory);
  if (!authorization.managed) return true;
  const logicalBranch = normalizeLogicalBranchName(branch);
  if (!logicalBranch) return false;
  return authorization.assignments.some((entry) => (
    normalizeLogicalBranchName(entry.branchName) === logicalBranch
  ));
}

export function requireManagedAssignedBranch(directory, branch, message = 'Branch is not assigned to this account') {
  const authorization = getManagedBranchAuthorization(directory);
  if (!authorization.managed) return null;
  if (!isManagedBranchAssigned(directory, branch)) {
    const error = new Error(message);
    error.statusCode = 403;
    error.code = 'BRANCH_NOT_ASSIGNED';
    throw error;
  }
  return authorization.assignments.find((entry) => (
    normalizeLogicalBranchName(entry.branchName) === normalizeLogicalBranchName(branch)
  )) || null;
}
