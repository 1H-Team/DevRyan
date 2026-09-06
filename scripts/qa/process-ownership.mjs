import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Only process identity/ancestry is read. Command lines and environments may
// contain credentials and are neither needed nor retained for ownership.
export async function readQaProcessSnapshot() {
  if (process.platform === 'win32') {
    const script = 'Get-CimInstance Win32_Process | ForEach-Object { [PSCustomObject]@{ pid=$_.ProcessId; parentPid=$_.ParentProcessId; started=$_.CreationDate.ToFileTimeUtc().ToString() } } | ConvertTo-Json -Compress';
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
    const parsed = JSON.parse(stdout);
    return (Array.isArray(parsed) ? parsed : [parsed]).map(row => ({ pid: row.pid, parentPid: row.parentPid,
      startIdentity: row.started, running: true }));
  }
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,stat=,lstart='], {
    env: { ...process.env, LC_ALL: 'C' }, timeout: 5000, maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.split('\n').filter(line => line.trim()).map(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match || !Number.isFinite(Date.parse(match[4]))) throw new Error('QA process identity snapshot is malformed');
    return { pid: Number(match[1]), parentPid: Number(match[2]), startIdentity: match[4], running: !match[3].startsWith('Z') };
  });
}

// Retain descendants while the owned parent is alive, including children that
// detach into a different process group and are later reparented. A PID alone
// never authorizes a signal: its observed OS start identity must still match.
export function createQaProcessOwnership(child, { readSnapshot = readQaProcessSnapshot,
  signal = (pid, kind) => process.kill(pid, kind), intervalMs = 500 } = {}) {
  const records = new Map();
  const observationErrors = [];
  const signals = [];
  let rootObserved = false;
  let live = [];
  let pending = Promise.resolve();
  let closed = false;
  const observe = async () => {
    let rows;
    try {
      rows = await readSnapshot();
      if (!Array.isArray(rows) || rows.some(row => !Number.isSafeInteger(row.pid) || row.pid < 1
        || !Number.isSafeInteger(row.parentPid) || row.parentPid < 0
        || typeof row.startIdentity !== 'string' || !row.startIdentity || typeof row.running !== 'boolean')) {
        throw new Error('QA process identity snapshot is malformed');
      }
    } catch {
      observationErrors.push({ at: Date.now(), reason: 'OS process identity snapshot failed' });
      throw new Error('QA owned-process observation failed; complete cleanup cannot be verified');
    }
    const current = new Map(rows.map(row => [row.pid, row]));
    const root = current.get(child.pid);
    if (!rootObserved && root?.parentPid === process.pid && child.exitCode === null && child.signalCode === null) {
      records.set(root.pid, { ...root, observedParentPid: process.pid });
      rootObserved = true;
    }
    const owned = new Set([...records.values()].filter(row => current.get(row.pid)?.startIdentity === row.startIdentity).map(row => row.pid));
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (owned.has(row.pid) || !owned.has(row.parentPid)) continue;
        // A reused recorded PID is not the original child and must not be
        // adopted through an unrelated parent or signalled later.
        if (records.has(row.pid) && records.get(row.pid).startIdentity !== row.startIdentity) continue;
        records.set(row.pid, { ...row, observedParentPid: row.parentPid });
        owned.add(row.pid); changed = true;
      }
    }
    live = [...records.values()].filter(row => current.get(row.pid)?.startIdentity === row.startIdentity && current.get(row.pid).running);
    return live;
  };
  const refresh = () => {
    const next = pending.then(observe, observe);
    pending = next.catch(() => {});
    return next;
  };
  const timer = setInterval(() => { void refresh().catch(() => {}); }, intervalMs);
  timer.unref();
  void refresh().catch(() => {});
  const evidence = () => ({ source: 'retained-os-process-ancestry-and-start-identities', rootPid: child.pid ?? null,
    rootObserved, observationIntervalMs: intervalMs, observationErrors: [...observationErrors],
    observedProcesses: [...records.values()].map(row => ({ pid: row.pid, parentPid: row.observedParentPid, startIdentity: row.startIdentity })),
    remainingProcessIds: live.map(row => row.pid), signals: [...signals], trackingClosed: closed });
  const signalRemaining = async kind => {
    for (const row of await refresh()) {
      try { signal(row.pid, kind); signals.push({ pid: row.pid, startIdentity: row.startIdentity, signal: kind }); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  };
  const waitUntilStopped = async timeoutMs => {
    const deadline = Date.now() + timeoutMs;
    do {
      if ((await refresh()).length === 0) return true;
      await pause(50);
    } while (Date.now() < deadline);
    return false;
  };
  return {
    refresh,
    getEvidence: evidence,
    terminateRemaining: async () => {
      if ((await refresh()).length === 0) return;
      await signalRemaining('SIGTERM');
      if (await waitUntilStopped(2500)) return;
      await signalRemaining('SIGKILL');
      await waitUntilStopped(1000);
    },
    closeTracking: async () => { clearInterval(timer); closed = true; await pending; },
    auditStopped: async () => {
      await refresh();
      if (observationErrors.length || child.pid && !rootObserved) throw new Error('QA owned-process observation is incomplete; cleanup cannot be reported as complete');
      if (live.length) throw new Error(`QA owned processes remain after cleanup: ${live.map(row => row.pid).join(', ')}`);
      return evidence();
    },
  };
}
