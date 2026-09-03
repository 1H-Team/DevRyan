import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// v2 adds `workingDirectory`; v1 files (no such field) still read as null.
const REGISTRY_VERSION = 2;
const REGISTRY_FILE_NAME = 'managed-opencode-processes.json';

function getOpenChamberDataDir(env = process.env) {
  const configured = typeof env.OPENCHAMBER_DATA_DIR === 'string' ? env.OPENCHAMBER_DATA_DIR.trim() : '';
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.config', 'openchamber');
}

function buildContextModeStorageEnv(env = process.env) {
  const dataDir = getOpenChamberDataDir(env);
  return {
    CONTEXT_MODE_DATA_DIR: dataDir,
    CONTEXT_MODE_DIR: path.join(dataDir, 'context-mode'),
  };
}

function getManagedOpenCodeRegistryPath(options = {}) {
  if (typeof options.registryPath === 'string' && options.registryPath.trim()) {
    return path.resolve(options.registryPath);
  }
  return path.join(getOpenChamberDataDir(options.env), REGISTRY_FILE_NAME);
}

function normalizePositiveInteger(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.trunc(number);
}

function normalizeRegistryRecord(record) {
  if (!record || typeof record !== 'object') return null;
  const childPid = normalizePositiveInteger(record.childPid);
  const ownerPid = normalizePositiveInteger(record.ownerPid);
  if (!childPid || !ownerPid) return null;

  return {
    childPid,
    ownerPid,
    port: normalizePositiveInteger(record.port),
    binary: typeof record.binary === 'string' && record.binary.trim() ? record.binary.trim() : 'opencode',
    hostRuntime: typeof record.hostRuntime === 'string' && record.hostRuntime.trim() ? record.hostRuntime.trim() : 'web',
    hostname: typeof record.hostname === 'string' && record.hostname.trim() ? record.hostname.trim() : null,
    startedAt: Number.isFinite(record.startedAt) ? Math.trunc(record.startedAt) : Date.now(),
    workingDirectory: typeof record.workingDirectory === 'string' && record.workingDirectory.trim()
      ? record.workingDirectory.trim()
      : null,
  };
}

function readManagedOpenCodeRegistry(options = {}) {
  const registryPath = getManagedOpenCodeRegistryPath(options);
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    const rawRecords = Array.isArray(parsed?.processes) ? parsed.processes : [];
    return rawRecords.map(normalizeRegistryRecord).filter(Boolean);
  } catch {
    return [];
  }
}

// Registry writers on different processes (packaged app + dev web server) share
// one file; unlocked read-modify-write lets one clobber the other's record and
// leaves the dropped child as an untracked orphan.
const REGISTRY_LOCK_STALE_MS = 2_000;
const REGISTRY_LOCK_ACQUIRE_TIMEOUT_MS = 1_000;

function acquireRegistryLock(registryPath) {
  const lockPath = `${registryPath}.lock`;
  const deadline = Date.now() + REGISTRY_LOCK_ACQUIRE_TIMEOUT_MS;
  fs.mkdirSync(path.dirname(registryPath), { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      return lockPath;
    } catch (error) {
      if (error?.code !== 'EEXIST') return null;
    }
    try {
      if (Date.now() - fs.statSync(lockPath).mtimeMs > REGISTRY_LOCK_STALE_MS) {
        fs.rmdirSync(lockPath);
        continue;
      }
    } catch {
      continue;
    }
    if (Date.now() >= deadline) {
      // Proceed unlocked rather than fail the caller; contention is rare and
      // the fallback matches the historical (unlocked) behavior.
      return null;
    }
    const spinUntil = Date.now() + 25;
    while (Date.now() < spinUntil) {
      // Short busy-wait; the critical sections under this lock are tiny.
    }
  }
}

function releaseRegistryLock(lockPath) {
  if (!lockPath) return;
  try {
    fs.rmdirSync(lockPath);
  } catch {
  }
}

function withRegistryLock(options, fn) {
  const registryPath = getManagedOpenCodeRegistryPath(options);
  const lockPath = acquireRegistryLock(registryPath);
  try {
    return fn();
  } finally {
    releaseRegistryLock(lockPath);
  }
}

