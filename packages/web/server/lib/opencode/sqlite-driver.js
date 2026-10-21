// ---------------------------------------------------------------------------
// SQLite driver resolution for DevRyan's own database access (native runtime
// bundles, clone verification, QA and package lanes).
//
// This module has no project imports so it can run inside a worker thread.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const SQLITE_DRIVER_ORDER = Object.freeze(['better-sqlite3', 'node:sqlite', 'bun:sqlite']);

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
