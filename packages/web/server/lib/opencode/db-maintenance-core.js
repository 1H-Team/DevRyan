// ---------------------------------------------------------------------------
// OpenCode database maintenance — synchronous core.
//
// OpenCode (v1.18.27) keeps a durable `event` table for its multi-device sync
// (`/sync/*`) and the V2 session `events`/`history` API. Nothing in OpenCode
// prunes it, and every user message's `message.updated` event carries the full
// diff patch bodies, so on a busy machine the table dominates the database
// (12.9 of 15.4 GB observed). DevRyan only uses the v1 API and the live SSE
// stream, neither of which reads `event` rows.
//
// Reader check (v1.18.27 source):
//   * `event` rows are read by `/sync/history` (multi-device sync),
//     `EventV2.readAfter`/`readAggregate` behind the V2 session `events` +
//     `history` endpoints, and `control-plane/workspace.ts` when a session is
//     moved into a *remote* workspace. None of those are exercised by DevRyan.
//   * `session_context_epoch.baseline_seq` bounds `session_message.seq`
//     (`session/history.ts`), never `event.seq`; `context-epoch.ts` and the
//     runner's steer cutoff only read `event_sequence.seq`.
//   * `event_sequence` is read by `EventV2.latestSequence`, the sync fence and
//     the publish path; it is therefore kept for every live session so the
//     next published seq stays continuous.
//
// This module has no project imports so it can run inside a worker thread;
// the facade in `db-maintenance.js` supplies process/disk guards, persistence
// and journaling. The SQLite driver is `better-sqlite3` (the dependency
// `git/service.js` already uses, loaded lazily) with Node's built-in
// `node:sqlite` as the fallback when the native binding does not match the
// running Node ABI.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const OPENCODE_DB_MAINTENANCE_DEFAULTS = Object.freeze({
  enabled: true,
  idleHours: 24,
  keepSeqPerAggregate: 64,
});
export const OPENCODE_DB_PRELAUNCH_TIME_BUDGET_MS = 20_000;
export const OPENCODE_DB_VACUUM_FREELIST_RATIO = 0.15;
export const OPENCODE_DB_VACUUM_FREE_DISK_RATIO = 1.2;
export const OPENCODE_DB_VACUUM_MODES = Object.freeze(['never', 'auto', 'force']);
export const SQLITE_DRIVER_ORDER = Object.freeze(['better-sqlite3', 'node:sqlite', 'bun:sqlite']);

const BUSY_TIMEOUT_MS = 5000;
// Small batches keep every delete transaction well under OpenCode's own
// 5 s busy timeout (packages/core/src/database/database.ts) should a stray
// writer appear mid-run; mutations are refused outright while one is known.
const PRUNE_BATCH_SESSIONS = 20;
const MAX_IDLE_HOURS = 24 * 365;
const MAX_KEEP_SEQ = 1_000_000;

// Only these four tables are touched or read for decisions; `message`,
// `part` and `session` rows are never written.
const REQUIRED_COLUMNS = Object.freeze({
  event: ['id', 'aggregate_id', 'seq', 'type', 'data'],
  event_sequence: ['aggregate_id', 'seq'],
  session: ['id', 'time_updated'],
  session_context_epoch: ['session_id', 'baseline_seq'],
});

// `substr(...) = 'ses_'` rather than LIKE: `_` is a LIKE wildcard.
const SESSION_AGGREGATE_FILTER = "substr(aggregate_id, 1, 4) = 'ses_'";
const ORPHAN_EVENT_WHERE = `${SESSION_AGGREGATE_FILTER} AND aggregate_id NOT IN (SELECT id FROM session)`;

const clampInteger = (value, min, max, fallback) => {
  const numeric = typeof value === 'string' && value.trim().length > 0 ? Number(value) : value;
  if (typeof numeric !== 'number' || !Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.round(numeric)));
};

/** Settings shape stored under `opencodeDbMaintenance` in settings.json. */
export const normalizeOpenCodeDbMaintenanceSettings = (raw) => {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    enabled: source.enabled !== false,
    idleHours: clampInteger(source.idleHours, 1, MAX_IDLE_HOURS, OPENCODE_DB_MAINTENANCE_DEFAULTS.idleHours),
    keepSeqPerAggregate: clampInteger(
      source.keepSeqPerAggregate,
      1,
      MAX_KEEP_SEQ,
      OPENCODE_DB_MAINTENANCE_DEFAULTS.keepSeqPerAggregate,
    ),
  };
};

