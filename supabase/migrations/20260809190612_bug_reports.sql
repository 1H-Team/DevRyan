-- Managed Bug Reports are written and reviewed only through the authenticated
-- DevRyan server. Browser Supabase roles receive no table privileges or RLS
-- policies; service_role is the sole Data API role with access.

create table public.bug_reports (
  id uuid primary key,
  reporter_user_id uuid references public.user_profiles(id) on delete set null,
  reporter_display_name text not null
    check (char_length(btrim(reporter_display_name)) between 1 and 300),
  reporter_email text not null
    check (char_length(btrim(reporter_email)) between 3 and 320),
  reporter_role text not null
    check (reporter_role in ('admin', 'senior_developer', 'developer')),
  title text not null
    check (char_length(btrim(title)) between 1 and 200),
  description text not null
    check (char_length(btrim(description)) between 1 and 20000),
  status text not null default 'submitted'
    check (status in ('submitted', 'in_progress', 'resolved')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index bug_reports_reporter_created_idx
  on public.bug_reports (reporter_user_id, created_at desc, id desc);

create index bug_reports_created_idx
  on public.bug_reports (created_at desc, id desc);

create index bug_reports_status_created_idx
  on public.bug_reports (status, created_at desc, id desc);

create index activity_logs_error_kind_created_idx
  on public.activity_logs (action, created_at desc, event_id desc)
  where action in ('session.error', 'tool.failed', 'managed_task.failed');

create trigger bug_reports_updated_at
before update on public.bug_reports
for each row execute function public.devryan_set_updated_at();

alter table public.bug_reports enable row level security;
alter table public.bug_reports force row level security;

revoke all on table public.bug_reports from public, anon, authenticated, service_role;
grant select, insert on table public.bug_reports to service_role;
grant update (status) on table public.bug_reports to service_role;

-- The new page is enabled for every managed role by default. Existing sparse
-- user overrides intentionally remain untouched so a missing cell inherits
-- this role value.
update public.role_policies
set
  settings_pages = case
    when '*' = any(settings_pages) or 'bug-reports' = any(settings_pages) then settings_pages
    else array_append(settings_pages, 'bug-reports')
  end,
  settings_permissions = jsonb_set(
    coalesce(settings_permissions, '{}'::jsonb),
    '{bug-reports}',
    '{"read":true,"edit":true}'::jsonb,
    true
  )
where role in ('admin', 'senior_developer', 'developer');

comment on table public.bug_reports is
  'Service-only DevRyan bug reports with immutable reporter snapshots and administrator-managed status.';
comment on column public.bug_reports.id is
  'Client-generated UUID used as the idempotency key for submission retries.';
