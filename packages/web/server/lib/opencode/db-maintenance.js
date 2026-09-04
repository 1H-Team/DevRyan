// ---------------------------------------------------------------------------
// OpenCode database maintenance — facade.
//
// Wires the synchronous core (`db-maintenance-core.js`) to the real machine:
// default database path, the lazily resolved SQLite driver (`better-sqlite3`
// as `git/service.js` uses, `node:sqlite` fallback), free-disk and
// live-OpenCode-process guards, the worker-thread executor, the persisted
// last-run file and the harness journal.
//
// The pre-launch hook (`lifecycle.deps.beforeManagedSpawn`) runs `run()` with
// `vacuum: 'never'` and a time budget while no managed OpenCode process
// exists; the Settings → Storage "Compact now" action schedules a one-shot
// forced run that the same hook consumes across the restart it triggers.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';

import { getOpenCodeDataPath } from '../git/service.js';
import { isProcessRunning, readManagedOpenCodeRegistry } from './managed-process-registry.js';
import {
  NO_SQLITE_DRIVER_PREFIX,
  OPENCODE_DB_MAINTENANCE_DEFAULTS,
  inspectOpenCodeDb,
  normalizeVacuumMode,
  performOpenCodeDbMaintenance,
  resolveSqliteDriver,
} from './db-maintenance-core.js';

export {
  OPENCODE_DB_MAINTENANCE_DEFAULTS,
  OPENCODE_DB_PRELAUNCH_TIME_BUDGET_MS,
  normalizeOpenCodeDbMaintenanceSettings,
  resolveSqliteDriver,
} from './db-maintenance-core.js';

export const OPENCODE_DB_FILE_NAME = 'opencode.db';
export const OPENCODE_DB_MAINTENANCE_STATE_FILE = 'opencode-db-maintenance.json';
export const OPENCODE_DB_MAINTENANCE_JOURNAL_EVENT = 'opencode_db_maintenance';
const STATE_FILE_VERSION = 1;

export const resolveDefaultOpenCodeDbPath = () => path.join(getOpenCodeDataPath(), OPENCODE_DB_FILE_NAME);

const OPENCODE_EXECUTABLE_PATTERN = /^opencode(?:-[a-z0-9.-]+)?(?:\.exe)?$/i;
const OPENCODE_SERVE_PATTERN = /(?:^|[\s/\\])opencode(?:\.exe)?\s+serve\b/i;

/** Does this `ps` command line belong to an OpenCode process (TUI, run or serve)? */
export const isOpenCodeProcessCommand = (command) => {
  if (typeof command !== 'string') return false;
  const trimmed = command.trim();
  if (!trimmed) return false;
  const executable = trimmed.split(/\s+/)[0];
  const baseName = executable.split(/[\\/]/).pop() || '';
  return OPENCODE_EXECUTABLE_PATTERN.test(baseName) || OPENCODE_SERVE_PATTERN.test(trimmed);
};

const parseProcessTable = (output) => {
  const rows = [];
  for (const line of String(output || '').split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!match) continue;
    rows.push({ pid: Number.parseInt(match[1], 10), command: match[2].trim() });
  }
  return rows;
};

const defaultReadProcessTable = () => {
  if (process.platform === 'win32') return [];
  const result = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  if (result.error || typeof result.stdout !== 'string') return [];
  return parseProcessTable(result.stdout);
};

/**
 * Every OpenCode process other than ours: managed children registered by
 * other DevRyan owners (registry) plus anything in `ps` that looks like the
 * OpenCode binary. Only consulted for the VACUUM decision.
 */