export const normalizeVacuumMode = (value) => (
  OPENCODE_DB_VACUUM_MODES.includes(value) ? value : 'never'
);

// ---------------------------------------------------------------------------
// SQLite driver adapters. Both expose the same tiny surface:
//   pragma(name, { simple }) / prepare(sql) -> { get, all, run } /
//   exec(sql) / transaction(fn) -> fn / close().
// ---------------------------------------------------------------------------

const firstColumn = (row) => (row && typeof row === 'object' ? Object.values(row)[0] : undefined);

const adaptBetterSqlite = (db) => ({
  pragma: (name, options = {}) => db.pragma(name, options),
  prepare: (sql) => db.prepare(sql),
  exec: (sql) => db.exec(sql),
  transaction: (fn) => db.transaction(fn),
  close: () => db.close(),
});

// Drivers without a transaction helper get the BEGIN/COMMIT/ROLLBACK wrapper.
const manualTransaction = (db) => (fn) => (...args) => {
  db.exec('BEGIN');
  try {
    const result = fn(...args);
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // already rolled back
    }
    throw error;
  }
};

const pragmaViaPrepare = (db) => (name, { simple = false } = {}) => {
  const rows = db.prepare(`PRAGMA ${name}`).all();
  return simple ? firstColumn(rows[0]) : rows;
};

const adaptNodeSqlite = (db) => ({
  pragma: pragmaViaPrepare(db),
  prepare: (sql) => db.prepare(sql),
  exec: (sql) => db.exec(sql),
  transaction: manualTransaction(db),
  close: () => db.close(),
});

// `bun:sqlite` (the server under Bun: `bun run dev`, `web-verify`). Its
// statement API matches better-sqlite3 except that `run()` only reports
// `changes` on recent Bun versions, so fall back to `changes()`.
const adaptBunSqlite = (db) => ({
  pragma: pragmaViaPrepare(db),
  prepare: (sql) => {
    const statement = db.prepare(sql);
    return {
      get: (...args) => statement.get(...args),
      all: (...args) => statement.all(...args),
      run: (...args) => {
        const outcome = statement.run(...args);
        const changes = outcome && typeof outcome.changes === 'number'
          ? outcome.changes
          : Number(db.prepare('SELECT changes() AS n').get()?.n ?? 0);
        return { changes };
      },
    };
  },
  exec: (sql) => db.exec(sql),
  transaction: manualTransaction(db),
  close: () => db.close(),
});

const loadBetterSqliteDriver = () => {
  const Database = require('better-sqlite3');
  // The JS entry always loads; the native binding is only bound on the first
  // open, so probe it here (this is where an ABI mismatch surfaces).
  new Database(':memory:').close();
  return {
    name: 'better-sqlite3',
    open: (dbPath, { readonly = false } = {}) => adaptBetterSqlite(new Database(dbPath, { fileMustExist: true, readonly })),
  };
};

const loadNodeSqliteDriver = () => {
  const { DatabaseSync } = require('node:sqlite');
  return {
    name: 'node:sqlite',
    open: (dbPath, { readonly = false } = {}) => {
      if (!fs.existsSync(dbPath)) {
        const error = new Error(`unable to open database file: ${dbPath}`);
        error.code = 'SQLITE_CANTOPEN';
        throw error;
      }
      return adaptNodeSqlite(new DatabaseSync(dbPath, { readOnly: readonly }));
    },
  };
};

const loadBunSqliteDriver = () => {
  if (typeof Bun === 'undefined') throw new Error('not running under Bun');
  const { Database } = require('bun:sqlite');
  return {
    name: 'bun:sqlite',
    open: (dbPath, { readonly = false } = {}) => {
      if (!fs.existsSync(dbPath)) {
        const error = new Error(`unable to open database file: ${dbPath}`);
        error.code = 'SQLITE_CANTOPEN';
        throw error;
      }
      return adaptBunSqlite(new Database(dbPath, readonly ? { readonly: true } : { readwrite: true, create: false }));
    },
  };
};

const DRIVER_LOADERS = Object.freeze({
  'better-sqlite3': loadBetterSqliteDriver,
  'node:sqlite': loadNodeSqliteDriver,
  'bun:sqlite': loadBunSqliteDriver,
});

