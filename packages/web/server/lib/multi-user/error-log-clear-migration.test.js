import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
  '../../../../../supabase/migrations/20260810182541_clear_managed_error_diagnostics.sql',
  import.meta.url,
), 'utf8');

const triggerFunction = migration.slice(
  migration.indexOf('create or replace function public.devryan_preserve_locked_user_activity()'),
  migration.indexOf('create or replace function public.devryan_clear_error_logs('),
);
const clearFunction = migration.slice(
  migration.indexOf('create or replace function public.devryan_clear_error_logs('),
);

describe('managed Error Log clear migration', () => {
  it('limits the transaction-local retention bypass to diagnostic actions', () => {
    expect(triggerFunction).toContain("current_setting('devryan.error_log_clear_scope', true) = 'diagnostics'");
    expect(triggerFunction).toContain("'session.error'");
    expect(triggerFunction).toContain("'tool.failed'");
    expect(triggerFunction).toContain("'managed_task.failed'");
    expect(triggerFunction).toContain("'diagnostic.recovered'");
    expect(triggerFunction).toContain("'diagnostic.unresolved'");
    expect(triggerFunction).toContain('profile.analytics_retention_locked_at is not null');
    expect(triggerFunction).toContain('return null');
  });

  it('deletes linked evidence before its matching user-visible failures', () => {
    const linkedDelete = clearFunction.indexOf('delete from public.activity_logs resolution');
    const failureDelete = clearFunction.indexOf('delete from public.activity_logs failure');
    expect(linkedDelete).toBeGreaterThan(-1);
    expect(failureDelete).toBeGreaterThan(linkedDelete);
    expect(clearFunction).toContain("resolution.target_type = 'activity_event'");
    expect(clearFunction).toContain('failure.event_id::text = resolution.target_id');
    expect(clearFunction).toContain("'linkedResolutionCount', linked_resolution_count");
    expect(clearFunction).toContain("'clearedCount', cleared_count");
  });

  it('uses inclusive snapshot boundaries and null p_since for all-range clearing', () => {
    expect(clearFunction.match(/failure\.created_at <= p_until/g)).toHaveLength(2);
    expect(clearFunction.match(/p_since is null or failure\.created_at >= p_since/g)).toHaveLength(2);
    expect(clearFunction).toContain('p_since must be earlier than or equal to p_until');
  });

  it('keeps both deletes in one rollback-safe function transaction', () => {
    expect(clearFunction.match(/delete from public\.activity_logs/g)).toHaveLength(2);
    expect(clearFunction).not.toMatch(/\bcommit\b|\brollback\b/i);
    expect(clearFunction).not.toContain('exception when');
    expect(clearFunction).toContain("set_config('devryan.error_log_clear_scope', 'diagnostics', true)");
    expect(clearFunction).toContain("set_config('devryan.error_log_clear_scope', 'off', true)");
  });

  it('is security-invoker and executable only by the service role', () => {
    expect(clearFunction).toContain('security invoker');
    expect(clearFunction).toContain("set search_path = ''");
    expect(clearFunction).toContain('from public, anon, authenticated');
    expect(clearFunction).toContain('to service_role');
  });
});
