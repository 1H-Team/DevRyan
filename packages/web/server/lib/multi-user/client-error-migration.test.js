import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { CLIENT_ERROR_LOGS_MIGRATION } from './bug-reports.js';

const migration = readFileSync(new URL(
  `../../../../../supabase/migrations/${CLIENT_ERROR_LOGS_MIGRATION}.sql`,
  import.meta.url,
), 'utf8');

const clearFunction = migration.slice(
  migration.indexOf('create or replace function public.devryan_clear_error_logs('),
);
const triggerFunction = migration.slice(
  migration.indexOf('create or replace function public.devryan_preserve_locked_user_activity()'),
  migration.indexOf('create or replace function public.devryan_clear_error_logs('),
);

describe('client error diagnostics migration', () => {
  it('rebuilds the impact index so client rows stay on the filtered pagination path', () => {
    expect(migration).toContain('drop index if exists public.activity_logs_diagnostic_impact_created_idx');
    const index = migration.slice(migration.indexOf('create index activity_logs_diagnostic_impact_created_idx'));
    expect(index).toContain("where action in ('session.error', 'tool.failed', 'managed_task.failed', 'client.error')");
    expect(index).toContain('(diagnostic_impact, action, created_at desc, event_id desc)');
  });

  it('clears client errors alongside the server-projected failures', () => {
    // Both the linked-evidence subquery and the failure delete must see the new action,
    // otherwise "Clear all" silently leaves client rows behind.
    expect(clearFunction.match(/'session\.error', 'tool\.failed', 'managed_task\.failed', 'client\.error'/g))
      .toHaveLength(2);
    expect(clearFunction.match(/delete from public\.activity_logs/g)).toHaveLength(2);
  });

  it('extends the retention bypass to client errors without widening it further', () => {
    expect(triggerFunction).toContain("'client.error'");
    expect(triggerFunction).toContain("current_setting('devryan.error_log_clear_scope', true) = 'diagnostics'");
    expect(triggerFunction).toContain('profile.analytics_retention_locked_at is not null');
  });

  it('keeps the clear function security-invoker and service-role only', () => {
    expect(clearFunction).toContain('security invoker');
    expect(clearFunction).toContain("set search_path = ''");
    expect(clearFunction).toContain('from public, anon, authenticated');
    expect(clearFunction).toContain('to service_role');
    expect(clearFunction).not.toMatch(/\bcommit\b|\brollback\b/i);
  });
});