export const NO_SQLITE_DRIVER_PREFIX = 'No SQLite driver available';

/**
 * Lazily resolve a SQLite driver: `better-sqlite3` first (the dependency the
 * git service already uses), then Node's built-in `node:sqlite` when the
 * native binding was built for another Node ABI, then `bun:sqlite` when the
 * server runs under Bun. Throws when none loads.
 */
export const resolveSqliteDriver = ({ order = SQLITE_DRIVER_ORDER } = {}) => {
  const failures = [];
  for (const name of order) {
    const loader = DRIVER_LOADERS[name];
    if (!loader) continue;
    try {
      return loader();
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    }
  }
  throw new Error(`${NO_SQLITE_DRIVER_PREFIX} (${failures.join('; ')})`);
};

const statSize = (filePath) => {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
};

const pragmaValue = (db, name) => {
  const value = db.pragma(name, { simple: true });
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
};

/** PRAGMA table_info guard: abort instead of guessing when OpenCode's tables change shape. */
export const checkOpenCodeDbSchema = (db) => {
  const missing = [];
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    let rows;
    try {
      rows = db.pragma(`table_info(${table})`);
    } catch {
      rows = [];
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      missing.push(table);
      continue;
    }
    const names = new Set(rows.map((row) => row?.name));
    for (const column of columns) {
      if (!names.has(column)) missing.push(`${table}.${column}`);
    }
  }
  return { ok: missing.length === 0, missing };
};

/**
 * VACUUM policy. `force` is the explicit Compact action, `auto` is the
 * opportunistic path; both still refuse to run next to another live OpenCode
 * process (VACUUM needs the file to itself) or without room for the rebuilt
 * copy. Pure so the decision can be tested without a database.
 */
export const decideVacuum = ({
  mode,
  freelistPages = 0,
  pageCount = 0,
  dbBytes = 0,
  freeDiskBytes = null,
  otherProcesses = [],
}) => {
  const normalizedMode = normalizeVacuumMode(mode);
  if (normalizedMode === 'never') return { decided: false, reason: 'not_requested' };
  if (Array.isArray(otherProcesses) && otherProcesses.length > 0) {
    return { decided: false, reason: 'other_opencode_process' };
  }
  if (typeof freeDiskBytes !== 'number' || !Number.isFinite(freeDiskBytes)) {
    return { decided: false, reason: 'free_disk_unknown' };
  }
  if (freeDiskBytes < dbBytes * OPENCODE_DB_VACUUM_FREE_DISK_RATIO) {
    return { decided: false, reason: 'insufficient_free_disk' };
  }
  if (normalizedMode === 'force') return { decided: true, reason: 'forced' };
  const ratio = pageCount > 0 ? freelistPages / pageCount : 0;
  return ratio > OPENCODE_DB_VACUUM_FREELIST_RATIO
    ? { decided: true, reason: 'freelist_above_threshold' }
    : { decided: false, reason: 'freelist_below_threshold' };
};

const readSnapshot = (db, dbPath) => {
  const pageSize = pragmaValue(db, 'page_size');
  const pageCount = pragmaValue(db, 'page_count');
  const freelistPages = pragmaValue(db, 'freelist_count');
  const eventRows = db.prepare('SELECT COUNT(*) AS n FROM event').get().n;
  return {
    dbBytes: statSize(dbPath),
    walBytes: statSize(`${dbPath}-wal`),
    pageSize,
    pageCount,
    freelistPages,
    reclaimableBytes: freelistPages * pageSize,
    eventRows,
  };
};

const emptyInspection = (dbPath) => ({
  dbPath,
  exists: false,
  schema: 'unknown',
  dbBytes: 0,
  walBytes: 0,
  reclaimableBytes: 0,
  pageSize: 0,
  pageCount: 0,
  freelistPages: 0,
  eventRows: 0,
  orphanEventRows: 0,
  error: null,
});

const openDatabase = (driver, dbPath, { readonly = false } = {}) => {
  const db = driver.open(dbPath, { readonly });
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  return db;
};

const openPreferReadonly = (driver, dbPath) => {
  try {
    return openDatabase(driver, dbPath, { readonly: true });
  } catch {
    // A WAL database without a writable -shm can refuse read-only opens.
    return openDatabase(driver, dbPath);
  }
};

