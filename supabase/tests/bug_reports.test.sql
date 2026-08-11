begin;

set local role postgres;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(27);

select has_table('public', 'bug_reports', 'bug_reports exists');
select col_is_pk('public', 'bug_reports', 'id', 'id is the primary key');
select is(
  (select column_default::text from information_schema.columns
   where table_schema = 'public' and table_name = 'bug_reports' and column_name = 'id'),
  null::text,
  'client-generated id has no database default'
);

select throws_ok(
  $$insert into public.bug_reports
    (id, reporter_display_name, reporter_email, reporter_role, title, description)
    values ('10000000-0000-4000-8000-000000000001', 'Reporter', 'reporter@example.test', 'developer', ' ', 'Details')$$,
  '23514', null, 'blank titles are rejected'
);
select throws_ok(
  $$insert into public.bug_reports
    (id, reporter_display_name, reporter_email, reporter_role, title, description)
    values ('10000000-0000-4000-8000-000000000002', 'Reporter', 'reporter@example.test', 'developer', 'Title', repeat('x', 20001))$$,
  '23514', null, 'descriptions over 20000 characters are rejected'
);
select throws_ok(
  $$insert into public.bug_reports
    (id, reporter_display_name, reporter_email, reporter_role, title, description, status)
    values ('10000000-0000-4000-8000-000000000003', 'Reporter', 'reporter@example.test', 'developer', 'Title', 'Details', 'closed')$$,
  '23514', null, 'unknown statuses are rejected'
);
select throws_ok(
  $$insert into public.bug_reports
    (id, reporter_display_name, reporter_email, reporter_role, title, description)
    values ('10000000-0000-4000-8000-000000000004', 'Reporter', 'reporter@example.test', 'owner', 'Title', 'Details')$$,
  '23514', null, 'unknown reporter roles are rejected'
);

select has_index('public', 'bug_reports', 'bug_reports_reporter_created_idx', 'reporter cursor index exists');
select has_index('public', 'bug_reports', 'bug_reports_created_idx', 'newest-first cursor index exists');
select has_index('public', 'bug_reports', 'bug_reports_status_created_idx', 'status cursor index exists');
select has_index('public', 'activity_logs', 'activity_logs_error_kind_created_idx', 'error-log cursor index exists');
select has_trigger('public', 'bug_reports', 'bug_reports_updated_at', 'shared updated-at trigger is attached');

select ok(
  (select relrowsecurity from pg_class where oid = 'public.bug_reports'::regclass),
  'row level security is enabled'
);
select ok(
  (select relforcerowsecurity from pg_class where oid = 'public.bug_reports'::regclass),
  'row level security is forced'
);
select is(
  (select count(*)::integer from pg_policies where schemaname = 'public' and tablename = 'bug_reports'),
  0,
  'no browser RLS policies exist'
);
select ok(not has_table_privilege('anon', 'public.bug_reports', 'select'), 'anon cannot select reports');
select ok(not has_table_privilege('authenticated', 'public.bug_reports', 'insert'), 'authenticated cannot insert reports');
select ok(
  has_table_privilege('service_role', 'public.bug_reports', 'select,insert'),
  'service_role can select and insert reports'
);
select ok(
  has_column_privilege('service_role', 'public.bug_reports', 'status', 'update'),
  'service_role can update report status'
);
select ok(
  not has_column_privilege('service_role', 'public.bug_reports', 'reporter_email', 'update'),
  'service_role cannot mutate reporter snapshots'
);
select ok(not has_table_privilege('service_role', 'public.bug_reports', 'delete'), 'service_role cannot delete reports');

set local role service_role;
select lives_ok(
  $$insert into public.bug_reports
    (id, reporter_display_name, reporter_email, reporter_role, title, description, updated_at)
    values ('20000000-0000-4000-8000-000000000001', 'Reporter', 'reporter@example.test', 'developer', 'Title', 'Details', '2000-01-01T00:00:00Z')$$,
  'service_role can insert through forced RLS'
);
select lives_ok(
  $$update public.bug_reports set status = 'in_progress'
    where id = '20000000-0000-4000-8000-000000000001'$$,
  'service_role can update through forced RLS'
);
reset role;
set local role postgres;

select is(
  (select status from public.bug_reports where id = '20000000-0000-4000-8000-000000000001'),
  'in_progress',
  'status transitions persist'
);
select ok(
  (select updated_at > '2000-01-01T00:00:00Z'::timestamptz
   from public.bug_reports where id = '20000000-0000-4000-8000-000000000001'),
  'the shared trigger advances updated_at'
);
select is(
  (select count(*)::integer from public.role_policies
   where role in ('admin', 'senior_developer', 'developer')
     and settings_permissions->'bug-reports' = '{"read": true, "edit": true}'::jsonb),
  3,
  'all role matrices default Bug Reports to Read/Edit'
);
select is(
  (select count(*)::integer from public.role_policies
   where role in ('admin', 'senior_developer', 'developer')
     and ('bug-reports' = any(settings_pages) or '*' = any(settings_pages))),
  3,
  'all legacy role projections include Bug Reports'
);

select * from finish();
rollback;
