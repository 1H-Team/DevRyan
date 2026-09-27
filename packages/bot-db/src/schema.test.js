import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, cpSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BOT_DB_MIGRATIONS } from './inventory.js';
import {
  assertBotDatabaseName,
  classifyBotDatabaseHistory,
  loadBotDatabaseSql,
  renderMigrationTransaction,
  sourceSchemaMigrations,
} from './schema.js';

const packageRoot = path.resolve(import.meta.dir, '..');
const repositoryRoot = path.resolve(packageRoot, '../..');
const supabaseDirectory = path.join(repositoryRoot, 'supabase/migrations');
const sqlDirectory = path.join(packageRoot, 'sql');
const history = (count) => BOT_DB_MIGRATIONS.slice(0, count)
  .map(({ ordinal, name, sha256 }) => ({ ordinal, name, sha256 }));

const temporary = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const copyTree = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bot-db-sql-'));
  temporary.push(root);
  cpSync(sqlDirectory, path.join(root, 'sql'), { recursive: true });
  cpSync(supabaseDirectory, path.join(root, 'migrations'), { recursive: true });
  return { sqlDirectory: path.join(root, 'sql'), supabaseMigrationsDirectory: path.join(root, 'migrations') };
};

describe('schema history classification', () => {
  test('distinguishes empty, current and behind prefixes', () => {
    expect(classifyBotDatabaseHistory([]).state).toBe('empty');
    expect(classifyBotDatabaseHistory(history(BOT_DB_MIGRATIONS.length)).state).toBe('current');
    const behind = classifyBotDatabaseHistory(history(5));
    expect(behind.state).toBe('behind');
    expect(behind.pending.map((entry) => entry.name)).toEqual(BOT_DB_MIGRATIONS.slice(5).map((entry) => entry.name));
  });

  test('refuses history from a newer release without planning changes', () => {
    const newer = [...history(BOT_DB_MIGRATIONS.length), {
      ordinal: BOT_DB_MIGRATIONS.length,
      name: 'local:9999_future',
      sha256: 'f'.repeat(64),
    }];
    expect(classifyBotDatabaseHistory(newer)).toEqual(expect.objectContaining({ state: 'newer', pending: [] }));
  });

  test('treats changed checksums, gaps and reordering as unknown history', () => {
    const drift = history(3);
    drift[1] = { ...drift[1], sha256: '0'.repeat(64) };
    expect(classifyBotDatabaseHistory(drift).state).toBe('unknown');
    expect(classifyBotDatabaseHistory([history(3)[0], history(3)[2]]).state).toBe('unknown');
    const renamed = history(2);
    renamed[1] = { ...renamed[1], name: 'supabase:20990101000000_other' };
    expect(classifyBotDatabaseHistory(renamed).state).toBe('unknown');
    expect(() => classifyBotDatabaseHistory([{ ordinal: '0' }])).toThrow(expect.objectContaining({
      code: 'bot_database_schema_unknown',
    }));
  });
});

describe('verified SQL loading', () => {
  test('loads the reviewed inventory in order', async () => {
    const loaded = await loadBotDatabaseSql({ supabaseMigrationsDirectory: supabaseDirectory, sqlDirectory });
    expect(loaded.migrations.map((entry) => entry.name)).toEqual(BOT_DB_MIGRATIONS.map((entry) => entry.name));
    expect(loaded.bootstrapCluster).toContain('create role authenticator login noinherit');
    expect(loaded.bootstrapDatabase).toContain('create schema devryan_local');
  });

  test('rejects checksum drift in any file', async () => {
    const tree = copyTree();
    const target = path.join(tree.supabaseMigrationsDirectory, '20260822120000_production_bots.sql');
    writeFileSync(target, `${readFileSync(target, 'utf8')}\n-- drift\n`);
    await expect(loadBotDatabaseSql(tree)).rejects.toMatchObject({ code: 'bot_database_inventory_drift' });
  });

  test('rejects symlinked and missing SQL files', async () => {
    const tree = copyTree();
    const local = path.join(tree.sqlDirectory, 'local', '0001_local_identity.sql');
    const moved = `${local}.real`;
    cpSync(local, moved);
    rmSync(local);
    symlinkSync(moved, local);
    await expect(loadBotDatabaseSql(tree)).rejects.toMatchObject({ code: 'bot_database_inventory_unavailable' });
    rmSync(local);
    await expect(loadBotDatabaseSql(tree)).rejects.toMatchObject({ code: 'bot_database_inventory_unavailable' });
    await expect(loadBotDatabaseSql({ ...tree, sqlDirectory: 'relative' })).rejects.toMatchObject({
      code: 'bot_database_inventory_invalid',
    });
  });
});

describe('migration rendering', () => {
  test('commits the migration and its history row in one transaction', () => {
    const rendered = renderMigrationTransaction({ ...BOT_DB_MIGRATIONS[0], sql: 'select 1' });
    expect(rendered.startsWith('begin;\n')).toBe(true);
    expect(rendered.trimEnd().endsWith('commit;')).toBe(true);
    expect(rendered).toContain(`values (0, '${BOT_DB_MIGRATIONS[0].name}', '${BOT_DB_MIGRATIONS[0].sha256}', 'supporting')`);
  });

  test('rejects malformed migrations before rendering', () => {
    expect(() => renderMigrationTransaction({ ...BOT_DB_MIGRATIONS[0], sql: 'x', name: "x'; drop" }))
      .toThrow(expect.objectContaining({ code: 'bot_database_inventory_invalid' }));
    expect(() => renderMigrationTransaction({ ...BOT_DB_MIGRATIONS[0], sql: 'x', kind: 'excluded' }))
      .toThrow(expect.objectContaining({ code: 'bot_database_inventory_invalid' }));
  });
});

describe('import source schemas and database names', () => {
  test('returns the exact hosted prefix for a reviewed marker only', () => {
    const prefix = sourceSchemaMigrations('20260908182901');
    expect(prefix.at(-1).name).toBe('supabase:20260908182901_bot_memory_automatic_recovery');
    expect(prefix.every((entry) => entry.source === 'supabase')).toBe(true);
    expect(() => sourceSchemaMigrations('20260903110000')).toThrow(expect.objectContaining({
      code: 'bot_import_source_schema_unsupported',
    }));
    expect(() => sourceSchemaMigrations(undefined)).toThrow(expect.objectContaining({
      code: 'bot_import_source_schema_unsupported',
    }));
  });

  test('accepts only the live, candidate, source and retired database names', () => {
    expect(assertBotDatabaseName('devryan_bots')).toBe('devryan_bots');
    expect(assertBotDatabaseName('devryan_bots_candidate_0123456789abcdef')).toBe('devryan_bots_candidate_0123456789abcdef');
    for (const name of ['postgres', 'devryan_bots;drop', 'devryan_bots_candidate_x', 'DEVRYAN_BOTS']) {
      expect(() => assertBotDatabaseName(name)).toThrow(expect.objectContaining({ code: 'bot_database_name_invalid' }));
    }
  });
});
