begin;

set local role postgres;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

insert into auth.users (id, email)
values ('a6000000-0000-4000-8000-000000000001', 'bot-resolution@example.com');
insert into public.user_profiles (id, email, display_name, role)
values ('a6000000-0000-4000-8000-000000000001', 'bot-resolution@example.com',
  'Resolution Tester', 'admin');
insert into public.bots (id, name, title, tenancy, created_by)
values ('b6000000-0000-4000-8000-000000000001', 'Resolution Bot', 'Resolution Bot',
  'team', 'a6000000-0000-4000-8000-000000000001');
insert into public.bot_revisions (id, bot_id, revision_number, contract, compiled_hash, created_by)
values ('c6000000-0000-4000-8000-000000000001',
  'b6000000-0000-4000-8000-000000000001', 1, '{}'::jsonb, repeat('a', 64),
  'a6000000-0000-4000-8000-000000000001');
insert into public.bot_memberships (bot_id, user_id, role, assigned_by)
values ('b6000000-0000-4000-8000-000000000001',
  'a6000000-0000-4000-8000-000000000001', 'manager',
  'a6000000-0000-4000-8000-000000000001');
insert into public.bot_channels (id, bot_id, owner_user_id)
values ('d6000000-0000-4000-8000-000000000001',
  'b6000000-0000-4000-8000-000000000001',
  'a6000000-0000-4000-8000-000000000001');
update public.bot_revisions set activated_at = now()
where id = 'c6000000-0000-4000-8000-000000000001';
update public.bots
set active_revision_id = 'c6000000-0000-4000-8000-000000000001', lifecycle = 'active'
where id = 'b6000000-0000-4000-8000-000000000001';

set local role service_role;
select is((public.devryan_enqueue_bot_message_run(
  'f6000000-0000-4000-8000-000000000001', 'f6000000-0000-4000-8000-000000000002',
  'e6000000-0000-4000-8000-000000000001', 'b6000000-0000-4000-8000-000000000001',
  'd6000000-0000-4000-8000-000000000001', 'c6000000-0000-4000-8000-000000000001',
  'resolution-admission', '{}'::jsonb, '{}'::jsonb, 'resolution-fixture-scope',
  'a6000000-0000-4000-8000-000000000001', '{"ciphertext":"user"}'::jsonb,
  '{"ciphertext":"empty"}'::jsonb, 0, now(), '[]'::jsonb
)->>'created')::boolean, true, 'admission creates the retry fixture');

update public.bot_runs
set state = 'failed', finished_at = now(), agent_thread_id = 'read-only-thread',
  context_snapshot = '{"failurePhase":"execution","retryable":true}'::jsonb
where id = 'e6000000-0000-4000-8000-000000000001';
insert into public.bot_action_attempts (
  id, run_id, bot_id, revision_id, computer_scope_key, action_hash,
  idempotency_key, tool, action, target, encrypted_args, args_digest,
  risk, approval_class, policy_effect, decision_expires_at, state,
  execution_receipt, initiated_by, started_at, finished_at
)
select 'f6000000-0000-4000-8000-000000000003', id, bot_id, revision_id,
  computer_scope_key, 'sha256:' || repeat('b', 64), 'safe-read',
  'browser', 'snapshot', '{"operationKind":"read"}'::jsonb, '{}'::jsonb,
  repeat('c', 64), 'low', 'none', 'allow', now() + interval '5 minutes',
  'failed', '{"writeGuarantee":"safe_to_retry"}'::jsonb,
  'a6000000-0000-4000-8000-000000000001', now(), now()
from public.bot_runs where id = 'e6000000-0000-4000-8000-000000000001';

select is(
  (public.devryan_retry_bot_run(
    'e6000000-0000-4000-8000-000000000001',
    'a6000000-0000-4000-8000-000000000001', now()
  )->>'ok')::boolean,
  true,
  'a settled read-only attempt remains safe for same-run retry'
);

update public.bot_runs
set state = 'failed', finished_at = now(),
  context_snapshot = '{"failurePhase":"execution","retryable":true}'::jsonb
