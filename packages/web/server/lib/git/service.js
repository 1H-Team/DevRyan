import simpleGit from 'simple-git';
import crypto from 'node:crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createRequire } from 'module';

import {
  createPostCheckoutHookRunner,
  createWorktreeBootstrapRuntime,
} from '@openchamber/harness-runtime';
import { populateWorktreeWithLockRecovery } from './worktree-lock-recovery.js';
import { withIndexLockRetry, withIndexLockRetryResult } from './index-lock-retry.js';
import { getRequestPrincipal } from '../multi-user/request-context.js';
import { getGitHubAuthById } from '../github/auth.js';

const fsp = fs.promises;
const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const gpgconfCandidates = ['gpgconf', '/opt/homebrew/bin/gpgconf', '/usr/local/bin/gpgconf'];
let resolvedGitBinary = null;
let worktreeBootstrapRuntime = null;
let worktreeBootstrapInitialization = null;
let gitAskPassHelperPromise = null;

const isExecutableFile = (candidate) => {
  if (typeof candidate !== 'string' || candidate.trim().length === 0) {
    return false;
  }
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) {
      return false;
    }
    if (process.platform === 'win32') {
      const ext = path.extname(candidate).toLowerCase();
      return ext.length === 0 || ext === '.exe' || ext === '.cmd' || ext === '.bat' || ext === '.com';
    }
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const normalizeGitExecutableCandidate = (candidate) => {
  if (typeof candidate !== 'string') {
    return null;
  }
  const trimmed = candidate.trim();
  if (!trimmed) {
    return null;
  }

  const ext = path.extname(trimmed).toLowerCase();
  if (ext === '.cmd' || ext === '.bat' || ext === '.com') {
    const exeCandidate = trimmed.slice(0, -ext.length) + '.exe';
    if (isExecutableFile(exeCandidate)) {
      return exeCandidate;
    }
  }

  return trimmed;
};

const listPathExecutableCandidates = (binaryName) => {
  const currentPath = process.env.PATH || '';
  const seen = new Set();
  const matches = [];
  for (const segment of currentPath.split(path.delimiter)) {
    const dir = typeof segment === 'string' ? segment.trim() : '';
    if (!dir || seen.has(dir)) {
      continue;
    }
    seen.add(dir);
    matches.push(path.join(dir, binaryName));
  }
  return matches;
};

const listWindowsGitInstallCandidates = () => {
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LocalAppData,
  ]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);

  const candidates = [];
  for (const root of roots) {
    candidates.push(path.join(root, 'Git', 'cmd', 'git.exe'));
    candidates.push(path.join(root, 'Git', 'bin', 'git.exe'));
    candidates.push(path.join(root, 'Git', 'mingw64', 'bin', 'git.exe'));
    candidates.push(path.join(root, 'Programs', 'Git', 'cmd', 'git.exe'));
    candidates.push(path.join(root, 'Programs', 'Git', 'bin', 'git.exe'));
  }
  return candidates;
};

const resolveGitBinary = () => {
  if (process.platform !== 'win32') {
    return 'git';
  }
  if (resolvedGitBinary) {
    return resolvedGitBinary;
  }

  const explicit = [process.env.GIT_BINARY, process.env.OPENCHAMBER_GIT_BINARY]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);
  for (const candidate of explicit) {
    if (isExecutableFile(candidate)) {
      resolvedGitBinary = candidate;
      return resolvedGitBinary;
    }
  }

  const discovered = [
    ...listPathExecutableCandidates('git.exe'),
    ...listPathExecutableCandidates('git'),
    ...listWindowsGitInstallCandidates(),
  ]
    .map(normalizeGitExecutableCandidate)
    .filter(Boolean)
    .filter((candidate) => isExecutableFile(candidate));

  const preferredExe = discovered.find((candidate) => candidate.toLowerCase().endsWith('.exe'));
  resolvedGitBinary = preferredExe || discovered[0] || 'git.exe';
  return resolvedGitBinary;
};

const getGitBinary = () => resolveGitBinary();

/**
 * Escape an SSH key path for use in core.sshCommand.
 * Handles Windows/Unix differences and prevents command injection.
 */