export const listOtherOpenCodeProcessesDefault = ({
  selfPid = process.pid,
  readRegistry = readManagedOpenCodeRegistry,
  isRunning = isProcessRunning,
  readProcessTable = defaultReadProcessTable,
} = {}) => {
  const seen = new Map();
  let records = [];
  try {
    records = readRegistry();
  } catch {
    records = [];
  }
  for (const record of Array.isArray(records) ? records : []) {
    const pid = record?.childPid;
    if (typeof pid !== 'number' || pid === selfPid) continue;
    let running = false;
    try {
      running = isRunning(pid);
    } catch {
      running = false;
    }
    if (!running) continue;
    seen.set(pid, { pid, command: typeof record.binary === 'string' ? `${record.binary} serve` : 'opencode serve', source: 'registry' });
  }
  let table = [];
  try {
    table = readProcessTable();
  } catch {
    table = [];
  }
  for (const row of Array.isArray(table) ? table : []) {
    if (!row || row.pid === selfPid || seen.has(row.pid)) continue;
    if (!isOpenCodeProcessCommand(row.command)) continue;
    seen.set(row.pid, { pid: row.pid, command: row.command, source: 'ps' });
  }
  return [...seen.values()];
};

export const checkFreeDiskBytesDefault = (directory) => {
  if (typeof fs.statfsSync !== 'function') return null;
  try {
    const stats = fs.statfsSync(directory);
    const bytes = Number(stats.bavail) * Number(stats.bsize);
    return Number.isFinite(bytes) ? bytes : null;
  } catch {
    return null;
  }
};

export const WORKER_START_FAILED = 'OPENCODE_DB_MAINTENANCE_WORKER_START_FAILED';

const runInWorker = (input, { workerUrl = new URL('./db-maintenance-worker.js', import.meta.url) } = {}) => new Promise((resolve, reject) => {
  let worker;
  const startFailure = (cause) => {
    const error = new Error(`maintenance worker did not start: ${cause instanceof Error ? cause.message : String(cause)}`);
    error.code = WORKER_START_FAILED;
    error.cause = cause;
    return error;
  };
  try {
    worker = new Worker(workerUrl, { workerData: input });
  } catch (error) {
    reject(startFailure(error));
    return;
  }
  let started = false;
  let settled = false;
  const settle = (fn, value) => {
    if (settled) return;
    settled = true;
    fn(value);
  };
  worker.on('message', (message) => {
    if (message?.type === 'started') {
      started = true;
      return;
    }
    if (message?.type !== 'done') return;
    if (message.ok === true) settle(resolve, message.result);
    else settle(reject, new Error(message.error || 'maintenance worker failed'));
  });
  worker.once('error', (error) => settle(reject, started ? error : startFailure(error)));
  worker.once('exit', (code) => {
    const error = new Error(`maintenance worker exited with code ${code}`);
    settle(reject, started ? error : startFailure(error));
  });
});

/** Default executor: worker thread. Tests inject an in-process executor. */
export const executeOpenCodeDbMaintenanceInWorker = runInWorker;

export const createOpenCodeDbMaintenanceInProcessExecutor = ({ loadDriver = resolveSqliteDriver, now = Date.now } = {}) => (
  async (input) => performOpenCodeDbMaintenance({ driver: loadDriver(), now, ...input })
);

/**
 * Worker thread first; if the worker cannot even start (for example the
 * module cannot be resolved from a packaged archive), run in-process instead.
 * The pass is idempotent, so a start failure never loses work.
 */
export const createOpenCodeDbMaintenanceWorkerExecutor = ({
  loadDriver = resolveSqliteDriver,
  now = Date.now,
  logger = console,
  workerUrl,
} = {}) => {
  const inProcess = createOpenCodeDbMaintenanceInProcessExecutor({ loadDriver, now });
  return async (input) => {
    try {
      return await runInWorker(input, workerUrl ? { workerUrl } : {});
    } catch (error) {
      if (error?.code !== WORKER_START_FAILED) throw error;
      logger?.warn?.('[OpenCode] Database maintenance worker unavailable; running in-process:', error.message);
      return inProcess(input);
    }
  };
};

