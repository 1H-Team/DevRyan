import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import {
  BOT_DB_BOOTSTRAP,
  BOT_DB_MIGRATIONS,
  BOT_DB_SCHEMA_HEAD,
  LOCAL_MIGRATION_INVENTORY,
  REVIEWED_SOURCE_SCHEMAS,
  SUPABASE_MIGRATION_INVENTORY,
} from './inventory.js';

const packageRoot = path.resolve(import.meta.dir, '..');
const repositoryRoot = path.resolve(packageRoot, '../..');
const supabaseDirectory = path.join(repositoryRoot, 'supabase/migrations');
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

// Released order of the local Bot database history. Entries may only be
// appended; a changed prefix would strand every installed database.
const RELEASED_HISTORY = [
  'supabase:20260802195944_devryan_multi_user',
  'supabase:20260803112512_classify_agent_test_users',
  'supabase:20260822120000_production_bots',
  'supabase:20260823100000_bot_recovery_purge',
  'supabase:20260823150227_bot_capability_bindings',
  'supabase:20260823202400_bot_profiles_and_publish',
  'supabase:20260824030000_bot_message_admission_timestamps',
  'supabase:20260824033000_bot_admission_schema_marker',
  'supabase:20260824040000_bot_revision_history',
  'supabase:20260824120000_bots_shared_memory_team_tenancy',
  'supabase:20260824213000_bot_complete_delete',
  'supabase:20260825120000_bot_shared_files',
  'supabase:20260825190000_bot_approval_expiry',
  'supabase:20260826120000_bot_chat_latency',
  'supabase:20260826130000_bot_two_phase_responses',
  'supabase:20260826140000_bot_environment_secrets',
  'supabase:20260827100000_agent_agnostic_bots_program',
  'supabase:20260828210316_bot_terminal_error_audit',
  'supabase:20260829120000_bot_acknowledgment_admission',
  'supabase:20260829130000_bot_contextual_acknowledgments',
  'supabase:20260830150000_bot_waiting_control',
  'supabase:20260830180651_bot_audit_clear',
  'supabase:20260830210000_bot_safe_run_retry',
  'supabase:20260831002620_bot_telegram_transport',
  'supabase:20260901120000_durable_bot_memory_extraction',
  'supabase:20260901130000_bot_memory_extraction_conflict_recovery',
  'supabase:20260901160000_bot_runtime_scope_and_audit_repair',
  'supabase:20260901230000_bot_memory_extraction_requeue',
  'supabase:20260902120000_bot_audit_resolution_and_read_only_retry',
  'supabase:20260903100000_bot_run_failure_stage_audit',
  'supabase:20260903110000_bot_memory_extraction_inline_claim',
  'supabase:20260908182901_bot_memory_automatic_recovery',
  'local:0001_local_identity',
];

describe('local Bot database inventory', () => {
  test('classifies every hosted migration exactly once, in file order', () => {
    const files = readdirSync(supabaseDirectory).filter((name) => name.endsWith('.sql')).sort();
    expect(SUPABASE_MIGRATION_INVENTORY.map((entry) => entry.filename)).toEqual(files);
  });

  test('records the byte-exact checksum of every hosted migration', () => {
    for (const entry of SUPABASE_MIGRATION_INVENTORY) {
      expect({ file: entry.filename, sha256: sha256(path.join(supabaseDirectory, entry.filename)) })
        .toEqual({ file: entry.filename, sha256: entry.sha256 });
    }
  });

  test('supports only the reviewed profile migrations and keeps shared-host rules out', () => {
    expect(SUPABASE_MIGRATION_INVENTORY.filter((entry) => entry.kind === 'supporting').map((entry) => entry.filename))
      .toEqual(['20260802195944_devryan_multi_user.sql', '20260803112512_classify_agent_test_users.sql']);
    for (const entry of SUPABASE_MIGRATION_INVENTORY.filter((candidate) => candidate.kind === 'excluded')) {
      const sql = readFileSync(path.join(supabaseDirectory, entry.filename), 'utf8');
      expect({ file: entry.filename, touchesBots: /public\.bots?\b|public\.bot_|devryan_bot_/.test(sql) })
        .toEqual({ file: entry.filename, touchesBots: false });
    }
  });

  test('records bootstrap and local additions by checksum', () => {
    expect(sha256(path.join(packageRoot, 'sql', BOT_DB_BOOTSTRAP.cluster.filename)))
      .toBe(BOT_DB_BOOTSTRAP.cluster.sha256);
    expect(sha256(path.join(packageRoot, 'sql', BOT_DB_BOOTSTRAP.database.filename)))
      .toBe(BOT_DB_BOOTSTRAP.database.sha256);
    const localFiles = readdirSync(path.join(packageRoot, 'sql/local')).filter((name) => name.endsWith('.sql')).sort();
    expect(LOCAL_MIGRATION_INVENTORY.map((entry) => entry.filename)).toEqual(localFiles);
    for (const entry of LOCAL_MIGRATION_INVENTORY) {
      expect(sha256(path.join(packageRoot, 'sql/local', entry.filename))).toBe(entry.sha256);
    }
  });

  test('applies an append-only ordered history', () => {
    const names = BOT_DB_MIGRATIONS.map((entry) => entry.name);
    expect(names.slice(0, RELEASED_HISTORY.length)).toEqual(RELEASED_HISTORY);
    expect(new Set(names).size).toBe(names.length);
    expect(BOT_DB_MIGRATIONS.map((entry) => entry.ordinal)).toEqual(names.map((_, index) => index));
    expect(BOT_DB_MIGRATIONS.some((entry) => entry.kind === 'excluded')).toBe(false);
    expect(BOT_DB_SCHEMA_HEAD).toBe(names.at(-1));
  });

  test('maps each reviewed import marker to the migration that sets it', () => {
    for (const [marker, name] of Object.entries(REVIEWED_SOURCE_SCHEMAS)) {
      const entry = BOT_DB_MIGRATIONS.find((migration) => migration.name === name);
      expect(entry?.source).toBe('supabase');
      const sql = readFileSync(path.join(supabaseDirectory, entry.filename), 'utf8');
      const body = sql.slice(sql.lastIndexOf('create or replace function public.devryan_bot_schema_version()'));
      expect(body).toContain(`'${marker}'::text`);
    }
  });

  test('local additions depend only on relations created earlier in the history', () => {
    const sql = readFileSync(path.join(packageRoot, 'sql/local/0001_local_identity.sql'), 'utf8');
    expect(sql).toContain('references public.bots(id)');
    const localIndex = BOT_DB_MIGRATIONS.findIndex((entry) => entry.name === 'local:0001_local_identity');
    const botsIndex = BOT_DB_MIGRATIONS.findIndex((entry) => entry.name === 'supabase:20260822120000_production_bots');
    expect(localIndex).toBeGreaterThan(botsIndex);
    expect(sql).not.toMatch(/\bgrant\s+(?:all|insert|update|delete)[^;]*bot_local_owner_mappings[^;]*service_role/i);
  });
});
