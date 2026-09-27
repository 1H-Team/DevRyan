import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  BOT_DB_BOOTSTRAP,
  BOT_DB_MIGRATIONS,
  REVIEWED_SOURCE_SCHEMAS,
} from './inventory.js';

export const BOT_DATABASE_NAME = 'devryan_bots';
export const BOT_DATABASE_NAME_PATTERN = /^devryan_bots(?:_(?:candidate|source|retired)_[0-9a-f]{16,32})?$/;
const MAX_SQL_BYTES = 2 * 1024 * 1024;

export class BotDatabaseInventoryError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'BotDatabaseInventoryError';
    this.code = code;
  }
}

const fail = (message, code) => {
  throw new BotDatabaseInventoryError(message, code);
};

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const readVerified = async (directory, filename, expectedSha256, fsImpl) => {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    fail('Bot database SQL directory must be absolute', 'bot_database_inventory_invalid');
  }
  const target = path.join(directory, filename);
  if (path.dirname(target) !== path.resolve(directory)) {
    fail('Bot database SQL path is invalid', 'bot_database_inventory_invalid');
  }
  let handle;
  try {
    handle = await fsImpl.open(target, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_SQL_BYTES) {
      fail(`Bot database SQL file ${filename} is invalid`, 'bot_database_inventory_invalid');
    }
    const bytes = await handle.readFile();
    if (sha256(bytes) !== expectedSha256) {
      fail(`Bot database SQL file ${filename} does not match its reviewed checksum`, 'bot_database_inventory_drift');
    }
    return bytes.toString('utf8');
  } catch (error) {
    if (error instanceof BotDatabaseInventoryError) throw error;
    fail(`Bot database SQL file ${filename} is unavailable`, 'bot_database_inventory_unavailable');
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

// Loads and checksum-verifies every reviewed SQL file. Packaged apps ship the
// Supabase subset and local SQL as resources; development reads the checkout.
export async function loadBotDatabaseSql({
  supabaseMigrationsDirectory,
  sqlDirectory,
  fsImpl = fs,
} = {}) {
  const bootstrapCluster = await readVerified(
    sqlDirectory,
    BOT_DB_BOOTSTRAP.cluster.filename,
    BOT_DB_BOOTSTRAP.cluster.sha256,
    fsImpl,
  );
  const bootstrapDatabase = await readVerified(
    sqlDirectory,
    BOT_DB_BOOTSTRAP.database.filename,
    BOT_DB_BOOTSTRAP.database.sha256,
    fsImpl,
  );
  const migrations = [];
  for (const migration of BOT_DB_MIGRATIONS) {
    const sql = await readVerified(
      migration.source === 'local' ? path.join(sqlDirectory, 'local') : supabaseMigrationsDirectory,
      migration.filename,
      migration.sha256,
      fsImpl,
    );
    migrations.push(Object.freeze({ ...migration, sql }));
  }
  return Object.freeze({
    bootstrapCluster,
    bootstrapDatabase,
    migrations: Object.freeze(migrations),
  });
}

const normalizeHistoryRow = (row) => {
  if (!row || typeof row !== 'object' || Array.isArray(row)
    || !Number.isSafeInteger(row.ordinal) || row.ordinal < 0
    || typeof row.name !== 'string' || typeof row.sha256 !== 'string') {
    fail('Bot database migration history is invalid', 'bot_database_schema_unknown');
  }
  return { ordinal: row.ordinal, name: row.name, sha256: row.sha256 };
};

// Compares recorded history with the reviewed inventory. Only an exact prefix
// may be migrated forward; unknown, reordered or changed history and history
// from a newer release are never modified.
export function classifyBotDatabaseHistory(rows, inventory = BOT_DB_MIGRATIONS) {
  if (!Array.isArray(rows)) fail('Bot database migration history is invalid', 'bot_database_schema_unknown');
  const history = rows.map(normalizeHistoryRow).sort((left, right) => left.ordinal - right.ordinal);
  if (history.length === 0) {
    return Object.freeze({ state: 'empty', appliedCount: 0, pending: inventory });
  }
  for (const [index, row] of history.entries()) {
    if (row.ordinal !== index) {
      return Object.freeze({ state: 'unknown', appliedCount: history.length, pending: [] });
    }
    const expected = inventory[index];
    if (!expected) {
      return Object.freeze({ state: 'newer', appliedCount: history.length, pending: [] });
    }
    if (expected.name !== row.name || expected.sha256 !== row.sha256) {
      return Object.freeze({ state: 'unknown', appliedCount: history.length, pending: [] });
    }
  }
  if (history.length === inventory.length) {
    return Object.freeze({ state: 'current', appliedCount: history.length, pending: [] });
  }
  return Object.freeze({
    state: 'behind',
    appliedCount: history.length,
    pending: inventory.slice(history.length),
  });
}

// The exact reviewed migration prefix for a hosted Bot schema marker. Local
// additions are excluded: the source database mirrors the hosted schema.
export function sourceSchemaMigrations(marker, inventory = BOT_DB_MIGRATIONS) {
  const name = typeof marker === 'string' && Object.hasOwn(REVIEWED_SOURCE_SCHEMAS, marker)
    ? REVIEWED_SOURCE_SCHEMAS[marker]
    : null;
  const index = name ? inventory.findIndex((migration) => migration.name === name) : -1;
  if (index < 0) {
    fail('The cloud Bot schema is not a reviewed import source', 'bot_import_source_schema_unsupported');
  }
  const prefix = inventory.slice(0, index + 1);
  if (prefix.some((migration) => migration.source !== 'supabase')) {
    fail('The reviewed import source schema is invalid', 'bot_database_inventory_invalid');
  }
  return prefix;
}

const quoteLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;

// One transaction per migration: the reviewed SQL and its history row commit
// or roll back together.
export function renderMigrationTransaction(migration) {
  if (!migration || typeof migration.sql !== 'string' || !Number.isSafeInteger(migration.ordinal)
    || !/^[a-z]+:[0-9A-Za-z_.-]+$/.test(migration.name) || !/^[0-9a-f]{64}$/.test(migration.sha256)
    || !['supporting', 'bot', 'local'].includes(migration.kind)) {
    fail('Bot database migration is invalid', 'bot_database_inventory_invalid');
  }
  return [
    'begin;',
    "set local lock_timeout = '30s';",
    "set local client_min_messages = warning;",
    "set local search_path = public, extensions;",
    migration.sql,
    ';',
    `insert into devryan_local.schema_migrations (ordinal, name, sha256, kind) values (${migration.ordinal}, ${quoteLiteral(migration.name)}, ${quoteLiteral(migration.sha256)}, ${quoteLiteral(migration.kind)});`,
    'commit;',
    '',
  ].join('\n');
}

export function assertBotDatabaseName(name) {
  if (typeof name !== 'string' || !BOT_DATABASE_NAME_PATTERN.test(name)) {
    fail('Bot database name is invalid', 'bot_database_name_invalid');
  }
  return name;
}
