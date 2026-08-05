import fs from 'node:fs/promises';
import path from 'node:path';

export const isPathContained = (root, candidate) => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

export const resolveAssignmentForValue = (principal, value, { allowInternal = true } = {}) => {
  const input = typeof value === 'string' ? value.trim() : '';
  if (!input) return null;
  const assignments = principal?.assignments || [];
  return assignments.find((entry) => (
    input === entry.publicDirectory
    || input.startsWith(`${entry.publicDirectory}/`)
    || (allowInternal && (
      input === entry.repositoryPath
      || (input.startsWith(`${entry.repositoryPath}${path.sep}`) && isPathContained(entry.repositoryPath, input))
      || input === entry.worktreeContainerPath
      || (entry.worktreeContainerPath
        && input.startsWith(`${entry.worktreeContainerPath}${path.sep}`)
        && isPathContained(entry.worktreeContainerPath, input))
    ))
  )) || null;
};

const resolveCanonicalPathFromNearestExistingAncestor = async (value) => {
  let current = path.resolve(value);
  const missing = [];
  while (true) {
    try {
      const canonicalAncestor = await fs.realpath(current);
      return path.join(canonicalAncestor, ...missing);
    } catch (error) {
      if (error?.code !== 'ENOENT') return null;
      const parent = path.dirname(current);
      if (parent === current) return null;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
};

export const resolveCanonicalManagedPath = async (assignment, candidate) => {
  const lexicalCandidate = path.resolve(candidate);
  const lexicalRoot = [assignment.repositoryPath, assignment.worktreeContainerPath]
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => path.resolve(value))
    .find((root) => isPathContained(root, lexicalCandidate));
  if (!lexicalRoot) return null;
  const canonicalRoot = await resolveCanonicalPathFromNearestExistingAncestor(lexicalRoot);
  if (!canonicalRoot) return null;
  const canonicalCandidate = await resolveCanonicalPathFromNearestExistingAncestor(lexicalCandidate);
  if (!canonicalCandidate) return null;
  return isPathContained(canonicalRoot, canonicalCandidate) ? canonicalCandidate : null;
};

// Administrators retain host-wide path access: any absolute host path passes through,
// canonicalized best-effort against the nearest existing ancestor.
export const resolveAdminPassThroughPath = async (value) => {
  const input = typeof value === 'string' ? value.trim() : '';
  if (!input || !path.isAbsolute(input)) return null;
  return resolveCanonicalPathFromNearestExistingAncestor(input);
};

export const translateDirectoryValue = async (principal, value) => {
  const assignment = resolveAssignmentForValue(principal, value);
  if (!assignment) {
    if (principal?.role === 'admin') return resolveAdminPassThroughPath(value);
    return null;
  }
  const input = String(value);
  let candidate;
  if (input === assignment.publicDirectory) {
    candidate = assignment.repositoryPath;
  } else if (input.startsWith(`${assignment.publicDirectory}/`)) {
    candidate = path.resolve(
      assignment.repositoryPath,
      input.slice(assignment.publicDirectory.length + 1).split('/').join(path.sep),
    );
  } else if (path.isAbsolute(input) && (
    isPathContained(assignment.repositoryPath, input)
    || (assignment.worktreeContainerPath && isPathContained(assignment.worktreeContainerPath, input))
  )) {
    candidate = input;
  } else {
    return null;
  }

  const translated = await resolveCanonicalManagedPath(assignment, candidate);
  if (translated) return translated;
  if (principal?.role === 'admin') return resolveAdminPassThroughPath(candidate);
  return null;
};

// The OpenCode SDK percent-encodes scoped directory headers. Preserve raw
// paths first so a legitimate directory containing percent sequences is not
// reinterpreted, then accept exactly one decoded form through the same
// canonical containment checks.
export const translateDirectoryHeaderValue = async (principal, value) => {
  const input = typeof value === 'string' ? value : '';
  if (!input) return null;

  const rawTranslation = await translateDirectoryValue(principal, input);
  if (rawTranslation) return rawTranslation;

  let decoded;
  try {
    decoded = decodeURIComponent(input);
  } catch {
    return null;
  }
  if (decoded === input) return null;
  return translateDirectoryValue(principal, decoded);
};

export const publicizeValue = (principal, value) => {
  if (typeof value === 'string') {
    for (const assignment of principal?.assignments || []) {
      if (value === assignment.repositoryPath) return assignment.publicDirectory;
      if (value.startsWith(`${assignment.repositoryPath}${path.sep}`)) {
        return `${assignment.publicDirectory}/${value.slice(assignment.repositoryPath.length + 1).split(path.sep).join('/')}`;
      }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => publicizeValue(principal, entry));
  if (value && typeof value === 'object') {
    const next = {};
    for (const [key, entry] of Object.entries(value)) {
      if (['repositoryPath', 'worktreeContainerPath'].includes(key)) continue;
      next[key] = publicizeValue(principal, entry);
    }
    return next;
  }
  return value;
};
