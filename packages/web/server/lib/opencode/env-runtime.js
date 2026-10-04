import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergePathValues } from './path-utils.js';

const SHELL_PROBE_TIMEOUT_MS = 5_000;
const DISCOVERY_PROBE_BUDGET_MS = 10_000;

export const createOpenCodeEnvRuntime = (deps) => {
  const {
    state,
    homeDirectory = os.homedir(),
    environmentPath = process.env.PATH || '',
    executeProbe = spawnSync,
    probeNow = () => performance.now(),
    probeTimeoutMs = SHELL_PROBE_TIMEOUT_MS,
    probeBudgetMs = DISCOVERY_PROBE_BUDGET_MS,
    shellCandidates,
    isExecutable: executableOverride,
  } = deps;

  // A logical discovery owns one runner, including nested WSL probes. The clock
  // starts at its first subprocess, not while checking configured paths/cache.
  const createProbeRunner = () => {
    let deadline;
    return (executable, args, options = {}) => {
      const now = probeNow();
      deadline ??= now + probeBudgetMs;
      const remaining = Math.floor(deadline - now);
      if (remaining <= 0) return null;
      const timeout = Math.max(1, Math.min(options.timeout ?? probeTimeoutMs, remaining));
      try {
        const result = executeProbe(executable, args, { ...options, timeout, killSignal: 'SIGKILL' });
        // An errored/timed-out process can still have stdout. It is never an
        // authoritative environment or executable discovery result.
        if (!result || result.error || result.signal || result.status !== 0 || typeof result.stdout !== 'string'
          || probeNow() - now > timeout) return null;
        return result;
      } catch {
        return null;
      }
    };
  };

  const uniqueShellCandidates = () => [...new Set((shellCandidates ?? [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'])
    .filter((candidate) => typeof candidate === 'string' && candidate.length > 0))];

  const parseNullSeparatedEnvSnapshot = (raw) => {
    if (typeof raw !== 'string' || raw.length === 0) {
      return null;
    }

    const result = {};
    const entries = raw.split('\0');
    for (const entry of entries) {
      if (!entry) {
        continue;
      }
      const idx = entry.indexOf('=');
      if (idx === 0) continue; // CMD can include hidden drive-current-directory entries.
      if (idx < 0) return null;
      const key = entry.slice(0, idx);
      if (/[\r\n]/.test(key) || key.trim() !== key) return null;
      const value = entry.slice(idx + 1);
      result[key] = value;
    }

    return Object.keys(result).length > 0 ? result : null;
  };

  const isExecutable = (filePath) => {
    if (executableOverride) return executableOverride(filePath);
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return false;
      if (process.platform === 'win32') {
        const ext = path.extname(filePath).toLowerCase();
        if (!ext) return true;
        return ['.exe', '.cmd', '.bat', '.com'].includes(ext);
      }
      fs.accessSync(filePath, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };

  const searchPathFor = (binaryName) => {
    const trimmed = typeof binaryName === 'string' ? binaryName.trim() : '';
    if (!trimmed) {
      return null;
    }

    const current = environmentPath;
    const parts = current.split(path.delimiter).filter(Boolean);
    const candidateNames = [trimmed];

    if (process.platform === 'win32' && !path.extname(trimmed)) {
      const pathExt = process.env.PATHEXT || process.env.PathExt || '.COM;.EXE;.BAT;.CMD';
      for (const ext of pathExt.split(';')) {
        const normalizedExt = ext.trim();
        if (!normalizedExt) continue;
        const candidateName = `${trimmed}${normalizedExt.startsWith('.') ? normalizedExt : `.${normalizedExt}`}`;
        if (!candidateNames.some((existing) => existing.toLowerCase() === candidateName.toLowerCase())) {
          candidateNames.push(candidateName);
        }
      }
    }

    for (const dir of parts) {
      for (const candidateName of candidateNames) {
        const candidate = path.join(dir, candidateName);
        if (isExecutable(candidate)) {
          return candidate;
        }
      }
    }
    return null;
  };

  const prependToPath = (dir) => {
    const trimmed = typeof dir === 'string' ? dir.trim() : '';
    if (!trimmed) return;
    const current = process.env.PATH || '';
    const parts = current.split(path.delimiter).filter(Boolean);
    if (parts.includes(trimmed)) return;
    process.env.PATH = [trimmed, ...parts].join(path.delimiter);
  };

  const getWindowsShellEnvSnapshot = (probe) => {
    const parseResult = (stdout) => parseNullSeparatedEnvSnapshot(typeof stdout === 'string' ? stdout : '');

    const psScript =
      "Get-ChildItem Env: | ForEach-Object { [Console]::Out.Write($_.Name); [Console]::Out.Write('='); [Console]::Out.Write($_.Value); [Console]::Out.Write([char]0) }";

    const powershellCandidates = [
      'pwsh.exe',
      'powershell.exe',
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ];

    for (const shellPath of new Set(powershellCandidates)) {
      try {
        const result = probe(shellPath, ['-NoLogo', '-Command', psScript], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          maxBuffer: 10 * 1024 * 1024,
          windowsHide: true,
        });
        if (!result) {
          continue;
        }
        const parsed = parseResult(result.stdout);
        if (parsed) {
          return parsed;
        }
      } catch {
      }
    }

    const comspec = process.env.ComSpec || 'cmd.exe';
    try {
      const result = probe(comspec, ['/d', '/s', '/c', 'set'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      });
      if (result && result.stdout.length > 0) {
        return parseNullSeparatedEnvSnapshot(result.stdout.replace(/\r?\n/g, '\0'));
      }
    } catch {
    }

    return null;
  };

  const getLoginShellEnvSnapshot = () => {
    if (state.cachedLoginShellEnvSnapshot !== undefined) {
      return state.cachedLoginShellEnvSnapshot;
    }

    const probe = createProbeRunner();
    if (process.platform === 'win32') {
      const windowsSnapshot = getWindowsShellEnvSnapshot(probe);
      state.cachedLoginShellEnvSnapshot = windowsSnapshot;
      return windowsSnapshot;
    }

    for (const shellPath of uniqueShellCandidates()) {
      if (!isExecutable(shellPath)) {
        continue;
      }

      try {
        const result = probe(shellPath, ['-lic', 'env -0'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          maxBuffer: 10 * 1024 * 1024,
          windowsHide: true,
        });

        if (!result) {
          continue;
        }

        const parsed = parseNullSeparatedEnvSnapshot(result.stdout || '');
        if (parsed) {
          state.cachedLoginShellEnvSnapshot = parsed;
          return parsed;
        }
      } catch {
      }
    }

    state.cachedLoginShellEnvSnapshot = null;
    return null;
  };

  const applyLoginShellEnvSnapshot = () => {
    const snapshot = getLoginShellEnvSnapshot();
    if (!snapshot) {
      return;
    }

    const skipKeys = new Set(['PWD', 'OLDPWD', 'SHLVL', '_']);
    for (const [key, value] of Object.entries(snapshot)) {
      if (skipKeys.has(key)) {
        continue;
      }
      const existing = process.env[key];
      if (typeof existing === 'string' && existing.length > 0) {
        continue;
      }
      process.env[key] = value;
    }

    const currentPath = process.env.PATH || '';
    const shellPath = snapshot.PATH || '';
    if (!shellPath) {
      return;
    }

    process.env.PATH = mergePathValues(shellPath, currentPath, path.delimiter);
  };

  const resolveGitBinaryForSpawn = () => {
    if (process.platform !== 'win32') {
      return 'git';
    }

    if (state.resolvedGitBinary) {
      return state.resolvedGitBinary;
    }

    const explicit = [process.env.GIT_BINARY, process.env.OPENCHAMBER_GIT_BINARY]
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean);
    for (const candidate of explicit) {
      if (isExecutable(candidate)) {
        state.resolvedGitBinary = candidate;
        return state.resolvedGitBinary;
      }
    }

    const candidates = [];
    const normalizeGitCandidate = (candidate) => {
      if (typeof candidate !== 'string') {
        return '';
      }
      const trimmed = candidate.trim();
      if (!trimmed) {
        return '';
      }
      const ext = path.extname(trimmed).toLowerCase();
      if (ext === '.cmd' || ext === '.bat' || ext === '.com') {
        const exeCandidate = trimmed.slice(0, -ext.length) + '.exe';
        if (isExecutable(exeCandidate)) {
          return exeCandidate;
        }
      }
      return trimmed;
    };

    const pathCandidate = normalizeGitCandidate(searchPathFor('git'));
    if (pathCandidate && isExecutable(pathCandidate)) {
      candidates.push(pathCandidate);
    }

    const pathExeCandidate = normalizeGitCandidate(searchPathFor('git.exe'));
    if (pathExeCandidate && isExecutable(pathExeCandidate)) {
      candidates.push(pathExeCandidate);
    }

    const programRoots = [
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
      process.env.LocalAppData,
    ]
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean);
    for (const root of programRoots) {
      const installCandidates = [
        path.join(root, 'Git', 'cmd', 'git.exe'),
        path.join(root, 'Git', 'bin', 'git.exe'),
        path.join(root, 'Git', 'mingw64', 'bin', 'git.exe'),
        path.join(root, 'Programs', 'Git', 'cmd', 'git.exe'),
        path.join(root, 'Programs', 'Git', 'bin', 'git.exe'),
      ];
      for (const candidate of installCandidates) {
        const normalized = normalizeGitCandidate(candidate);
        if (normalized && isExecutable(normalized)) {
          candidates.push(normalized);
        }
      }
    }

    const preferredExe = candidates.find((candidate) => candidate.toLowerCase().endsWith('.exe'));
    state.resolvedGitBinary = preferredExe || candidates[0] || 'git.exe';
    return state.resolvedGitBinary;
  };

  return {applyLoginShellEnvSnapshot,getLoginShellEnvSnapshot,isExecutable,searchPathFor,resolveGitBinaryForSpawn};
};
