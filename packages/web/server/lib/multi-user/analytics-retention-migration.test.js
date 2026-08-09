import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
  '../../../../../supabase/migrations/20260807100000_indefinite_user_analytics_retention.sql',
  import.meta.url,
), 'utf8');

describe('indefinite user analytics retention migration', () => {
  it('adds a monotonic lock for managed non-admin users', () => {
    expect(migration).toContain('analytics_retention_locked_at timestamptz');
    expect(migration).toContain('devryan_lock_user_analytics_retention');
    expect(migration).toContain('coalesce(profile.analytics_retention_locked_at, now())');
    expect(migration).toContain("profile.role in ('developer', 'senior_developer')");
  });

  it('protects existing and late-delivered actor or target rows from every delete', () => {
    expect(migration).toContain('before delete on public.activity_logs');
    expect(migration).toContain('activity_logs_preserve_locked_user_analytics');
    expect(migration).toContain('profile.id in (old.actor_user_id, old.target_user_id)');
    expect(migration).toContain('return null');
  });

  it('purges ordinary rows while reporting protected rows and retaining the purge event', () => {
    expect(migration).toContain('devryan_purge_unprotected_activity_logs');
    expect(migration).toContain('activity.event_id is distinct from p_preserve_event_id');
    expect(migration).toContain('profile.id in (activity.actor_user_id, activity.target_user_id)');
    expect(migration).toContain("'deletedCount', deleted_count");
    expect(migration).toContain("'protectedCount', protected_count");
  });

  it('keeps both RPCs service-role-only and idempotently deployable', () => {
    expect(migration.match(/create or replace function public\.devryan_/g)).toHaveLength(3);
    expect(migration.match(/from public, anon, authenticated/g)).toHaveLength(3);
    expect(migration.match(/to service_role/g)).toHaveLength(2);
    expect(migration).toContain('add column if not exists');
    expect(migration).toContain('drop trigger if exists');
  });
});