/** Read-only size/row summary. Never writes; safe while OpenCode is running. */
export const inspectOpenCodeDb = ({ driver, dbPath }) => {
  const result = emptyInspection(dbPath);
  if (!fs.existsSync(dbPath)) return result;
  result.exists = true;
  result.dbBytes = statSize(dbPath);
  result.walBytes = statSize(`${dbPath}-wal`);

  let db = null;
  try {
    db = openPreferReadonly(driver, dbPath);
    const schema = checkOpenCodeDbSchema(db);
    if (!schema.ok) {
      result.schema = 'mismatch';
      result.error = `schema_mismatch: ${schema.missing.join(', ')}`;
      return result;
    }
    result.schema = 'ok';
    Object.assign(result, readSnapshot(db, dbPath));
    result.orphanEventRows = db.prepare(`SELECT COUNT(*) AS n FROM event WHERE ${ORPHAN_EVENT_WHERE}`).get().n;
    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    return result;
  } finally {
    try {
      db?.close();
    } catch {
      // best effort
    }
  }
};

const createRunResult = ({ at, reason, dryRun, vacuum }) => ({
  at,
  reason,
  dryRun,
  status: 'ok',
  schema: 'ok',
  driver: null,
  durationMs: 0,
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
  error: null,
});

/**
 * One maintenance pass. Synchronous by design; the facade runs it inside a
 * worker thread so the server stays responsive.
 *
 * Order: schema guard -> checkpoint -> orphan purge (session aggregates whose
 * session no longer exists: `event` + `event_sequence`) -> idle prune (for
 * sessions idle longer than `idleHours`, delete `event` rows with
 * `seq <= latest - keepSeqPerAggregate`; `event_sequence` untouched) ->
 * VACUUM per `decideVacuum`. Dry runs open the database but issue no writes.
 */
