import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../../../../../supabase/migrations/20260809190612_bug_reports.sql', import.meta.url),
  'utf8',
).toLowerCase();

describe('bug reports database migration', () => {
  it('creates the constrained report table, cursor indexes, and shared updated-at trigger', () => {
    expect(migration).toContain('create table public.bug_reports');
    expect(migration).toMatch(/id uuid primary key(?!\s+default)/);
    expect(migration).toContain("status text not null default 'submitted'");
    expect(migration).toContain("status in ('submitted', 'in_progress', 'resolved')");
    expect(migration).toContain('char_length(btrim(title)) between 1 and 200');
    expect(migration).toContain('char_length(btrim(description)) between 1 and 20000');
    expect(migration).toContain('bug_reports_reporter_created_idx');
    expect(migration).toContain('bug_reports_created_idx');
    expect(migration).toContain('bug_reports_status_created_idx');
    expect(migration).toContain('activity_logs_error_kind_created_idx');
    expect(migration).toContain('execute function public.devryan_set_updated_at()');
  });

  it('keeps the table service-only with forced RLS and no browser policies', () => {
    expect(migration).toContain('enable row level security');
    expect(migration).toContain('force row level security');
    expect(migration).toContain(
      'revoke all on table public.bug_reports from public, anon, authenticated, service_role',
    );
    expect(migration).toContain('grant select, insert on table public.bug_reports to service_role');
    expect(migration).toContain('grant update (status) on table public.bug_reports to service_role');
    expect(migration).not.toContain('grant update on table public.bug_reports to service_role');
    expect(migration).not.toContain('create policy');
    expect(migration).not.toMatch(/grant\s+\w[\s,\w]*\s+on table public\.bug_reports to (?:anon|authenticated|public)/);
  });

  it('updates role defaults while leaving sparse user overrides inheritable', () => {
    expect(migration).toContain('update public.role_policies');
    expect(migration).toContain("'{bug-reports}'");
    expect(migration).toContain("where role in ('admin', 'senior_developer', 'developer')");
    expect(migration).not.toContain('update public.user_policies');
  });
});
