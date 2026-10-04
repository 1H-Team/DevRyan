import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  checkOpenCodeDbSchema,
  decideVacuum,
  detectOpenCodeDbGeneration,
  inspectOpenCodeDb,
  normalizeOpenCodeDbMaintenanceSettings,
  performOpenCodeDbMaintenance,
  resolveSqliteDriver,
} from './db-maintenance-core.js';
import {
  OPENCODE_DB_MAINTENANCE_JOURNAL_EVENT,
  OPENCODE_DB_MAINTENANCE_STATE_FILE,
  createOpenCodeDbCompactionScheduler,
  createOpenCodeDbMaintenance,
  createOpenCodeDbMaintenanceInProcessExecutor,
  createOpenCodeDbMaintenanceWorkerExecutor,
  isOpenCodeProcessCommand,
  listOtherOpenCodeProcessesDefault,
} from './db-maintenance.js';
import {
  resolveOpenCodeDatabaseSelection,
  writeOpenCodeRuntimeSelection,
} from './runtime-selection.js';

// Captured from OpenCode v1.18.27 `packages/core/src/database/migration/*`
// (final shape after every ALTER): only the tables the module reads or writes,
// plus `message`/`part`/`project` so the "never touched" contract is checked.
const SCHEMA_SQL = `
CREATE TABLE project (id text PRIMARY KEY, worktree text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL);
CREATE TABLE session (
  id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL, directory text NOT NULL,
  title text NOT NULL, version text NOT NULL, share_url text, summary_additions integer, summary_deletions integer,
  summary_files integer, summary_diffs text, revert text, permission text, time_created integer NOT NULL,
  time_updated integer NOT NULL, time_compacting integer, time_archived integer, workspace_id text, path text,
  agent text, model text, cost real DEFAULT 0 NOT NULL, tokens_input integer DEFAULT 0 NOT NULL,
  tokens_output integer DEFAULT 0 NOT NULL, tokens_reasoning integer DEFAULT 0 NOT NULL,
  tokens_cache_read integer DEFAULT 0 NOT NULL, tokens_cache_write integer DEFAULT 0 NOT NULL, metadata text,
  CONSTRAINT fk_session_project_id_project_id_fk FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE
);
CREATE INDEX session_project_idx ON session (project_id);
CREATE INDEX session_parent_idx ON session (parent_id);
CREATE TABLE message (
  id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL,
  CONSTRAINT fk_message_session_id_session_id_fk FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
);
CREATE INDEX message_session_idx ON message (session_id);
CREATE TABLE part (
  id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL,
  CONSTRAINT fk_part_message_id_message_id_fk FOREIGN KEY (message_id) REFERENCES message(id) ON DELETE CASCADE
);
CREATE INDEX part_message_idx ON part (message_id);
CREATE TABLE event_sequence (aggregate_id text PRIMARY KEY, seq integer NOT NULL, owner_id text);
CREATE TABLE event (
  id text PRIMARY KEY, aggregate_id text NOT NULL, seq integer NOT NULL, type text NOT NULL, data text NOT NULL,
  CONSTRAINT fk_event_aggregate_id_event_sequence_aggregate_id_fk FOREIGN KEY (aggregate_id) REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX event_aggregate_seq_idx ON event (aggregate_id, seq);
CREATE INDEX event_aggregate_type_seq_idx ON event (aggregate_id, type, seq);
CREATE TABLE session_context_epoch (
  session_id text PRIMARY KEY, baseline text NOT NULL, snapshot text NOT NULL, baseline_seq integer NOT NULL,
  CONSTRAINT fk_session_context_epoch_session_id_session_id_fk FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
);
`;

// Every OpenCode 1.18.x database carries this migration journal (TEXT ids);
// DDL and first/last ids as a 1.18.x companion `opencode-devryan.db` has them
// (no `__drizzle_migrations`; an older `opencode.db` has both). No `kv` table.
const V1_MIGRATION_SQL = `
CREATE TABLE "migration" (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL);
INSERT INTO migration (id, time_completed) VALUES ('20260127222353_familiar_lady_ursula', 1769552633000);
INSERT INTO migration (id, time_completed) VALUES ('20260622202450_simplify_session_input', 1782160290000);
`;

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 4, 12, 0, 0);
const tempDirs = [];
// better-sqlite3 when its native binding matches this Node ABI, node:sqlite otherwise.
const driver = resolveSqliteDriver();
const openDb = (dbPath, options) => driver.open(dbPath, options);

const makeTempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-opencode-db-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

const eventData = (aggregate, seq, bytes) => JSON.stringify({
  info: { id: `msg_${aggregate}_${seq}`, sessionID: aggregate, summary: { diffs: [{ file: 'a.ts', patch: 'x'.repeat(bytes) }] } },
});

const addAggregate = (db, aggregate, { events, bytes = 64, sequenceOnly = false } = {}) => {
  db.prepare('INSERT INTO event_sequence (aggregate_id, seq, owner_id) VALUES (?, ?, NULL)').run(aggregate, events - 1);
  if (sequenceOnly) return;
  const insert = db.prepare('INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?, ?, ?, ?, ?)');
  for (let seq = 0; seq < events; seq += 1) {
    insert.run(`evt_${aggregate}_${seq}`, aggregate, seq, seq % 2 === 0 ? 'message.updated' : 'message.part.updated', eventData(aggregate, seq, bytes));
  }
};

const addSession = (db, id, { timeUpdated, events, bytes = 64, parent = null } = {}) => {
  db.prepare(`INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
              VALUES (?, 'prj_1', ?, ?, '/work', ?, '1.18.27', ?, ?)`).run(id, parent, id, `Session ${id}`, timeUpdated - HOUR, timeUpdated);
  db.prepare('INSERT INTO session_context_epoch (session_id, baseline, snapshot, baseline_seq) VALUES (?, ?, ?, ?)').run(id, 'base', '{}', 10);
  db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(`msg_${id}`, id, timeUpdated, timeUpdated, '{"role":"user"}');
  db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)').run(`prt_${id}`, `msg_${id}`, id, timeUpdated, timeUpdated, '{"type":"text"}');
  addAggregate(db, id, { events, bytes });
};

