import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
  '../../../../../supabase/migrations/20260823150227_bot_capability_bindings.sql',
  import.meta.url,
), 'utf8');

describe('Production Bot capability binding migration', () => {
  it('creates immutable service-only Skill and MCP snapshot tables', () => {
    for (const table of ['bot_skill_packages', 'bot_mcp_bindings']) {
      expect(migration).toContain(`create table public.${table}`);
      expect(migration).toContain(`alter table public.${table} enable row level security`);
      expect(migration).toContain(`alter table public.${table} force row level security`);
      expect(migration).toContain(`revoke all on table public.${table} from public, anon, authenticated`);
      expect(migration).toContain(`grant all on table public.${table} to service_role`);
      expect(migration).toContain(`create trigger ${table}_immutable`);
    }
    expect(migration).not.toMatch(/grant\s+(?:select|insert|update|delete|all)[^;]+to\s+(?:anon|authenticated)/i);
  });

  it('indexes foreign keys and pins content, descriptors, manifests, and credential identities', () => {
    expect(migration).toContain('bot_skill_packages_bot_id_idx');
    expect(migration).toContain('bot_skill_packages_object_id_idx');
    expect(migration).toContain('bot_skill_packages_created_by_idx');
    expect(migration).toContain('bot_mcp_bindings_bot_id_idx');
    expect(migration).toContain('bot_mcp_bindings_created_by_idx');
    expect(migration).toContain('package_digest text not null');
    expect(migration).toContain('descriptor_digest text not null');
    expect(migration).toContain('manifest_digest text not null');
    expect(migration).toContain('bot_mcp_bindings_credential_provider_key');
    expect(migration).not.toContain('bot_skill_packages_bot_name_digest_key');
    expect(migration).not.toContain('bot_mcp_bindings_bot_descriptor_manifest_key');
  });

  it('adds capability snapshots to the retired-Bot purge contract', () => {
    expect(migration).toContain("'capability_bindings'");
    expect(migration).toContain('delete from public.bot_skill_packages where bot_id = p_bot_id');
    expect(migration).toContain('delete from public.bot_mcp_bindings where bot_id = p_bot_id');
    expect(migration).toContain("target_bot.lifecycle <> 'retired'");
    expect(migration).toContain('grant execute on function public.devryan_purge_bot_resource(uuid, text, uuid) to service_role');
  });

  it('keeps audit rows immutable while allowing Draft and Retired Bot cleanup', () => {
    expect(migration).toContain("current_setting('devryan.bot_audit_reference_cleanup', true) = 'on'");
    expect(migration).toContain("(pg_catalog.to_jsonb(new) - 'bot_id')");
    expect(migration).toContain("target_bot.lifecycle not in ('draft', 'retired')");
    expect(migration).toContain("set_config('devryan.bot_audit_reference_cleanup', 'on', true)");
    expect(migration).toContain('grant execute on function public.devryan_purge_bot(uuid, uuid) to service_role');
  });
});
