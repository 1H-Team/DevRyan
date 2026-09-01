begin;
select '1..1';

insert into auth.users(id, email) values
  ('a3000000-0000-4000-8000-000000000001', 'audit-clear@example.com'),
  ('a3000000-0000-4000-8000-000000000002', 'audit-clear-suspended@example.com');
insert into public.user_profiles(id, email, display_name, role, status) values
  ('a3000000-0000-4000-8000-000000000001', 'audit-clear@example.com', 'Clear Tester', 'admin', 'active'),
  ('a3000000-0000-4000-8000-000000000002', 'audit-clear-suspended@example.com', 'Suspended Tester', 'admin', 'suspended');

insert into public.bot_audit_events(event_id, target_type, action, result, created_at) values
  ('c3000000-0000-4000-8000-000000000001', 'bot_run', 'bot.run.failed', 'failure', '2001-01-01T00:00:00Z'),
  ('c3000000-0000-4000-8000-000000000002', 'bot_run', 'bot.run.failed', 'failure', '2001-01-02T00:00:00Z'),
  ('c3000000-0000-4000-8000-000000000003', 'bot_run', 'bot.run.completed', 'success', '2001-01-03T00:00:00Z');

set local role service_role;
do $$
declare
  actor_id uuid := 'a3000000-0000-4000-8000-000000000001';
  cleared jsonb;
begin
  if has_table_privilege('anon', 'public.bot_audit_cleared_events', 'SELECT')
    or has_table_privilege('authenticated', 'public.bot_audit_review_events', 'SELECT')
    or has_function_privilege('authenticated', 'public.devryan_clear_bot_audit(uuid,timestamptz,timestamptz)', 'EXECUTE')
    or has_function_privilege('anon', 'public.devryan_clear_bot_audit(uuid,timestamptz,timestamptz)', 'EXECUTE') then
    raise exception 'Bot audit clearing exposed to browser database roles';
  end if;
  if (select prosecdef from pg_proc where oid = 'public.devryan_clear_bot_audit(uuid,timestamptz,timestamptz)'::regprocedure) then
    raise exception 'Clear function must not bypass invoker permissions';
  end if;

  begin
    perform public.devryan_clear_bot_audit(actor_id, null, null);
    raise exception 'Missing cutoff accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.devryan_clear_bot_audit(actor_id, '2001-01-03Z', '2001-01-02Z');
    raise exception 'Inverted range accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.devryan_clear_bot_audit('a3000000-0000-4000-8000-000000000002', null, now());
    raise exception 'Suspended administrator accepted';
  exception when insufficient_privilege then null;
  end;

  cleared := public.devryan_clear_bot_audit(actor_id, '2001-01-02Z', '2001-01-02Z');
  if cleared <> '{"clearedCount":1}'::jsonb then raise exception 'Inclusive range count incorrect: %', cleared; end if;
  if exists (select 1 from public.bot_audit_review_events where event_id = 'c3000000-0000-4000-8000-000000000002') then
    raise exception 'Cleared event remains in review';
  end if;
  if not exists (select 1 from public.bot_audit_cleared_events where event_id = 'c3000000-0000-4000-8000-000000000002' and cleared_by = actor_id) then
    raise exception 'Clear attribution missing';
  end if;
  if not exists (select 1 from public.bot_audit_events where event_id = 'c3000000-0000-4000-8000-000000000002') then
    raise exception 'Retained UUID detail lost';
  end if;
  if (select count(*) from public.bot_audit_review_events where event_id in (
    'c3000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000003'
  )) <> 2 then raise exception 'Clear affected events outside the requested range'; end if;
  if public.devryan_clear_bot_audit(actor_id, '2001-01-02Z', '2001-01-02Z') <> '{"clearedCount":0}'::jsonb then
    raise exception 'Repeated clear was not idempotent';
  end if;

  perform public.devryan_clear_bot_audit(actor_id, null, now());
  if exists (select 1 from public.bot_audit_review_events where created_at <= now()) then
    raise exception 'All-time clear left review events';
  end if;
  -- A late-arriving/backdated event must remain visible after the snapshot.
  insert into public.bot_audit_events(event_id, target_type, action, result, created_at)
  values ('c3000000-0000-4000-8000-000000000004', 'bot_run', 'bot.run.failed', 'failure', '2001-01-02Z');
  if not exists (select 1 from public.bot_audit_review_events where event_id = 'c3000000-0000-4000-8000-000000000004') then
    raise exception 'New event incorrectly cleared';
  end if;
  begin
    delete from public.bot_audit_events where event_id = 'c3000000-0000-4000-8000-000000000002';
    raise exception 'Clearing weakened immutable ledger';
  exception when check_violation then null;
  end;
  perform set_config('devryan.bot_audit_prune', 'on', true);
  delete from public.bot_audit_events where event_id = 'c3000000-0000-4000-8000-000000000002';
  perform set_config('devryan.bot_audit_prune', 'off', true);
  if exists (select 1 from public.bot_audit_cleared_events where event_id = 'c3000000-0000-4000-8000-000000000002') then
    raise exception 'Retention left orphan dismissal records';
  end if;
end;
$$;
select 'ok 1 - Bot audit clearing enforces permissions, range boundaries, snapshots, idempotency and retention';
rollback;