/**
 * Fixture: an active session (100 events), an idle session (100 events, big
 * payloads), a small idle session (10 events), an orphan `ses_` aggregate
 * whose session was deleted (20 events + sequence), a sequence-only orphan,
 * and a non-session aggregate (`prj_`) that must never be touched. Carries
 * the real 1.18.x `migration` journal unless `v1Journal: false`.
 */
const createFixtureDb = (dir, { idleBytes = 64, now = NOW, v1Journal = true } = {}) => {
  const dbPath = path.join(dir, 'opencode.db');
  fs.writeFileSync(dbPath, '');
  const db = openDb(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA_SQL);
  if (v1Journal) db.exec(V1_MIGRATION_SQL);
  db.prepare('INSERT INTO project (id, worktree, time_created, time_updated) VALUES (?, ?, ?, ?)').run('prj_1', '/work', now, now);
  addSession(db, 'ses_active', { timeUpdated: now - HOUR, events: 100 });
  addSession(db, 'ses_idle', { timeUpdated: now - 48 * HOUR, events: 100, bytes: idleBytes });
  addSession(db, 'ses_idle_small', { timeUpdated: now - 48 * HOUR, events: 10 });
  addAggregate(db, 'ses_deleted', { events: 20 });
  addAggregate(db, 'ses_deleted_seq_only', { events: 3, sequenceOnly: true });
  addAggregate(db, 'prj_1', { events: 5 });
  db.close();
  return dbPath;
};

const counts = (dbPath) => {
  const db = openDb(dbPath, { readonly: true });
  try {
    const one = (sql, ...params) => db.prepare(sql).get(...params).n;
    const seqs = Object.fromEntries(db.prepare('SELECT aggregate_id, seq FROM event_sequence').all().map((row) => [row.aggregate_id, row.seq]));
    return {
      events: one('SELECT COUNT(*) AS n FROM event'),
      perAggregate: Object.fromEntries(db.prepare('SELECT aggregate_id, COUNT(*) AS n, MIN(seq) AS lo, MAX(seq) AS hi FROM event GROUP BY aggregate_id').all()
        .map((row) => [row.aggregate_id, { n: row.n, lo: row.lo, hi: row.hi }])),
      seqs,
      sessions: one('SELECT COUNT(*) AS n FROM session'),
      messages: one('SELECT COUNT(*) AS n FROM message'),
      parts: one('SELECT COUNT(*) AS n FROM part'),
      epochs: one('SELECT COUNT(*) AS n FROM session_context_epoch'),
      freelist: db.pragma('freelist_count', { simple: true }),
    };
  } finally {
    db.close();
  }
};

const runCore = (dbPath, options = {}) => performOpenCodeDbMaintenance({
  driver,
  dbPath,
  now: () => NOW,
  freeDiskBytes: 1e12,
  otherProcesses: [],
  runtimeGeneration: 1,
  ...options,
});

// A v2 database migrated in place: the v1 tables the pass would otherwise
// prune (and v1's own `migration` journal) plus a `kv` table, with the
// importer's `migration.v1-v2` marker or without it (fail closed).
const createV2FixtureDb = (dir, { marker = 'kv-marker' } = {}) => {
  const dbPath = createFixtureDb(dir);
  const db = openDb(dbPath);
  db.exec('CREATE TABLE kv (key text PRIMARY KEY, value text NOT NULL)');
  if (marker === 'kv-marker') {
    db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run('migration.v1-v2', '{}');
  }
  db.close();
  return dbPath;
};

// Records every open so a test can assert a file was never opened for writing.
const recordingDriver = () => {
  const opens = [];
  return {
    opens,
    driver: {
      name: driver.name,
      open: (dbPath, options = {}) => {
        opens.push({ dbPath, readonly: options.readonly === true });
        return driver.open(dbPath, options);
      },
    },
  };
};

// Native launches only write generation 2. Legacy core tests inject their
// disposable database explicitly; they do not manufacture a runnable v1 host.
const recordSelection = (dataDir, dbPath, { ownerPid = process.pid } = {}) => writeOpenCodeRuntimeSelection({
  version: 1, writtenAt: NOW, ownerPid,
  runtime: { generation: 2, kind: 'host', binary: '/fixture/native-controller', channel: 'opencode' },
  opencode: { dataDirectory: path.dirname(dbPath), databasePath: dbPath, configDirectory: null, databaseSource: 'OPENCODE_DB' },
}, { dataDir });
const legacyFixtureSelection = dbPath => ({ path: dbPath, source: 'selection', selection: { runtime: { generation: 1 } } });

describe('normalizeOpenCodeDbMaintenanceSettings', () => {
  it('defaults, clamps and honours the opt-out', () => {
    expect(normalizeOpenCodeDbMaintenanceSettings(undefined)).toEqual({ enabled: true, idleHours: 24, keepSeqPerAggregate: 64 });
    expect(normalizeOpenCodeDbMaintenanceSettings({ enabled: false, idleHours: '72', keepSeqPerAggregate: 0 }))
      .toEqual({ enabled: false, idleHours: 72, keepSeqPerAggregate: 1 });
    expect(normalizeOpenCodeDbMaintenanceSettings({ idleHours: -5, keepSeqPerAggregate: 'nope' }))
      .toEqual({ enabled: true, idleHours: 1, keepSeqPerAggregate: 64 });
    expect(normalizeOpenCodeDbMaintenanceSettings([]).enabled).toBe(true);
  });
});

