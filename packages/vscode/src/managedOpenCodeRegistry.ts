import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

// v2 adds `workingDirectory`; v1 files (no such field) still read as null.
const REGISTRY_VERSION = 2;
const REGISTRY_FILE_NAME = 'managed-opencode-processes.json';

export type ManagedOpenCodeProcessRecord = {
  childPid: number;
  ownerPid: number;
  port: number | null;
  binary: string;
  hostRuntime: string;
  hostname: string | null;
  startedAt: number;
  workingDirectory: string | null;
};

export type ReapManagedOpenCodeProcessesResult = {
  kept: ManagedOpenCodeProcessRecord[];
  reaped: Array<ManagedOpenCodeProcessRecord & { terminated: boolean }>;
  removed: Array<ManagedOpenCodeProcessRecord & { reason: string }>;
  skipped: Array<ManagedOpenCodeProcessRecord & { reason: string }>;
};

type RegistryOptions = {
  registryPath?: string;
  env?: NodeJS.ProcessEnv;
};

type ReapOptions = RegistryOptions & {
  isProcessRunning?: (pid: number) => boolean;
  readProcessCommand?: (pid: number) => string | null | Promise<string | null>;
  terminateManagedOpenCodePid?: (pid: number, record: ManagedOpenCodeProcessRecord) => boolean | Promise<boolean>;
  processKill?: typeof process.kill;
  platform?: NodeJS.Platform;
};

export function getOpenChamberDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = typeof env.OPENCHAMBER_DATA_DIR === 'string' ? env.OPENCHAMBER_DATA_DIR.trim() : '';
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.config', 'openchamber');
}

export function buildContextModeStorageEnv(env: NodeJS.ProcessEnv = process.env): {
  CONTEXT_MODE_DATA_DIR: string;
  CONTEXT_MODE_DIR: string;
} {
  const dataDir = getOpenChamberDataDir(env);
  return {
    CONTEXT_MODE_DATA_DIR: dataDir,
    CONTEXT_MODE_DIR: path.join(dataDir, 'context-mode'),
  };
}

export function getManagedOpenCodeRegistryPath(options: RegistryOptions = {}): string {
  if (typeof options.registryPath === 'string' && options.registryPath.trim()) {
    return path.resolve(options.registryPath);
  }
  return path.join(getOpenChamberDataDir(options.env), REGISTRY_FILE_NAME);
}

function normalizePositiveInteger(value: unknown): number | null {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.trunc(number);
}

function normalizeRegistryRecord(record: unknown): ManagedOpenCodeProcessRecord | null {
  if (!record || typeof record !== 'object') return null;
  const raw = record as Record<string, unknown>;
  const childPid = normalizePositiveInteger(raw.childPid);
  const ownerPid = normalizePositiveInteger(raw.ownerPid);
  if (!childPid || !ownerPid) return null;

  return {
    childPid,
    ownerPid,
    port: normalizePositiveInteger(raw.port),
    binary: typeof raw.binary === 'string' && raw.binary.trim() ? raw.binary.trim() : 'opencode',
    hostRuntime: typeof raw.hostRuntime === 'string' && raw.hostRuntime.trim() ? raw.hostRuntime.trim() : 'vscode',
    hostname: typeof raw.hostname === 'string' && raw.hostname.trim() ? raw.hostname.trim() : null,
    startedAt: Number.isFinite(raw.startedAt) ? Math.trunc(Number(raw.startedAt)) : Date.now(),
    workingDirectory: typeof raw.workingDirectory === 'string' && raw.workingDirectory.trim()
      ? raw.workingDirectory.trim()
      : null,
  };
}

export function readManagedOpenCodeRegistry(options: RegistryOptions = {}): ManagedOpenCodeProcessRecord[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(getManagedOpenCodeRegistryPath(options), 'utf8')) as unknown;
    const records = parsed && typeof parsed === 'object' && Array.isArray((parsed as { processes?: unknown }).processes)
      ? (parsed as { processes: unknown[] }).processes
      : [];
    return records.map(normalizeRegistryRecord).filter((record): record is ManagedOpenCodeProcessRecord => Boolean(record));
  } catch {
    return [];
  }
}

