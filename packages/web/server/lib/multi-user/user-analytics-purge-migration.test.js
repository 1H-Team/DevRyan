import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
  '../../../../../supabase/migrations/20260830123704_admin_clear_all_user_analytics.sql',
  import.meta.url,
), 'utf8');

const triggerFunction = migration.slice(
  migration.indexOf('create or replace function public.devryan_preserve_locked_user_activity()'),
  migration.indexOf('create or replace function public.devryan_purge_user_activity_logs('),
);
const purgeFunction = migration.slice(
  migration.indexOf('create or replace function public.devryan_purge_user_activity_logs('),
);

describe('administrator clear-all user analytics migration', () => {
  it('limits the retention bypass to the transaction-local exact target', () => {
    expect(triggerFunction).toContain("'devryan.user_analytics_clear_target'");
    expect(triggerFunction).toContain('old.actor_user_id::text');
    expect(triggerFunction).toContain('old.target_user_id::text');
    expect(triggerFunction).toContain('profile.analytics_retention_locked_at is not null');
    expect(triggerFunction).toContain("current_setting('devryan.error_log_clear_scope', true) = 'diagnostics'");
  });

  it('deletes the exact target snapshot and fails unless zero rows remain', () => {
    expect(purgeFunction).toContain("set_config(\n    'devryan.user_analytics_clear_target'");
    expect(migration).toContain('p_user_id in (activity.actor_user_id, activity.target_user_id)');
    expect(migration).toContain('activity.event_id is distinct from p_preserve_event_id');
    expect(migration).toContain("'deletedCount', deleted_count");
    expect(migration).toContain("'remainingCount', remaining_count");
    expect(migration).toContain("'complete', true");
    expect(migration).toContain('if remaining_count <> 0 then');
    expect(migration).toContain('User analytics purge did not clear the complete target snapshot');
    expect(migration).toContain("set_config('devryan.user_analytics_clear_target', 'off', true)");
  });

  it('is a short security-invoker operation executable only by the service role', () => {
    expect(purgeFunction).toContain('security invoker');
    expect(purgeFunction).toContain("set search_path = ''");
    expect(purgeFunction).toContain('from public, anon, authenticated');
    expect(purgeFunction).toContain('to service_role');
    expect(purgeFunction).not.toMatch(/\bcommit\b|\brollback\b/i);
  });
});