const emptyRun = ({ at, reason, dryRun, status, error, vacuum = 'never', durationMs = 0 }) => ({
  at,
  reason,
  dryRun,
  status,
  schema: 'unknown',
  driver: null,
  durationMs,
  before: null,
  after: null,
  orphanEvents: 0,
  orphanSequences: 0,
  deletedOrphanEvents: 0,
  deletedOrphanSequences: 0,
  candidateSessions: 0,
  prunableEvents: 0,
  prunedSessions: 0,
  prunedEvents: 0,
  deletedEvents: 0,
  partial: false,
  vacuum: { requested: vacuum, decided: false, reason: 'not_evaluated' },
  vacuumed: false,
  vacuumDurationMs: 0,
  error,
});

const summarizeRun = (result) => ({
  at: result.at,
  reason: result.reason,
  dryRun: result.dryRun,
  status: result.status,
  schema: result.schema ?? 'unknown',
  driver: result.driver ?? null,
  durationMs: result.durationMs,
  deletedEvents: result.deletedEvents,
  deletedOrphanEvents: result.deletedOrphanEvents,
  deletedOrphanSequences: result.deletedOrphanSequences,
  prunedEvents: result.prunedEvents,
  prunedSessions: result.prunedSessions,
  candidateSessions: result.candidateSessions,
  orphanEvents: result.orphanEvents,
  prunableEvents: result.prunableEvents,
  partial: result.partial,
  vacuum: result.vacuum,
  vacuumed: result.vacuumed,
  vacuumDurationMs: result.vacuumDurationMs,
  before: result.before,
  after: result.after,
  error: result.error,
});

/**
 * One-shot coordination between the Compact route and the pre-launch hook:
 * the route schedules a forced VACUUM, restarts OpenCode, and the hook that
 * runs before the new managed spawn consumes it.
 */
export const createOpenCodeDbCompactionScheduler = () => {
  let forcedPending = false;
  return {
    scheduleForced() {
      forcedPending = true;
    },
    consumeForced() {
      const pending = forcedPending;
      forcedPending = false;
      return pending;
    },
    isForcedPending() {
      return forcedPending;
    },
  };
};

