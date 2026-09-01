begin;

set local role postgres;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

insert into auth.users (id, email)
values ('a2000000-0000-4000-8000-000000000001', 'bot-control@example.com');
insert into public.user_profiles (id, email, display_name, role)
values ('a2000000-0000-4000-8000-000000000001', 'bot-control@example.com', 'Control Tester', 'admin');
insert into public.bots (id, name, title, tenancy, created_by)
values ('b2000000-0000-4000-8000-000000000001', 'Control Bot', 'Control Bot', 'team',
  'a2000000-0000-4000-8000-000000000001');
insert into public.bot_revisions (id, bot_id, revision_number, contract, compiled_hash, created_by)
values ('c2000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001',
  1, '{}'::jsonb, repeat('a', 64), 'a2000000-0000-4000-8000-000000000001');
insert into public.bot_memberships (bot_id, user_id, role, assigned_by)
values ('b2000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001',
  'manager', 'a2000000-0000-4000-8000-000000000001');
insert into public.bot_channels (id, bot_id, owner_user_id)
values ('d2000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001',
  'a2000000-0000-4000-8000-000000000001');
insert into public.bot_runs (
  id, bot_id, channel_id, revision_id, idempotency_key, model_snapshot,
  context_snapshot, computer_scope_key, state
) values
  ('e2000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001',
   'd2000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001',
   'control-wait', '{}'::jsonb, '{}'::jsonb, 'control-test-scope', 'waiting_control'),
  ('e2000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000001',
   'd2000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001',
   'control-queued', '{}'::jsonb, '{}'::jsonb, 'control-test-scope', 'queued');
insert into public.bot_action_attempts (
  id, run_id, bot_id, revision_id, computer_scope_key, action_hash, idempotency_key,
  tool, action, target, encrypted_args, args_digest, risk, approval_class,
  policy_effect, decision_expires_at, state, initiated_by, started_at
) values (
  'f2000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001',
  'b2000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001',
  'control-test-scope', 'sha256:' || repeat('a', 64), 'same-control-action',
  'browser', 'click', '{}'::jsonb, '{"ciphertext":"sealed"}'::jsonb, repeat('b', 64),
  'sensitive', 'none', 'allow', now() + interval '5 minutes', 'waiting_control',
  'a2000000-0000-4000-8000-000000000001', now()
);

set local role service_role;
select is((select state from public.bot_runs where id = 'e2000000-0000-4000-8000-000000000001'),
  'waiting_control', 'a run can durably wait for browser control');
select is((select state from public.bot_action_attempts where id = 'f2000000-0000-4000-8000-000000000001'),
  'waiting_control', 'the exact action attempt can durably wait');
select is((select count(*)::integer from public.devryan_claim_bot_run(
  'control-test-scope', 'second-runtime', now() + interval '5 minutes')),
  0, 'a waiting run prevents another queued run claiming its computer');
select throws_ok(
  $$update public.bot_runs set state = 'running' where id = 'e2000000-0000-4000-8000-000000000002'$$,
  '23505', null, 'the active-scope unique index includes waiting control');
select throws_ok(
  $$select * from public.devryan_delete_bot_channel('d2000000-0000-4000-8000-000000000001',
    'a2000000-0000-4000-8000-000000000001')$$,
  '23514', 'Bot channel has unfinished runs', 'a waiting conversation cannot be deleted');

update public.bot_runs set state = 'running'
where id = 'e2000000-0000-4000-8000-000000000001';
update public.bot_action_attempts set state = 'executing'
where id = 'f2000000-0000-4000-8000-000000000001';
update public.bot_action_attempts set state = 'waiting_control'
where id = 'f2000000-0000-4000-8000-000000000001';
update public.bot_runs set state = 'waiting_control'
where id = 'e2000000-0000-4000-8000-000000000001';
select is((select count(*)::integer from public.bot_action_attempts
  where run_id = 'e2000000-0000-4000-8000-000000000001' and idempotency_key = 'same-control-action'),
  1, 'repeated lease races retain one idempotent action row');
select is((select count(*)::integer from public.bot_audit_events
  where target_id = 'e2000000-0000-4000-8000-000000000001' and result in ('failure', 'unknown', 'denied')),
  0, 'waiting and resuming do not generate terminal failure audit events');

update public.bot_action_attempts set state = 'cancelled', finished_at = now()
where id = 'f2000000-0000-4000-8000-000000000001';
update public.bot_runs set state = 'cancelled', finished_at = now()
where id = 'e2000000-0000-4000-8000-000000000001';
select is((select state from public.bot_action_attempts where id = 'f2000000-0000-4000-8000-000000000001'),
  'cancelled', 'a waiting action remains cancellable');
select is((select count(*)::integer from public.devryan_claim_bot_run(
  'control-test-scope', 'second-runtime', now() + interval '5 minutes')),
  1, 'cancellation releases the computer for the next queued run');

select * from finish();
rollback;