export const performOpenCodeDbMaintenance = ({
  driver,
  dbPath,
  dryRun = false,
  idleHours = OPENCODE_DB_MAINTENANCE_DEFAULTS.idleHours,
  keepSeqPerAggregate = OPENCODE_DB_MAINTENANCE_DEFAULTS.keepSeqPerAggregate,
  vacuum = 'never',
  timeBudgetMs = null,
  now = Date.now,
  freeDiskBytes = null,
  otherProcesses = [],
  reason = 'manual',
}) => {
  const startedAt = now();
  const vacuumMode = normalizeVacuumMode(vacuum);
  const keep = clampInteger(keepSeqPerAggregate, 1, MAX_KEEP_SEQ, OPENCODE_DB_MAINTENANCE_DEFAULTS.keepSeqPerAggregate);
  const idle = clampInteger(idleHours, 1, MAX_IDLE_HOURS, OPENCODE_DB_MAINTENANCE_DEFAULTS.idleHours);
  const result = createRunResult({ at: startedAt, reason, dryRun: dryRun === true, vacuum: vacuumMode });
  result.driver = driver?.name ?? null;
  const finish = () => {
    result.durationMs = Math.max(0, now() - startedAt);
    return result;
  };
  const overBudget = () => (
    typeof timeBudgetMs === 'number' && Number.isFinite(timeBudgetMs) && now() - startedAt > timeBudgetMs
  );

  if (!fs.existsSync(dbPath)) {
    result.status = 'skipped';
    result.error = 'missing_database';
    return finish();
  }

  let db = null;
  try {
    db = result.dryRun ? openPreferReadonly(driver, dbPath) : openDatabase(driver, dbPath);
  } catch (error) {
    result.status = 'error';
    result.error = `open_failed: ${error instanceof Error ? error.message : String(error)}`;
    return finish();
  }

  try {
    const schema = checkOpenCodeDbSchema(db);
    if (!schema.ok) {
      result.status = 'skipped';
      result.schema = 'mismatch';
      result.error = `schema_mismatch: ${schema.missing.join(', ')}`;
      return finish();
    }

    if (!result.dryRun) {
      try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch {
        // Another connection may hold the WAL; the checkpoint is opportunistic.
      }
    }
    result.before = readSnapshot(db, dbPath);

    // Deletes take the SQLite write lock; another OpenCode process (an orphan
    // serve, VS Code, a second install) writing under its 5 s busy timeout
    // could fail a live session's writes while a big delete runs. Mutations
    // are therefore refused while one is known; counts are still reported.
    const otherProcessAlive = Array.isArray(otherProcesses) && otherProcesses.length > 0;
    const mutationsAllowed = !result.dryRun && !otherProcessAlive;

    // (c) orphans: only `ses_` aggregates; other aggregate kinds are never touched.
    result.orphanEvents = db.prepare(`SELECT COUNT(*) AS n FROM event WHERE ${ORPHAN_EVENT_WHERE}`).get().n;
    result.orphanSequences = db.prepare(`SELECT COUNT(*) AS n FROM event_sequence WHERE ${ORPHAN_EVENT_WHERE}`).get().n;
    if (mutationsAllowed && (result.orphanEvents > 0 || result.orphanSequences > 0)) {
      const deleteOrphanEvents = db.prepare(`DELETE FROM event WHERE ${ORPHAN_EVENT_WHERE}`);
      const deleteOrphanSequences = db.prepare(`DELETE FROM event_sequence WHERE ${ORPHAN_EVENT_WHERE}`);
      db.transaction(() => {
        result.deletedOrphanEvents = Number(deleteOrphanEvents.run().changes);
        result.deletedOrphanSequences = Number(deleteOrphanSequences.run().changes);
      })();
    }

    // (d) idle prune: keep the newest `keep` seqs of every idle session.
    const cutoff = startedAt - idle * 60 * 60 * 1000;
    result.prunableEvents = db.prepare(`
      SELECT COUNT(*) AS n
        FROM event e
        JOIN event_sequence es ON es.aggregate_id = e.aggregate_id
        JOIN session s ON s.id = e.aggregate_id
       WHERE s.time_updated < ? AND e.seq <= es.seq - ?
    `).get(cutoff, keep).n;
    const candidates = db.prepare(`
      SELECT s.id AS id, es.seq AS latest
        FROM session s
        JOIN event_sequence es ON es.aggregate_id = s.id
       WHERE s.time_updated < ? AND es.seq >= ?
       ORDER BY s.time_updated ASC
    `).all(cutoff, keep);
    result.candidateSessions = candidates.length;

    if (mutationsAllowed && candidates.length > 0) {
      const deleteEvents = db.prepare('DELETE FROM event WHERE aggregate_id = ? AND seq <= ?');
      const pruneBatch = db.transaction((batch) => {
        let deleted = 0;
        for (const candidate of batch) {
          const changes = Number(deleteEvents.run(candidate.id, candidate.latest - keep).changes);
          if (changes > 0) {
            deleted += changes;
            result.prunedSessions += 1;
          }
        }
        return deleted;
      });
      for (let index = 0; index < candidates.length; index += PRUNE_BATCH_SESSIONS) {
        if (overBudget()) {
          result.partial = true;
          break;
        }
        result.prunedEvents += pruneBatch(candidates.slice(index, index + PRUNE_BATCH_SESSIONS));
      }
    }
    result.deletedEvents = result.deletedOrphanEvents + result.prunedEvents;
    if (!result.dryRun && otherProcessAlive) {
      result.status = 'skipped';
      result.error = 'other_opencode_process';
    }

    // (e) VACUUM decision on the post-delete freelist.
    const afterDeletes = result.dryRun ? result.before : readSnapshot(db, dbPath);
    const decision = decideVacuum({
      mode: vacuumMode,
      freelistPages: afterDeletes.freelistPages,
      pageCount: afterDeletes.pageCount,
      dbBytes: afterDeletes.dbBytes,
      freeDiskBytes,
      otherProcesses,
    });
    result.vacuum = { requested: vacuumMode, ...decision };
    if (decision.decided && !result.dryRun) {
      if (result.partial) {
        result.vacuum = { requested: vacuumMode, decided: false, reason: 'time_budget_exhausted' };
      } else {
        const vacuumStartedAt = now();
        db.exec('VACUUM');
        try {
          db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        } catch {
          // best effort; the rebuilt file is complete either way
        }
        result.vacuumed = true;
        result.vacuumDurationMs = Math.max(0, now() - vacuumStartedAt);
      }
    }

    result.after = result.dryRun ? result.before : readSnapshot(db, dbPath);
    return finish();
  } catch (error) {
    result.status = 'error';
    result.error = error instanceof Error ? error.message : String(error);
    return finish();
  } finally {
    try {
      db?.close();
    } catch {
      // best effort
    }
  }
};
