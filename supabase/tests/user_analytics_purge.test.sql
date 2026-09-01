begin;

set local role postgres;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(13);

select ok(
  to_regprocedure('public.devryan_purge_user_activity_logs(uuid,uuid)') is not null,
  'Per-user analytics purge RPC exists'
);
select ok(
  not (select prosecdef from pg_proc
       where oid = 'public.devryan_purge_user_activity_logs(uuid,uuid)'::regprocedure),
  'Per-user analytics purge RPC is security invoker'
);
select ok(
  not has_function_privilege('anon', 'public.devryan_purge_user_activity_logs(uuid,uuid)', 'execute'),
  'anon cannot execute the per-user purge RPC'
);
select ok(
  not has_function_privilege('authenticated', 'public.devryan_purge_user_activity_logs(uuid,uuid)', 'execute'),
  'authenticated cannot execute the per-user purge RPC'
);
select ok(
  has_function_privilege('service_role', 'public.devryan_purge_user_activity_logs(uuid,uuid)', 'execute'),
  'service_role can execute the per-user purge RPC'
);

set local session_replication_role = replica;
insert into public.user_profiles (id, email, display_name, role, analytics_retention_locked_at)
values
  ('d1000000-0000-4000-8000-000000000001', 'purge-target@example.test', 'Purge Target', 'developer', '2026-08-01T00:00:00Z'),
  ('d1000000-0000-4000-8000-000000000002', 'locked-peer@example.test', 'Locked Peer', 'developer', '2026-08-01T00:00:00Z');
set local session_replication_role = origin;

insert into public.activity_logs (event_id, actor_user_id, target_user_id, actor_role, action, created_at)
values
  ('a1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', null, 'developer', 'prompt.sent', '2026-08-01T01:00:00Z'),
  ('a1000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000001', 'developer', 'user.updated', '2026-08-01T02:00:00Z'),
  ('a1000000-0000-4000-8000-000000000003', 'd1000000-0000-4000-8000-000000000001', null, 'developer', 'activity.user_purged', '2026-08-01T03:00:00Z'),
  ('a1000000-0000-4000-8000-000000000004', 'd1000000-0000-4000-8000-000000000002', null, 'developer', 'prompt.sent', '2026-08-01T04:00:00Z'),
  ('a1000000-0000-4000-8000-000000000005', 'd1000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000002', 'developer', 'user.updated', '2026-08-01T05:00:00Z');

set local role service_role;
select is(
  public.devryan_purge_user_activity_logs(
    'd1000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000003'
  ),
  '{"complete": true, "deletedCount": 3, "remainingCount": 0}'::jsonb,
  'administrator purge clears the complete retention-locked target snapshot'
);
reset role;
set local role postgres;

select ok(
  not exists (
    select 1 from public.activity_logs
    where event_id in (
      'a1000000-0000-4000-8000-000000000001',
      'a1000000-0000-4000-8000-000000000002',
      'a1000000-0000-4000-8000-000000000005'
    )
  ),
  'target-owned and cross-linked analytics are deleted despite retention locks'
);
select ok(
  exists (select 1 from public.activity_logs where event_id = 'a1000000-0000-4000-8000-000000000003')
    and exists (select 1 from public.activity_logs where event_id = 'a1000000-0000-4000-8000-000000000004'),
  'the preserved audit marker and unrelated peer analytics remain'
);
select ok(
  (select analytics_retention_locked_at is not null
   from public.user_profiles
   where id = 'd1000000-0000-4000-8000-000000000001'),
  'the target retention lock remains active for future ordinary purges'
);

insert into public.activity_logs (event_id, actor_user_id, actor_role, action, created_at)
values (
  'a1000000-0000-4000-8000-000000000006',
  'd1000000-0000-4000-8000-000000000001',
  'developer',
  'prompt.sent',
  '2026-08-01T06:00:00Z'
);

set local role service_role;
delete from public.activity_logs
where event_id = 'a1000000-0000-4000-8000-000000000006';
reset role;
set local role postgres;

select ok(
  exists (select 1 from public.activity_logs where event_id = 'a1000000-0000-4000-8000-000000000006'),
  'the transaction-local bypass does not leak into later direct deletes'
);

set local role service_role;
select is(
  public.devryan_purge_unprotected_activity_logs(
    'a1000000-0000-4000-8000-000000000003'
  ),
  '{"deletedCount": 0, "protectedCount": 2}'::jsonb,
  'the global purge still preserves retention-locked analytics'
);
reset role;
set local role postgres;

select ok(
  exists (select 1 from public.activity_logs where event_id = 'a1000000-0000-4000-8000-000000000004')
    and exists (select 1 from public.activity_logs where event_id = 'a1000000-0000-4000-8000-000000000006'),
  'global retention leaves the unrelated peer and new target analytics intact'
);

select throws_ok(
  $$ select public.devryan_purge_user_activity_logs(null, null) $$,
  '22023',
  'p_user_id is required',
  'the purge rejects a missing target identity'
);

select * from finish();
rollback;