describe('decideVacuum', () => {
  const base = { freelistPages: 100, pageCount: 400, dbBytes: 1000, freeDiskBytes: 5000, otherProcesses: [] };

  it('never runs unless asked, and refuses next to another OpenCode process or without room', () => {
    expect(decideVacuum({ ...base, mode: 'never' })).toEqual({ decided: false, reason: 'not_requested' });
    expect(decideVacuum({ ...base, mode: 'force', otherProcesses: [{ pid: 9, command: 'opencode serve' }] }))
      .toEqual({ decided: false, reason: 'other_opencode_process' });
    expect(decideVacuum({ ...base, mode: 'force', freeDiskBytes: 1100 })).toEqual({ decided: false, reason: 'insufficient_free_disk' });
    expect(decideVacuum({ ...base, mode: 'force', freeDiskBytes: null })).toEqual({ decided: false, reason: 'free_disk_unknown' });
    expect(decideVacuum({ ...base, mode: 'force' })).toEqual({ decided: true, reason: 'forced' });
  });

  it('auto vacuums only when the freelist exceeds 15 % of pages', () => {
    expect(decideVacuum({ ...base, mode: 'auto' })).toEqual({ decided: true, reason: 'freelist_above_threshold' });
    expect(decideVacuum({ ...base, mode: 'auto', freelistPages: 40 })).toEqual({ decided: false, reason: 'freelist_below_threshold' });
    expect(decideVacuum({ ...base, mode: 'auto', pageCount: 0, freelistPages: 0 })).toEqual({ decided: false, reason: 'freelist_below_threshold' });
    expect(decideVacuum({ ...base, mode: 'bogus' })).toEqual({ decided: false, reason: 'not_requested' });
  });
});

