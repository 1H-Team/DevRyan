import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createDiagnosticSanitizer } from './sanitizer.js';

const MINIMUM_GIT_HOOK_RUN_VERSION = Object.freeze({ major: 2, minor: 36 });
const DEFAULT_HOOK_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30 * 1000;
const DEFAULT_CAPTURE_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_FAILURE_EXCERPT_BYTES = 8 * 1024;
const ZERO_COMMIT = '0000000000000000000000000000000000000000';

const stripTerminalControls = (value) => String(value || '')
  .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, '')
  .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');

const truncateUtf8 = (value, maxBytes) => {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  return `${bytes.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/u, '')}\n[output truncated]`;
};

const parseGitVersion = (value) => {
  const match = String(value || '').match(/\bgit version\s+(\d+)\.(\d+)(?:\.(\d+))?/i);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] || 0),
  };
};

const supportsGitHookRun = (version) => Boolean(version && (
  version.major > MINIMUM_GIT_HOOK_RUN_VERSION.major
  || (
    version.major === MINIMUM_GIT_HOOK_RUN_VERSION.major
    && version.minor >= MINIMUM_GIT_HOOK_RUN_VERSION.minor
  )
));

const terminateProcessGroup = (child, options, signal) => {
  if (!child?.pid) return;
  if (options.platform === 'win32') {
    try {
      const killer = options.spawnImpl('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.unref?.();
    } catch {
      child.kill?.(signal);
    }
    return;
  }
  try {
    options.processKill(-child.pid, signal);
  } catch {
    try {
      child.kill?.(signal);
    } catch {
      // The process may already have exited between the timeout and the kill.
    }
  }
};

export const runBoundedChildProcess = ({
  binary,
  args,
  cwd,
  env,
  timeoutMs,
  maxOutputBytes,
  spawnImpl = spawn,
  processKill = process.kill.bind(process),
  platform = process.platform,
  killGraceMs = 1_000,
}) => new Promise((resolve) => {
  const output = [];
  const stdout = [];
  const stderr = [];
  let capturedBytes = 0;
  let outputTruncated = false;
  let timedOut = false;
  let settled = false;
  let timeout = null;
  let hardKillTimeout = null;

  const append = (target, chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk || ''));
    const available = Math.max(0, maxOutputBytes - capturedBytes);
    if (available > 0) {
      const kept = bytes.subarray(0, available);
      output.push(kept);
      target.push(kept);
      capturedBytes += kept.length;
    }
    if (bytes.length > available) outputTruncated = true;
  };

  const finish = (result) => {
    if (settled) return;
    settled = true;
    if (timeout) clearTimeout(timeout);
    if (hardKillTimeout) clearTimeout(hardKillTimeout);
    resolve({
      ...result,
      timedOut,
      output: Buffer.concat(output).toString('utf8'),
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      capturedBytes,
      outputTruncated,
    });
  };

  let child;
  try {
    child = spawnImpl(binary, args, {
      cwd,
      env,
      windowsHide: true,
      detached: platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    finish({ exitCode: null, signal: null, error });
    return;
  }

  child.stdout?.on('data', (chunk) => append(stdout, chunk));
  child.stderr?.on('data', (chunk) => append(stderr, chunk));
  child.once('error', (error) => finish({ exitCode: null, signal: null, error }));
  child.once('close', (exitCode, signal) => finish({ exitCode, signal, error: null }));

  timeout = setTimeout(() => {
    timedOut = true;
    terminateProcessGroup(child, { platform, processKill, spawnImpl }, 'SIGTERM');
    hardKillTimeout = setTimeout(() => {
      terminateProcessGroup(child, { platform, processKill, spawnImpl }, 'SIGKILL');
    }, killGraceMs);
    hardKillTimeout.unref?.();
  }, timeoutMs);
  timeout.unref?.();
});

const hookError = (message, code, stageOutput) => {
  const error = new Error(message);
  error.code = code;
  error.stageOutput = stageOutput;
  return error;
};

export const createPostCheckoutHookRunner = (options = {}) => {
  const getGitBinary = typeof options.getGitBinary === 'function'
    ? options.getGitBinary
    : () => options.gitBinary || 'git';
  const getEnv = typeof options.getEnv === 'function'
    ? options.getEnv
    : async () => ({ ...process.env, GIT_TERMINAL_PROMPT: '0' });
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const stat = options.stat ?? fs.stat;
  const hookTimeoutMs = options.hookTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_CAPTURE_LIMIT_BYTES;
  const maxFailureExcerptBytes = options.maxFailureExcerptBytes ?? DEFAULT_FAILURE_EXCERPT_BYTES;
  const processOptions = {
    spawnImpl: options.spawnImpl ?? spawn,
    processKill: options.processKill ?? process.kill.bind(process),
    platform: options.platform ?? process.platform,
    killGraceMs: options.killGraceMs ?? 1_000,
  };
  let capabilityPromise = null;

  const runGit = async (binary, args, cwd, env, timeoutMs = commandTimeoutMs) => (
    runBoundedChildProcess({
      binary,
      args,
      cwd,
      env,
      timeoutMs,
      maxOutputBytes,
      ...processOptions,
    })
  );

  const sanitizeExcerpt = (value, cwd) => {
    const sanitizer = createDiagnosticSanitizer({
      homeDir: os.homedir(),
      worktreeRoots: [cwd],
    });
    const clean = sanitizer.sanitizeText(stripTerminalControls(value)).trim();
    return truncateUtf8(clean, maxFailureExcerptBytes);
  };

  const getCapability = (binary, cwd, env) => {
    capabilityPromise ??= runGit(binary, ['--version'], cwd, env).then((result) => {
      const version = parseGitVersion(`${result.stdout}\n${result.stderr}`);
      if (result.timedOut || result.error || result.exitCode !== 0 || !supportsGitHookRun(version)) {
        const detected = version
          ? `${version.major}.${version.minor}.${version.patch}`
          : 'unknown';
        throw hookError(
          `Running post-checkout hooks requires Git 2.36 or newer (detected ${detected}). Upgrade Git and retry setup.`,
          'GIT_HOOK_RUN_UNSUPPORTED',
          null,
        );
      }
      return version;
    });
    return capabilityPromise;
  };

  const resolveHookPath = async (binary, cwd, env) => {
    const configured = await runGit(binary, ['config', '--path', '--get', 'core.hooksPath'], cwd, env);
    if (configured.timedOut || configured.error || ![0, 1].includes(configured.exitCode)) {
      throw hookError(
        'Unable to resolve the effective Git hooks path. Check the repository Git configuration and retry setup.',
        'GIT_HOOK_PATH_FAILED',
        null,
      );
    }
    if (configured.exitCode === 0 && configured.stdout.trim()) {
      const configuredPath = configured.stdout.trim();
      return path.resolve(cwd, configuredPath, 'post-checkout');
    }

    const defaultPath = await runGit(binary, ['rev-parse', '--git-path', 'hooks/post-checkout'], cwd, env);
    if (defaultPath.timedOut || defaultPath.error || defaultPath.exitCode !== 0 || !defaultPath.stdout.trim()) {
      throw hookError(
        'Unable to resolve the repository post-checkout hook path. Verify the worktree and retry setup.',
        'GIT_HOOK_PATH_FAILED',
        null,
      );
    }
    return path.resolve(cwd, defaultPath.stdout.trim());
  };

  const run = async (directory) => {
    const cwd = path.resolve(directory);
    const startedAt = now();
    const binary = getGitBinary();
    const env = {
      ...(await getEnv(cwd)),
      GIT_TERMINAL_PROMPT: '0',
    };
    const hookPath = await resolveHookPath(binary, cwd, env);
    const presence = await stat(hookPath).then((entry) => entry.isFile()).catch(() => false);
    if (!presence) {
      return {
        presence: false,
        exitStatus: 0,
        durationMs: Math.max(0, now() - startedAt),
      };
    }

    try {
      await getCapability(binary, cwd, env);
    } catch (error) {
      if (error && typeof error === 'object') {
        throw hookError(error.message, error.code || 'GIT_HOOK_RUN_UNSUPPORTED', {
          presence: true,
          exitStatus: null,
          durationMs: Math.max(0, now() - startedAt),
          failureExcerpt: error.message,
        });
      }
      throw error;
    }

    const head = await runGit(binary, ['rev-parse', '--verify', 'HEAD'], cwd, env);
    if (head.timedOut || head.error || head.exitCode !== 0 || !head.stdout.trim()) {
      const failureExcerpt = sanitizeExcerpt(head.output || head.error?.message || '', cwd);
      throw hookError(
        failureExcerpt
          ? `Unable to resolve the new worktree HEAD: ${failureExcerpt}`
          : 'Unable to resolve the new worktree HEAD before running post-checkout.',
        'GIT_HOOK_HEAD_FAILED',
        {
          presence: true,
          exitStatus: head.exitCode,
          durationMs: Math.max(0, now() - startedAt),
          ...(failureExcerpt ? { failureExcerpt } : {}),
        },
      );
    }
    const newHead = head.stdout.trim().split(/\s+/u)[0];
    const hook = await runGit(
      binary,
      ['hook', 'run', '--ignore-missing', 'post-checkout', '--', ZERO_COMMIT, newHead, '1'],
      cwd,
      env,
      hookTimeoutMs,
    );
    const durationMs = Math.max(0, now() - startedAt);
    if (hook.timedOut) {
      const failureExcerpt = sanitizeExcerpt(hook.output, cwd);
      throw hookError(
        `post-checkout hook timed out after ${Math.round(hookTimeoutMs / 1000)} seconds. Review the hook before retrying setup.`,
        'GIT_HOOK_TIMEOUT',
        {
          presence: true,
          exitStatus: null,
          durationMs,
          ...(failureExcerpt ? { failureExcerpt } : {}),
        },
      );
    }
    if (hook.error || hook.exitCode !== 0) {
      const failureExcerpt = sanitizeExcerpt(hook.output || hook.error?.message || '', cwd);
      throw hookError(
        `post-checkout hook failed with exit status ${hook.exitCode ?? 'unknown'}${failureExcerpt ? `: ${failureExcerpt}` : ''}`,
        'GIT_HOOK_FAILED',
        {
          presence: true,
          exitStatus: hook.exitCode,
          durationMs,
          ...(failureExcerpt ? { failureExcerpt } : {}),
        },
      );
    }

    return {
      presence: true,
      exitStatus: 0,
      durationMs,
    };
  };

  return { run };
};

export {
  DEFAULT_CAPTURE_LIMIT_BYTES,
  DEFAULT_FAILURE_EXCERPT_BYTES,
  DEFAULT_HOOK_TIMEOUT_MS,
  MINIMUM_GIT_HOOK_RUN_VERSION,
  ZERO_COMMIT as POST_CHECKOUT_ZERO_COMMIT,
};
