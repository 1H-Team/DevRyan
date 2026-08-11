begin;

set local role postgres;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(19);

select ok(
  to_regprocedure('public.devryan_clear_error_logs(timestamp with time zone,timestamp with time zone)') is not null,
  'Error Log clear RPC exists'
);
select ok(
  not (select prosecdef from pg_proc
       where oid = 'public.devryan_clear_error_logs(timestamp with time zone,timestamp with time zone)'::regprocedure),
  'Error Log clear RPC is security invoker'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.devryan_clear_error_logs(timestamp with time zone,timestamp with time zone)',
    'execute'
  ),
  'anon cannot execute the Error Log clear RPC'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.devryan_clear_error_logs(timestamp with time zone,timestamp with time zone)',
    'execute'
  ),
  'authenticated cannot execute the Error Log clear RPC'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.devryan_clear_error_logs(timestamp with time zone,timestamp with time zone)',
    'execute'
  ),
  'service_role can execute the Error Log clear RPC'
);

set local session_replication_role = replica;
insert into public.user_profiles (
  id,
  email,
  display_name,
  role,
  analytics_retention_locked_at
) values (
  'd0000000-0000-4000-8000-000000000001',
  'locked-developer@example.test',
  'Locked Developer',
  'developer',
  '2026-08-01T00:00:00Z'
);
set local session_replication_role = origin;

insert into public.activity_logs (event_id, actor_user_id, actor_role, action, target_type, target_id, created_at)
values
  ('a0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'developer', 'session.error', null, null, '2026-08-01T00:00:00Z'),
  ('a0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', 'developer', 'tool.failed', null, null, '2026-08-02T00:00:00Z'),
  ('a0000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000001', 'developer', 'managed_task.failed', null, null, '2026-08-03T00:00:00Z'),
  ('a0000000-0000-4000-8000-000000000004', 'd0000000-0000-4000-8000-000000000001', 'developer', 'session.error', null, null, '2026-08-04T00:00:00Z'),
  ('a0000000-0000-4000-8000-000000000005', 'd0000000-0000-4000-8000-000000000001', 'developer', 'file.opened', null, null, '2026-08-02T12:00:00Z'),
  ('a0000000-0000-4000-8000-000000000006', 'd0000000-0000-4000-8000-000000000001', 'developer', 'diagnostic.recovered', 'activity_event', 'a0000000-0000-4000-8000-000000000002', '2026-08-02T01:00:00Z'),
  ('a0000000-0000-4000-8000-000000000007', 'd0000000-0000-4000-8000-000000000001', 'developer', 'diagnostic.unresolved', 'activity_event', 'a0000000-0000-4000-8000-000000000003', '2026-08-03T01:00:00Z'),
  ('a0000000-0000-4000-8000-000000000008', 'd0000000-0000-4000-8000-000000000001', 'developer', 'diagnostic.recovered', 'activity_event', 'a0000000-0000-4000-8000-000000000099', '2026-08-02T02:00:00Z');

set local role service_role;
select is(
  public.devryan_clear_error_logs('2026-08-02T00:00:00Z', '2026-08-03T00:00:00Z'),
  '{"clearedCount": 2, "linkedResolutionCount": 2}'::jsonb,
  'recent clearing counts visible failures and linked evidence'
);
reset role;
set local role postgres;

select is(
  (select count(*)::integer from public.activity_logs
   where event_id in (
     'a0000000-0000-4000-8000-000000000002',
     'a0000000-0000-4000-8000-000000000003'
   )),
  0,
  'inclusive since and until boundary failures are removed'
);
select is(
  (select count(*)::integer from public.activity_logs
   where event_id in (
     'a0000000-0000-4000-8000-000000000006',
     'a0000000-0000-4000-8000-000000000007'
   )),
  0,
  'linked recovered and unresolved evidence is removed'
);
select ok(
  exists (select 1 from public.activity_logs where event_id = 'a0000000-0000-4000-8000-000000000001'),
  'failure before p_since survives'
);
select ok(
  exists (select 1 from public.activity_logs where event_id = 'a0000000-0000-4000-8000-000000000004'),
  'failure after p_until survives'
);
select ok(
  exists (select 1 from public.activity_logs where event_id = 'a0000000-0000-4000-8000-000000000005'),
  'retention-locked non-diagnostic analytics survive'
);
select ok(
  exists (select 1 from public.activity_logs where event_id = 'a0000000-0000-4000-8000-000000000008'),
  'unlinked diagnostic evidence survives'
);

set local role service_role;
select is(
  public.devryan_clear_error_logs(null, '2026-08-05T00:00:00Z'),
  '{"clearedCount": 2, "linkedResolutionCount": 0}'::jsonb,
  'null p_since clears all matching failures through the cutoff'
);
reset role;
set local role postgres;

select is(
  (select array_agg(action order by action) from public.activity_logs),
  array['diagnostic.recovered', 'file.opened']::text[],
  'all-range clearing still preserves unrelated and unlinked rows'
);

set local role service_role;
delete from public.activity_logs where event_id = 'a0000000-0000-4000-8000-000000000005';
reset role;
set local role postgres;
select ok(
  exists (select 1 from public.activity_logs where event_id = 'a0000000-0000-4000-8000-000000000005'),
  'the retention trigger still protects locked non-diagnostic analytics'
);

insert into public.activity_logs (event_id, actor_user_id, actor_role, action, target_type, target_id, created_at)
values
  ('b0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'developer', 'tool.failed', null, null, '2026-08-05T01:00:00Z'),
  ('b0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', 'developer', 'diagnostic.recovered', 'activity_event', 'b0000000-0000-4000-8000-000000000001', '2026-08-05T02:00:00Z');

create function pg_temp.fail_test_tool_delete()
returns trigger
language plpgsql
as $$
begin
  if old.action = 'tool.failed' then
    raise exception 'forced Error Log clear failure';
  end if;
  return old;
end;
$$;

create trigger zz_fail_test_tool_delete
before delete on public.activity_logs
for each row execute function pg_temp.fail_test_tool_delete();

set local role service_role;
select throws_ok(
  $$select public.devryan_clear_error_logs(null, '2026-08-06T00:00:00Z')$$,
  'P0001',
  'forced Error Log clear failure',
  'a failure in the second delete rolls back the linked-evidence delete'
);
reset role;
set local role postgres;

select ok(
  exists (select 1 from public.activity_logs where event_id = 'b0000000-0000-4000-8000-000000000001'),
  'failed clearing preserves the original failure row'
);
select ok(
  exists (select 1 from public.activity_logs where event_id = 'b0000000-0000-4000-8000-000000000002'),
  'failed clearing preserves the linked evidence row'
);
select throws_ok(
  $$select public.devryan_clear_error_logs('2026-08-07T00:00:00Z', '2026-08-06T00:00:00Z')$$,
  '22023',
  'p_since must be earlier than or equal to p_until',
  'invalid snapshot boundaries are rejected'
);

select * from finish();
rollback;