function writeManagedOpenCodeRegistry(records, options = {}) {
  const registryPath = getManagedOpenCodeRegistryPath(options);
  const normalized = Array.isArray(records)
    ? records.map(normalizeRegistryRecord).filter(Boolean)
    : [];
  fs.mkdirSync(path.dirname(registryPath), { recursive: true, mode: 0o700 });
  const tempPath = `${registryPath}.tmp.${process.pid}`;
  fs.writeFileSync(
    tempPath,
    JSON.stringify({ version: REGISTRY_VERSION, processes: normalized }, null, 2),
    { mode: 0o600 },
  );
  fs.renameSync(tempPath, registryPath);
  return normalized;
}

function registerManagedOpenCodeProcess(record, options = {}) {
  const normalized = normalizeRegistryRecord({
    ...record,
    ownerPid: record?.ownerPid ?? process.pid,
    startedAt: record?.startedAt ?? Date.now(),
  });
  if (!normalized) return null;

  withRegistryLock(options, () => {
    const existing = readManagedOpenCodeRegistry(options)
      .filter((entry) => entry.childPid !== normalized.childPid);
    writeManagedOpenCodeRegistry([...existing, normalized], options);
  });
  return normalized;
}

function unregisterManagedOpenCodeProcess(childPid, options = {}) {
  const normalizedChildPid = normalizePositiveInteger(childPid);
  if (!normalizedChildPid) return false;
  return withRegistryLock(options, () => {
    const existing = readManagedOpenCodeRegistry(options);
    const next = existing.filter((entry) => entry.childPid !== normalizedChildPid);
    if (next.length === existing.length) return false;
    writeManagedOpenCodeRegistry(next, options);
    return true;
  });
}

function isProcessRunning(pid, processKill = process.kill.bind(process)) {
  const normalizedPid = normalizePositiveInteger(pid);
  if (!normalizedPid) return false;
  try {
    processKill(normalizedPid, 0);
    return true;
  } catch {
    return false;
  }
}