export const createOpenCodeDbMaintenance = ({
  dbPath = resolveDefaultOpenCodeDbPath(),
  dataDir,
  loadDriver = resolveSqliteDriver,
  now = Date.now,
  checkFreeDiskBytes = checkFreeDiskBytesDefault,
  listOtherOpenCodeProcesses = listOtherOpenCodeProcessesDefault,
  journal = null,
  logger = console,
  execute = null,
} = {}) => {
  if (typeof dataDir !== 'string' || dataDir.length === 0) {
    throw new TypeError('createOpenCodeDbMaintenance requires dataDir');
  }
  const statePath = path.join(dataDir, OPENCODE_DB_MAINTENANCE_STATE_FILE);
  const executor = typeof execute === 'function'
    ? execute
    : createOpenCodeDbMaintenanceWorkerExecutor({ loadDriver, now, logger });
  let inFlight = null;

  const readState = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (!parsed || typeof parsed !== 'object') return { version: STATE_FILE_VERSION, lastRun: null, lastDryRun: null };
      return {
        version: STATE_FILE_VERSION,
        lastRun: parsed.lastRun && typeof parsed.lastRun === 'object' ? parsed.lastRun : null,
        lastDryRun: parsed.lastDryRun && typeof parsed.lastDryRun === 'object' ? parsed.lastDryRun : null,
      };
    } catch {
      return { version: STATE_FILE_VERSION, lastRun: null, lastDryRun: null };
    }
  };

  const writeState = (state) => {
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      const tmp = `${statePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, statePath);
    } catch (error) {
      logger?.warn?.('[OpenCode] Could not persist database maintenance state:', error instanceof Error ? error.message : String(error));
    }
  };

  const persist = (summary) => {
    const state = readState();
    if (summary.dryRun) state.lastDryRun = summary;
    else state.lastRun = summary;
    writeState(state);
  };

  const record = (summary) => {
    if (typeof journal !== 'function') return;
    try {
      journal({
        type: 'log',
        level: summary.status === 'error' ? 'warn' : 'info',
        event: OPENCODE_DB_MAINTENANCE_JOURNAL_EVENT,
        payload: summary,
      });
    } catch {
      // journaling is best-effort
    }
  };

  const inspect = async () => {
    const state = readState();
    let inspection;
    try {
      inspection = inspectOpenCodeDb({ driver: loadDriver(), dbPath });
    } catch (error) {
      inspection = {
        dbPath,
        exists: fs.existsSync(dbPath),
        schema: 'unknown',
        dbBytes: 0,
        walBytes: 0,
        reclaimableBytes: 0,
        pageSize: 0,
        pageCount: 0,
        freelistPages: 0,
        eventRows: 0,
        orphanEventRows: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    return { ...inspection, lastRun: state.lastRun, lastDryRun: state.lastDryRun, running: inFlight !== null };
  };

  const run = async (options = {}) => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const dryRun = options.dryRun === true;
      const reason = typeof options.reason === 'string' && options.reason ? options.reason : (dryRun ? 'dry_run' : 'manual');
      const startedAt = now();
      if (!fs.existsSync(dbPath)) {
        return summarizeRun(emptyRun({ at: startedAt, reason, dryRun, status: 'skipped', error: 'missing_database' }));
      }

      let otherProcesses = [];
      try {
        otherProcesses = await listOtherOpenCodeProcesses();
      } catch (error) {
        logger?.warn?.('[OpenCode] Could not list OpenCode processes; deletes and VACUUM stay off:', error instanceof Error ? error.message : String(error));
        otherProcesses = [{ pid: -1, command: 'unknown', source: 'error' }];
      }
      let freeDiskBytes = null;
      try {
        freeDiskBytes = await checkFreeDiskBytes(path.dirname(dbPath));
      } catch {
        freeDiskBytes = null;
      }

      const input = {
        dbPath,
        dryRun,
        idleHours: options.idleHours ?? OPENCODE_DB_MAINTENANCE_DEFAULTS.idleHours,
        keepSeqPerAggregate: options.keepSeqPerAggregate ?? OPENCODE_DB_MAINTENANCE_DEFAULTS.keepSeqPerAggregate,
        vacuum: normalizeVacuumMode(options.vacuum),
        timeBudgetMs: typeof options.timeBudgetMs === 'number' && Number.isFinite(options.timeBudgetMs) ? options.timeBudgetMs : null,
        reason,
        freeDiskBytes,
        otherProcesses: Array.isArray(otherProcesses) ? otherProcesses.map((entry) => ({
          pid: entry?.pid ?? null,
          command: typeof entry?.command === 'string' ? entry.command : '',
          source: typeof entry?.source === 'string' ? entry.source : 'unknown',
        })) : [],
      };

      let result;
      try {
        result = await executor(input);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // A host without any SQLite driver simply cannot maintain the file;
        // that is a quiet skip, not a failure worth a warning on every launch.
        const noDriver = message.startsWith(NO_SQLITE_DRIVER_PREFIX);
        result = emptyRun({
          at: startedAt,
          reason,
          dryRun,
          status: noDriver ? 'skipped' : 'error',
          error: noDriver ? 'no_sqlite_driver' : message,
          vacuum: input.vacuum,
          durationMs: Math.max(0, now() - startedAt),
        });
      }

      const summary = summarizeRun(result);
      persist(summary);
      record(summary);
      const level = summary.status === 'error' ? 'warn' : 'log';
      logger?.[level]?.(
        `[OpenCode] Database maintenance ${summary.dryRun ? 'dry run' : 'run'} (${summary.reason}) ${summary.status}`,
        {
          deletedEvents: summary.deletedEvents,
          prunedSessions: summary.prunedSessions,
          vacuum: summary.vacuum,
          vacuumed: summary.vacuumed,
          partial: summary.partial,
          durationMs: summary.durationMs,
          dbBytesBefore: summary.before?.dbBytes ?? null,
          dbBytesAfter: summary.after?.dbBytes ?? null,
          error: summary.error,
        },
      );
      return summary;
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  return {
    dbPath,
    statePath,
    inspect,
    run,
    readState,
    isRunning: () => inFlight !== null,
  };
};