describe('performOpenCodeDbMaintenance', () => {
  it('purges event and sequence rows only for ses_ aggregates whose session is gone', () => {
    const dbPath = createFixtureDb(makeTempDir());

    const result = runCore(dbPath, { keepSeqPerAggregate: 1000 });

    expect(result.status).toBe('ok');
    expect(result.orphanEvents).toBe(20);
    expect(result.orphanSequences).toBe(2);
    expect(result.deletedOrphanEvents).toBe(20);
    expect(result.deletedOrphanSequences).toBe(2);
    const after = counts(dbPath);
    expect(after.perAggregate.ses_deleted).toBeUndefined();
    expect(after.seqs.ses_deleted).toBeUndefined();
    expect(after.seqs.ses_deleted_seq_only).toBeUndefined();
    // Non-session aggregates are never touched.
    expect(after.perAggregate.prj_1).toEqual({ n: 5, lo: 0, hi: 4 });
    expect(after.seqs.prj_1).toBe(4);
  });

  it('prunes idle sessions to the newest K seqs, keeps event_sequence and leaves active sessions alone', () => {
    const dbPath = createFixtureDb(makeTempDir());
    const before = counts(dbPath);

    const result = runCore(dbPath, { idleHours: 24, keepSeqPerAggregate: 64 });

    expect(result.candidateSessions).toBe(1);
    expect(result.prunableEvents).toBe(36);
    expect(result.prunedSessions).toBe(1);
    expect(result.prunedEvents).toBe(36);
    expect(result.deletedEvents).toBe(20 + 36);
    expect(result.partial).toBe(false);
    const after = counts(dbPath);
    expect(after.perAggregate.ses_idle).toEqual({ n: 64, lo: 36, hi: 99 });
    expect(after.perAggregate.ses_active).toEqual({ n: 100, lo: 0, hi: 99 });
    expect(after.perAggregate.ses_idle_small).toEqual({ n: 10, lo: 0, hi: 9 });
    // Sequence continuity: the latest seq survives for every live session.
    expect(after.seqs).toEqual({ ses_active: 99, ses_idle: 99, ses_idle_small: 9, prj_1: 4 });
    expect(after.events).toBe(before.events - 56);
    expect(result.before.eventRows).toBe(before.events);
    expect(result.after.eventRows).toBe(after.events);
  });

  it('honours a smaller keep window and the idle threshold', () => {
    const dbPath = createFixtureDb(makeTempDir());

    // 100 hours idle threshold: nothing is idle yet.
    expect(runCore(dbPath, { idleHours: 100, keepSeqPerAggregate: 8 }).prunedEvents).toBe(0);
    const untouched = counts(dbPath);
    expect(untouched.perAggregate.ses_idle.n).toBe(100);

    const result = runCore(dbPath, { idleHours: 24, keepSeqPerAggregate: 8 });
    expect(result.prunedSessions).toBe(2);
    expect(result.prunedEvents).toBe(92 + 2);
    const after = counts(dbPath);
    expect(after.perAggregate.ses_idle).toEqual({ n: 8, lo: 92, hi: 99 });
    expect(after.perAggregate.ses_idle_small).toEqual({ n: 8, lo: 2, hi: 9 });
    expect(after.perAggregate.ses_active.n).toBe(100);
  });

  it('never writes message, part, session or session_context_epoch rows', () => {
    const dbPath = createFixtureDb(makeTempDir());
    const before = counts(dbPath);

    runCore(dbPath, { keepSeqPerAggregate: 8, vacuum: 'force' });

    const after = counts(dbPath);
    expect(after.sessions).toBe(before.sessions);
    expect(after.messages).toBe(before.messages);
    expect(after.parts).toBe(before.parts);
    expect(after.epochs).toBe(before.epochs);
  });

  it('dry run reports what would happen and mutates nothing', () => {
    const dbPath = createFixtureDb(makeTempDir());
    const before = counts(dbPath);
    const sizeBefore = fs.statSync(dbPath).size;

    const result = runCore(dbPath, { dryRun: true, keepSeqPerAggregate: 64, vacuum: 'force' });

    expect(result.dryRun).toBe(true);
    expect(result.status).toBe('ok');
    expect(result.orphanEvents).toBe(20);
    expect(result.prunableEvents).toBe(36);
    expect(result.candidateSessions).toBe(1);
    expect(result.deletedEvents).toBe(0);
    expect(result.prunedEvents).toBe(0);
    expect(result.vacuumed).toBe(false);
    expect(result.vacuum).toEqual({ requested: 'force', decided: true, reason: 'forced' });
    expect(result.after).toBe(result.before);
    expect(counts(dbPath)).toEqual(before);
    expect(fs.statSync(dbPath).size).toBe(sizeBefore);
  });

  it('aborts with schema_mismatch before touching anything when a table changed shape', () => {
    const dir = makeTempDir();
    const dbPath = createFixtureDb(dir);
    const db = openDb(dbPath);
    db.exec('ALTER TABLE event_sequence RENAME COLUMN seq TO sequence');
    const eventsBefore = db.prepare('SELECT COUNT(*) AS n FROM event').get().n;
    db.close();

    const result = runCore(dbPath, { vacuum: 'force' });

    expect(result.status).toBe('skipped');
    expect(result.schema).toBe('mismatch');
    expect(result.error).toBe('schema_mismatch: event_sequence.seq');
    expect(result.before).toBeNull();
    expect(result.vacuumed).toBe(false);
    const db2 = openDb(dbPath, { readonly: true });
    expect(db2.prepare('SELECT COUNT(*) AS n FROM event').get().n).toBe(eventsBefore);
    expect(eventsBefore).toBe(235);
    db2.close();

    const otherPath = path.join(dir, 'other.db');
    fs.writeFileSync(otherPath, '');
    const missingTable = openDb(otherPath);
    missingTable.exec('CREATE TABLE event (id text PRIMARY KEY, aggregate_id text, seq integer, type text, data text)');
    expect(checkOpenCodeDbSchema(missingTable)).toEqual({
      ok: false,
      missing: ['event_sequence', 'session', 'session_context_epoch'],
    });
    missingTable.close();
  });

  it('reports a missing database as skipped without creating it', () => {
    const dbPath = path.join(makeTempDir(), 'opencode.db');

    const result = runCore(dbPath);

    expect(result).toMatchObject({ status: 'skipped', error: 'missing_database', deletedEvents: 0 });
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it('VACUUMs on force when the guards allow it, and reports the reason when they do not', () => {
    const dbPath = createFixtureDb(makeTempDir(), { idleBytes: 8 * 1024 });

    // Another OpenCode process alive: nothing is deleted or vacuumed (a long
    // delete would outlast its 5 s busy timeout); the counts are still reported.
    const eventsBeforeBlocked = counts(dbPath).events;
    const blocked = runCore(dbPath, { keepSeqPerAggregate: 8, vacuum: 'force', otherProcesses: [{ pid: 42, command: 'opencode serve --port 4096' }] });
    expect(blocked.vacuumed).toBe(false);
    expect(blocked.vacuum).toEqual({ requested: 'force', decided: false, reason: 'other_opencode_process' });
    expect(blocked).toMatchObject({ status: 'skipped', error: 'other_opencode_process', deletedEvents: 0, prunedSessions: 0 });
    expect(blocked.orphanEvents + blocked.prunableEvents).toBeGreaterThan(0);
    expect(counts(dbPath).events).toBe(eventsBeforeBlocked);

    const deletesOnly = runCore(dbPath, { keepSeqPerAggregate: 8, vacuum: 'never' });
    expect(deletesOnly.status).toBe('ok');
    expect(deletesOnly.deletedEvents).toBeGreaterThan(0);
    const freelistAfterDeletes = counts(dbPath).freelist;
    expect(freelistAfterDeletes).toBeGreaterThan(0);
    expect(deletesOnly.after.freelistPages).toBe(freelistAfterDeletes);
    expect(deletesOnly.after.reclaimableBytes).toBe(freelistAfterDeletes * deletesOnly.after.pageSize);

    const noRoom = runCore(dbPath, { vacuum: 'force', freeDiskBytes: 10 });
    expect(noRoom.vacuum).toEqual({ requested: 'force', decided: false, reason: 'insufficient_free_disk' });

    const sizeBefore = fs.statSync(dbPath).size;
    const forced = runCore(dbPath, { vacuum: 'force' });
    expect(forced.vacuumed).toBe(true);
    expect(forced.vacuum).toEqual({ requested: 'force', decided: true, reason: 'forced' });
    expect(forced.after.freelistPages).toBe(0);
    expect(forced.after.dbBytes).toBeLessThan(sizeBefore);
    expect(counts(dbPath).freelist).toBe(0);
  });

  it('auto VACUUMs only above the freelist threshold', () => {
    const dbPath = createFixtureDb(makeTempDir(), { idleBytes: 8 * 1024 });

    const first = runCore(dbPath, { keepSeqPerAggregate: 8, vacuum: 'auto' });
    expect(first.vacuum).toEqual({ requested: 'auto', decided: true, reason: 'freelist_above_threshold' });
    expect(first.vacuumed).toBe(true);

    const second = runCore(dbPath, { keepSeqPerAggregate: 8, vacuum: 'auto' });
    expect(second.deletedEvents).toBe(0);
    expect(second.vacuum).toEqual({ requested: 'auto', decided: false, reason: 'freelist_below_threshold' });
    expect(second.vacuumed).toBe(false);
  });

  it('stops pruning when the time budget is exhausted and skips the VACUUM', () => {
    const dbPath = createFixtureDb(makeTempDir());
    let tick = 0;
    // Every clock read advances 30 s, so the first batch already exceeds a 20 s budget.
    const now = () => NOW + (tick += 30_000);

    const result = runCore(dbPath, { now, timeBudgetMs: 20_000, keepSeqPerAggregate: 8, vacuum: 'force' });

    expect(result.status).toBe('ok');
    expect(result.partial).toBe(true);
    expect(result.prunedEvents).toBe(0);
    expect(result.deletedOrphanEvents).toBe(20);
    expect(result.vacuum).toEqual({ requested: 'force', decided: false, reason: 'time_budget_exhausted' });
    expect(result.vacuumed).toBe(false);
    expect(counts(dbPath).perAggregate.ses_idle.n).toBe(100);
  });

  it.each(['kv-marker', 'kv-table'])('refuses to write a v2 database (%s) and deletes nothing', (marker) => {
    const dbPath = createV2FixtureDb(makeTempDir(), { marker });
    const before = counts(dbPath);
    const { driver: recorded, opens } = recordingDriver();

    const result = runCore(dbPath, { driver: recorded, keepSeqPerAggregate: 8, vacuum: 'force' });

    expect(result).toMatchObject({
      status: 'skipped',
      error: 'v2_database',
      generation: 2,
      deletedEvents: 0,
      deletedOrphanEvents: 0,
      prunedEvents: 0,
      vacuumed: false,
      before: null,
    });
    expect(counts(dbPath)).toEqual(before);
    expect(before.events).toBe(235);
    // Never opened read-write: closing such a connection would checkpoint the WAL.
    expect(opens).toEqual([{ dbPath, readonly: true }]);
    expect(runCore(dbPath, { driver: recorded, dryRun: true })).toMatchObject({ status: 'skipped', error: 'v2_database', generation: 2 });
    expect(opens.every((entry) => entry.readonly)).toBe(true);
  });

  it('still maintains a real-shaped 1.18.x database (v1 `migration` journal, no drizzle table)', () => {
    const dbPath = createFixtureDb(makeTempDir());
    const { driver: recorded, opens } = recordingDriver();

    const result = runCore(dbPath, { driver: recorded, keepSeqPerAggregate: 64 });

    expect(result).toMatchObject({ status: 'ok', generation: 1, schema: 'ok', deletedEvents: 56, error: null });
    expect(counts(dbPath).events).toBe(179);
    // Generation probed read-only first, then reopened for the writes.
    expect(opens).toEqual([{ dbPath, readonly: true }, { dbPath, readonly: false }]);
  });

  it('never opens a file read-write that is not positively a v1 database', () => {
    // Schema-complete but without any v1 migration journal: neither v1 nor v2.
    const dbPath = createFixtureDb(makeTempDir(), { v1Journal: false });
    const before = counts(dbPath);
    const { driver: recorded, opens } = recordingDriver();

    const result = runCore(dbPath, { driver: recorded, keepSeqPerAggregate: 8, vacuum: 'force' });

    expect(result).toMatchObject({ status: 'skipped', error: 'database_generation_unknown', generation: 'unknown', deletedEvents: 0, vacuumed: false, before: null });
    expect(counts(dbPath)).toEqual(before);
    expect(opens).toEqual([{ dbPath, readonly: true }]);
  });

  it('mutates only for a named generation-1 runtime; dry runs need none', () => {
    const dbPath = createFixtureDb(makeTempDir());
    const before = counts(dbPath);

    expect(runCore(dbPath, { runtimeGeneration: null, vacuum: 'force' }))
      .toMatchObject({ status: 'skipped', error: 'runtime_generation_unknown', deletedEvents: 0, vacuumed: false });
    expect(runCore(dbPath, { runtimeGeneration: undefined }))
      .toMatchObject({ status: 'skipped', error: 'runtime_generation_unknown' });
    expect(runCore(dbPath, { runtimeGeneration: 2 }))
      .toMatchObject({ status: 'skipped', error: 'runtime_generation_unsupported', deletedEvents: 0 });
    expect(counts(dbPath)).toEqual(before);

    expect(runCore(dbPath, { runtimeGeneration: null, dryRun: true }))
      .toMatchObject({ status: 'ok', orphanEvents: 20, prunableEvents: 36, deletedEvents: 0 });
    expect(counts(dbPath)).toEqual(before);
  });
});

describe('detectOpenCodeDbGeneration', () => {
  const generationOf = (dbPath, mutate = () => {}) => {
    const db = openDb(dbPath);
    try {
      mutate(db);
      return detectOpenCodeDbGeneration(db);
    } finally {
      db.close();
    }
  };

  it('recognises every 1.18.x shape as v1; a `migration` table alone is not v2', () => {
    // Companion `opencode-devryan.db`: `migration` + `session_context_epoch`, no drizzle table.
    expect(generationOf(createFixtureDb(makeTempDir()))).toBe(1);
    // Older `opencode.db`: both journals.
    expect(generationOf(createFixtureDb(makeTempDir()), (db) => {
      db.exec('CREATE TABLE __drizzle_migrations (id integer PRIMARY KEY, hash text NOT NULL, created_at numeric)');
    })).toBe(1);
    // Drizzle journal only.
    expect(generationOf(createFixtureDb(makeTempDir(), { v1Journal: false }), (db) => {
      db.exec('CREATE TABLE __drizzle_migrations (id integer PRIMARY KEY, hash text NOT NULL, created_at numeric)');
    })).toBe(1);
  });

  it('reports unknown without a v1 journal or without session_context_epoch', () => {
    expect(generationOf(createFixtureDb(makeTempDir(), { v1Journal: false }))).toBe('unknown');
    expect(generationOf(createFixtureDb(makeTempDir()), (db) => db.exec('DROP TABLE session_context_epoch'))).toBe('unknown');
  });

  it('recognises v2 by its kv table, with or without the migration.v1-v2 marker', () => {
    for (const marker of ['kv-marker', 'kv-table']) {
      expect(generationOf(createV2FixtureDb(makeTempDir(), { marker }))).toBe(2);
    }
  });
});

describe('inspectOpenCodeDb', () => {
  it('reports sizes, rows and orphans read-only', () => {
    const dbPath = createFixtureDb(makeTempDir());

    const inspection = inspectOpenCodeDb({ driver, dbPath });

    expect(inspection).toMatchObject({ dbPath, exists: true, generation: 1, schema: 'ok', eventRows: 235, orphanEventRows: 20, error: null });
    expect(inspection.dbBytes).toBeGreaterThan(0);
    expect(inspection.pageSize).toBeGreaterThan(0);
    expect(inspection.reclaimableBytes).toBe(inspection.freelistPages * inspection.pageSize);
    expect(counts(dbPath).events).toBe(235);
  });

  it('flags a missing file and a mismatched schema', () => {
    const dir = makeTempDir();
    expect(inspectOpenCodeDb({ driver, dbPath: path.join(dir, 'missing.db') })).toMatchObject({ exists: false, schema: 'unknown', eventRows: 0 });

    const dbPath = path.join(dir, 'odd.db');
    fs.writeFileSync(dbPath, '');
    const db = openDb(dbPath);
    db.exec('CREATE TABLE event (id text PRIMARY KEY)');
    db.close();
    const inspection = inspectOpenCodeDb({ driver, dbPath });
    expect(inspection.exists).toBe(true);
    expect(inspection.schema).toBe('mismatch');
    expect(inspection.error).toContain('schema_mismatch');
  });

  it('reports the database generation and stops at a v2 file, opening it read-only', () => {
    const v2Path = createV2FixtureDb(makeTempDir());
    const { driver: recorded, opens } = recordingDriver();
    expect(inspectOpenCodeDb({ driver: recorded, dbPath: v2Path })).toMatchObject({ exists: true, generation: 2, error: 'v2_database', eventRows: 0 });
    expect(opens).toEqual([{ dbPath: v2Path, readonly: true }]);

    const v1Path = createFixtureDb(makeTempDir());
    expect(inspectOpenCodeDb({ driver, dbPath: v1Path })).toMatchObject({ generation: 1, schema: 'ok', eventRows: 235, error: null });
  });
});

describe('createOpenCodeDbMaintenance', () => {
  const createRuntime = (dbPath, dataDir, { selection = true, ...overrides } = {}) => {
    const journal = vi.fn();
    const logger = { log: vi.fn(), warn: vi.fn() };
    const maintenance = createOpenCodeDbMaintenance({
      dataDir,
      resolveDatabase: () => selection ? legacyFixtureSelection(dbPath)
        : resolveOpenCodeDatabaseSelection({ dataDir, opencodeDataPath: path.dirname(dbPath) }),
      now: () => NOW,
      checkFreeDiskBytes: () => 1e12,
      listOtherOpenCodeProcesses: () => [],
      journal,
      logger,
      execute: createOpenCodeDbMaintenanceInProcessExecutor({ loadDriver: () => driver, now: () => NOW }),
      ...overrides,
    });
    return { maintenance, journal, logger };
  };

  it('persists the last run, journals it and exposes it through inspect()', async () => {
    const dir = makeTempDir();
    const dbPath = createFixtureDb(dir);
    const { maintenance, journal, logger } = createRuntime(dbPath, dir);

    expect((await maintenance.inspect()).lastRun).toBeNull();
    const result = await maintenance.run({ vacuum: 'never', keepSeqPerAggregate: 64, timeBudgetMs: 20_000, reason: 'startup' });

    expect(result).toMatchObject({ status: 'ok', reason: 'startup', dryRun: false, deletedEvents: 56, vacuumed: false });
    expect(result.vacuum).toEqual({ requested: 'never', decided: false, reason: 'not_requested' });
    const statePath = path.join(dir, OPENCODE_DB_MAINTENANCE_STATE_FILE);
    expect(maintenance.statePath).toBe(statePath);
    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(persisted.lastRun).toMatchObject({ at: NOW, deletedEvents: 56, vacuumed: false, dryRun: false });
    expect(persisted.lastRun.before.eventRows).toBe(235);
    expect(persisted.lastRun.after.eventRows).toBe(179);
    expect(persisted.lastDryRun).toBeNull();
    expect(journal).toHaveBeenCalledWith(expect.objectContaining({
      type: 'log',
      level: 'info',
      event: OPENCODE_DB_MAINTENANCE_JOURNAL_EVENT,
      payload: expect.objectContaining({ deletedEvents: 56, reason: 'startup' }),
    }));
    expect(logger.log).toHaveBeenCalled();

    const inspection = await maintenance.inspect();
    expect(inspection.lastRun).toMatchObject({ deletedEvents: 56 });
    expect(inspection.eventRows).toBe(179);
    expect(inspection.orphanEventRows).toBe(0);
  });

  it('keeps dry runs separate from the last real run', async () => {
    const dir = makeTempDir();
    const dbPath = createFixtureDb(dir);
    const { maintenance, journal } = createRuntime(dbPath, dir);

    const dry = await maintenance.run({ dryRun: true, vacuum: 'force' });
    expect(dry).toMatchObject({ dryRun: true, reason: 'dry_run', deletedEvents: 0, orphanEvents: 20, prunableEvents: 36 });
    expect(dry.vacuum).toEqual({ requested: 'force', decided: true, reason: 'forced' });
    const state = maintenance.readState();
    expect(state.lastRun).toBeNull();
    expect(state.lastDryRun).toMatchObject({ dryRun: true });
    expect(journal).toHaveBeenCalledTimes(1);
    expect(counts(dbPath).events).toBe(235);
  });

  it('reports a host without any SQLite driver as a quiet skip', async () => {
    const dir = makeTempDir();
    const dbPath = createFixtureDb(dir);
    const { maintenance, logger } = createRuntime(dbPath, dir, {
      execute: createOpenCodeDbMaintenanceInProcessExecutor({
        loadDriver: () => { throw new Error('No SQLite driver available (better-sqlite3: not yet supported in Bun)'); },
        now: () => NOW,
      }),
    });

    const result = await maintenance.run({ reason: 'startup' });

    expect(result).toMatchObject({ status: 'skipped', error: 'no_sqlite_driver', deletedEvents: 0 });
    expect(logger.warn).not.toHaveBeenCalled();
    expect((await maintenance.inspect()).lastRun).toMatchObject({ status: 'skipped', error: 'no_sqlite_driver' });
  });

  it('skips a missing database without writing state', async () => {
    const dir = makeTempDir();
    const { maintenance, journal } = createRuntime(path.join(dir, 'opencode.db'), dir);

    const result = await maintenance.run();

    expect(result).toMatchObject({ status: 'skipped', error: 'missing_database' });
    expect(fs.existsSync(path.join(dir, OPENCODE_DB_MAINTENANCE_STATE_FILE))).toBe(false);
    expect(journal).not.toHaveBeenCalled();
  });

  it('turns a failing process listing into a skipped run and an executor failure into an error run', async () => {
    const dir = makeTempDir();
    const dbPath = createFixtureDb(dir);
    const eventsBefore = counts(dbPath).events;
    const { maintenance } = createRuntime(dbPath, dir, {
      listOtherOpenCodeProcesses: () => { throw new Error('ps unavailable'); },
    });
    // Unknown process state counts as "another OpenCode may be writing":
    // nothing is deleted or vacuumed, the counts are still reported.
    const vetoed = await maintenance.run({ vacuum: 'force' });
    expect(vetoed.vacuum).toEqual({ requested: 'force', decided: false, reason: 'other_opencode_process' });
    expect(vetoed).toMatchObject({ status: 'skipped', error: 'other_opencode_process', deletedEvents: 0 });
    expect(counts(dbPath).events).toBe(eventsBefore);

    const { maintenance: failing, journal } = createRuntime(dbPath, dir, {
      execute: async () => { throw new Error('worker crashed'); },
    });
    const failed = await failing.run({ reason: 'restart' });
    expect(failed).toMatchObject({ status: 'error', error: 'worker crashed', reason: 'restart', deletedEvents: 0 });
    expect(journal).toHaveBeenCalledWith(expect.objectContaining({ level: 'warn' }));
    expect(failing.readState().lastRun).toMatchObject({ status: 'error' });
  });

  it('coalesces concurrent runs', async () => {
    const dir = makeTempDir();
    const dbPath = createFixtureDb(dir);
    let calls = 0;
    const { maintenance } = createRuntime(dbPath, dir, {
      execute: async (input) => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return performOpenCodeDbMaintenance({ driver, now: () => NOW, ...input });
      },
    });

    const [first, second] = await Promise.all([maintenance.run({ keepSeqPerAggregate: 64 }), maintenance.run({ keepSeqPerAggregate: 64 })]);

    expect(calls).toBe(1);
    expect(first).toBe(second);
    expect(maintenance.isRunning()).toBe(false);
  });

  it('refuses mutations without a runtime selection, persisting and journaling the skip', async () => {
    const dir = makeTempDir();
    const dbPath = createFixtureDb(dir);
    const before = counts(dbPath);
    // Legacy fallback over the fixture directory only (never the real data dir).
    const resolveDatabase = () => resolveOpenCodeDatabaseSelection({ dataDir: dir, opencodeDataPath: dir });
    const { maintenance, journal } = createRuntime(dbPath, dir, { selection: false, resolveDatabase });

    const result = await maintenance.run({ vacuum: 'force', reason: 'startup' });

    expect(result).toMatchObject({
      status: 'skipped',
      error: 'runtime_selection_unavailable',
      dbSource: 'legacy-newest',
      runtimeGeneration: null,
      deletedEvents: 0,
      vacuumed: false,
    });
    expect(counts(dbPath)).toEqual(before);
    expect(maintenance.readState().lastRun).toMatchObject({ status: 'skipped', error: 'runtime_selection_unavailable' });
    expect(journal).toHaveBeenCalledWith(expect.objectContaining({
      event: OPENCODE_DB_MAINTENANCE_JOURNAL_EVENT,
      payload: expect.objectContaining({ error: 'runtime_selection_unavailable' }),
    }));

    // Read-only views may still use the legacy guess, and say so.
    const dry = await maintenance.run({ dryRun: true });
    expect(dry).toMatchObject({ status: 'ok', dbSource: 'legacy-newest', orphanEvents: 20, deletedEvents: 0 });
    const inspection = await maintenance.inspect();
    expect(inspection).toMatchObject({ dbPath, dbSource: 'legacy-newest', runtimeGeneration: null, eventRows: 235 });
    expect(counts(dbPath)).toEqual(before);
  });

  it('treats a record written by another server process as no selection', async () => {
    const dir = makeTempDir();
    const dbPath = createFixtureDb(dir);
    const before = counts(dbPath);
    recordSelection(dir, dbPath, { ownerPid: process.pid + 1 });
    const { maintenance } = createRuntime(dbPath, dir, { selection: false });

    expect(await maintenance.run({ vacuum: 'force' }))
      .toMatchObject({ status: 'skipped', error: 'runtime_selection_unavailable', runtimeGeneration: null, deletedEvents: 0 });
    expect(counts(dbPath)).toEqual(before);
  });

  it('passes the native selected generation to the core and refuses legacy pruning', async () => {
    const dir = makeTempDir();
    const dbPath = createFixtureDb(dir);
    recordSelection(dir, dbPath);
    const { maintenance } = createRuntime(dbPath, dir, { selection: false });

    expect(maintenance.dbPath).toBe(dbPath);
    expect(await maintenance.inspect()).toMatchObject({ dbPath, dbSource: 'selection', runtimeGeneration: 2 });
    const eventsBefore = counts(dbPath).events;
    expect(await maintenance.run({ keepSeqPerAggregate: 8 }))
      .toMatchObject({ status: 'skipped', error: 'runtime_generation_unsupported', runtimeGeneration: 2, deletedEvents: 0 });
    expect(counts(dbPath).events).toBe(eventsBefore);
  });

  it('never prunes a v2 database even when the legacy core fixture names it', async () => {
    const dir = makeTempDir();
    const dbPath = createV2FixtureDb(dir);
    const before = counts(dbPath);
    const { maintenance } = createRuntime(dbPath, dir);

    const result = await maintenance.run({ vacuum: 'force', keepSeqPerAggregate: 8, reason: 'compact' });

    expect(result).toMatchObject({ status: 'skipped', error: 'v2_database', generation: 2, deletedEvents: 0, vacuumed: false });
    expect(counts(dbPath)).toEqual(before);
    expect(maintenance.readState().lastRun).toMatchObject({ error: 'v2_database' });
  });

  it('runs end-to-end through the worker-thread executor', async () => {
    const dir = makeTempDir();
    // The real worker has its own clock; keep its active/idle fixtures relative
    // to wall time while deterministic in-process tests retain the fixed NOW.
    const dbPath = createFixtureDb(dir, { idleBytes: 8 * 1024, now: Date.now() });
    const journal = vi.fn();
    const maintenance = createOpenCodeDbMaintenance({
      dataDir: dir,
      resolveDatabase: () => legacyFixtureSelection(dbPath),
      checkFreeDiskBytes: () => 1e12,
      listOtherOpenCodeProcesses: () => [],
      journal,
      logger: { log: vi.fn(), warn: vi.fn() },
    });

    const result = await maintenance.run({ vacuum: 'force', keepSeqPerAggregate: 64, reason: 'compact' });

    expect(result).toMatchObject({ status: 'ok', reason: 'compact', deletedEvents: 56, vacuumed: true });
    expect(result.prunedSessions).toBe(1);
    expect(result.after.freelistPages).toBe(0);
    expect(counts(dbPath).perAggregate.ses_active).toEqual({ n: 100, lo: 0, hi: 99 });
    expect(counts(dbPath).perAggregate.ses_idle).toEqual({ n: 64, lo: 36, hi: 99 });
    expect(journal).toHaveBeenCalledTimes(1);
  }, 20_000);

  it('falls back to an in-process run when the worker cannot start', async () => {
    const dir = makeTempDir();
    const dbPath = createFixtureDb(dir);
    const logger = { log: vi.fn(), warn: vi.fn() };
    const execute = createOpenCodeDbMaintenanceWorkerExecutor({
      loadDriver: () => driver,
      now: () => NOW,
      logger,
      workerUrl: new URL('./db-maintenance-worker.missing.js', import.meta.url),
    });

    const result = await execute({ dbPath, dryRun: false, idleHours: 24, keepSeqPerAggregate: 64, vacuum: 'never', timeBudgetMs: null, reason: 'startup', freeDiskBytes: 1e12, otherProcesses: [], runtimeGeneration: 1 });

    expect(result).toMatchObject({ status: 'ok', deletedEvents: 56 });
    expect(logger.warn).toHaveBeenCalledWith(
      '[OpenCode] Database maintenance worker unavailable; running in-process:',
      expect.stringContaining('did not start'),
    );
    expect(counts(dbPath).perAggregate.ses_idle).toEqual({ n: 64, lo: 36, hi: 99 });
  }, 20_000);
});

describe('createOpenCodeDbCompactionScheduler', () => {
  it('is a one-shot flag', () => {
    const scheduler = createOpenCodeDbCompactionScheduler();
    expect(scheduler.isForcedPending()).toBe(false);
    expect(scheduler.consumeForced()).toBe(false);
    scheduler.scheduleForced();
    expect(scheduler.isForcedPending()).toBe(true);
    expect(scheduler.consumeForced()).toBe(true);
    expect(scheduler.consumeForced()).toBe(false);
    expect(scheduler.isForcedPending()).toBe(false);
  });
});

describe('other OpenCode process detection', () => {
  it('recognises OpenCode binaries and serve commands but not the DevRyan server', () => {
    expect(isOpenCodeProcessCommand('/Users/z/.config/openchamber/bin/opencode serve --port 4096')).toBe(true);
    expect(isOpenCodeProcessCommand('/opt/opencode-darwin-arm64/bin/opencode-darwin-arm64 serve')).toBe(true);
    expect(isOpenCodeProcessCommand('opencode')).toBe(true);
    expect(isOpenCodeProcessCommand('C:\\tools\\opencode.exe serve')).toBe(true);
    expect(isOpenCodeProcessCommand('node /app/packages/web/server/index.js')).toBe(false);
    expect(isOpenCodeProcessCommand('/Applications/DevRyan.app/Contents/MacOS/DevRyan')).toBe(false);
    expect(isOpenCodeProcessCommand('vim opencode-notes.md')).toBe(false);
    expect(isOpenCodeProcessCommand('')).toBe(false);
    expect(isOpenCodeProcessCommand(null)).toBe(false);
  });

  it('merges live registry children of other owners with ps matches and drops itself', () => {
    const processes = listOtherOpenCodeProcessesDefault({
      selfPid: 100,
      readRegistry: () => [
        { childPid: 200, ownerPid: 150, binary: '/bin/opencode' },
        { childPid: 300, ownerPid: 100, binary: '/bin/opencode' },
        { childPid: 100, ownerPid: 1, binary: '/bin/opencode' },
      ],
      isRunning: (pid) => pid !== 300,
      readProcessTable: () => [
        { pid: 200, command: '/bin/opencode serve --port 4096' },
        { pid: 400, command: '/usr/local/bin/opencode' },
        { pid: 500, command: 'node /app/server/index.js' },
        { pid: 100, command: 'opencode serve' },
      ],
    });

    expect(processes.map((entry) => entry.pid).sort()).toEqual([200, 400]);
    expect(processes.find((entry) => entry.pid === 200).source).toBe('registry');
    expect(processes.find((entry) => entry.pid === 400).source).toBe('ps');
  });
});