where id = 'e6000000-0000-4000-8000-000000000001';
insert into public.bot_action_attempts (
  id, run_id, bot_id, revision_id, computer_scope_key, action_hash,
  idempotency_key, tool, action, target, encrypted_args, args_digest,
  risk, approval_class, policy_effect, decision_expires_at, state,
  execution_receipt, initiated_by, started_at, finished_at
)
select 'f6000000-0000-4000-8000-000000000004', id, bot_id, revision_id,
  computer_scope_key, 'sha256:' || repeat('d', 64), 'unsafe-write',
  'connector.crm', 'contact.update', '{"operationKind":"write"}'::jsonb, '{}'::jsonb,
  repeat('e', 64), 'sensitive', 'none', 'allow', now() + interval '5 minutes',
  'succeeded', '{"writeGuarantee":"at_least_once"}'::jsonb,
  'a6000000-0000-4000-8000-000000000001', now(), now()
from public.bot_runs where id = 'e6000000-0000-4000-8000-000000000001';

select is(
  public.devryan_retry_bot_run(
    'e6000000-0000-4000-8000-000000000001',
    'a6000000-0000-4000-8000-000000000001', now()
  )->>'reason',
  'execution_started',
  'a possibly mutating action still forbids same-run retry'
);

insert into public.bot_audit_events (
  event_id, bot_id, target_type, target_id, action, result, metadata, created_at
) values
  ('16000000-0000-4000-8000-000000000001', 'b6000000-0000-4000-8000-000000000001',
    'bot_computer', 'computer-a', 'bot.computer.navigation_loop', 'failure', '{}',
    now() - interval '10 minutes'),
  ('16000000-0000-4000-8000-000000000002', 'b6000000-0000-4000-8000-000000000001',
    'bot_computer', 'computer-a', 'bot.computer.navigation_loop.retry', 'success', '{}',
    now() - interval '9 minutes'),
  ('16000000-0000-4000-8000-000000000003', 'b6000000-0000-4000-8000-000000000001',
    'bot_computer', 'computer-b', 'bot.computer.cookie_block', 'partial', '{}',
    now() - interval '8 minutes'),
  ('16000000-0000-4000-8000-000000000004', 'b6000000-0000-4000-8000-000000000001',
    'bot_computer', 'computer-b', 'bot.computer.cookie_block.requeue', 'success', '{}',
    now() - interval '7 minutes'),
  ('16000000-0000-4000-8000-000000000005', 'b6000000-0000-4000-8000-000000000001',
    'bot_computer', 'computer-c', 'bot.computer.navigation_loop', 'failure', '{}',
    now() - interval '6 minutes'),
  ('16000000-0000-4000-8000-000000000006', 'b6000000-0000-4000-8000-000000000001',
    'bot_computer', 'different-computer', 'bot.computer.navigation_loop', 'success', '{}',
    now() - interval '5 minutes'),
  ('16000000-0000-4000-8000-000000000007', 'b6000000-0000-4000-8000-000000000001',
    'bot_run', 'e6000000-0000-4000-8000-000000000001', 'bot.run.failed', 'failure', '{}',
    now() - interval '1 minute');

select is(
  (select resolved_by_event_id::text from public.bot_audit_events_with_resolution
   where event_id = '16000000-0000-4000-8000-000000000001'),
  '16000000-0000-4000-8000-000000000002',
  'a matching retry success resolves a prior failure'
);
select is(
  (select resolved_by_event_id::text from public.bot_audit_events_with_resolution
   where event_id = '16000000-0000-4000-8000-000000000003'),
  '16000000-0000-4000-8000-000000000004',
  'a matching requeue success resolves a prior partial result'
);
select is(
  (select resolved_at::text from public.bot_audit_events_with_resolution
   where event_id = '16000000-0000-4000-8000-000000000005'),
  null::text,
  'a success for another target does not resolve the issue'
);

update public.bot_runs
set state = 'completed', finished_at = now(), updated_at = now()
where id = 'e6000000-0000-4000-8000-000000000001';
select ok(
  (select resolved_at is not null from public.bot_audit_events_with_resolution
   where event_id = '16000000-0000-4000-8000-000000000007'),
  'a completed run resolves its earlier run failure'
);
select is(
  (select resolved_by_event_id::text from public.bot_audit_events_with_resolution
   where event_id = '16000000-0000-4000-8000-000000000007'),
  null::text,
  'run-state resolution does not invent an audit event ID'
);

select ok(has_function_privilege('service_role',
  'public.devryan_retry_bot_run(uuid,uuid,timestamptz)', 'execute'),
  'the service role retains retry RPC access');
select ok(not has_function_privilege('authenticated',
  'public.devryan_retry_bot_run(uuid,uuid,timestamptz)', 'execute'),
  'authenticated clients cannot invoke retry directly');
select is(public.devryan_bot_schema_version(), '20260903110000',
  'the schema marker advances with generalized resolution and safe retry');

select * from finish();
rollback;
