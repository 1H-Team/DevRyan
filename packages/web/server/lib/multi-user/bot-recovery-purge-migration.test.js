import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
  '../../../../../supabase/migrations/20260823100000_bot_recovery_purge.sql',
  import.meta.url,
), 'utf8');

describe('Production Bot recovery purge migration', () => {
  it('keeps fixed purge RPCs service-only and lifecycle-gated', () => {
    expect(migration).toContain('public.devryan_purge_bot_resource(');
    expect(migration).toContain('public.devryan_purge_bot(');
    expect(migration).toContain("target_bot.lifecycle <> 'retired'");
    expect(migration).toContain("membership.role = 'manager'");
    expect(migration).toContain("profile.role = 'admin'");
    expect(migration).toContain("tg_op = 'DELETE' and not exists");
    expect(migration).toContain('grant execute on function public.devryan_purge_bot_resource(uuid, text, uuid) to service_role');
    expect(migration).toContain('grant execute on function public.devryan_purge_bot(uuid, uuid) to service_role');
    expect(migration).not.toMatch(/grant execute[^;]+to (?:anon|authenticated)/i);
  });

  it('tombstones shared provenance before channel deletion and retains the audit relation', () => {
    const sharedTombstone = migration.indexOf('source_tombstoned_at = coalesce');
    const channelDelete = migration.indexOf('delete from public.bot_channels');
    expect(sharedTombstone).toBeGreaterThan(-1);
    expect(channelDelete).toBeGreaterThan(sharedTombstone);
    expect(migration).not.toMatch(/delete from public\.bot_audit_events/i);
  });
});