export function writeManagedOpenCodeRegistry(records: ManagedOpenCodeProcessRecord[], options: RegistryOptions = {}): ManagedOpenCodeProcessRecord[] {
  const normalized = records
    .map(normalizeRegistryRecord)
    .filter((record): record is ManagedOpenCodeProcessRecord => Boolean(record));
  const registryPath = getManagedOpenCodeRegistryPath(options);
  fs.mkdirSync(path.dirname(registryPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    registryPath,
    JSON.stringify({ version: REGISTRY_VERSION, processes: normalized }, null, 2),
    { mode: 0o600 },
  );
  return normalized;
}

export function registerManagedOpenCodeProcess(
  record: Partial<ManagedOpenCodeProcessRecord>,
  options: RegistryOptions = {},
): ManagedOpenCodeProcessRecord | null {
  const normalized = normalizeRegistryRecord({
    ...record,
    ownerPid: record.ownerPid ?? process.pid,
    startedAt: record.startedAt ?? Date.now(),
  });
  if (!normalized) return null;
  const existing = readManagedOpenCodeRegistry(options).filter((entry) => entry.childPid !== normalized.childPid);
  writeManagedOpenCodeRegistry([...existing, normalized], options);
  return normalized;
}

export function unregisterManagedOpenCodeProcess(childPid: number, options: RegistryOptions = {}): boolean {
  const normalizedChildPid = normalizePositiveInteger(childPid);
  if (!normalizedChildPid) return false;
  const existing = readManagedOpenCodeRegistry(options);
  const next = existing.filter((entry) => entry.childPid !== normalizedChildPid);
  if (next.length === existing.length) return false;
  writeManagedOpenCodeRegistry(next, options);
  return true;
}

function isProcessRunning(pid: number, processKill: typeof process.kill = process.kill.bind(process)): boolean {
  const normalizedPid = normalizePositiveInteger(pid);
  if (!normalizedPid) return false;
  try {
    processKill(normalizedPid, 0);
    return true;
  } catch {
    return false;
  }
}

function readProcessCommand(pid: number, options: ReapOptions = {}): string | null {
  const normalizedPid = normalizePositiveInteger(pid);
  if (!normalizedPid) return null;
  const platform = options.platform || process.platform;

  try {
    if (platform === 'win32') {
      const result = spawnSync('powershell.exe', [
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

    const result = spawnSync('ps', ['-p', String(normalizedPid), '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const output = typeof result.stdout === 'string' ? result.stdout.trim() : '';
    return result.status === 0 && output ? output : null;
  } catch {
    return null;
  }
}

export function isManagedOpenCodeProcessCommand(command: string | null | undefined, record: Pick<ManagedOpenCodeProcessRecord, 'binary' | 'port'>): boolean {
  if (typeof command !== 'string' || !command.trim()) return false;
  const normalized = command.replace(/\\/g, '/').replace(/\s+/g, ' ').trim().toLowerCase();
  const binaryBase = path.basename(record.binary || 'opencode').toLowerCase();
  const binaryLooksRight = normalized.includes('opencode')
    || (binaryBase.length > 0 && normalized.includes(binaryBase));
  if (!binaryLooksRight || !/(?:^|\s)serve(?:$|\s)/.test(normalized)) {
    return false;
  }

  const port = normalizePositiveInteger(record.port);
  if (!port) return true;
  return normalized.includes(`--port ${port}`)
    || normalized.includes(`--port=${port}`);
}

function waitForProcessExit(pid: number, timeoutMs: number, processKill: typeof process.kill): Promise<boolean> {
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

async function terminateManagedOpenCodePid(pid: number, options: ReapOptions = {}): Promise<boolean> {
  const normalizedPid = normalizePositiveInteger(pid);
  if (!normalizedPid) return true;
  const platform = options.platform || process.platform;
  const processKill = options.processKill || process.kill.bind(process);

  if (platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(normalizedPid), '/t'], {
        stdio: 'ignore',
        timeout: 3000,
        windowsHide: true,
      });
    } catch {
      // ignore
    }
    if (await waitForProcessExit(normalizedPid, 1500, processKill)) return true;
    try {
      spawnSync('taskkill', ['/pid', String(normalizedPid), '/f', '/t'], {
        stdio: 'ignore',
        timeout: 5000,
        windowsHide: true,
      });
    } catch {
      // ignore
    }
    return waitForProcessExit(normalizedPid, 3000, processKill);
  }

  const signal = (targetPid: number, signalName: NodeJS.Signals) => {
    try {
      processKill(-targetPid, signalName);
    } catch {
      try {
        processKill(targetPid, signalName);
      } catch {
        // ignore
      }
    }
  };

  signal(normalizedPid, 'SIGTERM');
  if (await waitForProcessExit(normalizedPid, 2500, processKill)) return true;
  signal(normalizedPid, 'SIGKILL');
  return waitForProcessExit(normalizedPid, 1000, processKill);
}

export async function reapOrphanedManagedOpenCodeProcesses(options: ReapOptions = {}): Promise<ReapManagedOpenCodeProcessesResult> {
  const records = readManagedOpenCodeRegistry(options);
  const running = options.isProcessRunning || ((pid: number) => isProcessRunning(pid, options.processKill));
  const commandReader = options.readProcessCommand || ((pid: number) => readProcessCommand(pid, options));
  const terminator = options.terminateManagedOpenCodePid || ((pid: number) => terminateManagedOpenCodePid(pid, options));

  const kept: ManagedOpenCodeProcessRecord[] = [];
  const reaped: Array<ManagedOpenCodeProcessRecord & { terminated: boolean }> = [];
  const removed: Array<ManagedOpenCodeProcessRecord & { reason: string }> = [];
  const skipped: Array<ManagedOpenCodeProcessRecord & { reason: string }> = [];

  for (const record of records) {
    if (running(record.ownerPid)) {
      kept.push(record);
      skipped.push({ ...record, reason: 'owner-alive' });
      continue;
    }

    if (!running(record.childPid)) {
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

  writeManagedOpenCodeRegistry(kept, options);
  return { kept, reaped, removed, skipped };
}