function escapeSshKeyPath(sshKeyPath) {
  const isWindows = process.platform === 'win32';
  
  // Normalize path first on Windows (convert backslashes to forward slashes)
  let normalizedPath = sshKeyPath;
  if (isWindows) {
    normalizedPath = sshKeyPath.replace(/\\/g, '/');
  }
  
  // Validate: reject paths with characters that could enable injection
  // Allow only alphanumeric, path separators, dots, dashes, underscores, spaces, and colons (for Windows drives)
  // Note: backslash is not in this list since we've already normalized Windows paths
  const dangerousChars = /[`$!"';&|<>(){}[\]*?#~]/;
  if (dangerousChars.test(normalizedPath)) {
    throw new Error(`SSH key path contains invalid characters: ${sshKeyPath}`);
  }

  if (isWindows) {
    // On Windows, Git (via MSYS/MinGW) expects Unix-style paths
    // Convert "C:/path" to "/c/path" for MSYS compatibility
    let unixPath = normalizedPath;
    const driveMatch = unixPath.match(/^([A-Za-z]):\//);
    if (driveMatch) {
      unixPath = `/${driveMatch[1].toLowerCase()}${unixPath.slice(2)}`;
    }
    
    // Use single quotes for the path (prevents shell interpretation)
    return `'${unixPath}'`;
  } else {
    // On Unix, use single quotes and escape any single quotes in the path
    // Single quotes prevent all shell interpretation except for single quotes themselves
    const escaped = normalizedPath.replace(/'/g, "'\\''");
    return `'${escaped}'`;
  }
}

/**
 * Build the SSH command string for git config
 */
function buildSshCommand(sshKeyPath) {
  const escapedPath = escapeSshKeyPath(sshKeyPath);
  return `ssh -i ${escapedPath} -o IdentitiesOnly=yes`;
}

const isSocketPath = async (candidate) => {
  if (!candidate || typeof candidate !== 'string') {
    return false;
  }
  try {
    const stat = await fsp.stat(candidate);
    return typeof stat.isSocket === 'function' && stat.isSocket();
  } catch {
    return false;
  }
};

const resolveSshAuthSock = async () => {
  const existing = (process.env.SSH_AUTH_SOCK || '').trim();
  if (existing) {
    return existing;
  }

  if (process.platform === 'win32') {
    return null;
  }

  const gpgSock = path.join(os.homedir(), '.gnupg', 'S.gpg-agent.ssh');
  if (await isSocketPath(gpgSock)) {
    return gpgSock;
  }

  const runGpgconf = async (args) => {
    for (const candidate of gpgconfCandidates) {
      try {
        const { stdout } = await execFileAsync(candidate, args);
        return String(stdout || '');
      } catch {
        continue;
      }
    }
    return '';
  };

  const candidate = (await runGpgconf(['--list-dirs', 'agent-ssh-socket'])).trim();
  if (candidate && await isSocketPath(candidate)) {
    return candidate;
  }

  if (candidate) {
    await runGpgconf(['--launch', 'gpg-agent']);
    const retried = (await runGpgconf(['--list-dirs', 'agent-ssh-socket'])).trim();
    if (retried && await isSocketPath(retried)) {
      return retried;
    }
  }

  return null;
};

const resolveManagedGitAssignment = (directory) => {
  const principal = getRequestPrincipal();
  if (principal?.scope !== 'managed') return { principal: null, assignment: null };
  const directoryPath = normalizeDirectoryPath(directory);
  const assignment = principal.assignments?.find((entry) => {
    if (!directoryPath) return false;
    const candidate = path.resolve(directoryPath);
    return [entry.repositoryPath, entry.worktreeContainerPath]
      .filter((value) => typeof value === 'string' && value.trim())
      .some((value) => {
        const root = path.resolve(value);
        const relative = path.relative(root, candidate);
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
      });
  }) || null;
  return { principal, assignment };
};

const assertBranchCreationAllowed = () => {
  const principal = getRequestPrincipal();
  if (principal?.scope === 'managed' && principal.policy?.createBranches !== true) {
    const error = new Error('Branch creation is disabled by policy');
    error.statusCode = 403;
    error.code = 'BRANCH_CREATION_DISABLED';
    throw error;
  }
};

const assertManagedMutationBranch = async (directory) => {
  const { principal, assignment } = resolveManagedGitAssignment(directory);
  if (!principal) return null;
  if (!assignment) throw new Error('Directory is not assigned to this user');
  return assignment;
};

const validateManagedSourceRef = async (directory, value) => {
  const candidate = String(value || '').trim();
  if (!candidate || candidate.startsWith('-') || /[\0-\x20\\]/.test(candidate)) {
    throw new Error('Invalid Git source ref');
  }
  const verified = await runGitCommand(directory, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]);
  if (!verified.success) throw new Error('Git source ref does not exist');
  return candidate;
};

const getCheckedOutBranch = async (git) => {
  const branch = String(await git.raw(['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim();
  if (!branch) throw new Error('Git operation requires a checked-out branch');
  return branch;
};

const normalizeManagedBranchName = (value) => String(value || '')
  .trim()
  .replace(/^refs\/heads\//, '')
  .replace(/^heads\//, '')
  .replace(/^refs\/remotes\/[^/]+\//, '')
  .replace(/^remotes\/[^/]+\//, '');

const normalizeManagedFetchBranch = async (directory, value) => {
  const branch = normalizeManagedBranchName(value);
  if (!branch || branch.startsWith('-')) {
    throw new Error('Invalid Git branch for fetch');
  }
  const valid = await runGitCommand(directory, ['check-ref-format', `refs/heads/${branch}`]);
  if (!valid.success) {
    throw new Error('Invalid Git branch for fetch');
  }
  return branch;
};

const managedAssignmentsShareProject = (left, right) => {
  if (left?.projectId && right?.projectId) return left.projectId === right.projectId;
  if (!left?.repositoryPath || !right?.repositoryPath) return false;
  return path.resolve(left.repositoryPath) === path.resolve(right.repositoryPath);
};

const assertManagedFetchBranchAllowed = async ({ directory, principal, assignment, currentBranch, requestedBranch }) => {
  const branch = requestedBranch
    ? await normalizeManagedFetchBranch(directory, requestedBranch)
    : currentBranch;
  if (branch === currentBranch || principal.role === 'admin') return branch;

  const granted = (principal.assignments || []).some((candidate) => (
    managedAssignmentsShareProject(assignment, candidate)
    && normalizeManagedBranchName(candidate.branchName) === branch
  ));
  if (!granted) {
    throw new Error('Managed workspaces may only fetch the checked-out branch or another assigned branch');
  }
  return branch;
};

const ensureGitAskPassHelper = async () => {
  if (gitAskPassHelperPromise) return gitAskPassHelperPromise;
  gitAskPassHelperPromise = (async () => {
    const dataDirectory = process.env.OPENCHAMBER_DATA_DIR
      ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
      : path.join(os.homedir(), '.config', 'openchamber');
    const runtimeDirectory = path.join(dataDirectory, 'runtime');
    await fsp.mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
    if (process.platform === 'win32') {
      const helperPath = path.join(runtimeDirectory, 'git-askpass.cmd');
      const source = '@echo off\r\necho %* | findstr /I "username" >nul\r\nif not errorlevel 1 (echo x-access-token) else (echo %DEVRYAN_GIT_ASKPASS_TOKEN%)\r\n';
      await fsp.writeFile(helperPath, source, { encoding: 'utf8', mode: 0o700 });
      return helperPath;
    }
    const helperPath = path.join(runtimeDirectory, 'git-askpass');
    const source = '#!/bin/sh\ncase "$1" in\n  *[Uu]sername*) printf "%s\\n" "x-access-token" ;;\n  *) printf "%s\\n" "$DEVRYAN_GIT_ASKPASS_TOKEN" ;;\nesac\n';
    await fsp.writeFile(helperPath, source, { encoding: 'utf8', mode: 0o700 });
    await fsp.chmod(helperPath, 0o700);
    return helperPath;
  })().catch((error) => {
    gitAskPassHelperPromise = null;
    throw error;
  });
  return gitAskPassHelperPromise;
};

export const buildGitEnv = async (
  directory = null,
  { includeCredentials = false, githubAccountId = null, optionalLocks = true } = {},
) => {
  const env = { ...process.env };
  if (optionalLocks === false) {
    env.GIT_OPTIONAL_LOCKS = '0';
  }
  const { principal, assignment } = resolveManagedGitAssignment(directory);
  const selectedAccountId = principal
    ? principal.githubAccountId || null
    : githubAccountId || null;
  const auth = selectedAccountId ? getGitHubAuthById(selectedAccountId) : null;
  if (principal) {
    const authorName = auth?.user?.name || auth?.user?.login || principal.displayName || principal.email;
    const authorEmail = auth?.user?.email
      || (auth?.user?.id && auth?.user?.login
        ? `${auth.user.id}+${auth.user.login}@users.noreply.github.com`
        : principal.email);
    if (authorName) {
      env.GIT_AUTHOR_NAME = authorName;
      env.GIT_COMMITTER_NAME = authorName;
    }
    if (authorEmail) {
      env.GIT_AUTHOR_EMAIL = authorEmail;
      env.GIT_COMMITTER_EMAIL = authorEmail;
    }
  }
  if (includeCredentials && auth?.accessToken) {
    env.GIT_ASKPASS = await ensureGitAskPassHelper();
    env.GIT_TERMINAL_PROMPT = '0';
    env.DEVRYAN_GIT_ASKPASS_TOKEN = auth.accessToken;
  }
  if (!env.SSH_AUTH_SOCK || !env.SSH_AUTH_SOCK.trim()) {
    const resolved = await resolveSshAuthSock();
    if (resolved) {
      env.SSH_AUTH_SOCK = resolved;
    }
  }
  return env;
};

const createGit = async (directory, options = {}) => {
  const directoryPath = normalizeDirectoryPath(directory);
  if (!directoryPath) {
    throw new TypeError('Git directory is required');
  }
  const env = await buildGitEnv(directoryPath, options);
  const spawnOptions = { windowsHide: true };
  const binary = getGitBinary();
  const hasCustomBinary = typeof binary === 'string' && binary.trim() && binary !== 'git' && binary !== 'git.exe';
  const unsafe = hasCustomBinary ? { allowUnsafeCustomBinary: true } : undefined;
  return simpleGit({
    baseDir: directoryPath,
    env,
    spawnOptions,
    binary,
    unsafe,
  });
};

const globalGitDirectory = [os.homedir(), os.tmpdir(), process.cwd()]
  .find((candidate) => candidate && fs.existsSync(candidate));

const createGlobalConfigGit = () => createGit(globalGitDirectory);

const normalizeDirectoryPath = (value) => {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }

  if (trimmed === '~') {
    return os.homedir();
  }

  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }

  return trimmed;
};

const cleanBranchName = (branch) => {
  if (!branch) {
    return branch;
  }
  if (branch.startsWith('refs/heads/')) {
    return branch.substring('refs/heads/'.length);
  }
  if (branch.startsWith('heads/')) {
    return branch.substring('heads/'.length);
  }
  if (branch.startsWith('refs/')) {
    return branch.substring('refs/'.length);
  }
  return branch;
};

const OPENCODE_ADJECTIVES = [
  'brave',
  'calm',
  'clever',
  'cosmic',
  'crisp',
  'curious',
  'eager',
  'gentle',
  'glowing',
  'happy',
  'hidden',
  'jolly',
  'kind',
  'lucky',
  'mighty',
  'misty',
  'neon',
  'nimble',
  'playful',
  'proud',
  'quick',
  'quiet',
  'shiny',
  'silent',
  'stellar',
  'sunny',
  'swift',
  'tidy',
  'witty',
];

const OPENCODE_NOUNS = [
  'cabin',
  'cactus',
  'canyon',
  'circuit',
  'comet',
  'eagle',
  'engine',
  'falcon',
  'forest',
  'garden',
  'harbor',
  'island',
  'knight',
  'lagoon',
  'meadow',
  'moon',
  'mountain',
  'nebula',
  'orchid',
  'otter',
  'panda',
  'pixel',
  'planet',
  'river',
  'rocket',
  'sailor',
  'squid',
  'star',
  'tiger',
  'wizard',
  'wolf',
];

const OPENCODE_WORKTREE_ATTEMPTS = 26;

export const getOpenCodeDataPath = () => {
  const xdgDataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(xdgDataHome, 'opencode');
};

const pickRandom = (values) => values[Math.floor(Math.random() * values.length)];

const generateOpenCodeRandomName = () => `${pickRandom(OPENCODE_ADJECTIVES)}-${pickRandom(OPENCODE_NOUNS)}`;

const slugWorktreeName = (value) => {
  return String(value || '')
    .trim()
    .replace(/^refs\/heads\//, '')
    .replace(/^heads\//, '')
    .replace(/\s+/g, '-')
    .replace(/^\/+|\/+$/g, '')
    .split('/').join('-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 80);
};

const parseWorktreePorcelain = (raw) => {
  const lines = String(raw || '').split('\n').map((line) => line.trim());
  const entries = [];
  let current = null;

  for (const line of lines) {
    if (!line) {
      if (current?.worktree) {
        entries.push(current);
      }
      current = null;
      continue;
    }

    if (line.startsWith('worktree ')) {
      if (current?.worktree) {
        entries.push(current);
      }
      current = { worktree: line.substring('worktree '.length).trim() };
      continue;
    }

    if (!current) {
      continue;
    }

    if (line.startsWith('HEAD ')) {
      current.head = line.substring('HEAD '.length).trim();
      continue;
    }

    if (line.startsWith('branch ')) {
      const branchRef = line.substring('branch '.length).trim();
      current.branchRef = branchRef;
      current.branch = cleanBranchName(branchRef);
    }
  }

  if (current?.worktree) {
    entries.push(current);
  }

  return entries;
};

const canonicalPath = async (input) => {
  const absolutePath = path.resolve(input);
  const realPath = await fsp.realpath(absolutePath).catch(() => absolutePath);
  const normalized = path.normalize(realPath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

// True when `child` is the same directory as `parent` or nested inside it.
// Inputs are expected to be canonicalized (see canonicalPath) so the path.relative
// comparison is reliable across symlinks/casing.
export const isInsideOrSameDirectory = (parent, child) => {
  if (typeof parent !== 'string' || typeof child !== 'string' || !parent || !child) {
    return false;
  }
  if (parent === child) {
    return true;
  }
  const relative = path.relative(parent, child);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
};

const checkPathExists = async (targetPath) => {
  try {
    await fsp.stat(targetPath);
    return true;
  } catch {
    return false;
  }
};

const normalizeStartRef = (value) => {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return 'HEAD';
  }
  return trimmed;
};

const parseRemoteBranchRef = (value) => {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith('refs/remotes/')) {
    const rest = trimmed.substring('refs/remotes/'.length);
    const slashIndex = rest.indexOf('/');
    if (slashIndex <= 0 || slashIndex === rest.length - 1) {
      return null;
    }
    return {
      remote: rest.slice(0, slashIndex),
      branch: rest.slice(slashIndex + 1),
      remoteRef: rest,
      fullRef: `refs/remotes/${rest}`,
    };
  }

  if (trimmed.startsWith('remotes/')) {
    return parseRemoteBranchRef(`refs/${trimmed}`);
  }

  const slashIndex = trimmed.indexOf('/');
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
    return null;
  }

  return {
    remote: trimmed.slice(0, slashIndex),
    branch: trimmed.slice(slashIndex + 1),
    remoteRef: trimmed,
    fullRef: `refs/remotes/${trimmed}`,
  };
};

const resolveRemoteBranchRef = async (primaryWorktree, value) => {
  const raw = String(value || '').trim();
  const parsed = parseRemoteBranchRef(raw);
  if (!parsed) {
    return null;
  }

  if (raw.startsWith('refs/remotes/') || raw.startsWith('remotes/')) {
    return parsed;
  }

  const localRef = `refs/heads/${raw}`;
  const localExists = await runGitCommand(primaryWorktree, ['show-ref', '--verify', '--quiet', localRef]);
  if (localExists.success) {
    return null;
  }

  return parsed;
};

const normalizeUpstreamTarget = (remote, branch) => {
  const remoteName = String(remote || '').trim();
  const branchName = String(branch || '').trim();
  if (!remoteName || !branchName) {
    return null;
  }
  return {
    remote: remoteName,
    branch: branchName,
    full: `${remoteName}/${branchName}`,
  };
};

const parseGitErrorText = (error) => {
  const stderr = typeof error?.stderr === 'string' ? error.stderr : '';
  const stdout = typeof error?.stdout === 'string' ? error.stdout : '';
  const message = typeof error?.message === 'string' ? error.message : '';
  return [stderr, stdout, message]
    .map((chunk) => String(chunk || '').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
};

const GIT_CONFLICT_PATTERN = /conflict|could not apply|automatic merge failed|needs merge|could not write index|unmerged|you have unmerged files|middle of a merge|fix conflicts/i;
const GIT_DIVERGENCE_PATTERN = /not possible to fast-forward|cannot fast-forward|divergent branches|branches have diverged/i;

const isGitConflictError = (error) => GIT_CONFLICT_PATTERN.test(parseGitErrorText(error));

const readConflictResult = async (git) => {
  const status = await git.status().catch(() => ({ conflicted: [] }));
  return {
    success: false,
    conflict: true,
    conflictFiles: status.conflicted || [],
  };
};

const createGitOperationError = (message, code, statusCode, conflictFiles = []) => Object.assign(
  new Error(message),
  { code, statusCode, conflictFiles },
);

const isNotGitRepositoryError = (error) => {
  const text = parseGitErrorText(error);
  return /not a git repository/i.test(text);
};

export const isMissingDirectoryError = (error, directory) => {
  const directoryPath = normalizeDirectoryPath(directory);
  if (directoryPath && !fs.existsSync(directoryPath)) {
    return true;
  }

  const text = parseGitErrorText(error);
  return error?.code === 'ENOENT'
    || /cannot (?:change to|chdir to).*no such file or directory/i.test(text)
    || /no such file or directory.*(?:working directory|cwd)/i.test(text);
};

export const runGitCommand = async (cwd, args, options = {}) => withIndexLockRetryResult(async () => {
  try {
    const { stdout, stderr } = await execFileAsync(getGitBinary(), args, {
      cwd,
      env: await buildGitEnv(cwd, options),
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
    });
    return {
      success: true,
      exitCode: 0,
      stdout: String(stdout || ''),
      stderr: String(stderr || ''),
    };
  } catch (error) {
    return {
      success: false,
      exitCode: typeof error?.code === 'number' ? error.code : 1,
      stdout: String(error?.stdout || ''),
      stderr: String(error?.stderr || ''),
      message: parseGitErrorText(error),
    };
  }
});

export const runGitCommandOrThrow = async (cwd, args, fallbackMessage, options = {}) => {
  const result = await runGitCommand(cwd, args, options);
  if (!result.success) {
    throw new Error(result.message || fallbackMessage || 'Git command failed');
  }
  return result;
};

export const ensureOpenCodeProjectId = async (primaryWorktree) => {
  const gitDir = path.join(primaryWorktree, '.git');
  const idFile = path.join(gitDir, 'opencode');
  const existing = await fsp.readFile(idFile, 'utf8').then((value) => value.trim()).catch(() => '');
  if (existing) {
    return existing;
  }

  const rootsResult = await runGitCommandOrThrow(
    primaryWorktree,
    ['rev-list', '--max-parents=0', '--all'],
    'Failed to resolve repository roots'
  );

  const roots = rootsResult.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  const projectId = roots[0] || '';
  if (!projectId) {
    throw new Error('Failed to derive OpenCode project ID');
  }

  await fsp.mkdir(gitDir, { recursive: true }).catch(() => undefined);
  await fsp.writeFile(idFile, projectId, 'utf8').catch(() => undefined);

  return projectId;
};

const resolveWorktreeProjectContext = async (directory) => {
  const directoryPath = normalizeDirectoryPath(directory);
  if (!directoryPath) {
    throw new Error('Directory is required');
  }

  const topResult = await runGitCommandOrThrow(
    directoryPath,
    ['rev-parse', '--show-toplevel'],
    'Failed to resolve git top-level directory'
  );
  const sandbox = path.resolve(directoryPath, topResult.stdout.trim());

  const commonResult = await runGitCommandOrThrow(
    sandbox,
    ['rev-parse', '--git-common-dir'],
    'Failed to resolve git common directory'
  );
  const commonDir = path.resolve(sandbox, commonResult.stdout.trim());
  const primaryWorktree = path.dirname(commonDir);
  const projectID = await ensureOpenCodeProjectId(primaryWorktree);
  const worktreeRoot = path.join(getOpenCodeDataPath(), 'worktree', projectID);

  return {
    projectID,
    sandbox,
    primaryWorktree,
    worktreeRoot,
  };
};

const listWorktreeEntries = async (directory) => {
  const rawResult = await runGitCommandOrThrow(
    directory,
    ['worktree', 'list', '--porcelain'],
    'Failed to list git worktrees'
  );
  return parseWorktreePorcelain(rawResult.stdout);
};

const resolveWorktreeNameCandidates = (baseName) => {
  const normalizedBase = slugWorktreeName(baseName || '');
  if (!normalizedBase) {
    return Array.from({ length: OPENCODE_WORKTREE_ATTEMPTS }, () => generateOpenCodeRandomName());
  }
  return Array.from({ length: OPENCODE_WORKTREE_ATTEMPTS }, (_, index) => {
    if (index === 0) {
      return normalizedBase;
    }
    return `${normalizedBase}-${generateOpenCodeRandomName()}`;
  });
};

const resolveCandidateDirectory = async (worktreeRoot, preferredName, explicitBranchName, primaryWorktree) => {
  const candidates = resolveWorktreeNameCandidates(preferredName);

  for (const name of candidates) {
    const directory = path.join(worktreeRoot, name);
    if (await checkPathExists(directory)) {
      continue;
    }

    if (explicitBranchName) {
      return { name, directory, branch: explicitBranchName };
    }

    const branch = `openchamber/${name}`;
    const branchRef = `refs/heads/${branch}`;
    const branchExists = await runGitCommand(primaryWorktree, ['show-ref', '--verify', '--quiet', branchRef]);
    if (branchExists.success) {
      continue;
    }

    return { name, directory, branch };
  }

  throw new Error('Failed to generate a unique worktree name');
};

const resolveBranchForExistingMode = async (primaryWorktree, existingBranch, preferredBranchName) => {
  const requested = String(existingBranch || '').trim();
  if (!requested) {
    throw new Error('existingBranch is required in existing mode');
  }

  const normalizedLocal = cleanBranchName(requested);
  const localRef = `refs/heads/${normalizedLocal}`;
  const localExists = await runGitCommand(primaryWorktree, ['show-ref', '--verify', '--quiet', localRef]);
  if (localExists.success) {
    return {
      localBranch: normalizedLocal,
      checkoutRef: normalizedLocal,
      createLocalBranch: false,
      remoteRef: null,
    };
  }

  const remoteRef = parseRemoteBranchRef(requested);
  if (!remoteRef) {
    throw new Error(`Branch not found: ${requested}`);
  }

  const remoteExists = await runGitCommand(primaryWorktree, ['show-ref', '--verify', '--quiet', remoteRef.fullRef]);
  if (!remoteExists.success) {
    await fetchRemoteBranchRef(primaryWorktree, remoteRef.remote, remoteRef.branch).catch(() => undefined);
    const recheck = await runGitCommand(primaryWorktree, ['show-ref', '--verify', '--quiet', remoteRef.fullRef]);
    if (!recheck.success) {
      throw new Error(`Remote branch not found: ${requested}`);
    }
  }

  const localBranch = cleanBranchName(preferredBranchName || remoteRef.branch || requested);
  if (!localBranch) {
    throw new Error('Failed to resolve local branch name for existing branch worktree');
  }

  return {
    localBranch,
    checkoutRef: remoteRef.remoteRef,
    createLocalBranch: true,
    remoteRef,
  };
};

const findBranchInUse = async (primaryWorktree, localBranchName) => {
  if (!localBranchName) {
    return null;
  }
  const entries = await listWorktreeEntries(primaryWorktree);
  const targetRef = `refs/heads/${localBranchName}`;
  const targetClean = cleanBranchName(targetRef);
  return entries.find((entry) => {
    const entryRef = String(entry.branchRef || '').trim();
    const entryClean = cleanBranchName(entryRef || entry.branch || '');
    return entryRef === targetRef || entryClean === targetClean;
  }) || null;
};

const runWorktreeStartCommand = async (directory, command) => {
  const text = String(command || '').trim();
  if (!text) {
    return { success: true };
  }

  if (process.platform === 'win32') {
    const result = await execFileAsync('cmd', ['/c', text], {
      cwd: directory,
      env: await buildGitEnv(),
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
    }).then(({ stdout, stderr }) => ({ success: true, stdout, stderr })).catch((error) => ({
      success: false,
      stdout: error?.stdout,
      stderr: error?.stderr,
      message: parseGitErrorText(error),
    }));
    return result;
  }

  const result = await execFileAsync('bash', ['-lc', text], {
    cwd: directory,
    env: await buildGitEnv(),
    maxBuffer: 20 * 1024 * 1024,
  }).then(({ stdout, stderr }) => ({ success: true, stdout, stderr })).catch((error) => ({
    success: false,
    stdout: error?.stdout,
    stderr: error?.stderr,
    message: parseGitErrorText(error),
  }));
  return result;
};

const loadProjectStartCommand = async (projectID) => {
  const storagePath = path.join(getOpenCodeDataPath(), 'storage', 'project', `${projectID}.json`);
  try {
    const raw = await fsp.readFile(storagePath, 'utf8');
    const parsed = JSON.parse(raw);
    const start = typeof parsed?.commands?.start === 'string' ? parsed.commands.start.trim() : '';
    return start || '';
  } catch {
    return '';
  }
};

const getProjectStoragePath = (projectID) => {
  return path.join(getOpenCodeDataPath(), 'storage', 'project', `${projectID}.json`);
};

const syncSandboxesToOpenCodeDb = (projectID, sandboxes) => {
  try {
    const Database = require('better-sqlite3');
    const dbPath = path.join(getOpenCodeDataPath(), 'opencode.db');
    if (!fs.existsSync(dbPath)) return;
    const db = new Database(dbPath);
    try {
      const row = db.prepare('SELECT sandboxes FROM project WHERE id = ?').get(projectID);
      if (!row) return;
      const json = JSON.stringify(sandboxes);
      db.prepare('UPDATE project SET sandboxes = ?, time_updated = ? WHERE id = ?').run(json, Date.now(), projectID);
    } finally {
      db.close();
    }
  } catch (error) {
    console.warn('Failed to sync sandboxes to OpenCode DB:', error instanceof Error ? error.message : String(error));
  }
};

const updateProjectSandboxes = async (projectID, primaryWorktree, updater) => {
  const storagePath = getProjectStoragePath(projectID);
  await fsp.mkdir(path.dirname(storagePath), { recursive: true });

  const now = Date.now();
  const base = {
    id: projectID,
    worktree: primaryWorktree,
    vcs: 'git',
    sandboxes: [],
    time: {
      created: now,
      updated: now,
    },
  };

  const parsed = await fsp.readFile(storagePath, 'utf8').then((raw) => JSON.parse(raw)).catch(() => null);
  const current = parsed && typeof parsed === 'object' ? { ...base, ...parsed } : base;
  current.id = String(current.id || projectID);
  current.worktree = String(current.worktree || primaryWorktree);
  current.vcs = current.vcs || 'git';
  current.sandboxes = Array.isArray(current.sandboxes)
    ? current.sandboxes.map((entry) => String(entry || '').trim()).filter(Boolean)
    : [];
  const createdAt = Number(current?.time?.created);
  current.time = {
    created: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : now,
    updated: now,
  };

  updater(current);

  current.sandboxes = [...new Set(
    (Array.isArray(current.sandboxes) ? current.sandboxes : [])
      .map((entry) => String(entry || '').trim())
      .filter(Boolean)
  )];

  await fsp.writeFile(storagePath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');

  // Sync to OpenCode's SQLite database so project.sandboxes is visible via the SDK
  syncSandboxesToOpenCodeDb(projectID, current.sandboxes);
};

const syncProjectSandboxAdd = async (projectID, primaryWorktree, sandboxPath) => {
  const sandbox = String(sandboxPath || '').trim();
  if (!sandbox) {
    return;
  }
  await updateProjectSandboxes(projectID, primaryWorktree, (project) => {
    if (!project.sandboxes.includes(sandbox)) {
      project.sandboxes.push(sandbox);
    }
  });
};

const syncProjectSandboxRemove = async (projectID, primaryWorktree, sandboxPath) => {
  const sandbox = String(sandboxPath || '').trim();
  if (!sandbox) {
    return;
  }
  await updateProjectSandboxes(projectID, primaryWorktree, (project) => {
    project.sandboxes = project.sandboxes.filter((entry) => entry !== sandbox);
  });
};

const setupFailureMessage = (result, fallback) => (
  String(result?.message || result?.stderr || result?.stdout || fallback).trim()
);

const requireWorktreeBootstrapRuntime = async () => {
  if (!worktreeBootstrapRuntime || !worktreeBootstrapInitialization) {
    throw new Error('Worktree bootstrap runtime is not configured');
  }
  await worktreeBootstrapInitialization;
  return worktreeBootstrapRuntime;
};

export const configureWorktreeBootstrapRuntime = (options = {}) => {
  if (!options.store) {
    throw new TypeError('Worktree bootstrap record store is required');
  }
  const postCheckoutHookRunner = createPostCheckoutHookRunner({
    getGitBinary,
    getEnv: (directory) => buildGitEnv(directory),
  });
  worktreeBootstrapRuntime = createWorktreeBootstrapRuntime({
    store: options.store,
    onTransition: options.onTransition,
    effects: {
      worktreeExists: async (directory) => {
        try {
          const stat = await fsp.stat(directory);
          return stat.isDirectory();
        } catch {
          return false;
        }
      },
      prepare_remote: async (receipt) => {
        const metadata = receipt.metadata || {};
        if (metadata.ensureRemoteName && metadata.ensureRemoteUrl) {
          await ensureRemoteWithUrl(
            metadata.primaryWorktree,
            metadata.ensureRemoteName,
            metadata.ensureRemoteUrl,
          );
        }
        if (metadata.fetchRemote && metadata.fetchBranch) {
          await fetchRemoteBranchRef(
            metadata.primaryWorktree,
            metadata.fetchRemote,
            metadata.fetchBranch,
            metadata.githubAccountId || null,
            metadata.fetchRemoteUrl || '',
          );
        }
      },
      create_worktree: async (receipt) => {
        const metadata = receipt.metadata || {};
        const existing = await runGitCommand(receipt.directory, ['rev-parse', '--is-inside-work-tree']);
        if (existing.success) return;
        if (!Array.isArray(metadata.worktreeAddArgs) || !metadata.primaryWorktree) {
          throw new Error('Worktree creation metadata is incomplete');
        }
        await runGitCommandOrThrow(
          metadata.primaryWorktree,
          metadata.worktreeAddArgs,
          'Failed to create git worktree',
        );
      },
      sync_project_metadata: async (receipt) => {
        const metadata = receipt.metadata || {};
        await syncProjectSandboxAdd(
          metadata.projectID,
          metadata.primaryWorktree,
          receipt.directory,
        );
      },
      populate_worktree: async (receipt) => {
        const head = await runGitCommand(receipt.directory, ['rev-parse', '--verify', 'HEAD']);
        const status = await runGitCommand(
          receipt.directory,
          ['status', '--porcelain'],
          { optionalLocks: false },
        );
        if (head.success && status.success) {
          const index = await runGitCommand(receipt.directory, ['ls-files', '--stage']);
          // `worktree add --no-checkout` creates a valid HEAD but leaves the
          // index empty. Any indexed tree means checkout already happened, so
          // a replay must preserve the current files and local edits.
          if (!index.success || String(index.stdout || '').trim()) return;
        }
        await populateWorktreeWithLockRecovery(receipt.directory, { runGitCommandOrThrow });
      },
      run_post_checkout_hook: async (receipt) => postCheckoutHookRunner.run(receipt.directory),
      configure_upstream: async (receipt) => {
        const metadata = receipt.metadata || {};
        if (!metadata.setUpstream) return;
        await applyUpstreamConfiguration({
          primaryWorktree: metadata.primaryWorktree,
          worktreeDirectory: receipt.directory,
          localBranch: metadata.localBranch,
          setUpstream: metadata.setUpstream,
          upstreamRemote: metadata.upstreamRemote,
          upstreamBranch: metadata.upstreamBranch,
          ensureRemoteName: metadata.ensureRemoteName,
          ensureRemoteUrl: metadata.ensureRemoteUrl,
          fetchRemoteUrl: metadata.fetchRemoteUrl,
          githubAccountId: metadata.githubAccountId,
        });
      },
      run_project_setup: async (receipt) => {
        const projectStart = await loadProjectStartCommand(receipt.metadata?.projectID);
        if (!projectStart) return;
        const result = await runWorktreeStartCommand(receipt.directory, projectStart);
        if (!result.success) {
          throw new Error(setupFailureMessage(result, 'Project setup command failed'));
        }
      },
      run_requested_setup: async (receipt) => {
        const command = String(receipt.metadata?.startCommand || '').trim();
        if (!command) return;
        const result = await runWorktreeStartCommand(receipt.directory, command);
        if (!result.success) {
          throw new Error(setupFailureMessage(result, 'Requested setup command failed'));
        }
      },
    },
  });
  worktreeBootstrapInitialization = worktreeBootstrapRuntime
    .initialize();
  return worktreeBootstrapRuntime;
};

export const getConfiguredWorktreeBootstrapRuntime = () => worktreeBootstrapRuntime;

const ensureRemoteWithUrl = async (primaryWorktree, remoteName, remoteUrl) => {
  const name = String(remoteName || '').trim();
  const url = String(remoteUrl || '').trim();
  if (!name || !url) {
    return;
  }

  const getUrl = await runGitCommand(primaryWorktree, ['remote', 'get-url', name]);
  if (getUrl.success) {
    const currentUrl = String(getUrl.stdout || '').trim();
    if (currentUrl !== url) {
      await runGitCommandOrThrow(primaryWorktree, ['remote', 'set-url', name, url], 'Failed to update git remote URL');
    }
    return;
  }

  await runGitCommandOrThrow(primaryWorktree, ['remote', 'add', name, url], 'Failed to add git remote');
};

const fetchRemoteBranchRef = async (
  primaryWorktree,
  remoteName,
  branchName,
  githubAccountId = null,
  remoteUrl = '',
) => {
  const remote = String(remoteName || '').trim();
  const branch = String(branchName || '').trim();
  const fetchTarget = String(remoteUrl || '').trim() || remote;
  if (!remote || !branch) {
    return;
  }

  const refspec = `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`;
  await runGitCommandOrThrow(
    primaryWorktree,
    ['fetch', fetchTarget, refspec],
    `Failed to fetch ${remote}/${branch}`,
    { includeCredentials: true, githubAccountId },
  );
};

const checkRemoteBranchExists = async (primaryWorktree, remoteName, branchName, remoteUrl = '') => {
  const remote = String(remoteName || '').trim();
  const branch = String(branchName || '').trim();
  const url = String(remoteUrl || '').trim();
  if (!remote || !branch) {
    return { success: false, found: false };
  }

  const target = url || remote;
  const lsRemote = await runGitCommand(
    primaryWorktree,
    ['ls-remote', '--heads', target, `refs/heads/${branch}`]
  );
  if (!lsRemote.success) {
    return { success: false, found: false };
  }

  return {
    success: true,
    found: Boolean(String(lsRemote.stdout || '').trim()),
  };
};

const setBranchTrackingFallback = async (worktreeDirectory, localBranch, upstream) => {
  await runGitCommandOrThrow(
    worktreeDirectory,
    ['config', `branch.${localBranch}.remote`, upstream.remote],
    `Failed to set branch.${localBranch}.remote`
  );
  await runGitCommandOrThrow(
    worktreeDirectory,
    ['config', `branch.${localBranch}.merge`, `refs/heads/${upstream.branch}`],
    `Failed to set branch.${localBranch}.merge`
  );
};

const applyUpstreamConfiguration = async (args) => {
  const {
    primaryWorktree,
    worktreeDirectory,
    localBranch,
    setUpstream,
    upstreamRemote,
    upstreamBranch,
    ensureRemoteName,
    ensureRemoteUrl,
    fetchRemoteUrl,
    githubAccountId,
  } = args;

  if (!setUpstream) {
    return;
  }

  if (ensureRemoteName && ensureRemoteUrl) {
    await ensureRemoteWithUrl(primaryWorktree, ensureRemoteName, ensureRemoteUrl);
  }

  const upstream = normalizeUpstreamTarget(upstreamRemote, upstreamBranch);
  if (!upstream || !localBranch) {
    return;
  }

  let fetched = true;
  try {
    await fetchRemoteBranchRef(
      primaryWorktree,
      upstream.remote,
      upstream.branch,
      githubAccountId || null,
      fetchRemoteUrl,
    );
  } catch {
    fetched = false;
  }

  if (fetched) {
    await runGitCommandOrThrow(
      worktreeDirectory,
      ['branch', `--set-upstream-to=${upstream.full}`, localBranch],
      `Failed to set upstream to ${upstream.full}`
    );
    return;
  }

  await setBranchTrackingFallback(worktreeDirectory, localBranch, upstream);
};

export async function isGitRepository(directory) {
  const directoryPath = normalizeDirectoryPath(directory);
  if (!directoryPath || !fs.existsSync(directoryPath)) {
    return false;
  }

  const result = await runGitCommand(directoryPath, ['rev-parse', '--show-toplevel']);
  if (!result.success || !String(result.stdout || '').trim()) {
    return false;
  }

  const [requestedDirectory, repositoryRoot] = await Promise.all([
    canonicalPath(directoryPath),
    canonicalPath(path.resolve(directoryPath, String(result.stdout).trim())),
  ]);
  return requestedDirectory === repositoryRoot;
}

const isInsideGitWorktree = async (directory) => {
  const directoryPath = normalizeDirectoryPath(directory);
  if (!directoryPath || !fs.existsSync(directoryPath)) return false;
  const result = await runGitCommand(directoryPath, ['rev-parse', '--is-inside-work-tree']);
  return result.success && String(result.stdout || '').trim() === 'true';
};

export async function getGlobalIdentity() {
  const git = await createGlobalConfigGit();

  try {
    const userName = await git.getConfig('user.name', 'global').catch(() => null);
    const userEmail = await git.getConfig('user.email', 'global').catch(() => null);
    const sshCommand = await git.getConfig('core.sshCommand', 'global').catch(() => null);

    return {
      userName: userName?.value || null,
      userEmail: userEmail?.value || null,
      sshCommand: sshCommand?.value || null
    };
  } catch (error) {
    console.error('Failed to get global Git identity:', error);
    return {
      userName: null,
      userEmail: null,
      sshCommand: null
    };
  }
}

export async function getRemoteUrl(directory, remoteName = 'origin') {
  const git = await createGit(directory);

  try {
    const url = await git.remote(['get-url', remoteName]);
    return url?.trim() || null;
  } catch {
    return null;
  }
}

export async function getCurrentIdentity(directory) {
  const git = await createGit(directory);

  try {

    const userName = await git.getConfig('user.name', 'local').catch(() =>
      git.getConfig('user.name', 'global')
    );

    const userEmail = await git.getConfig('user.email', 'local').catch(() =>
      git.getConfig('user.email', 'global')
    );

    const sshCommand = await git.getConfig('core.sshCommand', 'local').catch(() =>
      git.getConfig('core.sshCommand', 'global')
    );

    return {
      userName: userName?.value || null,
      userEmail: userEmail?.value || null,
      sshCommand: sshCommand?.value || null
    };
  } catch (error) {
    console.error('Failed to get current Git identity:', error);
    return {
      userName: null,
      userEmail: null,
      sshCommand: null
    };
  }
}

export async function hasLocalIdentity(directory) {
  const git = await createGit(directory);

  try {
    const localName = await git.getConfig('user.name', 'local').catch(() => null);
    const localEmail = await git.getConfig('user.email', 'local').catch(() => null);
    return Boolean(localName?.value || localEmail?.value);
  } catch {
    return false;
  }
}

export async function setLocalIdentity(directory, profile) {
  const git = await createGit(directory);

  try {

    await git.addConfig('user.name', profile.userName, false, 'local');
    await git.addConfig('user.email', profile.userEmail, false, 'local');

    const authType = profile.authType || 'ssh';

    if (authType === 'ssh' && profile.sshKey) {
      await git.addConfig(
        'core.sshCommand',
        buildSshCommand(profile.sshKey),
        false,
        'local'
      );
      await git.raw(['config', '--local', '--unset', 'credential.helper']).catch(() => {});
    } else if (authType === 'token' && profile.host) {
      await git.addConfig(
        'credential.helper',
        'store',
        false,
        'local'
      );
      await git.raw(['config', '--local', '--unset', 'core.sshCommand']).catch(() => {});
    }

    return true;
  } catch (error) {
    console.error('Failed to set Git identity:', error);
    throw error;
  }
}

export async function getStatus(directory, options = {}) {
  const directoryPath = normalizeDirectoryPath(directory);
  const lightMode = options.mode === 'light';

  try {
    const directoryStat = await fsp.stat(directoryPath);
    if (!directoryStat.isDirectory()) {
      throw new Error('Git directory must be a directory');
    }

    const repositoryRootResult = await runGitCommand(directoryPath, ['rev-parse', '--show-toplevel']);
    if (!repositoryRootResult.success || !String(repositoryRootResult.stdout || '').trim()) {
      if (!fs.existsSync(directoryPath)) {
        throw Object.assign(new Error(`Git directory no longer exists: ${directoryPath}`), { code: 'ENOENT' });
      }
      throw Object.assign(
        new Error(repositoryRootResult.message || `Not a Git repository: ${directoryPath}`),
        { code: 'GIT_NOT_REPOSITORY' },
      );
    }

    const [requestedDirectory, repositoryRoot] = await Promise.all([
      canonicalPath(directoryPath),
      canonicalPath(path.resolve(directoryPath, String(repositoryRootResult.stdout).trim())),
    ]);
    if (requestedDirectory !== repositoryRoot) {
      throw Object.assign(
        new Error(`Not a Git repository for the requested project directory: ${directoryPath}`),
        { code: 'GIT_REPOSITORY_CONTEXT_MISMATCH' },
      );
    }

    // Status is collected in the background throughout the UI. Git normally
    // refreshes and rewrites the index during status, which can collide with a
    // simultaneous checkout/reset. Disable only those optional writes while
    // preserving the status result itself.
    const git = await createGit(directoryPath, { optionalLocks: false });
    // Use -uall to show all untracked files individually, not just directories
    const status = await git.status(['-uall']);

    // Light mode: skip numstat + new-file line counting for faster response
    const [stagedStatsRaw, workingStatsRaw] = lightMode
      ? ['', '']
      : await Promise.all([
          git.raw(['diff', '--cached', '--numstat']).catch(() => ''),
          git.raw(['diff', '--numstat']).catch(() => ''),
        ]);

    const diffStatsMap = new Map();

    const accumulateStats = (raw) => {
      if (!raw) return;
      raw
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .forEach((line) => {
          const parts = line.split('\t');
          if (parts.length < 3) {
            return;
          }
          const [insertionsRaw, deletionsRaw, ...pathParts] = parts;
          const path = pathParts.join('\t');
          if (!path) {
            return;
          }
          const insertions = insertionsRaw === '-' ? 0 : parseInt(insertionsRaw, 10) || 0;
          const deletions = deletionsRaw === '-' ? 0 : parseInt(deletionsRaw, 10) || 0;

          const existing = diffStatsMap.get(path) || { insertions: 0, deletions: 0 };
          diffStatsMap.set(path, {
            insertions: existing.insertions + insertions,
            deletions: existing.deletions + deletions,
          });
        });
    };

    accumulateStats(stagedStatsRaw);
    accumulateStats(workingStatsRaw);

    const diffStats = Object.fromEntries(diffStatsMap.entries());

    const MAX_NEW_FILE_STATS = 200;
    const MAX_NEW_FILE_STAT_SIZE = 1024 * 1024;
    const newFileStats = [];

    if (!lightMode) {
      for (const file of status.files) {
        if (newFileStats.length >= MAX_NEW_FILE_STATS) {
          break;
        }

        const working = (file.working_dir || '').trim();
        const indexStatus = (file.index || '').trim();
        const statusCode = working || indexStatus;

        if (statusCode !== '?' && statusCode !== 'A') {
          continue;
        }

        const existing = diffStats[file.path];
        if (existing && existing.insertions > 0) {
          continue;
        }

        const absolutePath = path.join(directoryPath, file.path);

        try {
          const stat = await fsp.stat(absolutePath);
          if (!stat.isFile() || stat.size > MAX_NEW_FILE_STAT_SIZE) {
            continue;
          }

          const buffer = await fsp.readFile(absolutePath);
          if (buffer.indexOf(0) !== -1) {
            newFileStats.push({
              path: file.path,
              insertions: existing?.insertions ?? 0,
              deletions: existing?.deletions ?? 0,
            });
            continue;
          }

          const normalized = buffer.toString('utf8').replace(/\r\n/g, '\n');
          if (!normalized.length) {
            newFileStats.push({
              path: file.path,
              insertions: 0,
              deletions: 0,
            });
            continue;
          }

          const segments = normalized.split('\n');
          if (normalized.endsWith('\n')) {
            segments.pop();
          }

          const lineCount = segments.length;
          newFileStats.push({
            path: file.path,
            insertions: lineCount,
            deletions: 0,
          });
        } catch (error) {
          if (error?.code !== 'ENOENT') {
            console.warn('Failed to estimate diff stats for new file', file.path, error);
          }
        }
      }
    }

    for (const entry of newFileStats) {
      diffStats[entry.path] = {
        insertions: entry.insertions,
        deletions: entry.deletions,
      };
    }

    const selectBaseRefForUnpublished = async (currentBranch) => {
      const candidates = [];
      const normalizedCurrentBranch = String(currentBranch || '').trim();
      const addCandidate = (ref, countsPullableBehind = false) => {
        if (!ref || candidates.some((candidate) => candidate.ref === ref)) {
          return;
        }
        candidates.push({ ref, countsPullableBehind });
      };

      if (normalizedCurrentBranch && normalizedCurrentBranch !== 'HEAD') {
        addCandidate(`origin/${normalizedCurrentBranch}`, true);
      }

      const originHead = await git
        .raw(['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'])
        .then((value) => String(value || '').trim())
        .catch(() => '');

      if (originHead) {
        // "refs/remotes/origin/main" -> "origin/main"
        const originHeadRef = originHead.replace(/^refs\/remotes\//, '');
        const originHeadBranch = originHeadRef.startsWith('origin/')
          ? originHeadRef.slice('origin/'.length)
          : originHeadRef;
        addCandidate(originHeadRef, Boolean(normalizedCurrentBranch && originHeadBranch === normalizedCurrentBranch));
      }

      addCandidate('origin/main', normalizedCurrentBranch === 'main');
      addCandidate('origin/master', normalizedCurrentBranch === 'master');
      addCandidate('main');
      addCandidate('master');

      for (const candidate of candidates) {
        const exists = await git
          .raw(['rev-parse', '--verify', candidate.ref])
          .then((value) => String(value || '').trim())
          .catch(() => '');
        if (exists) return candidate;
      }

      return null;
    };

    let tracking = status.tracking || null;
    let ahead = status.ahead;
    let behind = status.behind;

    // When no upstream is configured (common for new worktree branches), Git doesn't report ahead/behind.
    // We still want to show the number of unpublished commits to the user.
    // Light mode skips this — the basic ahead/behind from git status is sufficient for polling.
    if (!lightMode && !tracking && status.current) {
      const baseRef = await selectBaseRefForUnpublished(status.current);
      if (baseRef) {
        const divergenceRaw = await git
          .raw(['rev-list', '--left-right', '--count', `${baseRef.ref}...HEAD`])
          .then((value) => String(value || '').trim())
          .catch(() => '');
        const [behindRaw, aheadRaw] = divergenceRaw.split(/\s+/);
        const aheadCount = parseInt(aheadRaw, 10);
        const behindCount = parseInt(behindRaw, 10);
        if (Number.isFinite(aheadCount)) {
          ahead = aheadCount;
          behind = baseRef.countsPullableBehind && Number.isFinite(behindCount) ? behindCount : 0;
        }
      }
    }

    // Check for in-progress operations
    let mergeInProgress = null;
    let rebaseInProgress = null;

    try {
      // Check MERGE_HEAD for merge in progress
      const mergeHeadExists = await git
        .raw(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])
        .then(() => true)
        .catch(() => false);
      
      if (mergeHeadExists) {
        const mergeHead = await git.raw(['rev-parse', 'MERGE_HEAD']).catch(() => '');
        const headSha = mergeHead.trim().slice(0, 7);
        // Only set mergeInProgress if we actually have a valid head SHA
        if (headSha) {
          const mergeMsg = await fsp.readFile(path.join(directoryPath, '.git', 'MERGE_MSG'), 'utf8').catch(() => '');
          mergeInProgress = {
            head: headSha,
            message: mergeMsg.split('\n')[0] || '',
          };
        }
      }
    } catch {
      // ignore
    }

    try {
      // Check for rebase in progress (.git/rebase-merge or .git/rebase-apply)
      const rebaseMergeExists = await fsp.stat(path.join(directoryPath, '.git', 'rebase-merge')).then(() => true).catch(() => false);
      const rebaseApplyExists = await fsp.stat(path.join(directoryPath, '.git', 'rebase-apply')).then(() => true).catch(() => false);
      
      if (rebaseMergeExists || rebaseApplyExists) {
        const rebaseDir = rebaseMergeExists ? 'rebase-merge' : 'rebase-apply';
        const headName = await fsp.readFile(path.join(directoryPath, '.git', rebaseDir, 'head-name'), 'utf8').catch(() => '');
        const onto = await fsp.readFile(path.join(directoryPath, '.git', rebaseDir, 'onto'), 'utf8').catch(() => '');
        
        const headNameTrimmed = headName.trim().replace('refs/heads/', '');
        const ontoTrimmed = onto.trim().slice(0, 7);
        
        // Only set rebaseInProgress if we have valid data
        if (headNameTrimmed || ontoTrimmed) {
          rebaseInProgress = {
            headName: headNameTrimmed,
            onto: ontoTrimmed,
          };
        }
      }
    } catch {
      // ignore
    }

    return {
      current: status.current,
      tracking,
      ahead,
      behind,
      files: status.files.map((f) => ({
        path: f.path,
        index: f.index,
        working_dir: f.working_dir,
      })),
      isClean: status.isClean(),
      diffStats: lightMode ? undefined : diffStats,
      mergeInProgress,
      rebaseInProgress,
    };
  } catch (error) {
    if (!isNotGitRepositoryError(error) && !isMissingDirectoryError(error, directoryPath)) {
      console.error('Failed to get Git status:', error);
    }
    throw error;
  }
}

export async function getDiff(directory, { path, paths, staged = false, contextLines = 3 } = {}) {
  const git = await createGit(directory);

  try {
    const args = ['diff', '--no-color'];

    if (typeof contextLines === 'number' && !Number.isNaN(contextLines)) {
      args.push(`-U${Math.max(0, contextLines)}`);
    }

    if (staged) {
      args.push('--cached');
    }

    const selectedPaths = Array.isArray(paths)
      ? paths.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim())
      : path ? [path] : [];
    if (selectedPaths.length > 0) {
      args.push('--', ...selectedPaths);
    }

    const diff = await git.raw(args);
    if (diff && diff.trim().length > 0) {
      return diff;
    }

    if (staged || selectedPaths.length !== 1) {
      return diff;
    }

    const [singlePath] = selectedPaths;

    try {
      await git.raw(['ls-files', '--error-unmatch', singlePath]);
      return diff;
    } catch {
      const noIndexArgs = ['diff', '--no-color'];
      if (typeof contextLines === 'number' && !Number.isNaN(contextLines)) {
        noIndexArgs.push(`-U${Math.max(0, contextLines)}`);
      }
      noIndexArgs.push('--no-index', '--', '/dev/null', singlePath);
      try {
        const noIndexDiff = await git.raw(noIndexArgs);
        return noIndexDiff;
      } catch (noIndexError) {
        // git diff --no-index returns exit code 1 when differences exist (not a real error)
        if (noIndexError.exitCode === 1 && noIndexError.message) {
          return noIndexError.message;
        }
        throw noIndexError;
      }
    }
  } catch (error) {
    console.error('Failed to get Git diff:', error);
    throw error;
  }
}

export async function getRangeDiff(directory, { base, head, path, contextLines = 3 } = {}) {
  const git = await createGit(directory);
  const baseRef = typeof base === 'string' ? base.trim() : '';
  const headRef = typeof head === 'string' ? head.trim() : '';
  if (!baseRef || !headRef) {
    throw new Error('base and head are required');
  }

  // Prefer remote-tracking base ref so merged commits don't reappear
  // when local base branch is stale (common when user stays on feature branch).
  let resolvedBase = baseRef;
  const originCandidate = `refs/remotes/origin/${baseRef}`;
  try {
    const verified = await git.raw(['rev-parse', '--verify', originCandidate]);
    if (verified && verified.trim()) {
      resolvedBase = `origin/${baseRef}`;
    }
  } catch {
    // ignore
  }

  const args = ['diff', '--no-color'];
  if (typeof contextLines === 'number' && !Number.isNaN(contextLines)) {
    args.push(`-U${Math.max(0, contextLines)}`);
  }
  args.push(`${resolvedBase}...${headRef}`);
  if (path) {
    args.push('--', path);
  }
  const diff = await git.raw(args);
  return diff;
}

export async function getRangeFiles(directory, { base, head } = {}) {
  const git = await createGit(directory);
  const baseRef = typeof base === 'string' ? base.trim() : '';
  const headRef = typeof head === 'string' ? head.trim() : '';
  if (!baseRef || !headRef) {
    throw new Error('base and head are required');
  }

  let resolvedBase = baseRef;
  const originCandidate = `refs/remotes/origin/${baseRef}`;
  try {
    const verified = await git.raw(['rev-parse', '--verify', originCandidate]);
    if (verified && verified.trim()) {
      resolvedBase = `origin/${baseRef}`;
    }
  } catch {
    // ignore
  }

  const raw = await git.raw(['diff', '--name-only', `${resolvedBase}...${headRef}`]);
  return String(raw || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'avif'];

const BINARY_SNIFF_BYTES = 8192;

function isImageFile(filePath) {
  const ext = filePath.split('.').pop()?.toLowerCase();
  return IMAGE_EXTENSIONS.includes(ext || '');
}

function getImageMimeType(filePath) {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const mimeMap = {
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'svg': 'image/svg+xml',
    'webp': 'image/webp',
    'ico': 'image/x-icon',
    'bmp': 'image/bmp',
    'avif': 'image/avif',
  };
  return mimeMap[ext] || 'application/octet-stream';
}

const parseIsBinaryFromNumstat = (raw) => {
  const text = String(raw || '').trim();
  if (!text) {
    return false;
  }

  // Expected format: <added>\t<deleted>\t<path>
  const firstLine = text.split('\n').map((line) => line.trim()).find(Boolean) || '';
  const [added, deleted] = firstLine.split('\t');
  return added === '-' || deleted === '-';
};

const looksBinaryBySniff = async (absolutePath) => {
  try {
    const handle = await fsp.open(absolutePath, 'r');
    try {
      const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, BINARY_SNIFF_BYTES, 0);
      if (bytesRead <= 0) {
        return false;
      }
      return buffer.subarray(0, bytesRead).includes(0);
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
};

const isBinaryDiff = async (directoryPath, filePath, staged) => {
  // Fast path: ask git for numstat. For binary, it returns "-\t-\t<path>".
  const args = ['diff', '--numstat'];
  if (staged) {
    args.push('--cached');
  }
  args.push('--', filePath);

  const result = await runGitCommand(directoryPath, args);
  if (parseIsBinaryFromNumstat(result.stdout)) {
    return true;
  }

  // Fallback for untracked files (diff output is empty): use --no-index against /dev/null
  if (!staged) {
    const tracked = await runGitCommand(directoryPath, ['ls-files', '--error-unmatch', '--', filePath]).then((r) => r.success);
    if (!tracked) {
      const noIndex = await runGitCommand(directoryPath, ['diff', '--no-index', '--numstat', '--', '/dev/null', filePath]);
      if (parseIsBinaryFromNumstat(noIndex.stdout) || parseIsBinaryFromNumstat(noIndex.stderr) || parseIsBinaryFromNumstat(noIndex.message)) {
        return true;
      }
      const text = `${noIndex.stdout || ''}\n${noIndex.stderr || ''}\n${noIndex.message || ''}`.toLowerCase();
      if (text.includes('binary files') || text.includes('git binary patch')) {
        return true;
      }
    }
  }

  return false;
};

export async function getFileDiff(directory, { path: filePath, staged = false } = {}) {
  if (!directory || !filePath) {
    throw new Error('directory and path are required for getFileDiff');
  }

  const directoryPath = normalizeDirectoryPath(directory);
  const git = await createGit(directoryPath);
  const isImage = isImageFile(filePath);
  const mimeType = isImage ? getImageMimeType(filePath) : null;

  if (!isImage) {
    const absolutePath = path.join(directoryPath, filePath);
    const isBinaryBySniff = await looksBinaryBySniff(absolutePath);
    const isBinary = isBinaryBySniff || (await isBinaryDiff(directoryPath, filePath, staged));
    if (isBinary) {
      return {
        original: '',
        modified: '',
        path: filePath,
        isBinary: true,
      };
    }
  }

  let original = '';
  try {
    if (isImage) {
      // For images, use git show with raw output and convert to base64
      try {
        const { stdout } = await execFileAsync(getGitBinary(), ['show', `HEAD:${filePath}`], {
          cwd: directoryPath,
          encoding: 'buffer',
          windowsHide: true,
          maxBuffer: 50 * 1024 * 1024, // 50MB max
        });
        if (stdout && stdout.length > 0) {
          original = `data:${mimeType};base64,${stdout.toString('base64')}`;
        }
      } catch {
        original = '';
      }
    } else {
      original = await git.show([`HEAD:${filePath}`]);
    }
  } catch {
    original = '';
  }

  const fullPath = path.join(directoryPath, filePath);
  let modified = '';
  try {
    const stat = await fsp.stat(fullPath);
    if (stat.isFile()) {
      if (isImage) {
        // For images, read as binary and convert to data URL
        const buffer = await fsp.readFile(fullPath);
        modified = `data:${mimeType};base64,${buffer.toString('base64')}`;
      } else {
        modified = await fsp.readFile(fullPath, 'utf8');
      }
    }
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      modified = '';
    } else {
      console.error('Failed to read modified file contents for diff:', error);
      throw error;
    }
  }

  return {
    original,
    modified,
    path: filePath,
    isBinary: false,
  };
}

export async function revertFile(directory, filePath) {
  const directoryPath = normalizeDirectoryPath(directory);
  const git = await createGit(directoryPath);
  await assertManagedMutationBranch(directoryPath, git);
  const repoRoot = path.resolve(directoryPath);
  const absoluteTarget = path.resolve(repoRoot, filePath);

  if (!absoluteTarget.startsWith(repoRoot + path.sep) && absoluteTarget !== repoRoot) {
    throw new Error('Invalid file path');
  }

  const isTracked = await git
    .raw(['ls-files', '--error-unmatch', filePath])
    .then(() => true)
    .catch(() => false);

  if (!isTracked) {
    try {
      await git.raw(['clean', '-f', '-d', '--', filePath]);
      return;
    } catch (cleanError) {
      try {
        await fsp.rm(absoluteTarget, { recursive: true, force: true });
        return;
      } catch (fsError) {
        if (fsError && typeof fsError === 'object' && fsError.code === 'ENOENT') {
          return;
        }
        console.error('Failed to remove untracked file during revert:', fsError);
        throw fsError;
      }
    }
  }

  try {
    await withIndexLockRetry(() => git.raw(['restore', '--staged', filePath]));
  } catch (error) {
    await withIndexLockRetry(() => git.raw(['reset', 'HEAD', '--', filePath])).catch(() => {});
  }

  try {
    await withIndexLockRetry(() => git.raw(['restore', filePath]));
  } catch (error) {
    try {
      await withIndexLockRetry(() => git.raw(['checkout', '--', filePath]));
    } catch (fallbackError) {
      console.error('Failed to revert git file:', fallbackError);
      throw fallbackError;
    }
  }
}

const assertPathInsideRepo = (directoryPath, filePath) => {
  const repoRoot = path.resolve(directoryPath);
  const absoluteTarget = path.resolve(repoRoot, filePath);

  if (!absoluteTarget.startsWith(repoRoot + path.sep) && absoluteTarget !== repoRoot) {
    throw new Error('Invalid file path');
  }
};

export async function stageFile(directory, filePath) {
  const directoryPath = normalizeDirectoryPath(directory);
  const git = await createGit(directoryPath);
  await assertManagedMutationBranch(directoryPath, git);
  assertPathInsideRepo(directoryPath, filePath);
  await withIndexLockRetry(() => git.raw(['add', '--', filePath]));
}

export async function unstageFile(directory, filePath) {
  const directoryPath = normalizeDirectoryPath(directory);
  const git = await createGit(directoryPath);
  await assertManagedMutationBranch(directoryPath, git);
  assertPathInsideRepo(directoryPath, filePath);

  try {
    await withIndexLockRetry(() => git.raw(['restore', '--staged', '--', filePath]));
  } catch {
    await withIndexLockRetry(() => git.raw(['reset', 'HEAD', '--', filePath]));
  }
}

const HUNK_ACTION_FLAGS = {
  stage: ['--cached'],
  unstage: ['--cached', '--reverse'],
  discard: ['--reverse'],
};

const extractPatchTargetPath = (patch) => {
  const matches = [...patch.matchAll(/^(?:-{3}|\+{3})\s+(?:[ab]\/)?([^\s\t]+)/gm)];
  const realTargets = matches
    .map((match) => match[1])
    .filter((value) => value && value !== '/dev/null');
  return realTargets[0] || null;
};

const writeTempPatchFile = async (patch) => {
  const tmpPath = path.join(os.tmpdir(), `openchamber-hunk-${Date.now()}-${Math.random().toString(36).slice(2)}.patch`);
  await fsp.writeFile(tmpPath, patch, 'utf8');
  return tmpPath;
};

// Stage / unstage / discard a single diff hunk by applying a one-hunk patch with
// `git apply` (--cached / --reverse matrix). A `--check` dry-run first surfaces a
// clear "no longer applies" error if the index drifted.
// Note: unlike upstream there is no index-mutation queue here, so rapid
// concurrent applies are best-effort (matches DevRyan's existing stageFile).
export async function applyHunk(directory, filePath, options = {}) {
  const action = options?.action;
  if (!action || !HUNK_ACTION_FLAGS[action]) {
    throw new Error('Invalid hunk action');
  }
  const patch = typeof options?.patch === 'string' ? options.patch : '';
  if (!patch.trim()) {
    throw new Error('patch is required to apply a hunk');
  }
  if (!/^@@\s/m.test(patch)) {
    throw new Error('patch does not contain a hunk header');
  }

  const directoryPath = normalizeDirectoryPath(directory);
  assertPathInsideRepo(directoryPath, filePath);
  const git = await createGit(directoryPath);
  await assertManagedMutationBranch(directoryPath, git);

  const targetPath = extractPatchTargetPath(patch);
  if (targetPath && targetPath !== filePath) {
    throw new Error('patch target path does not match the requested file');
  }

  const flags = HUNK_ACTION_FLAGS[action];
  let tmpPath = null;
  try {
    tmpPath = await writeTempPatchFile(patch);

    try {
      await git.raw(['apply', ...flags, '--check', tmpPath]);
    } catch (checkError) {
      const text = parseGitErrorText(checkError);
      throw new Error(
        text
          ? `Hunk no longer applies — refresh and try again.\n${text}`
          : 'Hunk no longer applies — refresh and try again.'
      );
    }

    await withIndexLockRetry(() => git.raw(['apply', ...flags, tmpPath]));
  } finally {
    if (tmpPath) {
      await fsp.rm(tmpPath, { force: true }).catch(() => {});
    }
  }
}

export async function collectDiffs(directory, files = []) {
  const results = [];
  for (const filePath of files) {
    try {
      const diff = await getDiff(directory, { path: filePath });
      if (diff && diff.trim().length > 0) {
        results.push({ path: filePath, diff });
      }
    } catch (error) {
      console.error(`Failed to diff ${filePath}:`, error);
    }
  }
  return results;
}

export async function pull(directory, options = {}) {
  const git = await createGit(directory, { includeCredentials: true });
  const { principal, assignment } = resolveManagedGitAssignment(directory);
  if (principal) {
    await assertManagedMutationBranch(directory, git);
    const currentBranch = await getCheckedOutBranch(git);
    if (options.remote && options.remote !== 'origin') throw new Error('Managed workspaces may only pull from origin');
    if (options.branch && cleanBranchName(options.branch) !== currentBranch) {
      throw new Error('Managed workspaces may only pull the checked-out branch');
    }
    try {
      const remote = assignment.remoteUrl || 'origin';
      await git.raw(['fetch', remote, `refs/heads/${currentBranch}:refs/remotes/origin/${currentBranch}`]);
      if (options.rebase === true) await git.raw(['rebase', `origin/${currentBranch}`]);
      else await git.raw(['merge', '--ff-only', `origin/${currentBranch}`]);
      return { success: true, summary: {}, files: [], insertions: 0, deletions: 0 };
    } catch (error) {
      if (isGitConflictError(error)) {
        return {
          ...(await readConflictResult(git)),
          summary: {},
          files: [],
          insertions: 0,
          deletions: 0,
        };
      }
      if (GIT_DIVERGENCE_PATTERN.test(parseGitErrorText(error))) {
        throw createGitOperationError(
          'The managed branch has diverged from its remote branch. Rebase or merge it before pulling again.',
          'GIT_DIVERGED',
          409,
        );
      }
      throw error;
    }
  }
  const pullOptions = options.rebase === true
    ? { ...(options.options && typeof options.options === 'object' && !Array.isArray(options.options) ? options.options : {}), '--rebase': null }
    : options.options || {};

  try {
    const result = await git.pull(
      options.remote || 'origin',
      options.branch,
      pullOptions
    );

    return {
      success: true,
      summary: result.summary,
      files: result.files,
      insertions: result.insertions,
      deletions: result.deletions
    };
  } catch (error) {
    console.error('Failed to pull:', error);
    throw error;
  }
}

export async function listStashes(directory) {
  const git = await createGit(directory);
  const output = await git.raw(['stash', 'list', '--format=%gd%x1f%gs%x1f%cr%x1f%H']);
  return String(output || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [ref = '', message = '', relativeTime = '', hash = ''] = line.split('\x1f');
      return { ref, message, relativeTime, hash };
    })
    .filter((entry) => entry.ref);
}

export async function countStashFiles(directory, refs = []) {
  const git = await createGit(directory);
  const uniqueRefs = Array.from(new Set((Array.isArray(refs) ? refs : []).map((ref) => String(ref || '').trim()).filter(Boolean)));
  const counts = {};
  const concurrency = 4;
  let cursor = 0;

  const worker = async () => {
    while (cursor < uniqueRefs.length) {
      const ref = uniqueRefs[cursor++];
      if (!ref) continue;
      try {
        const names = await git.raw(['stash', 'show', '--name-only', ref]);
        counts[ref] = String(names || '').split('\n').map((line) => line.trim()).filter(Boolean).length;
      } catch {
        counts[ref] = 0;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, uniqueRefs.length) }, () => worker()));
  return counts;
}
export async function stashPush(directory, options = {}) {
  const git = await createGit(directory);
  const message = typeof options.message === 'string' && options.message.trim()
    ? options.message.trim()
    : `OpenChamber stash ${new Date().toISOString()}`;
  try {
    const output = await withIndexLockRetry(
      () => git.raw(['stash', 'push', '--include-untracked', '-m', message]),
    );
    return {
      success: true,
      created: !/no local changes/i.test(String(output || '')),
      message,
      output: String(output || '').trim(),
    };
  } catch (error) {
    if (isGitConflictError(error)) {
      const conflict = await readConflictResult(git);
      throw createGitOperationError(
        'Resolve merge conflicts before continuing',
        'GIT_UNMERGED_INDEX',
        409,
        conflict.conflictFiles,
      );
    }
    throw error;
  }
}

export async function stashApply(directory, options = {}) {
  const git = await createGit(directory);
  const ref = typeof options.ref === 'string' && options.ref.trim() ? options.ref.trim() : 'stash@{0}';
  await withIndexLockRetry(() => git.raw(['stash', 'apply', ref]));
  return { success: true, ref };
}

export async function stashDrop(directory, options = {}) {
  const git = await createGit(directory);
  const ref = typeof options.ref === 'string' && options.ref.trim() ? options.ref.trim() : 'stash@{0}';
  await withIndexLockRetry(() => git.raw(['stash', 'drop', ref]));
  return { success: true, ref };
}

export async function stashPop(directory, options = {}) {
  const ref = typeof options.ref === 'string' && options.ref.trim() ? options.ref.trim() : 'stash@{0}';
  await stashApply(directory, { ref });
  await stashDrop(directory, { ref });
  return { success: true, ref };
}

export async function push(directory, options = {}) {
  const git = await createGit(directory, { includeCredentials: true });
  const { principal, assignment } = resolveManagedGitAssignment(directory);
  if (principal) {
    await assertManagedMutationBranch(directory, git);
    const currentBranch = await getCheckedOutBranch(git);
    if (!principal.githubAccountId || !getGitHubAuthById(principal.githubAccountId)) {
      throw new Error('The assigned GitHub account is not connected on this host');
    }
    if (options.remote && options.remote !== 'origin') throw new Error('Managed workspaces may only push to origin');
    if (options.branch && cleanBranchName(options.branch) !== currentBranch) {
      throw new Error('Managed workspaces may only push the checked-out branch');
    }
    await git.raw([
      'push',
      assignment.remoteUrl || 'origin',
      `refs/heads/${currentBranch}:refs/heads/${currentBranch}`,
    ]);
    // Pushing to a URL does not update the remote-tracking ref; sync it so
    // status/log reflect the push without requiring a fetch.
    try {
      const pushedSha = (await git.raw(['rev-parse', `refs/heads/${currentBranch}`])).trim();
      if (pushedSha) {
        await git.raw(['update-ref', `refs/remotes/origin/${currentBranch}`, pushedSha]);
      }
    } catch {
      // Best effort: a failed tracking-ref update only delays UI freshness.
    }
    return {
      success: true,
      pushed: [{ local: currentBranch, remote: currentBranch }],
      repo: directory,
      ref: currentBranch,
    };
  }

  const describePushError = (error) => {
    const fromNestedGit = error?.git && typeof error.git === 'object'
      ? [error.git.message, error.git.stderr, error.git.stdout]
      : [];
    const candidates = [
      error?.message,
      error?.stderr,
      error?.stdout,
      ...fromNestedGit,
    ]
      .map((value) => String(value || '').trim())
      .filter(Boolean);

    return candidates[0] || 'Failed to push to remote';
  };

  const buildUpstreamOptions = (raw) => {
    if (Array.isArray(raw)) {
      return raw.includes('--set-upstream') ? raw : [...raw, '--set-upstream'];
    }

    if (raw && typeof raw === 'object') {
      return { ...raw, '--set-upstream': null };
    }

    return ['--set-upstream'];
  };

  const looksLikeMissingUpstream = (error) => {
    const message = String(error?.message || error?.stderr || '').toLowerCase();
    return (
      message.includes('has no upstream') ||
      message.includes('no upstream') ||
      message.includes('set-upstream') ||
      message.includes('set upstream') ||
      (message.includes('upstream') && message.includes('push') && message.includes('-u'))
    );
  };

  const normalizePushResult = (result) => {
    return {
      success: true,
      pushed: result.pushed,
      repo: result.repo,
      ref: result.ref,
    };
  };

  const remote = String(options.remote || '').trim();

  if (!remote && !options.branch) {
    try {
      await git.push();
      return {
        success: true,
        pushed: [],
        repo: directory,
        ref: null,
      };
    } catch (error) {
      if (!looksLikeMissingUpstream(error)) {
        const message = describePushError(error);
        console.error('Failed to push:', error);
        throw new Error(message);
      }

      try {
        const status = await git.status();
        const branch = status.current;
        const remotes = await git.getRemotes(true);
        const fallbackRemote = remotes.find((entry) => entry.name === 'origin')?.name || remotes[0]?.name;
        if (!branch || !fallbackRemote) {
          const message = describePushError(error);
          throw new Error(message);
        }

        const result = await git.push(fallbackRemote, branch, buildUpstreamOptions(options.options));
        return normalizePushResult(result);
      } catch (fallbackError) {
        const message = describePushError(fallbackError);
        console.error('Failed to push (including upstream fallback):', fallbackError);
        throw new Error(message);
      }
    }
  }

  const remoteName = remote || 'origin';

  // If caller didn't specify a branch, this is the common "Push"/"Commit & Push" path.
  // When there's no upstream yet (typical for freshly-created worktree branches), publish it on first push.
  if (!options.branch) {
    try {
      const status = await git.status();
      if (status.current && !status.tracking) {
        const result = await git.push(remoteName, status.current, buildUpstreamOptions(options.options));
        return normalizePushResult(result);
      }
    } catch (error) {
      // If we can't read status, fall back to the regular push path below.
      console.warn('Failed to read git status before push:', error);
    }
  }

  try {
    const result = await git.push(remoteName, options.branch, options.options || {});
    return normalizePushResult(result);
  } catch (error) {
    // Last-resort fallback: retry with upstream if the error suggests it's missing.
    if (!looksLikeMissingUpstream(error)) {
      const message = describePushError(error);
      console.error('Failed to push:', error);
      throw new Error(message);
    }

    try {
      const status = await git.status();
      const branch = options.branch || status.current;
      if (!branch) {
        console.error('Failed to push: missing branch name for upstream setup:', error);
        throw error;
      }

      const result = await git.push(remoteName, branch, buildUpstreamOptions(options.options));
      return normalizePushResult(result);
    } catch (fallbackError) {
      const message = describePushError(fallbackError);
      console.error('Failed to push (including upstream fallback):', fallbackError);
      throw new Error(message);
    }
  }
}

export async function deleteRemoteBranch(directory, options = {}) {
  const { branch, remote } = options;
  if (!branch) {
    throw new Error('branch is required to delete remote branch');
  }

  const git = await createGit(directory);
  const targetBranch = branch.startsWith('refs/heads/')
    ? branch.substring('refs/heads/'.length)
    : branch;
  const remoteName = remote || 'origin';

  try {
    await git.push(remoteName, `:${targetBranch}`);
    return { success: true };
  } catch (error) {
    console.error('Failed to delete remote branch:', error);
    throw error;
  }
}

export async function fetch(directory, options = {}) {
  const git = await createGit(directory, { includeCredentials: true });
  const { principal, assignment } = resolveManagedGitAssignment(directory);
  if (principal) {
    await assertManagedMutationBranch(directory, git);
    const currentBranch = await getCheckedOutBranch(git);
    if (options.remote && options.remote !== 'origin') throw new Error('Managed workspaces may only fetch from origin');
    const fetchBranch = await assertManagedFetchBranchAllowed({
      directory,
      principal,
      assignment,
      currentBranch,
      requestedBranch: options.branch,
    });
    await git.raw([
      'fetch',
      assignment.remoteUrl || 'origin',
      `refs/heads/${fetchBranch}:refs/remotes/origin/${fetchBranch}`,
    ]);
    return { success: true };
  }

  try {
    await git.fetch(
      options.remote || 'origin',
      options.branch,
      options.options || {}
    );

    return { success: true };
  } catch (error) {
    console.error('Failed to fetch:', error);
    throw error;
  }
}

export async function commit(directory, message, options = {}) {
  const git = await createGit(directory);

  try {
    await assertManagedMutationBranch(directory, git);
    const requestedFiles = Array.isArray(options.files)
      ? options.files
        .map((value) => String(value || '').trim())
        .filter(Boolean)
      : [];
    let filesToCommit = requestedFiles;

    if (options.stagedOnly) {
      filesToCommit = [];
    } else if (options.addAll) {
      await withIndexLockRetry(() => git.add('.'));
    } else if (requestedFiles.length > 0) {
      const status = await git.status();
      const fileStatusByPath = new Map(status.files.map((file) => [file.path, file]));
      filesToCommit = requestedFiles.filter((filePath) => fileStatusByPath.has(filePath));

      if (filesToCommit.length === 0) {
        throw new Error('No selected files are available to commit. Refresh git status and try again.');
      }

      const filesNeedingAdd = filesToCommit.filter((filePath) => {
        const fileStatus = fileStatusByPath.get(filePath);
        if (!fileStatus) {
          return false;
        }

        const alreadyFullyStaged = fileStatus.index !== ' ' && fileStatus.working_dir === ' ';
        return !alreadyFullyStaged;
      });

      if (filesNeedingAdd.length > 0) {
        await withIndexLockRetry(() => git.add(filesNeedingAdd));
      }
    }

    const commitArgs =
      !options.addAll && filesToCommit.length > 0
        ? filesToCommit
        : undefined;

    let result;
    try {
      if (options.amend) {
        result = await withIndexLockRetry(() => git.commit(message, commitArgs, ['--amend']));
      } else {
        result = await withIndexLockRetry(() => git.commit(message, commitArgs));
      }
    } catch (error) {
      const gitErrorText = parseGitErrorText(error);
      const isPathspecError = gitErrorText.includes('pathspec') && gitErrorText.includes('did not match any files');
      if (!isPathspecError || !commitArgs || commitArgs.length === 0) {
        throw error;
      }

      // Fallback for deleted/stale selections: commit currently staged changes.
      result = options.amend
        ? await git.commit(message, undefined, ['--amend'])
        : await git.commit(message);
    }

    return {
      success: true,
      commit: result.commit,
      branch: result.branch,
      summary: result.summary
    };
  } catch (error) {
    if (isGitConflictError(error)) {
      const conflict = await readConflictResult(git);
      throw createGitOperationError(
        'Resolve merge conflicts before continuing',
        'GIT_UNMERGED_INDEX',
        409,
        conflict.conflictFiles,
      );
    }
    console.error('Failed to commit:', error);
    throw error;
  }
}

export async function getBranches(directory) {
  const git = await createGit(directory, { includeCredentials: true });

  try {
    const result = await git.branch();

    const allBranches = result.all;
    const remoteBranches = allBranches.filter(branch => branch.startsWith('remotes/'));
    const activeRemoteBranches = await filterActiveRemoteBranches(git, remoteBranches);

    const filteredAll = [
      ...allBranches.filter(branch => !branch.startsWith('remotes/')),
      ...activeRemoteBranches
    ];

    return {
      all: filteredAll,
      current: result.current,
      branches: result.branches
    };
  } catch (error) {
    if (isNotGitRepositoryError(error)) {
      return {
        all: [],
        current: null,
        branches: {}
      };
    }
    console.error('Failed to get branches:', error);
    throw error;
  }
}

async function filterActiveRemoteBranches(git, remoteBranches) {
  const parsedRemoteBranches = remoteBranches
    .map((remoteBranch) => {
      const match = remoteBranch.match(/^remotes\/([^/]+)\/(.+)$/);
      if (!match) {
        return null;
      }
      return {
        remoteBranch,
        remoteName: match[1],
        branchName: match[2],
      };
    })
    .filter(Boolean)
    .filter(({ branchName }) => branchName !== 'HEAD');

  try {
    const remotes = await git.getRemotes();
    const branchesByRemote = new Map();

    await Promise.all(remotes.map(async (remote) => {
      try {
        const lsRemoteResult = await git.raw(['ls-remote', '--heads', remote.name]);
        const actualRemoteBranches = new Set();
        const lines = lsRemoteResult.trim().split('\n');
        for (const line of lines) {
          if (line.includes('\trefs/heads/')) {
            const branchName = line.split('\t')[1].replace('refs/heads/', '');
            actualRemoteBranches.add(branchName);
          }
        }
        branchesByRemote.set(remote.name, actualRemoteBranches);
      } catch {
        // Keep local remote-tracking refs when a remote cannot be verified.
      }
    }));

    return parsedRemoteBranches
      .filter(({ remoteName, branchName }) => {
        if (!branchesByRemote.has(remoteName)) {
          return true;
        }
        return branchesByRemote.get(remoteName).has(branchName);
      })
      .map(({ remoteBranch }) => remoteBranch);
  } catch (error) {
    console.warn('Failed to filter active remote branches, returning all:', error.message);
    return parsedRemoteBranches.map(({ remoteBranch }) => remoteBranch);
  }
}

export async function createBranch(directory, branchName, options = {}) {
  assertBranchCreationAllowed();
  const git = await createGit(directory);

  try {
    await git.checkoutBranch(branchName, options.startPoint || 'HEAD');
    return { success: true, branch: branchName };
  } catch (error) {
    console.error('Failed to create branch:', error);
    throw error;
  }
}

export async function checkoutBranch(directory, branchName) {
  const git = await createGit(directory);

  try {
    await withIndexLockRetry(() => git.checkout(branchName));
    return { success: true, branch: branchName };
  } catch (error) {
    console.error('Failed to checkout branch:', error);
    throw error;
  }
}

export async function getWorktrees(directory) {
  const directoryPath = normalizeDirectoryPath(directory);
  if (!directoryPath || !fs.existsSync(directoryPath) || !fs.existsSync(path.join(directoryPath, '.git'))) {
    return [];
  }
  try {
    const result = await runGitCommandOrThrow(
      directoryPath,
      ['worktree', 'list', '--porcelain'],
      'Failed to list git worktrees'
    );
    return parseWorktreePorcelain(result.stdout).map((entry) => ({
      head: entry.head || '',
      name: path.basename(entry.worktree || ''),
      branch: entry.branch || '',
      path: entry.worktree,
    }));
  } catch (error) {
    console.warn('Failed to list worktrees, returning empty list:', error?.message || error);
    return [];
  }
}

export async function getPrimaryWorktreeRoot(directory) {
  const directoryPath = normalizeDirectoryPath(directory);
  if (!directoryPath) {
    throw new Error('Directory is required');
  }

  const topResult = await runGitCommandOrThrow(
    directoryPath,
    ['rev-parse', '--show-toplevel'],
    'Failed to resolve git top-level directory'
  );
  const topLevel = topResult.stdout.trim();
  if (!topLevel) {
    throw new Error('Failed to resolve git top-level directory');
  }

  const sandbox = path.resolve(directoryPath, topLevel);
  const commonResult = await runGitCommandOrThrow(
    sandbox,
    ['rev-parse', '--git-common-dir'],
    'Failed to resolve git common directory'
  );
  const commonDir = commonResult.stdout.trim();
  if (!commonDir) {
    throw new Error('Failed to resolve git common directory');
  }

  return path.dirname(path.resolve(sandbox, commonDir));
}

export async function validateWorktreeCreate(directory, input = {}) {
  const mode = input?.mode === 'existing' ? 'existing' : 'new';
  const errors = [];

  try {
    const context = await resolveWorktreeProjectContext(directory);
    const preferredBranchName = cleanBranchName(String(input?.branchName || '').trim());
    const startRef = normalizeStartRef(input?.startRef);
    const ensureRemoteName = String(input?.ensureRemoteName || '').trim();
    const ensureRemoteUrl = String(input?.ensureRemoteUrl || '').trim();

    let localBranch = '';
    let inferredUpstream = null;

    if (mode === 'existing') {
      try {
        const requestedExistingBranch = String(input?.existingBranch || '').trim();
        const parsedExistingRemote = await resolveRemoteBranchRef(context.primaryWorktree, requestedExistingBranch);
        if (parsedExistingRemote && ensureRemoteName && ensureRemoteUrl && ensureRemoteName === parsedExistingRemote.remote) {
          const lsRemote = await runGitCommand(
            context.primaryWorktree,
            ['ls-remote', '--heads', ensureRemoteUrl, `refs/heads/${parsedExistingRemote.branch}`]
          );
          if (!lsRemote.success) {
            throw new Error(`Unable to query remote ${ensureRemoteName}`);
          }
          if (!String(lsRemote.stdout || '').trim()) {
            throw new Error(`Remote branch not found: ${parsedExistingRemote.remoteRef}`);
          }
          localBranch = cleanBranchName(preferredBranchName || parsedExistingRemote.branch);
          inferredUpstream = {
            remote: parsedExistingRemote.remote,
            branch: parsedExistingRemote.branch,
          };
        } else {
          const resolved = await resolveBranchForExistingMode(context.primaryWorktree, requestedExistingBranch, preferredBranchName);
          localBranch = resolved.localBranch || '';
          if (resolved.remoteRef) {
            inferredUpstream = {
              remote: resolved.remoteRef.remote,
              branch: resolved.remoteRef.branch,
            };
          }
        }
      } catch (error) {
        errors.push({
          code: 'branch_not_found',
          message: error instanceof Error ? error.message : 'Existing branch not found',
        });
      }
    } else {
      if (preferredBranchName) {
        const exists = await runGitCommand(context.primaryWorktree, ['show-ref', '--verify', '--quiet', `refs/heads/${preferredBranchName}`]);
        if (exists.success) {
          errors.push({
            code: 'branch_exists',
            message: `Branch already exists: ${preferredBranchName}`,
          });
        }
        localBranch = preferredBranchName;
      }

      const parsedRemoteRef = await resolveRemoteBranchRef(context.primaryWorktree, startRef);
      if (startRef && startRef !== 'HEAD') {
        if (parsedRemoteRef && ensureRemoteName && ensureRemoteUrl && ensureRemoteName === parsedRemoteRef.remote) {
          const remoteCheck = await checkRemoteBranchExists(
            context.primaryWorktree,
            parsedRemoteRef.remote,
            parsedRemoteRef.branch,
            ensureRemoteUrl
          );
          if (!remoteCheck.success) {
            errors.push({
              code: 'remote_unreachable',
              message: `Unable to query remote ${ensureRemoteName}`,
            });
          } else if (!remoteCheck.found) {
            errors.push({
              code: 'start_ref_not_found',
              message: `Remote branch not found: ${parsedRemoteRef.remoteRef}`,
            });
          }
        } else if (parsedRemoteRef) {
          const remoteCheck = await checkRemoteBranchExists(
            context.primaryWorktree,
            parsedRemoteRef.remote,
            parsedRemoteRef.branch
          );
          if (!remoteCheck.success) {
            errors.push({
              code: 'remote_unreachable',
              message: `Unable to query remote ${parsedRemoteRef.remote}`,
            });
          } else if (!remoteCheck.found) {
            errors.push({
              code: 'start_ref_not_found',
              message: `Remote branch not found: ${parsedRemoteRef.remoteRef}`,
            });
          }
        } else {
          const startRefExists = await runGitCommand(context.primaryWorktree, ['rev-parse', '--verify', '--quiet', startRef]);
          if (!startRefExists.success) {
            errors.push({
              code: 'start_ref_not_found',
              message: `Start ref not found: ${startRef}`,
            });
          }
        }
      }

      if (parsedRemoteRef) {
        inferredUpstream = {
          remote: parsedRemoteRef.remote,
          branch: parsedRemoteRef.branch,
        };
      }
    }

    if (localBranch) {
      const inUse = await findBranchInUse(context.primaryWorktree, localBranch);
      if (inUse) {
        errors.push({
          code: 'branch_in_use',
          message: `Branch is already checked out in ${inUse.worktree}`,
        });
      }
    }

    if ((ensureRemoteName && !ensureRemoteUrl) || (!ensureRemoteName && ensureRemoteUrl)) {
      errors.push({
        code: 'invalid_remote_config',
        message: 'Both ensureRemoteName and ensureRemoteUrl are required together',
      });
    }

    const shouldSetUpstream = Boolean(input?.setUpstream);
    if (shouldSetUpstream) {
      const upstreamRemote = String(input?.upstreamRemote || inferredUpstream?.remote || '').trim();
      const upstreamBranch = String(input?.upstreamBranch || inferredUpstream?.branch || '').trim();

      if (!upstreamRemote || !upstreamBranch) {
        errors.push({
          code: 'upstream_incomplete',
          message: 'upstreamRemote and upstreamBranch are required when setUpstream is true',
        });
      } else {
        const remoteExists = await runGitCommand(context.primaryWorktree, ['remote', 'get-url', upstreamRemote]);
        if (!remoteExists.success && (!ensureRemoteName || ensureRemoteName !== upstreamRemote)) {
          errors.push({
            code: 'remote_not_found',
            message: `Remote not found: ${upstreamRemote}`,
          });
        }
      }
    }

    return {
      ok: errors.length === 0,
      errors,
      resolved: {
        mode,
        localBranch: localBranch || null,
      },
    };
  } catch (error) {
    return {
      ok: false,
      errors: [{
        code: 'validation_failed',
        message: error instanceof Error ? error.message : 'Failed to validate worktree creation',
      }],
    };
  }
}

export async function previewWorktreeCreate(directory, input = {}) {
  const mode = input?.mode === 'existing' ? 'existing' : 'new';
  const context = await resolveWorktreeProjectContext(directory);
  await fsp.mkdir(context.worktreeRoot, { recursive: true });

  const preferredName = String(input?.worktreeName || input?.name || '').trim();
  const preferredBranchName = cleanBranchName(String(input?.branchName || '').trim());
  const candidate = await resolveCandidateDirectory(
    context.worktreeRoot,
    preferredName,
    mode === 'new' && preferredBranchName ? preferredBranchName : '',
    context.primaryWorktree
  );

  return {
    name: candidate.name,
    branch: mode === 'new' ? candidate.branch : preferredBranchName,
    path: candidate.directory,
  };
}

const buildWorktreeCreationMetadata = async ({
  mode,
  context,
  candidate,
  input,
  preferredBranchName,
  startRef,
  ensureRemoteName,
  ensureRemoteUrl,
}) => {
  const worktreeAddArgs = ['worktree', 'add', '--no-checkout'];
  let localBranch = '';
  let inferredUpstream = null;
  let fetchRemote = '';
  let fetchBranch = '';

  if (mode === 'existing') {
    const requestedExistingBranch = String(input?.existingBranch || '').trim();
    if (!requestedExistingBranch) {
      throw new Error('existingBranch is required in existing mode');
    }
    const normalizedLocal = cleanBranchName(requestedExistingBranch);
    const localExists = await runGitCommand(
      context.primaryWorktree,
      ['show-ref', '--verify', '--quiet', `refs/heads/${normalizedLocal}`],
    );
    if (localExists.success) {
      localBranch = normalizedLocal;
      worktreeAddArgs.push(candidate.directory, normalizedLocal);
    } else {
      const remoteRef = await resolveRemoteBranchRef(
        context.primaryWorktree,
        requestedExistingBranch,
      );
      if (!remoteRef) {
        throw new Error(`Branch not found: ${requestedExistingBranch}`);
      }
      localBranch = cleanBranchName(
        preferredBranchName || remoteRef.branch || requestedExistingBranch,
      );
      if (!localBranch) {
        throw new Error('Failed to resolve local branch name for existing branch worktree');
      }
      const remoteExists = await runGitCommand(
        context.primaryWorktree,
        ['show-ref', '--verify', '--quiet', remoteRef.fullRef],
      );
      if (
        !remoteExists.success
        || (
          ensureRemoteName
          && ensureRemoteUrl
          && remoteRef.remote === ensureRemoteName
        )
      ) {
        fetchRemote = remoteRef.remote;
        fetchBranch = remoteRef.branch;
      }
      worktreeAddArgs.push('-b', localBranch, candidate.directory, remoteRef.remoteRef);
      inferredUpstream = {
        remote: remoteRef.remote,
        branch: remoteRef.branch,
      };
    }
  } else {
    localBranch = candidate.branch;
    if (!localBranch) {
      throw new Error('Failed to resolve branch name for new worktree');
    }
    const branchExists = await runGitCommand(
      context.primaryWorktree,
      ['show-ref', '--verify', '--quiet', `refs/heads/${localBranch}`],
    );
    if (branchExists.success) {
      throw new Error(`Branch already exists: ${localBranch}`);
    }
    worktreeAddArgs.push('-b', localBranch, candidate.directory);
    if (startRef && startRef !== 'HEAD') worktreeAddArgs.push(startRef);
    const parsedRemoteStartRef = await resolveRemoteBranchRef(context.primaryWorktree, startRef);
    if (parsedRemoteStartRef) {
      fetchRemote = parsedRemoteStartRef.remote;
      fetchBranch = parsedRemoteStartRef.branch;
      inferredUpstream = {
        remote: parsedRemoteStartRef.remote,
        branch: parsedRemoteStartRef.branch,
      };
    }
  }

  const inUse = await findBranchInUse(context.primaryWorktree, localBranch);
  if (inUse) {
    throw new Error(`Branch is already checked out in ${inUse.worktree}`);
  }
  const setUpstream = Boolean(input?.setUpstream);
  return {
    mode,
    projectID: context.projectID,
    primaryWorktree: context.primaryWorktree,
    candidateName: candidate.name,
    worktreeAddArgs,
    localBranch,
    fetchRemote,
    fetchBranch,
    setUpstream,
    upstreamRemote: String(input?.upstreamRemote || inferredUpstream?.remote || '').trim(),
    upstreamBranch: String(input?.upstreamBranch || inferredUpstream?.branch || '').trim(),
    ensureRemoteName,
    ensureRemoteUrl,
    startCommand: String(input?.startCommand || '').trim(),
    inferredUpstream,
  };
};

export async function createWorktree(directory, input = {}) {
  const mode = input?.mode === 'existing' ? 'existing' : 'new';
  if (mode === 'new') assertBranchCreationAllowed();
  const context = await resolveWorktreeProjectContext(directory);
  const bootstrapRuntime = await requireWorktreeBootstrapRuntime();
  await fsp.mkdir(context.worktreeRoot, { recursive: true });

  const preferredName = String(input?.worktreeName || input?.name || '').trim();
  const preferredBranchName = cleanBranchName(String(input?.branchName || '').trim());
  const startRef = normalizeStartRef(input?.startRef);
  const ensureRemoteName = String(input?.ensureRemoteName || '').trim();
  const ensureRemoteUrl = String(input?.ensureRemoteUrl || '').trim();
  const idempotencyKey = String(input?.idempotencyKey || '').trim()
    || `worktree_${crypto.randomUUID().replaceAll('-', '')}`;
  const fingerprint = bootstrapRuntime.fingerprint({
    ...input,
    idempotencyKey: undefined,
    primaryWorktree: context.primaryWorktree,
  });
  let existingReceipt = await bootstrapRuntime.getByIdempotency(idempotencyKey);
  let candidate = null;
  let metadata = null;
  if (!existingReceipt) {
    try {
      candidate = await resolveCandidateDirectory(
        context.worktreeRoot,
        preferredName,
        mode === 'new' && preferredBranchName ? preferredBranchName : '',
        context.primaryWorktree,
      );
      metadata = await buildWorktreeCreationMetadata({
        mode,
        context,
        candidate,
        input,
        preferredBranchName,
        startRef,
        ensureRemoteName,
        ensureRemoteUrl,
      });
    } catch (error) {
      existingReceipt = await bootstrapRuntime.getByIdempotency(idempotencyKey);
      if (!existingReceipt) throw error;
    }
  }
  const begun = await bootstrapRuntime.beginOperation({
    idempotencyKey,
    fingerprint,
    ownerId: String(input?.ownerId || getRequestPrincipal()?.id || 'local-admin'),
    directory: existingReceipt?.directory ?? candidate?.directory,
    ...(metadata ? { metadata } : {}),
  });
  const operationId = begun.receipt.operationId;
  if (begun.replay && begun.receipt.result) {
    return {
      ...begun.receipt.result,
      name: String(
        begun.receipt.result.name
        || begun.receipt.metadata?.candidateName
        || path.basename(begun.receipt.directory),
      ),
      operationId,
      bootstrap: begun.receipt,
    };
  }
  if (
    begun.replay
    && ['failed', 'needs_attention', 'removed'].includes(begun.receipt.status)
  ) {
    const error = new Error(
      begun.receipt.error || `Worktree operation is ${begun.receipt.status}`,
    );
    error.operationId = operationId;
    error.bootstrap = begun.receipt;
    throw error;
  }
  const worktreeDirectory = begun.receipt.directory;

  try {
    await bootstrapRuntime.executeStage(operationId, 'prepare_remote');
    await bootstrapRuntime.executeStage(operationId, 'create_worktree');
    await bootstrapRuntime.executeStage(operationId, 'sync_project_metadata');

  const headResult = await runGitCommand(worktreeDirectory, ['rev-parse', 'HEAD']);
  const head = String(headResult.stdout || '').trim();
  const result = {
    head,
    name: String(begun.receipt.metadata?.candidateName || path.basename(worktreeDirectory)),
    branch: String(begun.receipt.metadata?.localBranch || ''),
    path: worktreeDirectory,
  };
  await bootstrapRuntime.setResult(operationId, result);
  void bootstrapRuntime.queue(operationId);
  return {
    ...result,
    operationId,
    bootstrap: await bootstrapRuntime.getReceipt(operationId),
  };
  } catch (cause) {
    const current = await bootstrapRuntime.getReceipt(operationId).catch(() => null);
    const bootstrap = current && ['failed', 'needs_attention', 'removed'].includes(current.status)
      ? current
      : await bootstrapRuntime.fail(operationId, cause);
    const error = cause instanceof Error ? cause : new Error(String(cause));
    error.operationId = operationId;
    error.bootstrap = bootstrap;
    throw error;
  }
}

export async function getWorktreeBootstrapStatus(directory) {
  const runtime = await requireWorktreeBootstrapRuntime();
  return runtime.getByDirectory(directory);
}

export async function getWorktreeBootstrapOperation(operationId) {
  const runtime = await requireWorktreeBootstrapRuntime();
  return runtime.getReceipt(operationId);
}

export async function listActiveWorktreeBootstrapOperations() {
  const runtime = await requireWorktreeBootstrapRuntime();
  return runtime.listActive();
}

export async function retryWorktreeBootstrapOperation(operationId) {
  const runtime = await requireWorktreeBootstrapRuntime();
  const receipt = await runtime.getReceipt(operationId);
  if (receipt.metadata?.mode === 'new') assertBranchCreationAllowed();
  return runtime.retry(operationId);
}

const removeWorktreeNow = async (directory, input, targetDirectory, bootstrapRuntime) => {
  const context = await resolveWorktreeProjectContext(directory);
  const deleteLocalBranch = input?.deleteLocalBranch === true;

  const targetCanonical = await canonicalPath(targetDirectory);
  const primaryCanonical = await canonicalPath(context.primaryWorktree);
  if (targetCanonical === primaryCanonical) {
    throw new Error('Cannot remove the primary workspace');
  }
  const worktreeRootCanonical = await canonicalPath(context.worktreeRoot);

  const entries = await listWorktreeEntries(context.primaryWorktree);
  const matchedEntry = await (async () => {
    for (const entry of entries) {
      if (!entry?.worktree) {
        continue;
      }
      const entryCanonical = await canonicalPath(entry.worktree);
      if (entryCanonical === targetCanonical) {
        return entry;
      }
    }
    return null;
  })();

  if (!matchedEntry?.worktree) {
    // The directory is not a registered git worktree (orphaned metadata). Only
    // delete it from disk when it lives INSIDE the managed worktree root —
    // never the root itself, and never an arbitrary path outside it. Unmanaged
    // orphans are forgotten (metadata cleaned up below) without touching disk.
    const isManagedOrphan = targetCanonical !== worktreeRootCanonical
      && isInsideOrSameDirectory(worktreeRootCanonical, targetCanonical);

    const targetExists = await checkPathExists(targetDirectory);
    if (targetExists && isManagedOrphan) {
      await fsp.rm(targetDirectory, { recursive: true, force: true });
    }

    try {
      await syncProjectSandboxRemove(context.projectID, context.primaryWorktree, targetDirectory);
    } catch (error) {
      console.warn('Failed to sync OpenCode sandbox metadata (remove):', error instanceof Error ? error.message : String(error));
    }

    await bootstrapRuntime.markRemoved(targetDirectory);

    return { removedPath: targetCanonical };
  }

  await runGitCommandOrThrow(
    context.primaryWorktree,
    ['worktree', 'remove', '--force', matchedEntry.worktree],
    'Failed to remove git worktree'
  );

  if (deleteLocalBranch) {
    const branchName = cleanBranchName(String(matchedEntry.branchRef || matchedEntry.branch || '').trim());
    if (branchName) {
      await runGitCommandOrThrow(
        context.primaryWorktree,
        ['branch', '-D', branchName],
        `Failed to delete local branch ${branchName}`
      );
    }
  }

  try {
    await syncProjectSandboxRemove(context.projectID, context.primaryWorktree, matchedEntry.worktree);
  } catch (error) {
    console.warn('Failed to sync OpenCode sandbox metadata (remove):', error instanceof Error ? error.message : String(error));
  }

  await bootstrapRuntime.markRemoved(matchedEntry.worktree);

  return { removedPath: await canonicalPath(matchedEntry.worktree) };
};

export async function removeWorktree(directory, input = {}) {
  const targetDirectory = normalizeDirectoryPath(input?.directory);
  if (!targetDirectory) {
    throw new Error('Worktree directory is required');
  }
  const bootstrapRuntime = await requireWorktreeBootstrapRuntime();
  return bootstrapRuntime.runDirectoryMaintenance(
    targetDirectory,
    () => removeWorktreeNow(directory, input, targetDirectory, bootstrapRuntime),
  );
}

export async function deleteBranch(directory, branch, options = {}) {
  const git = await createGit(directory);

  try {
    const branchName = branch.startsWith('refs/heads/')
      ? branch.substring('refs/heads/'.length)
      : branch;
    const args = ['branch', options.force ? '-D' : '-d', branchName];
    await git.raw(args);
    return { success: true };
  } catch (error) {
    console.error('Failed to delete branch:', error);
    throw error;
  }
}

export async function resolveBaseRefForLog(from, checkRef) {
  const baseRef = typeof from === 'string' ? from.trim() : '';
  if (!baseRef) {
    return baseRef;
  }

  if (baseRef.startsWith('origin/') || baseRef.startsWith('refs/remotes/')) {
    return baseRef;
  }

  const baseBranch = baseRef.startsWith('refs/heads/')
    ? baseRef.substring('refs/heads/'.length)
    : baseRef;

  if (await checkRef(`refs/heads/${baseBranch}`)) {
    return baseRef;
  }

  if (await checkRef(`refs/tags/${baseRef}`)) {
    return baseRef;
  }

  const originCandidate = `refs/remotes/origin/${baseBranch}`;
  if (await checkRef(originCandidate)) {
    return `origin/${baseBranch}`;
  }

  if (await checkRef(baseRef)) {
    return baseRef;
  }

  return baseRef;
}

export async function getLog(directory, options = {}) {
  const git = await createGit(directory);

  try {
    const maxCount = options.maxCount || 50;
    const isDefaultCurrentBranchLog = !options.from && !options.to && !options.file;

    // Per-commit sync status is only meaningful for the default log range
    // (current branch's HEAD vs. its upstream). When a custom range is
    // requested we skip the extra plumbing and leave the fields undefined.
    let hasUpstream = false;
    let headHash = null;
    let upstream = null;
    let upstreamHash = null;
    let mergeBaseHash = null;
    let remoteHashes = null;

    if (isDefaultCurrentBranchLog) {
      try {
        headHash = (await git.raw(['rev-parse', 'HEAD'])).trim() || null;
      } catch {
        headHash = null;
      }

      if (headHash) {
        try {
          upstream = (await git.raw(['rev-parse', '--abbrev-ref', '@{upstream}'])).trim() || null;
        } catch {
          upstream = null;
        }

        if (upstream) {
          try {
            upstreamHash = (await git.raw(['rev-parse', upstream])).trim() || null;
            mergeBaseHash = (await git.raw(['merge-base', 'HEAD', upstream])).trim() || null;
            const revList = await git.raw(['rev-list', `--max-count=${maxCount}`, upstream]);
            remoteHashes = new Set(
              revList
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean)
            );
            hasUpstream = true;
          } catch {
            upstreamHash = null;
            mergeBaseHash = null;
            remoteHashes = null;
            hasUpstream = false;
          }
        }
	      }
	    }

    const checkRef = async (ref) => {
      try {
        await git.raw(['rev-parse', '--verify', ref]);
        return true;
      } catch {
        return false;
      }
    };
    const resolvedFrom = options.from
      ? await resolveBaseRefForLog(options.from, checkRef)
      : '';

    const revisionArgs = [];
    if (options.from && options.to) {
      revisionArgs.push(`${resolvedFrom}..${options.to}`);
    } else if (options.from) {
      revisionArgs.push(`${resolvedFrom}..HEAD`);
    } else if (options.to) {
      revisionArgs.push(options.to);
    } else if (hasUpstream && upstream) {
      // Include both tips so remote-only commits remain visible when local is
      // behind. Plain `HEAD` would hide the current `origin/main` position.
      revisionArgs.push('HEAD', upstream);
    }

    const logArgs = [
      'log',
      `--max-count=${maxCount}`,
      '--date=iso',
      '--pretty=format:%x1e%H%x1f%an%x1f%ae%x1f%ad%x1f%s',
      '--shortstat',
      ...revisionArgs
    ];

    if (options.file) {
      logArgs.push('--', options.file);
    }

    const rawLog = await git.raw(logArgs);
    const records = rawLog
      .split('\x1e')
      .map((entry) => entry.trim())
      .filter(Boolean);

    const entries = records.map((record) => {
      const lines = record.split('\n').filter((line) => line.trim().length > 0);
      const header = lines.shift() || '';
      const [hash, authorName, authorEmail, date, message] = header.split('\x1f');

      let filesChanged = 0;
      let insertions = 0;
      let deletions = 0;

      lines.forEach((line) => {
        const filesMatch = line.match(/(\d+)\s+files?\s+changed/);
        const insertMatch = line.match(/(\d+)\s+insertions?\(\+\)/);
        const deleteMatch = line.match(/(\d+)\s+deletions?\(-\)/);

        if (filesMatch) {
          filesChanged = parseInt(filesMatch[1], 10);
        }
        if (insertMatch) {
          insertions = parseInt(insertMatch[1], 10);
        }
        if (deleteMatch) {
          deletions = parseInt(deleteMatch[1], 10);
        }
      });

      return {
        hash,
        date: date || '',
        message: message || '',
        refs: '',
        body: '',
        author_name: authorName || '',
        author_email: authorEmail || '',
        filesChanged,
        insertions,
        deletions
      };
    }).filter((entry) => entry.hash);

    const resolveTotal = async () => {
      if (options.file) {
	        const baseLog = await git.log({
	          maxCount,
	          from: resolvedFrom || options.from,
	          to: options.to,
	          file: options.file
	        });
        return baseLog.total;
      }

      const countArgs = ['rev-list', '--count', ...revisionArgs];
      if (countArgs.length === 2) {
        countArgs.push('HEAD');
      }

      const rawCount = await git.raw(countArgs);
      const parsedCount = parseInt(rawCount.trim(), 10);
      return Number.isFinite(parsedCount) ? parsedCount : entries.length;
    };

    const merged = entries.map((entry) => {
      const base = {
        hash: entry.hash,
        date: entry.date,
        message: entry.message,
        refs: entry.refs || '',
        body: entry.body || '',
        author_name: entry.author_name,
        author_email: entry.author_email,
        filesChanged: entry.filesChanged,
        insertions: entry.insertions,
        deletions: entry.deletions
      };

      if (!hasUpstream) {
        return {
          ...base,
          isHead: headHash ? entry.hash === headHash : false,
          isRemoteHead: false
        };
      }

      return {
        ...base,
        syncStatus: remoteHashes && remoteHashes.has(entry.hash) ? 'remote' : 'local',
        isHead: headHash ? entry.hash === headHash : false,
        isRemoteHead: upstreamHash ? entry.hash === upstreamHash : false,
        isSyncPoint: mergeBaseHash ? entry.hash === mergeBaseHash : false
      };
    });

    return {
      all: merged,
      latest: merged[0] || null,
      total: await resolveTotal(),
      hasUpstream
    };
  } catch (error) {
    console.error('Failed to get log:', error);
    throw error;
  }
}

export async function isLinkedWorktree(directory) {
  const git = await createGit(directory);
  try {
    const [gitDir, gitCommonDir] = await Promise.all([
      git.raw(['rev-parse', '--git-dir']).then((output) => output.trim()),
      git.raw(['rev-parse', '--git-common-dir']).then((output) => output.trim())
    ]);
    return gitDir !== gitCommonDir;
  } catch (error) {
    console.error('Failed to determine worktree type:', error);
    return false;
  }
}

export async function validateWorktreeDirectory(directory, worktreeRoot) {
  const directoryPath = normalizeDirectoryPath(directory);
  const rootPath = normalizeDirectoryPath(worktreeRoot);

  if (!directoryPath || !rootPath) {
    return {
      valid: false,
      insideWorktreeRoot: false,
      resolvedWorktreeRoot: null,
      resolvedCwd: null,
    };
  }

  const isRepo = await isInsideGitWorktree(directoryPath);
  if (!isRepo) {
    return {
      valid: false,
      insideWorktreeRoot: false,
      resolvedWorktreeRoot: null,
      resolvedCwd: null,
    };
  }

  const resolvedCwd = await canonicalPath(directoryPath);
  const resolvedRoot = await canonicalPath(rootPath);

  const inside = resolvedCwd.startsWith(resolvedRoot + path.sep) || resolvedCwd === resolvedRoot;

  return {
    valid: true,
    insideWorktreeRoot: inside,
    resolvedWorktreeRoot: resolvedRoot,
    resolvedCwd,
  };
}

export async function canonicalizeWorktreeState(directory) {
  const directoryPath = normalizeDirectoryPath(directory);

  if (!directoryPath) {
    return {
      worktreeRoot: null,
      cwd: null,
      branch: null,
      headState: 'detached',
      worktreeStatus: 'not-a-repo',
      legacy: false,
      degraded: false,
      attentionReason: null,
    };
  }

  const isRepo = await isInsideGitWorktree(directoryPath);
  if (!isRepo) {
    return {
      worktreeRoot: null,
      cwd: null,
      branch: null,
      headState: 'detached',
      worktreeStatus: 'not-a-repo',
      legacy: false,
      degraded: false,
      attentionReason: null,
    };
  }

  let cwd = await canonicalPath(directoryPath);
  const git = await createGit(directoryPath);

  let worktreeRoot = null;
  let worktreeStatus = 'ready';
  let headState = /** @type {'branch' | 'detached' | 'unborn'} */ ('branch');
  let branch = null;
  let attentionReason = /** @type {'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | null} */ (null);

  try {
    const context = await resolveWorktreeProjectContext(directoryPath);
    const topLevel = await canonicalPath(context.sandbox);
    worktreeRoot = topLevel;
    cwd = topLevel;
  } catch {
    worktreeStatus = 'invalid';
    const topLevel = await git.raw(['rev-parse', '--show-toplevel']).then((value) => String(value || '').trim()).catch(() => '');
    if (topLevel) {
      const canonicalTopLevel = await canonicalPath(path.resolve(directoryPath, topLevel));
      worktreeRoot = canonicalTopLevel;
      cwd = canonicalTopLevel;
    }
  }

  try {
    const symbolicRef = await git.raw(['symbolic-ref', '-q', 'HEAD']).catch(() => '');
    if (symbolicRef.trim()) {
      headState = 'branch';
      branch = cleanBranchName(symbolicRef.trim());
    } else {
      const revParse = await git.raw(['rev-parse', 'HEAD']).catch(() => '');
      if (!revParse.trim()) {
        headState = 'unborn';
        branch = null;
      } else {
        headState = 'detached';
        branch = revParse.trim().slice(0, 7);
      }
    }
  } catch {
    headState = 'unborn';
    branch = null;
  }

  // Detect attention reasons from getStatus side-effects
  try {
    const status = await git.status(['-uall']);
    if (status.current && (await git.raw(['rev-parse', '--verify', 'MERGE_HEAD']).then(() => true).catch(() => false))) {
      attentionReason = 'merge';
    } else {
      const rebaseMerge = await fsp.stat(path.join(directoryPath, '.git', 'rebase-merge')).then(() => true).catch(() => false);
      const rebaseApply = await fsp.stat(path.join(directoryPath, '.git', 'rebase-apply')).then(() => true).catch(() => false);
      if (rebaseMerge || rebaseApply) {
        attentionReason = 'rebase';
      } else if (status.conflicted && status.conflicted.length > 0) {
        const cherryPickHead = await fsp.stat(path.join(directoryPath, '.git', 'CHERRY_PICK_HEAD')).then(() => true).catch(() => false);
        const revertHead = await fsp.stat(path.join(directoryPath, '.git', 'REVERT_HEAD')).then(() => true).catch(() => false);
        if (cherryPickHead) attentionReason = 'cherry-pick';
        else if (revertHead) attentionReason = 'revert';
      }
    }
  } catch {
    // Status check failed — ignore
  }

  return {
    worktreeRoot,
    cwd,
    branch,
    headState,
    worktreeStatus,
    legacy: false,
    degraded: false,
    attentionReason,
  };
}

export async function getCommitFiles(directory, commitHash) {
  const git = await createGit(directory);

  try {

    const numstatRaw = await git.raw([
      'show',
      '--numstat',
      '--format=',
      commitHash
    ]);

    const files = [];
    const lines = numstatRaw.trim().split('\n').filter(Boolean);

    for (const line of lines) {
      const parts = line.split('\t');
      if (parts.length < 3) continue;

      const [insertionsRaw, deletionsRaw, ...pathParts] = parts;
      const filePath = pathParts.join('\t');
      if (!filePath) continue;

      const insertions = insertionsRaw === '-' ? 0 : parseInt(insertionsRaw, 10) || 0;
      const deletions = deletionsRaw === '-' ? 0 : parseInt(deletionsRaw, 10) || 0;
      const isBinary = insertionsRaw === '-' && deletionsRaw === '-';

      let changeType = 'M';
      let displayPath = filePath;

      if (filePath.includes(' => ')) {
        changeType = 'R';

        const match = filePath.match(/(?:\{[^}]*\s=>\s[^}]*\}|.*\s=>\s.*)/);
        if (match) {
          displayPath = filePath;
        }
      }

      files.push({
        path: displayPath,
        insertions,
        deletions,
        isBinary,
        changeType
      });
    }

    const nameStatusRaw = await git.raw([
      'show',
      '--name-status',
      '--format=',
      commitHash
    ]).catch(() => '');

    const statusMap = new Map();
    const statusLines = nameStatusRaw.trim().split('\n').filter(Boolean);
    for (const line of statusLines) {
      const match = line.match(/^([AMDRC])\d*\t(.+)$/);
      if (match) {
        const [, status, path] = match;
        statusMap.set(path, status);
      }
    }

    for (const file of files) {
      const basePath = file.path.includes(' => ')
        ? file.path.split(' => ').pop()?.replace(/[{}]/g, '') || file.path
        : file.path;

      const status = statusMap.get(basePath) || statusMap.get(file.path);
      if (status) {
        file.changeType = status;
      }
    }

    return { files };
  } catch (error) {
    console.error('Failed to get commit files:', error);
    throw error;
  }
}

export async function renameBranch(directory, oldName, newName) {
  const git = await createGit(directory);

  try {
    const normalizedOldName = cleanBranchName(String(oldName || '').trim());
    const normalizedNewName = cleanBranchName(String(newName || '').trim());

    const previousRemote = await git
      .raw(['config', '--get', `branch.${normalizedOldName}.remote`])
      .then((value) => String(value || '').trim())
      .catch(() => '');
    const previousMerge = await git
      .raw(['config', '--get', `branch.${normalizedOldName}.merge`])
      .then((value) => String(value || '').trim())
      .catch(() => '');

    // Use git branch -m command to rename the branch
    await git.raw(['branch', '-m', oldName, newName]);

    if (previousRemote && previousMerge && normalizedNewName) {
      const previousMergeBranch = cleanBranchName(previousMerge);
      const nextMergeBranch =
        previousMergeBranch === normalizedOldName
          ? normalizedNewName
          : previousMergeBranch;
      const upstream = normalizeUpstreamTarget(previousRemote, nextMergeBranch);

      if (upstream) {
        try {
          await runGitCommandOrThrow(
            directory,
            ['branch', `--set-upstream-to=${upstream.full}`, normalizedNewName],
            `Failed to set upstream to ${upstream.full}`
          );
        } catch {
          await setBranchTrackingFallback(directory, normalizedNewName, upstream);
        }
      }
    }

    return { success: true, branch: newName };
  } catch (error) {
    console.error('Failed to rename branch:', error);
    throw error;
  }
}

export async function getRemotes(directory) {
  const git = await createGit(directory);

  try {
    const remotes = await git.getRemotes(true);
    
    const { principal } = resolveManagedGitAssignment(directory);
    return remotes
      .filter((remote) => !principal || principal.role === 'admin' || remote.name === 'origin')
      .map((remote) => ({
      name: remote.name,
      fetchUrl: remote.refs.fetch,
      pushUrl: remote.refs.push
    }));
  } catch (error) {
    if (isNotGitRepositoryError(error)) {
      return [];
    }
    console.error('Failed to get remotes:', error);
    throw error;
  }
}

export async function removeRemote(directory, options = {}) {
  const remoteName = String(options.remote || '').trim();
  if (!remoteName) {
    throw new Error('remote is required to remove a remote');
  }
  if (remoteName === 'origin') {
    throw new Error('Cannot remove origin remote');
  }

  const git = await createGit(directory);

  try {
    await git.removeRemote(remoteName);
    return { success: true };
  } catch (error) {
    console.error('Failed to remove remote:', error);
    throw error;
  }
}

export async function rebase(directory, options = {}) {
  const git = await createGit(directory);

  try {
    let { onto } = options;
    if (!onto) {
      throw new Error('onto parameter is required for rebase');
    }
    const assignment = await assertManagedMutationBranch(directory, git);
    if (assignment) onto = await validateManagedSourceRef(directory, onto);

    await git.rebase([onto]);

    return {
      success: true,
      conflict: false
    };
  } catch (error) {
    if (isGitConflictError(error)) return readConflictResult(git);

    console.error('Failed to rebase:', error);
    throw error;
  }
}

export async function abortRebase(directory) {
  const git = await createGit(directory);

  try {
    await assertManagedMutationBranch(directory, git);
    await git.rebase(['--abort']);
    return { success: true };
  } catch (error) {
    console.error('Failed to abort rebase:', error);
    throw error;
  }
}

export async function merge(directory, options = {}) {
  const git = await createGit(directory);

  try {
    let { branch } = options;
    if (!branch) {
      throw new Error('branch parameter is required for merge');
    }
    const assignment = await assertManagedMutationBranch(directory, git);
    if (assignment) branch = await validateManagedSourceRef(directory, branch);

    await git.merge([branch]);

    return {
      success: true,
      conflict: false
    };
  } catch (error) {
    if (isGitConflictError(error)) return readConflictResult(git);

    console.error('Failed to merge:', error);
    throw error;
  }
}

export async function abortMerge(directory) {
  const git = await createGit(directory);

  try {
    await assertManagedMutationBranch(directory, git);
    await git.merge(['--abort']);
    return { success: true };
  } catch (error) {
    console.error('Failed to abort merge:', error);
    throw error;
  }
}

export async function continueRebase(directory) {
  const directoryPath = normalizeDirectoryPath(directory);
  const git = await createGit(directoryPath);

  try {
    await assertManagedMutationBranch(directoryPath, git);
    // Set GIT_EDITOR to prevent editor prompts
    await git.env('GIT_EDITOR', 'true').rebase(['--continue']);
    return { success: true, conflict: false };
  } catch (error) {
    const errorMessage = String(error?.message || error || '').toLowerCase();
    const isConflict = isGitConflictError(error);

    if (isConflict) {
      const status = await git.status().catch(() => ({ conflicted: [] }));
      return {
        success: false,
        conflict: true,
        conflictFiles: status.conflicted || []
      };
    }

    // Check for "nothing to commit" which means rebase step is complete
    if (errorMessage.includes('nothing to commit') || errorMessage.includes('no changes')) {
      // Skip this commit and continue
      try {
        await git.env('GIT_EDITOR', 'true').rebase(['--skip']);
        return { success: true, conflict: false };
      } catch {
        // If skip also fails, the rebase may be complete
        return { success: true, conflict: false };
      }
    }

    console.error('Failed to continue rebase:', error);
    throw error;
  }
}

export async function continueMerge(directory) {
  const directoryPath = normalizeDirectoryPath(directory);
  const git = await createGit(directoryPath);

  try {
    await assertManagedMutationBranch(directoryPath, git);
    // Check if there are still unmerged files
    const status = await git.status();
    if (status.conflicted && status.conflicted.length > 0) {
      return {
        success: false,
        conflict: true,
        conflictFiles: status.conflicted
      };
    }

    // For merge, we commit after resolving conflicts
    // Use --no-edit to use the default merge commit message
    await git.env('GIT_EDITOR', 'true').commit([], { '--no-edit': null });
    return { success: true, conflict: false };
  } catch (error) {
    const errorMessage = String(error?.message || error || '').toLowerCase();
    const isConflict = isGitConflictError(error);

    if (isConflict) {
      const status = await git.status().catch(() => ({ conflicted: [] }));
      return {
        success: false,
        conflict: true,
        conflictFiles: status.conflicted || []
      };
    }

    // "nothing to commit" can happen if all conflicts resolved to one side
    if (errorMessage.includes('nothing to commit') || errorMessage.includes('no changes added')) {
      // The merge is effectively complete (all changes already committed or no changes needed)
      return { success: true, conflict: false };
    }

    console.error('Failed to continue merge:', error);
    throw error;
  }
}

export async function getConflictDetails(directory) {
  const directoryPath = normalizeDirectoryPath(directory);
  const git = await createGit(directoryPath);

  try {
    // Get git status --porcelain
    const statusPorcelain = await git.raw(['status', '--porcelain']).catch(() => '');

    // Get unmerged files
    const unmergedFilesRaw = await git.raw(['diff', '--name-only', '--diff-filter=U']).catch(() => '');
    const unmergedFiles = unmergedFilesRaw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    // Get current diff
    const diff = await git.raw(['diff']).catch(() => '');

    // Detect operation type and get head info
    let operation = 'merge';
    let headInfo = '';

    // Check for MERGE_HEAD (merge in progress)
    const mergeHeadExists = await git
      .raw(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])
      .then(() => true)
      .catch(() => false);

    if (mergeHeadExists) {
      operation = 'merge';
      const mergeHead = await git.raw(['rev-parse', 'MERGE_HEAD']).catch(() => '');
      const mergeMsg = await fsp
        .readFile(path.join(directoryPath, '.git', 'MERGE_MSG'), 'utf8')
        .catch(() => '');
      headInfo = `MERGE_HEAD: ${mergeHead.trim()}\n${mergeMsg}`;
    } else {
      // Check for REBASE_HEAD (rebase in progress)
      const rebaseHeadExists = await git
        .raw(['rev-parse', '--verify', '--quiet', 'REBASE_HEAD'])
        .then(() => true)
        .catch(() => false);

      if (rebaseHeadExists) {
        operation = 'rebase';
        const rebaseHead = await git.raw(['rev-parse', 'REBASE_HEAD']).catch(() => '');
        headInfo = `REBASE_HEAD: ${rebaseHead.trim()}`;
      }
    }

    return {
      statusPorcelain: statusPorcelain.trim(),
      unmergedFiles,
      diff: diff.trim(),
      headInfo: headInfo.trim(),
      operation,
    };
  } catch (error) {
    console.error('Failed to get conflict details:', error);
    throw error;
  }
}