function readProcessCommand(pid, options = {}) {
  const normalizedPid = normalizePositiveInteger(pid);
  if (!normalizedPid) return null;
  const spawnSyncImpl = typeof options.spawnSync === 'function' ? options.spawnSync : spawnSync;
  const platform = options.platform || process.platform;

  try {
    if (platform === 'win32') {
      const result = spawnSyncImpl('powershell.exe', [
        '-NoProfile',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${normalizedPid}").CommandLine`,
      ], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const output = typeof result.stdout === 'string' ? result.stdout.trim() : '';
      return result.status === 0 && output ? output : null;
    }

    const result = spawnSyncImpl('ps', ['-p', String(normalizedPid), '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const output = typeof result.stdout === 'string' ? result.stdout.trim() : '';
    return result.status === 0 && output ? output : null;
  } catch {
    return null;
  }
}

function isManagedOpenCodeProcessCommand(command, record) {
  if (typeof command !== 'string' || !command.trim()) return false;
  const normalized = command.replace(/\\/g, '/').replace(/\s+/g, ' ').trim().toLowerCase();
  const binaryBase = path.basename(record?.binary || 'opencode').toLowerCase();
  const binaryLooksRight = normalized.includes('opencode')
    || (binaryBase && normalized.includes(binaryBase));
  if (!binaryLooksRight || !/(?:^|\s)serve(?:$|\s)/.test(normalized)) {
    return false;
  }

  const port = normalizePositiveInteger(record?.port);
  if (!port) return true;
  return normalized.includes(`--port ${port}`)
    || normalized.includes(`--port=${port}`);
}

function waitForProcessExit(pid, timeoutMs, processKill = process.kill.bind(process)) {
  const normalizedPid = normalizePositiveInteger(pid);
  if (!normalizedPid) return Promise.resolve(true);
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve) => {
    const check = () => {
      if (!isProcessRunning(normalizedPid, processKill)) {
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      setTimeout(check, 150);
    };
    check();
  });
}

async function terminateManagedOpenCodePid(pid, options = {}) {
  const normalizedPid = normalizePositiveInteger(pid);
  if (!normalizedPid) return true;

  const platform = options.platform || process.platform;
  const spawnSyncImpl = typeof options.spawnSync === 'function' ? options.spawnSync : spawnSync;
  const processKill = typeof options.processKill === 'function' ? options.processKill : process.kill.bind(process);

  if (platform === 'win32') {
    try {
      spawnSyncImpl('taskkill', ['/pid', String(normalizedPid), '/t'], {
        stdio: 'ignore',
        timeout: 3000,
        windowsHide: true,
      });
    } catch {
    }
    if (await waitForProcessExit(normalizedPid, 1500, processKill)) return true;
    try {
      spawnSyncImpl('taskkill', ['/pid', String(normalizedPid), '/f', '/t'], {
        stdio: 'ignore',
        timeout: 5000,
        windowsHide: true,
      });
    } catch {
    }
    return waitForProcessExit(normalizedPid, 3000, processKill);
  }

  // Signal the group led by the target (falls back to the pid alone when it is
  // not a group leader) plus any explicitly listed descendants. Agent-spawned
  // children usually share the server's process group, so callers must pass
  // descendants instead of relying on a group kill reaching them.
  const descendantPids = Array.isArray(options.descendantPids)
    ? options.descendantPids.map(normalizePositiveInteger).filter((value) => value && value !== normalizedPid)
    : [];
  const signal = (targetPid, signalName) => {
    try {
      processKill(-targetPid, signalName);
    } catch {
      try {
        processKill(targetPid, signalName);
      } catch {
      }
    }
    for (const descendantPid of descendantPids) {
      try {
        processKill(descendantPid, signalName);
      } catch {
      }
    }
  };

  signal(normalizedPid, 'SIGTERM');
  if (await waitForProcessExit(normalizedPid, 2500, processKill)) return true;
  signal(normalizedPid, 'SIGKILL');
  return waitForProcessExit(normalizedPid, 1000, processKill);
}

async function reapOrphanedManagedOpenCodeProcesses(options = {}) {
  const records = readManagedOpenCodeRegistry(options);
  const isRunning = typeof options.isProcessRunning === 'function'
    ? options.isProcessRunning
    : (pid) => isProcessRunning(pid);
  const commandReader = typeof options.readProcessCommand === 'function'
    ? options.readProcessCommand
    : (pid) => readProcessCommand(pid, options);
  const terminator = typeof options.terminateManagedOpenCodePid === 'function'
    ? options.terminateManagedOpenCodePid
    : (pid) => terminateManagedOpenCodePid(pid, options);

  const kept = [];
  const reaped = [];
  const removed = [];
  const skipped = [];

  for (const record of records) {
    if (isRunning(record.ownerPid)) {
      kept.push(record);
      skipped.push({ ...record, reason: 'owner-alive' });
      continue;
    }

    if (!isRunning(record.childPid)) {
      removed.push({ ...record, reason: 'child-not-running' });
      continue;
    }

    const command = await Promise.resolve(commandReader(record.childPid)).catch(() => null);
    if (!isManagedOpenCodeProcessCommand(command, record)) {
      removed.push({ ...record, reason: 'command-mismatch' });
      continue;
    }

    const terminated = await Promise.resolve(terminator(record.childPid, record)).catch(() => false);
    reaped.push({ ...record, terminated });
  }

  // Remove only the records this sweep actually processed, from a fresh read:
  // terminations above can take seconds, and a wholesale write of `kept` would
  // clobber any record registered by another process mid-sweep.
  const processedChildPids = new Set([...reaped, ...removed].map((entry) => entry.childPid));
  withRegistryLock(options, () => {
    const current = readManagedOpenCodeRegistry(options);
    writeManagedOpenCodeRegistry(
      current.filter((entry) => !processedChildPids.has(entry.childPid)),
      options,
    );
  });
  return { kept, reaped, removed, skipped };
}

export {
  REGISTRY_FILE_NAME,
  getOpenChamberDataDir,
  buildContextModeStorageEnv,
  getManagedOpenCodeRegistryPath,
  readManagedOpenCodeRegistry,
  writeManagedOpenCodeRegistry,
  registerManagedOpenCodeProcess,
  unregisterManagedOpenCodeProcess,
  isManagedOpenCodeProcessCommand,
  isProcessRunning,
  readProcessCommand,
  terminateManagedOpenCodePid,
  reapOrphanedManagedOpenCodeProcesses,
};
