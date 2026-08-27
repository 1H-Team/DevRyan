import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
  '../../../../../supabase/migrations/20260823202400_bot_profiles_and_publish.sql',
  import.meta.url,
), 'utf8');
const baseMigration = readFileSync(new URL(
  '../../../../../supabase/migrations/20260822120000_production_bots.sql',
  import.meta.url,
), 'utf8');

describe('Production Bot profile and publish migration', () => {
  it('backfills durable presentation from active, latest, and Bot-name fallbacks', () => {
    expect(migration).toContain('add column title text');
    expect(migration).toContain("revision.id = bot.active_revision_id");
    expect(migration).toContain('order by revision.revision_number desc');
    expect(migration).toContain('bot.name');
    expect(migration).toContain('add column avatar_fallback text');
    expect(migration).toContain('avatar_fallback is null');
    expect(migration).not.toMatch(/update public\.bot_revisions\s+set contract/i);
  });

  it('keeps profile avatars encrypted, same-Bot scoped, private, and MIME bounded', () => {
    expect(migration).toContain("visibility in ('private', 'library', 'profile')");
    expect(migration).toContain("content_type in ('image/png', 'image/jpeg', 'image/webp')");
    expect(migration).toContain('ciphertext_size <= 5242880');
    expect(migration).toContain('object_row.bot_id = new.id');
    expect(migration).toContain("object_row.visibility = 'profile'");
    expect(migration).toContain('bot_objects_protect_referenced_avatar');
    expect(migration).not.toMatch(/grant\s+(?:select|insert|update|delete|all)[^;]+to\s+(?:anon|authenticated)/i);
    expect(baseMigration).toContain("'bots',");
    expect(baseMigration).toContain("'bot_objects',");
    expect(baseMigration).toContain("execute format('alter table public.%I force row level security', relation_name)");
  });

  it('publishes only the locked Draft version and leaves profile fields authoritative', () => {
    expect(migration).toContain('public.devryan_publish_bot_revision');
    expect(migration).toContain('for update');
    expect(migration).toContain('target_revision.updated_at is distinct from p_expected_updated_at');
    expect(migration).toContain('target_revision.compiled_hash is distinct from p_compiled_hash');
    expect(migration).toContain("target_revision.contract->>'tenancy' is distinct from target_bot.tenancy");
    expect(migration).not.toMatch(/set\s+name\s*=\s*target_revision\.contract/i);
    expect(migration).toContain('grant execute on function public.devryan_publish_bot_revision(uuid, uuid, timestamptz, text, uuid)');
    expect(migration).not.toMatch(/grant execute[^;]+devryan_publish_bot_revision[^;]+to (?:anon|authenticated)/i);
  });

  it('exposes a service-role-only compatibility marker for fail-closed startup', () => {
    expect(migration).toContain('public.devryan_bot_schema_version()');
    expect(migration).toContain("select '20260823202400'::text");
    expect(migration).toContain('grant execute on function public.devryan_bot_schema_version()');
    expect(migration).not.toMatch(/grant execute[^;]+devryan_bot_schema_version[^;]+to (?:anon|authenticated)/i);
  });
});
